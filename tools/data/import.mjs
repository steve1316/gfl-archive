#!/usr/bin/env node
/**
 * Generate the site's doll and equipment data from gf-data-us.
 *
 * Writes the doll shards, their profile side files, equipment.json, hocs.json, fairies.json, the formation simulator data, upstream.json and the search index under src/data.
 * Output is deterministic for a given upstream commit and set of released dolls, so a scheduled run only commits when something really changed.
 * The search index keeps the pre-2026-09-13 IOPWiki names from `tools/data/name-aliases.json` as aliases for renamed dolls.
 * The run date only selects which dolls are released and is not written out, so an unchanged import produces no diff.
 * Doll profiles come from IOPWiki, with Wikidata filling empty makers and countries and gf-data-ch spotting copied CN dates.
 * Profile fields can be corrected through `overrides.json` `fields` with paths such as `profile.manufacturer`, each with a one-line `reason`.
 *
 * Usage:
 *     node tools/data/import.mjs [--date YYYY-MM-DD]
 *     GF_DATA_DIR=/path/to/gf-data-us node tools/data/import.mjs
 *     IOPWIKI_CACHE=reuse WIKIDATA_CACHE=reuse node tools/data/import.mjs   (reuse the fetched profile sources)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

import { loadCnGuns } from "./lib/cnData.mjs";
import { buildDoll, selectReleased, splitDetails } from "./lib/dolls.mjs";
import { buildAssimilation, buildEnemies } from "./lib/enemies.mjs";
import { buildEquipment, exclusivesByDoll } from "./lib/equipment.mjs";
import { buildFairies } from "./lib/fairies.mjs";
import { buildFormation, buildFormationEnemies } from "./lib/formation.mjs";
import { buildHocs } from "./lib/hocs.mjs";
import { fetchIopwikiPages, parseEnRelease, wikipediaTitle } from "./lib/iopwiki.mjs";
import { findEquipmentMentions } from "./lib/mentions.mjs";
import { buildProfile, fillFromWikidata, indexPages, releaseFor } from "./lib/profile.mjs";
import { SHARDS } from "./lib/shards.mjs";
import { addExtraSkins, validateExtraSkins } from "./lib/skins.mjs";
import { readStatConfig } from "./lib/stats.mjs";
import { loadUpstream, readLock, resolveUpstreamDir } from "./lib/upstream.mjs";
import { fetchWikidataFacts } from "./lib/wikidata.mjs";
import { writeStory } from "../story/build_story.mjs";

/** Where generated data is written. */
const OUT_DIR = "src/data";

/** Fewer dolls than this joining an IOPWiki page means the page fetch or parse went wrong. */
const MIN_PROFILE_PAGES = 400;

/**
 * Set a value at a dotted path such as `normal.skill.description`. The full path, including the last
 * segment, must already exist, so a typo'd field name fails loudly instead of silently adding a new key.
 *
 * @param {object} target Object to change.
 * @param {string} path Dotted path.
 * @param {unknown} value New value.
 */
function setPath(target, path, value) {
	const keys = path.split(".");
	const last = keys.pop();
	const parent = keys.reduce((node, key) => node?.[key], target);
	if (!parent || !last || !Object.hasOwn(parent, last)) {
		throw new Error(`override path ${path} does not exist`);
	}
	parent[last] = value;
}

/**
 * Write JSON with a trailing newline.
 *
 * @param {string} file Output path.
 * @param {unknown} data Value to write.
 */
function writeJson(file, data) {
	fs.writeFileSync(file, `${JSON.stringify(data)}\n`);
}

/**
 * Attach a profile to every doll: its IOPWiki fields, its Global release date, and Wikidata labels for a maker or country
 * that IOPWiki leaves empty.
 *
 * @param {object[]} dolls Built dolls, override dolls included. Each gains a `profile`.
 * @param {ReturnType<typeof loadUpstream>} upstream Upstream readers.
 * @returns {Promise<{ joined: number, wikidata: number }>} How many dolls joined an IOPWiki page, and how many Wikidata filled.
 */
async function attachProfiles(dolls, upstream) {
	const pages = indexPages(await fetchIopwikiPages());
	const cnGuns = await loadCnGuns();
	if (cnGuns.size === 0) {
		throw new Error("gf-data-ch gun.json has no rows, so copied CN release dates cannot be spotted");
	}
	const usGuns = new Map(upstream.stc("gun").map((gun) => [gun.id, gun]));
	const lookups = [];
	for (const doll of dolls) {
		const id = doll.normal.id;
		const page = pages.get(id);
		const gun = usGuns.get(id);
		// Override dolls have no US row, so they come out unreleased.
		const release = releaseFor(gun?.launch_time, cnGuns.get(id), parseEnRelease(page?.fields.releasedon));
		doll.profile = buildProfile(page, release);
		const title = page ? wikipediaTitle(page.fields) : null;
		if (title && (doll.profile.manufacturer.length === 0 || doll.profile.country.length === 0)) {
			lookups.push({ doll, title });
		}
	}
	const joined = dolls.filter((doll) => doll.profile.iopwikiTitle).length;
	if (joined < MIN_PROFILE_PAGES) {
		throw new Error(`only ${joined} dolls joined an IOPWiki page, expected at least ${MIN_PROFILE_PAGES}`);
	}
	const facts = lookups.length > 0 ? await fetchWikidataFacts(lookups.map((lookup) => lookup.title)) : new Map();
	for (const { doll, title } of lookups) {
		doll.profile = fillFromWikidata(doll.profile, facts.get(title), [doll.normal.name, doll.profile.fullName, title]);
	}
	return { joined, wikidata: dolls.filter((doll) => doll.profile.sources.includes("wikidata")).length };
}

/**
 * Run the importer: read upstream and the profile sources, build every doll and equipment item, apply the overrides, and write `src/data`.
 *
 * @returns {Promise<void>} Resolves once every file is written.
 */
async function main() {
	const args = process.argv.slice(2);
	const cutoff = args.includes("--date") ? args[args.indexOf("--date") + 1] : new Date().toISOString().slice(0, 10);
	const upstreamDir = resolveUpstreamDir();
	const upstream = loadUpstream(upstreamDir);
	const overrides = JSON.parse(fs.readFileSync("tools/data/overrides.json", "utf8"));
	const extraSkins = JSON.parse(fs.readFileSync("tools/data/extra-skins.json", "utf8"));
	const aliases = JSON.parse(fs.readFileSync("tools/data/equipment-aliases.json", "utf8"));
	validateExtraSkins(extraSkins, upstream);
	const ctx = { config: readStatConfig(upstream), warnings: [] };

	const releasedGuns = selectReleased(upstream, cutoff);
	const dolls = releasedGuns.map((gun) => buildDoll(upstream, gun, ctx));
	for (const extra of overrides.addDolls) {
		if (!dolls.some((doll) => doll.normal.id === extra.normal.id)) {
			dolls.push(extra);
		}
	}
	for (const extra of extraSkins.filter((entry) => !dolls.some((doll) => doll.normal.id === entry.doll))) {
		throw new Error(`extra skin ${extra.doll}:${extra.key} belongs to a doll the data does not hold`);
	}
	for (const doll of dolls) {
		doll.skins = addExtraSkins(doll.skins, doll.normal.id, extraSkins);
	}
	const profiles = await attachProfiles(dolls, upstream);
	for (const fix of overrides.fields) {
		const doll = dolls.find((entry) => entry.normal.id === fix.doll);
		if (!doll) {
			throw new Error(`override for missing doll ${fix.doll}`);
		}
		setPath(doll, fix.path, fix.value);
	}
	dolls.sort((a, b) => a.normal.id - b.normal.id);

	const equipment = buildEquipment(upstream);
	// The doll page reads its exclusive equipment from the profile side file, so it never downloads equipment.json.
	const exclusives = exclusivesByDoll(equipment);
	for (const doll of dolls) {
		// Hand-added collaboration dolls have no gun row, so nothing records a build time for them.
		doll.production ??= null;
		doll.exclusiveEquipment = exclusives.get(doll.normal.id) ?? [];
		const dollAliases = aliases.filter((alias) => alias.doll === doll.normal.id);
		for (const form of [doll.normal, doll.mod].filter(Boolean)) {
			for (const key of ["skill", "skill2"]) {
				if (form[key]) {
					form[key].equipmentMentions = findEquipmentMentions(form[key].description, doll.exclusiveEquipment, dollAliases);
				}
			}
		}
	}
	for (const shard of SHARDS) {
		const split = dolls.filter((doll) => doll.normal.id >= shard.min && doll.normal.id <= shard.max).map(splitDetails);
		writeJson(
			`${OUT_DIR}/${shard.file}.json`,
			split.map((entry) => entry.record)
		);
		writeJson(`${OUT_DIR}/${shard.profiles}.json`, Object.fromEntries(split.map((entry) => [entry.record.normal.id, entry.details])));
	}
	writeJson(`${OUT_DIR}/equipment.json`, equipment);
	const hocs = buildHocs(upstream, cutoff);
	writeJson(`${OUT_DIR}/hocs.json`, hocs);
	const fairies = buildFairies(upstream);
	writeJson(`${OUT_DIR}/fairies.json`, fairies);
	const enemies = buildEnemies(upstream, ctx.warnings);
	// The index reads the records, and only an enemy's own page downloads the lore, skills and stats.
	writeJson(`${OUT_DIR}/enemies.json`, { factions: enemies.factions, items: enemies.items });
	writeJson(`${OUT_DIR}/enemy-details.json`, enemies.details);
	// Only the 57 capturable enemies use this, so an ordinary enemy's page never downloads it.
	const assimilation = buildAssimilation(upstream, ctx.warnings);
	writeJson(`${OUT_DIR}/assimilation.json`, assimilation);
	// Only the formation simulator reads these, so they sit in their own folder and never load on other pages.
	const formation = buildFormation(upstream, releasedGuns, ctx.config);
	fs.mkdirSync(`${OUT_DIR}/formation`, { recursive: true });
	writeJson(`${OUT_DIR}/formation/dolls.json`, formation.forms);
	writeJson(`${OUT_DIR}/formation/constants.json`, formation.constants);
	// The opposing side. Kept apart from the enemy archive's own files, which carry lore and rank bars the simulator never reads.
	writeJson(`${OUT_DIR}/formation/enemies.json`, { items: buildFormationEnemies(enemies) });

	// The story player. Written as a small chapter list, one file per chapter's mission list, and one file per scene, so opening a
	// scene fetches that scene alone rather than the chapter around it.
	const story = writeStory(upstream, upstreamDir);
	for (const name of new Set(story.missingScripts)) {
		ctx.warnings.push(`story script ${name} is listed by the game's index but is not in the upstream data`);
	}
	for (const [tag, count] of story.unknownTags) {
		ctx.warnings.push(`story tag <${tag}> is not recognised by the parser, seen ${count} time${count === 1 ? "" : "s"}`);
	}

	const { repo, sha } = readLock();
	const counts = {
		dolls: dolls.length,
		mods: dolls.filter((doll) => doll.mod).length,
		equipment: Object.values(equipment.items).flat().length,
		hocs: hocs.items.length,
		fairies: fairies.items.length,
		enemies: enemies.items.length,
		assimilation: assimilation.units.length,
		storyChapters: story.chapters,
		storyScenes: story.scenes
	};
	writeJson(`${OUT_DIR}/upstream.json`, { repo, sha, counts });

	execFileSync("node", ["tools/data/build_search_index.mjs"], { stdio: "inherit" });

	for (const warning of ctx.warnings) {
		console.warn(`warning: ${warning}`);
	}
	console.log(
		`dolls ${counts.dolls}, mods ${counts.mods}, equipment ${counts.equipment}, hocs ${counts.hocs}, fairies ${counts.fairies}, enemies ${counts.enemies}, assimilation ${counts.assimilation}, story ${counts.storyChapters} chapters / ${counts.storyScenes} scenes, warnings ${ctx.warnings.length}`
	);
	console.log(`profiles: ${profiles.joined} joined an IOPWiki page, ${profiles.wikidata} filled from Wikidata`);
}

await main();
