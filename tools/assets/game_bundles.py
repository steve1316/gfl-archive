#!/usr/bin/env python3
"""Resolve and download the game's Unity asset bundles behind every asset the archive shows.

The wanted set comes from the site data: every doll (base art, Mod art when the doll has a Mod, each skin with a numeric id), its Spine rigs,
its skill icons and every equipment icon. Each wanted asset is matched to a bundle by name and then confirmed against the file list the ResData
manifest records for that bundle, so nothing is downloaded on a guess.

Naming rules, from the Phase 4B research:

- Art is `character_<code>`, Mod art `character_<code>mod`, skin art `character_<code>_<skinId>`.
- About 350 bundles only exist as `_nom` and `_he` twins. `_nom` is the fallback, `_he` (the censored build) is never used. A plain bundle can
  also exist next to a `_nom` twin and hold only an expression sheet, which is why every file is confirmed rather than every bundle name.
- Spine rigs are `<art bundle>_spine`, falling back to the art bundle itself when it holds the `.skel` files.
- Skill icons live in `sprites_ui`, equipment icons in `resource_icon_equip`.

Subcommands:

- `inventory` writes `tools/assets/.cache/inventory.json` and prints the summary. Nothing is downloaded.
- `download` fetches every resolved bundle into `tools/assets/.cache/bundles/<name>.ab`, skipping bundles already cached under the same content
  hash name (`resname`) at the right size.
- `verify` checks that every resolved bundle is cached at the size ResData records, under the `resname` ResData records.

`bundles/cache-index.json` records the `resname` each cached bundle was downloaded under, since the file name alone cannot tell an updated
bundle of the same size from the old one. A cached bundle with no record is adopted without a download when its SHA-1 matches ResData's
`fileHash`.

Collaboration dolls have no `gun` row, so their skill slots have no codename. Those slots are marked `source: legacy`: the extractor carries
their icons over from the old asset repo snapshot instead of counting them as gaps.
"""

import argparse
import collections
import concurrent.futures
import glob
import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
import urllib.request

from download_spine import BUNDLE_KEYS, CODE_OVERRIDES, MOD_ID_OFFSET, resolve_code
from skin_live2d_table import SKIN_LIVE2D_PREFIX, SKIN_LIVE2D_VARIANTS, skin_live2d_models


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Constants

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(TOOLS_DIR))
SITE_DATA_DIR = os.path.join(REPO_ROOT, "src", "data")
CACHE_DIR = os.path.join(TOOLS_DIR, ".cache")
BUNDLE_CACHE_DIR = os.path.join(CACHE_DIR, "bundles")
INVENTORY_PATH = os.path.join(CACHE_DIR, "inventory.json")

# The committed manifest an `--only-missing` run compares against.
MANIFEST_PATH = os.path.join(REPO_ROOT, "assets-manifest.json")

# Sidecar file in the bundle cache recording the `resname`, size and SHA-1 each bundle was cached under.
CACHE_INDEX_NAME = "cache-index.json"

USER_AGENT = "gfl-archive-asset-rebuild/1.0 (fan site asset pipeline; https://github.com/steve1316/gfl-archive)"
MAX_WORKERS = 4
ATTEMPTS = 3
BACKOFF_SECONDS = 2.0
TIMEOUT_SECONDS = 60
CHUNK_BYTES = 1 << 20
BYTES_PER_MB = 1048576

# Suffix tried after the plain bundle name. The `_he` twin is deliberately absent.
NOM_SUFFIX = "_nom"
SKILL_BUNDLE = "sprites_ui"
EQUIP_BUNDLE = "resource_icon_equip"

# UI bundles the extractor needs as a whole, e.g. the equipment rarity backgrounds. Downloaded whenever ResData lists them.
UI_BUNDLES = ("atlasclips_listequipment",)

# Tiers in report order.
TIERS = (
    "art",
    "mod_art",
    "skin_art",
    "spine",
    "mod_spine",
    "skin_spine",
    "skill_icon",
    "equip_icon",
    "hoc_art",
    "hoc_spine",
    "fairy_art",
    "enemy_art",
    "enemy_spine",
    "faction_icon",
    "live2d",
    "story_sprite",
    "story_background",
    "story_ui",
)

# Each role is `(name, filename alternatives, required)`. `{stem}` is the codename, with `_<skinId>` for skins.
ART_ROLES = (
    ("full", ("pic_{stem}.png",), True),
    ("full_d", ("pic_{stem}_D.png",), True),
    ("card", ("pic_{stem}_N.jpg",), True),
)
MOD_CARD_ROLE = ("mod_card", ("pic_{stem}_N_mod.jpg",), False)
SPINE_ROLES = (
    ("skel", ("{stem}.skel.bytes", "{stem}.skel"), True),
    ("atlas", ("{stem}.atlas.txt", "{stem}.atlas"), True),
    ("texture", ("{stem}.png",), True),
    ("dorm_skel", ("R{stem}.skel.bytes", "R{stem}.skel"), False),
    ("dorm_atlas", ("R{stem}.atlas.txt", "R{stem}.atlas"), False),
    ("dorm_texture", ("R{stem}.png",), False),
)
SKILL_ROLES = (("icon", ("SkillIcon/{stem}.png",), True),)

# Story sprites sit in `avgpicprefabs_*` bundles. Unlike the character bundles, the manifest lists only the prefab that lays a sprite
# out, not the textures inside it, so the prefab is what is matched here. The art itself is a `pic_<stem>` texture the extractor reads
# out of the bundle, along with a `_D` damaged pose where the character has one.
STORY_SPRITE_ROLES = (("prefab", ("{stem}.prefab",), True),)

# A story background is either a flat texture under `AVGTexture/` or, for one of them, a battle background folder holding its own layers.
STORY_BACKGROUND_ROLES = (
    ("full", ("AVGTexture/{stem}.png", "{stem}/background.png"), True),
    ("alpha", ("AVGTexture/{stem}_Alpha.png", "{stem}/background_Alpha.png"), False),
)

# The dialogue chrome: one sprite atlas holding the frame, the speaker plate and the player's own buttons.
STORY_UI_BUNDLE = "atlasclips_avg"

# Story sprites that live outside their own prefab bundle, keyed by prefab. See the file's own note for why they cannot be derived.
STORY_SOURCES_PATH = os.path.join(TOOLS_DIR, "story-sprite-sources.json")

# A sprite resolved through `STORY_SOURCES_PATH` is matched by the texture's own filename rather than by the prefab's.
STORY_SOURCE_ROLES = (("texture", ("{stem}.png", "{stem}.jpg"), True),)
EQUIP_ROLES = (("icon", ("Equip/{stem}.png",), True), ("alpha", ("Equip/{stem}_Alpha.png",), False))

# Enemy portraits sit in the unit's own bundle under a different naming scheme from the dolls': `_SS` is the small card, which every enemy
# has, and `_LL` the large art, which only about three in five do. A handful also ship a separate alpha mask for the card.
ENEMY_ART_ROLES = (
    ("card", ("pic_{stem}_SS.png",), True),
    ("full", ("pic_{stem}_LL.png",), False),
    ("card_alpha", ("pic_{stem}_SS_Alpha.png",), False),
)

# An enemy has one combat rig and no dorm rig, so only the first three Spine roles apply.
ENEMY_SPINE_ROLES = SPINE_ROLES[:3]


# The faction emblems all live in one bundle, one folder per faction. Each is layered into a front, a back and sometimes a background;
# the front carries the mark a reader recognises, so it is the only one taken. The folder names are the game's own, including the
# lowercase `sangvis` among the capitalised rest and its `_bu` suffixes.
FACTION_ICON_BUNDLE = "sprites_guncamps"
FACTION_ICON_PATHS = {
    "Sangvis Ferri": "sangvis/{front}.png",
    "KCCO": "KCCO/{front}.png",
    "Paradeus": "Paradeus/{front}.png",
}

# The file inside each faction's folder that holds its mark, since the game does not name them consistently.
FACTION_ICON_FRONTS = {"Sangvis Ferri": "\u524d\u90e8", "KCCO": "\u901a\u7528\u6b63\u89c4\u519b_logo", "Paradeus": "\u524d"}

# HOC pictures all live in one bundle. The card path keeps its folder, since L9A1 also has a root-level `L9A1_Vertical.png`.
HOC_ART_BUNDLE = "resource_squads"
HOC_ART_ROLES = (
    # RPG29 has no vertical card in the game, so the card is optional and the extractor derives one from the full art.
    ("card", ("Squads_Vertical/{stem}_Vertical.png",), False),
    ("bgl", ("{stem}_BGL.jpg",), True),
    ("bgr", ("{stem}_BGR.jpg",), True),
    ("left", ("{stem}_Left.png",), True),
    ("left_alpha", ("{stem}_Left_Alpha.png",), True),
    ("right", ("{stem}_Right.png",), True),
    ("right_alpha", ("{stem}_Right_Alpha.png",), True),
)

# Fairy pictures all live in one bundle, three forms each with a plain and an alpha-masked copy. The `Pics/Fairy/` prefix keeps the templates
# from matching the same-named files under `Pics/Fairy/Battle/`.
FAIRY_ART_BUNDLE = "resource_fairy"
FAIRY_ART_ROLES = (
    ("form1", ("Pics/Fairy/{stem}_1.png",), True),
    ("form1_alpha", ("Pics/Fairy/{stem}_1_Alpha.png",), True),
    ("form2", ("Pics/Fairy/{stem}_2.png",), True),
    ("form2_alpha", ("Pics/Fairy/{stem}_2_Alpha.png",), True),
    ("form3", ("Pics/Fairy/{stem}_3.png",), True),
    ("form3_alpha", ("Pics/Fairy/{stem}_3_Alpha.png",), True),
)

# Live2D bundle names, one bundle per fairy or HOC, keyed by kind. A fairy's live2d code is its normal `fairies.json` code, but a HOC's is
# its weapon name, e.g. `BGM-71` - a HOC's `hocs.json` code (e.g. `TOW`) is an unrelated internal id used for its Spine rig instead.
LIVE2D_BUNDLE_PREFIXES = {"fairy": "live2dnew_fairy_", "hoc": "live2dnew_squads_"}

# Live2D file names never depend on the fairy or HOC's code, unlike the templated roles above, so no `{stem}` placeholder is needed. The
# texture folder name varies per form and, for the `golden` fairy, so does the model file name (a `modle` typo) - both are matched by file
# name suffix only, ignoring the folder, so the folder inconsistency never matters.
FAIRY_LIVE2D_ROLES = (
    ("form1_moc", ("model1_moc.asset", "modle1_moc.asset"), True),
    ("form1_prefab", ("model1.prefab", "modle1.prefab"), True),
    ("form2_moc", ("model2_moc.asset", "modle2_moc.asset"), True),
    ("form2_prefab", ("model2.prefab", "modle2.prefab"), True),
    ("form3_moc", ("model3_moc.asset", "modle3_moc.asset"), True),
    ("form3_prefab", ("model3.prefab", "modle3.prefab"), True),
    # Each form has its own texture file, but only one is ever needed, so the first match wins regardless of which form it belongs to.
    ("texture", ("texture_00.png",), True),
)
HOC_LIVE2D_ROLES = (
    ("moc", ("model_moc.asset",), True),
    ("prefab", ("model.prefab",), True),
    ("texture0", ("texture_00.png",), True),
    # A second texture is not universal - BGM-71 and AT4 ship one, AGS-30 does not.
    ("texture1", ("texture_01.png",), False),
)

# Skill codes with no icon anywhere in `sprites_ui`, confirmed by the research pass.
EXPECTED_MISSING_SKILL_CODES = frozenset(code.lower() for code in ("ma", "mg4", "rmb", "xm3", "m2wnl", "TaeSkill"))

# Rigs the game does not ship at all. Anything else missing fails the Spine pass. The three enemies are Tareus, Erma's Dummy and the
# Theresa apocalypse variant, none of which has a skeleton anywhere in ResData.
EXPECTED_MISSING_RIGS = frozenset(
    (
        "skin_spine:95:1809",
        # Tareus, Erma's Dummy and the Theresa apocalypse variant have no skeleton anywhere in ResData.
        "enemy_spine:176001",
        "enemy_spine:232001",
        "enemy_spine:100017001",
        # Ladon and the two Isomer bosses ship a skeleton and an atlas but no atlas page. The only same-named PNG in the game is a 128x128
        # icon in `resource_icon_enemy`, and their atlases call for a 1024x512 page, so there is nothing to render them with.
        "enemy_spine:204001",
        "enemy_spine:224001",
        "enemy_spine:225001",
    )
)

# Art the game does not ship at all. Erma's Dummy is a training target with no portrait bundle of its own.
EXPECTED_MISSING_ART = frozenset(("enemy_art:232001",))

# Skill codes whose icon file carries another name. `c93G` was checked pixel-identical to the hosted C93 skill icon.
SKILL_ICON_ALIASES = {"c93": "c93G"}

# The `sangvis` fields holding a captured unit's skill group ids, in the order its page lists them. Thirteen units point `skill2` at a
# strategic skill, which lives in `chess_skill` rather than `battle_skill_config` and so resolves to no code and no icon. The other
# seventeen are ordinary skills with icons like the rest, which is why the slot is listed rather than skipped.
ASSIMILATION_SKILL_SLOTS = ("skill1", "skill2", "skill3", "skill_advance")

LOG_LOCK = threading.Lock()


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Loading


def read_json(path):
    """Read one JSON file.

    Args:
        path: File path.

    Returns:
        The parsed value.
    """
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def load_index(resdata):
    """Index the ResData bundles by lowercased name, keeping their file lists.

    Args:
        resdata: The parsed `resdata_no_hash.json`.

    Returns:
        A `(index, res_url)` pair. Each index entry holds `resname`, `sizeOriginal`, `files`, a list of `(lowercased path, path)` pairs,
        and `sha1` when ResData records a `fileHash`.
    """
    index = {}
    for key in BUNDLE_KEYS:
        for bundle in resdata.get(key, []):
            files = [(res["pathKey"].lower(), res["pathKey"]) for res in bundle.get("assetAllRes", [])]
            entry = {"resname": bundle["resname"], "sizeOriginal": bundle["sizeOriginal"], "files": files}
            sha1 = normalise_file_hash(bundle.get("fileHash"))
            if sha1:
                entry["sha1"] = sha1
            index[bundle["assetBundleName"].lower()] = entry
    return index, resdata["resUrl"]


def normalise_file_hash(file_hash):
    """Turn a ResData `fileHash` into a plain lowercase SHA-1 hex digest.

    Args:
        file_hash: The recorded hash, such as `DA-D3-32-...`, or None.

    Returns:
        The 40-character hex digest, or None when the value is missing or not a SHA-1.
    """
    digest = (file_hash or "").replace("-", "").lower()
    return digest if re.fullmatch(r"[0-9a-f]{40}", digest) else None


def load_records(path, key="id"):
    """Read a `{"items": [...]}` site file into `{"id", "code", "name"}` records sorted by id.

    `name` is carried through for the Live2D tier: a HOC's Live2D bundle is named after its displayed weapon name, not its internal `code`.

    Args:
        path: Path to the site file, such as `hocs.json` or `fairies.json`.
        key: Field name each record is sorted by.

    Returns:
        A list of `{"id": int, "code": str, "name": str}` dicts, empty when the file is absent.
    """
    if not os.path.isfile(path):
        return []
    return sorted(({"id": item["id"], "code": item["code"], "name": item["name"]} for item in read_json(path)["items"]), key=lambda record: record[key])


def load_site(site_dir):
    """Read the dolls, equipment ids, HOCs and fairies the site shows.

    Args:
        site_dir: Directory holding `dolls-*.json`, `equipment.json` and, when hosted, `hocs.json` and `fairies.json`.

    Returns:
        A `(dolls, equipment_ids, hocs, fairies, enemies, units)` tuple. Dolls are sorted by id, ids are sorted and deduplicated, `hocs`,
        `fairies` and `enemies` are lists of `{"id": int, "code": str, "name": str}` sorted by id, empty when their site file is absent,
        and `units` is the sorted ids of the Protocol Assimilation units the site ships.
    """
    dolls = []
    for path in sorted(glob.glob(os.path.join(site_dir, "dolls-*.json"))):
        dolls.extend(read_json(path))
    dolls.sort(key=lambda doll: doll["normal"]["id"])
    items = read_json(os.path.join(site_dir, "equipment.json"))["items"]
    equipment_ids = sorted({item["id"] for group in items.values() for item in group})
    hocs = load_records(os.path.join(site_dir, "hocs.json"))
    fairies = load_records(os.path.join(site_dir, "fairies.json"))
    enemies = load_records(os.path.join(site_dir, "enemies.json"))
    return dolls, equipment_ids, hocs, fairies, enemies, assimilation_units(site_dir)


def assimilation_units(site_dir):
    """Read the ids of the Protocol Assimilation units the site shows.

    These are the enemies a player can capture and field, and they carry skills with icons of their own. Their ids are `sangvis.id`,
    which is what the skill icons are published under, rather than any enemy id: one captured unit stands for a whole enemy family,
    so keying on an enemy's own id would copy the same icon under every variant of it.

    Args:
        site_dir: Directory holding `assimilation.json`.

    Returns:
        The unit ids, sorted. Empty when the file is absent.
    """
    path = os.path.join(site_dir, "assimilation.json")
    if not os.path.isfile(path):
        return []
    return sorted(unit["id"] for unit in read_json(path)["units"])


def load_tables(gf_data_dir):
    """Read the `stc` tables that turn ids into codenames.

    Args:
        gf_data_dir: The `gf-data-us` checkout.

    Returns:
        A `(guns, skill_codes, equip_codes, sangvis)` tuple: gun rows by id, skill codename by skill group id (lowest level wins),
        equipment codename by id, and the `sangvis` rows by id, whose skill fields are skill group ids like a gun's.
    """
    stc = os.path.join(gf_data_dir, "stc")
    guns = {row["id"]: row for row in read_json(os.path.join(stc, "gun.json"))}
    skill_rows = sorted(read_json(os.path.join(stc, "battle_skill_config.json")), key=lambda row: (row["skill_group_id"], row.get("level", 0), row["id"]))
    skill_codes = {}
    for row in skill_rows:
        skill_codes.setdefault(row["skill_group_id"], row["code"])
    equip_codes = {row["id"]: row["code"] for row in read_json(os.path.join(stc, "equip.json"))}
    # Older checkouts predate Protocol Assimilation, and the test fixtures carry only the tables they exercise.
    sangvis_path = os.path.join(stc, "sangvis.json")
    sangvis = {row["id"]: row for row in read_json(sangvis_path)} if os.path.isfile(sangvis_path) else {}
    return guns, skill_codes, equip_codes, sangvis


def load_live2d_table(gf_data_dir):
    """Read the `stc/live2d.json` table naming every playable Live2D combination.

    Args:
        gf_data_dir: The `gf-data-us` checkout.

    Returns:
        The table's rows, or an empty list when the file is absent, since an older data checkout may not carry it.
    """
    path = os.path.join(gf_data_dir, "stc", "live2d.json")
    return read_json(path) if os.path.isfile(path) else []


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Resolution


def bundle_candidates(names):
    """Expand bundle names with their `_nom` fallback, preserving order.

    Args:
        names: Bundle names in preference order.

    Returns:
        A list with each name followed by its `_nom` twin.
    """
    return [candidate for name in names for candidate in (name.lower(), name.lower() + NOM_SUFFIX)]


def find_file(index, bundle_names, filenames):
    """Find the first bundle holding one of the wanted files.

    Filenames match the end of a path at a folder boundary, case-insensitively, so `SkillIcon/x.png` only matches inside that folder.

    Args:
        index: The bundle index from `load_index`.
        bundle_names: Candidate bundle names in preference order, already expanded with `_nom`.
        filenames: Filename alternatives in preference order.

    Returns:
        A `{"bundle", "path"}` dict, or None when no candidate holds any alternative.
    """
    suffixes = ["/" + filename.lower() for filename in filenames]
    for name in bundle_names:
        bundle = index.get(name)
        if not bundle:
            continue
        for suffix in suffixes:
            for lowered, path in bundle["files"]:
                if lowered.endswith(suffix):
                    return {"bundle": name, "path": path}
    return None


def find_prefix(bundle, folder):
    """Find the real-case path down to a named folder, matched as a path segment rather than a filename.

    Used for a folder whose files are too numerous or too arbitrarily named to list role by role, such as `motions/`. The caller gets the
    folder's own path back, to filter or list the bundle's files against later, rather than one specific file.

    Args:
        bundle: One index bundle entry.
        folder: Folder name to match, such as `motions`.

    Returns:
        The path up to and including `<folder>/`, in its original case, or None when no file sits under that folder.
    """
    marker = f"/{folder.lower()}/"
    for lowered, path in bundle["files"]:
        hit = lowered.find(marker)
        if hit != -1:
            return path[: hit + len(marker)]
    return None


def resolve_item(index, tier, key, stem, bundle_names, roles, **extra):
    """Resolve one wanted item role by role.

    Args:
        index: The bundle index from `load_index`.
        tier: One of `TIERS`.
        key: Stable item key such as `skin_art:65:30033`.
        stem: Codename used to fill the role filename templates.
        bundle_names: Bundle names in preference order, before `_nom` expansion.
        roles: Role tuples such as `ART_ROLES`.
        **extra: Descriptive fields copied onto the item, e.g. `doll_id`.

    Returns:
        The item dict with `status` of `resolved`, `partial` or `unresolved`.
    """
    candidates = bundle_candidates(bundle_names)
    assets, missing, found_required = {}, [], 0
    for role, templates, required in roles:
        hit = find_file(index, candidates, [template.format(stem=stem) for template in templates])
        if hit:
            assets[role] = hit
            found_required += required
        elif required:
            missing.append(role)
    bundles = sorted({hit["bundle"] for hit in assets.values()})
    if not missing:
        status = "resolved"
    elif found_required:
        status = "partial"
    else:
        status = "unresolved"
    return {
        "key": key,
        "tier": tier,
        **extra,
        "status": status,
        "bundles": bundles,
        "assets": assets,
        "missing": missing,
        "sizeOriginal": sum(index[name]["sizeOriginal"] for name in bundles),
    }


def rig_stem(index, bundle_names, stem):
    """Find the stem a rig's files actually use.

    A few `_spine` bundles name their files differently from the codename, e.g. `Gsh-18_523.skel` in `character_gsh18_523_spine`. When no
    candidate holds `<stem>.skel`, the stem is taken from the one combat skeleton in the first existing bundle, the skeleton with no `R` prefix.

    Args:
        index: The bundle index from `load_index`.
        bundle_names: Candidate bundle names in preference order, already expanded with `_nom`.
        stem: The codename-based stem.

    Returns:
        The stem to resolve the Spine roles with.
    """
    if find_file(index, bundle_names, [template.format(stem=stem) for template in SPINE_ROLES[0][1]]):
        return stem
    for name in bundle_names:
        bundle = index.get(name)
        if not bundle:
            continue
        skels = {path.rsplit("/", 1)[-1].split(".skel")[0] for lowered, path in bundle["files"] if lowered.endswith((".skel", ".skel.bytes"))}
        combat = [skel for skel in skels if not (skel[:1] in "Rr" and skel[1:] in skels)]
        return combat[0] if len(combat) == 1 else stem
    return stem


def spine_item(index, tier, key, stem, art_bundle, **extra):
    """Resolve a rig from `<art bundle>_spine`, falling back to the art bundle.

    Args:
        index: The bundle index from `load_index`.
        tier: One of the Spine tiers.
        key: Stable item key.
        stem: The codename-based stem.
        art_bundle: The art bundle name the rig bundle is named after.
        **extra: Descriptive fields copied onto the item.

    Returns:
        The item dict, with `code` set to the stem the rig files use.
    """
    names = [f"{art_bundle}_spine", art_bundle]
    actual = rig_stem(index, bundle_candidates(names), stem)
    return resolve_item(index, tier, key, actual, names, SPINE_ROLES, **{**extra, "code": actual})


def unresolved_item(tier, key, reason, **extra):
    """Build an item that could not even be named, e.g. a doll with no codename.

    Args:
        tier: One of `TIERS`.
        key: Stable item key.
        reason: Why no bundle name could be built.
        **extra: Descriptive fields copied onto the item.

    Returns:
        An unresolved item dict.
    """
    return {"key": key, "tier": tier, **extra, "status": "unresolved", "reason": reason, "bundles": [], "assets": {}, "missing": [], "sizeOriginal": 0}


def doll_items(index, doll, codes):
    """Resolve the art and Spine items for one doll, its Mod and its skins.

    Args:
        index: The bundle index from `load_index`.
        doll: One site doll record with `normal`, `mod` and `skins`.
        codes: Weapon codename by gun id, as `download_spine.resolve_code` expects.

    Returns:
        A list of item dicts.
    """
    doll_id = doll["normal"]["id"]
    code = resolve_code(doll_id, codes)
    if not code:
        reason = "no gun code"
        return [unresolved_item("art", f"art:{doll_id}", reason, doll_id=doll_id), unresolved_item("spine", f"spine:{doll_id}", reason, doll_id=doll_id)]

    has_mod = doll.get("mod") is not None
    art = f"character_{code}"
    items = [
        resolve_item(index, "art", f"art:{doll_id}", code, [art], ART_ROLES, doll_id=doll_id, code=code),
        spine_item(index, "spine", f"spine:{doll_id}", code, art, doll_id=doll_id),
    ]
    if has_mod:
        mod_code = resolve_code(doll_id, codes, mod=True)
        mod_art = f"character_{mod_code}"
        items.append(resolve_item(index, "mod_art", f"mod_art:{doll_id}", mod_code, [mod_art], ART_ROLES, doll_id=doll_id, code=mod_code))
        items.append(spine_item(index, "mod_spine", f"mod_spine:{doll_id}", mod_code, mod_art, doll_id=doll_id))

    skin_roles = ART_ROLES + ((MOD_CARD_ROLE,) if has_mod else ())
    for skin_id in (doll.get("skins") or {}).get("skin_ids") or []:
        # Null ids are hand-written skins and string keys are `legacy-<slug>` art from the old repos. Neither has a game bundle.
        if not isinstance(skin_id, int):
            continue
        stem = f"{code}_{skin_id}"
        skin_art = f"character_{stem}"
        fields = {"doll_id": doll_id, "skin_id": skin_id, "code": stem}
        items.append(resolve_item(index, "skin_art", f"skin_art:{doll_id}:{skin_id}", stem, [skin_art], skin_roles, **fields))
        items.append(spine_item(index, "skin_spine", f"skin_spine:{doll_id}:{skin_id}", stem, skin_art, doll_id=doll_id, skin_id=skin_id))
    return items


def legacy_skill_item(doll_id, slot):
    """Build the skill icon item of a collaboration doll slot, whose icon only the old asset repo hosts.

    Args:
        doll_id: The collaboration doll's id.
        slot: `skill1` or `skill2`.

    Returns:
        An item with `status` and `source` of `legacy` and no bundles.
    """
    item = unresolved_item("skill_icon", f"skill_icon:doll:{doll_id}:{slot}", "collaboration doll with no gun row, icon carried from the old asset repo", users=[[doll_id, slot]])
    item.update(status="legacy", source="legacy")
    return item


def skill_items(index, dolls, guns, skill_codes, units=(), sangvis=None):
    """Resolve one skill icon item per distinct skill codename.

    Skill 1 comes from the doll's `gun.skill1`, and a Mod's skill 2 from `gun(20000 + id).skill2`. A captured Protocol Assimilation unit
    keeps its skill group ids on its own `sangvis` row and draws from the same icon set. Icons are shared by codename, so each item lists
    both the doll slots and the unit slots that use it. A collaboration doll has no `gun` row, so its slots become legacy items read from
    the old asset repo.

    A unit's `skill2` is its strategic skill, which lives in `chess_skill` rather than `battle_skill_config` and has no icon at all. It
    resolves to no code and is skipped in silence, the way a doll slot with no code would not be.

    Args:
        index: The bundle index from `load_index`.
        dolls: Site doll records.
        guns: Gun rows by id.
        skill_codes: Skill codename by skill group id.
        units: Ids of the Protocol Assimilation units the site ships.
        sangvis: `sangvis` rows by id, holding each unit's skill group ids. Required when `units` is not empty.

    Returns:
        A list of item dicts.
    """
    users = collections.OrderedDict()
    unit_users = collections.OrderedDict()
    items = []
    for doll in dolls:
        doll_id = doll["normal"]["id"]
        slots = [("skill1", doll_id, "skill1")]
        if doll.get("mod") is not None:
            slots.append(("skill2", MOD_ID_OFFSET + doll_id, "skill2"))
        for slot, gun_id, field in slots:
            code = skill_codes.get((guns.get(gun_id) or {}).get(field))
            if not code and doll_id in CODE_OVERRIDES and gun_id not in guns:
                items.append(legacy_skill_item(doll_id, slot))
                continue
            if not code:
                items.append(unresolved_item("skill_icon", f"skill_icon:doll:{doll_id}:{slot}", "no skill code", users=[[doll_id, slot]]))
                continue
            users.setdefault(code, []).append([doll_id, slot])
    for unit_id in units:
        row = (sangvis or {}).get(unit_id) or {}
        for slot in ASSIMILATION_SKILL_SLOTS:
            code = skill_codes.get(row.get(slot))
            if code:
                unit_users.setdefault(code, []).append([unit_id, slot])
    for code in list(users) + [code for code in unit_users if code not in users]:
        icon = SKILL_ICON_ALIASES.get(code, code)
        fields = {"code": code, "users": users.get(code, [])}
        if code in unit_users:
            fields["unit_users"] = unit_users[code]
        items.append(resolve_item(index, "skill_icon", f"skill_icon:{code}", icon, [SKILL_BUNDLE], SKILL_ROLES, **fields))
    return items


def equip_items(index, equipment_ids, equip_codes):
    """Resolve one icon item per equipment id the site shows.

    Args:
        index: The bundle index from `load_index`.
        equipment_ids: Equipment ids from the site data.
        equip_codes: Equipment codename by id.

    Returns:
        A list of item dicts.
    """
    items = []
    for equip_id in equipment_ids:
        code = equip_codes.get(equip_id)
        key = f"equip_icon:{equip_id}"
        if not code:
            items.append(unresolved_item("equip_icon", key, "no equip code", equip_id=equip_id))
            continue
        items.append(resolve_item(index, "equip_icon", key, code, [EQUIP_BUNDLE], EQUIP_ROLES, equip_id=equip_id, code=code))
    return items


def hoc_items(index, hoc):
    """Resolve the art and Spine items for one HOC.

    The rig bundle holds one combat skeleton named after the code and a few crew skeletons with irregular names, such as `RTOWA`, `QLZ04 A`
    or `R_PP93_M1`. A crew skeleton either ships its own atlas and page or uses the combat atlas, so its atlas roles are optional.

    Args:
        index: The bundle index from `load_index`.
        hoc: One `{id, code}` record from `hocs.json`.

    Returns:
        A `[hoc_art item, hoc_spine item]` list.
    """
    hoc_id, code = hoc["id"], hoc["code"]
    art = resolve_item(index, "hoc_art", f"hoc_art:{hoc_id}", code, [HOC_ART_BUNDLE], HOC_ART_ROLES, hoc_id=hoc_id, code=code)
    rig_bundle = f"character_{code.lower()}_spine"
    skeletons = []
    for name in bundle_candidates([rig_bundle]):
        bundle = index.get(name)
        if bundle:
            skeletons = sorted({path.rsplit("/", 1)[-1].split(".skel")[0] for lowered, path in bundle["files"] if lowered.endswith((".skel", ".skel.bytes"))}, key=str.lower)
            break
    crew = [stem for stem in skeletons if stem.lower() != code.lower()]
    roles = list(SPINE_ROLES[:3])
    for number, stem in enumerate(crew, start=1):
        # Crew stems are written into the templates, since `resolve_item` fills `{stem}` with the combat code.
        roles.append((f"crew{number}_skel", (f"{stem}.skel.bytes", f"{stem}.skel"), True))
        roles.append((f"crew{number}_atlas", (f"{stem}.atlas.txt", f"{stem}.atlas"), False))
        roles.append((f"crew{number}_texture", (f"{stem}.png",), False))
    rig = resolve_item(index, "hoc_spine", f"hoc_spine:{hoc_id}", code, [rig_bundle], roles, hoc_id=hoc_id, code=code, crew=len(crew))
    return [art, rig]


def avg_bundle_index(index, pattern, extract):
    """Index the AVG bundles by the name each asset is known by in the scripts.

    A story sprite or background is named in the script but not in the bundle name, and the bundles group several characters together,
    so the only way to find one is to walk the manifest once and remember where each asset lives.

    Args:
        index: The bundle index from `load_index`.
        pattern: Prefix a bundle name must start with, lowercased.
        extract: Callable taking a lowercased path and returning the asset's name, or None when the path is not one.

    Returns:
        A dict of lowercased asset name to the bundle holding it.
    """
    found = {}
    for name, bundle in index.items():
        if not name.startswith(pattern):
            continue
        for lowered, _path in bundle["files"]:
            asset = extract(lowered)
            if asset and asset not in found:
                found[asset] = name
    return found


def story_prefab_index(index):
    """Index every story sprite prefab by its name.

    Args:
        index: The bundle index from `load_index`.

    Returns:
        A dict of lowercased prefab name to the bundle holding it.
    """
    return avg_bundle_index(index, "avgpicprefabs", lambda path: path.rsplit("/", 1)[-1][: -len(".prefab")] if path.endswith(".prefab") else None)


def story_background_index(index):
    """Index every story background by the scene code the game's mission table names it with.

    Most are a flat texture named after the code. One is a battle background folder, where the code is the folder rather than the file.

    Args:
        index: The bundle index from `load_index`.

    Returns:
        A dict of lowercased background code to the bundle holding it.
    """
    found = {}
    for name, bundle in index.items():
        if not (name.startswith("resource_avgtexture") or name.startswith("battlebackground")):
            continue
        for lowered, _path in bundle["files"]:
            if not lowered.endswith((".png", ".jpg")):
                continue
            parts = lowered.rsplit("/", 2)
            stem = parts[-1].rsplit(".", 1)[0]
            if "/avgtexture/" in lowered and stem not in found:
                found[stem] = name
            elif len(parts) >= 2 and parts[-1].startswith("background.") and parts[-2] not in found:
                found[parts[-2]] = name
    return found


def story_items(index, sprites, backgrounds):
    """Resolve the art one story needs: every character on stage, every background, and the dialogue chrome.

    Args:
        index: The bundle index from `load_index`.
        sprites: Sprite prefab names the scripts refer to, mapped to the non-zero expression indices each is asked for.
        backgrounds: Background codes the mission table names.

    Returns:
        A list of items across the `story_sprite`, `story_background` and `story_ui` tiers.
    """
    prefabs = story_prefab_index(index)
    scenes = story_background_index(index)
    listed = read_json(STORY_SOURCES_PATH) if os.path.exists(STORY_SOURCES_PATH) else {}
    by_prefab = {name.lower(): entry for name, entry in listed.get("sprites", {}).items()}
    expression_sources = {name.lower(): entry for name, entry in listed.get("expressions", {}).items()}
    items = []
    wanted_expressions = sprites if isinstance(sprites, dict) else {name: [] for name in sprites}
    for prefab in sorted(wanted_expressions, key=str.lower):
        expressions = list(wanted_expressions[prefab])
        source = by_prefab.get(prefab.lower())
        if source:
            # The art sits in a character bundle under the character's own name, so the texture is what is matched, not the prefab.
            items.append(
                resolve_item(
                    index,
                    "story_sprite",
                    f"story_sprite:{prefab}",
                    source["texture"],
                    [source["bundle"]],
                    STORY_SOURCE_ROLES,
                    prefab=prefab,
                    texture=source["texture"],
                    expressions=expressions,
                )
            )
            continue
        bundle = prefabs.get(prefab.lower())
        # Many script sprite slots carry an off-screen speaker's label rather than a character, so they have no art and are skipped.
        if bundle:
            items.append(resolve_item(index, "story_sprite", f"story_sprite:{prefab}", prefab, [bundle], STORY_SPRITE_ROLES, prefab=prefab, expressions=expressions))
    # An expression whose art sits outside the prefab's bundle is its own item, since it can come from a different bundle again.
    for prefab, wanted in sorted(wanted_expressions.items(), key=lambda pair: pair[0].lower()):
        listed_expressions = expression_sources.get(prefab.lower(), {})
        for expression in wanted:
            source = listed_expressions.get(str(expression))
            if not source:
                continue
            items.append(
                resolve_item(
                    index,
                    "story_sprite",
                    f"story_sprite:{prefab}#{expression}",
                    source["texture"],
                    [source["bundle"]],
                    STORY_SOURCE_ROLES,
                    prefab=prefab,
                    texture=source["texture"],
                    expression=expression,
                    expressions=[],
                )
            )
    for code in sorted(backgrounds, key=str.lower):
        bundle = scenes.get(code.lower())
        if bundle:
            items.append(resolve_item(index, "story_background", f"story_background:{code}", code, [bundle], STORY_BACKGROUND_ROLES, background=code))
    if STORY_UI_BUNDLE in index:
        # Built by hand rather than through `resolve_item`: the chrome is a sprite atlas whose pieces are named inside the bundle, not
        # listed as files, so there are no role templates to match. The shape still matches what the rest of the pipeline expects.
        items.append(
            {
                "key": "story_ui",
                "tier": "story_ui",
                "status": "resolved",
                "bundles": [STORY_UI_BUNDLE],
                "assets": {},
                "missing": [],
                "sizeOriginal": index[STORY_UI_BUNDLE]["sizeOriginal"],
            }
        )
    return items


def faction_icon_items(index):
    """Resolve one emblem per faction.

    Args:
        index: The bundle index from `load_index`.

    Returns:
        One item per faction, in `FACTION_ICON_PATHS` order.
    """
    items = []
    for faction, template in FACTION_ICON_PATHS.items():
        path = template.format(front=FACTION_ICON_FRONTS[faction])
        roles = (("icon", (path,), True),)
        items.append(resolve_item(index, "faction_icon", f"faction_icon:{faction}", faction, [FACTION_ICON_BUNDLE], roles, faction=faction))
    return items


def skeleton_index(index):
    """Index every Spine skeleton in ResData by its lowercased name.

    Args:
        index: The bundle index from `load_index`.

    Returns:
        A dict of lowercased skeleton name to a list of `(bundle name, stem as written)` pairs.
    """
    skeletons = {}
    for name, bundle in index.items():
        for lowered, path in bundle["files"]:
            if lowered.endswith((".skel", ".skel.bytes")):
                stem = path.rsplit("/", 1)[-1].split(".skel")[0]
                skeletons.setdefault(stem.lower(), []).append((name, stem))
    return skeletons


def enemy_rig(index, skeletons, code):
    """Find the bundle and stem holding one enemy's Spine rig.

    Enemy rigs are named far less predictably than doll rigs, so the skeleton is looked up by name before any bundle name is guessed.
    An Elite variant lives inside the base unit's bundle (`HunterElite` in `character_bosshunter_spine`), a KCCO variant inside its
    family's (`Cyclops_SG` in `character_cyclops_spine`), and a Paradeus unit inside a shared one (`Strelet` in
    `character_mercenary_spine`). Only when no skeleton carries the code does the bundle name get tried, which is what finds the few
    Ringleaders whose skeleton is named `Boss8` or `Boss9` after nothing at all.

    Args:
        index: The bundle index from `load_index`.
        skeletons: The skeleton index from `skeleton_index`.
        code: The enemy's codename.

    Returns:
        A `(bundle name, stem)` pair, or `(None, None)` when ResData holds no skeleton for the code.
    """
    lowered = code.lower()
    for candidate in (lowered, re.sub(r"^boss", "", lowered)):
        homes = skeletons.get(candidate)
        if not homes:
            continue
        # A name can sit in more than one bundle, so the unit's own bundle wins over a shared one.
        for bundle, stem in homes:
            if lowered in bundle:
                return bundle, stem
        return homes[0]
    for name in (f"character_{lowered}_spine", f"character_boss{lowered}_spine", f"character_{re.sub(r'_[0-9]+$', '', lowered)}_spine"):
        bundle = index.get(name)
        if not bundle:
            continue
        stems = sorted({path.rsplit("/", 1)[-1].split(".skel")[0] for low, path in bundle["files"] if low.endswith((".skel", ".skel.bytes"))}, key=str.lower)
        if stems:
            return name, stems[0]
    return None, None


def enemy_items(index, skeletons, enemy):
    """Resolve the art and Spine items for one enemy.

    Args:
        index: The bundle index from `load_index`.
        skeletons: The skeleton index from `skeleton_index`.
        enemy: One `{id, code}` record from `enemies.json`.

    Returns:
        An `[enemy_art item, enemy_spine item]` list.
    """
    enemy_id, code = enemy["id"], enemy["code"]
    art = resolve_item(index, "enemy_art", f"enemy_art:{enemy_id}", code, [f"character_{code.lower()}"], ENEMY_ART_ROLES, enemy_id=enemy_id, code=code)
    bundle, stem = enemy_rig(index, skeletons, code)
    if bundle is None:
        rig = {
            "key": f"enemy_spine:{enemy_id}",
            "tier": "enemy_spine",
            "enemy_id": enemy_id,
            "code": code,
            "status": "unresolved",
            "bundles": [],
            "assets": {},
            "missing": ["skel"],
            "sizeOriginal": 0,
            "reason": "ResData holds no skeleton for this code",
        }
    else:
        rig = resolve_item(index, "enemy_spine", f"enemy_spine:{enemy_id}", stem, [bundle], ENEMY_SPINE_ROLES, enemy_id=enemy_id, code=code, rig_stem=stem)
        if rig["status"] == "partial":
            # A rig needs its skeleton, its atlas and its atlas page together to draw anything, so a missing one makes the whole rig
            # absent rather than partial. Three enemies ship a skeleton and an atlas with no page anywhere in the game.
            rig = {**rig, "status": "unresolved", "assets": {}, "bundles": [], "sizeOriginal": 0, "reason": f"the game ships no {', '.join(rig['missing'])} for this rig"}
    return [art, rig]


def fairy_items(index, fairy):
    """Resolve the art item for one fairy.

    Args:
        index: The bundle index from `load_index`.
        fairy: One `{id, code}` record from `fairies.json`.

    Returns:
        The `fairy_art` item dict.
    """
    fairy_id, code = fairy["id"], fairy["code"]
    return resolve_item(index, "fairy_art", f"fairy_art:{fairy_id}", code, [FAIRY_ART_BUNDLE], FAIRY_ART_ROLES, fairy_id=fairy_id, code=code)


def live2d_item(index, kind, item_id, stem):
    """Resolve one fairy's or HOC's Live2D model bundle.

    A fairy's bundle holds three forms, each with its own `moc` source and `prefab`, plus one texture and one `motions/` folder shared by
    every form. A HOC's bundle holds a single form the same way. The `motions` role is not resolved file by file, since a fairy or HOC has an
    arbitrary, game-defined number of named animation clips - it instead records the bundle-relative folder itself, for a later extractor to
    list.

    Args:
        index: The bundle index from `load_index`.
        kind: `"fairy"` or `"hoc"`.
        item_id: The fairy or HOC id.
        stem: The lowercased code the bundle name is built from - a fairy's own `code`, or a HOC's displayed weapon `name`.

    Returns:
        The `live2d` item dict with `status` of `resolved` or `partial`, or None when the bundle is not in the index at all - most
        fairies and HOCs never get a Live2D model, and that is not a gap worth recording.
    """
    bundle_name = LIVE2D_BUNDLE_PREFIXES[kind] + stem
    if not any(name in index for name in bundle_candidates([bundle_name])):
        return None
    roles = FAIRY_LIVE2D_ROLES if kind == "fairy" else HOC_LIVE2D_ROLES
    item = resolve_item(index, "live2d", f"live2d:{kind}:{item_id}", stem, [bundle_name], roles, kind=kind, id=item_id, code=stem)
    if item["status"] == "unresolved":
        # The bundle exists but holds none of the required model roles - a genuine gap, unlike the no-bundle-at-all case skipped above,
        # so it still stays unresolved with empty bundles, same as every other tier.
        return item
    motions = None
    for name in bundle_candidates([bundle_name]):
        bundle = index.get(name)
        if bundle:
            prefix = find_prefix(bundle, "motions")
            if prefix:
                motions = {"bundle": name, "path": prefix}
            break
    if motions:
        item["assets"]["motions"] = motions
        item["bundles"] = sorted({hit["bundle"] for hit in item["assets"].values()})
        item["sizeOriginal"] = sum(index[name]["sizeOriginal"] for name in item["bundles"])
    else:
        item["missing"] = item["missing"] + ["motions"]
        item["status"] = "partial"
    return item


def live2d_items(index, fairies, hocs):
    """Resolve the Live2D item for every fairy and HOC that actually ships one.

    Only 9 fairies and 3 HOCs ship a Live2D model today, but which ones is never hardcoded - every fairy and HOC in the site data is
    checked, and the ones with no bundle in the index produce no item at all, so a newly added Live2D model is picked up with no code
    change and the rest never show up as a false gap in the refresh's unresolved check.

    Args:
        index: The bundle index from `load_index`.
        fairies: Fairy records from `load_site`, each `{"id", "code", "name"}`.
        hocs: HOC records from `load_site`, each `{"id", "code", "name"}`.

    Returns:
        A list of `live2d` item dicts, one per fairy or HOC whose bundle is in the index, keyed by the fairy's own `code` or the HOC's
        `name`. A fairy or HOC with no Live2D bundle at all produces no entry.
    """
    candidates = [live2d_item(index, "fairy", fairy["id"], fairy["code"].lower()) for fairy in fairies]
    candidates.extend(live2d_item(index, "hoc", hoc["id"], hoc["name"].lower()) for hoc in hocs)
    return [item for item in candidates if item is not None]


def variant_model_root(scoped):
    """Pick the one model folder a skin Live2D variant's roles must all come from.

    A Cubism model folder holds `model.prefab`, `<name>_moc.asset`, its texture folder (`model.<res>/`) and its `motions/` folder as direct
    siblings. Some bundles carry a stale duplicate of the whole folder at another depth (e.g. a leftover top-level copy next to a newer,
    nested one), so the root is chosen from the folders that hold a `.prefab` file, by this tie-break chain: a folder that also holds a
    `_moc.asset` sibling beats one that does not; among the survivors, the shallowest (shortest) path wins; and if that is still tied, the
    lexically first path wins. The chain ends in a full ordering (path length, then the path itself), so the winner never depends on `set`
    iteration order, which is randomised per process by `PYTHONHASHSEED` and would otherwise let two equal-depth candidates flip at random.

    Args:
        scoped: `(lowered, path)` pairs already filtered to one variant.

    Returns:
        The winning folder's path prefix (in lowered form, trailing slash included), or None when no folder in scope holds a `.prefab`.
    """
    prefab_dirs = sorted({lowered[: lowered.rfind("/") + 1] for lowered, _path in scoped if lowered.endswith(".prefab")}, key=lambda d: (len(d), d))
    if not prefab_dirs:
        return None
    moc_dirs = {lowered[: lowered.rfind("/") + 1] for lowered, _path in scoped if lowered.endswith("_moc.asset")}
    with_moc = [candidate for candidate in prefab_dirs if candidate in moc_dirs]
    return with_moc[0] if with_moc else prefab_dirs[0]


def variant_assets(bundle_name, bundle, variant_folder):
    """Locate one skin Live2D variant's moc, prefab, texture folder and motions folder, all from the same model folder.

    The roles cannot go through `resolve_item`, which matches a role by filename suffix: both variants hold `model_moc.asset` and
    `model.prefab`, so a suffix match would find whichever comes first and silently drop the other. Scoping to the variant's own folder
    prefix is not enough either - a bundle can carry a full duplicate model nested one folder deeper (a stale leftover next to the current
    one), and matching each role independently by first file-order hit can then splice a `moc` from one folder onto a `textures` from the
    other, still reporting the item resolved. `variant_model_root` picks a single model folder first, and every role here is required to
    sit directly in that folder or one of its named subfolders (`model.<res>/`, `motions/`), never in the duplicate.

    Args:
        bundle_name: The bundle's index name.
        bundle: The index entry, whose `files` is a list of `(lowered, real)` path pairs.
        variant_folder: The in-bundle folder name, `normal` or `destroy`.

    Returns:
        A dict of role suffix (`moc`, `prefab`, `textures`, `motions`) to its `{"bundle", "path"}` hit. `motions` carries its folder
        prefix rather than one file. `textures` is present when the model folder holds at least one texture folder (`model.<res>/`),
        and its `path` is the model folder itself: a model folder can ship more than one resolution, and only the prefab, which this
        module never loads, says which one the model uses, so `extract_live2d.py` picks the folder from the loaded bundle. A role with no
        match is absent, including every role when the variant has no folder with a `.prefab` at all.
    """
    marker = f"/{variant_folder}/"
    scoped = [(lowered, path) for lowered, path in bundle["files"] if marker in lowered]
    root = variant_model_root(scoped)
    if root is None:
        return {}

    found = {}
    for lowered, path in scoped:
        if not lowered.startswith(root):
            continue
        rel = lowered[len(root) :]
        if "/" not in rel:
            if rel.endswith(".prefab") and "prefab" not in found:
                found["prefab"] = {"bundle": bundle_name, "path": path}
            elif rel.endswith("_moc.asset") and "moc" not in found:
                found["moc"] = {"bundle": bundle_name, "path": path}
        elif rel.count("/") == 1 and rel.endswith(".png"):
            found.setdefault("textures", {"bundle": bundle_name, "path": path[: len(root)]})
        elif rel.startswith("motions/") and "motions" not in found:
            found["motions"] = {"bundle": bundle_name, "path": path[: len(root) + len("motions/")]}
    return found


def skin_live2d_item(index, model):
    """Resolve one T-Doll skin Live2D model's bundle, both variants.

    Args:
        index: The bundle index from `load_index`.
        model: One record from `skin_live2d_table.skin_live2d_models`.

    Returns:
        The `live2d` item dict with `kind` `"skin"` and `status` of `resolved` or `partial`, or None when the bundle is not in the index.
    """
    bundle_name, bundle = None, None
    for name in bundle_candidates([model["bundle"]]):
        if name in index:
            bundle_name, bundle = name, index[name]
            break
    if bundle is None:
        return None

    assets, missing = {}, []
    for output, folder in SKIN_LIVE2D_VARIANTS:
        found = variant_assets(bundle_name, bundle, folder)
        for role in ("moc", "prefab", "textures", "motions"):
            if role in found:
                assets[f"{output}_{role}"] = found[role]
            else:
                missing.append(f"{output}_{role}")
    key = f"live2d:skin:{model['doll_id']}:{model['form']}:{model['skin_key']}"
    return {
        "key": key,
        "tier": "live2d",
        "kind": "skin",
        "id": model["doll_id"],
        "form": model["form"],
        "skin": model["skin_key"],
        "code": model["bundle"][len(SKIN_LIVE2D_PREFIX) :],
        "assets": assets,
        "missing": missing,
        "status": "resolved" if not missing else "partial",
        "bundles": [bundle_name],
        "sizeOriginal": bundle["sizeOriginal"],
    }


def skin_live2d_items(index, models):
    """Resolve every skin Live2D model whose bundle the game actually ships.

    Args:
        index: The bundle index from `load_index`.
        models: Records from `skin_live2d_table.skin_live2d_models`.

    Returns:
        A list of `live2d` item dicts. A model whose bundle is absent produces no entry, so it never shows as a false gap.
    """
    return [item for item in (skin_live2d_item(index, model) for model in models) if item is not None]


def new_targets(dolls, equipment_ids, manifest, hocs=(), fairies=(), enemies=(), live2d_models=(), units=(), story_keys=()):
    """Work out which dolls, Mods, skins, equipment, HOCs and fairies the committed manifest does not list yet.

    A known gap inside a hosted form, such as a skin with no rig, is not a target, because the form itself is listed. A HOC counts as hosted
    once the manifest lists its art, so a rig added for that HOC later is not picked up as a new target on its own. A fairy counts as hosted
    the same way, once the manifest lists its art. Live2D is tracked separately from art, in its own `manifest["live2d"]["fairies"/"hocs"]`
    block, since most fairies and HOCs never get a Live2D bundle at all. T-Doll skin Live2D models are tracked the same way, in
    `manifest["live2d"]["tdolls"]`, keyed by doll id, form and skin key.

    Args:
        dolls: Site doll records.
        equipment_ids: Equipment ids from the site data.
        manifest: The committed version 3 manifest.
        hocs: HOC records from `load_site`, each `{"id", "code", "name"}`.
        fairies: Fairy records from `load_site`, each `{"id", "code", "name"}`.
        enemies: Enemy records from `load_site`, each `{"id", "code", "name"}`.
        live2d_models: Records from `skin_live2d_table.skin_live2d_models`.
        units: Ids of the Protocol Assimilation units the site ships.
        story_keys: Item keys of the story art the manifest already lists, which are therefore not new targets.

    Returns:
        A dict of `dolls`, `mods`, `equipment`, `hocs`, `fairies` and `enemies` id sets, a `skins` set of `(doll_id, skin_id)` pairs (only numeric skin
        ids count), a `live2d` set of `(kind, id)` pairs where `kind` is `"fairy"` or `"hoc"`, and a `skin` set of `(doll_id, form, skin_key)`
        triples for T-Doll skin Live2D models the manifest does not list.
    """
    listed = manifest["dolls"]
    targets = {"dolls": set(), "mods": set(), "skins": set(), "equipment": set(), "story": {key.lower() for key in story_keys}}
    for doll in dolls:
        doll_id = doll["normal"]["id"]
        entry = listed.get(str(doll_id))
        if entry is None:
            targets["dolls"].add(doll_id)
        if doll.get("mod") is not None and "mod" not in (entry or {}):
            targets["mods"].add(doll_id)
        hosted_skins = (entry or {}).get("skins", {})
        for skin_id in (doll.get("skins") or {}).get("skin_ids") or []:
            if isinstance(skin_id, int) and str(skin_id) not in hosted_skins:
                targets["skins"].add((doll_id, skin_id))
    hosted_equipment = set(manifest["equipment"])
    targets["equipment"] = {equip_id for equip_id in equipment_ids if equip_id not in hosted_equipment}
    listed_hocs = manifest.get("hocs", {})
    targets["hocs"] = {hoc["id"] for hoc in hocs if str(hoc["id"]) not in listed_hocs}
    listed_fairies = manifest.get("fairies", {})
    targets["fairies"] = {fairy["id"] for fairy in fairies if str(fairy["id"]) not in listed_fairies}
    listed_enemies = manifest.get("enemies", {})
    targets["enemies"] = {enemy["id"] for enemy in enemies if str(enemy["id"]) not in listed_enemies}
    targets["factions_hosted"] = len(manifest.get("factions", [])) > 0
    listed_units = manifest.get("assimilation", {})
    targets["units"] = {unit_id for unit_id in units if str(unit_id) not in listed_units}
    listed_live2d = manifest.get("live2d", {})
    listed_live2d_fairies = listed_live2d.get("fairies", {})
    listed_live2d_hocs = listed_live2d.get("hocs", {})
    targets["live2d"] = {("fairy", fairy["id"]) for fairy in fairies if str(fairy["id"]) not in listed_live2d_fairies} | {
        ("hoc", hoc["id"]) for hoc in hocs if str(hoc["id"]) not in listed_live2d_hocs
    }
    listed_tdolls = listed_live2d.get("tdolls", {})
    targets["skin"] = {
        (model["doll_id"], model["form"], model["skin_key"])
        for model in live2d_models
        if model["skin_key"] not in listed_tdolls.get(str(model["doll_id"]), {}).get(model["form"], {})
    }
    return targets


def select_new_items(items, targets):
    """Keep only the items that belong to a new target.

    Art and rigs follow their form. A skill icon keeps only the slots of new dolls (`skill1`) and new Mods (`skill2`), as a copy, so the icon is
    never rewritten for a doll that already hosts it. Legacy items are never selected, since only the old asset repos had them.

    Args:
        items: Item dicts from `build_inventory`.
        targets: The dict from `new_targets`.

    Returns:
        The selected items, in their original order.
    """
    selected = []
    for item in items:
        if item.get("source") == "legacy":
            continue
        tier = item["tier"]
        if tier == "skill_icon":
            users = [user for user in item.get("users", []) if (user[1] == "skill1" and user[0] in targets["dolls"]) or (user[1] == "skill2" and user[0] in targets["mods"])]
            unit_users = [user for user in item.get("unit_users", []) if user[0] in targets.get("units", set())]
            if users or unit_users:
                selected.append({**item, "users": users, **({"unit_users": unit_users} if unit_users else {})})
            continue
        if tier in ("art", "spine"):
            keep = item.get("doll_id") in targets["dolls"]
        elif tier in ("mod_art", "mod_spine"):
            keep = item.get("doll_id") in targets["mods"]
        elif tier in ("skin_art", "skin_spine"):
            keep = (item.get("doll_id"), item.get("skin_id")) in targets["skins"]
        elif tier == "equip_icon":
            keep = item.get("equip_id") in targets["equipment"]
        elif tier in ("hoc_art", "hoc_spine"):
            keep = item.get("hoc_id") in targets.get("hocs", set())
        elif tier == "fairy_art":
            keep = item.get("fairy_id") in targets.get("fairies", set())
        elif tier in ("enemy_art", "enemy_spine"):
            keep = item.get("enemy_id") in targets.get("enemies", set())
        elif tier == "faction_icon":
            keep = not targets.get("factions_hosted", False)
        elif tier == "story_sprite":
            # A sprite gains files in more than one pass: the plain pose first, then the expressions a script asks for. So it is kept
            # when any one of its stems is unpublished, rather than all or nothing the way a background or the chrome is.
            published = targets.get("story", set())
            stem = item["prefab"].lower()
            if item.get("expression"):
                keep = f"story_sprite:{stem}_{item['expression']}" not in published
            else:
                keep = any(name not in published for name in [f"story_sprite:{stem}"] + [f"story_sprite:{stem}_{index}" for index in item.get("expressions", [])])
        elif tier in ("story_background", "story_ui"):
            keep = item["key"].lower() not in targets.get("story", set())
        elif tier == "live2d":
            if item.get("kind") == "skin":
                keep = (item.get("id"), item.get("form"), item.get("skin")) in targets.get("skin", set())
            else:
                keep = (item.get("kind"), item.get("id")) in targets.get("live2d", set())
        else:
            keep = False
        if keep:
            selected.append(item)
    return selected


def only_missing_problems(inventory):
    """List why an `--only-missing` inventory cannot be extracted.

    Args:
        inventory: An inventory dict.

    Returns:
        One message per unexpected unresolved item and per partial item, empty when every selected item resolved or is a known gap.
    """
    summary = inventory["summary"]
    problems = [f"{entry['key']} is unresolved: {entry['reason']}" for entry in summary["unresolved_unexpected"]]
    problems.extend(f"{entry['key']} is missing {', '.join(entry['missing'])}" for entry in summary["partial"])
    return problems


def is_expected_gap(item):
    """Tell whether an unresolved item is a known, accepted gap.

    Args:
        item: An unresolved item dict.

    Returns:
        True for the skill codes with no icon anywhere in the game, and for the rigs and art the game does not ship.
    """
    return item["key"] in EXPECTED_MISSING_RIGS or item["key"] in EXPECTED_MISSING_ART or (item["tier"] == "skill_icon" and item.get("code", "").lower() in EXPECTED_MISSING_SKILL_CODES)


def summarise(items, index, include_ui=True):
    """Total the items per tier and collect the bundles to download.

    Args:
        items: Every resolved or unresolved item.
        index: The bundle index from `load_index`.
        include_ui: Whether to add the whole UI bundles the extractor needs, such as the equipment rarity backgrounds.

    Returns:
        A `(summary, bundles)` pair. `bundles` maps each needed bundle name to its `resname`, `sizeOriginal` and, when known, `sha1`.
    """
    tiers = {tier: {"items": 0, "resolved": 0, "partial": 0, "unresolved": 0, "legacy": 0} for tier in TIERS}
    summary = {"tiers": tiers, "partial": [], "legacy": [], "unresolved_expected": [], "unresolved_unexpected": []}
    names = {name for name in UI_BUNDLES if name in index} if include_ui else set()
    for item in items:
        tiers[item["tier"]]["items"] += 1
        tiers[item["tier"]][item["status"]] += 1
        names.update(item["bundles"])
        if item["status"] == "partial":
            summary["partial"].append({"key": item["key"], "missing": item["missing"]})
        elif item["status"] == "legacy":
            summary["legacy"].append({"key": item["key"], "reason": item["reason"]})
        elif item["status"] == "unresolved":
            entry = {"key": item["key"], "reason": item.get("reason", "no bundle holds the files")}
            summary["unresolved_expected" if is_expected_gap(item) else "unresolved_unexpected"].append(entry)
    bundles = {name: {key: index[name][key] for key in ("resname", "sizeOriginal", "sha1") if key in index[name]} for name in sorted(names)}
    summary["bundle_count"] = len(bundles)
    summary["download_bytes"] = sum(bundle["sizeOriginal"] for bundle in bundles.values())
    summary["download_mb"] = round(summary["download_bytes"] / BYTES_PER_MB, 1)
    return summary, bundles


def build_inventory(
    resdata,
    dolls,
    equipment_ids,
    guns,
    skill_codes,
    equip_codes,
    select=None,
    hocs=(),
    fairies=(),
    enemies=(),
    live2d_rows=(),
    doll_ids=None,
    units=(),
    sangvis=None,
    story_sprites=(),
    story_backgrounds=(),
):
    """Resolve every wanted asset against the ResData manifest.

    Args:
        resdata: The parsed `resdata_no_hash.json`.
        dolls: Site doll records.
        equipment_ids: Equipment ids from the site data.
        guns: Gun rows by id.
        skill_codes: Skill codename by skill group id.
        equip_codes: Equipment codename by id.
        select: Optional callable narrowing the item list before bundles are collected. The UI bundles are then added only for equipment icons.
        hocs: HOC records from `load_site`, each `{"id", "code"}`.
        fairies: Fairy records from `load_site`, each `{"id", "code"}`.
        enemies: Enemy records from `load_site`, each `{"id", "code"}`.
        live2d_rows: Rows from `stc/live2d.json`, used to resolve T-Doll skin Live2D models. Empty when the checkout has none.
        doll_ids: Doll ids the archive hosts, used to filter `live2d_rows`. Defaults to every id in `dolls` when not given.
        units: Ids of the Protocol Assimilation units the site ships, which carry skill icons of their own.
        sangvis: `sangvis` rows by id, holding each unit's skill group ids.
        story_sprites: Sprite prefab names the story scripts refer to. Empty when no story data is generated.
        story_backgrounds: Background codes the story's mission table names. Empty when no story data is generated.

    Returns:
        The inventory dict with `resVersion`, `resUrl`, `summary`, `bundles` and `items`.
    """
    index, res_url = load_index(resdata)
    codes = {gun_id: row["code"] for gun_id, row in guns.items() if row.get("code")}
    items = []
    for doll in dolls:
        items.extend(doll_items(index, doll, codes))
    items.extend(skill_items(index, dolls, guns, skill_codes, units, sangvis))
    items.extend(equip_items(index, equipment_ids, equip_codes))
    for hoc in hocs:
        items.extend(hoc_items(index, hoc))
    for fairy in fairies:
        items.append(fairy_items(index, fairy))
    if enemies:
        # Built once for the whole run, since resolving an enemy rig searches every skeleton in ResData by name.
        skeletons = skeleton_index(index)
        for enemy in enemies:
            items.extend(enemy_items(index, skeletons, enemy))
    if enemies:
        items.extend(faction_icon_items(index))
    items.extend(live2d_items(index, fairies, hocs))
    if story_sprites or story_backgrounds:
        items.extend(story_items(index, story_sprites, story_backgrounds))
    known_dolls = doll_ids if doll_ids is not None else {doll["normal"]["id"] for doll in dolls}
    items.extend(skin_live2d_items(index, skin_live2d_models(live2d_rows, set(index), known_dolls)))
    if select is not None:
        items = select(items)
    include_ui = select is None or any(item["tier"] == "equip_icon" for item in items)
    summary, bundles = summarise(items, index, include_ui)
    return {"resVersion": resdata.get("resVison"), "resUrl": res_url, "summary": summary, "bundles": bundles, "items": items}


def load_story(site_dir):
    """Read which sprites and backgrounds the generated story data asks for.

    Args:
        site_dir: Directory holding the site's generated data, whose `story/` folder the story build writes.

    Returns:
        A `(sprites, backgrounds)` pair, where `sprites` maps each prefab to the non-zero expression indices the scripts ask it for.
        Both are empty when no story data is generated yet.
    """
    # `black` and `White` are entries in the game's background table but are washes rather than pictures, so there is nothing to fetch.
    washes = {"black", "white"}
    story_dir = os.path.join(site_dir, "story")
    if not os.path.isdir(story_dir):
        return {}, []
    sprites, backgrounds = {}, set()
    scenes_dir = os.path.join(story_dir, "scenes")
    if os.path.isdir(scenes_dir):
        for name in os.listdir(scenes_dir):
            if not name.endswith(".json"):
                continue
            for beat in read_json(os.path.join(scenes_dir, name)).get("beats", []):
                for sprite in beat.get("sprites", []):
                    if not sprite.get("prefab"):
                        continue
                    wanted = sprites.setdefault(sprite["prefab"], set())
                    if sprite.get("expression"):
                        wanted.add(sprite["expression"])
                # A scene changes background mid-way far more often than its mission names one, and those are the ones that were
                # being missed: the mission table names 383 backgrounds where the scripts between them ask for 600.
                for op in beat.get("ops", []):
                    value = op.get("value")
                    if op.get("type") == "background" and value and value.lower() not in washes:
                        backgrounds.add(value)
    for name in os.listdir(story_dir):
        if not name.startswith("chapter-") or not name.endswith(".json"):
            continue
        for mission in read_json(os.path.join(story_dir, name)).get("missions", []):
            if mission.get("background"):
                backgrounds.add(mission["background"])
    return {name: sorted(wanted) for name, wanted in sorted(sprites.items(), key=lambda pair: pair[0].lower())}, sorted(backgrounds, key=str.lower)


def inventory_from_paths(resdata_path, gf_data_dir, site_dir, manifest_path=None):
    """Load every input from disk and build the inventory.

    Args:
        resdata_path: Path to `resdata_no_hash.json`.
        gf_data_dir: The `gf-data-us` checkout.
        site_dir: Directory holding the site's `dolls-*.json`, `equipment.json` and, when hosted, `hocs.json` and `fairies.json`.
        manifest_path: The committed manifest. When given, only items for targets it does not list are kept and the inventory is flagged
            `onlyMissing`.

    Returns:
        The inventory dict from `build_inventory`.
    """
    dolls, equipment_ids, hocs, fairies, enemies, units = load_site(site_dir)
    guns, skill_codes, equip_codes, sangvis = load_tables(gf_data_dir)
    live2d_rows = load_live2d_table(gf_data_dir)
    resdata = read_json(resdata_path)
    story_sprites, story_backgrounds = load_story(site_dir)
    shared = {
        "hocs": hocs,
        "fairies": fairies,
        "enemies": enemies,
        "live2d_rows": live2d_rows,
        "units": units,
        "sangvis": sangvis,
        "story_sprites": story_sprites,
        "story_backgrounds": story_backgrounds,
    }
    if manifest_path is None:
        return build_inventory(resdata, dolls, equipment_ids, guns, skill_codes, equip_codes, **shared)
    # `new_targets` needs the resolved skin Live2D models, the same ones `build_inventory` resolves below, or `targets["skin"]` stays empty
    # and `select_new_items` drops every skin item regardless of what the manifest lists.
    index, _res_url = load_index(resdata)
    known_dolls = {doll["normal"]["id"] for doll in dolls}
    live2d_models = skin_live2d_models(live2d_rows, set(index), known_dolls)
    manifest = read_json(manifest_path)
    story_block = manifest.get("story", {})
    story_keys = (
        [f"story_sprite:{name}" for name in story_block.get("sprites", [])]
        + [f"story_background:{name}" for name in story_block.get("backgrounds", [])]
        + (["story_ui"] if story_block.get("ui") else [])
    )
    targets = new_targets(dolls, equipment_ids, manifest, hocs=hocs, fairies=fairies, enemies=enemies, live2d_models=live2d_models, units=units, story_keys=story_keys)
    inventory = build_inventory(resdata, dolls, equipment_ids, guns, skill_codes, equip_codes, select=lambda items: select_new_items(items, targets), **shared)
    inventory["onlyMissing"] = True
    return inventory


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Download


def log_line(message):
    """Print one progress line, safe to call from worker threads.

    Args:
        message: The line to print.
    """
    with LOG_LOCK:
        print(message, flush=True)


def http_fetch(url, dest):
    """Stream one URL to a file with a descriptive User-Agent.

    Args:
        url: The bundle URL.
        dest: The file path to write.

    Raises:
        urllib.error.URLError: On a network or HTTP failure.
    """
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response, open(dest, "wb") as handle:
        shutil.copyfileobj(response, handle, CHUNK_BYTES)


def cached_size(cache_dir, name):
    """Read the size of a cached bundle.

    Args:
        cache_dir: The bundle cache directory.
        name: Bundle name.

    Returns:
        The byte count, or None when the bundle is not cached.
    """
    path = os.path.join(cache_dir, f"{name}.ab")
    return os.path.getsize(path) if os.path.isfile(path) else None


def file_sha1(path):
    """Hash a file with SHA-1, the digest ResData records as `fileHash`.

    Args:
        path: The file.

    Returns:
        The lowercase hex digest.
    """
    digest = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_cache_index(cache_dir):
    """Read the cache index sidecar.

    Args:
        cache_dir: The bundle cache directory.

    Returns:
        A dict of bundle name to `{resname, size, sha1?}`, empty when the sidecar does not exist yet.
    """
    path = os.path.join(cache_dir, CACHE_INDEX_NAME)
    return read_json(path) if os.path.isfile(path) else {}


def write_cache_index(cache_dir, index):
    """Write the cache index sidecar atomically, names sorted so reruns give the same file.

    Args:
        cache_dir: The bundle cache directory.
        index: The dict from `read_cache_index`, updated.
    """
    path = os.path.join(cache_dir, CACHE_INDEX_NAME)
    with open(f"{path}.tmp", "w", encoding="utf-8") as handle:
        json.dump(dict(sorted(index.items())), handle, indent=1)
        handle.write("\n")
    os.replace(f"{path}.tmp", path)


def index_record(bundle, size):
    """Build the cache index record of a bundle cached at a size.

    Args:
        bundle: Dict with `resname` and, when known, `sha1`.
        size: The cached file's size.

    Returns:
        The record dict.
    """
    record = {"resname": bundle["resname"], "size": size}
    if bundle.get("sha1"):
        record["sha1"] = bundle["sha1"]
    return record


def cache_state(cache_dir, name, bundle, index, hasher=file_sha1):
    """Decide whether a cached bundle can be used as it is.

    The content hash name (`resname`) is the key and the size a second check. A bundle cached before the index existed has no record, so it is
    adopted only when its SHA-1 matches the `fileHash` ResData records.

    Args:
        cache_dir: The bundle cache directory.
        name: Bundle name.
        bundle: Dict with `resname`, `sizeOriginal` and, when known, `sha1`.
        index: The cache index from `read_cache_index`.
        hasher: Callable hashing a file, replaceable in tests.

    Returns:
        `cached` when the record matches, `migrated` when an unrecorded or outdated file's hash matches, otherwise `stale`.
    """
    size = cached_size(cache_dir, name)
    if size != bundle["sizeOriginal"]:
        return "stale"
    record = index.get(name) or {}
    if record.get("resname") == bundle["resname"] and record.get("size") == size:
        return "cached"
    if bundle.get("sha1") and hasher(os.path.join(cache_dir, f"{name}.ab")) == bundle["sha1"]:
        return "migrated"
    return "stale"


def fetch_bundle(name, bundle, res_url, cache_dir, fetch, sleep):
    """Download one bundle with retries, writing through a `.part` file.

    Args:
        name: Bundle name.
        bundle: Dict with `resname` and `sizeOriginal`.
        res_url: CDN base URL.
        cache_dir: The bundle cache directory.
        fetch: Callable `(url, dest)` that writes the URL to `dest`.
        sleep: Callable used for the backoff delay.

    Returns:
        None on success, or the last error message after `ATTEMPTS` failures.
    """
    url = f"{res_url}{bundle['resname']}.ab"
    final = os.path.join(cache_dir, f"{name}.ab")
    part = f"{final}.part"
    error = None
    for attempt in range(ATTEMPTS):
        if attempt:
            sleep(BACKOFF_SECONDS * 2 ** (attempt - 1))
        try:
            fetch(url, part)
            size = os.path.getsize(part)
            if size != bundle["sizeOriginal"]:
                raise OSError(f"size {size} != expected {bundle['sizeOriginal']}")
            if bundle.get("sha1") and file_sha1(part) != bundle["sha1"]:
                raise OSError(f"SHA-1 does not match fileHash {bundle['sha1']}")
            os.replace(part, final)
            return None
        except Exception as exc:
            error = f"attempt {attempt + 1}: {exc}"
            if os.path.exists(part):
                os.remove(part)
    return error


def download_bundles(bundles, res_url, cache_dir, fetch=http_fetch, workers=MAX_WORKERS, sleep=time.sleep, log=log_line):
    """Download every bundle not already cached under its `resname` at its expected size, and record each in the cache index.

    Args:
        bundles: Map of bundle name to `resname`, `sizeOriginal` and, when known, `sha1`.
        res_url: CDN base URL.
        cache_dir: The bundle cache directory.
        fetch: Callable `(url, dest)` that writes the URL to `dest`.
        workers: Parallel downloads, capped at `MAX_WORKERS`.
        sleep: Callable used for the backoff delay.
        log: Callable receiving progress lines.

    Returns:
        A dict with `downloaded`, `skipped` and `migrated` name lists (`migrated` is the part of `skipped` adopted by hash), `failed` entries of
        `{name, error}` and `bytes` downloaded.
    """
    os.makedirs(cache_dir, exist_ok=True)
    index = read_cache_index(cache_dir)
    states = {name: cache_state(cache_dir, name, bundle, index) for name, bundle in bundles.items()}
    skipped = [name for name in bundles if states[name] != "stale"]
    migrated = [name for name in bundles if states[name] == "migrated"]
    for name in migrated:
        index[name] = index_record(bundles[name], bundles[name]["sizeOriginal"])
    if migrated:
        write_cache_index(cache_dir, index)
    pending = [name for name in bundles if states[name] == "stale"]
    total_bytes = sum(bundles[name]["sizeOriginal"] for name in pending)
    log(f"{len(bundles)} bundles: {len(skipped)} cached ({len(migrated)} adopted by SHA-1), {len(pending)} to download ({total_bytes / BYTES_PER_MB:.1f} MB)")

    result = {"downloaded": [], "skipped": skipped, "migrated": migrated, "failed": [], "bytes": 0}
    started = time.monotonic()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(workers, MAX_WORKERS))) as pool:
            futures = {pool.submit(fetch_bundle, name, bundles[name], res_url, cache_dir, fetch, sleep): name for name in pending}
            for done, future in enumerate(concurrent.futures.as_completed(futures), start=1):
                name = futures[future]
                error = future.result()
                if error:
                    result["failed"].append({"name": name, "error": error})
                    log(f"[{done}/{len(pending)}] FAILED {name}: {error}")
                    continue
                index[name] = index_record(bundles[name], bundles[name]["sizeOriginal"])
                result["downloaded"].append(name)
                result["bytes"] += bundles[name]["sizeOriginal"]
                elapsed = time.monotonic() - started
                log(f"[{done}/{len(pending)}] {name} {bundles[name]['sizeOriginal'] / BYTES_PER_MB:.2f} MB, {result['bytes'] / BYTES_PER_MB:.1f} MB in {elapsed:.0f}s")
    finally:
        if pending:
            write_cache_index(cache_dir, index)
    result["downloaded"].sort()
    result["failed"].sort(key=lambda entry: entry["name"])
    return result


def verify_cache(bundles, cache_dir):
    """List bundles that are missing from the cache, have the wrong size, or were cached under another `resname`.

    Args:
        bundles: Map of bundle name to `resname` and `sizeOriginal`.
        cache_dir: The bundle cache directory.

    Returns:
        A list of `{name, check, expected, actual}` dicts with `check` of `size` or `resname`, empty when the cache is complete.
    """
    index = read_cache_index(cache_dir)
    problems = []
    for name, bundle in sorted(bundles.items()):
        actual = cached_size(cache_dir, name)
        if actual != bundle["sizeOriginal"]:
            problems.append({"name": name, "check": "size", "expected": bundle["sizeOriginal"], "actual": actual})
        elif (index.get(name) or {}).get("resname") != bundle["resname"]:
            problems.append({"name": name, "check": "resname", "expected": bundle["resname"], "actual": (index.get(name) or {}).get("resname")})
    return problems


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# CLI


def print_summary(inventory):
    """Print the inventory summary as a short table.

    Args:
        inventory: The inventory dict from `build_inventory`.
    """
    summary = inventory["summary"]
    print(f"resVersion={inventory['resVersion']}  cdn={inventory['resUrl']}")
    print(f"{'TIER':<12}{'ITEMS':>7}{'RESOLVED':>10}{'PARTIAL':>9}{'UNRESOLVED':>12}{'LEGACY':>8}")
    for tier, counts in summary["tiers"].items():
        print(f"{tier:<12}{counts['items']:>7}{counts['resolved']:>10}{counts['partial']:>9}{counts['unresolved']:>12}{counts['legacy']:>8}")
    print(f"bundles to download: {summary['bundle_count']} ({summary['download_mb']} MB)")
    for label in ("legacy", "unresolved_expected", "unresolved_unexpected", "partial"):
        entries = summary[label]
        print(f"{label}: {len(entries)}")
        for entry in entries:
            print(f"  {entry['key']}  {entry.get('reason') or ','.join(entry['missing'])}")


def main():
    """Parse arguments and run the requested subcommand."""
    parser = argparse.ArgumentParser(description="Resolve and download the game's asset bundles for the asset rebuild.")
    parser.add_argument("command", choices=("inventory", "download", "verify"))
    parser.add_argument("--gf-data", default=os.environ.get("GF_DATA_DIR"), help="The gf-data-us checkout. Defaults to $GF_DATA_DIR.")
    parser.add_argument("--site-data", default=SITE_DATA_DIR, help="Directory holding the site's dolls-*.json and equipment.json.")
    parser.add_argument("--cache", default=BUNDLE_CACHE_DIR, help="Bundle cache directory.")
    parser.add_argument("--workers", type=int, default=MAX_WORKERS, help=f"Parallel downloads, at most {MAX_WORKERS}.")
    parser.add_argument("--only-missing", action="store_true", help="Keep only items for dolls, Mods, skins and equipment the committed manifest does not list.")
    parser.add_argument("--manifest", default=MANIFEST_PATH, help="The committed manifest `--only-missing` compares against.")
    args = parser.parse_args()
    if not args.gf_data:
        sys.exit("pass --gf-data or set GF_DATA_DIR")

    manifest_path = args.manifest if args.only_missing else None
    inventory = inventory_from_paths(os.path.join(args.gf_data, "resdata_no_hash.json"), args.gf_data, args.site_data, manifest_path)
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(INVENTORY_PATH, "w", encoding="utf-8") as handle:
        json.dump(inventory, handle, indent=1, ensure_ascii=False)

    if args.only_missing:
        print(f"only missing: {len(inventory['items'])} items, {inventory['summary']['bundle_count']} bundles ({inventory['summary']['download_mb']} MB)")
        problems = only_missing_problems(inventory)
        if problems:
            sys.exit("new assets cannot be extracted yet:\n  " + "\n  ".join(problems))

    if args.command == "inventory":
        print_summary(inventory)
        print(f"wrote {INVENTORY_PATH}")
        return

    bundles = inventory["bundles"]
    if args.command == "download":
        started = time.monotonic()
        result = download_bundles(bundles, inventory["resUrl"], args.cache, workers=args.workers)
        minutes = (time.monotonic() - started) / 60
        print(
            f"downloaded {len(result['downloaded'])} ({result['bytes'] / BYTES_PER_MB:.1f} MB), skipped {len(result['skipped'])} "
            f"({len(result['migrated'])} adopted by SHA-1), failed {len(result['failed'])} in {minutes:.1f} min"
        )
        for entry in result["failed"]:
            print(f"  FAILED {entry['name']}: {entry['error']}")

    problems = verify_cache(bundles, args.cache)
    cached_mb = sum(bundle["sizeOriginal"] for bundle in bundles.values()) / BYTES_PER_MB
    print(f"verify: {len(bundles) - len(problems)}/{len(bundles)} bundles cached at expected size and resname ({cached_mb:.1f} MB expected)")
    for problem in problems:
        print(f"  {problem['name']}: {problem['check']} expected {problem['expected']}, found {problem['actual']}")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
