/**
 * What the story index shows for each chapter and mission beyond the game's own fields: a mission's number, a chapter's cover, and
 * names repaired where upstream stored UTF-8 as Latin-1.
 */

/** The generic room a chapter falls back to when it has no curated cover and no published background of its own. */
export const FALLBACK_COVER = "作战室avg";

/** The two entries in the background table that are a wash rather than a picture, lowercased, so they never become a cover. */
export const BACKGROUND_WASHES = new Set(["black", "white"]);

/** A main story scene code: chapter, mission and part, then an optional lone capital such as the `E` of an emergency mission. */
const SCENE_CODE = /^(\d+-\d+-\d+)([A-Z](?![a-z]))?/;

/** A Latin-1 rendering of a UTF-8 lead byte followed by a continuation byte, the mark of text decoded the wrong way. */
const MOJIBAKE = /[ÃÂ][\x80-\xBF]/;

/** Any character Latin-1 cannot hold. */
const BEYOND_LATIN1 = /[^\x00-\xFF]/;

/**
 * The number the index shows beside a mission.
 *
 * The main story shows the mission's first scene code, such as `5-1-1`. Chapter 13's scripts end in `First` or `End`, which is dropped.
 * Every other chapter, and a main story mission with no readable code, shows its place in the chapter counted from 1.
 *
 * @param {number} type The chapter's type, where 1 is the main story.
 * @param {number} position The mission's index within the chapter, from 0.
 * @param {string} firstScript The first script the mission plays.
 * @returns {string} The mission's number.
 */
export function missionNumber(type, position, firstScript) {
	const match = type === 1 ? SCENE_CODE.exec(firstScript) : null;
	return match ? match[1] + (match[2] ?? "") : String(position + 1);
}

/**
 * Repair text that upstream stored as UTF-8 bytes read back as Latin-1, such as `PoincarÃ©` for `Poincaré`.
 *
 * Text that also holds a character above U+00FF is left alone. Latin-1 cannot hold it, so re-decoding would garble it without a trace.
 *
 * @param {string} text The text as upstream gives it.
 * @returns {string} The repaired text, or the original when it shows no sign of the fault or would not decode cleanly.
 */
export function repairMojibake(text) {
	if (!text || !MOJIBAKE.test(text) || BEYOND_LATIN1.test(text)) {
		return text;
	}
	const repaired = Buffer.from(text, "latin1").toString("utf8");
	return repaired.includes("�") ? text : repaired;
}

/**
 * Choose the background drawn behind a chapter's row and banner.
 *
 * The curated pick wins when it is published. Otherwise the chapter's first published background that is not a wash is used, and with
 * none of those the generic room.
 *
 * @param {string | undefined} curated The curated background for the chapter, if any.
 * @param {string[]} sceneBackgrounds Every background the chapter's scenes show, in play order.
 * @param {Set<string>} published The published background names, lowercased.
 * @param {(message: string) => void} warn Called when the curated pick is not published.
 * @returns {string} The background name as the data spells it.
 */
export function pickCover(curated, sceneBackgrounds, published, warn) {
	if (curated && published.has(curated.toLowerCase())) {
		return curated;
	}
	if (curated) {
		warn(`cover ${curated} is not published`);
	}
	const usable = (name) => !BACKGROUND_WASHES.has(name.toLowerCase()) && published.has(name.toLowerCase());
	return sceneBackgrounds.find(usable) ?? FALLBACK_COVER;
}
