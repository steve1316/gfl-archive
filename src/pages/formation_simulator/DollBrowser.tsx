import { memo, useCallback, useMemo, useState } from "react";
import type { ChangeEvent } from "react";

import { Box, ButtonBase, InputAdornment, TextField, Typography, useTheme } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";

import ArtPlaceholder from "../../components/ArtPlaceholder";
import { TypeBadge } from "../../components/DollBadges";
import FilterChip from "../../components/FilterChip";
import { imageUrl } from "../../lib/assets";
import { searchIndex } from "../../lib/data";
import { MOD_ID_OFFSET } from "../../lib/formation/pipeline";
import { matchesAnyName, normaliseName } from "../../lib/nameSearch";
import { hasDollArt } from "../../lib/processData";
import type { FormationData } from "../../types/formation";
import { toggleInSet } from "./toggleInSet";

/** Weapon classes in chip order. */
const TYPES = ["HG", "SMG", "RF", "AR", "MG", "SG"] as const;

/**
 * Rarity chips in the T-Doll Index's order. Rarity 1 is the collaboration "Extra" rarity.
 *
 * Drawn with `FilterChip` directly rather than `RarityChipRow`: importing `FilterRows` here moved it out of the main chunk and added ~120 B gzip to every page.
 */
const RARITIES: readonly { key: number; label: string; rarity: number }[] = [
	{ key: 0, label: "General", rarity: 2 },
	{ key: 1, label: "Rare", rarity: 3 },
	{ key: 2, label: "Epochal", rarity: 4 },
	{ key: 3, label: "Legendary", rarity: 5 },
	{ key: 4, label: "Extra", rarity: 1 }
];

/** Most cards shown at once, so typing stays fast. Narrowing the search shows the rest. */
const MAX_CARDS = 120;

/** Props for DollBrowser. */
interface DollBrowserProps {
	/** Formation data, to list only dolls the simulator can place. */
	data: FormationData;
	/** Doll ids already in the echelon, shown but not pickable. */
	placedIds: ReadonlySet<number>;
	/** Whether the echelon already has five dolls. */
	full: boolean;
	/** A doll was picked. */
	onPick: (dollId: number) => void;
}

/**
 * Step 1 of the doll modal: search and filter dolls, then pick one.
 *
 * @param props Component props.
 * @returns The browser.
 */
export default memo(function DollBrowser({ data, placedIds, full, onPick }: DollBrowserProps) {
	const [query, setQuery] = useState("");
	const theme = useTheme();
	const [types, setTypes] = useState<ReadonlySet<string>>(new Set());
	const [rarities, setRarities] = useState<ReadonlySet<number>>(new Set());
	const [modOnly, setModOnly] = useState(false);

	const candidates = useMemo(
		() =>
			searchIndex
				.filter((entry) => data.forms[String(entry.id)])
				.map((entry) => ({ entry, keys: [entry.name, ...(entry.aliases ?? [])].map(normaliseName), hasMod: Boolean(data.forms[String(entry.id + MOD_ID_OFFSET)]) })),
		[data.forms]
	);
	const shown = useMemo(() => {
		const needle = normaliseName(query);
		return candidates
			.filter(
				({ entry, keys, hasMod }) => matchesAnyName(keys, needle) && (types.size === 0 || types.has(entry.type)) && (rarities.size === 0 || rarities.has(entry.rarity)) && (!modOnly || hasMod)
			)
			.slice(0, MAX_CARDS);
	}, [candidates, query, types, rarities, modOnly]);

	const handleQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), []);
	const toggleType = useCallback((type?: string | number) => setTypes((current) => toggleInSet(current, String(type))), []);
	const toggleRarity = useCallback(
		(key?: string | number) =>
			setRarities((current) => {
				const rarity = RARITIES.find((entry) => entry.key === key)?.rarity;
				if (rarity === undefined) {
					return current;
				}
				return toggleInSet(current, rarity);
			}),
		[]
	);
	const toggleMod = useCallback(() => setModOnly((current) => !current), []);

	if (full) {
		return <Typography sx={{ py: 4, textAlign: "center" }}>The echelon already has five dolls. Remove one to add another.</Typography>;
	}

	return (
		<Box>
			<TextField
				fullWidth
				size="small"
				placeholder="Search by name"
				value={query}
				onChange={handleQuery}
				slotProps={{
					input: {
						startAdornment: (
							<InputAdornment position="start">
								<SearchIcon fontSize="small" />
							</InputAdornment>
						)
					},
					htmlInput: { "aria-label": "Search dolls by name" }
				}}
			/>
			<Box sx={{ display: "flex", flexWrap: "wrap", my: 1.5 }}>
				{RARITIES.map((entry) => (
					<FilterChip key={entry.key} label={entry.label} value={entry.key} selected={rarities.has(entry.rarity)} onToggle={toggleRarity} colour={theme.palette.rarity?.[entry.rarity]} />
				))}
				{TYPES.map((type) => (
					<FilterChip key={type} label={type} value={type} selected={types.has(type)} onToggle={toggleType} colour={theme.palette.weaponType[type]} />
				))}
				<FilterChip label="MOD" selected={modOnly} onToggle={toggleMod} />
			</Box>
			<Box sx={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 1 }}>
				{shown.map(({ entry }) => {
					const taken = placedIds.has(entry.id);
					return (
						<ButtonBase
							key={entry.id}
							disabled={taken}
							onClick={() => onPick(entry.id)}
							sx={{ flexDirection: "column", alignItems: "stretch", borderRadius: "8px", overflow: "hidden", bgcolor: "raised", opacity: taken ? 0.4 : 1, textAlign: "left" }}
							aria-label={taken ? `${entry.name} (already in the echelon)` : `Pick ${entry.name}`}
						>
							{hasDollArt(entry.id) ? (
								<Box
									component="img"
									src={imageUrl(entry.id, "normal", "card")}
									alt=""
									loading="lazy"
									sx={{ width: "100%", aspectRatio: "1 / 2", objectFit: "cover", objectPosition: "50% 0%" }}
								/>
							) : (
								<ArtPlaceholder name={entry.name} />
							)}
							<Box sx={{ p: 0.75 }}>
								<Typography variant="caption" sx={{ fontWeight: 700, display: "block", lineHeight: 1.2 }} noWrap>
									{entry.name}
								</Typography>
								<TypeBadge type={entry.type} dense />
							</Box>
						</ButtonBase>
					);
				})}
			</Box>
			{shown.length === 0 && <Typography sx={{ py: 3, textAlign: "center" }}>No dolls match.</Typography>}
		</Box>
	);
});
