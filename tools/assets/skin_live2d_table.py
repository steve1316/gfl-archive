#!/usr/bin/env python3
"""Join `stc/live2d.json` into the set of T-Doll skin Live2D models worth building.

The table names one row per playable combination. `fit_gun` is the doll id, offset by `MOD_ID_OFFSET` when the row is for a doll's Mod form,
and `skin` is the skin id or 0 for the form's own base art. A row's `code` names its bundle, `live2dnew_gun_<code lowercased>`.

The key is `(doll_id, form, skin_key)` and all three parts are load bearing. Dropping `form` collides in 41 cases, and one of those is a real
difference rather than a duplicate: `AR15_4508` and `AR15Mod` both describe skin 4508, but resolve to `live2dnew_gun_ar15_4508` and
`live2dnew_gun_ar15mod`, which are different models. A Mod row whose own `<Code>Mod_<skinId>` bundle does not exist instead points at the base
doll's `<code>_<skinId>` bundle, because that Mod really does wear the base model. Two keys then name the same bundle, but each still gets its
own extraction and its own published folder - a duplicated copy of the model per key, not a shared one - for 41 of the 238 keys.

Rows that are not dolls carry `fit_gun` of 0 or -1: the `cg_*` scenes, `NPC_Kalina` and `NPC_William_live2d`. The filter is `fit_gun > 0`, not
`fit_gun != -1`, because the cg rows use 0.
"""

import re

from download_spine import MOD_ID_OFFSET

# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Constants

# Bundle name prefix every T-Doll skin Live2D bundle shares.
SKIN_LIVE2D_PREFIX = "live2dnew_gun_"

# A Mod row's code, such as `UMP45Mod_3403`, when the Mod has no bundle of its own and falls back to the base doll's skin bundle.
MOD_SKIN_CODE = re.compile(r"^(.+)Mod_(\d+)$")

# A skin Live2D bundle holds two models under sibling folders. The output name for `destroy` is `damaged`, matching the archive's own wording
# for damaged art everywhere else.
SKIN_LIVE2D_VARIANTS = (("normal", "normal"), ("damaged", "destroy"))


def parse_motion_ids(motions):
    """Parse a row's `motions` column into motion ids.

    The column is a comma separated list with newlines scattered through it, such as `1000,1001\\n,1002`.

    Args:
        motions: The row's `motions` value.

    Returns:
        A list of int motion ids, in the column's own order.
    """
    return [int(part) for part in motions.replace("\n", "").split(",") if part.strip()]


def row_model_key(row):
    """Derive a `stc/live2d.json` row's model key.

    Args:
        row: One row from `stc/live2d.json`.

    Returns:
        The `(doll_id, form, skin_key)` tuple, with `form` `base` or `mod` and `skin_key` `base` or the stringified skin id, or None when
        the row is not a doll (`fit_gun <= 0`).
    """
    fit_gun = row["fit_gun"]
    if fit_gun <= 0:
        return None
    is_mod = fit_gun > MOD_ID_OFFSET
    return (fit_gun - MOD_ID_OFFSET if is_mod else fit_gun, "mod" if is_mod else "base", "base" if row["skin"] == 0 else str(row["skin"]))


def skin_live2d_models(rows, bundle_names, doll_ids):
    """Pick the skin Live2D models to build from the game's table.

    Args:
        rows: Rows from `stc/live2d.json`.
        bundle_names: Every bundle name in the ResData index, so a row with no bundle is dropped.
        doll_ids: Doll ids the archive hosts, so a row for a doll we do not have is dropped.

    Returns:
        A list of `{"doll_id", "form", "skin_key", "bundle"}` dicts, one per distinct key, sorted by doll id then form then
        skin key. `form` is `base` or `mod` and `skin_key` is `base` or the stringified skin id.
    """
    models = {}
    for row in rows:
        key = row_model_key(row)
        if key is None or key[0] not in doll_ids:
            continue
        bundle = SKIN_LIVE2D_PREFIX + row["code"].lower()
        if bundle not in bundle_names:
            match = MOD_SKIN_CODE.match(row["code"])
            bundle = f"{SKIN_LIVE2D_PREFIX}{match.group(1).lower()}_{match.group(2)}" if match else None
        if bundle is None or bundle not in bundle_names:
            continue
        if key in models:
            continue
        models[key] = {
            "doll_id": key[0],
            "form": key[1],
            "skin_key": key[2],
            "bundle": bundle,
        }
    return [models[key] for key in sorted(models)]
