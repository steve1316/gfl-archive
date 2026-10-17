import type { StoryChapterSummary } from "../../types/story";

/** One heading in the chapter list and the chapters under it, in display order. */
export interface ChapterGroup {
	/** The heading, such as `Main Story`. */
	title: string;
	/** The chapters under the heading, in display order. */
	chapters: StoryChapterSummary[];
}

/** A Minor Event's label, which is the year it ran. */
const YEAR_LABEL = /^\d+$/;

/**
 * Whether a chapter is a Minor Event: a type 3 chapter labelled with its year.
 *
 * @param chapter The chapter.
 * @returns True for a Minor Event.
 */
function isMinor(chapter: StoryChapterSummary): boolean {
	return chapter.type === 3 && YEAR_LABEL.test(chapter.label);
}

/**
 * Sort chapters into the four groups IOP Wiki uses, which follow the game's own playback type.
 *
 * Main Story is type 1 and Story Events type 2. A type 3 chapter labelled with a year is a Minor Event, listed by year. Everything else,
 * such as the event campaigns the game gives no chapter, is an Other Event. Empty groups are left out.
 *
 * @param chapters The chapters in menu order, as the index lists them.
 * @returns The groups in display order.
 */
export function groupChapters(chapters: StoryChapterSummary[]): ChapterGroup[] {
	const main = chapters.filter((chapter) => chapter.type === 1);
	const story = chapters.filter((chapter) => chapter.type === 2);
	const minor = chapters.filter(isMinor).sort((left, right) => Number(left.label) - Number(right.label));
	const other = chapters.filter((chapter) => chapter.type !== 1 && chapter.type !== 2 && !isMinor(chapter));
	const groups = [
		{ title: "Main Story", chapters: main },
		{ title: "Story Events", chapters: story },
		{ title: "Minor Events", chapters: minor },
		{ title: "Other Events", chapters: other }
	];
	return groups.filter((group) => group.chapters.length > 0);
}
