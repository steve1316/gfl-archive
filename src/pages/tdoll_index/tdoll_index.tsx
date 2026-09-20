import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";

// Component imports
import LoadError from "../../components/LoadError";
import ScrollToTop from "../../components/ScrollToTop";
import FilterPanel from "../../components/FilterPanel";
import DollCard from "../../components/DollCard";
import DollFilterRows from "./DollFilterRows";
import IndexSummaryBar from "../../components/IndexSummaryBar";
import type { SortOption } from "../../components/IndexSummaryBar";

// MaterialUI imports
import { Box, Container, Grid, Divider, Button } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import { loadAllDolls, searchIndex } from "../../lib/data";
import { matchesAnyName, normaliseName } from "../../lib/nameSearch";
import { formatBuildTimeQuery, isIncompleteBuildTime, matchesBuildTime, parseBuildTime } from "../../lib/buildTime";
import { useLive2dAvailability } from "../../lib/useLive2dAvailability";
import type { TDoll, TDollForm } from "../../types/tdoll";

/** How many dolls one page of results holds. */
const PAGE_SIZE = 30;

/** Old IOPWiki names by doll id, from the search index, so a doll stays findable by the name it had before upstream renamed it. */
const ALIASES_BY_ID = new Map(searchIndex.map((entry) => [entry.id, entry.aliases ?? []]));

/** What the results can be sorted by. */
type SortKey = "id" | "name" | "rarity" | "release" | "buildTime";

/** The sort menu's entries, in menu order. */
const SORT_OPTIONS: SortOption<SortKey>[] = [
	{ value: "id", label: "ID" },
	{ value: "name", label: "Name" },
	{ value: "rarity", label: "Rarity" },
	{ value: "release", label: "Global release" },
	{ value: "buildTime", label: "Build time" }
];

/** Compares names so digits order by value, putting "9A-91" before "43M", and case is ignored. Built once rather than per comparison. */
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** A doll paired with the form the current filters mean we should show. */
interface IndexEntry extends TDoll {
	/** Either the base form or the Mod, depending on the Mod filter. */
	selected: TDollForm;
}

/**
 * Whether a value is one of the sort keys, for sort choices read back from session storage.
 *
 * @param value The stored value.
 * @returns True when it names a sort key.
 */
function isSortKey(value: unknown): value is SortKey {
	return SORT_OPTIONS.some((option) => option.value === value);
}

/**
 * Sort the matching dolls. Ties fall back to ascending id, and dolls with no known Global release date or build time stay last in either direction.
 *
 * @param entries The matching dolls, left unchanged.
 * @param key What to sort by. Name and rarity come from the shown form, so a Mod counts as 6 stars while the Mod filter is on.
 * @param descending Whether to reverse the order.
 * @returns A sorted copy, or `entries` itself when the order asked for is ascending id, which it is already in.
 */
function sortEntries(entries: IndexEntry[], key: SortKey, descending: boolean): IndexEntry[] {
	// The shards are already in ascending id order, and filtering keeps it.
	if (key === "id" && !descending) {
		return entries;
	}
	const direction = descending ? -1 : 1;
	return [...entries].sort((a, b) => {
		let order: number;
		switch (key) {
			case "name":
				order = NAME_COLLATOR.compare(a.selected.name, b.selected.name);
				break;
			case "rarity":
				order = a.selected.rarity - b.selected.rarity;
				break;
			case "release": {
				// Decided before the direction applies, so dolls with no known date stay last either way.
				const missing = Number(a.release.date === null) - Number(b.release.date === null);
				if (missing !== 0) {
					return missing;
				}
				// ISO dates compare as text. A month-precision date sorts before the days of that month.
				const aDate = a.release.date ?? "";
				const bDate = b.release.date ?? "";
				order = aDate < bDate ? -1 : aDate > bDate ? 1 : 0;
				break;
			}
			case "buildTime": {
				// Decided before the direction applies, so dolls whose production never gives them stay last either way.
				const missing = Number(a.production === null) - Number(b.production === null);
				if (missing !== 0) {
					return missing;
				}
				order = (a.production?.seconds ?? 0) - (b.production?.seconds ?? 0);
				break;
			}
			case "id":
				order = a.normal.id - b.normal.id;
				break;
		}
		return direction * order || a.normal.id - b.normal.id;
	});
}

const styles = {
	root: { py: 3 },
	summaryContainer: { pt: 2 },
	cardGrid: {
		pt: 4,
		pb: 8,
		minWidth: "70%"
	},
	topDividerForCards: {
		marginTop: "10px",
		marginBottom: "25px"
	},
	bottomDividerForCards: {
		marginTop: "25px",
		marginBottom: "10px"
	}
} satisfies Record<string, SxProps<Theme>>;

export default function TDoll_Index() {
	const [allDolls, setAllDolls] = useState<TDoll[]>([]);
	// True when a doll shard failed to load, which swaps the results for a retry notice.
	const [loadFailed, setLoadFailed] = useState(false);
	// Bumped by the retry button to load the shards again. Shards that did load stay cached.
	const [loadAttempt, setLoadAttempt] = useState(0);

	const [rarityFilter, setRarityFilter] = useState([
		{ key: 0, label: "General", rarity: 2, selected: false },
		{ key: 1, label: "Rare", rarity: 3, selected: false },
		{ key: 2, label: "Epochal", rarity: 4, selected: false },
		{ key: 3, label: "Legendary", rarity: 5, selected: false },
		{ key: 4, label: "Extra", rarity: 1, selected: false }
	]);

	const [typeFilter, setTypeFilter] = useState([
		{ key: 0, label: "HG", selected: false },
		{ key: 1, label: "SMG", selected: false },
		{ key: 2, label: "RF", selected: false },
		{ key: 3, label: "AR", selected: false },
		{ key: 4, label: "MG", selected: false },
		{ key: 5, label: "SG", selected: false }
	]);

	const [modFilter, setModFilter] = useState({
		key: 0,
		label: "MOD",
		selected: false
	});

	const [live2dFilter, setLive2dFilter] = useState({
		key: 0,
		label: "Live2D",
		selected: false
	});

	// Fetched only once the Live2D filter is switched on, whether by a click or by a saved filter restoring it already on.
	const live2dAvailability = useLive2dAvailability(live2dFilter.selected);

	/** How many results are on screen. Raised by the load-more button rather than by paging. */
	const [shown, setShown] = useState(PAGE_SIZE);

	/** What the results are sorted by, and whether the order is reversed. Not reset by Clear all, since it is not a filter. */
	const [sortKey, setSortKey] = useState<SortKey>("id");
	const [sortDescending, setSortDescending] = useState(false);

	/**
	 * The dolls matching the current filters.
	 *
	 * This used to be built inside an effect that stored rendered JSX elements in state, so every filter
	 * change re-rendered the whole list twice and the element array was a second copy of the data.
	 */
	/** What the reader has typed into the name search. */
	const [nameQuery, setNameQuery] = useState("");
	/** What the reader has typed into the build time search. */
	const [buildTimeText, setBuildTimeText] = useState("");

	// The list re-filters from a deferred copy, so typing stays responsive while a few hundred cards re-render.
	const deferredQuery = useDeferredValue(nameQuery);

	// Parsed once per keystroke rather than per doll, since every doll in `matches` reads the same parsed query.
	const buildTimeQuery = useMemo(() => parseBuildTime(buildTimeText), [buildTimeText]);
	// True once the typed text cannot become a build time, so the field shows a hint. A time still being typed, such as `3:5`, is left unflagged.
	const buildTimeInvalid = buildTimeText.trim() !== "" && buildTimeQuery === null && !isIncompleteBuildTime(buildTimeText);

	// Every doll's searchable names, normalised once per load rather than on every keystroke.
	const searchKeys = useMemo(
		() => new Map(allDolls.map((data) => [data.normal.id, [data.normal.name, data.mod?.name ?? "", ...(ALIASES_BY_ID.get(data.normal.id) ?? [])].filter(Boolean).map(normaliseName)])),
		[allDolls]
	);

	const matches = useMemo(() => {
		const typeOn = typeFilter.some((entry) => entry.selected);
		const rarityOn = rarityFilter.some((entry) => entry.selected);
		const modOn = modFilter.selected;
		// Live2D availability is fetched lazily, so the filter stays off until it has actually loaded rather than
		// matching nothing for the moment in between and flashing an empty result.
		const live2dOn = live2dFilter.selected && live2dAvailability !== null;
		const live2dIds = modOn ? live2dAvailability?.tdollModIds : live2dAvailability?.tdollIds;
		const query = normaliseName(deferredQuery);

		return allDolls.flatMap<IndexEntry>((data) => {
			// The name search narrows every other filter. Both forms' names and any old names count, so "m4sopmod" finds the doll
			// whichever form the Mod filter is showing, and "hk416" still finds 416.
			if (!matchesAnyName(searchKeys.get(data.normal.id) ?? [], query)) {
				return [];
			}
			if (buildTimeQuery && !(data.production && matchesBuildTime(data.production.seconds, buildTimeQuery))) {
				return [];
			}
			// With Mod also on, only a Mod-form model counts, since that is the form the list is showing.
			if (live2dOn && !live2dIds?.has(data.normal.id)) {
				return [];
			}
			if (!typeOn && !rarityOn && !modOn) {
				return [{ ...data, selected: data.normal }];
			}
			let selected: TDollForm;
			if (modOn) {
				if (data.mod === null) {
					return [];
				}
				selected = data.mod;
				if (!typeOn && !rarityOn) {
					return [{ ...data, selected }];
				}
			} else {
				selected = data.normal;
			}
			const entry: IndexEntry[] = [{ ...data, selected }];
			const matchesType = typeFilter.some((type) => type.selected && type.label === selected.type);
			// A Mod at 6 stars is shown under the 5 star filter, since that is the rarity it upgraded from.
			const matchesRarity = rarityFilter.some((rarity) => rarity.selected && (rarity.rarity === selected.rarity || (modOn && rarity.rarity === 5 && selected.rarity === 6)));
			if (typeOn && rarityOn) {
				return matchesType && matchesRarity ? entry : [];
			}
			return (typeOn ? matchesType : matchesRarity) ? entry : [];
		});
	}, [allDolls, searchKeys, typeFilter, rarityFilter, modFilter, live2dFilter, live2dAvailability, deferredQuery, buildTimeQuery]);

	const sorted = useMemo(() => sortEntries(matches, sortKey, sortDescending), [matches, sortKey, sortDescending]);

	// The slice of sorted matches actually rendered, grown by PAGE_SIZE each time the load-more button is clicked.
	const visible = useMemo(() => sorted.slice(0, shown), [sorted, shown]);

	// The old version computed this with a loop and an off-by-one, so page 2 read "30-60" rather than
	// "31-60" and every later page was wrong by the same one.
	const rangeLabel = matches.length === 0 ? "0" : `1-${visible.length}`;

	// The index renders every doll, so it is the one route that legitimately loads all shards.
	useEffect(() => {
		let active = true;
		setLoadFailed(false);
		loadAllDolls().then(
			(dolls) => active && setAllDolls(dolls),
			() => active && setLoadFailed(true)
		);
		return () => {
			active = false;
		};
	}, [loadAttempt]);

	// Set HTML meta-data here using document API.
	useEffect(() => {
		document.title = "T-Doll Index";
		document.querySelector('meta[name="description"]')?.setAttribute("content", "Index of filterable T-Dolls");
	}, []);

	// Checks for filters in sessionStorage. Runs once for now.
	useEffect(() => {
		const savedFilters = sessionStorage.getItem("filters");
		if (savedFilters) {
			const temp = JSON.parse(savedFilters);
			setRarityFilter(temp.rarityFilter);
			setTypeFilter(temp.typeFilter);
			setModFilter(temp.modFilter);
			// Absent from filters saved before the Live2D filter existed.
			setLive2dFilter((current) => ({ ...current, selected: temp.live2dFilter?.selected === true }));
			// Absent from filters saved before the name search existed.
			setNameQuery(typeof temp.nameQuery === "string" ? temp.nameQuery : "");
			// Absent from filters saved before build time search existed.
			setBuildTimeText(typeof temp.buildTime === "string" ? temp.buildTime : "");
			// Absent from filters saved before sorting existed.
			setSortKey(isSortKey(temp.sortKey) ? temp.sortKey : "id");
			setSortDescending(temp.sortDescending === true);
		}
	}, []);

	// Reset the visible slice and persist the filters and sort every time they change, so a narrower filter never
	// leaves a stale, too-large slice on screen and a new order starts from its top.
	useEffect(() => {
		setShown(PAGE_SIZE);

		const tempFilters = {
			rarityFilter: rarityFilter,
			typeFilter: typeFilter,
			modFilter: modFilter,
			live2dFilter: live2dFilter,
			nameQuery: nameQuery,
			buildTime: buildTimeText,
			sortKey: sortKey,
			sortDescending: sortDescending
		};
		sessionStorage.setItem("filters", JSON.stringify(tempFilters));
	}, [modFilter, live2dFilter, rarityFilter, typeFilter, nameQuery, buildTimeText, sortKey, sortDescending]);

	// Every handler below is stable across renders and toggles from the current state rather than a captured copy,
	// so the memoised FilterPanel, its chips and the result cards can all skip renders they have no part in.
	const handleToggleRarity = useCallback((key?: string | number) => {
		setRarityFilter((rarities) => rarities.map((rarity) => (rarity.key === key ? { ...rarity, selected: !rarity.selected } : rarity)));
	}, []);

	const handleToggleType = useCallback((key?: string | number) => {
		setTypeFilter((types) => types.map((type) => (type.key === key ? { ...type, selected: !type.selected } : type)));
	}, []);

	const handleToggleMod = useCallback(() => {
		setModFilter((mod) => ({ ...mod, selected: !mod.selected }));
	}, []);

	const handleToggleLive2d = useCallback(() => {
		setLive2dFilter((live2d) => ({ ...live2d, selected: !live2d.selected }));
	}, []);

	const handleClearName = useCallback(() => setNameQuery(""), []);

	const handleClearBuildTime = useCallback(() => setBuildTimeText(""), []);

	const handleToggleSortDirection = useCallback(() => setSortDescending((descending) => !descending), []);

	const handleLoadMore = useCallback(() => setShown((current) => current + PAGE_SIZE), []);

	const handleRetryLoad = useCallback(() => setLoadAttempt((current) => current + 1), []);

	// Deselects every filter at once, for the panel's Clear all button.
	const handleClearAll = useCallback(() => {
		setRarityFilter((rarities) => rarities.map((rarity) => ({ ...rarity, selected: false })));
		setTypeFilter((types) => types.map((type) => ({ ...type, selected: false })));
		setModFilter((mod) => ({ ...mod, selected: false }));
		setLive2dFilter((live2d) => ({ ...live2d, selected: false }));
		setNameQuery("");
		setBuildTimeText("");
	}, []);

	// The currently active filters, flattened into one list the summary bar can render as removable chips.
	// Each entry keeps its own delete handler so it clears just that filter.
	const activeFilters = useMemo(
		() => [
			...rarityFilter.filter((rarity) => rarity.selected).map((rarity) => ({ id: `rarity-${rarity.key}`, label: rarity.label, onDelete: () => handleToggleRarity(rarity.key) })),
			...typeFilter.filter((type) => type.selected).map((type) => ({ id: `type-${type.key}`, label: type.label, onDelete: () => handleToggleType(type.key) })),
			...(modFilter.selected ? [{ id: "mod", label: modFilter.label, onDelete: handleToggleMod }] : []),
			...(live2dFilter.selected ? [{ id: "live2d", label: live2dFilter.label, onDelete: handleToggleLive2d }] : []),
			...(nameQuery.trim() ? [{ id: "name", label: `"${nameQuery.trim()}"`, onDelete: handleClearName }] : []),
			...(buildTimeQuery ? [{ id: "build-time", label: `Build time ${formatBuildTimeQuery(buildTimeQuery)}`, onDelete: handleClearBuildTime }] : [])
		],
		[rarityFilter, typeFilter, modFilter, live2dFilter, nameQuery, buildTimeQuery, handleToggleRarity, handleToggleType, handleToggleMod, handleToggleLive2d, handleClearName, handleClearBuildTime]
	);

	// Built once per filter change rather than per render, so the memoised panel skips renders that only touch the results.
	const filterRows = useMemo(
		() => (
			<DollFilterRows
				rarityFilter={rarityFilter}
				typeFilter={typeFilter}
				modFilter={modFilter}
				live2dFilter={live2dFilter}
				onToggleRarity={handleToggleRarity}
				onToggleType={handleToggleType}
				onToggleMod={handleToggleMod}
				onToggleLive2d={handleToggleLive2d}
			/>
		),
		[rarityFilter, typeFilter, modFilter, live2dFilter, handleToggleRarity, handleToggleType, handleToggleMod, handleToggleLive2d]
	);

	return (
		<Box component="main" sx={styles.root}>
			<ScrollToTop />

			{/* Filters and summary bar */}
			<Container maxWidth="lg" sx={styles.summaryContainer}>
				<FilterPanel
					activeCount={activeFilters.length}
					onClear={handleClearAll}
					nameQuery={nameQuery}
					onNameQueryChange={setNameQuery}
					nameLabel="Search T-Dolls by name"
					buildTimeQuery={buildTimeText}
					onBuildTimeQueryChange={setBuildTimeText}
					buildTimeInvalid={buildTimeInvalid}
					buildTimeExample="3:55"
					buildTimeLabel="Search T-Dolls by build time"
				>
					{filterRows}
				</FilterPanel>

				<IndexSummaryBar
					rangeLabel={rangeLabel}
					total={matches.length}
					activeFilters={activeFilters}
					sortId="tdoll-sort"
					sortOptions={SORT_OPTIONS}
					sortKey={sortKey}
					onSortKeyChange={setSortKey}
					sortDescending={sortDescending}
					onToggleSortDirection={handleToggleSortDirection}
				/>
			</Container>
			{/* End of filters and summary bar */}

			{/* T-Dolls List */}
			<Container sx={styles.cardGrid} maxWidth="lg">
				<Divider sx={styles.topDividerForCards} />

				{loadFailed && <LoadError what="the T-Dolls" onRetry={handleRetryLoad} />}

				{/* Search Results */}
				<Grid container spacing={4}>
					{visible.map((tdoll) => (
						<Grid key={tdoll.normal.id} size={{ xs: 6, sm: 4, md: 3, lg: 2 }}>
							<DollCard
								id={tdoll.normal.id}
								name={tdoll.selected.name}
								type={tdoll.selected.type}
								rarity={tdoll.selected.rarity}
								isMod={tdoll.selected === tdoll.mod}
								image={tdoll.selected.assets.images.card ?? ""}
								to={`/tdoll/${tdoll.normal.id}`}
								highlight={deferredQuery}
							/>
						</Grid>
					))}
				</Grid>

				{visible.length < matches.length && (
					<Box sx={{ display: "flex", justifyContent: "center", mt: 3 }}>
						<Button variant="outlined" onClick={handleLoadMore}>
							Load {Math.min(PAGE_SIZE, matches.length - visible.length)} more
						</Button>
					</Box>
				)}

				<Divider sx={styles.bottomDividerForCards} />

				{/* End of Search Results */}
			</Container>

			{/* End of T-Dolls List */}
		</Box>
	);
}
