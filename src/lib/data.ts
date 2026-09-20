/**
 * The single place the app reads doll, equipment, HOC and Fairy data.
 *
 * Shards are fetched on demand so a route pays only for what it renders. Viewing one
 * doll fetches the shard holding it rather than all five, and the navbar, which renders on every
 * route, reads the small search index instead of the full dataset. That split is only possible
 * because the data modules no longer run `processData` at import time.
 *
 * The large files ship as plain JSON assets read with `fetch` rather than as dynamic imports. A browser remembers a failed dynamic import
 * for the rest of the session, so an import that fails once on a flaky connection could never be retried without a reload.
 */

import enemySearchIndexJson from "../data/enemy-search-index.json";
import fairySearchIndexJson from "../data/fairy-search-index.json";
import hocSearchIndexJson from "../data/hoc-search-index.json";
import searchIndexJson from "../data/search-index.json";
import type { AssimilationData, EnemyData, EnemyDetailsData } from "../types/enemy";
import type { Equipment, EquipmentType, RawEquipment } from "../types/equipment";
import type { FairyData } from "../types/fairy";
import type { FormationConstants, FormationData, FormationEnemy, FormationForm } from "../types/formation";
import type { HocData } from "../types/hoc";
import type { StoryChapter, StoryIndex, StoryScene } from "../types/story";
import type { Live2dIndex, Live2dMotion, Live2dTdollFile } from "../types/live2d";
import type { EnemySpineEntry, EnemySpineIndex, HocSpineEntry, HocSpineIndex, SpineDollEntry, SpineIndex } from "../types/spine";
import type { DollDetails, RawTDoll, TDoll, TDollWithDetails } from "../types/tdoll";
import { equipmentIconUrl } from "./assets";
import { hasDollArt, hasEquipmentIcon, processDoll, processDolls } from "./processData";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Types and module state

/** One entry in the lightweight search index. */
export interface SearchEntry {
	/** Doll id, shared by the base form and its Mod. */
	id: number;
	/** The base form's current name. */
	name: string;
	/** Doll type, such as "AR" or "HG". */
	type: string;
	/** Base form rarity, with 1 meaning the collaboration "Extra" rarity. */
	rarity: number;
	/** Names IOPWiki used before the 2026-09-13 upstream import renamed the doll, kept searchable. Absent when the name did not change. */
	aliases?: string[];
}

/** One HOC in its search index. */
export interface HocSearchEntry {
	/** HOC id, used in its page's address. */
	id: number;
	/** Official English name. */
	name: string;
}

/** One Fairy in its search index. */
export interface FairySearchEntry {
	/** Fairy id, used in its page's address. */
	id: number;
	/** Official English name. */
	name: string;
}

/** One enemy in its search index. Variants share a name, so only the first of each is indexed. */
export interface EnemySearchEntry {
	/** Enemy id, used in its page's address. */
	id: number;
	/** Official English name. */
	name: string;
}

/** One generated shard: the doll records every doll list reads, and the profile side file only the doll page reads. */
interface Shard {
	/** Highest doll id the shard holds. */
	max: number;
	/** Basename of the shard's doll records under `src/data/`. */
	file: string;
	/** Basename of the shard's profiles and spec sheets under `src/data/`, keyed by doll id. */
	profiles: string;
}

/**
 * Every doll's id and name, for search and navigation.
 *
 * Small enough to load eagerly on every route, unlike the full dataset.
 */
export const searchIndex: SearchEntry[] = searchIndexJson as SearchEntry[];

/** Every HOC's id and name, for the navbar search. */
export const hocSearchIndex: HocSearchEntry[] = hocSearchIndexJson as HocSearchEntry[];

/** Every Fairy's id and name, for the navbar search. */
export const fairySearchIndex: FairySearchEntry[] = fairySearchIndexJson as FairySearchEntry[];

/** Every distinctly named enemy's id and name, for the navbar search. */
export const enemySearchIndex: EnemySearchEntry[] = enemySearchIndexJson as EnemySearchEntry[];

/**
 * Hosted URLs of the large generated data files, keyed by their path from this module. Only the URLs are meant to be bundled, but
 * `hoc-spine-index.json` is small enough (under 4 KB) that Vite's default `assetsInlineLimit` inlines its contents here as a base64
 * `data:` URI instead of emitting it as its own asset - a pre-existing quirk, not something this glob's own patterns cause, and not
 * worth a `no-inline` query here since `fetchData` works the same either way. See `TDOLL_LIVE2D_DATA_URLS` below for a pattern where
 * that same inlining was a real problem worth avoiding.
 */
const EXISTING_DATA_URLS = import.meta.glob<string>(
	[
		"../data/dolls-*.json",
		"../data/profiles-*.json",
		"../data/spine-index.json",
		"../data/equipment.json",
		"../data/hocs.json",
		"../data/hoc-spine-index.json",
		"../data/fairies.json",
		"../data/enemies.json",
		"../data/enemy-details.json",
		"../data/assimilation.json",
		"../data/enemy-spine-index.json",
		"../data/live2d-index.json",
		"../data/story/index.json",
		"../data/story/chapter-*.json"
	],
	{
		query: "?url",
		import: "default",
		eager: true
	}
);

/**
 * Hosted URLs of the per-doll T-Doll skin Live2D motion files, keyed the same way as `EXISTING_DATA_URLS`.
 *
 * A separate glob because most of these files are small - the median real file is around 3 KB, under the 4 KB `assetsInlineLimit` that
 * every other file in `EXISTING_DATA_URLS` safely clears. Without `no-inline`, Vite would base64-inline a small doll's file straight
 * into this eagerly loaded module instead of emitting it as its own asset, defeating the point of splitting them out: the whole doll's
 * motions would ship on every page's initial bundle rather than being fetched only when a reader opens that doll's Live2D mode.
 * `no-inline` forces every matched file to stay a separate asset regardless of size, so this glob only ever costs a few bytes of URL
 * string per doll. The folder may not exist at all (nothing published yet), which a glob with no matches tolerates fine.
 */
const TDOLL_LIVE2D_DATA_URLS = import.meta.glob<string>("../data/live2d-tdolls/*.json", {
	query: "?url&no-inline",
	import: "default",
	eager: true
});

/**
 * Hosted URLs of the formation simulator's data files. `no-inline` keeps the small constants file from being base64-inlined into this
 * eagerly loaded module, so none of the simulator's data ships on other pages.
 */
const FORMATION_DATA_URLS = import.meta.glob<string>("../data/formation/*.json", {
	query: "?url&no-inline",
	import: "default",
	eager: true
});

/**
 * Hosted URLs of each story scene, resolved only when a scene is opened.
 *
 * Deliberately not eager, unlike every glob above. There are hundreds of scenes, and an eager glob would put every one of their URL
 * strings into this module, which other pages import - so reading one scene would cost every page on the site a little. Lazy keeps
 * that cost on the story player alone.
 */
const STORY_SCENE_URLS = import.meta.glob<string>("../data/story/scenes/*.json", { query: "?url&no-inline", import: "default" });

/** The eager URL maps above, merged under one lookup key so `fetchData` does not need to know they differ. */
const DATA_URLS: Record<string, string> = { ...EXISTING_DATA_URLS, ...TDOLL_LIVE2D_DATA_URLS, ...FORMATION_DATA_URLS };

/**
 * The generated data shards, in id order. This table mirrors `tools/data/lib/shards.mjs`.
 *
 * The collaboration dolls sit in the 1000 range, so the last shard catches everything above 999.
 */
const SHARDS: ReadonlyArray<Shard> = [
	{ max: 100, file: "dolls-1-100", profiles: "profiles-1-100" },
	{ max: 200, file: "dolls-101-200", profiles: "profiles-101-200" },
	{ max: 300, file: "dolls-201-300", profiles: "profiles-201-300" },
	{ max: 400, file: "dolls-301-400", profiles: "profiles-301-400" },
	{ max: 999, file: "dolls-401-999", profiles: "profiles-401-999" },
	{ max: Number.POSITIVE_INFINITY, file: "dolls-1000-1999", profiles: "profiles-1000-1999" }
];

/** Cache of in-flight and loaded shards, so a shard is fetched and processed at most once. A failed load is dropped so it can be retried. */
const shardCache = new Map<number, Promise<TDoll[]>>();

/** Cache of in-flight and loaded profile side files, so each is fetched at most once. A failed load is dropped so it can be retried. */
const detailsCache = new Map<number, Promise<Record<string, DollDetails>>>();

/** Cache of the in-flight or loaded Spine index, under the single key `0`. A failed load is dropped so it can be retried. */
const spineIndexCache = new Map<0, Promise<SpineIndex>>();

/** Cache of the in-flight or loaded equipment, under the single key `0`. A failed load is dropped so it can be retried. */
const equipmentCache = new Map<0, Promise<{ types: EquipmentType[]; items: Record<string, Equipment[]> }>>();

/** Cache of the in-flight or loaded HOCs, under the single key `0`. A failed load is dropped so it can be retried. */
const hocCache = new Map<0, Promise<HocData>>();

/** Cache of the in-flight or loaded story index, under the single key `0`. A failed load is dropped so it can be retried. */
const storyIndexCache = new Map<0, Promise<StoryIndex>>();

/** Cache of loaded chapters, keyed by chapter id. A failed load is dropped so it can be retried. */
const storyChapterCache = new Map<number, Promise<StoryChapter>>();

/** Cache of loaded scenes, keyed by script name. A failed load is dropped so it can be retried. */
const storySceneCache = new Map<string, Promise<StoryScene>>();

/** Cache of the in-flight or loaded HOC Spine index, under the single key `0`. A failed load is dropped so it can be retried. */
const hocSpineIndexCache = new Map<0, Promise<HocSpineIndex>>();

/** Cache of the in-flight or loaded Fairies, under the single key `0`. A failed load is dropped so it can be retried. */
const fairyCache = new Map<0, Promise<FairyData>>();

/** Cache of the in-flight or loaded enemies, under the single key `0`. A failed load is dropped so it can be retried. */
const enemyCache = new Map<0, Promise<EnemyData>>();

/** Cache of the in-flight or loaded enemy details, under the single key `0`. A failed load is dropped so it can be retried. */
const enemyDetailsCache = new Map<0, Promise<EnemyDetailsData>>();

/** Cache of the in-flight or loaded Protocol Assimilation units, under the single key `0`. A failed load is dropped so it can be retried. */
const assimilationCache = new Map<0, Promise<AssimilationData>>();

/** Cache of the in-flight or loaded enemy Spine index, under the single key `0`. A failed load is dropped so it can be retried. */
const enemySpineIndexCache = new Map<0, Promise<EnemySpineIndex>>();

/** Cache of the in-flight or loaded Live2D index, under the single key `0`. A failed load is dropped so it can be retried. */
const live2dIndexCache = new Map<0, Promise<Live2dIndex>>();

/** Cache of the in-flight or loaded formation data, under the single key `0`. A failed load is dropped so it can be retried. */
const formationCache = new Map<0, Promise<FormationData>>();

/**
 * Cache of in-flight and loaded T-Doll skin Live2D motion files, keyed by doll id. A doll with no file resolves to undefined and stays
 * cached that way, since a missing file never appears mid-session. A network failure is dropped so it can be retried.
 */
const skinLive2dTdollCache = new Map<number, Promise<Live2dTdollFile | undefined>>();

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Dolls

/**
 * Fetch one generated data file.
 *
 * @param name The file's basename under `src/data/`, such as `dolls-1-100`.
 * @returns The parsed JSON.
 * @throws When the file is not bundled, the request fails or the response is not OK.
 */
async function fetchData<T>(name: string): Promise<T> {
	const url = DATA_URLS[`../data/${name}.json`];
	if (url === undefined) {
		throw new Error(`${name}.json is not a bundled data file`);
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`${name}.json failed to load with HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

/**
 * Cache a load under a key, and forget it if it fails so a later call fetches again instead of reusing the rejection.
 *
 * @param cache The cache to store the load in.
 * @param key The cache key.
 * @param pending The load.
 * @returns The same load.
 */
function cacheUntilFailure<K, V>(cache: Map<K, Promise<V>>, key: K, pending: Promise<V>): Promise<V> {
	cache.set(key, pending);
	pending.catch(() => {
		if (cache.get(key) === pending) {
			cache.delete(key);
		}
	});
	return pending;
}

/**
 * Attach an equipment item's icon URL, shared by the Equipment Index list and a doll's exclusive equipment.
 *
 * @param item An equipment item from the generated data.
 * @returns A copy of the item with `image` set to its icon URL, or null when no icon is hosted yet.
 */
function withEquipmentIcon<T extends { id: number }>(item: T): T & { image: string | null } {
	return { ...item, image: hasEquipmentIcon(item.id) ? equipmentIconUrl(item.id) : null };
}

/**
 * Load and process one shard, reusing an earlier load when there is one.
 *
 * @param index Position in `SHARDS`.
 * @returns The shard's dolls, with assets resolved.
 */
function loadShard(index: number): Promise<TDoll[]> {
	const cached = shardCache.get(index);
	if (cached) {
		return cached;
	}
	const shard = SHARDS[index];
	if (!shard) {
		return Promise.resolve([]);
	}
	return cacheUntilFailure(shardCache, index, fetchData<RawTDoll[]>(shard.file).then(processDolls));
}

/**
 * Load one shard's profiles and spec sheets, reusing an earlier load when there is one.
 *
 * @param index Position in `SHARDS`.
 * @returns The shard's details, keyed by doll id.
 */
function loadShardDetails(index: number): Promise<Record<string, DollDetails>> {
	const cached = detailsCache.get(index);
	if (cached) {
		return cached;
	}
	const shard = SHARDS[index];
	if (!shard) {
		return Promise.resolve({});
	}
	return cacheUntilFailure(detailsCache, index, fetchData<Record<string, DollDetails>>(shard.profiles));
}

/**
 * Find which shard holds a doll.
 *
 * @param id Doll id.
 * @returns The index into `SHARDS`.
 */
function shardIndexFor(id: number): number {
	const found = SHARDS.findIndex((shard) => id <= shard.max);
	return found === -1 ? SHARDS.length - 1 : found;
}

/**
 * Load a single doll without its profile or spec sheets, for places such as the home carousel and the art viewer.
 *
 * Only the shard containing it is fetched, so opening one doll's page does not pull the other 250.
 *
 * @param id Doll id.
 * @returns The doll, or `undefined` when no doll has that id.
 */
export async function loadDoll(id: number): Promise<TDoll | undefined> {
	const dolls = await loadShard(shardIndexFor(id));
	return dolls.find((doll) => doll.normal.id === id);
}

/**
 * Load a single doll with its profile and spec sheets, for the doll page.
 *
 * The shard and its profile side file are fetched in parallel. Both are cached, so a later `loadDoll` or `loadAllDolls` reuses the shard.
 *
 * @param id Doll id.
 * @returns The doll with its details attached and its exclusive equipment icons resolved, or `undefined` when no doll has that id.
 * @throws When the shard or side file fails to load, or the doll exists but its side file has no entry for it, which `tools/data/check.mjs`
 *   guards against.
 */
export async function loadDollDetails(id: number): Promise<TDollWithDetails | undefined> {
	const index = shardIndexFor(id);
	const [dolls, details] = await Promise.all([loadShard(index), loadShardDetails(index)]);
	const doll = dolls.find((entry) => entry.normal.id === id);
	if (!doll) {
		return undefined;
	}
	const entry = details[String(id)];
	if (!entry) {
		throw new Error(`doll ${id} has no profile entry`);
	}
	return { ...doll, ...entry, exclusiveEquipment: entry.exclusiveEquipment.map(withEquipmentIcon) };
}

/**
 * Load every doll.
 *
 * Used by the index page, which genuinely renders all of them. Other routes should not call this. Profiles and spec sheets are left out.
 *
 * @returns Every doll, in shard order.
 */
export async function loadAllDolls(): Promise<TDoll[]> {
	const shards = await Promise.all(SHARDS.map((_, index) => loadShard(index)));
	return shards.flat();
}

/**
 * Ids of dolls whose art is hosted, for places that should only show dolls with artwork.
 *
 * @returns Doll ids whose base card is in the asset manifest.
 */
export function dollIdsWithArt(): number[] {
	return searchIndex.map((entry) => entry.id).filter((id) => hasDollArt(id));
}

/**
 * Process a raw doll without going through a shard.
 *
 * @param raw A raw doll record.
 * @returns The doll with assets resolved.
 */
export { processDoll };

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Spine

/**
 * Look up a doll's Spine rigs.
 *
 * The index runs to a few hundred KB and only the doll page reads it, so it is its own file, fetched once and cached. Paths inside it are
 * relative to the doll's Spine directory and are turned into URLs by `src/lib/assets.ts`.
 *
 * @param id Doll id.
 * @returns The doll's rigs, or undefined when nothing was published for it.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadSpineRigs(id: number): Promise<SpineDollEntry | undefined> {
	const index = await (spineIndexCache.get(0) ?? cacheUntilFailure(spineIndexCache, 0, fetchData<SpineIndex>("spine-index")));
	return index[String(id)];
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Equipment

/**
 * Load all equipment and its types.
 *
 * @returns Equipment types in display order, and items keyed by type key with icon URLs resolved.
 */
export async function loadEquipment(): Promise<{ types: EquipmentType[]; items: Record<string, Equipment[]> }> {
	const cached = equipmentCache.get(0);
	if (cached) {
		return cached;
	}
	return cacheUntilFailure(
		equipmentCache,
		0,
		fetchData<{ types: EquipmentType[]; items: Record<string, RawEquipment[]> }>("equipment").then((source) => {
			const items: Record<string, Equipment[]> = {};
			for (const [key, list] of Object.entries(source.items)) {
				items[key] = list.map(withEquipmentIcon);
			}
			return { types: source.types, items };
		})
	);
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// HOCs

/**
 * Load every HOC and the constants their stats are worked out from.
 *
 * @returns The HOC data, shared by the HOC Index and each HOC's page.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadHocs(): Promise<HocData> {
	return hocCache.get(0) ?? cacheUntilFailure(hocCache, 0, fetchData<HocData>("hocs"));
}

/**
 * Look up a HOC's Spine rigs.
 *
 * @param id HOC id.
 * @returns The HOC's combat and crew rigs, or undefined when nothing was published for it.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadHocSpineRigs(id: number): Promise<HocSpineEntry | undefined> {
	const index = await (hocSpineIndexCache.get(0) ?? cacheUntilFailure(hocSpineIndexCache, 0, fetchData<HocSpineIndex>("hoc-spine-index")));
	return index[String(id)];
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Fairies

/**
 * Load every Fairy, its talents and the constants their stats are worked out from.
 *
 * @returns The Fairy data, shared by the Fairy Index and each Fairy's page.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadFairies(): Promise<FairyData> {
	return fairyCache.get(0) ?? cacheUntilFailure(fairyCache, 0, fetchData<FairyData>("fairies"));
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Enemies

/**
 * Load every enemy in the archive and the faction names the index filters by.
 *
 * @returns The enemy records, shared by the Enemy Index and each enemy's page.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadEnemies(): Promise<EnemyData> {
	return enemyCache.get(0) ?? cacheUntilFailure(enemyCache, 0, fetchData<EnemyData>("enemies"));
}

/**
 * Load the lore, skills and stats that only an enemy's own page shows. Kept out of `enemies.json` so the index does not download it.
 *
 * @returns The details, keyed by stringified enemy id.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadEnemyDetails(): Promise<EnemyDetailsData> {
	return enemyDetailsCache.get(0) ?? cacheUntilFailure(enemyDetailsCache, 0, fetchData<EnemyDetailsData>("enemy-details"));
}

/**
 * Load the Protocol Assimilation units. Only the pages of capturable enemies ask for this, so an ordinary enemy never fetches it.
 *
 * @returns The playable units, their classes, growth constants and strategic chips.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadAssimilation(): Promise<AssimilationData> {
	return assimilationCache.get(0) ?? cacheUntilFailure(assimilationCache, 0, fetchData<AssimilationData>("assimilation"));
}

/**
 * Look up an enemy's Spine rig.
 *
 * @param id Enemy id.
 * @returns The enemy's combat rig, or undefined when nothing was published for it.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadEnemySpineRigs(id: number): Promise<EnemySpineEntry | undefined> {
	const index = await (enemySpineIndexCache.get(0) ?? cacheUntilFailure(enemySpineIndexCache, 0, fetchData<EnemySpineIndex>("enemy-spine-index")));
	return index[String(id)];
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Live2D

/**
 * Look up a fairy's Live2D motions.
 *
 * @param id Fairy id.
 * @returns The fairy's motions, or undefined when nothing was published for it.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadFairyLive2dMotions(id: number): Promise<Live2dMotion[] | undefined> {
	const index = await (live2dIndexCache.get(0) ?? cacheUntilFailure(live2dIndexCache, 0, fetchData<Live2dIndex>("live2d-index")));
	return index.fairies[String(id)]?.motions;
}

/**
 * Look up a HOC's Live2D motions.
 *
 * @param id HOC id.
 * @returns The HOC's motions, or undefined when nothing was published for it.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadHocLive2dMotions(id: number): Promise<Live2dMotion[] | undefined> {
	const index = await (live2dIndexCache.get(0) ?? cacheUntilFailure(live2dIndexCache, 0, fetchData<Live2dIndex>("live2d-index")));
	return index.hocs[String(id)]?.motions;
}

/**
 * Fetch one doll's T-Doll skin Live2D motions file.
 *
 * @param dollId The doll's base id.
 * @returns The doll's motions file, or undefined when the doll has no such file bundled at all - not every doll has one, unlike the
 *   other generated data files this module reads.
 * @throws When the file is bundled but the request fails or the response is not OK.
 */
async function fetchSkinLive2dTdollFile(dollId: number): Promise<Live2dTdollFile | undefined> {
	const url = DATA_URLS[`../data/live2d-tdolls/${dollId}.json`];
	if (url === undefined) {
		return undefined;
	}
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`live2d-tdolls/${dollId}.json failed to load with HTTP ${response.status}`);
	}
	return (await response.json()) as Live2dTdollFile;
}

/**
 * Look up one T-Doll skin variant's Live2D motions.
 *
 * Only fetches the one doll's own motion file, cached per doll, rather than the shared index - the motions for every doll's every skin
 * would be hundreds of KB if they all shipped in one file every doll page paid for.
 *
 * @param dollId The doll's base id.
 * @param form `base` or `mod`, the doll form the model belongs to.
 * @param skinKey `base` for the form's own art, or the skin id as a string.
 * @param variant `normal` or `damaged`.
 * @returns The variant's motions, or undefined when nothing was published for it.
 * @throws When the doll's file is bundled but fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadSkinLive2dMotions(dollId: number, form: string, skinKey: string, variant: string): Promise<Live2dMotion[] | undefined> {
	const file = await (skinLive2dTdollCache.get(dollId) ?? cacheUntilFailure(skinLive2dTdollCache, dollId, fetchSkinLive2dTdollFile(dollId)));
	return file?.[form]?.[skinKey]?.[variant]?.motions;
}

/**
 * Look up which form, skin and variant combinations have a published Live2D model for a doll, without loading any motions.
 *
 * Reads the shared index's `tdolls` block, which is availability only - safe to load on every doll page, unlike the per-doll motion
 * files `loadSkinLive2dMotions` fetches on demand.
 *
 * @param dollId The doll's base id.
 * @returns The doll's forms, each mapping a skin key to the variant names it has (`normal`, `damaged`, or both), or undefined when the
 *   doll has no T-Doll skin Live2D models at all.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadSkinLive2dForms(dollId: number): Promise<Record<string, Record<string, string[]>> | undefined> {
	const index = await (live2dIndexCache.get(0) ?? cacheUntilFailure(live2dIndexCache, 0, fetchData<Live2dIndex>("live2d-index")));
	return index.tdolls?.[String(dollId)];
}

/** Which fairies, HOCs and T-Dolls have a Live2D model, for the index pages' Live2D filter chips. */
export interface Live2dAvailability {
	/** Ids of every Fairy with a Live2D model. */
	fairyIds: Set<number>;
	/** Ids of every HOC with a Live2D model. */
	hocIds: Set<number>;
	/** Ids of every T-Doll with a Live2D model in at least one form. */
	tdollIds: Set<number>;
	/** Ids of every T-Doll whose Mod form specifically has a Live2D model. */
	tdollModIds: Set<number>;
}

/**
 * Look up which fairies, HOCs and T-Dolls have a Live2D model.
 *
 * The index's `tdolls` block is only present once the T-Doll models are published, so `tdollIds` and `tdollModIds` come back
 * empty on an older index rather than throwing.
 *
 * @returns The id sets the Live2D filter chips match against.
 * @throws When the index fails to load. The failed load is not cached, so a later call tries again.
 */
export async function loadLive2dAvailability(): Promise<Live2dAvailability> {
	const index = await (live2dIndexCache.get(0) ?? cacheUntilFailure(live2dIndexCache, 0, fetchData<Live2dIndex>("live2d-index")));
	const tdollIds = new Set<number>();
	const tdollModIds = new Set<number>();
	for (const [id, forms] of Object.entries(index.tdolls ?? {})) {
		tdollIds.add(Number(id));
		if (forms.mod) {
			tdollModIds.add(Number(id));
		}
	}
	return {
		fairyIds: new Set(Object.keys(index.fairies).map(Number)),
		hocIds: new Set(Object.keys(index.hocs).map(Number)),
		tdollIds,
		tdollModIds
	};
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Formation simulator

/**
 * Load the formation simulator's forms, constants and enemies.
 *
 * The three are fetched together rather than separately, since the page draws both sides of the fight at once and has nothing to
 * show until it has all of them.
 *
 * @returns The formation data.
 * @throws When any of the files fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadFormationData(): Promise<FormationData> {
	const load = async (): Promise<FormationData> => {
		const [forms, constants, enemies] = await Promise.all([
			fetchData<Record<string, FormationForm>>("formation/dolls"),
			fetchData<FormationConstants>("formation/constants"),
			fetchData<{ items: FormationEnemy[] }>("formation/enemies")
		]);
		return { forms, constants, enemies: enemies.items };
	};
	return formationCache.get(0) ?? cacheUntilFailure(formationCache, 0, load());
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Story

/**
 * Turn a script name into the filename its scene was written under.
 *
 * Mirrors `sceneFile` in `tools/story/build_story.mjs`. A couple of script names carry a folder part, and a slash cannot go in a
 * filename, so it becomes a double underscore - no script name contains one, which keeps the mapping reversible.
 *
 * @param name The script name, such as `0-1-1`.
 * @returns The filename stem.
 */
function sceneFile(name: string): string {
	return name.replace(/\//g, "__").toLowerCase();
}

/**
 * Load the list of story chapters. Small enough to fetch before a reader has chosen anything.
 *
 * @returns The chapters in menu order, without their missions.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadStoryIndex(): Promise<StoryIndex> {
	return storyIndexCache.get(0) ?? cacheUntilFailure(storyIndexCache, 0, fetchData<StoryIndex>("story/index"));
}

/**
 * Load one chapter's mission list.
 *
 * @param id The chapter id from the story index.
 * @returns The chapter's missions in order.
 * @throws When the file fails to load. The failed load is not cached, so a later call tries again.
 */
export function loadStoryChapter(id: number): Promise<StoryChapter> {
	return storyChapterCache.get(id) ?? cacheUntilFailure(storyChapterCache, id, fetchData<StoryChapter>(`story/chapter-${id}`));
}

/**
 * Load one scene's beats.
 *
 * The scene URLs are behind a lazy glob, so this resolves the URL before fetching it rather than reading it from a map.
 *
 * @param name The script name from a mission's `scripts` list.
 * @returns The scene.
 * @throws When the scene is not a bundled file, or the fetch fails. A failed load is not cached, so a later call tries again.
 */
export function loadStoryScene(name: string): Promise<StoryScene> {
	const load = async (): Promise<StoryScene> => {
		const resolve = STORY_SCENE_URLS[`../data/story/scenes/${sceneFile(name)}.json`];
		if (resolve === undefined) {
			throw new Error(`story scene ${name} is not a bundled data file`);
		}
		const response = await fetch(await resolve());
		if (!response.ok) {
			throw new Error(`story scene ${name} failed to load with HTTP ${response.status}`);
		}
		return (await response.json()) as StoryScene;
	};
	return storySceneCache.get(name) ?? cacheUntilFailure(storySceneCache, name, load());
}
