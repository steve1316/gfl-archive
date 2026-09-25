import { test } from "node:test";
import assert from "node:assert/strict";

import { branchRegions, buildTimeline, linesRead, lineTotal, reachedChoices } from "../../../src/lib/storyBranches.ts";

// Every line here is invented, like the parser's fixtures, so the tests exercise the branch rules without quoting the game's dialogue.

/**
 * A beat with one page of text, tagged with a branch number when given one.
 *
 * @param text The page's text.
 * @param branch The branch number, or undefined for a beat every alternative plays.
 * @returns The beat.
 */
function line(text, branch) {
	return { speaker: null, narrator: false, sprites: [], pages: [{ spans: [{ text }] }], ops: branch ? [{ type: "branch", value: branch, raw: "分支" }] : [] };
}

/**
 * A beat that puts a choice to the reader, on a page of its own after a line of text.
 *
 * @param options The option labels.
 * @returns The beat.
 */
function prompt(options) {
	return { speaker: null, narrator: false, sprites: [], pages: [{ spans: [{ text: "..." }] }, { spans: [], choices: options }], ops: [] };
}

/**
 * A beat with several click-through pages, tagged with a branch number when given one.
 *
 * @param texts The pages' text, one per page.
 * @param branch The branch number, or undefined for a beat every alternative plays.
 * @returns The beat.
 */
function pages(texts, branch) {
	return { ...line(texts[0], branch), pages: texts.map((text) => ({ spans: [{ text }] })) };
}

// One choice between two alternatives, then a line both play.
const ONE = [line("open"), prompt(["Left", "Right"]), line("went left", "1"), line("went right", "2"), line("after")];

// Two choices in a row, each between two alternatives.
const TWO = [line("open"), prompt(["A", "B"]), line("took A", "1"), line("took B", "2"), line("middle"), prompt(["C", "D"]), line("took C", "1"), line("took D", "2"), line("close")];

test("the timeline says where each picked alternative starts", () => {
	const timeline = buildTimeline(ONE, branchRegions(ONE), { 0: "2" });
	assert.deepEqual(
		timeline.beats.map((beat) => beat.pages[0].spans[0]?.text),
		["open", "...", "went right", "after"]
	);
	assert.deepEqual(timeline.starts, { 0: 2 });
});

test("an unanswered choice has no start yet", () => {
	assert.deepEqual(buildTimeline(ONE, branchRegions(ONE), {}).starts, {});
});

test("a pick stays while the reader is on or past the alternative it chose", () => {
	const picks = { 0: "2" };
	const { starts } = buildTimeline(ONE, branchRegions(ONE), picks);
	assert.equal(reachedChoices(picks, starts, 2), picks);
	assert.equal(reachedChoices(picks, starts, 3), picks);
});

test("stepping back onto the choice forgets its pick, so reading on offers it again", () => {
	const map = branchRegions(ONE);
	const picks = { 0: "2" };
	const kept = reachedChoices(picks, buildTimeline(ONE, map, picks).starts, 1);
	assert.deepEqual(kept, {});
	const timeline = buildTimeline(ONE, map, kept);
	assert.equal(timeline.pendingIndex, 0);
	assert.equal(timeline.beats.length, 2);
});

test("stepping back between two choices forgets only the later pick", () => {
	const picks = { 0: "1", 1: "2" };
	const { starts } = buildTimeline(TWO, branchRegions(TWO), picks);
	assert.deepEqual(starts, { 0: 2, 1: 5 });
	assert.deepEqual(reachedChoices(picks, starts, 4), { 0: "1" });
	assert.deepEqual(reachedChoices(picks, starts, 1), {});
	assert.equal(reachedChoices(picks, starts, 5), picks);
});

// A choice whose right-hand answer runs two pages to the left's one, then a closing line. The prompt says "..." and then offers the choice on a
// page of its own with no text.
const UNEVEN = [line("open"), prompt(["Left", "Right"]), line("went left", "1"), pages(["went right", "and on"], "2"), line("after")];

test("every page with text is a line, and a choice's empty page is not", () => {
	assert.equal(lineTotal(UNEVEN, branchRegions(UNEVEN), { 0: "2" }), 5);
});

test("only the picked answer counts toward the total", () => {
	assert.equal(lineTotal(UNEVEN, branchRegions(UNEVEN), { 0: "1" }), 4);
});

test("an unanswered choice counts its longest answer, so the total can only drop once the reader picks", () => {
	assert.equal(lineTotal(UNEVEN, branchRegions(UNEVEN), {}), 5);
});

test("the count goes up by one per page with text along the path read", () => {
	const played = buildTimeline(UNEVEN, branchRegions(UNEVEN), { 0: "2" }).beats;
	assert.deepEqual(
		[
			[0, 0],
			[1, 0],
			[1, 1],
			[2, 0],
			[2, 1],
			[3, 0]
		].map(([at, page]) => linesRead(played, at, page)),
		[1, 2, 2, 3, 4, 5]
	);
});
