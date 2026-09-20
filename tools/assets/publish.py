#!/usr/bin/env python3
"""Back up the asset repo clone and prepare its rebuilt tree for a force-push, without pushing.

`backup` writes a `git bundle` of every ref in a clone and proves it restores. `prepare` resolves the repo's default branch straight
from origin (never from local state), requires the clone's copy of that branch to be exactly in sync with origin, regenerates the
version 3 manifest from the staging tree, requires it to match the repo-root `assets-manifest.json` byte for byte, runs the v3
audit, checks the tree against GitHub's size guidance, and then commits the staging tree onto an orphan branch in the clone.
It prints a push command leased to the origin commit it checked, plus the publish runbook, for a person to run, and never runs
them. Pass `--replace-branch` to delete and recreate an existing local `rebuild` branch when re-running prepare; the default branch
itself is never touched.

`add` commits the files of an incremental staging tree onto the asset repo's branch through a shallow, blobless, sparse clone and pushes them
normally. It is what the scheduled refresh runs. `wait-live` polls those files' raw URLs until every one returns 200.

Usage:
    python3 tools/assets/publish.py backup --clone <path> --out <dir>
    python3 tools/assets/publish.py prepare --clone <path>
    python3 tools/assets/publish.py prepare --clone <path> --replace-branch
    python3 tools/assets/publish.py add --staging <tree> --remote <url> --list <file> [--dry-run]
    python3 tools/assets/publish.py wait-live --base <url> --list <file>
"""

import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_manifest  # noqa: E402


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Constants

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))

BYTES_PER_MB = 1000 * 1000

# Our own warn and refuse lines, under GitHub's 5 GB repo recommendation. Decimal megabytes keep the check on the strict side.
REFUSE_TOTAL_BYTES = 5000 * BYTES_PER_MB
WARN_TOTAL_BYTES = 4000 * BYTES_PER_MB

# GitHub warns above 50 MB per file and rejects above 100 MB.
MAX_FILE_BYTES = 50 * BYTES_PER_MB

# Bytes of new files one publish commit carries at most. The skin Live2D tier adds roughly 500 MB, which is slow and all-or-nothing as a
# single push, so it goes out in batches instead.
BATCH_BYTES = 200 * BYTES_PER_MB

# Files the repo may carry that the staging tree does not produce, kept when present in the clone.
KEEP_FILES = ("CNAME",)

MANIFEST_NAME = "assets-manifest.json"

BRANCH = "rebuild"

STAGING_TREE = "tools/assets/.staging/assets"

REPO_TITLE = "gfl-archive-assets"

REPO_CONTENT = "Cards, full art, skill icons, equipment icons, HOC and fairy art, UI images and Spine chibis"

# Owner of the asset repo, for the Git Trees API.
OWNER = "steve1316"

GITHUB_API = "https://api.github.com"

USER_AGENT = "gfl-archive-refresh/1.0 (fan site asset pipeline; https://github.com/steve1316/gfl-archive)"

# How long `wait-live` polls for new asset URLs, and how often.
LIVE_TIMEOUT_SECONDS = 20 * 60
LIVE_INTERVAL_SECONDS = 30

# Commit message labels whose plural is not the singular plus a trailing `s`.
IRREGULAR_PLURALS = {"fairy": "fairies", "live2d fairy": "live2d fairies"}


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Pure checks


def check_sizes(files):
    """Check a planned tree against GitHub's repo and file size guidance.

    Args:
        files: `(rel_path, size_bytes)` pairs for every file in the tree.

    Returns:
        A dict with `errors` and `warnings` lists, plus `count`, `total` and `largest` (a `(rel_path, size)` pair or None).
    """
    total = sum(size for _, size in files)
    largest = max(files, key=lambda entry: (entry[1], entry[0])) if files else None
    errors = [f"{rel} is {size / BYTES_PER_MB:.1f} MB, over the {MAX_FILE_BYTES // BYTES_PER_MB} MB file limit" for rel, size in sorted(files) if size > MAX_FILE_BYTES]
    warnings = []
    if total >= REFUSE_TOTAL_BYTES:
        errors.append(f"tree is {total / BYTES_PER_MB:.1f} MB, at or over the {REFUSE_TOTAL_BYTES // BYTES_PER_MB} MB limit")
    elif total > WARN_TOTAL_BYTES:
        warnings.append(f"tree is {total / BYTES_PER_MB:.1f} MB, over the {WARN_TOTAL_BYTES // BYTES_PER_MB} MB warning line")
    return {"errors": errors, "warnings": warnings, "count": len(files), "total": total, "largest": largest}


def compare_manifests(regenerated, committed):
    """Compare a freshly generated manifest with the committed copy.

    Args:
        regenerated: The regenerated manifest file contents.
        committed: The committed manifest file contents.

    Returns:
        None when the two are byte-identical, otherwise a message saying whether the content or only the formatting differs.
    """
    if regenerated == committed:
        return None
    try:
        same_content = json.loads(regenerated) == json.loads(committed)
    except ValueError:
        same_content = False
    if same_content:
        return "the regenerated manifest has the same content but different formatting from the committed one"
    return "the regenerated manifest differs from the committed one. Rebuild it with tools/assets/build_manifest.py and commit it first"


def branch_sync_status(clone, branch, counts):
    """Build a refusal message for a local branch that is not exactly in sync with its origin counterpart.

    Args:
        clone: The repository path, used in the message.
        branch: The branch name, used in the message.
        counts: Output of `git rev-list --left-right --count <branch>...origin/<branch>`, as "<ahead> <behind>".

    Returns:
        None when the branch matches `origin/<branch>`, otherwise a message saying whether it is behind, ahead, or diverged.
    """
    ahead, behind = (int(count) for count in counts.split())
    if ahead == 0 and behind == 0:
        return None
    if behind == 0:
        return f"{clone}'s {branch} is {ahead} commit(s) ahead of origin/{branch}"
    if ahead == 0:
        return f"{clone}'s {branch} is {behind} commit(s) behind origin/{branch}"
    return f"{clone}'s {branch} has diverged from origin/{branch} ({ahead} ahead, {behind} behind)"


def parse_symref_head(output):
    """Parse the branch name out of `git ls-remote --symref origin HEAD` output.

    Args:
        output: The command's standard output, e.g. `ref: refs/heads/main\\tHEAD\\n<sha>\\tHEAD`.

    Returns:
        The branch name, or None when no `ref: refs/heads/<name> ... HEAD` line is present.
    """
    for line in output.splitlines():
        match = re.match(r"^ref:\s+refs/heads/(\S+)\s+HEAD$", line.strip())
        if match:
            return match.group(1)
    return None


def push_command(clone, base_branch, lease_sha):
    """Build the force-push command for a prepared clone, leased to the origin commit `prepare` checked.

    Args:
        clone: The clone's path.
        base_branch: The remote's default branch.
        lease_sha: The full sha `origin/<base_branch>` pointed at when `prepare` ran.

    Returns:
        The command line. The push is refused if the remote branch has moved since.
    """
    return f"git -C {clone} push --force-with-lease={base_branch}:{lease_sha} origin {BRANCH}:{base_branch}"


def runbook_text():
    """Build the publish runbook printed after `prepare`.

    Returns:
        The runbook lines, joined with newlines.
    """
    return "\n".join(
        (
            "Publish runbook (back to back, only with explicit confirmation):",
            f"  1. Push {REPO_TITLE} with its printed command.",
            "  2. Push the site's master immediately after, so the new site and the new asset layout go live together.",
            "  3. Wait for the site's Pages deploy to finish (`gh api repos/<owner>/<repo>/pages/builds/latest`).",
            "  4. Run `node tools/assets/verify_live_assets.mjs <asset base URL>` against the live host.",
        )
    )


def readme_text(res_version):
    """Build the README written into a rebuilt asset repo.

    Args:
        res_version: The game ResData version the tree was extracted from.

    Returns:
        The README contents.
    """
    return (
        f"# {REPO_TITLE}\n\n"
        f"{REPO_CONTENT} for [Griffin Archive](https://github.com/steve1316/gfl-archive), served over raw.githubusercontent.com.\n\n"
        f"Extracted from the Girls' Frontline game asset bundles (ResData version {res_version}) by `tools/assets/` in the site repository.\n\n"
        "© Sunborn/MICA Team, mirrored for fan site use. These assets are **not** covered by the licence of the site's source code.\n"
    )


def list_tree(root, skip=()):
    """List every file under a directory with its size.

    Args:
        root: The directory to walk.
        skip: Relative paths to leave out.

    Returns:
        Sorted `(rel_path, size_bytes)` pairs, using forward slashes.
    """
    found = []
    for directory, dirs, names in os.walk(root):
        dirs[:] = [name for name in dirs if name != ".git"]
        for name in names:
            absolute = os.path.join(directory, name)
            rel = os.path.relpath(absolute, root).replace(os.sep, "/")
            if rel not in skip:
                found.append((rel, os.path.getsize(absolute)))
    return sorted(found)


def repo_name(remote_url, clone):
    """Name a repo for its backup file.

    Args:
        remote_url: The clone's `origin` URL, or an empty string.
        clone: The clone's path, used when there is no remote.

    Returns:
        The repo name without a `.git` suffix.
    """
    source = remote_url.rstrip("/") or os.path.abspath(clone)
    name = source.replace(":", "/").rsplit("/", 1)[-1]
    return name[:-4] if name.endswith(".git") else name


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Git helpers


def git(clone, *args, check=True):
    """Run a git command inside a clone.

    Args:
        clone: The repository path.
        *args: Arguments after `git -C <clone>`.
        check: Whether a non-zero exit stops the script.

    Returns:
        The command's stripped standard output.

    Raises:
        SystemExit: When `check` is true and the command fails.
    """
    result = subprocess.run(["git", "-C", clone, *args], capture_output=True, text=True)
    if check and result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed in {clone}:\n{result.stderr.strip()}")
    return result.stdout.strip()


def default_branch(clone, run=git):
    """Find the branch the remote serves by default, resolved straight from the remote.

    Never trusts local state: not the currently checked-out branch, not a possibly-stale or unset
    `refs/remotes/origin/HEAD`. Both real clones in this repo have `origin/HEAD` unset, so this always asks the remote.

    Args:
        clone: The repository path.
        run: The command runner, `run(clone, *args, check=...)` returning stdout. Defaults to `git`; tests inject a fake
            to avoid needing a real remote.

    Returns:
        The default branch name.

    Raises:
        SystemExit: When the remote's default branch cannot be resolved.
    """
    branch = parse_symref_head(run(clone, "ls-remote", "--symref", "origin", "HEAD"))
    if not branch:
        sys.exit(f"could not resolve origin's default branch for {clone} from `git ls-remote --symref origin HEAD`")
    return branch


def require_synced_with_origin(clone, branch):
    """Fetch a branch from origin and refuse to continue unless the clone matches it exactly.

    Args:
        clone: The repository path.
        branch: The local branch to check, normally the resolved default branch.

    Raises:
        SystemExit: When the fetch fails, or the local branch is behind, ahead of, or diverged from `origin/<branch>`.
    """
    git(clone, "fetch", "origin", branch)
    counts = git(clone, "rev-list", "--left-right", "--count", f"{branch}...origin/{branch}")
    problem = branch_sync_status(clone, branch, counts)
    if problem:
        sys.exit(f"{problem}. Fetch/push/pull to bring it in sync before preparing")


def ref_map(lines):
    """Parse `<sha> <ref>` lines into a dict.

    Args:
        lines: Output of `git show-ref` or `git bundle list-heads`.

    Returns:
        Map of ref name to sha.
    """
    refs = {}
    for line in lines.splitlines():
        if line.strip():
            sha, ref = line.split(None, 1)
            refs[ref.strip()] = sha
    return refs


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Backup


def backup(clone, out_dir):
    """Bundle every ref of a clone and prove the bundle restores the same HEAD and refs.

    Args:
        clone: The repository path.
        out_dir: Directory to write `<repo>-<date>.bundle` into.

    Returns:
        The bundle path.

    Raises:
        SystemExit: When the bundle already exists or fails verification.
    """
    name = repo_name(git(clone, "remote", "get-url", "origin", check=False), clone)
    bundle = os.path.join(os.path.abspath(out_dir), f"{name}-{datetime.date.today().isoformat()}.bundle")
    if os.path.exists(bundle):
        sys.exit(f"{bundle} already exists, refusing to overwrite a backup")

    git(clone, "bundle", "create", bundle, "--all")
    print(f"wrote {bundle} ({os.path.getsize(bundle) / BYTES_PER_MB:.1f} MB)")
    git(clone, "bundle", "verify", bundle)

    source_head = git(clone, "rev-parse", "HEAD")
    source_refs = ref_map(git(clone, "show-ref"))
    bundle_refs = ref_map(git(clone, "bundle", "list-heads", bundle))
    with tempfile.TemporaryDirectory(prefix="bundle-verify-") as scratch:
        restored = os.path.join(scratch, "restored")
        result = subprocess.run(["git", "clone", "--quiet", "--no-checkout", bundle, restored], capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit(f"cloning the bundle failed:\n{result.stderr.strip()}")
        restored_head = git(restored, "rev-parse", "HEAD")
        git(restored, "fsck", "--connectivity-only")

    problems = [f"{ref} is {sha} in the clone but {bundle_refs.get(ref)} in the bundle" for ref, sha in sorted(source_refs.items()) if bundle_refs.get(ref) != sha]
    if restored_head != source_head:
        problems.append(f"restored HEAD {restored_head} does not match the clone's HEAD {source_head}")
    if problems:
        sys.exit("bundle verification failed:\n  " + "\n  ".join(problems))
    print(f"verified: restored HEAD {restored_head} matches the clone, all {len(source_refs)} refs match, connectivity ok")
    return bundle


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Prepare


def resolve_res_version(explicit):
    """Find the ResData version the staging tree was extracted from.

    Args:
        explicit: A version passed on the command line, or None.

    Returns:
        The version string.

    Raises:
        SystemExit: When no source records it.
    """
    if explicit:
        return explicit
    inventory = os.path.join(TOOLS_DIR, ".cache", "inventory.json")
    if os.path.isfile(inventory):
        with open(inventory, encoding="utf-8") as handle:
            version = json.load(handle).get("resVersion")
        if version:
            return str(version)
    sys.exit("no ResData version found in tools/assets/.cache/inventory.json. Pass --res-version")


def verify_staging(assets_root, manifest_path, spine_index_path):
    """Regenerate the manifest, require it to match the committed copy, and run the v3 audit.

    Args:
        assets_root: The asset staging tree.
        manifest_path: The committed repo-root manifest.
        spine_index_path: The Spine index the site bundles.

    Returns:
        The regenerated manifest file contents.

    Raises:
        SystemExit: When the manifests differ or the audit fails.
    """
    regenerated = build_manifest.dumps(build_manifest.build_v3(assets_root))
    with open(manifest_path, encoding="utf-8") as handle:
        committed = handle.read()
    difference = compare_manifests(regenerated, committed)
    if difference:
        sys.exit(difference)
    print(f"manifest: regenerated from the staging tree, byte-identical to {manifest_path} ({len(regenerated)} bytes)")

    # The HOC Spine index sits next to the doll Spine index. Resolving it that way, rather than trusting the audit's own default keeps this working regardless of caller context.
    hoc_spine_index_path = os.path.join(os.path.dirname(spine_index_path), "hoc-spine-index.json")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as handle:
        handle.write(regenerated)
        regenerated_path = handle.name
    try:
        command = ["node", os.path.join(TOOLS_DIR, "audit_assets.mjs"), "--assets", assets_root]
        command += ["--manifest", regenerated_path, "--spine-index", spine_index_path, "--hoc-spine-index", hoc_spine_index_path]
        result = subprocess.run(command, capture_output=True, text=True)
    finally:
        os.unlink(regenerated_path)
    print("audit:\n" + "\n".join(f"  {line}" if line else "" for line in result.stdout.strip().splitlines()))
    if result.returncode != 0:
        sys.exit(f"the v3 audit failed with exit code {result.returncode}. {result.stderr.strip()}")
    return regenerated


def print_stats(label, stats):
    """Print a size summary.

    Args:
        label: What the numbers describe.
        stats: The dict from `check_sizes`.
    """
    largest = stats["largest"]
    summary = f"{label}: {stats['count']} files, {stats['total'] / BYTES_PER_MB:.1f} MB"
    if largest:
        summary += f", largest {largest[0]} ({largest[1] / BYTES_PER_MB:.2f} MB)"
    print(summary)


def prepare(clone, assets_root, manifest_path, spine_index_path, res_version, replace_branch):
    """Commit a verified staging tree onto an orphan branch in a clone and print the push command.

    Args:
        clone: The local clone of the asset repo.
        assets_root: The asset staging tree.
        manifest_path: The committed repo-root manifest.
        spine_index_path: The Spine index the site bundles.
        res_version: The ResData version, for the commit message and README.
        replace_branch: Whether an existing `rebuild` branch may be deleted first.

    Raises:
        SystemExit: When any check fails: a dirty tree, a clone whose default branch is not exactly in sync with origin, an
            existing `rebuild` branch without `--replace-branch`, a manifest mismatch, an audit failure, or a size-limit
            breach. Nothing in the clone changes before every check has passed.
    """
    clone = os.path.abspath(clone)
    if git(clone, "status", "--porcelain"):
        sys.exit(f"{clone} has uncommitted changes")
    base_branch = default_branch(clone)
    if base_branch == BRANCH:
        sys.exit(f"{clone} is on {BRANCH}. Check out the default branch first")
    require_synced_with_origin(clone, base_branch)
    lease_sha = git(clone, "rev-parse", "--verify", f"refs/remotes/origin/{base_branch}")
    if git(clone, "rev-parse", "--verify", "--quiet", f"refs/heads/{BRANCH}", check=False) and not replace_branch:
        sys.exit(f"{clone} already has a {BRANCH} branch. Pass --replace-branch to rebuild it")

    regenerated = verify_staging(assets_root, manifest_path, spine_index_path)

    kept = {}
    for name in KEEP_FILES:
        if os.path.isfile(os.path.join(clone, name)):
            with open(os.path.join(clone, name), "rb") as handle:
                kept[name] = handle.read()
    readme = readme_text(res_version)
    planned = list_tree(assets_root, skip={MANIFEST_NAME})
    planned += [(name, len(data)) for name, data in kept.items()] + [("README.md", len(readme.encode("utf-8")))]
    planned.append((MANIFEST_NAME, len(regenerated.encode("utf-8"))))
    stats = check_sizes(planned)
    print_stats("planned tree", stats)
    for warning in stats["warnings"]:
        print(f"WARNING: {warning}")
    if stats["errors"]:
        sys.exit("refusing to prepare:\n  " + "\n  ".join(stats["errors"]))

    git(clone, "checkout", "--quiet", base_branch)
    if replace_branch:
        git(clone, "branch", "-D", BRANCH, check=False)
    git(clone, "checkout", "--quiet", "--orphan", BRANCH)
    git(clone, "rm", "-r", "-f", "--quiet", "--ignore-unmatch", ".")
    git(clone, "clean", "-f", "-d", "-x", "--quiet")

    for directory, _, names in os.walk(assets_root):
        rel_dir = os.path.relpath(directory, assets_root)
        os.makedirs(os.path.join(clone, rel_dir), exist_ok=True)
        for name in names:
            if rel_dir == "." and name == MANIFEST_NAME:
                continue
            shutil.copyfile(os.path.join(directory, name), os.path.join(clone, rel_dir, name))
    for name, data in kept.items():
        with open(os.path.join(clone, name), "wb") as handle:
            handle.write(data)
    with open(os.path.join(clone, "README.md"), "w", encoding="utf-8") as handle:
        handle.write(readme)
    with open(os.path.join(clone, MANIFEST_NAME), "w", encoding="utf-8") as handle:
        handle.write(regenerated)

    git(clone, "add", "--all")
    git(clone, "commit", "--quiet", "-m", f"Rebuild assets from game data ({res_version})")

    committed = []
    for line in filter(None, git(clone, "ls-tree", "-r", "-l", "-z", "HEAD").split("\0")):
        meta, rel = line.split("\t", 1)
        committed.append((rel, int(meta.split()[3])))
    final = check_sizes(committed)
    if final["errors"]:
        sys.exit("the committed tree breaks the size limits:\n  " + "\n  ".join(final["errors"]))
    if sorted(committed) != sorted(planned):
        sys.exit("the committed tree does not match the planned tree")

    print(f"\ncommitted {git(clone, 'rev-parse', '--short', 'HEAD')} on orphan branch {BRANCH} in {clone}")
    print_stats("committed tree", final)
    for warning in final["warnings"]:
        print(f"WARNING: {warning}")
    print(f"\nNot pushed. origin/{base_branch} was {lease_sha} when checked. To publish, run:")
    print(f"  {push_command(clone, base_branch, lease_sha)}")
    print(f"\n{runbook_text()}")


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Incremental add


def fetch_tree_sizes(repo_title, branch="main", token=None, opener=urllib.request.urlopen):
    """Read every file size of a repo branch from the GitHub Git Trees API.

    A blobless clone cannot report sizes without downloading every blob, so the hosted total comes from the API instead.

    Args:
        repo_title: The repo name, such as `gfl-archive-assets`.
        branch: The branch to list.
        token: Optional GitHub token, which raises the API rate limit.
        opener: Callable standing in for `urllib.request.urlopen` in tests.

    Returns:
        A dict of size in bytes by path, blobs only.

    Raises:
        SystemExit: When the request fails, or the API truncates the listing.
    """
    request = urllib.request.Request(
        f"{GITHUB_API}/repos/{OWNER}/{repo_title}/git/trees/{branch}?recursive=1", headers={"Accept": "application/vnd.github+json", "User-Agent": USER_AGENT}
    )
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with opener(request, timeout=60) as response:
            body = json.load(response)
    except urllib.error.HTTPError as error:
        sys.exit(f"reading the tree of {repo_title} from the GitHub API failed: HTTP {error.code}")
    except urllib.error.URLError as error:
        sys.exit(f"reading the tree of {repo_title} from the GitHub API failed: {error.reason}")
    if body.get("truncated"):
        sys.exit(f"the Git Trees API truncated the listing of {repo_title}, so its size cannot be checked")
    return {entry["path"]: entry["size"] for entry in body["tree"] if entry["type"] == "blob"}


def planned_tree(existing, staged):
    """Combine hosted file sizes with staged ones, a staged file replacing a hosted one at the same path.

    Args:
        existing: Size by path of the hosted tree.
        staged: `(rel_path, size_bytes)` pairs of the staging tree.

    Returns:
        Sorted `(rel_path, size_bytes)` pairs for `check_sizes`.
    """
    sizes = dict(existing)
    sizes.update(dict(staged))
    return sorted(sizes.items())


def batch_paths(paths, batch_bytes):
    """Group files into commit-sized batches.

    A file larger than the whole budget still gets its own batch rather than being dropped, so no file is ever skipped for
    being too big.

    Args:
        paths: Absolute paths to the files to publish, in the order they should go out.
        batch_bytes: Maximum bytes per batch.

    Returns:
        A list of path lists, each within the budget except where one file alone exceeds it.
    """
    batches, current, total = [], [], 0
    for path in paths:
        size = os.path.getsize(path)
        if current and total + size > batch_bytes:
            batches.append(current)
            current, total = [], 0
        current.append(path)
        total += size
    if current:
        batches.append(current)
    return batches


def join_numbers(label, values):
    """Name a group of ids, such as `dolls 424, 425`.

    Args:
        label: Singular label, such as `doll`.
        values: The ids as strings, already in order.

    Returns:
        The group text, pluralised when there is more than one id and the label is not `equipment`: an `s` is appended unless
        the label is in `IRREGULAR_PLURALS`, which spells the plural out instead.
    """
    if len(values) == 1 or label == "equipment":
        plural = label
    else:
        plural = IRREGULAR_PLURALS.get(label, f"{label}s")
    return f"{plural} {', '.join(values)}"


def commit_message(paths):
    """Describe the dolls, skins, equipment, HOCs, fairies and Live2D models an add commit holds.

    Args:
        paths: Staged relative paths, such as `tdolls/424/card.webp`, `spine/65/skins/9001/a.skel`, `equipment/301.png`, `hocs/6/card.webp`,
            `fairies/9/form1.webp`, `live2d/fairies/9/form1.model3.json`, `live2d/hocs/6/model.model3.json` or
            `live2d/tdolls/104/base/1202/normal/model.model3.json`.

    Returns:
        A subject line such as `Add art for dolls 424, 425, skin 65:9001, equipment 301, hoc 6 and fairy 9`.
    """
    dolls, skins, equipment, hocs, fairies, live2d_hocs, live2d_fairies, live2d_tdolls = set(), set(), set(), set(), set(), set(), set(), set()
    for rel in paths:
        parts = rel.split("/")
        if parts[0] == "equipment" and len(parts) == 2 and parts[1][:-4].isdigit():
            equipment.add(int(parts[1][:-4]))
        elif parts[0] in ("tdolls", "spine") and len(parts) > 2 and parts[1].isdigit():
            if parts[2] == "skins" and len(parts) > 4:
                skins.add((int(parts[1]), parts[3]))
            else:
                dolls.add(int(parts[1]))
        elif parts[0] in ("hocs", "hoc-spine") and len(parts) > 2 and parts[1].isdigit():
            hocs.add(int(parts[1]))
        elif parts[0] == "fairies" and len(parts) > 2 and parts[1].isdigit():
            fairies.add(int(parts[1]))
        elif parts[0] == "live2d" and len(parts) > 3 and parts[2].isdigit():
            if parts[1] == "hocs":
                live2d_hocs.add(int(parts[2]))
            elif parts[1] == "fairies":
                live2d_fairies.add(int(parts[2]))
            elif parts[1] == "tdolls":
                live2d_tdolls.add(int(parts[2]))
    groups = []
    if dolls:
        groups.append(join_numbers("doll", [str(doll_id) for doll_id in sorted(dolls)]))
    if skins:
        ordered = sorted(skins, key=lambda pair: (pair[0], (0, int(pair[1]), "") if pair[1].isdigit() else (1, 0, pair[1])))
        groups.append(join_numbers("skin", [f"{doll_id}:{skin_id}" for doll_id, skin_id in ordered]))
    if equipment:
        groups.append(join_numbers("equipment", [str(equip_id) for equip_id in sorted(equipment)]))
    if hocs:
        groups.append(join_numbers("hoc", [str(hoc_id) for hoc_id in sorted(hocs)]))
    if fairies:
        groups.append(join_numbers("fairy", [str(fairy_id) for fairy_id in sorted(fairies)]))
    if live2d_hocs:
        groups.append(join_numbers("live2d hoc", [str(hoc_id) for hoc_id in sorted(live2d_hocs)]))
    if live2d_fairies:
        groups.append(join_numbers("live2d fairy", [str(fairy_id) for fairy_id in sorted(live2d_fairies)]))
    if live2d_tdolls:
        groups.append(join_numbers("live2d doll", [str(doll_id) for doll_id in sorted(live2d_tdolls)]))
    if not groups:
        return "Add assets"
    return f"Add art for {groups[0] if len(groups) == 1 else ', '.join(groups[:-1]) + ' and ' + groups[-1]}"


def sparse_pattern(rel):
    """Turn a path into a non-cone sparse-checkout pattern matching exactly that file.

    Args:
        rel: A relative path.

    Returns:
        The pattern, anchored at the root with glob characters escaped.
    """
    return "/" + re.sub(r"([*?\[\\])", r"\\\1", rel)


def run_with_input(clone, args, text):
    """Run a git command in a clone with text on standard input.

    Args:
        clone: The repository path.
        args: Arguments after `git -C <clone>`.
        text: The standard input.

    Raises:
        SystemExit: When the command fails.
    """
    result = subprocess.run(["git", "-C", clone, *args], input=text, capture_output=True, text=True, env={**os.environ, "GIT_LITERAL_PATHSPECS": "1"})
    if result.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed in {clone}:\n{result.stderr.strip()}")


def add(staging_tree, remote, branch="main", dry_run=False, sizes=None, token=None, batch_bytes=BATCH_BYTES):
    """Commit an incremental staging tree onto the asset repo's branch in commit-sized batches and push each one.

    The clone is shallow, has no blobs and checks out only the staged paths, so nothing hosted is downloaded except an earlier failed run's
    leftovers at those paths. A leftover is overwritten: the merge step already refused anything the manifest or Spine index lists, so a hosted
    file at a staged path can only come from a run whose site commit never landed. Identical files make no commit. The size check against the
    hosted tree runs once, over everything staged, before any batch is committed. Each batch is then committed and pushed before the next
    starts, so a failure partway through only costs the batches still to come: everything already pushed is already live, since the manifest
    and search index that reference these files live in the site repo, not this one.

    Args:
        staging_tree: The staging tree, such as `<staging>/assets`.
        remote: The repo URL to clone and push, such as `git@github.com:steve1316/gfl-archive-assets.git`.
        branch: The branch to commit onto.
        dry_run: Commit each batch in the throwaway clone and print it, but do not push any of them.
        sizes: Callable `(repo_title, branch)` returning hosted sizes by path. Defaults to the Git Trees API.
        token: Optional GitHub token for the API.
        batch_bytes: Maximum bytes of new files per commit. Defaults to `BATCH_BYTES`.

    Returns:
        The staged relative paths, empty when nothing was staged.

    Raises:
        SystemExit: When the tree would break GitHub's size guidance or a git command fails.
    """
    staged = list_tree(staging_tree) if os.path.isdir(staging_tree) else []
    if not staged:
        print(f"{REPO_TITLE}: nothing staged")
        return []
    hosted = (sizes or (lambda repo_title, ref: fetch_tree_sizes(repo_title, ref, token)))(REPO_TITLE, branch)
    limits = check_sizes(planned_tree(hosted, staged))
    for warning in limits["warnings"]:
        print(f"warning: {REPO_TITLE} {warning}")
    if limits["errors"]:
        sys.exit(f"{REPO_TITLE} cannot take these files:\n  " + "\n  ".join(limits["errors"]))

    paths = [rel for rel, _size in staged]
    rel_by_abs = {os.path.join(staging_tree, *rel.split("/")): rel for rel in paths}
    batches = [[rel_by_abs[abs_path] for abs_path in batch] for batch in batch_paths(list(rel_by_abs), batch_bytes)]

    with tempfile.TemporaryDirectory(prefix="add-") as scratch:
        clone = os.path.join(scratch, "clone")
        result = subprocess.run(["git", "clone", "-q", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", branch, remote, clone], capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit(f"cloning {remote} failed:\n{result.stderr.strip()}")
        git(clone, "checkout", "-q", branch)
        committed_any = False
        for batch in batches:
            run_with_input(clone, ["sparse-checkout", "set", "--no-cone", "--stdin"], "".join(f"{sparse_pattern(rel)}\n" for rel in batch))
            for rel in batch:
                target = os.path.join(clone, *rel.split("/"))
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copyfile(os.path.join(staging_tree, *rel.split("/")), target)
            run_with_input(clone, ["add", "--sparse", "--pathspec-from-file=-"], "".join(f"{rel}\n" for rel in batch))
            if not git(clone, "status", "--porcelain"):
                print(f"{REPO_TITLE}: batch of {len(batch)} file(s) already hosted, nothing to commit")
                continue
            committed_any = True
            message = commit_message(batch)
            git(clone, "commit", "-q", "-m", message)
            print(git(clone, "show", "--stat", "--format=%h %s", "HEAD"))
            if dry_run:
                print(f"{REPO_TITLE}: dry run, not pushed")
                continue
            git(clone, "push", "-q", "origin", branch)
            print(f"{REPO_TITLE}: pushed {message}")
        if not committed_any:
            print(f"{REPO_TITLE}: every staged file is already hosted, nothing to commit")
    return paths


def url_for(base, rel):
    """Build a raw URL for a hosted path, encoding each segment.

    Args:
        base: The asset repo's raw base URL, with or without a trailing slash.
        rel: The relative path.

    Returns:
        The absolute URL.
    """
    return base.rstrip("/") + "/" + "/".join(urllib.parse.quote(part) for part in rel.split("/"))


def http_status(url):
    """Fetch a URL's HTTP status with a HEAD request.

    Args:
        url: The URL.

    Returns:
        The status code, or None on a network failure such as a timeout or a dropped connection.
    """
    request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except OSError:
        return None


def wait_live(base, paths, timeout=LIVE_TIMEOUT_SECONDS, interval=LIVE_INTERVAL_SECONDS, status=None, clock=time.monotonic, sleep=time.sleep):
    """Poll new asset URLs until the raw host serves every one, or the timeout passes.

    Args:
        base: The asset repo's raw base URL the paths were pushed to.
        paths: The pushed relative paths.
        timeout: Seconds to keep polling.
        interval: Seconds between rounds.
        status: Callable returning a URL's HTTP status. Defaults to a HEAD request.
        clock: Monotonic clock, replaceable in tests.
        sleep: Sleep function, replaceable in tests.

    Returns:
        The URLs that still did not return 200, empty when all are live.
    """
    probe = status or http_status
    pending = [url_for(base, rel) for rel in paths]
    deadline = clock() + timeout
    while True:
        pending = [url for url in pending if probe(url) != 200]
        if not pending or clock() >= deadline:
            return pending
        sleep(interval)


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Entry point


def main():
    """Parse arguments and run `backup`, `prepare`, `add` or `wait-live`."""
    parser = argparse.ArgumentParser(description="Back up and prepare the asset repo. Never pushes.")
    commands = parser.add_subparsers(dest="command", required=True)

    backup_parser = commands.add_parser("backup", help="Bundle every ref of a clone and verify the bundle.")
    backup_parser.add_argument("--clone", required=True, help="Local clone of the asset repo.")
    backup_parser.add_argument("--out", required=True, help="Directory to write the bundle into.")

    prepare_parser = commands.add_parser("prepare", help="Commit the verified staging tree onto an orphan branch.")
    prepare_parser.add_argument("--clone", required=True, help="Local clone of the asset repo.")
    prepare_parser.add_argument("--assets", default=STAGING_TREE, help="The asset staging tree.")
    prepare_parser.add_argument("--manifest", default=MANIFEST_NAME, help="The committed repo-root manifest the regenerated one must match.")
    prepare_parser.add_argument("--spine-index", default="src/data/spine-index.json", help="The Spine index the audit checks.")
    prepare_parser.add_argument("--res-version", help="ResData version. Defaults to the one in tools/assets/.cache/inventory.json.")
    prepare_parser.add_argument("--replace-branch", action="store_true", help="Delete an existing rebuild branch first.")

    add_parser = commands.add_parser("add", help="Commit an incremental staging tree onto the asset repo and push it.")
    add_parser.add_argument("--staging", required=True, help="The staging tree, such as <staging>/assets.")
    add_parser.add_argument("--remote", required=True, help="The repo URL to clone and push.")
    add_parser.add_argument("--branch", default="main", help="The branch to commit onto.")
    add_parser.add_argument("--list", required=True, help="Where to write the staged paths as JSON, for wait-live.")
    add_parser.add_argument("--dry-run", action="store_true", help="Commit in a throwaway clone but do not push.")

    wait_parser = commands.add_parser("wait-live", help="Poll pushed asset URLs until the raw host serves them.")
    wait_parser.add_argument("--base", required=True, help="The asset repo's raw base URL.")
    wait_parser.add_argument("--list", required=True, help="The JSON path list written by add.")
    wait_parser.add_argument("--timeout", type=int, default=LIVE_TIMEOUT_SECONDS, help="Seconds to keep polling.")
    args = parser.parse_args()

    if args.command == "add":
        paths = add(args.staging, args.remote, args.branch, args.dry_run, token=os.environ.get("GITHUB_TOKEN"))
        with open(args.list, "w", encoding="utf-8") as handle:
            json.dump(paths, handle)
        return
    if args.command == "wait-live":
        with open(args.list, encoding="utf-8") as handle:
            paths = json.load(handle)
        pending = wait_live(args.base, paths, args.timeout)
        if pending:
            sys.exit(f"{len(pending)} of {len(paths)} assets are still not live after {args.timeout}s:\n  " + "\n  ".join(pending[:20]))
        print(f"all {len(paths)} assets are live on {args.base}")
        return

    if args.command == "backup":
        if not os.path.isdir(args.out):
            sys.exit(f"no such directory: {args.out}")
        backup(args.clone, args.out)
        return

    if not os.path.isdir(args.assets):
        sys.exit(f"no such staging tree: {args.assets}")
    prepare(args.clone, args.assets, args.manifest, args.spine_index, resolve_res_version(args.res_version), args.replace_branch)


if __name__ == "__main__":
    main()
