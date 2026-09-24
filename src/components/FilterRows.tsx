import { memo } from "react";
import type { ReactNode } from "react";

import { Avatar, Box, Divider, useTheme } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import FilterChip from "./FilterChip";

// Avatars are props of memoised chips, so they are built once here. A fresh element per render would re-render every chip.
/** The number avatar for each rarity, keyed by the rarity it shows. */
const RARITY_AVATARS = new Map([1, 2, 3, 4, 5, 6].map((rarity) => [rarity, <Avatar key={rarity}>{rarity}</Avatar>]));

const styles = {
	chipList: {
		display: "flex",
		flexWrap: "wrap",
		listStyle: "none",
		p: 0,
		m: 0,
		gap: 0.5
	},
	divider: {
		my: 0.5
	}
} satisfies Record<string, SxProps<Theme>>;

/** One togglable filter entry with no colour data of its own beyond its label. */
export interface SimpleFilterEntry {
	/** Stable key used to match a toggle back to this entry. */
	key: number;
	/** Text shown on the chip. */
	label: string;
	/** Whether this filter is currently active. */
	selected: boolean;
}

/** One rarity filter entry, which also carries the rarity used for matching and for the chip's colour. */
export interface RarityFilterEntry extends SimpleFilterEntry {
	/** The game's rarity number (1 = Extra, 2-5 = General through Legendary) this entry filters on. */
	rarity: number;
}

/** Props for ChipRow. */
interface ChipRowProps {
	/** The row's chips, each wrapped in an `li`. */
	children: ReactNode;
}

/**
 * One row of filter chips, as a list.
 *
 * @param props Component props.
 * @returns The row.
 */
export function ChipRow({ children }: ChipRowProps) {
	return (
		<Box component="ul" sx={styles.chipList}>
			{children}
		</Box>
	);
}

/**
 * The rule between two rows of filter chips.
 *
 * @returns The divider.
 */
export function ChipRowDivider() {
	return <Divider sx={styles.divider} />;
}

/** Props for RarityChipRow. */
interface RarityChipRowProps {
	/** The rarity entries and whether each is on. */
	entries: RarityFilterEntry[];
	/** Toggles the entry with this key. One stable handler for the whole row, which each chip calls with its key. */
	onToggle: (key?: string | number) => void;
}

/**
 * A row of rarity chips, each tinted with its rarity colour and led by its rarity number.
 *
 * @param props Component props.
 * @returns The row.
 */
export const RarityChipRow = memo(function RarityChipRow({ entries, onToggle }: RarityChipRowProps) {
	const theme = useTheme();
	return (
		<ChipRow>
			{entries.map((entry) => (
				<li key={entry.key}>
					<FilterChip
						label={entry.label}
						selected={entry.selected}
						value={entry.key}
						onToggle={onToggle}
						colour={theme.palette.rarity?.[entry.rarity]}
						avatar={RARITY_AVATARS.get(entry.rarity)}
					/>
				</li>
			))}
		</ChipRow>
	);
});
