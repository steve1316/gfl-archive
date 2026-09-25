/**
 * Build the story data the player reads, from the upstream cutscene scripts and the game's own story index.
 *
 * The game catalogues its stories in two tables rather than in the filenames: `story_playback` is the chapter list the Story Playback
 * menu shows, and `story_util` is the missions inside them. A chapter's `story_campaign_id` is a comma-separated list of campaign ids,
 * and a mission's `campaign` names one of them, which is the join between the two. Scripts are then named by `story_util.scripts`.
 *
 * Scope is every chapter the playback menu catalogues: the main story it marks `type` 1, and the side campaigns it marks `type` 2.
 * The data also holds campaigns the menu does not list at all, which are counted in the summary and left alone - without a menu entry
 * there is no title or ordering to show them under.
 *
 * Output is three levels, so nothing fetches more than it shows: a tiny chapter list, one file per chapter holding that chapter's
 * mission list, and one file per scene holding its beats. A reader opening a single scene pays for that scene, not for the chapter
 * around it - the largest chapter is over a megabyte of dialogue.
 */

import fs from "node:fs";
import path from "node:path";

import { storyTracks } from "./music_titles.mjs";
import { parseScript } from "./parse_avg.mjs";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Module constants

/** Where the cutscene scripts live inside the upstream checkout. */
const SCRIPT_DIR = path.join("asset", "avgtxt");

/** Where the generated story data is written. */
const OUT_DIR = path.join("src", "data", "story");

/** The game's background table, one name a line, indexed by a script's `BIN` tag. */
const BACKGROUND_TABLE = "profiles.txt";

/** Where each scene's beats are written, one file each. */
const SCENE_DIR = path.join(OUT_DIR, "scenes");

/**
 * Turn a script name into a filename.
 *
 * Two script names carry a folder part, and a slash cannot go in a filename. No name contains a double underscore, so it is a safe
 * stand-in and the site can rebuild the name without a lookup table.
 *
 * @param {string} name The script name from `story_util.scripts`.
 * @returns {string} The filename stem.
 */
export function sceneFile(name) {
	return name.replace(/\//g, "__").toLowerCase();
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Script files

/**
 * Index every script file by its lowercased name.
 *
 * The tables name scripts in mixed case - `1-1-1E` where the file is `1-1-1e.txt` - so a case-sensitive lookup loses about two
 * thirds of them.
 *
 * @param {string} dir The upstream checkout.
 * @returns {Map<string, string>} Lowercased script name to its path.
 */
/**
 * Read the game's background table.
 *
 * A script names its background as `<BIN>n</BIN>`, and `n` indexes this file: one name a line, counted from zero. The names are the
 * scene codes the art is published under, so `BIN 7` is the eighth line, `雪地`. Two of them, `black` and `White`, are washes rather
 * than pictures and have no art to publish.
 *
 * @param {string} dir The upstream checkout.
 * @returns {string[]} The background names, indexed as the scripts index them.
 */
function readBackgrounds(dir) {
	const file = path.join(dir, SCRIPT_DIR, BACKGROUND_TABLE);
	if (!fs.existsSync(file)) {
		return [];
	}
	return fs
		.readFileSync(file, "utf8")
		.split(/\r?\n/)
		.map((line) => line.trim());
}

/**
 * Replace each background op's index with the name it points at.
 *
 * Done here rather than in the player so a scene ships the name of its own background, and nothing downstream has to carry a
 * 906-entry table to read one scene.
 *
 * @param {object[]} beats The scene's beats, edited in place.
 * @param {string[]} backgrounds The background table.
 */
function resolveBackgrounds(beats, backgrounds) {
	for (const beat of beats) {
		for (const op of beat.ops) {
			// Only `BIN` is an index. The two `Pic` tags in the data carry a sprite list and are left alone.
			if (op.type !== "background" || op.raw !== "BIN" || !/^\d+$/.test(op.value ?? "")) {
				continue;
			}
			const name = backgrounds[Number(op.value)];
			if (name) {
				op.value = name;
			}
		}
	}
}

function indexScripts(dir) {
	const root = path.join(dir, SCRIPT_DIR);
	const found = new Map();
	for (const entry of fs.readdirSync(root, { withFileTypes: true, recursive: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".txt")) {
			continue;
		}
		const full = path.join(entry.parentPath ?? entry.path ?? root, entry.name);
		const name = path.relative(root, full).slice(0, -4).split(path.sep).join("/");
		found.set(name.toLowerCase(), full);
	}
	return found;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Building

/**
 * Split a comma-separated field into trimmed, non-empty parts.
 *
 * @param {unknown} value The field.
 * @returns {string[]} Its parts.
 */
function parts(value) {
	return String(value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

/**
 * Build the story index and every chapter's scenes.
 *
 * @param {object} upstream The upstream reader from `loadUpstream`.
 * @param {string} dir The upstream checkout, for reading the script files.
 * @returns {{ index: object, chapters: Map<number, object>, scenes: Map<string, object>, summary: object }} The chapter list, each chapter's missions, every scene's beats, and what to report.
 */
export function buildStory(upstream, dir) {
	const scripts = indexScripts(dir);
	const backgrounds = readBackgrounds(dir);
	const playback = upstream.stc("story_playback");
	const missions = upstream.stc("story_util");

	// Which chapter owns each campaign id, so a mission can find its chapter.
	const chapterOf = new Map();
	for (const row of playback) {
		for (const campaign of parts(row.story_campaign_id)) {
			chapterOf.set(campaign, row.id);
		}
	}

	const byChapter = new Map(playback.map((row) => [row.id, []]));
	const uncatalogued = new Set();
	for (const row of missions) {
		const chapter = chapterOf.get(String(row.campaign));
		if (chapter === undefined) {
			uncatalogued.add(row.campaign);
			continue;
		}
		byChapter.get(chapter).push(row);
	}

	const unknownTags = new Map();
	const missingScripts = [];
	const index = { chapters: [] };
	const chapters = new Map();
	const scenes = new Map();
	let beatCount = 0;

	for (const row of playback) {
		const rows = byChapter.get(row.id);
		if (rows.length === 0) {
			continue;
		}
		const listed = [];
		for (const mission of rows) {
			const names = parts(mission.scripts);
			const present = [];
			for (const name of names) {
				const file = scripts.get(name.toLowerCase());
				if (!file) {
					missingScripts.push(name);
					continue;
				}
				present.push(name);
				// A scene can be listed by more than one mission, so it is parsed and written once.
				if (scenes.has(name)) {
					continue;
				}
				const parsed = parseScript(fs.readFileSync(file, "utf8"));
				resolveBackgrounds(parsed.beats, backgrounds);
				for (const [tag, count] of parsed.unknown) {
					unknownTags.set(tag, (unknownTags.get(tag) ?? 0) + count);
				}
				scenes.set(name, { name, beats: parsed.beats });
				beatCount += parsed.beats.length;
			}
			if (present.length === 0) {
				continue;
			}
			listed.push({
				id: mission.id,
				title: upstream.t(mission.title),
				description: upstream.t(mission.description),
				bgm: mission.bgm || undefined,
				background: mission.background_code || undefined,
				scripts: present
			});
		}
		if (listed.length === 0) {
			continue;
		}
		index.chapters.push({ id: row.id, label: upstream.t(row.chapter), name: upstream.t(row.name), type: row.type, order: row.order, missions: listed.length });
		chapters.set(row.id, { id: row.id, missions: listed });
	}

	index.chapters.sort((left, right) => left.order - right.order);
	return {
		index,
		chapters,
		scenes,
		summary: {
			chapters: index.chapters.length,
			scenes: scenes.size,
			beats: beatCount,
			unknownTags,
			missingScripts,
			uncatalogued: [...uncatalogued],
			// Every track the scenes play, for the importer's title step.
			tracks: storyTracks(scenes)
		}
	};
}

/**
 * Write the story data and report what it contains.
 *
 * @param {object} upstream The upstream reader from `loadUpstream`.
 * @param {string} dir The upstream checkout.
 * @returns {object} The summary, so the importer can fold the counts into `upstream.json`.
 */
export function writeStory(upstream, dir) {
	const { index, chapters, scenes, summary } = buildStory(upstream, dir);
	// Rewritten from scratch, so a chapter or scene dropped upstream does not survive as a stale file.
	fs.rmSync(OUT_DIR, { recursive: true, force: true });
	fs.mkdirSync(SCENE_DIR, { recursive: true });
	fs.writeFileSync(path.join(OUT_DIR, "index.json"), `${JSON.stringify(index)}\n`);
	for (const [id, chapter] of chapters) {
		fs.writeFileSync(path.join(OUT_DIR, `chapter-${id}.json`), `${JSON.stringify(chapter)}\n`);
	}
	for (const [name, scene] of scenes) {
		fs.writeFileSync(path.join(SCENE_DIR, `${sceneFile(name)}.json`), `${JSON.stringify(scene)}\n`);
	}
	return summary;
}
