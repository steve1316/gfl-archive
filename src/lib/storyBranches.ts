import type { StoryBeat } from "../types/story";

/** How many characters a fallback label keeps before it is cut short. */
const LABEL_LIMIT = 160;

/** A branch region's one alternative: what the choice button reads and which beats taking it plays. */
export interface BranchOption {
	/** The script's own number for the alternative, `1`, `2` and so on. Matches the `branch` op on the beats it plays. */
	label: string;
	/** What the choice button reads, taken from the script's own prompt where it wrote one and from the alternative's first line otherwise. */
	text: string;
}

/** A point where the script offers the reader a choice, and the alternatives it branches into. */
export interface BranchRegion {
	/** Index of the first beat carrying a branch tag, which is where the choice is put to the reader. */
	start: number;
	/** The alternatives, in the order the script numbers them. */
	options: BranchOption[];
}

/** A scene's branch points, and which of them each beat belongs to. */
export interface BranchMap {
	/** Every choice the scene offers, in the order they come up. */
	regions: BranchRegion[];
	/** Per beat, the index into `regions` of the choice it belongs to, or -1 when the beat plays whatever the reader picks. */
	regionOf: number[];
	/** Per beat, the branch number it is tagged with, or null when the beat plays whatever the reader picks. */
	labelOf: (string | null)[];
}

/** The beats to play given the choices made so far, and the next choice still to be answered. */
export interface StoryTimeline {
	/** The beats to play, in order, with every alternative the reader did not take left out. */
	beats: StoryBeat[];
	/** The choice the reader has reached and not yet answered, or null when the scene runs on to its end. */
	pending: BranchRegion | null;
	/** Index of `pending` into the scene's regions, so the answer can be recorded against it. -1 when nothing is pending. */
	pendingIndex: number;
	/** Per answered choice, keyed by its index into the regions, where the picked alternative starts among `beats`. */
	starts: Record<number, number>;
}

/**
 * The options a beat puts to the reader.
 *
 * @param beat The beat.
 * @returns The option labels in order, empty when the beat offers none.
 */
function offeredChoices(beat: StoryBeat): string[] {
	return beat.pages.flatMap((page) => page.choices ?? []);
}

/**
 * The branch number a beat is tagged with.
 *
 * @param beat The beat.
 * @returns The number as the script wrote it, or null when the beat carries no branch tag.
 */
function branchLabel(beat: StoryBeat): string | null {
	let label: string | null = null;
	for (const op of beat.ops) {
		if (op.type === "branch" && op.value) {
			label = op.value;
		}
	}
	return label;
}

/**
 * How many of a beat's pages carry text, up to a page. A choice's own page often has none, and a page with no text is no line to read.
 *
 * @param beat The beat.
 * @param upTo How many of its pages to look at, from the first.
 * @returns The count.
 */
function textPages(beat: StoryBeat, upTo = beat.pages.length): number {
	return beat.pages.slice(0, upTo).filter((page) => page.spans.some((span) => span.text.trim() !== "")).length;
}

/**
 * The first thing an alternative actually says, to stand in as its label where the script wrote no prompt.
 *
 * The opening beats of an alternative are often silent - a background change or a fade - so this looks through the alternative until
 * it finds one with text rather than giving up on the first.
 *
 * @param beats The scene's beats.
 * @param indexes The alternative's beats, in order.
 * @returns The text, or an empty string when the alternative never says anything.
 */
function firstLine(beats: StoryBeat[], indexes: number[]): string {
	for (const index of indexes) {
		for (const page of beats[index]?.pages ?? []) {
			const text = page.spans
				.map((span) => span.text)
				.join("")
				.trim();
			if (text !== "") {
				return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT).trimEnd()}...` : text;
			}
		}
	}
	return "";
}

/**
 * Find a scene's choice points.
 *
 * The scripts mark a branch by tagging each beat with the number of the alternative it belongs to. A prompt beat, the one listing the
 * options, is what opens a choice, and everything tagged after it belongs to that choice however the numbers run - some scripts write
 * the alternatives as blocks, others interleave them. Where a script wrote no prompt, a number that has already been used is the only
 * signal that the next choice has begun. Beats carrying no tag at all play whichever way the reader goes.
 *
 * @param beats The scene's beats.
 * @returns The regions, and the region and branch number of every beat.
 */
export function branchRegions(beats: StoryBeat[]): BranchMap {
	const regions: BranchRegion[] = [];
	const regionOf: number[] = new Array<number>(beats.length).fill(-1);
	const labelOf: (string | null)[] = new Array<string | null>(beats.length).fill(null);
	// Every beat of each alternative in the region being built, so a label can fall back to the first line the alternative speaks.
	let heads: Map<string, number[]> = new Map();
	let previous: string | null = null;
	// A prompt has been read and the next tagged beat starts the choice it introduces. The scene opens armed, for a script with none.
	let armed = true;
	// Where the last prompt sat and what it offered, so a region opening directly after one takes its wording.
	let promptAt = -2;
	let promptOptions: string[] = [];
	// The wording the region being built was opened with, empty when no prompt introduced it.
	let regionOptions: string[] = [];

	const close = () => {
		const region = regions[regions.length - 1];
		if (!region) {
			return;
		}
		const numbered = [...heads.entries()].sort((left, right) => Number(left[0]) - Number(right[0]));
		region.options = numbered.map(([label, indexes], position) => ({
			label,
			text: (regionOptions[position] ?? firstLine(beats, indexes)) || `Option ${position + 1}`
		}));
	};

	beats.forEach((beat, index) => {
		const offered = offeredChoices(beat);
		if (offered.length > 0) {
			armed = true;
			promptAt = index;
			promptOptions = offered;
			return;
		}
		const label = branchLabel(beat);
		if (label === null) {
			return;
		}
		if (armed || (regionOptions.length === 0 && heads.has(label) && label !== previous)) {
			close();
			regions.push({ start: index, options: [] });
			heads = new Map();
			previous = null;
			regionOptions = promptAt === index - 1 ? promptOptions : [];
			armed = false;
		}
		heads.set(label, [...(heads.get(label) ?? []), index]);
		regionOf[index] = regions.length - 1;
		labelOf[index] = label;
		previous = label;
	});
	close();

	return { regions, regionOf, labelOf };
}

/**
 * The beats to play, given the choices the reader has made.
 *
 * Playback stops at the first choice still unanswered, since everything past it depends on the answer.
 *
 * @param beats The scene's beats.
 * @param map The scene's branch map.
 * @param choices The branch number picked for each region, keyed by its index into `map.regions`.
 * @returns The timeline.
 */
export function buildTimeline(beats: StoryBeat[], map: BranchMap, choices: Record<number, string>): StoryTimeline {
	const played: StoryBeat[] = [];
	const starts: Record<number, number> = {};
	for (let index = 0; index < beats.length; index++) {
		const beat = beats[index];
		if (!beat) {
			continue;
		}
		const region = map.regionOf[index] ?? -1;
		if (region === -1) {
			played.push(beat);
			continue;
		}
		const chosen = choices[region];
		if (chosen === undefined) {
			return { beats: played, pending: map.regions[region] ?? null, pendingIndex: region, starts };
		}
		starts[region] ??= played.length;
		if (map.labelOf[index] === chosen) {
			played.push(beat);
		}
	}
	return { beats: played, pending: null, pendingIndex: -1, starts };
}

/**
 * The picks the reader is still past. A pick counts only while the reader is on or after the first beat it chose, so stepping back onto the
 * choice forgets it, and reading on offers the choice again rather than replaying the old answer.
 *
 * @param choices The branch number picked for each region, keyed by its index into the regions.
 * @param starts Where each picked alternative starts in the timeline, from `buildTimeline`.
 * @param at Index into the timeline of the beat the reader is on.
 * @returns The picks still reached, or `choices` itself when none is forgotten.
 */
export function reachedChoices(choices: Record<number, string>, starts: Record<number, number>, at: number): Record<number, string> {
	const kept = Object.fromEntries(Object.entries(choices).filter(([region]) => (starts[Number(region)] ?? Infinity) <= at));
	return Object.keys(kept).length === Object.keys(choices).length ? choices : kept;
}

/**
 * How many lines the path being read holds, counting every page with text. A picked answer's pages count and the others' do not, and a choice
 * not yet answered counts its longest answer, so the total can only drop once the reader picks.
 *
 * @param beats The scene's beats.
 * @param map The scene's branch map.
 * @param choices The branch number picked for each region, keyed by its index into `map.regions`.
 * @returns The total.
 */
export function lineTotal(beats: StoryBeat[], map: BranchMap, choices: Record<number, string>): number {
	// Each region's pages per answer, so an unanswered one can take its longest.
	const sizes = map.regions.map(() => new Map<string, number>());
	beats.forEach((beat, index) => {
		const label = map.labelOf[index];
		const size = sizes[map.regionOf[index] ?? -1];
		if (label && size) {
			size.set(label, (size.get(label) ?? 0) + textPages(beat));
		}
	});
	const counted = sizes.map((size, region) => {
		if (choices[region] !== undefined) {
			return choices[region];
		}
		let longest: string | null = null;
		let most = -1;
		for (const [label, count] of size) {
			if (count > most) {
				longest = label;
				most = count;
			}
		}
		return longest;
	});
	return beats.reduce((total, beat, index) => {
		const region = map.regionOf[index] ?? -1;
		return region === -1 || map.labelOf[index] === counted[region] ? total + textPages(beat) : total;
	}, 0);
}

/**
 * How many lines have been read along the path, the page on screen included, counting every page with text. It goes up by one per click.
 *
 * @param played The beats the timeline plays.
 * @param at Index of the beat on screen.
 * @param page Index of the page on screen.
 * @returns The count, 0 before any text.
 */
export function linesRead(played: StoryBeat[], at: number, page: number): number {
	return played.slice(0, at + 1).reduce((read, beat, index) => read + textPages(beat, index === at ? page + 1 : beat.pages.length), 0);
}
