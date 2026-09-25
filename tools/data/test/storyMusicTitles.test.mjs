import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMusicTitles, parseAudioTemplate, parseOstTable, storyTracks } from "../../story/music_titles.mjs";

// The rows here are invented. They copy the layout of IOPWiki's soundtrack tables, not their content.

/**
 * A soundtrack table in the page's layout, one row per entry.
 *
 * @param {string[]} rows Each row's text after its leading pipe, such as "Anthem\u00b9 || BGM_A || Menus || [[File:BGM_A.ogg]]".
 * @returns {string} The wikitext.
 */
function table(rows) {
	return ['{| class="gf-table"', "|-", "! Track name !! File name (ID if different) !! Heard in !! Player", ...rows.flatMap((row) => ["|-", `| ${row}`]), "|}"].join("\n");
}

test("a row's official CD title wins over its other names, and the marks go", () => {
	const ost = parseOstTable(table(["Anthem\u00b9, Lobby\u00b3 || BGM_A || Menus || [[File:BGM_A.ogg]]", "Danger\u00b3 || BGM_Danger || Story scenes || [[File:BGM_Danger.ogg]]"]), 1);
	assert.equal(ost.get("bgm_a"), "Anthem");
	assert.equal(ost.get("bgm_danger"), "Danger");
});

test("a row with no official title takes its first name", () => {
	const ost = parseOstTable(table(["Calm\u00b2, Quiet Night\u00b3 || BGM_C || Story scenes || [[File:BGM_C.ogg]]"]), 1);
	assert.equal(ost.get("bgm_c"), "Calm");
});

test("a title with a comma of its own stays whole", () => {
	const ost = parseOstTable(table(["Rain, Again\u00b3 || BGM_R || Story scenes || [[File:BGM_R.ogg]]"]), 1);
	assert.equal(ost.get("bgm_r"), "Rain, Again");
});

test("wiki links and web links keep only their text", () => {
	const ost = parseOstTable(
		table(["[[Some Event|Event Theme]]\u00b3 || BGM_E || Events || [[File:BGM_E.ogg]]", "[https://example.com/watch?v=1&a=2 Polaris]\u00b2\u00b3 || m_end || Ending || [[File:m_end.ogg]]"]),
		1
	);
	assert.equal(ost.get("bgm_e"), "Event Theme");
	assert.equal(ost.get("m_end"), "Polaris");
});

test("an ID in the file cell's parentheses is a key too, and an empty file cell gives none", () => {
	const ost = parseOstTable(table(["Tide\u00b9 || GF_TIDE (10213) || Events || [[File:GF_TIDE.ogg]]", "Funeral\u00b3 ||  || Story scenes || [[File:.ogg]]"]), 1);
	assert.equal(ost.get("gf_tide"), "Tide");
	assert.equal(ost.get("10213"), "Tide");
	assert.equal(ost.has(""), false);
	assert.equal(ost.size, 2);
});

test("a row whose player cell runs onto a second line still reads", () => {
	const ost = parseOstTable(table(["Polaris\u00b3 || m_end || Ending\n| [[File:m_end.ogg]]"]), 1);
	assert.equal(ost.get("m_end"), "Polaris");
});

test("a CD tracklist table on the same page is not read as a track table", () => {
	const cdTable = ['{| class="wikitable"', "|-", "! # !! Title", "|-", "| 16 || The War has Begun", "|}"].join("\n");
	const ost = parseOstTable(`${cdTable}\n${table(["Anthem\u00b9 || BGM_A || Menus || [[File:BGM_A.ogg]]"])}`, 1);
	assert.equal(ost.has("the"), false);
	assert.equal(ost.has("16"), false);
	assert.equal(ost.get("bgm_a"), "Anthem");
});

test("a page without the track tables, or with too few rows, fails rather than yielding no titles", () => {
	assert.throws(() => parseOstTable("no tables here"), /track table/);
	assert.throws(() => parseOstTable(table(["Anthem\u00b9 || BGM_A || Menus || [[File:BGM_A.ogg]]"])), /rows/);
});

test("the audio table maps each music ID to its file and skips other kinds", () => {
	const template = parseAudioTemplate("AudioBGM|10213|GF_TIDE|BGM\nAudioBT|BT_x|y|Battle\r\nAudioBGM|BGM_A|BGM_A|BGM\n");
	assert.equal(template.get("10213"), "GF_TIDE");
	assert.equal(template.get("BGM_A"), "BGM_A");
	assert.equal(template.size, 2);
});

test("every reference gets a title through its own name or its file, silences get none, and the rest are missing", () => {
	const ost = parseOstTable(table(["Anthem\u00b9 || BGM_A || Menus || x", "Tide\u00b9 || GF_TIDE || Events || x"]), 1);
	const template = new Map([["10213", "GF_TIDE"]]);
	const { titles, missing } = buildMusicTitles(["BGM_A", "10213", "BGM_Empty", "BGM_PAUSE", "Room", "BGM_Unknown", "BGM_A"], ost, template, { Room: "Room" });
	assert.deepEqual(titles, { 10213: "Tide", BGM_A: "Anthem", Room: "Room" });
	assert.deepEqual(missing, ["BGM_Unknown"]);
});

test("a hand-kept title wins over the page's", () => {
	const ost = parseOstTable(table(["Anthem\u00b9 || BGM_A || Menus || x"]), 1);
	assert.equal(buildMusicTitles(["BGM_A"], ost, new Map(), { BGM_A: "Own" }).titles.BGM_A, "Own");
});

test("the story's tracks are every scene's music references, once each, sorted", () => {
	const scenes = new Map([
		[
			"a",
			{
				beats: [
					{
						ops: [
							{ type: "bgm", value: "BGM_B" },
							{ type: "sfx", value: "Alarm" }
						]
					},
					{ ops: [{ type: "bgm", value: "" }] }
				]
			}
		],
		["b", { beats: [{ ops: [{ type: "bgm", value: "10213" }] }, { ops: [{ type: "bgm", value: "BGM_B" }] }] }]
	]);
	assert.deepEqual(storyTracks(scenes), ["10213", "BGM_B"]);
});
