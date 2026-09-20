#!/usr/bin/env python3
"""Download Spine chibi bundles from the game CDN and unpack them, keyed by doll id.

Spine data ships inside Unity asset bundles on the CDN. `gf-resource-downloader` fetches those bundles
but deliberately does not open them, so this script does both halves: fetch the handful of bundles that
matter, then extract the Spine files with UnityPy. The full asset rebuild uses `game_bundles.py` and
`extract_game_assets.py` instead, and imports its naming helpers from here.

Only the bundles for the requested dolls are fetched, not the whole 478 MB chibi tier, which keeps a
refresh to tens of megabytes.

Three kinds of rig are available. `--ids` fetches base rigs, `--ids --mod` fetches the Mod rigs of the
same dolls, and `--skin-pairs` fetches individual skins. Mod skins are not a thing: a Mod doll wearing
a skin shows the skin's own chibi, and the archive has no Mod skin animations either.

Each bundle yields:

- one `.skel` TextAsset per skeleton, the combat rig plus an `R`-prefixed dorm rig
- one `.atlas` TextAsset describing the sprite regions
- one `Texture2D` atlas page, saved as PNG

Requires `UnityPy`.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import zipfile


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Constants

BUNDLE_KEYS = ("BaseAssetBundles", "AddAssetBundles")

# Spine bundles are named after the weapon codename from `gun.hjson`. A few dolls, AA12 among them,
# keep their skeleton in the plain `character_<code>` bundle with no suffix, so both are tried.
BUNDLE_TEMPLATES = ("character_{code}_spine", "character_{code}")

# Collaboration units carry no `code` in `gun.hjson`, so their bundles are named explicitly.
CODE_OVERRIDES = {
    1003: "kiana",
    1004: "raidenmei",
    1005: "bronya",
    1006: "theresa",
    1007: "himeko",
    1008: "seele",
}

# Mod rigs are a separate doll in `gun.hjson`, filed 20000 above the original with `Mod` appended to
# the codename, so `G3` at 63 becomes `G3Mod` at 20063.
MOD_ID_OFFSET = 20000

RECORD_OPEN = "  {"
RECORD_CLOSE = ("  },", "  }")
FIELD_RE = re.compile(r"^    (id|code): (.*)$")


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Lookup


def parse_guns(path):
    """Map each doll id to its weapon codename.

    Args:
        path: Path to `formatted/gun.hjson` from `gf-data-us`.

    Returns:
        A dict mapping integer doll id to codename.
    """
    codes, current = {}, None
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.rstrip("\n")
            if line == RECORD_OPEN:
                current = {}
            elif line in RECORD_CLOSE:
                if current and current.get("id", "").isdigit() and current.get("code"):
                    codes[int(current["id"])] = current["code"]
                current = None
            elif current is not None:
                match = FIELD_RE.match(line)
                if match:
                    current.setdefault(match.group(1), match.group(2).strip().strip('"').strip("'"))
    return codes


def resolve_code(doll_id, codes, mod=False):
    """Find the weapon codename whose bundles hold a doll's Spine data.

    Args:
        doll_id: The doll's id in the archive's own numbering.
        codes: Doll id to codename, as from `parse_guns`.
        mod: Whether to resolve the Mod rig rather than the base one.

    Returns:
        The codename, or an empty string when the doll is not in `gun.hjson` at all.
    """
    base = CODE_OVERRIDES.get(doll_id) or codes.get(doll_id, "")
    if not mod:
        return base
    # Without the guard an unknown doll would resolve to the bare string "Mod".
    return codes.get(MOD_ID_OFFSET + doll_id) or (f"{base}Mod" if base else "")


def index_bundles(resdata_zip, region):
    """Index every asset bundle in the ResData manifest by lowercased bundle name.

    Args:
        resdata_zip: Path to `resdata.zip`.
        region: Region code such as `us`.

    Returns:
        A `(bundles, res_url)` pair.
    """
    with zipfile.ZipFile(resdata_zip) as archive:
        resdata = json.loads(archive.read(f"{region}_resdata.json"))
    bundles = {}
    for key in BUNDLE_KEYS:
        for bundle in resdata.get(key, []):
            bundles[bundle["assetBundleName"].lower()] = bundle
    return bundles, resdata["resUrl"]


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Fetch and unpack


def unpack(ab_path, target_dir):
    """Extract the Spine files from one downloaded asset bundle.

    TextAssets hold the `.skel` and `.atlas` payloads. UnityPy hands their contents back as a string,
    so the bytes are recovered with a surrogateescape round trip rather than a plain encode, which
    would corrupt the binary skeleton.

    Args:
        ab_path: Path to the downloaded `.ab` file.
        target_dir: Directory to write the extracted files into.

    Returns:
        A sorted list of filenames written.
    """
    import UnityPy

    os.makedirs(target_dir, exist_ok=True)
    written = []
    for obj in UnityPy.load(ab_path).objects:
        if obj.type.name == "TextAsset":
            data = obj.read()
            raw = data.m_Script
            raw = raw.encode("utf-8", "surrogateescape") if isinstance(raw, str) else bytes(raw)
            with open(os.path.join(target_dir, data.m_Name), "wb") as handle:
                handle.write(raw)
            written.append(data.m_Name)
        elif obj.type.name == "Texture2D":
            data = obj.read()
            name = f"{data.m_Name}.png"
            data.image.save(os.path.join(target_dir, name))
            written.append(name)
    return sorted(written)


def fetch_skins(args, codes, bundles, res_url):
    """Download and unpack the Spine rigs for individual skins.

    Skins ship as `character_<code>_<skin id>_spine`. The files land in the doll's own directory
    alongside the base rig, where the index picks them up by their `<code>_<skin id>` filenames.

    Args:
        args: Parsed command-line arguments.
        codes: Doll id to weapon codename.
        bundles: Asset bundles keyed by lowercased name.
        res_url: CDN base URL.
    """
    with open(args.skin_pairs, encoding="utf-8") as handle:
        pairs = json.load(handle)
    os.makedirs(args.cache, exist_ok=True)

    resolved, unresolved, failed = 0, [], []
    for doll_id, skin_id in pairs:
        code = resolve_code(doll_id, codes)
        name = f"character_{code.lower()}_{skin_id}_spine"
        bundle = bundles.get(name)
        if not bundle:
            unresolved.append((doll_id, skin_id))
            continue

        ab_path = os.path.join(args.cache, f"{name}.ab")
        if not os.path.exists(ab_path):
            try:
                urllib.request.urlretrieve(f"{res_url}{bundle['resname']}.ab", ab_path)
            except Exception as error:
                failed.append((doll_id, skin_id, f"download: {error}"))
                continue
        try:
            unpack(ab_path, os.path.join(args.out, "spine", str(doll_id)))
        except Exception as error:
            failed.append((doll_id, skin_id, f"unpack: {error}"))
            continue
        resolved += 1
        if resolved % 100 == 0:
            print(f"  {resolved}/{len(pairs)}")

    print(f"\nskin rigs resolved : {resolved}")
    print(f"unresolved         : {len(unresolved)}")
    print(f"failed             : {len(failed)}")
    for entry in failed[:5]:
        print(f"   {entry}")


def main():
    """Resolve, download and unpack the Spine bundles for the requested dolls."""
    parser = argparse.ArgumentParser(description="Download and unpack Spine chibi bundles from the CDN.")
    parser.add_argument("--guns", required=True, help="Path to gun.hjson from gf-data-us.")
    parser.add_argument("--resdata", required=True, help="Path to resdata.zip.")
    parser.add_argument("--region", default="us", help="Region whose manifest to read.")
    parser.add_argument("--ids", help="JSON file holding a list of doll ids under a 'missing' key, or a comma-separated list.")
    parser.add_argument("--skin-pairs", help="JSON file of [doll_id, skin_id] pairs, for fetching skin rigs.")
    parser.add_argument("--mod", action="store_true", help="Fetch the Mod rigs for the given ids rather than the base ones.")
    parser.add_argument("--out", required=True, help="Staging directory to write spine/<id>/ into.")
    parser.add_argument("--cache", required=True, help="Directory to keep downloaded .ab files in.")
    args = parser.parse_args()

    if args.skin_pairs:
        return fetch_skins(args, parse_guns(args.guns), *index_bundles(args.resdata, args.region))

    if not args.ids:
        sys.exit("pass --ids or --skin-pairs")

    if os.path.isfile(args.ids):
        with open(args.ids, encoding="utf-8") as handle:
            payload = json.load(handle)
        doll_ids = payload["missing"] if isinstance(payload, dict) else payload
    else:
        doll_ids = [int(v) for v in args.ids.split(",")]

    codes = parse_guns(args.guns)
    bundles, res_url = index_bundles(args.resdata, args.region)
    os.makedirs(args.cache, exist_ok=True)

    resolved, unresolved, failed = {}, [], []
    for doll_id in sorted(doll_ids):
        code = resolve_code(doll_id, codes, args.mod)
        name, bundle = None, None
        for template in BUNDLE_TEMPLATES:
            candidate = template.format(code=code.lower())
            if candidate in bundles:
                name, bundle = candidate, bundles[candidate]
                break
        if not bundle:
            unresolved.append((doll_id, code))
            continue

        ab_path = os.path.join(args.cache, f"{name}.ab")
        if not os.path.exists(ab_path):
            try:
                urllib.request.urlretrieve(f"{res_url}{bundle['resname']}.ab", ab_path)
            except Exception as error:
                failed.append((doll_id, name, f"download: {error}"))
                continue
        try:
            written = unpack(ab_path, os.path.join(args.out, "spine", str(doll_id)))
        except Exception as error:
            failed.append((doll_id, name, f"unpack: {error}"))
            continue
        resolved[str(doll_id)] = {"code": code, "bundle": name, "files": written}
        print(f"  {doll_id:<6} {name:<44} {len(written)} files")

    print(f"\nresolved   : {len(resolved)}")
    print(f"unresolved : {len(unresolved)}  {unresolved[:8]}")
    print(f"failed     : {len(failed)}")
    for entry in failed[:8]:
        print(f"  {entry}")

    index_path = os.path.join(args.out, "spine", "cdn-index.json")
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    with open(index_path, "w", encoding="utf-8") as handle:
        json.dump({"dolls": resolved, "unresolved": unresolved, "failed": failed}, handle, indent=1, sort_keys=True)


if __name__ == "__main__":
    main()
