import { buildMissionSkill, buildSkill, skillRowsExist } from "./skills.mjs";
import { cleanName, stripMarkup } from "./text.mjs";
import { configValue } from "./upstream.mjs";

/** Faction names by `enemy_illustration.forces`, in the order the index lists them. Anything with no faction is grouped as Other. */
const FACTIONS = [
	{ forces: 1, name: "Sangvis Ferri" },
	{ forces: 2, name: "KCCO" },
	{ forces: 3, name: "Paradeus" },
	{ forces: 0, name: "Other" }
];

/** Upstream rank fields to the site's rank keys, in display order. Each one is a bar the game's archive draws, not a real stat. */
const RANK_FIELDS = {
	pow_rank: "power",
	life_rank: "health",
	hit_rank: "accuracy",
	dodge_rank: "evasion",
	rate_rank: "rateOfFire",
	armor_rank: "armor",
	speed_rank: "speed",
	range_rank: "range",
	tenacity_rank: "tenacity"
};

/** Upstream `enemy_character_type` fields to the site's stat keys, in display order. */
const STAT_FIELDS = {
	maxlife: "hp",
	pow: "damage",
	hit: "accuracy",
	dodge: "evasion",
	rate: "rateOfFire",
	armor: "armor",
	armor_piercing: "armorPiercing",
	range: "range",
	speed: "speed",
	number: "number"
};

/** The `enemy_illustration.type` that marks the named boss and Ringleader tier. The other values are mob tiers the game never gives names to. */
const BOSS_TYPE = 1;

/**
 * The level a canonical archive row carries. The same enemy also has per-mode deployment rows whose `level` is an encoded marker
 * such as 10100 or 30100, and training targets with rows that only differ in HP. Those are not what the archive shows.
 */
const ARCHIVE_LEVEL = 100;

/** Fewer enemies than this means the archive table or the join went wrong. */
const MIN_ENEMIES = 300;

/**
 * Class names by `sangvis.type`, which is also the `sangvis_type` id. Upstream only names the last two in Chinese, so the English
 * names come from IOPWiki instead. The capture rates on `sangvis_type` line up with them: 25%, 50% and 100% in this order.
 */
const ASSIMILATION_CLASSES = { 1: "Ringleader", 2: "Elite", 3: "Basic" };

/** Upstream `sangvis` ratio fields to the site's stat keys, in display order. Each is a percentage against the class's base rate. */
const RATIO_FIELDS = {
	ratio_hp: "hp",
	ratio_pow: "damage",
	ratio_hit: "accuracy",
	ratio_dodge: "evasion",
	ratio_rate: "rateOfFire",
	ratio_armor: "armor"
};

/**
 * The `sangvis` skill fields, in the order a unit's page lists them and in the order `sangvis_type.skills_max_lv` counts them.
 * A class whose `skills_max_lv` entry is zero does not have that slot at all, which is how an Elite ends up with only the last two.
 */
const SKILL_FIELDS = ["skill1", "skill2", "skill3", "skill_advance"];

/**
 * `sangvis` ids at or above this are display-only duplicates of a unit a player really owns. They carry no skills and share their
 * family with a real row, so keeping them would double up every Ringleader.
 */
const DISPLAY_ONLY_SANGVIS_ID = 9000;

/** Fewer playable units than this means the `sangvis` table or its text did not load. */
const MIN_ASSIMILATION_UNITS = 50;

/**
 * Pick the stat row that stands for one enemy. Preference goes to the lowest-numbered row at the archive level, which for regular
 * mobs is the 10000-series base unit. Anything else falls back to the lowest-numbered row of any level.
 *
 * These are base deployment values, not the numbers a player meets on a map. The same enemy also has per-mode rows that scale them,
 * so the archive's own rank bars are the honest way to compare two enemies and these numbers are only a starting point.
 *
 * @param {object[]} rows The `enemy_character_type` rows joined to this enemy, in any order.
 * @returns {object | null} The canonical row, or null when the enemy has no stat row at all.
 */
export function canonicalStatRow(rows) {
	if (rows.length === 0) {
		return null;
	}
	const atArchiveLevel = rows.filter((row) => row.level === ARCHIVE_LEVEL);
	return (atArchiveLevel.length > 0 ? atArchiveLevel : rows).reduce((best, row) => (row.id < best.id ? row : best));
}

/**
 * Build every enemy in the game's archive, split into the records the index needs and the details only a page needs.
 *
 * Enemies are keyed by `sub_id` rather than `id`, since that is what is unique across the table and what the stat rows join on.
 * A family such as Scarecrow carries several sub ids, one per variant, and each becomes its own record.
 *
 * Every enemy ships. `enemy_illustration.launch_time` looks like a release date but only ever holds the game's launch date or a
 * 2035 placeholder, so it says nothing about whether an enemy is live and is not used as a filter.
 *
 * @param {ReturnType<import("./upstream.mjs").loadUpstream>} upstream Upstream readers.
 * @param {string[]} warnings Collected warnings, appended to in place.
 * @returns {{ factions: string[], items: object[], details: Record<string, object> }} Faction names in display order, the index records, and the page details by id.
 * @throws {Error} When an enemy has no name, or fewer than `MIN_ENEMIES` enemies are built.
 */
export function buildEnemies(upstream, warnings) {
	// The game ships the same mapping as `sangvis_forces`, so a shifted id shows up here rather than silently mislabelling a faction.
	const configured = upstream.catchdata("game_config_info").find((row) => row.parameter_name === "sangvis_forces")?.parameter_value ?? "";
	for (const pair of configured.split(",")) {
		const [forces, label] = pair.split(":");
		if (label !== undefined && !FACTIONS.some((entry) => entry.forces === Number(forces))) {
			warnings.push(`game_config_info sangvis_forces has faction ${forces} (${label}) that the enemy index does not know about`);
		}
	}

	const organisations = new Map(upstream.stc("organization").map((row) => [row.id, cleanName(upstream.t(row.name))]));
	const skills = new Map(upstream.stc("enemy_illustration_skill").map((row) => [row.id, { name: cleanName(upstream.t(row.name)), description: stripMarkup(upstream.t(row.description)).trim() }]));

	// Captured units come from `sangvis`, which points back at an enemy family. `if_capture` says the same thing, and the two are
	// cross-checked below rather than one being trusted on its own.
	const capturedFamilies = new Set(playableSangvis(upstream).map((row) => row.illustration_id));

	const illustrations = upstream.stc("enemy_illustration");
	const knownSubIds = new Set(illustrations.map((row) => row.sub_id));

	const statRows = new Map();
	let orphanStatRows = 0;
	for (const row of upstream.stc("enemy_character_type")) {
		const subId = row.enemy_illustration_sub_id;
		if (!subId) {
			continue;
		}
		if (!knownSubIds.has(subId)) {
			orphanStatRows += 1;
			continue;
		}
		if (!statRows.has(subId)) {
			statRows.set(subId, []);
		}
		statRows.get(subId).push(row);
	}
	if (orphanStatRows > 0) {
		warnings.push(`enemy_character_type has ${orphanStatRows} rows pointing at an enemy_illustration_sub_id that does not exist`);
	}

	const flaggedFamilies = new Set(illustrations.filter((row) => row.if_capture === 1).map((row) => row.id));
	const disagreements = [...flaggedFamilies].filter((id) => !capturedFamilies.has(id)).concat([...capturedFamilies].filter((id) => !flaggedFamilies.has(id)));
	if (disagreements.length > 0) {
		warnings.push(`enemy_illustration if_capture and sangvis disagree on ${disagreements.length} families: ${disagreements.join(", ")}`);
	}

	const items = [];
	const details = {};
	for (const row of illustrations) {
		const name = cleanName(upstream.t(row.name));
		if (name === "") {
			throw new Error(`enemy ${row.sub_id} is missing its name text`);
		}
		const statRow = canonicalStatRow(statRows.get(row.sub_id) ?? []);
		const subName = cleanName(upstream.t(row.sub_name));
		items.push({
			id: row.sub_id,
			familyId: row.id,
			name,
			code: row.code,
			faction: FACTIONS.find((entry) => entry.forces === row.forces)?.name ?? "Other",
			boss: row.type === BOSS_TYPE,
			capturable: capturedFamilies.has(row.id),
			ranks: Object.fromEntries(Object.entries(RANK_FIELDS).map(([field, key]) => [key, row[field] ?? 0]))
		});
		details[row.sub_id] = {
			// Only worth carrying when it differs from the name, which it usually does not.
			subName: subName === name ? null : subName,
			introduce: stripMarkup(upstream.t(row.introduce)).trim(),
			counter: stripMarkup(upstream.t(row.counter)).trim(),
			// `extra` holds the voice actor wrapped in separators, which `unescapeText` has already turned into commas.
			voiceActor: cleanName(upstream.t(row.extra).replaceAll(",", " ")),
			organisation: organisations.get(row.org_id) ?? null,
			baseStats: statRow === null ? null : Object.fromEntries(Object.entries(STAT_FIELDS).map(([field, key]) => [key, statRow[field] ?? 0])),
			baseStatsLevel: statRow?.level ?? null,
			skills: String(row.enemy_skill ?? "")
				.split(",")
				.map((id) => skills.get(Number(id)))
				.filter((skill) => skill !== undefined && skill.name !== "")
		};
	}

	if (items.length < MIN_ENEMIES) {
		throw new Error(`expected at least ${MIN_ENEMIES} enemies, found ${items.length}`);
	}

	const withoutStats = items.filter((item) => details[item.id].baseStats === null);
	if (withoutStats.length > 0) {
		warnings.push(`${withoutStats.length} enemies have no stat row: ${withoutStats.map((item) => item.name).join(", ")}`);
	}

	const factions = FACTIONS.map((entry) => entry.name).filter((label) => items.some((item) => item.faction === label));
	return { factions, items, details };
}

/**
 * Enemy ids the game ships no portrait for at all, so the art check does not report them. Erma's Dummy is a training target that has no
 * character bundle of its own.
 */
const ENEMIES_WITHOUT_ART = new Set([232001]);

/**
 * Compare the enemies with the v3 asset manifest's `enemies` key. An absent or empty `enemies` key means the manifest has not
 * been extended for enemy art yet, so nothing is reported.
 *
 * @param {{ id: number, name: string }[]} enemies Generated enemy records.
 * @param {{ enemies?: Record<string, string[]> }} manifest The v3 asset manifest.
 * @returns {string[]} Names of enemies missing their card art, once the manifest lists any enemy, ignoring the ones the game ships none for.
 */
export function findEnemyArtGaps(enemies, manifest) {
	const entries = manifest.enemies ?? {};
	if (Object.keys(entries).length === 0) {
		return [];
	}
	return enemies.filter((enemy) => !ENEMIES_WITHOUT_ART.has(enemy.id) && !(entries[String(enemy.id)] ?? []).includes("card")).map((enemy) => enemy.name);
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Protocol Assimilation

/**
 * Build the Protocol Assimilation units: the enemies a player can capture and field themselves.
 *
 * Stats ship as the game's inputs rather than as numbers. A unit's displayed stat depends on its level, its star rank, its size
 * and its affection, and that combination has not been checked against a reliable source, so nothing here pretends to be a
 * finished stat line. What is shipped is exact: the class's base rates, the star multipliers and the unit's own percentages.
 *
 * @param {ReturnType<import("./upstream.mjs").loadUpstream>} upstream Upstream readers.
 * @param {string[]} warnings Collected warnings, appended to in place.
 * @returns {{ classes: string[], constants: object, chips: object[], units: object[] }} The class names, growth constants, strategic chips and units.
 * @throws {Error} When a unit has no name, a class has no `sangvis_type` row, or fewer than `MIN_ASSIMILATION_UNITS` units are built.
 */
export function buildAssimilation(upstream, warnings) {
	const traits = new Map(upstream.stc("sangvis_character_type").map((row) => [row.id, cleanName(upstream.t(row.name))]));

	const classes = {};
	const skillLevelsByType = new Map();
	for (const row of upstream.stc("sangvis_type")) {
		const name = ASSIMILATION_CLASSES[row.id];
		if (name === undefined) {
			warnings.push(`sangvis_type ${row.id} (${row.name}) has no class name`);
			continue;
		}
		const skillLevels = String(row.skills_max_lv)
			.split(",")
			.map(Number)
			.map((level) => (Number.isFinite(level) ? level : 0));
		classes[name] = {
			baseRates: { hp: row.basic_hp, damage: row.basic_pow, accuracy: row.basic_hit, evasion: row.basic_dodge, rateOfFire: row.basic_rate, armor: row.basic_armor },
			// Upstream stores both rates per ten thousand, so 2500 is the 25% the game shows for a Ringleader.
			captureRate: row.daily_successr / 100,
			guaranteedRate: row.author_successr / 100,
			// Kept with its zeros, since a zero is what lines the array up against `SKILL_FIELDS` and marks a slot the class lacks.
			skillLevels
		};
		skillLevelsByType.set(row.id, skillLevels);
	}
	for (const name of Object.values(ASSIMILATION_CLASSES)) {
		if (!classes[name]) {
			throw new Error(`sangvis_type has no row for the ${name} class`);
		}
	}

	const advance = upstream.stc("sangvis_advance").sort((a, b) => a.lv - b.lv);
	const constants = {
		maxLevel: Number(configValue(upstream, "sangvis_lv_max")),
		baseLevel: Number(configValue(upstream, "sangvis_base_lv")),
		starUnlockLevels: advance.map((row) => row.unlock_lv),
		starRates: advance.map((row) => ({
			hp: row.advance_hp,
			damage: row.advance_pow,
			accuracy: row.advance_hit,
			evasion: row.advance_dodge,
			rateOfFire: row.advance_rate,
			armor: row.advance_armor
		})),
		classes
	};

	// One chip ships with text keys that the text table has no entry for, so it never appears in game and is dropped here too.
	const allChips = upstream.stc("sangvis_chip").map((row) => ({ id: row.id, name: cleanName(upstream.t(row.name)), description: stripMarkup(upstream.t(row.des)).trim(), type: row.type }));
	const chips = allChips.filter((chip) => chip.name !== "" && chip.description !== "");
	if (chips.length < allChips.length) {
		warnings.push(
			`${allChips.length - chips.length} strategic chips have no text: ${allChips
				.filter((chip) => !chips.includes(chip))
				.map((chip) => chip.id)
				.join(", ")}`
		);
	}

	const unresolvedSkills = [];
	const units = playableSangvis(upstream)
		.sort((a, b) => a.id - b.id)
		.map((row) => {
			const name = cleanName(upstream.t(row.name)) || cleanName(row.en_name);
			if (name === "") {
				throw new Error(`sangvis ${row.id} is missing its name text`);
			}
			const className = ASSIMILATION_CLASSES[row.type];
			if (className === undefined) {
				throw new Error(`sangvis ${row.id} ${name} has an unknown type ${row.type}`);
			}
			return {
				id: row.id,
				familyId: row.illustration_id,
				name,
				code: row.code,
				className,
				stars: row.rank,
				traits: splitIds(row.character)
					.map((id) => traits.get(id))
					.filter((label) => label !== undefined && label !== ""),
				introduce: stripMarkup(upstream.t(row.introduce)).trim(),
				ratios: Object.fromEntries(Object.entries(RATIO_FIELDS).map(([field, key]) => [key, row[field] ?? 0])),
				armorPiercing: row.armor_piercing,
				crit: row.crit,
				critDamage: row.crit_dmg,
				apCost: row.ap_cost,
				// Ringleaders are the only class with strategic chip slots, and each slot takes its own set of chip types.
				chipSlots: className === "Ringleader" ? [splitIds(row.type_chip1), splitIds(row.type_chip2), splitIds(row.type_chip3)].filter((slot) => slot.length > 0) : [],
				skills: SKILL_FIELDS.map((field, slot) => skillOrNull(upstream, row, field, skillLevelsByType.get(row.type)?.[slot] ?? 0, unresolvedSkills, warnings)).filter((skill) => skill !== null)
			};
		});

	if (units.length < MIN_ASSIMILATION_UNITS) {
		throw new Error(`expected at least ${MIN_ASSIMILATION_UNITS} Protocol Assimilation units, found ${units.length}`);
	}
	if (unresolvedSkills.length > 0) {
		warnings.push(`${unresolvedSkills.length} Protocol Assimilation skill slots have no text in any skill table: ${unresolvedSkills.join(", ")}`);
	}

	return { classes: Object.values(ASSIMILATION_CLASSES), constants, chips, units };
}

/**
 * The `sangvis` rows a player can actually own, one per capturable enemy family.
 *
 * @param {ReturnType<import("./upstream.mjs").loadUpstream>} upstream Upstream readers.
 * @returns {object[]} The playable rows.
 */
function playableSangvis(upstream) {
	return upstream.stc("sangvis").filter((row) => row.id < DISPLAY_ONLY_SANGVIS_ID);
}

/**
 * Split a comma-separated id list into numbers, dropping anything empty or zero.
 *
 * @param {string | number} value The raw field, such as `1,2,3`.
 * @returns {number[]} The ids.
 */
function splitIds(value) {
	return String(value ?? "")
		.split(",")
		.map(Number)
		.filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * Build one of a unit's skills. A slot the unit's class does not have, or one whose skill has no rows upstream, is recorded as
 * unresolved rather than failing the import.
 *
 * `skill2` is the odd one out: when `skill2_type` is 2 it is a mission skill rather than a battle skill, the same split the
 * strategy fairies have. When it is 3 it points at an id no skill table holds text for, which is what the check below catches.
 *
 * @param {ReturnType<import("./upstream.mjs").loadUpstream>} upstream Upstream readers.
 * @param {object} row The `sangvis` row.
 * @param {string} field The skill field to read.
 * @param {number} levelCount How many level rows this slot has for the unit's class, or 0 when the class has no such slot.
 * @param {string[]} unresolved Slots with no skill text, appended to in place as `id field`.
 * @param {string[]} warnings Collected warnings, appended to in place.
 * @returns {object | null} The skill, or null when the slot is empty or the skill has no text.
 */
function skillOrNull(upstream, row, field, levelCount, unresolved, warnings) {
	const id = Number(row[field]);
	if (levelCount <= 0 || !Number.isInteger(id) || id <= 0) {
		return null;
	}
	const mission = field === "skill2" && row.skill2_type === 2;
	if (!mission && !skillRowsExist(upstream, id, levelCount)) {
		unresolved.push(`${row.id} ${field}`);
		return null;
	}
	const skill = mission ? buildMissionSkill(upstream, id) : buildSkill(upstream, id, warnings, levelCount);
	if (skill.name === "") {
		unresolved.push(`${row.id} ${field}`);
		return null;
	}
	return { slot: field, ...skill };
}
