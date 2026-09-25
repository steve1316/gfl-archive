import { test } from "node:test";
import assert from "node:assert/strict";

import { trackTitle } from "../../../src/lib/storyMusic.ts";

// A stand-in for the importer's title table.
const TITLES = { BGM_Danger: "Danger", 10213: "The Tide" };

test("a track the table knows shows the soundtrack's own title", () => {
	assert.equal(trackTitle("BGM_Danger", TITLES), "Danger");
	assert.equal(trackTitle("10213", TITLES), "The Tide");
});

test("a named track the table does not know yet shows its tidied reference", () => {
	assert.equal(trackTitle("BGM_Sneak_Night", TITLES), "Sneak Night");
});

test("a numbered track the table does not know, a silence, or no track shows nothing", () => {
	assert.equal(trackTitle("99999", TITLES), null);
	assert.equal(trackTitle("BGM_Empty", TITLES), null);
	assert.equal(trackTitle(null, TITLES), null);
});
