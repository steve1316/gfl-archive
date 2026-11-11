"""Unit tests for `game_bundles`, run with `python3 -m unittest discover tools/assets/tests`.

Everything runs against the small fixture tree next to this file. No test touches the network.
"""

import hashlib
import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import game_bundles  # noqa: E402


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Fixtures

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
GF_DATA = os.path.join(FIXTURES, "gf-data")
SITE_DATA = os.path.join(FIXTURES, "site")


def build_fixture_inventory():
    """Build the inventory for the fixture tree.

    Returns:
        The inventory dict produced by `game_bundles.inventory_from_paths`.
    """
    return game_bundles.inventory_from_paths(os.path.join(FIXTURES, "resdata_no_hash.json"), GF_DATA, SITE_DATA)


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Resolution


class ResolutionTests(unittest.TestCase):
    """Bundle naming, the `_nom` fallback and per-asset confirmation."""

    @classmethod
    def setUpClass(cls):
        """Build the fixture inventory once for every test in the class."""
        cls.inventory = build_fixture_inventory()
        cls.items = {item["key"]: item for item in cls.inventory["items"]}

    def test_base_art_uses_plain_bundle(self):
        """A doll with a plain `character_<code>` bundle resolves all three art files from it."""
        item = self.items["art:1"]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["bundles"], ["character_m1873"])
        self.assertEqual(item["assets"]["full"]["path"], "Assets/Characters/M1873/Pic/pic_M1873.png")
        self.assertEqual(item["assets"]["card"]["path"], "Assets/Characters/M1873/Pic/pic_M1873_N.jpg")
        self.assertEqual(item["sizeOriginal"], 1000)

    def test_nom_fallback_when_plain_bundle_lacks_the_art(self):
        """A plain bundle that exists but lacks the art falls back to `_nom`, never `_he`."""
        item = self.items["art:233"]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["bundles"], ["character_px4storm_nom"])
        skin = self.items["skin_art:233:2801"]
        self.assertEqual(skin["bundles"], ["character_px4storm_2801_nom"])
        self.assertNotIn("character_px4storm_he", self.inventory["bundles"])
        self.assertNotIn("character_px4storm", self.inventory["bundles"])

    def test_mod_naming(self):
        """Mod art and rigs come from `character_<code>mod` and its `_spine` bundle."""
        self.assertEqual(self.items["mod_art:1"]["bundles"], ["character_m1873mod"])
        self.assertEqual(self.items["mod_spine:1"]["bundles"], ["character_m1873mod_spine"])
        self.assertNotIn("mod_art:163", self.items)

    def test_skin_naming_and_mod_card(self):
        """Skins resolve `character_<code>_<skinId>` and pick up the Mod card when the doll has a Mod."""
        item = self.items["skin_art:1:301"]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["assets"]["mod_card"]["path"], "Assets/Characters/M1873_301/Pic/pic_M1873_301_N_mod.jpg")
        self.assertNotIn("mod_card", self.items["skin_art:233:2801"]["assets"])

    def test_spine_stem_fallback_for_renamed_rig_files(self):
        """A `_spine` bundle whose files use another stem, like `Gsh-18_523`, resolves to that stem."""
        item = self.items["skin_spine:1:302"]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["code"], "M-1873_302")
        self.assertEqual(item["assets"]["skel"]["path"], "Assets/Characters/M1873_302/Spine/M-1873_302.skel.bytes")
        self.assertEqual(item["assets"]["dorm_skel"]["path"], "Assets/Characters/M1873_302/Spine/RM-1873_302.skel.bytes")

    def test_null_skin_ids_are_skipped(self):
        """Skins without an id produce no item."""
        self.assertEqual(sorted(k for k in self.items if k.startswith("skin_art:163:")), ["skin_art:163:902"])

    def test_legacy_skin_keys_are_skipped(self):
        """`legacy-<slug>` keys have no game bundle, so they produce neither an art nor a Spine item."""
        self.assertFalse([key for key in self.items if "legacy-" in key])

    def test_spine_naming_and_art_bundle_fallback(self):
        """Rigs come from `_spine`, or from the art bundle when that holds the skeleton."""
        self.assertEqual(self.items["spine:1"]["bundles"], ["character_m1873_spine"])
        self.assertEqual(self.items["spine:1"]["assets"]["dorm_skel"]["path"], "Assets/Characters/M1873/Spine/RM1873.skel.bytes")
        self.assertEqual(self.items["spine:163"]["bundles"], ["character_aa12"])
        self.assertEqual(self.items["spine:163"]["status"], "resolved")
        skin_rig = self.items["skin_spine:1:301"]
        self.assertEqual(skin_rig["status"], "resolved")
        self.assertNotIn("dorm_skel", skin_rig["assets"])

    def test_code_overrides_resolve_collab_dolls(self):
        """Collaboration dolls with no `gun` row use the codename overrides from `download_spine`."""
        self.assertEqual(self.items["art:1003"]["bundles"], ["character_kiana"])
        self.assertEqual(self.items["spine:1003"]["bundles"], ["character_kiana_spine"])

    def test_shared_icons(self):
        """Skill icons come from the SkillIcon folder of `sprites_ui` and equipment icons carry their alpha."""
        skill = self.items["skill_icon:powBuff"]
        self.assertEqual(skill["assets"]["icon"]["path"], "Assets/Sprites/UI/Icon/SkillIcon/powBuff.png")
        self.assertEqual(skill["users"], [[1, "skill1"], [163, "skill1"]])
        equip = self.items["equip_icon:1"]
        self.assertEqual(equip["bundles"], ["resource_icon_equip"])
        self.assertEqual(equip["assets"]["alpha"]["path"], "Assets/Resources/DaBao/Pics/Icons/Equip/scope_N_Alpha.png")
        self.assertNotIn("alpha", self.items["equip_icon:2"]["assets"])

    def test_skill_icon_alias(self):
        """A skill code whose icon file carries another name resolves through the alias table."""
        item = self.items["skill_icon:c93"]
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["assets"]["icon"]["path"], "Assets/Sprites/UI/Icon/SkillIcon/c93G.png")

    def test_partial_items(self):
        """A bundle missing some required files is reported as partial with the missing roles."""
        item = self.items["skin_art:163:902"]
        self.assertEqual(item["status"], "partial")
        self.assertEqual(item["missing"], ["full_d", "card"])
        self.assertEqual(self.inventory["summary"]["partial"], [{"key": "skin_art:163:902", "missing": ["full_d", "card"]}])

    def test_unresolved_reporting(self):
        """Known gaps are split from unexpected ones."""
        summary = self.inventory["summary"]
        expected = {entry["key"] for entry in summary["unresolved_expected"]}
        unexpected = {entry["key"] for entry in summary["unresolved_unexpected"]}
        self.assertEqual(expected, {"skill_icon:ma"})
        self.assertEqual(
            unexpected,
            {"art:999", "spine:999", "skill_icon:ghostSkill", "skin_art:1:302", "skin_spine:163:902", "skin_spine:233:2801", "equip_icon:3"},
        )

    def test_collab_skill_slots_are_legacy_sourced(self):
        """A collaboration doll's skill slot has no codename, so it is carried from the old repo rather than counted as a gap."""
        item = self.items["skill_icon:doll:1003:skill1"]
        self.assertEqual((item["status"], item["source"], item["users"], item["bundles"]), ("legacy", "legacy", [[1003, "skill1"]], []))
        self.assertEqual([entry["key"] for entry in self.inventory["summary"]["legacy"]], ["skill_icon:doll:1003:skill1"])
        self.assertEqual(self.inventory["summary"]["tiers"]["skill_icon"]["legacy"], 1)

    def test_file_hash_is_normalised(self):
        """ResData's dashed upper-case `fileHash` becomes a plain SHA-1 digest, and anything else is dropped."""
        self.assertEqual(game_bundles.normalise_file_hash("DA-D3-32-A0-79-8A-F6-10-B9-64-A8-ED-C0-B5-8F-30-17-05-B1-D2"), "dad332a0798af610b964a8edc0b58f301705b1d2")
        self.assertIsNone(game_bundles.normalise_file_hash(None))
        self.assertIsNone(game_bundles.normalise_file_hash("12-34"))

    def test_summary_counts_and_bundle_totals(self):
        """Tier counts and the deduplicated download total match the fixture."""
        summary = self.inventory["summary"]
        self.assertEqual(summary["tiers"]["art"], {"items": 5, "resolved": 4, "partial": 0, "unresolved": 1, "legacy": 0})
        self.assertEqual(summary["tiers"]["skin_art"], {"items": 4, "resolved": 2, "partial": 1, "unresolved": 1, "legacy": 0})
        self.assertEqual(summary["tiers"]["equip_icon"], {"items": 3, "resolved": 2, "partial": 0, "unresolved": 1, "legacy": 0})
        self.assertEqual(summary["bundle_count"], 16)
        self.assertEqual(summary["download_bytes"], 18250)
        self.assertEqual(self.inventory["bundles"]["sprites_ui"], {"resname": "hashspritesui", "sizeOriginal": 5000})

    def test_ui_bundles_are_downloaded_when_listed(self):
        """UI bundles the extractor needs join the download list when ResData has them, and are skipped otherwise."""
        index = {"atlasclips_listequipment": {"resname": "hashframe", "sizeOriginal": 7, "files": []}}
        _summary, bundles = game_bundles.summarise([], index)
        self.assertEqual(bundles, {"atlasclips_listequipment": {"resname": "hashframe", "sizeOriginal": 7}})
        self.assertEqual(game_bundles.summarise([], {})[1], {})


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# HOC resolution


def hoc_index(files_by_bundle):
    """Build a bundle index like `load_index` returns from `{bundle: [paths]}`."""
    return {name: {"resname": name, "sizeOriginal": 1, "files": [(path.lower(), path) for path in paths]} for name, paths in files_by_bundle.items()}


SQUADS = "Assets/Resources/DaBao/Pics/Squads/"


def squad_pictures(code):
    """The seven picture paths one HOC has in `resource_squads`."""
    return [f"{SQUADS}Squads_Vertical/{code}_Vertical.png"] + [f"{SQUADS}{code}_{part}" for part in ("BGL.jpg", "BGR.jpg", "Left.png", "Left_Alpha.png", "Right.png", "Right_Alpha.png")]


class HocResolutionTests(unittest.TestCase):
    """HOC art and rigs resolve from `resource_squads` and `character_<code>_spine`."""

    def test_art_uses_the_vertical_card_in_its_folder(self):
        index = hoc_index({"resource_squads": [f"{SQUADS}L9A1_Vertical.png"] + squad_pictures("L9A1")})
        art = game_bundles.hoc_items(index, {"id": 11, "code": "L9A1"})[0]
        self.assertEqual(art["key"], "hoc_art:11")
        self.assertEqual(art["status"], "resolved")
        self.assertEqual(art["assets"]["card"]["path"], f"{SQUADS}Squads_Vertical/L9A1_Vertical.png")
        self.assertEqual(sorted(art["assets"]), ["bgl", "bgr", "card", "left", "left_alpha", "right", "right_alpha"])

    def test_missing_card_is_optional(self):
        """RPG29 ships no vertical card, so the art still resolves and the card role is simply absent."""
        index = hoc_index({"resource_squads": squad_pictures("RPG29")[1:]})
        art = game_bundles.hoc_items(index, {"id": 10, "code": "RPG29"})[0]
        self.assertEqual(art["status"], "resolved")
        self.assertNotIn("card", art["assets"])

    def test_rig_lists_combat_and_crew_with_own_or_shared_atlases(self):
        spine = "Assets/Characters/MK153/Spine/"
        names = ("MK153.atlas.txt", "MK153.png", "MK153.skel.bytes", "RMK153A.skel.bytes", "RMK153B.atlas.txt", "RMK153B.png", "RMK153B.skel.bytes", "RMK153C.skel.bytes")
        rig = game_bundles.hoc_items(hoc_index({"character_mk153_spine": [spine + name for name in names]}), {"id": 7, "code": "MK153"})[1]
        self.assertEqual(rig["status"], "resolved")
        self.assertEqual(rig["crew"], 3)
        self.assertTrue(rig["assets"]["crew1_skel"]["path"].endswith("RMK153A.skel.bytes"))
        self.assertNotIn("crew1_atlas", rig["assets"])
        self.assertTrue(rig["assets"]["crew2_atlas"]["path"].endswith("RMK153B.atlas.txt"))
        self.assertTrue(rig["assets"]["crew2_texture"]["path"].endswith("RMK153B.png"))

    def test_crew_names_with_spaces_and_no_r_prefix(self):
        spine = "Assets/Characters/QLZ04/Spine/"
        names = ("QLZ04.atlas.txt", "QLZ04.png", "QLZ04.skel.bytes", "QLZ04 A.skel.bytes", "QLZ04 B.skel.bytes")
        rig = game_bundles.hoc_items(hoc_index({"character_qlz04_spine": [spine + name for name in names]}), {"id": 6, "code": "QLZ04"})[1]
        self.assertEqual(rig["crew"], 2)
        self.assertTrue(rig["assets"]["skel"]["path"].endswith("QLZ04.skel.bytes"))
        self.assertTrue(rig["assets"]["crew1_skel"]["path"].endswith("QLZ04 A.skel.bytes"))

    def test_missing_bundles_are_unresolved(self):
        art, rig = game_bundles.hoc_items(hoc_index({}), {"id": 1, "code": "TOW"})
        self.assertEqual((art["status"], rig["status"]), ("unresolved", "unresolved"))


class HocTargetTests(unittest.TestCase):
    """`--only-missing` picks HOCs the committed manifest does not list."""

    def test_new_hocs_are_targets_and_their_items_selected(self):
        manifest = {"dolls": {}, "equipment": [], "hocs": {"1": ["card", "full"]}}
        targets = game_bundles.new_targets([], [], manifest, hocs=[{"id": 1, "code": "TOW"}, {"id": 2, "code": "AGS30"}])
        self.assertEqual(targets["hocs"], {2})
        items = [{"tier": "hoc_art", "hoc_id": 1}, {"tier": "hoc_spine", "hoc_id": 2}, {"tier": "hoc_art", "hoc_id": 2}]
        self.assertEqual(game_bundles.select_new_items(items, targets), items[1:])

    def test_manifest_without_hocs_targets_every_hoc(self):
        targets = game_bundles.new_targets([], [], {"dolls": {}, "equipment": []}, hocs=[{"id": 3, "code": "2B14"}])
        self.assertEqual(targets["hocs"], {3})


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Fairy resolution


FAIRY_PICS = "Assets/Resources/DaBao/Pics/Fairy/"


def fairy_pictures(code):
    """The six picture paths one fairy has in `resource_fairy`."""
    return [f"{FAIRY_PICS}{code}_{number}{alpha}.png" for number in (1, 2, 3) for alpha in ("", "_Alpha")]


class FairyResolutionTests(unittest.TestCase):
    """Fairy art resolves from `resource_fairy` and ignores the `Battle/` twins."""

    def test_art_resolves_all_six_roles_and_ignores_the_battle_folder(self):
        battle = [f"{FAIRY_PICS}Battle/fighting_1.png"]
        index = hoc_index({"resource_fairy": battle + fairy_pictures("fighting")})
        art = game_bundles.fairy_items(index, {"id": 1, "code": "fighting"})
        self.assertEqual(art["key"], "fairy_art:1")
        self.assertEqual(art["status"], "resolved")
        self.assertEqual(sorted(art["assets"]), ["form1", "form1_alpha", "form2", "form2_alpha", "form3", "form3_alpha"])
        self.assertEqual(art["assets"]["form1"]["path"], f"{FAIRY_PICS}fighting_1.png")

    def test_missing_bundle_is_unresolved(self):
        art = game_bundles.fairy_items(hoc_index({}), {"id": 2, "code": "air_attack"})
        self.assertEqual(art["status"], "unresolved")


class FairyTargetTests(unittest.TestCase):
    """`--only-missing` picks fairies the committed manifest does not list."""

    def test_new_fairies_are_targets_and_their_items_selected(self):
        manifest = {"dolls": {}, "equipment": [], "fairies": {"1": ["form1"]}}
        targets = game_bundles.new_targets([], [], manifest, fairies=[{"id": 1, "code": "fighting"}, {"id": 2, "code": "air_attack"}])
        self.assertEqual(targets["fairies"], {2})
        items = [{"tier": "fairy_art", "fairy_id": 1}, {"tier": "fairy_art", "fairy_id": 2}]
        self.assertEqual(game_bundles.select_new_items(items, targets), items[1:])

    def test_manifest_without_fairies_targets_every_fairy(self):
        targets = game_bundles.new_targets([], [], {"dolls": {}, "equipment": []}, fairies=[{"id": 3, "code": "Nian"}])
        self.assertEqual(targets["fairies"], {3})


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Live2D resolution


def fairy_live2d_files(code):
    """The nine model files and two motion files one fairy's Live2D bundle has, for `code`."""
    base = f"Assets/Resources/DaBao/Live2DNew/Fairy/{code}/"
    forms = [f"{base}{n}/model{n}{suffix}" for n in (1, 2, 3) for suffix in ("_moc.asset", ".prefab", ".2048/texture_00.png")]
    motions = [f"{base}motions/wait_01.anim", f"{base}motions/wait_01.fade.asset"]
    return forms + motions


def hoc_live2d_files(code):
    """The four model files and one motion file one HOC's Live2D bundle has, for `code`."""
    base = f"Assets/Resources/DaBao/Live2DNew/Squads/{code}/"
    return [f"{base}model_moc.asset", f"{base}model.prefab", f"{base}model.2048/texture_00.png", f"{base}motions/daiji_idle_01.anim"]


class Live2dResolutionTests(unittest.TestCase):
    """The Live2D tier resolves one bundle per fairy or HOC, most of which have none at all."""

    def test_fairy_resolves_its_bundle_by_its_own_code(self):
        index = hoc_index({"live2dnew_fairy_fighting": fairy_live2d_files("fighting")})
        item = game_bundles.live2d_items(index, [{"id": 1, "code": "fighting", "name": "Warrior Fairy"}], [])[0]
        self.assertEqual(item["key"], "live2d:fairy:1")
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["bundles"], ["live2dnew_fairy_fighting"])
        self.assertEqual(item["kind"], "fairy")
        self.assertTrue(item["assets"]["motions"]["path"].endswith("/motions/"))

    def test_hoc_resolves_its_bundle_by_its_weapon_name_not_its_internal_code(self):
        """`BGM-71`'s internal `hocs.json` code is `TOW`, used for its Spine rig - its Live2D bundle is named after the weapon instead."""
        index = hoc_index({"live2dnew_squads_bgm-71": hoc_live2d_files("BGM-71")})
        item = game_bundles.live2d_items(index, [], [{"id": 1, "code": "TOW", "name": "BGM-71"}])[0]
        self.assertEqual(item["key"], "live2d:hoc:1")
        self.assertEqual(item["status"], "resolved")
        self.assertEqual(item["bundles"], ["live2dnew_squads_bgm-71"])
        self.assertEqual(item["kind"], "hoc")

    def test_fairy_with_no_live2d_bundle_produces_no_item(self):
        """Most fairies and HOCs ship no Live2D model at all, so a bundle absent from the index produces no item, not an unresolved one -
        an unresolved row here would be a false gap in the refresh's unresolved check."""
        items = game_bundles.live2d_items(hoc_index({}), [{"id": 2, "code": "air_attack", "name": "Airstrike Fairy"}], [])
        self.assertEqual(items, [])

    def test_bundle_with_roles_but_no_motions_is_partial(self):
        """A bundle with every model role but no `motions/` folder downgrades from resolved to partial, motions reported missing."""
        files = hoc_live2d_files("BGM-71")[:-1]  # drop the trailing motions file, keep the model files
        index = hoc_index({"live2dnew_squads_bgm-71": files})
        item = game_bundles.live2d_items(index, [], [{"id": 1, "code": "TOW", "name": "BGM-71"}])[0]
        self.assertEqual(item["status"], "partial")
        self.assertIn("motions", item["missing"])
        self.assertNotIn("motions", item["assets"])

    def test_bundle_with_only_motions_is_unresolved(self):
        """A bundle holding nothing but a `motions/` folder stays unresolved with empty bundles, same as any other tier's total miss."""
        index = hoc_index({"live2dnew_squads_bgm-71": ["Assets/Resources/DaBao/Live2DNew/Squads/BGM-71/motions/daiji_idle_01.anim"]})
        item = game_bundles.live2d_items(index, [], [{"id": 1, "code": "TOW", "name": "BGM-71"}])[0]
        self.assertEqual(item["status"], "unresolved")
        self.assertEqual(item["bundles"], [])
        self.assertNotIn("motions", item["assets"])


class Live2dTargetTests(unittest.TestCase):
    """`--only-missing` picks fairies and HOCs the committed manifest's `live2d` block does not list."""

    def test_new_targets_lists_only_ids_missing_from_the_live2d_manifest_block(self):
        manifest = {"dolls": {}, "equipment": [], "live2d": {"fairies": {"1": ["form1", "form2", "form3"]}, "hocs": {}}}
        fairies = [{"id": 1, "code": "fighting", "name": "Warrior Fairy"}, {"id": 3, "code": "armor", "name": "Armor Fairy"}]
        hocs = [{"id": 1, "code": "TOW", "name": "BGM-71"}]
        targets = game_bundles.new_targets([], [], manifest, hocs=hocs, fairies=fairies)
        self.assertEqual(targets["live2d"], {("fairy", 3), ("hoc", 1)})

    def test_select_new_items_narrows_a_story_sprite_to_its_unpublished_files(self):
        """A sprite kept for a new expression carries only the unpublished ones, and marks its hosted plain pose so it is not rewritten."""
        targets = {"story": {"story_sprite:falcon", "story_sprite:falcon_1", "story_sprite:k5"}}
        items = [
            {"key": "story_sprite:Falcon", "tier": "story_sprite", "prefab": "Falcon", "expressions": [1, 2]},
            {"key": "story_sprite:K5", "tier": "story_sprite", "prefab": "K5", "expressions": []},
            {"key": "story_sprite:New", "tier": "story_sprite", "prefab": "New", "expressions": [3]},
        ]
        selected = game_bundles.select_new_items(items, targets)
        self.assertEqual([(item["prefab"], item["expressions"], item.get("plainPublished", False)) for item in selected], [("Falcon", [2], True), ("New", [3], False)])
        self.assertEqual(items[0]["expressions"], [1, 2])

    def test_select_new_items_keeps_live2d_items_in_the_live2d_target_set(self):
        """A live2d item is kept only when its own `(kind, id)` pair is in `targets["live2d"]` - fairy 1's Live2D model is already listed
        in the manifest, so its item is dropped, while fairy 3's and HOC 1's are still targets and kept."""
        manifest = {"dolls": {}, "equipment": [], "live2d": {"fairies": {"1": ["form1", "form2", "form3"]}, "hocs": {}}}
        fairies = [{"id": 1, "code": "fighting", "name": "Warrior Fairy"}, {"id": 3, "code": "armor", "name": "Armor Fairy"}]
        hocs = [{"id": 1, "code": "TOW", "name": "BGM-71"}]
        targets = game_bundles.new_targets([], [], manifest, hocs=hocs, fairies=fairies)
        items = [
            {"key": "live2d:fairy:1", "tier": "live2d", "kind": "fairy", "id": 1},
            {"key": "live2d:fairy:3", "tier": "live2d", "kind": "fairy", "id": 3},
            {"key": "live2d:hoc:1", "tier": "live2d", "kind": "hoc", "id": 1},
        ]
        self.assertEqual(game_bundles.select_new_items(items, targets), items[1:])


def skin_live2d_index():
    """Build a one-bundle index holding a two-variant skin Live2D bundle.

    Returns:
        An index dict whose single bundle carries a normal and a destroy variant, the destroy one with two textures.
    """
    base = "assets/resources/dabao/live2dnew/gun/g36c_1202"
    paths = [
        f"{base}/normal/model_moc.asset",
        f"{base}/normal/model.prefab",
        f"{base}/normal/model.2048/texture_00.png",
        f"{base}/normal/motions/daiji_idle_01.fade.asset",
        f"{base}/normal/motions/daiji_idle_01.anim",
        f"{base}/destroy/model_moc.asset",
        f"{base}/destroy/model.prefab",
        f"{base}/destroy/model.2048/texture_00.png",
        f"{base}/destroy/model.2048/texture_01.png",
        f"{base}/destroy/motions/broken.fade.asset",
    ]
    return {"live2dnew_gun_g36c_1202": {"files": [(path, path) for path in paths], "sizeOriginal": 4096}}


def test_variant_assets_does_not_mix_a_duplicated_nested_model_folder():
    """A bundle can carry a stale duplicate of a whole model folder nested one level deeper (this happens for real: AK12Mod's `normal`
    variant has a full second copy under `Normal/model/`). Every resolved role must come from the same folder - here that has to be the
    shallower `normal/` folder, since only it has a `.prefab` directly inside it.

    File order matters here, and mirrors the real bundle: the nested duplicate's `moc` and `motions` entries are listed BEFORE the
    shallower folder's own `moc` and `motions` (same as ResData actually orders AK12Mod's files), while the shallower folder's `texture`
    and `prefab` are listed first. This is deliberate - a fixture where every top-level file simply comes first would pass under the old,
    order-dependent, per-role first-hit algorithm too, and would not actually guard this fix."""
    base = "assets/resources/dabao/live2dnew/gun/dup1234/normal"
    paths = [
        f"{base}/model.2048/texture_00.png",
        f"{base}/model.prefab",
        # A duplicated model folder nested one level deeper, with no prefab of its own - just moc, textures and motions. Its moc and
        # motions entries come before the shallower folder's own, the same way AK12Mod's real bundle orders them.
        f"{base}/model/model.2048/texture_00.png",
        f"{base}/model/model_moc.asset",
        f"{base}/model/motions/daiji_idle_01.anim",
        f"{base}/model_moc.asset",
        f"{base}/motions/daiji_idle_01.anim",
    ]
    bundle = {"files": [(path, path) for path in paths], "sizeOriginal": 1}
    found = game_bundles.variant_assets("live2dnew_gun_dup1234", bundle, "normal")
    # The whole point: every role sits in the same folder, none reach into the nested duplicate.
    assert found["moc"]["path"] == f"{base}/model_moc.asset"
    assert found["prefab"]["path"] == f"{base}/model.prefab"
    assert found["textures"]["path"] == f"{base}/"
    assert found["motions"]["path"] == f"{base}/motions/"


def test_variant_assets_records_the_model_folder_for_textures_when_it_ships_several_resolutions():
    """A model folder can ship both `model.1024/` and `model.2048/`, the real case being `live2d:skin:115:base:1103` (KP31_1103's
    normal model), whose prefab references `model.1024/`. This module cannot read the prefab, so it records no resolution guess, only
    the model folder, and `extract_live2d.py` picks the texture folder from the loaded bundle."""
    base = "assets/resources/dabao/live2dnew/gun/kp31_1103/normal"
    paths = [
        f"{base}/model.1024/texture_00.png",
        f"{base}/model.2048/texture_00.png",
        f"{base}/model.prefab",
        f"{base}/model_moc.asset",
        f"{base}/motions/daiji_idle_01.anim",
    ]
    bundle = {"files": [(path, path) for path in paths], "sizeOriginal": 1}
    found = game_bundles.variant_assets("live2dnew_gun_kp31_1103", bundle, "normal")
    assert found["textures"] == {"bundle": "live2dnew_gun_kp31_1103", "path": f"{base}/"}


def test_variant_model_root_is_deterministic_when_two_equal_depth_folders_both_qualify():
    """Two folders at the same depth that both hold a prefab and a moc sibling must resolve the same way every run, not by `set`
    iteration order (which `PYTHONHASHSEED` randomises per process). The lexically first path wins the tie."""
    scoped = [
        ("a/xk7q/model.prefab", "a/xk7q/model.prefab"),
        ("a/xk7q/model_moc.asset", "a/xk7q/model_moc.asset"),
        ("a/m2pz/model.prefab", "a/m2pz/model.prefab"),
        ("a/m2pz/model_moc.asset", "a/m2pz/model_moc.asset"),
    ]
    assert game_bundles.variant_model_root(scoped) == "a/m2pz/"


def test_skin_live2d_item_resolves_both_variants_separately():
    model = {"doll_id": 104, "form": "base", "skin_key": "1202", "bundle": "live2dnew_gun_g36c_1202"}
    item = game_bundles.skin_live2d_item(skin_live2d_index(), model)
    assert item["status"] == "resolved"
    assert item["kind"] == "skin"
    assert item["key"] == "live2d:skin:104:base:1202"
    # The whole point: the two variants must not collapse onto one another.
    assert item["assets"]["normal_moc"]["path"].endswith("/normal/model_moc.asset")
    assert item["assets"]["damaged_moc"]["path"].endswith("/destroy/model_moc.asset")
    assert item["assets"]["normal_textures"]["path"].endswith("/normal/")
    assert item["assets"]["damaged_motions"]["path"].endswith("/destroy/motions/")


def test_skin_live2d_item_is_partial_when_a_variant_is_missing():
    index = skin_live2d_index()
    files = [pair for pair in index["live2dnew_gun_g36c_1202"]["files"] if "/destroy/" not in pair[0]]
    index["live2dnew_gun_g36c_1202"]["files"] = files
    model = {"doll_id": 104, "form": "base", "skin_key": "1202", "bundle": "live2dnew_gun_g36c_1202"}
    item = game_bundles.skin_live2d_item(index, model)
    assert item["status"] == "partial"
    assert "damaged_moc" in item["missing"]
    assert item["assets"]["normal_moc"]["path"].endswith("/normal/model_moc.asset")


def test_skin_live2d_item_is_none_when_the_bundle_is_absent():
    model = {"doll_id": 104, "form": "base", "skin_key": "1202", "bundle": "live2dnew_gun_nope"}
    assert game_bundles.skin_live2d_item(skin_live2d_index(), model) is None


def live2d_resdata(fairy_bundle, fairy_code, hoc_bundle, hoc_code):
    """Build a minimal `resdata_no_hash.json`-shaped dict with one fairy and one HOC Live2D bundle.

    Args:
        fairy_bundle: The fairy's Live2D bundle name, such as `live2dnew_fairy_fighting`.
        fairy_code: The fairy's own code, passed to `fairy_live2d_files`.
        hoc_bundle: The HOC's Live2D bundle name, such as `live2dnew_squads_bgm-71`.
        hoc_code: The HOC's displayed weapon name, passed to `hoc_live2d_files`.

    Returns:
        A resdata dict `build_inventory` can read via `load_index`.
    """
    bundles = {fairy_bundle: fairy_live2d_files(fairy_code), hoc_bundle: hoc_live2d_files(hoc_code)}
    return {
        "resUrl": "https://cdn.example/",
        "BaseAssetBundles": [{"assetBundleName": name, "resname": name, "sizeOriginal": 1, "assetAllRes": [{"pathKey": path} for path in paths]} for name, paths in bundles.items()],
        "AddAssetBundles": [],
    }


class Live2dInventoryTests(unittest.TestCase):
    """`build_inventory` resolves the Live2D tier for every fairy and HOC, not just their art and rigs."""

    def test_build_inventory_includes_live2d_items_for_a_fairy_and_a_hoc(self):
        resdata = live2d_resdata("live2dnew_fairy_fighting", "fighting", "live2dnew_squads_bgm-71", "BGM-71")
        fairies = [{"id": 1, "code": "fighting", "name": "Warrior Fairy"}]
        hocs = [{"id": 1, "code": "TOW", "name": "BGM-71"}]
        inventory = game_bundles.build_inventory(resdata, [], [], {}, {}, {}, hocs=hocs, fairies=fairies)
        items = {item["key"]: item for item in inventory["items"]}
        self.assertIn("live2d:fairy:1", items)
        self.assertEqual(items["live2d:fairy:1"]["status"], "resolved")
        self.assertEqual(items["live2d:fairy:1"]["bundles"], ["live2dnew_fairy_fighting"])
        self.assertIn("live2d:hoc:1", items)
        self.assertEqual(items["live2d:hoc:1"]["status"], "resolved")
        self.assertEqual(items["live2d:hoc:1"]["bundles"], ["live2dnew_squads_bgm-71"])


def resdata_from_index(index):
    """Build a resdata dict from an index dict shaped like `skin_live2d_index` returns.

    Args:
        index: A bundle index dict of bundle name to `{"files": [(lowered, real)], "sizeOriginal"}`.

    Returns:
        A resdata dict `build_inventory` can read via `load_index`.
    """
    return {
        "resUrl": "https://cdn.example/",
        "BaseAssetBundles": [
            {
                "assetBundleName": name,
                "resname": name,
                "sizeOriginal": bundle["sizeOriginal"],
                "assetAllRes": [{"pathKey": path} for _lowered, path in bundle["files"]],
            }
            for name, bundle in index.items()
        ],
        "AddAssetBundles": [],
    }


def test_build_inventory_includes_skin_live2d_items():
    index = skin_live2d_index()
    resdata = resdata_from_index(index)
    rows = [{"code": "G36C_1202", "fit_gun": 104, "skin": 1202, "motions": "1"}]
    inventory = game_bundles.build_inventory(resdata, [], [], {}, {}, {}, live2d_rows=rows, doll_ids={104})
    keys = [item["key"] for item in inventory["items"] if item["tier"] == "live2d"]
    assert "live2d:skin:104:base:1202" in keys


def test_new_targets_lists_skin_live2d_absent_from_the_manifest():
    manifest = {"version": 3, "dolls": {}, "equipment": {}, "live2d": {"tdolls": {"104": {"base": {"1202": ["normal"]}}}}}
    models = [
        {"doll_id": 104, "form": "base", "skin_key": "1202", "bundle": "b"},
        {"doll_id": 104, "form": "mod", "skin_key": "1202", "bundle": "b"},
    ]
    targets = game_bundles.new_targets([], [], manifest, live2d_models=models)
    assert (104, "mod", "1202") in targets["skin"]
    assert (104, "base", "1202") not in targets["skin"]


def write_json(path, value):
    """Write one JSON file, creating its parent directory.

    Args:
        path: File path to write.
        value: The value to serialise.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(value, handle)


def test_inventory_from_paths_only_missing_threads_skin_live2d_models_into_new_targets():
    """`inventory_from_paths`'s `--only-missing` branch has to resolve the same skin Live2D models `build_inventory` resolves and pass
    them into `new_targets`, or `targets["skin"]` stays empty and `select_new_items` drops every skin item no matter what the manifest
    lists. This drives the real function end to end on a scratch tree, rather than unit-testing `new_targets` alone, since the bug was in
    the wiring between the two, not in either function by itself."""
    with tempfile.TemporaryDirectory() as scratch:
        gf_data = os.path.join(scratch, "gf-data")
        write_json(os.path.join(gf_data, "stc", "gun.json"), [])
        write_json(os.path.join(gf_data, "stc", "battle_skill_config.json"), [])
        write_json(os.path.join(gf_data, "stc", "equip.json"), [])
        write_json(os.path.join(gf_data, "stc", "live2d.json"), [{"code": "G36C_1202", "fit_gun": 104, "skin": 1202, "motions": "1"}])

        site = os.path.join(scratch, "site")
        write_json(os.path.join(site, "dolls-1-200.json"), [site_doll(104)])
        write_json(os.path.join(site, "equipment.json"), {"items": {}})

        resdata_path = os.path.join(scratch, "resdata_no_hash.json")
        write_json(resdata_path, resdata_from_index(skin_live2d_index()))

        manifest_path = os.path.join(scratch, "manifest.json")
        write_json(manifest_path, {"dolls": {}, "equipment": {}})
        inventory = game_bundles.inventory_from_paths(resdata_path, gf_data, site, manifest_path)
        keys = [item["key"] for item in inventory["items"] if item["tier"] == "live2d"]
        assert "live2d:skin:104:base:1202" in keys

        write_json(manifest_path, {"dolls": {}, "equipment": {}, "live2d": {"tdolls": {"104": {"base": {"1202": ["normal", "damaged"]}}}}})
        inventory = game_bundles.inventory_from_paths(resdata_path, gf_data, site, manifest_path)
        keys = [item["key"] for item in inventory["items"] if item["tier"] == "live2d"]
        assert "live2d:skin:104:base:1202" not in keys


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# Download


class FakeFetcher:
    """Record fetches and write bytes, optionally failing or writing the wrong size first."""

    def __init__(self, sizes, failures=None, short_writes=None):
        """Set up the fake.

        Args:
            sizes: Map of URL to the number of bytes to write.
            failures: Map of URL to how many leading calls raise before a success.
            short_writes: Map of URL to how many leading calls write one byte too few.
        """
        self.sizes = sizes
        self.failures = dict(failures or {})
        self.short_writes = dict(short_writes or {})
        self.calls = []

    def __call__(self, url, dest):
        """Pretend to download `url` into `dest`.

        Args:
            url: The requested URL.
            dest: The file path to write.

        Raises:
            OSError: While the URL still has failures queued.
        """
        self.calls.append(url)
        if self.failures.get(url, 0) > 0:
            self.failures[url] -= 1
            raise OSError("simulated network error")
        size = self.sizes[url]
        if self.short_writes.get(url, 0) > 0:
            self.short_writes[url] -= 1
            size -= 1
        with open(dest, "wb") as handle:
            handle.write(b"x" * size)


def bundle_names(cache):
    """List the cached bundle files, leaving out the cache index sidecar.

    Args:
        cache: The bundle cache directory.

    Returns:
        Sorted `.ab` file names.
    """
    return sorted(name for name in os.listdir(cache) if name.endswith(".ab"))


class DownloadTests(unittest.TestCase):
    """Cache skipping, retries and verification with an injected fetcher."""

    def setUp(self):
        """Create a scratch cache directory and a two-bundle plan."""
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = self.tmp.name
        self.bundles = {"character_a": {"resname": "resA", "sizeOriginal": 10}, "character_b": {"resname": "resB", "sizeOriginal": 20}}
        self.urls = {"http://cdn/resA.ab": 10, "http://cdn/resB.ab": 20}
        self.sleeps = []

    def tearDown(self):
        """Remove the scratch cache."""
        self.tmp.cleanup()

    def run_download(self, fetcher):
        """Run the downloader against the scratch cache.

        Args:
            fetcher: The injected fetch callable.

        Returns:
            The result dict from `game_bundles.download_bundles`.
        """
        return game_bundles.download_bundles(self.bundles, "http://cdn/", self.cache, fetch=fetcher, sleep=self.sleeps.append, log=lambda _msg: None)

    def write_cached(self, name, size):
        """Put a fake cached bundle in place.

        Args:
            name: Bundle name.
            size: Byte count to write.
        """
        with open(os.path.join(self.cache, f"{name}.ab"), "wb") as handle:
            handle.write(b"y" * size)

    def test_downloads_missing_bundles_to_named_files(self):
        """Missing bundles are fetched from `resUrl + resname + .ab` into `<name>.ab`."""
        fetcher = FakeFetcher(self.urls)
        result = self.run_download(fetcher)
        self.assertEqual(sorted(fetcher.calls), ["http://cdn/resA.ab", "http://cdn/resB.ab"])
        self.assertEqual(sorted(result["downloaded"]), ["character_a", "character_b"])
        self.assertEqual(result["bytes"], 30)
        self.assertEqual(os.path.getsize(os.path.join(self.cache, "character_b.ab")), 20)
        self.assertFalse([f for f in os.listdir(self.cache) if f.endswith(".part")])

    def test_skips_bundle_cached_under_the_same_resname(self):
        """A bundle recorded under its current resname at the right size is not fetched again, a wrong-sized one is."""
        self.run_download(FakeFetcher(self.urls))
        self.write_cached("character_b", 5)
        fetcher = FakeFetcher(self.urls)
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls, ["http://cdn/resB.ab"])
        self.assertEqual(result["skipped"], ["character_a"])
        self.assertEqual(result["downloaded"], ["character_b"])
        self.assertEqual(os.path.getsize(os.path.join(self.cache, "character_b.ab")), 20)

    def test_a_new_resname_of_the_same_size_is_downloaded_again(self):
        """An updated bundle keeps its name and can keep its size, so a changed resname alone forces a fresh download."""
        self.run_download(FakeFetcher(self.urls))
        self.bundles["character_a"] = {"resname": "resA2", "sizeOriginal": 10}
        fetcher = FakeFetcher({"http://cdn/resA2.ab": 10})
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls, ["http://cdn/resA2.ab"])
        self.assertEqual(game_bundles.read_cache_index(self.cache)["character_a"], {"resname": "resA2", "size": 10})

    def test_unrecorded_bundle_is_adopted_only_when_its_sha1_matches(self):
        """A bundle cached before the index existed is adopted without a download when its hash matches ResData, and fetched otherwise."""
        self.write_cached("character_a", 10)
        self.write_cached("character_b", 20)
        self.bundles["character_a"]["sha1"] = hashlib.sha1(b"y" * 10).hexdigest()
        self.bundles["character_b"]["sha1"] = hashlib.sha1(b"x" * 20).hexdigest()
        fetcher = FakeFetcher(self.urls)
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls, ["http://cdn/resB.ab"])
        self.assertEqual((result["skipped"], result["migrated"], result["downloaded"]), (["character_a"], ["character_a"], ["character_b"]))
        index = game_bundles.read_cache_index(self.cache)
        self.assertEqual(index["character_a"], {"resname": "resA", "size": 10, "sha1": self.bundles["character_a"]["sha1"]})
        fetcher = FakeFetcher(self.urls)
        self.assertEqual((self.run_download(fetcher)["downloaded"], fetcher.calls), ([], []))

    def test_unrecorded_bundle_without_a_hash_is_downloaded(self):
        """With no `fileHash` to prove an unrecorded file, size alone is not trusted."""
        self.write_cached("character_a", 10)
        fetcher = FakeFetcher(self.urls)
        self.run_download(fetcher)
        self.assertIn("http://cdn/resA.ab", fetcher.calls)

    def test_download_with_the_wrong_sha1_counts_as_a_failed_attempt(self):
        """A download whose bytes do not hash to ResData's `fileHash` is never cached."""
        self.bundles["character_a"]["sha1"] = "0" * 40
        result = self.run_download(FakeFetcher(self.urls))
        self.assertEqual([entry["name"] for entry in result["failed"]], ["character_a"])
        self.assertNotIn("character_a", game_bundles.read_cache_index(self.cache))

    def test_retries_with_exponential_backoff(self):
        """Transient failures are retried with doubling sleeps."""
        fetcher = FakeFetcher(self.urls, failures={"http://cdn/resA.ab": 2})
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls.count("http://cdn/resA.ab"), 3)
        self.assertEqual(result["failed"], [])
        self.assertEqual(self.sleeps, [game_bundles.BACKOFF_SECONDS, game_bundles.BACKOFF_SECONDS * 2])

    def test_gives_up_after_three_attempts(self):
        """A bundle failing every attempt is reported and leaves no file behind."""
        fetcher = FakeFetcher(self.urls, failures={"http://cdn/resA.ab": 5})
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls.count("http://cdn/resA.ab"), game_bundles.ATTEMPTS)
        self.assertEqual([entry["name"] for entry in result["failed"]], ["character_a"])
        self.assertEqual(bundle_names(self.cache), ["character_b.ab"])

    def test_size_mismatch_counts_as_a_failed_attempt(self):
        """A short download is retried rather than cached."""
        fetcher = FakeFetcher(self.urls, short_writes={"http://cdn/resB.ab": 1})
        result = self.run_download(fetcher)
        self.assertEqual(fetcher.calls.count("http://cdn/resB.ab"), 2)
        self.assertEqual(result["failed"], [])
        self.assertEqual(os.path.getsize(os.path.join(self.cache, "character_b.ab")), 20)

    def test_verify_cache(self):
        """Verification lists bundles that are missing, the wrong size, or recorded under another resname."""
        self.run_download(FakeFetcher({"http://cdn/resA.ab": 10}, failures={"http://cdn/resB.ab": 5}))
        self.assertEqual(game_bundles.verify_cache(self.bundles, self.cache), [{"name": "character_b", "check": "size", "expected": 20, "actual": None}])
        self.write_cached("character_b", 19)
        self.assertEqual(game_bundles.verify_cache(self.bundles, self.cache), [{"name": "character_b", "check": "size", "expected": 20, "actual": 19}])
        self.write_cached("character_b", 20)
        self.assertEqual(game_bundles.verify_cache(self.bundles, self.cache), [{"name": "character_b", "check": "resname", "expected": "resB", "actual": None}])


# //////////////////////////////////////////////////////////////////////////////////////////////////
# //////////////////////////////////////////////////////////////////////////////////////////////////
# New targets


def site_doll(doll_id, mod=False, skin_ids=None):
    """Build a minimal site doll record.

    Args:
        doll_id: The doll id.
        mod: Whether the doll has a Mod.
        skin_ids: Skin ids, or None for no skins.

    Returns:
        A doll dict shaped like the site shards.
    """
    return {"normal": {"id": doll_id}, "mod": {"id": doll_id} if mod else None, "skins": {"skin_ids": skin_ids} if skin_ids else None}


class NewTargetTests(unittest.TestCase):
    """Selecting only the dolls, Mods, skins and equipment the committed manifest does not list."""

    def setUp(self):
        self.manifest = {
            "equipment": [1, 2],
            "dolls": {
                "65": {"normal": {"images": ["card"]}, "mod": {"images": ["card"]}, "skins": {"805": {"images": ["card"]}}, "skills": ["skill1", "skill2"]},
                "95": {"normal": {"images": ["card"]}, "skins": {"1809": {"images": ["card"]}}, "skills": ["skill1"]},
                "100": {"normal": {"images": ["card"]}, "skills": ["skill1"]},
            },
        }
        dolls = [site_doll(65, mod=True, skin_ids=[805, 9001]), site_doll(95, skin_ids=[1809, "legacy-x", None]), site_doll(100, mod=True), site_doll(424)]
        self.targets = game_bundles.new_targets(dolls, [1, 2, 3], self.manifest)

    def test_targets(self):
        """A missing doll, a missing Mod, a missing numeric skin and a missing equipment id are the targets."""
        self.assertEqual(
            self.targets,
            {
                "units": set(),
                "story": set(),
                "dolls": {424},
                "mods": {100},
                "skins": {(65, 9001)},
                "equipment": {3},
                "hocs": set(),
                "fairies": set(),
                "enemies": set(),
                "factions_hosted": False,
                "live2d": set(),
                "skin": set(),
            },
        )

    def test_selects_forms_of_new_targets(self):
        """Art and rigs follow their form, and hosted forms, known gaps and legacy items are never selected."""
        items = [
            {"key": "art:424", "tier": "art", "doll_id": 424},
            {"key": "spine:424", "tier": "spine", "doll_id": 424},
            {"key": "art:65", "tier": "art", "doll_id": 65},
            {"key": "mod_art:100", "tier": "mod_art", "doll_id": 100},
            {"key": "mod_spine:100", "tier": "mod_spine", "doll_id": 100},
            {"key": "skin_art:65:9001", "tier": "skin_art", "doll_id": 65, "skin_id": 9001},
            {"key": "skin_spine:95:1809", "tier": "skin_spine", "doll_id": 95, "skin_id": 1809},
            {"key": "equip_icon:3", "tier": "equip_icon", "equip_id": 3},
            {"key": "equip_icon:1", "tier": "equip_icon", "equip_id": 1},
            {"key": "enemy_art:2001", "tier": "enemy_art", "enemy_id": 2001},
            {"key": "skill_icon:doll:1005:skill1", "tier": "skill_icon", "source": "legacy", "users": [[424, "skill1"]]},
        ]
        keys = [item["key"] for item in game_bundles.select_new_items(items, self.targets)]
        self.assertEqual(keys, ["art:424", "spine:424", "mod_art:100", "mod_spine:100", "skin_art:65:9001", "equip_icon:3"])

    def test_skill_icons_keep_only_new_slots(self):
        """A shared skill icon keeps only the slots of new dolls and new Mods, so hosted icons are never rewritten."""
        items = [
            {"key": "skill_icon:ar", "tier": "skill_icon", "users": [[65, "skill1"], [424, "skill1"], [100, "skill2"], [100, "skill1"]]},
            {"key": "skill_icon:mg4", "tier": "skill_icon", "users": [[95, "skill1"]]},
        ]
        selected = game_bundles.select_new_items(items, self.targets)
        self.assertEqual(selected, [{"key": "skill_icon:ar", "tier": "skill_icon", "users": [[424, "skill1"], [100, "skill2"]]}])
        self.assertEqual(items[0]["users"], [[65, "skill1"], [424, "skill1"], [100, "skill2"], [100, "skill1"]])

    def test_only_missing_problems(self):
        """Unexpected unresolved items and partial items stop an only-missing run, expected gaps do not."""
        summary = {
            "unresolved_expected": [{"key": "skill_icon:mg4"}],
            "unresolved_unexpected": [{"key": "art:424", "reason": "no bundle holds the files"}],
            "partial": [{"key": "skin_art:65:9001", "missing": ["card"]}],
        }
        problems = game_bundles.only_missing_problems({"summary": summary})
        self.assertEqual(problems, ["art:424 is unresolved: no bundle holds the files", "skin_art:65:9001 is missing card"])

    def test_expected_missing_rig_is_not_a_problem(self):
        """A skin rig the game does not ship is an expected gap, so it never stops an only-missing run."""
        item = {"key": "skin_spine:95:1809", "tier": "skin_spine", "doll_id": 95, "skin_id": 1809, "status": "unresolved", "bundles": []}
        summary, _bundles = game_bundles.summarise([item], {}, include_ui=False)
        self.assertEqual([entry["key"] for entry in summary["unresolved_expected"]], ["skin_spine:95:1809"])
        self.assertEqual(summary["unresolved_unexpected"], [])
        self.assertEqual(game_bundles.only_missing_problems({"summary": summary}), [])

    def test_ui_bundle_only_with_equipment(self):
        """The equipment UI bundle is left out when asked, and kept by default."""
        index = {"atlasclips_listequipment": {"resname": "x", "sizeOriginal": 5}}
        _summary, bundles = game_bundles.summarise([], index, include_ui=False)
        self.assertEqual(bundles, {})
        _summary, bundles = game_bundles.summarise([], index)
        self.assertEqual(list(bundles), ["atlasclips_listequipment"])

    def test_fixture_inventory_with_manifest(self):
        """With a manifest listing nothing, the fixture inventory is flagged and keeps its items, and a manifest listing everything empties it."""
        with tempfile.TemporaryDirectory() as scratch:
            empty = os.path.join(scratch, "empty.json")
            with open(empty, "w", encoding="utf-8") as handle:
                json.dump({"equipment": [], "dolls": {}}, handle)
            inventory = game_bundles.inventory_from_paths(os.path.join(FIXTURES, "resdata_no_hash.json"), GF_DATA, SITE_DATA, empty)
            self.assertTrue(inventory["onlyMissing"])
            self.assertTrue(any(item["tier"] == "art" for item in inventory["items"]))

            dolls, equipment_ids, _hocs, _fairies, _enemies, _units = game_bundles.load_site(SITE_DATA)
            full = {"equipment": equipment_ids, "dolls": {}}
            for doll in dolls:
                skins = {str(skin_id): {"images": ["card"]} for skin_id in ((doll.get("skins") or {}).get("skin_ids") or []) if isinstance(skin_id, int)}
                full["dolls"][str(doll["normal"]["id"])] = {"normal": {"images": ["card"]}, "mod": {"images": ["card"]}, "skins": skins, "skills": []}
            listed = os.path.join(scratch, "full.json")
            with open(listed, "w", encoding="utf-8") as handle:
                json.dump(full, handle)
            inventory = game_bundles.inventory_from_paths(os.path.join(FIXTURES, "resdata_no_hash.json"), GF_DATA, SITE_DATA, listed)
            self.assertEqual(inventory["items"], [])
            self.assertEqual(inventory["bundles"], {})


    def test_committed_data_has_no_new_targets(self):
        """The committed site data and manifest agree on dolls, equipment, HOCs and fairies: every one already has a published art asset, so
        there are no pending targets left. Enemies are the exception until their art is published. Fairies and HOCs with published Live2D models are excluded from targets; any unpublished ones are
        still targets. `live2d_models` is left at its default here: unlike fairies and HOCs, which this repo enumerates in committed site
        data, the full set of T-Doll skin Live2D models only exists in the external `stc/live2d.json` table (fetched into the gitignored
        gf-data-us checkout, not committed), so there is no committed source to check the real manifest's `skin` targets against here. The
        wiring that resolves and threads real skin models through `new_targets` is covered end to end instead, on a scratch tree, by
        `test_inventory_from_paths_only_missing_threads_skin_live2d_models_into_new_targets`."""
        dolls, equipment_ids, hocs, fairies, enemies, units = game_bundles.load_site(game_bundles.SITE_DATA_DIR)
        manifest = game_bundles.read_json(game_bundles.MANIFEST_PATH)
        targets = game_bundles.new_targets(dolls, equipment_ids, manifest, hocs=hocs, fairies=fairies, enemies=enemies, units=units)
        published_live2d = manifest.get("live2d", {})
        published_fairy_ids = set(int(fid) for fid in published_live2d.get("fairies", {}))
        published_hoc_ids = set(int(hid) for hid in published_live2d.get("hocs", {}))
        expected_live2d = {("fairy", fairy["id"]) for fairy in fairies if fairy["id"] not in published_fairy_ids} | {("hoc", hoc["id"]) for hoc in hocs if hoc["id"] not in published_hoc_ids}
        # Enemies are targets until their art is published, the same way an unpublished Live2D model is. This set empties itself once the
        # manifest grows an `enemies` block.
        published_enemy_ids = set(int(eid) for eid in manifest.get("enemies", {}))
        expected_enemies = {enemy["id"] for enemy in enemies if enemy["id"] not in published_enemy_ids}
        # Captured units are targets until their skill icons are published, and this set empties itself once the manifest grows an
        # `assimilation` block, the same way the enemy one above does.
        published_unit_ids = set(int(uid) for uid in manifest.get("assimilation", {}))
        expected_units = {unit_id for unit_id in units if unit_id not in published_unit_ids}
        self.assertEqual(
            targets,
            {
                "story": set(),
                "dolls": set(),
                "mods": set(),
                "skins": set(),
                "equipment": set(),
                "hocs": set(),
                "fairies": set(),
                "enemies": expected_enemies,
                "units": expected_units,
                # True once the emblems are published, which is a fixed set rather than a per-id one.
                "factions_hosted": len(manifest.get("factions", [])) > 0,
                "live2d": expected_live2d,
                "skin": set(),
            },
        )


def unity_object(kind, path_id, tree):
    """Build a fake UnityPy object reader exposing a type tree.

    Args:
        kind: Unity type name such as `MonoBehaviour`.
        path_id: The object's path ID.
        tree: The dict `read_typetree` returns.

    Returns:
        A namespace shaped like an object reader.
    """
    return SimpleNamespace(type=SimpleNamespace(name=kind), path_id=path_id, read_typetree=lambda: tree, assets_file="prefab-file")


def avg_bundle(dependencies, prefabs):
    """Build a fake `avgpicprefabs` bundle.

    Args:
        dependencies: The bundle's `m_Dependencies`.
        prefabs: Map of prefab name to the `(file ID, path ID)` its first `pic` entry holds.

    Returns:
        A namespace shaped like a UnityPy environment.
    """
    objects = [unity_object("AssetBundle", 1, {"m_Dependencies": dependencies})]
    for number, (name, pic) in enumerate(prefabs.items()):
        owner = 100 + number
        objects.append(unity_object("GameObject", owner, {"m_Name": name}))
        tree = {"m_GameObject": {"m_FileID": 0, "m_PathID": owner}, "pic": [{"m_FileID": pic[0], "m_PathID": pic[1]}], "picAlpha": [{"m_FileID": 0, "m_PathID": 900 + number}]}
        objects.append(unity_object("MonoBehaviour", 200 + number, tree))
    return SimpleNamespace(objects=objects)


class StoryDependencyTests(unittest.TestCase):
    """A story prefab whose art sits in another bundle pulls that bundle's dependencies into the download."""

    def test_picture_refs_are_keyed_by_the_owning_prefab(self):
        """Each prefab maps to its own `pic` and `picAlpha` references and the file they are relative to."""
        env = avg_bundle(["resource_fairy"], {"DJMAXSUEE": (1, 55), "Local": (0, 66)})
        refs = game_bundles.story_picture_refs(env)
        self.assertEqual(refs["djmaxsuee"], {"pic": [(1, 55)], "alpha": [(0, 900)], "file": "prefab-file"})
        self.assertEqual(refs["local"]["pic"], [(0, 66)])

    def test_only_bundles_drawing_art_from_outside_add_their_known_dependencies(self):
        """External art adds the dependencies ResData ships. Local art, listed sources and unreadable bundles add none."""
        envs = {"avg_a.ab": avg_bundle(["resource_fairy", "gone"], {"Outside": (1, 55)}), "avg_b.ab": avg_bundle(["character_x"], {"Inside": (0, 66)})}

        def loader(path):
            """Open a fake bundle, failing for unknown names.

            Args:
                path: The `.ab` path.

            Returns:
                The fake environment.
            """
            return envs[os.path.basename(path)]

        items = [
            {"tier": "story_sprite", "status": "resolved", "prefab": "Outside", "bundles": ["avg_a"]},
            {"tier": "story_sprite", "status": "resolved", "prefab": "Inside", "bundles": ["avg_b"]},
            {"tier": "story_sprite", "status": "resolved", "prefab": "Listed", "texture": "pic_Listed", "bundles": ["character_y"]},
            {"tier": "story_sprite", "status": "resolved", "prefab": "Broken", "bundles": ["avg_c"]},
        ]
        needs, failures = game_bundles.story_dependency_needs(items, {"resource_fairy": {}, "character_x": {}}, "", loader=loader)
        self.assertEqual(game_bundles.resolve_story_dependencies(needs, {}), {"resource_fairy"})
        self.assertEqual([row["name"] for row in failures], ["avg_c"])

    def test_needs_cover_the_plain_pose_and_wanted_expressions_only(self):
        """Only slot 0 and the expressions a script asks for name a CAB, and a kept plain pose drops slot 0."""
        env = avg_bundle(["character_x", "character_y"], {"Many": (1, 55)})
        tree = next(obj.read_typetree() for obj in env.objects if obj.type.name == "MonoBehaviour")
        tree["pic"] = [{"m_FileID": 1, "m_PathID": 1}, {"m_FileID": 2, "m_PathID": 2}, {"m_FileID": 2, "m_PathID": 3}]
        env.objects[-1].assets_file = SimpleNamespace(externals=[SimpleNamespace(path="archive:/CAB-aa/CAB-aa"), SimpleNamespace(path="archive:/CAB-bb/CAB-bb")])
        index = {"character_x": {}, "character_y": {}}
        cases = [({}, {"cab-aa"}), ({"expressions": [2]}, {"cab-aa", "cab-bb"}), ({"expressions": [2], "plainPublished": True}, {"cab-bb"})]
        for extra, wanted in cases:
            with self.subTest(extra=extra):
                item = {"tier": "story_sprite", "status": "resolved", "prefab": "Many", "bundles": ["avg_a"], **extra}
                needs, _failures = game_bundles.story_dependency_needs([item], index, "", loader=lambda _path: env)
                self.assertEqual(needs, [{"cabs": wanted, "dependencies": ["character_x", "character_y"]}])

    def test_mapped_cabs_fetch_one_bundle_and_unknown_ones_skip_known_bundles(self):
        """A CAB the map knows fetches its bundle alone. An unknown CAB fetches only the dependencies the map has not seen."""
        needs = [{"cabs": {"cab-aa"}, "dependencies": ["character_x", "character_y"]}, {"cabs": {"cab-new"}, "dependencies": ["character_x", "character_y", "character_z"]}]
        cabs = {"character_x": "cab-aa", "character_y": "cab-bb"}
        self.assertEqual(game_bundles.resolve_story_dependencies(needs, cabs), {"character_x", "character_z"})
        # With no map at all, every dependency is fetched, as before the map existed.
        self.assertEqual(game_bundles.resolve_story_dependencies(needs, {}), {"character_x", "character_y", "character_z"})

    def test_fetching_settles_after_learning_an_unknown_cab(self):
        """An unknown CAB first fetches the unmapped dependencies, then learning them maps it, and nothing is fetched twice."""
        needs = [{"cabs": {"cab-new"}, "dependencies": ["character_x", "character_y", "character_z"]}]
        cabs = {"character_x": "cab-aa"}
        held = {"character_y": "cab-new", "character_z": "cab-zz"}
        calls = []

        def download(pending):
            """Pretend to download, recording each pass.

            Args:
                pending: The bundles to fetch.

            Returns:
                A `download_bundles` shaped result.
            """
            calls.append(sorted(pending))
            return {"downloaded": sorted(pending), "skipped": [], "migrated": [], "failed": [], "bytes": 0}

        def loader(path):
            """Open a fake dependency holding its CAB.

            Args:
                path: The `.ab` path.

            Returns:
                A namespace shaped like a UnityPy environment.
            """
            name = os.path.basename(path)[: -len(".ab")]
            return SimpleNamespace(files={name: SimpleNamespace(files={held[name].upper(): object()})})

        with tempfile.TemporaryDirectory() as cache:
            for name in held:
                open(os.path.join(cache, f"{name}.ab"), "wb").close()
            result = {"downloaded": [], "skipped": [], "migrated": [], "failed": [], "bytes": 0}
            fetched = game_bundles.fetch_story_dependencies(needs, cabs, {}, {name: {} for name in held}, cache, download, result, loader=loader)
        self.assertEqual(calls, [["character_y", "character_z"]])
        self.assertEqual(fetched, {"character_y", "character_z"})
        self.assertEqual(cabs, {"character_x": "cab-aa", "character_y": "cab-new", "character_z": "cab-zz"})

    def test_learning_records_each_cached_bundles_cab(self):
        """Cached bundles teach the map their serialized file, skipping `.resS` payloads, overwriting a stale entry."""
        bundle = SimpleNamespace(files={"CAB-cc": object(), "CAB-cc.resS": object()})
        env = SimpleNamespace(files={"character_x": bundle})
        with tempfile.TemporaryDirectory() as cache:
            open(os.path.join(cache, "character_x.ab"), "wb").close()
            cabs = {"character_x": "cab-stale", "character_y": "cab-bb"}
            game_bundles.learn_story_cabs(cabs, ["character_x", "character_gone"], cache, loader=lambda _path: env)
            self.assertEqual(cabs, {"character_x": "cab-cc", "character_y": "cab-bb"})


if __name__ == "__main__":
    unittest.main()
