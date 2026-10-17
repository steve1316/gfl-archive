import { test } from "node:test";
import assert from "node:assert/strict";

import { FALLBACK_COVER, missionNumber, pickCover, repairMojibake } from "../../story/chapter_meta.mjs";

test("a main story mission is numbered by its first scene code", () => {
	assert.equal(missionNumber(1, 0, "5-1-1"), "5-1-1");
	assert.equal(missionNumber(1, 3, "0-4-1"), "0-4-1");
	assert.equal(missionNumber(1, 0, "5-1-1E"), "5-1-1E");
	assert.equal(missionNumber(1, 0, "13-1-1First"), "13-1-1");
	assert.equal(missionNumber(1, 1, "13-1-2End"), "13-1-2");
});

test("a main story mission with no code falls back to its running number", () => {
	assert.equal(missionNumber(1, 4, "weird"), "5");
});

test("every other chapter type uses a running number from 1", () => {
	assert.equal(missionNumber(2, 0, "-56-1-A"), "1");
	assert.equal(missionNumber(3, 6, "2021-1-1"), "7");
});

test("UTF-8 read as Latin-1 is repaired and clean text is left alone", () => {
	assert.equal(repairMojibake("PoincarÃ© Recurrence"), "Poincaré Recurrence");
	assert.equal(repairMojibake("Poincaré Recurrence"), "Poincaré Recurrence");
	assert.equal(repairMojibake("Mirror Stage"), "Mirror Stage");
	// A lone telltale with no continuation byte would decode to a replacement character, so it is kept.
	assert.equal(repairMojibake("Ã alone"), "Ã alone");
});

test("text with a character Latin-1 cannot hold is left alone rather than garbled", () => {
	// Re-decoding would cut the curly quote and the CJK down to one byte each, so a mixed string keeps its mojibake instead.
	assert.equal(repairMojibake("PoincarÃ©’s Recurrence"), "PoincarÃ©’s Recurrence");
	assert.equal(repairMojibake("PoincarÃ© 作战"), "PoincarÃ© 作战");
});

test("a published curated cover wins", () => {
	assert.equal(
		pickCover("cg.4-2", ["cg.5"], new Set(["cg.4-2", "cg.5"]), () => {}),
		"cg.4-2"
	);
});

test("an unpublished curated cover warns and falls back to the first published scene background, skipping washes", () => {
	const warnings = [];
	assert.equal(
		pickCover("typo", ["black", "missing", "Cg.5"], new Set(["black", "cg.5"]), (message) => warnings.push(message)),
		"Cg.5"
	);
	assert.equal(warnings.length, 1);
});

test("no curated cover and no published background gives the generic room", () => {
	assert.equal(
		pickCover(undefined, ["white"], new Set(), () => {}),
		FALLBACK_COVER
	);
});
