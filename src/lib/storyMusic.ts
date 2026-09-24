/** The references that play silence rather than a track, lower-cased. They get no title, so Now Playing stays hidden for them. */
const SILENCES = new Set(["bgm_empty", "bgm_pause"]);

/** The prefix the game puts before a track's name. */
const TRACK_PREFIX = /^(?:BGM|GF)_/;

/**
 * The title a track shows as in the story corner and the Logs. For now it is the script's reference, tidied, so `BGM_Sneak` reads "Sneak",
 * until the soundtrack's own title table replaces it.
 *
 * @param ref The track reference a beat plays, such as `BGM_Sneak` or `10213`, or null for none.
 * @returns The title, or null for no track, a silence, or a numeric reference with no name in it.
 */
export function trackTitle(ref: string | null): string | null {
	if (ref === null || SILENCES.has(ref.toLowerCase()) || /^\d+$/.test(ref)) {
		return null;
	}
	const title = ref.replace(TRACK_PREFIX, "").replace(/_/g, " ").trim();
	return title === "" ? null : title;
}
