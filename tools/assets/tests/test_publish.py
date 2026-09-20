"""Unit tests for `publish.py`, run with `python3 -m unittest discover tools/assets/tests`.

The size and manifest checks are tested directly. `prepare` and `backup` run against throwaway git repos in a temporary directory, with
no remote and no network.
"""

import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import build_manifest  # noqa: E402
import publish  # noqa: E402


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Helpers

MB = publish.BYTES_PER_MB

GIT_IDENTITY = {"GIT_AUTHOR_NAME": "test", "GIT_AUTHOR_EMAIL": "test@example.com", "GIT_COMMITTER_NAME": "test", "GIT_COMMITTER_EMAIL": "test@example.com"}


def write(root, rel, data=b"x"):
    """Write one file under a root, making folders as needed.

    Args:
        root: The root directory.
        rel: Relative file path.
        data: File contents as bytes.
    """
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)


def run_git(repo, *args):
    """Run a git command in a test repo.

    Args:
        repo: The repository path.
        *args: Arguments after `git -C <repo>`.

    Returns:
        The stripped standard output.
    """
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout.strip()


def git_verify(repo, ref):
    """Check whether a ref exists in a test repo.

    Args:
        repo: The repository path.
        ref: The ref to check, e.g. "refs/heads/rebuild".

    Returns:
        True when the ref exists.
    """
    return subprocess.run(["git", "-C", repo, "rev-parse", "--verify", "--quiet", ref], capture_output=True).returncode == 0


def make_fixture(root):
    """Build a tiny staging tree, its manifest, a Spine index, and a clone tracking a local origin.

    The clone is built with `remote add` + `fetch`, the same way the real asset-repo clones came to be, rather than
    `git clone` -- that leaves `refs/remotes/origin/HEAD` unset locally, reproducing the exact condition
    `default_branch` must not depend on and that `prepare` must still resolve and sync-check correctly.

    Args:
        root: Temporary directory to build in.

    Returns:
        A dict of the paths the tests pass to `prepare`, plus `origin`.
    """
    assets, origin, clone = (os.path.join(root, name) for name in ("assets", "origin", "clone"))
    write(assets, "tdolls/1/card.webp")
    write(assets, "tdolls/1/card_d.webp")
    write(assets, "tdolls/1/skill1.png")
    write(assets, "spine/1/A.skel")
    write(assets, "spine/1/A.atlas", b"\nA.png\nsize: 2,2\n")
    write(assets, "spine/1/A.png")
    write(assets, "equipment/5.png")
    write(assets, "logo.png")
    write(assets, "assets-manifest.json", b"stale copy that must not be published")
    write(assets, "tdolls/1/full.webp", b"full")
    write(assets, "tdolls/1/full_d.webp", b"full_d")

    manifest = os.path.join(root, "assets-manifest.json")
    with open(manifest, "w", encoding="utf-8") as handle:
        handle.write(build_manifest.dumps(build_manifest.build_v3(assets)))
    spine_index = os.path.join(root, "spine-index.json")
    with open(spine_index, "w", encoding="utf-8") as handle:
        json.dump({"1": {"combat": {"skel": "A", "atlas": "A", "anims": ["wait"]}}}, handle)

    os.makedirs(origin)
    run_git(origin, "init", "--quiet", "--initial-branch", "main")
    write(origin, "old/110_card.png", b"old")
    write(origin, "CNAME", b"assets.example.com\n")
    write(origin, ".nojekyll", b"")
    run_git(origin, "add", "--all")
    run_git(origin, "commit", "--quiet", "-m", "Old layout")

    os.makedirs(clone)
    run_git(clone, "init", "--quiet", "--initial-branch", "main")
    run_git(clone, "remote", "add", "origin", origin)
    run_git(clone, "fetch", "--quiet", "origin")
    run_git(clone, "checkout", "--quiet", "-b", "main", "origin/main")
    return {"assets_root": assets, "manifest_path": manifest, "spine_index_path": spine_index, "clone": clone, "origin": origin}


def quiet(function, *args, **kwargs):
    """Call a function with its standard output swallowed.

    Args:
        function: The function to call.
        *args: Positional arguments.
        **kwargs: Keyword arguments.

    Returns:
        A `(result, output)` pair.
    """
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        result = function(*args, **kwargs)
    return result, buffer.getvalue()


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Pure checks


class CheckSizesTests(unittest.TestCase):
    """Size checks against our own limits under GitHub's 5 GB repo recommendation."""

    def test_small_tree_passes_with_stats(self):
        """A small tree passes and reports count, total and largest file."""
        stats = publish.check_sizes([("a.png", 10), ("b/c.webp", 30), ("d.png", 20)])
        self.assertEqual(stats["errors"], [])
        self.assertEqual(stats["warnings"], [])
        self.assertEqual((stats["count"], stats["total"], stats["largest"]), (3, 60, ("b/c.webp", 30)))

    def test_check_sizes_follows_github_limits(self):
        """A tree warns past 4,000 MB and is refused at 5,000 MB."""
        at_warn_line = [(f"f{i}", 40 * MB) for i in range(100)]
        self.assertEqual(publish.check_sizes(at_warn_line)["errors"], [])
        self.assertEqual(len(publish.check_sizes(at_warn_line + [("g", 1)])["warnings"]), 1)
        at_refuse_line = [(f"f{i}", 50 * MB) for i in range(100)]
        self.assertIn("5000 MB limit", publish.check_sizes(at_refuse_line)["errors"][0])

    def test_file_over_50_mb_is_refused(self):
        """A file of 50 MB passes and one byte more is refused."""
        stats = publish.check_sizes([("ok.png", 50 * MB), ("big.png", 50 * MB + 1)])
        self.assertEqual(len(stats["errors"]), 1)
        self.assertIn("big.png", stats["errors"][0])

    def test_empty_tree(self):
        """An empty tree has no largest file."""
        self.assertIsNone(publish.check_sizes([])["largest"])


class CompareManifestsTests(unittest.TestCase):
    """The byte-identity check between the regenerated and committed manifests."""

    def test_identical_bytes(self):
        """Byte-identical manifests pass."""
        text = build_manifest.dumps({"version": 3, "dolls": {}})
        self.assertIsNone(publish.compare_manifests(text, text))

    def test_formatting_only_difference_still_fails(self):
        """The same content with different formatting is still a failure."""
        manifest = {"version": 3, "dolls": {}}
        message = publish.compare_manifests(build_manifest.dumps(manifest), build_manifest.dumps(manifest, indent=2))
        self.assertIn("formatting", message)

    def test_content_difference_fails(self):
        """Different content fails."""
        message = publish.compare_manifests(build_manifest.dumps({"equipment": [1]}), build_manifest.dumps({"equipment": [1, 2]}))
        self.assertIn("differs", message)

    def test_unparsable_committed_copy_fails(self):
        """A committed copy that is not JSON fails."""
        self.assertIn("differs", publish.compare_manifests("{}\n", "not json"))


class NamingTests(unittest.TestCase):
    """Backup file names and the README."""

    def test_repo_name_from_remote_or_folder(self):
        """The name comes from the remote URL, or the folder when there is no remote."""
        self.assertEqual(publish.repo_name("https://github.com/o/gfl-archive-assets.git", "/x/clone"), "gfl-archive-assets")
        self.assertEqual(publish.repo_name("git@github.com:o/gfl-wiki-assets-art.git", "/x/clone"), "gfl-wiki-assets-art")
        self.assertEqual(publish.repo_name("", "/x/assets-probe"), "assets-probe")

    def test_readme_names_source_and_rights(self):
        """The README names the repo, the ResData version and the rights holder."""
        text = publish.readme_text("2026082516")
        self.assertIn("gfl-archive-assets", text)
        self.assertIn("2026082516", text)
        self.assertIn("© Sunborn/MICA Team, mirrored for fan site use", text)


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Git round trips


@mock.patch.dict(os.environ, GIT_IDENTITY)
class PrepareTests(unittest.TestCase):
    """The orphan-branch commit in a clone."""

    def setUp(self):
        """Build the fixture in a temporary directory."""
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = make_fixture(self.tmp.name)

    def tearDown(self):
        """Remove the fixture."""
        self.tmp.cleanup()

    def prepare(self, **overrides):
        """Run `prepare` on the fixture with its output swallowed.

        Args:
            **overrides: Arguments to replace.

        Returns:
            The captured output.
        """
        args = {key: value for key, value in self.paths.items() if key != "origin"}
        args.update(res_version="2026082516", replace_branch=False)
        args.update(overrides)
        return quiet(publish.prepare, **args)[1]

    def test_assets_repo_gets_orphan_commit_with_kept_files_and_fresh_manifest(self):
        """The repo gets one parentless commit with CNAME, a README and the committed manifest, and the old files are gone."""
        output = self.prepare()
        clone = self.paths["clone"]
        self.assertEqual(run_git(clone, "rev-parse", "--abbrev-ref", "HEAD"), "rebuild")
        self.assertEqual(run_git(clone, "rev-list", "--count", "HEAD"), "1")
        self.assertEqual(run_git(clone, "log", "-1", "--format=%s"), "Rebuild assets from game data (2026082516)")
        files = set(run_git(clone, "ls-tree", "-r", "--name-only", "HEAD").splitlines())
        self.assertNotIn("old/110_card.png", files)
        self.assertTrue({"CNAME", "README.md", "assets-manifest.json", "spine/1/A.png", "logo.png"} <= files)
        with open(self.paths["manifest_path"], encoding="utf-8") as handle:
            self.assertEqual(run_git(clone, "show", "HEAD:assets-manifest.json") + "\n", handle.read())
        self.assertEqual(run_git(clone, "show", "HEAD:CNAME"), "assets.example.com")
        lease = run_git(self.paths["origin"], "rev-parse", "main")
        self.assertIn(f"git -C {clone} push --force-with-lease=main:{lease} origin rebuild:main", output)
        self.assertNotIn("push --force origin", output)
        self.assertLess(output.index("gfl-archive-assets with"), output.index("site's master immediately"))
        self.assertIn("verify_live_assets.mjs", output)
        self.assertNotIn("gfl-wiki-assets-art", output)
        self.assertEqual(run_git(clone, "status", "--porcelain"), "")

    def test_nojekyll_is_not_kept(self):
        """The rebuilt tree never carries `.nojekyll`, even when the clone had one, since the asset repo is no longer served through Pages."""
        self.prepare()
        files = set(run_git(self.paths["clone"], "ls-tree", "-r", "--name-only", "HEAD").splitlines())
        self.assertNotIn(".nojekyll", files)

    def test_manifest_mismatch_stops_before_touching_the_clone(self):
        """A staging tree that no longer matches the committed manifest stops before any git change."""
        write(self.paths["assets_root"], "tdolls/2/full.webp")
        with self.assertRaises(SystemExit) as caught:
            self.prepare()
        self.assertIn("differs", str(caught.exception.code))
        self.assertEqual(run_git(self.paths["clone"], "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_audit_failure_stops_before_touching_the_clone(self):
        """A missing atlas page fails the audit before any git change."""
        os.remove(os.path.join(self.paths["assets_root"], "spine/1/A.png"))
        with self.assertRaises(SystemExit) as caught:
            self.prepare()
        self.assertIn("audit failed", str(caught.exception.code))
        self.assertEqual(run_git(self.paths["clone"], "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_existing_rebuild_branch_needs_replace_flag(self):
        """An existing rebuild branch is only replaced when asked."""
        self.prepare()
        run_git(self.paths["clone"], "checkout", "--quiet", "main")
        with self.assertRaises(SystemExit):
            self.prepare()
        self.prepare(replace_branch=True)
        self.assertEqual(run_git(self.paths["clone"], "rev-list", "--count", "rebuild"), "1")

    def test_clone_behind_origin_stops_before_touching_the_clone(self):
        """When origin has moved on and the clone has not, prepare refuses before any git change."""
        origin = self.paths["origin"]
        write(origin, "extra.txt", b"new upstream commit")
        run_git(origin, "add", "--all")
        run_git(origin, "commit", "--quiet", "-m", "Upstream moves on")
        with self.assertRaises(SystemExit) as caught:
            self.prepare()
        self.assertIn("behind", str(caught.exception.code))
        self.assertEqual(run_git(self.paths["clone"], "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertFalse(git_verify(self.paths["clone"], f"refs/heads/{publish.BRANCH}"))

    def test_clone_ahead_of_origin_stops_before_touching_the_clone(self):
        """A clone with a local commit origin has never seen refuses before any git change."""
        write(self.paths["clone"], "local-only.txt", b"oops")
        run_git(self.paths["clone"], "add", "--all")
        run_git(self.paths["clone"], "commit", "--quiet", "-m", "Local-only commit")
        with self.assertRaises(SystemExit) as caught:
            self.prepare()
        self.assertIn("ahead", str(caught.exception.code))
        self.assertEqual(run_git(self.paths["clone"], "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertFalse(git_verify(self.paths["clone"], f"refs/heads/{publish.BRANCH}"))

    def test_size_limit_stops_before_touching_the_clone(self):
        """A planned tree over the size limit refuses before any git change, like the manifest and audit stops."""
        with mock.patch.object(publish, "REFUSE_TOTAL_BYTES", 10):
            with self.assertRaises(SystemExit) as caught:
                self.prepare()
        self.assertIn("MB", str(caught.exception.code))
        self.assertEqual(run_git(self.paths["clone"], "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertFalse(git_verify(self.paths["clone"], f"refs/heads/{publish.BRANCH}"))


class ParseSymrefHeadTests(unittest.TestCase):
    """The pure `git ls-remote --symref origin HEAD` parser."""

    def test_parses_the_default_branch(self):
        """A normal ls-remote --symref response yields the branch name."""
        output = "ref: refs/heads/main\tHEAD\n036ddf31e2c3ac827c2360ebb4bc3fd0c3b41811\tHEAD\n"
        self.assertEqual(publish.parse_symref_head(output), "main")

    def test_parses_a_non_main_default_branch(self):
        """A repo defaulting to a differently named branch is read correctly."""
        self.assertEqual(publish.parse_symref_head("ref: refs/heads/develop\tHEAD\nabc123\tHEAD\n"), "develop")

    def test_no_symref_line_returns_none(self):
        """Output without a `ref:` line for HEAD (e.g. a detached HEAD on the remote) yields None."""
        self.assertIsNone(publish.parse_symref_head("036ddf31e2c3ac827c2360ebb4bc3fd0c3b41811\tHEAD\n"))

    def test_empty_output_returns_none(self):
        """No output at all yields None."""
        self.assertIsNone(publish.parse_symref_head(""))


class DefaultBranchTests(unittest.TestCase):
    """`default_branch` resolves from the remote through an injected command runner, never from local state."""

    def test_resolves_from_ls_remote_symref(self):
        """The branch comes from `ls-remote --symref origin HEAD`, run through the injected runner."""
        calls = []

        def fake_run(clone, *args, **kwargs):
            calls.append((clone, args))
            return "ref: refs/heads/main\tHEAD\n036ddf3\tHEAD\n"

        self.assertEqual(publish.default_branch("/some/clone", run=fake_run), "main")
        self.assertEqual(calls, [("/some/clone", ("ls-remote", "--symref", "origin", "HEAD"))])

    def test_unresolvable_default_branch_exits(self):
        """When the remote gives no symref for HEAD, default_branch fails loudly instead of guessing from local state."""
        with self.assertRaises(SystemExit) as caught:
            publish.default_branch("/some/clone", run=lambda *a, **k: "")
        self.assertIn("could not resolve", str(caught.exception.code))


class BranchSyncStatusTests(unittest.TestCase):
    """The ahead/behind/diverged comparison against origin, from injected `rev-list --left-right --count` output."""

    def test_even_is_none(self):
        """Matching counts mean no problem."""
        self.assertIsNone(publish.branch_sync_status("/c", "main", "0\t0"))

    def test_behind(self):
        """Zero ahead, some behind: the local branch is behind."""
        message = publish.branch_sync_status("/c", "main", "0\t3")
        self.assertIn("behind", message)
        self.assertIn("3", message)

    def test_ahead(self):
        """Some ahead, zero behind: the local branch is ahead."""
        message = publish.branch_sync_status("/c", "main", "2\t0")
        self.assertIn("ahead", message)
        self.assertIn("2", message)

    def test_diverged(self):
        """Both ahead and behind: the branches have diverged."""
        message = publish.branch_sync_status("/c", "main", "2\t3")
        self.assertIn("diverged", message)
        self.assertIn("2 ahead", message)
        self.assertIn("3 behind", message)

    def test_message_names_the_clone_and_branch(self):
        """The message names the clone path and branch so the refusal is actionable."""
        message = publish.branch_sync_status("/x/clone", "main", "0\t1")
        self.assertIn("/x/clone", message)
        self.assertIn("main", message)


@mock.patch.dict(os.environ, GIT_IDENTITY)
class BackupTests(unittest.TestCase):
    """The verified bundle backup."""

    def test_bundle_restores_every_ref(self):
        """The bundle restores HEAD and every ref, and an existing bundle is never overwritten."""
        with tempfile.TemporaryDirectory() as tmp:
            clone = make_fixture(tmp)["clone"]
            run_git(clone, "branch", "side")
            bundle, output = quiet(publish.backup, clone, tmp)
            self.assertTrue(os.path.basename(bundle).startswith("origin-"))
            self.assertIn("all 3 refs match", output)
            with self.assertRaises(SystemExit):
                quiet(publish.backup, clone, tmp)


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Incremental add


def git_in(cwd, *args, stdin=None):
    """Run git with the test identity and return its output.

    Args:
        cwd: Working directory.
        *args: Git arguments.
        stdin: Optional text piped to the command.

    Returns:
        The stripped standard output.
    """
    result = subprocess.run(["git", *args], cwd=cwd, input=stdin, capture_output=True, text=True, env={**os.environ, **GIT_IDENTITY}, check=True)
    return result.stdout.strip()


def make_remote(scratch, files):
    """Create a bare repo on `main` that allows partial clones, seeded with files.

    Args:
        scratch: Temporary directory.
        files: Map of relative path to bytes.

    Returns:
        A `file://` URL of the bare repo and its path.
    """
    bare = os.path.join(scratch, "remote.git")
    git_in(scratch, "init", "-q", "--bare", "-b", "main", bare)
    git_in(bare, "config", "uploadpack.allowfilter", "true")
    git_in(bare, "config", "uploadpack.allowanysha1inwant", "true")
    seed = os.path.join(scratch, "seed")
    git_in(scratch, "clone", "-q", bare, seed)
    for rel, data in files.items():
        path = os.path.join(seed, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)
    git_in(seed, "add", "-A")
    git_in(seed, "commit", "-q", "-m", "seed")
    git_in(seed, "push", "-q", "origin", "HEAD:main")
    return f"file://{bare}", bare


def stage(root, files):
    """Write staged files.

    Args:
        root: The staging tree.
        files: Map of relative path to bytes.
    """
    for rel, data in files.items():
        path = os.path.join(root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as handle:
            handle.write(data)


def no_sizes(_title, _branch):
    """Report an empty hosted tree.

    Args:
        _title: Ignored repo title.
        _branch: Ignored branch.

    Returns:
        An empty dict.
    """
    return {}


class CommitMessageTests(unittest.TestCase):
    """Naming what an add commit holds."""

    def test_one_doll(self):
        """Card, full art and rig files of one doll name that doll."""
        self.assertEqual(publish.commit_message(["tdolls/424/card.webp", "spine/424/Foo.skel"]), "Add art for doll 424")

    def test_mixed(self):
        """Dolls, skins, equipment, HOCs and fairies are grouped, numbered and joined."""
        paths = [
            "tdolls/425/card.webp",
            "tdolls/424/mod/card.webp",
            "tdolls/65/skins/9001/card.webp",
            "spine/65/skins/9001/a.skel",
            "equipment/301.png",
            "hocs/6/card.webp",
            "fairies/9/form1.webp",
        ]
        self.assertEqual(publish.commit_message(paths), "Add art for dolls 424, 425, skin 65:9001, equipment 301, hoc 6 and fairy 9")

    def test_hoc_art_and_rig(self):
        """Card art and rig files under a HOC's own top-level folders name that HOC once."""
        paths = ["hocs/6/card.webp", "hocs/6/full.webp", "hoc-spine/6/QLZ04.skel", "hoc-spine/6/QLZ04 A.atlas"]
        self.assertEqual(publish.commit_message(paths), "Add art for hoc 6")

    def test_fairy_art(self):
        """Form art files under a fairy's own top-level folder name that fairy once."""
        paths = ["fairies/6/form1.webp", "fairies/6/form2.webp", "fairies/6/form3.webp"]
        self.assertEqual(publish.commit_message(paths), "Add art for fairy 6")

    def test_multiple_fairies_are_pluralised_irregularly(self):
        """Two fairies read as `fairies`, not `fairys`."""
        paths = ["fairies/9/form1.webp", "fairies/10/form1.webp"]
        self.assertEqual(publish.commit_message(paths), "Add art for fairies 9, 10")

    def test_live2d_only(self):
        """A Live2D-only publish names the fairies and the HOC, not `Add assets`."""
        paths = [
            "live2d/fairies/9/form1.model3.json",
            "live2d/fairies/9/form1.moc3",
            "live2d/fairies/10/form1.model3.json",
            "live2d/hocs/6/model.model3.json",
            "live2d/hocs/6/model.moc3",
        ]
        self.assertEqual(publish.commit_message(paths), "Add art for live2d hoc 6 and live2d fairies 9, 10")

    def test_live2d_mixed_with_other_tiers(self):
        """A publish mixing Live2D models with plain art still names every tier."""
        paths = ["hocs/6/card.webp", "live2d/hocs/6/model.model3.json", "fairies/9/form1.webp", "live2d/fairies/9/form1.model3.json"]
        self.assertEqual(publish.commit_message(paths), "Add art for hoc 6, fairy 9, live2d hoc 6 and live2d fairy 9")

    def test_live2d_skin_names_the_doll_once_across_form_skin_and_variant(self):
        """A T-Doll skin Live2D batch names each doll once, not once per form, skin or variant folder."""
        paths = [
            "live2d/tdolls/104/base/1202/normal/model.model3.json",
            "live2d/tdolls/104/base/1202/damaged/model.model3.json",
            "live2d/tdolls/104/base/base/normal/model.model3.json",
            "live2d/tdolls/57/mod/4508/normal/model.model3.json",
        ]
        self.assertEqual(publish.commit_message(paths), "Add art for live2d dolls 57, 104")

    def test_live2d_skin_mixed_with_other_live2d_tiers(self):
        """A batch mixing skin models with fairy or HOC ones still names every tier separately."""
        paths = ["live2d/tdolls/104/base/base/normal/model.model3.json", "live2d/fairies/9/form1.model3.json"]
        self.assertEqual(publish.commit_message(paths), "Add art for live2d fairy 9 and live2d doll 104")


class PlannedTreeTests(unittest.TestCase):
    """Combining hosted and staged sizes under GitHub's 5 GB repo recommendation."""

    def test_staged_file_replaces_hosted_size(self):
        """A staged file at a hosted path counts once, at its staged size."""
        self.assertEqual(publish.planned_tree({"a": 5, "b": 7}, [("b", 9), ("c", 1)]), [("a", 5), ("b", 9), ("c", 1)])


class BatchPathsTests(unittest.TestCase):
    """Grouping files into commit-sized batches."""

    def test_batch_paths_splits_on_the_byte_budget(self):
        """Files are packed into a batch until the next one would go over the budget."""
        with tempfile.TemporaryDirectory() as tmp_path:
            for name, size in (("a", 400), ("b", 400), ("c", 400)):
                write(tmp_path, name, b"x" * size)
            batches = publish.batch_paths([os.path.join(tmp_path, n) for n in ("a", "b", "c")], 900)
            self.assertEqual([len(batch) for batch in batches], [2, 1])

    def test_batch_paths_keeps_a_file_larger_than_the_budget_in_its_own_batch(self):
        """A single file over the budget is never dropped, it just gets a batch of its own."""
        with tempfile.TemporaryDirectory() as tmp_path:
            write(tmp_path, "big", b"x" * 5000)
            write(tmp_path, "small", b"x" * 10)
            batches = publish.batch_paths([os.path.join(tmp_path, n) for n in ("big", "small")], 900)
            self.assertEqual([len(batch) for batch in batches], [1, 1])

    def test_batch_paths_returns_nothing_for_no_paths(self):
        """No paths means no batches."""
        self.assertEqual(publish.batch_paths([], 900), [])


@mock.patch.dict(os.environ, GIT_IDENTITY)
class AddTests(unittest.TestCase):
    """`add` commits staged files onto the remote branch through a blobless sparse clone."""

    def test_adds_new_files_and_keeps_the_rest(self):
        """New files are committed and pushed with a named message, and unrelated hosted files stay."""
        with tempfile.TemporaryDirectory() as scratch:
            remote, bare = make_remote(scratch, {"tdolls/1/card.webp": b"old", ".nojekyll": b""})
            tree = os.path.join(scratch, "staging", "assets")
            stage(tree, {"tdolls/424/card.webp": b"new card", "tdolls/424/card_d.webp": b"damaged"})
            with contextlib.redirect_stdout(io.StringIO()):
                paths = publish.add(tree, remote, sizes=no_sizes)
            self.assertEqual(paths, ["tdolls/424/card.webp", "tdolls/424/card_d.webp"])
            self.assertEqual(git_in(bare, "log", "-1", "--format=%s", "main"), "Add art for doll 424")
            self.assertEqual(
                git_in(bare, "ls-tree", "-r", "--name-only", "main").split("\n"),
                [".nojekyll", "tdolls/1/card.webp", "tdolls/424/card.webp", "tdolls/424/card_d.webp"],
            )

    def test_overwrites_a_leftover_and_skips_identical(self):
        """A leftover with other bytes is replaced, and a retry with identical bytes makes no commit."""
        with tempfile.TemporaryDirectory() as scratch:
            remote, bare = make_remote(scratch, {"tdolls/424/card.webp": b"leftover"})
            tree = os.path.join(scratch, "staging", "assets")
            stage(tree, {"tdolls/424/card.webp": b"fresh"})
            with contextlib.redirect_stdout(io.StringIO()):
                publish.add(tree, remote, sizes=no_sizes)
                head = git_in(bare, "rev-parse", "main")
                self.assertEqual(git_in(bare, "show", "main:tdolls/424/card.webp"), "fresh")
                publish.add(tree, remote, sizes=no_sizes)
            self.assertEqual(git_in(bare, "rev-parse", "main"), head)

    def test_dry_run_does_not_push(self):
        """A dry run commits in the throwaway clone only."""
        with tempfile.TemporaryDirectory() as scratch:
            remote, bare = make_remote(scratch, {".nojekyll": b""})
            head = git_in(bare, "rev-parse", "main")
            tree = os.path.join(scratch, "staging", "assets")
            stage(tree, {"tdolls/424/full.webp": b"art"})
            with contextlib.redirect_stdout(io.StringIO()):
                publish.add(tree, remote, dry_run=True, sizes=no_sizes)
            self.assertEqual(git_in(bare, "rev-parse", "main"), head)

    def test_oversized_tree_is_refused_before_cloning(self):
        """A tree that would break GitHub's size guidance stops before anything is cloned or pushed."""
        with tempfile.TemporaryDirectory() as scratch:
            remote, bare = make_remote(scratch, {".nojekyll": b""})
            head = git_in(bare, "rev-parse", "main")
            tree = os.path.join(scratch, "staging", "assets")
            stage(tree, {"tdolls/424/full.webp": b"art"})
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
                publish.add(tree, remote, sizes=lambda _title, _branch: {"huge.bin": 5000 * MB})
            self.assertEqual(git_in(bare, "rev-parse", "main"), head)

    def test_nothing_staged(self):
        """A missing or empty staging tree returns no paths without touching the remote."""
        with tempfile.TemporaryDirectory() as scratch, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(publish.add(os.path.join(scratch, "missing"), "file:///nowhere", sizes=no_sizes), [])

    def test_publishes_multiple_batches_as_separate_commits(self):
        """Files over the batch budget go out as their own commits, each pushed before the next batch is built."""
        with tempfile.TemporaryDirectory() as scratch:
            remote, bare = make_remote(scratch, {".nojekyll": b""})
            tree = os.path.join(scratch, "staging", "assets")
            stage(
                tree,
                {"tdolls/424/card.webp": b"x" * 400, "tdolls/425/card.webp": b"x" * 400, "tdolls/426/card.webp": b"x" * 400},
            )
            with contextlib.redirect_stdout(io.StringIO()):
                paths = publish.add(tree, remote, sizes=no_sizes, batch_bytes=900)
            self.assertEqual(paths, ["tdolls/424/card.webp", "tdolls/425/card.webp", "tdolls/426/card.webp"])
            subjects = git_in(bare, "log", "--format=%s", "main").split("\n")
            self.assertEqual(subjects[:2], ["Add art for doll 426", "Add art for dolls 424, 425"])
            revs = git_in(bare, "log", "--format=%H", "main").split("\n")
            first_batch, second_batch = revs[1], revs[0]
            self.assertEqual(
                git_in(bare, "ls-tree", "-r", "--name-only", first_batch).split("\n"),
                [".nojekyll", "tdolls/424/card.webp", "tdolls/425/card.webp"],
            )
            self.assertEqual(
                git_in(bare, "ls-tree", "-r", "--name-only", second_batch).split("\n"),
                [".nojekyll", "tdolls/424/card.webp", "tdolls/425/card.webp", "tdolls/426/card.webp"],
            )


class WaitLiveTests(unittest.TestCase):
    """Polling asset URLs via the raw content API until they are live."""

    def test_url_encoding(self):
        """Each path segment is percent-encoded onto the base."""
        self.assertEqual(publish.url_for("https://x.io/repo/", "spine/65/a b.png"), "https://x.io/repo/spine/65/a%20b.png")

    def test_waits_until_all_are_live(self):
        """URLs still returning 404 are polled again after the interval until they return 200."""
        answers = {"https://x.io/a": [404, 200], "https://x.io/b": [200]}
        sleeps = []
        pending = publish.wait_live(
            "https://x.io", ["a", "b"], timeout=100, interval=5, status=lambda url: answers[url].pop(0), clock=lambda: 0, sleep=sleeps.append
        )
        self.assertEqual(pending, [])
        self.assertEqual(sleeps, [5])

    def test_gives_up_after_the_timeout(self):
        """URLs that never go live are returned once the deadline passes."""
        now = iter([0, 50, 101])
        pending = publish.wait_live("https://x.io", ["a"], timeout=100, interval=5, status=lambda _url: 404, clock=lambda: next(now), sleep=lambda _seconds: None)
        self.assertEqual(pending, ["https://x.io/a"])

    def test_dropped_connection_counts_as_not_live(self):
        """A connection reset mid-request is a network failure, not a crash."""
        with mock.patch("urllib.request.urlopen", side_effect=ConnectionResetError):
            self.assertIsNone(publish.http_status("https://x.io/a"))


class TreeSizeTests(unittest.TestCase):
    """Reading hosted sizes from the Git Trees API."""

    def response(self, body):
        """Build a fake `urlopen` returning a JSON body.

        Args:
            body: The JSON value.

        Returns:
            A callable standing in for `urllib.request.urlopen`.
        """

        @contextlib.contextmanager
        def opener(_request, timeout=None):
            yield io.BytesIO(json.dumps(body).encode())

        return opener

    def test_blob_sizes(self):
        """Only blobs are counted."""
        body = {"truncated": False, "tree": [{"path": "a", "type": "blob", "size": 3}, {"path": "d", "type": "tree"}]}
        self.assertEqual(publish.fetch_tree_sizes("gfl-archive-assets", opener=self.response(body)), {"a": 3})

    def test_truncated_tree_stops(self):
        """A truncated listing cannot be trusted for the size limit."""
        with self.assertRaises(SystemExit):
            publish.fetch_tree_sizes("gfl-archive-assets", opener=self.response({"truncated": True, "tree": []}))

    def test_http_error_exits(self):
        """An HTTP error from the API exits with a readable message instead of a raw traceback."""

        def failing_opener(_request, timeout=None):
            raise urllib.error.HTTPError("https://api.github.com/x", 403, "rate limited", {}, None)

        with self.assertRaises(SystemExit):
            publish.fetch_tree_sizes("gfl-archive-assets", opener=failing_opener)


if __name__ == "__main__":
    unittest.main()
