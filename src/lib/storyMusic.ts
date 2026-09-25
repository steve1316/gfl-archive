/** The references that play silence rather than a track, lower-cased. They get no title, so Now Playing stays hidden for them. */
const SILENCES = new Set(["bgm_empty", "bgm_pause"]);

/** The prefix the game puts before a track's name. */
const TRACK_PREFIX = /^(?:BGM|GF)_/;

/**
 * The title a track shows as in the story corner and the Logs: the soundtrack's own, from the importer's title table. A track the table
 * does not know yet, such as one added upstream since the last import, falls back to its reference tidied, so `BGM_Sneak` reads "Sneak".
 *
 * @param ref The track reference a beat plays, such as `BGM_Sneak` or `10213`, or null for none.
 * @param titles The title for each reference, from `src/data/story/music-titles.json`.
 * @returns The title, or null for no track, a silence, or a numbered reference the table does not know.
 */
export function trackTitle(ref: string | null, titles: Record<string, string>): string | null {
	if (ref === null || SILENCES.has(ref.toLowerCase())) {
		return null;
	}
	const known = titles[ref];
	if (known !== undefined) {
		return known;
	}
	if (/^\d+$/.test(ref)) {
		return null;
	}
	const title = ref.replace(TRACK_PREFIX, "").replace(/_/g, " ").trim();
	return title === "" ? null : title;
}
