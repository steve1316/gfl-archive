import { test } from "node:test";
import assert from "node:assert/strict";

import { parseBeat, parseScript, readText, splitBeat } from "../../story/parse_avg.mjs";

// Every line here is invented. The real scripts are the game's copyrighted dialogue, so the fixtures exercise the grammar with
// placeholder names and text rather than quoting them.

test("a beat reads its sprite, speaker and text", () => {
	const beat = parseBeat("Alpha(2)<Speaker>Alpha</Speaker>||:Hello there");
	assert.deepEqual(beat.sprites, [{ prefab: "Alpha", expression: 2, shown: true, side: "left", tags: {} }]);
	assert.equal(beat.speaker, "Alpha");
	assert.equal(beat.pages.length, 1);
	assert.deepEqual(beat.pages[0].spans, [{ text: "Hello there" }]);
});

test("semicolons separate sprites and the speaker binds to its own", () => {
	const beat = parseBeat("Alpha(0)<Speaker>Alpha</Speaker>;Beta(1)||:Line");
	assert.deepEqual(
		beat.sprites.map((sprite) => [sprite.prefab, sprite.expression]),
		[
			["Alpha", 0],
			["Beta", 1]
		]
	);
	assert.equal(beat.speaker, "Alpha");
});

test("the two stage sides are kept apart", () => {
	const beat = parseBeat("Alpha(0)||Beta(0):Line");
	assert.deepEqual(
		beat.sprites.map((sprite) => [sprite.prefab, sprite.side]),
		[
			["Alpha", "left"],
			["Beta", "right"]
		]
	);
});

test("an empty pair of brackets is narration, with text but nobody on stage", () => {
	const beat = parseBeat("()||:Somewhere far away");
	assert.deepEqual(beat.sprites, []);
	assert.equal(beat.speaker, null);
	assert.deepEqual(beat.pages[0].spans, [{ text: "Somewhere far away" }]);
});

test("a plus splits the text into click-through pages", () => {
	const beat = parseBeat("()||:first+second+third");
	assert.deepEqual(
		beat.pages.map((page) => page.spans[0].text),
		["first", "second", "third"]
	);
});

test("a colon inside the dialogue does not end the head early", () => {
	const beat = parseBeat("Alpha(0)<Speaker>Alpha</Speaker>||:the time is 12:30");
	assert.equal(beat.speaker, "Alpha");
	assert.deepEqual(beat.pages[0].spans, [{ text: "the time is 12:30" }]);
});

test("a line with no colon still parses, with no text", () => {
	const beat = parseBeat("Alpha(0)||<BGM>cue_name</BGM>");
	assert.deepEqual(beat.pages, []);
	assert.deepEqual(beat.ops, [{ type: "bgm", value: "cue_name", raw: "BGM" }]);
});

test("known tags become named ops and keep their raw name", () => {
	const beat = parseBeat("()||<BGM>cue</BGM><SE1>hit</SE1><BIN>4</BIN>:Line");
	assert.deepEqual(beat.ops, [
		{ type: "bgm", value: "cue", raw: "BGM" },
		{ type: "sfx", value: "hit", raw: "SE1" },
		{ type: "background", value: "4", raw: "BIN" }
	]);
});

test("both cases of the speaker tag are read, and an empty one leaves no speaker", () => {
	assert.equal(parseBeat("Alpha(0)<speaker>Alpha</speaker>||:Line").speaker, "Alpha");
	assert.equal(parseBeat("Alpha(0)<Speaker></Speaker>||:Line").speaker, null);
});

test("a narrator tag marks the beat as narration", () => {
	assert.equal(parseBeat("()<narrator>||:Line").narrator, true);
	assert.equal(parseBeat("()||:Line").narrator, false);
});

test("a sprite tag binds to the sprite before it, and becomes an op when there is none", () => {
	const bound = parseBeat("Alpha(0)<Position>120</Position>||:Line");
	// Bound or loose, the tag arrives under the same name, so a reader of either does not need the game's own spelling.
	assert.deepEqual(bound.sprites[0].tags, { spritePosition: "120" });
	assert.deepEqual(bound.ops, []);

	const loose = parseBeat("()<Position>120</Position>||:Line");
	assert.deepEqual(loose.sprites, []);
	assert.deepEqual(loose.ops, [{ type: "spritePosition", value: "120", raw: "Position" }]);
});

test("a prefab with no expression is heard but not seen", () => {
	const unseen = parseBeat("M4A1()<Speaker>M4A1</Speaker>||:Line").sprites[0];
	assert.equal(unseen.shown, false);
	// Still carried, since the beat names them as the speaker and a tag can bind to the slot.
	assert.equal(unseen.prefab, "M4A1");
	assert.equal(parseBeat("M4A1(0)<Speaker>M4A1</Speaker>||:Line").sprites[0].shown, true);
});

test("an untagged line with one character heard but not seen names them as the speaker", () => {
	assert.equal(parseBeat("Alpha()||:Line").speaker, "Alpha");
	assert.equal(parseBeat("Alpha()||<BGM>BGM_Test</BGM>:Line").speaker, "Alpha");
});

test("the speaker tag still wins over a character heard but not seen", () => {
	assert.equal(parseBeat("Alpha()<Speaker>Beta</Speaker>||:Line").speaker, "Beta");
});

test("no speaker is guessed for a visible character, narration, or a line with no text", () => {
	assert.equal(parseBeat("Alpha(0)||:Line").speaker, null);
	assert.equal(parseBeat("()||:Line").speaker, null);
	assert.equal(parseBeat("Alpha()<narrator>||:Line").speaker, null);
	assert.equal(parseBeat("Alpha()||<BIN>1</BIN>").speaker, null);
	assert.equal(parseBeat("Alpha();Beta()||:Line").speaker, null);
});

test("the two spellings of a sprite tag land on one name", () => {
	assert.deepEqual(parseBeat("Alpha(0)<position>9</position>||:Line").sprites[0].tags, { spritePosition: "9" });
	assert.deepEqual(parseBeat("Alpha(0)<\u901a\u8baf\u6846>||:Line").sprites[0].tags, { commsBox: "" });
});

test("a choice is lifted out of the text rather than left in it as a styled run", () => {
	const [page] = parseBeat("()||:Pick one.<c>Go left<c>Go right").pages;
	assert.deepEqual(page.spans, [{ text: "Pick one." }]);
	assert.deepEqual(page.choices, ["Go left", "Go right"]);
});

test("a page offering no choice carries no choices field", () => {
	const [page] = parseBeat("()||:Just a line.").pages;
	assert.deepEqual(page.spans, [{ text: "Just a line." }]);
	assert.equal("choices" in page, false);
});

test("a bare tag carries its value after an equals sign", () => {
	const beat = parseBeat("()||<common_effect=rain>:Line");
	assert.deepEqual(beat.ops, [{ type: "effect", value: "rain", raw: "common_effect" }]);
});

test("a branch is an op the player can offer as a choice", () => {
	const beat = parseBeat("()||<分支>go left,go right</分支>:Which way");
	assert.deepEqual(beat.ops, [{ type: "branch", value: "go left,go right", raw: "分支" }]);
});

test("an unrecognised tag is kept rather than dropped", () => {
	const beat = parseBeat("()||<某个新标签>7</某个新标签>:Line");
	assert.deepEqual(beat.ops, [{ type: "unknown", raw: "某个新标签", value: "7" }]);
});

test("inline markup becomes styled spans", () => {
	const [page] = readText("plain <color=#ff0000>red</color> plain");
	assert.deepEqual(page.spans, [{ text: "plain " }, { text: "red", style: { color: "#ff0000" } }, { text: " plain" }]);
});

test("nested inline markup carries both styles", () => {
	const [page] = readText("<color=#00ff00><size=40>both</size></color>");
	assert.deepEqual(page.spans, [{ text: "both", style: { color: "#00ff00", size: "40" } }]);
});

test("splitBeat reports a missing colon rather than guessing", () => {
	assert.deepEqual(splitBeat("Alpha(0)||"), { head: "Alpha(0)||", text: null });
	assert.deepEqual(splitBeat("Alpha(0)||:x"), { head: "Alpha(0)||", text: "x" });
});

test("a script skips blank lines and tallies its unknown tags", () => {
	const { beats, unknown } = parseScript("()||:one\n\n()||<某个新标签>1</某个新标签>:two\n()||<某个新标签>2</某个新标签>:three\n");
	assert.equal(beats.length, 3);
	assert.equal(unknown.get("某个新标签"), 2);
	assert.equal(Object.hasOwn(beats[0], "unknown"), false);
});

test("a comms window stays open until the caller leaves the stage", () => {
	const { beats } = parseScript(["Alpha(0)<通讯框>;Beta(0)||:one", "Alpha(0);Beta(0)||:two", "Beta(0)||:three", "Alpha(0);Beta(0)||:four"].join("\n"));
	const calling = beats.map((beat) => beat.sprites.filter((sprite) => sprite.tags.commsBox !== undefined).map((sprite) => sprite.prefab));
	assert.deepEqual(calling, [["Alpha"], ["Alpha"], [], []]);
});
