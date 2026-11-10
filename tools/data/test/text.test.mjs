import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanName, parseTextTable, stripMarkup, unescapeText } from "../lib/text.mjs";

test("parses CRLF lines, splits on the first comma and strips leading BOMs", () => {
	const table = parseTextTable("\uFEFF\uFEFFgun-10000065,416\r\nbattle_skill_config-310211201,Cooldown: 20s//cDamage Multiplier: 6x\r\n\r\n");
	assert.equal(table.get("gun-10000065"), "416");
	assert.equal(table.get("battle_skill_config-310211201"), "Cooldown: 20s//cDamage Multiplier: 6x");
	assert.equal(table.size, 2);
});

test("unescapes //c and //n", () => {
	assert.equal(unescapeText("NIXOO//cAi Nonaka//nline"), "NIXOO, Ai Nonaka\nline");
});

test("spaces a comma glued to the next word and a comma right after a full stop", () => {
	assert.equal(unescapeText("armor//cMaximum of 300 points"), "armor, Maximum of 300 points");
	assert.equal(unescapeText("reduced by 30 points.//c30% chance"), "reduced by 30 points. 30% chance");
	assert.equal(unescapeText("deals 1//c000 damage"), "deals 1,000 damage");
});

test("strips color markup but keeps its text", () => {
	assert.equal(stripMarkup("deals <color=#FFA500>6x</color> damage"), "deals 6x damage");
});

test("turns a stray // typo into a comma after unescaping", () => {
	assert.equal(unescapeText("damage// rate of fire//c accuracy"), "damage, rate of fire, accuracy");
});

test("collapses non-breaking spaces and newlines in names", () => {
	assert.equal(cleanName(" DHG\u00a0Extended\nHandguard  "), "DHG Extended Handguard");
	assert.equal(cleanName("Desert\u00a0\u00a0Eagle"), "Desert Eagle");
});
