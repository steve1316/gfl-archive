import { plainText } from "../data/lib/iopwiki.mjs";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Module constants

/** IOPWiki's page listing the game's soundtrack, with each track's titles and file name. */
export const OST_PAGE = "Girls' Frontline Original Soundtrack";

/** The references that play silence rather than a track, lower-cased. They get no title, so Now Playing stays hidden for them. */
const SILENCES = new Set(["bgm_empty", "bgm_pause"]);

/** The marks the page puts after a title: 1 for the official CDs, 2 for streaming releases, 3 for the game's Music Collection. */
const MARKS = /[\u00b9\u00b2\u00b3]/g;

/** The official CD mark, which picks a row's title when it lists several. */
const OFFICIAL = "\u00b9";

/** The header the page's track tables open with. A page without it has changed its layout, and the parser no longer reads it. */
const TABLE_HEADER = /!\s*Track name\s*!!\s*File name/;

/** The fewest titles the page should yield. Far fewer means its tables have changed, and the import stops rather than writing too few. */
const MIN_TITLES = 100;

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Parsing

/**
 * The one title a row's first cell gives: its official CD title where it lists several, else its first, with the marks, links and markup
 * taken out. The names are split only after a mark, so a title with a comma of its own stays whole.
 *
 * @param {string} cell The row's first cell.
 * @returns {string} The title, or an empty string when the cell names none.
 */
function pickTitle(cell) {
	// A web link keeps its text, as `plainText` does for a wiki link.
	const text = plainText(cell.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, "$1"));
	const names = text
		.split(/(?<=[\u00b9\u00b2\u00b3]),\s*/)
		.map((name) => name.trim())
		.filter((name) => name !== "");
	const chosen = names.find((name) => name.includes(OFFICIAL)) ?? names[0] ?? "";
	return chosen.replace(MARKS, "").trim();
}

/**
 * Read the soundtrack page's track tables into a title for each file name and ID they list, keyed lower-cased. A row whose file cell also
 * gives an ID in parentheses is listed under both, and the first row to name a key keeps it.
 *
 * @param {string} wikitext The page's wikitext.
 * @param {number} [minTitles] The fewest titles to accept. Tests pass 1 for a short fixture.
 * @returns {Map<string, string>} Each lower-cased file name or ID, and its title.
 * @throws {Error} When the page has no track table, or yields fewer titles than `minTitles`, so a changed page stops the import.
 */
export function parseOstTable(wikitext, minTitles = MIN_TITLES) {
	if (!TABLE_HEADER.test(wikitext)) {
		throw new Error('the soundtrack page has no track table headed "Track name !! File name", so its layout has changed');
	}
	const titles = new Map();
	for (const chunk of wikitext.split(/\n\|-[^\n]*\n/)) {
		// A row is its first line. A long row can carry its player cell onto a second one.
		const line = chunk.trim().split("\n")[0] ?? "";
		if (!line.startsWith("|") || line.startsWith("|}")) {
			continue;
		}
		const [first, files] = line.slice(1).split(/\s*\|\|\s*/);
		const title = first ? pickTitle(first) : "";
		if (title === "" || !files) {
			continue;
		}
		for (const key of files.match(/[A-Za-z0-9_&-]+/g) ?? []) {
			if (!titles.has(key.toLowerCase())) {
				titles.set(key.toLowerCase(), title);
			}
		}
	}
	if (titles.size < minTitles) {
		throw new Error(`the soundtrack page yielded ${titles.size} titles, fewer than ${minTitles} rows' worth, so its layout has changed`);
	}
	return titles;
}

/**
 * Read the game's audio table into each music ID and the file it plays. The scripts name some tracks by a number, such as `10213`, and the
 * soundtrack page lists files by name, so this joins the two. Lines read `AudioBGM|<id>|<file>|BGM`, and other kinds are skipped.
 *
 * @param {string} text The contents of `asset/textdata/audiotemplate.txt`.
 * @returns {Map<string, string>} Each music ID and its file name.
 */
export function parseAudioTemplate(text) {
	const files = new Map();
	for (const line of text.split(/\r?\n/)) {
		const [kind, id, file] = line.trim().split("|");
		if (kind === "AudioBGM" && id && file) {
			files.set(id, file);
		}
	}
	return files;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Building

/**
 * Title every track the story plays. A hand-kept title wins, then the page's title for the reference itself, then the page's title for the
 * file the game's audio table maps it to. Silences get none and are not missing.
 *
 * @param {Iterable<string>} refs The track references the scenes play.
 * @param {Map<string, string>} ost The page's titles, from `parseOstTable`.
 * @param {Map<string, string>} template The audio table, from `parseAudioTemplate`.
 * @param {Record<string, string>} extra The hand-kept titles, keyed by reference.
 * @returns {{ titles: Record<string, string>, missing: string[] }} Each titled reference's title, and the references left without one.
 */
export function buildMusicTitles(refs, ost, template, extra) {
	const titles = {};
	const missing = [];
	for (const ref of [...new Set(refs)].sort()) {
		if (SILENCES.has(ref.toLowerCase())) {
			continue;
		}
		const file = template.get(ref);
		const title = extra[ref] ?? ost.get(ref.toLowerCase()) ?? (file === undefined ? undefined : ost.get(file.toLowerCase()));
		if (title === undefined) {
			missing.push(ref);
		} else {
			titles[ref] = title;
		}
	}
	return { titles, missing };
}

/**
 * Every track reference the story's scenes play, each once, sorted.
 *
 * @param {Map<string, { beats: { ops: { type: string, value?: string }[] }[] }>} scenes The scenes, from `buildStory`.
 * @returns {string[]} The references.
 */
export function storyTracks(scenes) {
	const refs = new Set();
	for (const scene of scenes.values()) {
		for (const beat of scene.beats) {
			for (const op of beat.ops) {
				if (op.type === "bgm" && op.value) {
					refs.add(op.value);
				}
			}
		}
	}
	return [...refs].sort();
}
