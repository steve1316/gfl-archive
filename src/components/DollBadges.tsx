import { memo } from "react";

import { Box } from "@mui/material";
import type { Theme } from "@mui/material";
import StarIcon from "@mui/icons-material/Star";

import { MOD_RARITY_COLOUR } from "../theme/palette";

/**
 * The colour a doll's or an equipment item's rarity is drawn in.
 *
 * A Mod takes its own colour whatever its rank, because Mods exist at rarity 4, 5 and 6 and would
 * otherwise be indistinguishable from an ordinary doll of the same rank.
 *
 * @param theme The active theme.
 * @param rarity The rarity, 1 to 6.
 * @param isMod Whether the form being shown is the Mod.
 * @returns A CSS colour.
 */
export function rarityColour(theme: Theme, rarity: number, isMod: boolean): string {
	if (isMod) {
		return MOD_RARITY_COLOUR;
	}
	return theme.palette.rarity?.[rarity] ?? theme.palette.text.secondary;
}

/** Props for TypeBadge. */
interface TypeBadgeProps {
	/** The weapon class, such as `AR` or `SMG`. */
	type: string;
	/** Smaller padding and type size, for the index cards. */
	dense?: boolean;
}

/**
 * The weapon class, tinted by the palette's weapon-type ramp.
 *
 * This was plain uncoloured text, even though the same six classes are colour-coded on the filter
 * chips, so the two did not agree with each other.
 *
 * @param props Component props.
 * @returns The badge.
 */
export const TypeBadge = memo(function TypeBadge({ type, dense = false }: TypeBadgeProps) {
	return (
		<Box
			component="span"
			sx={(theme) => {
				const tint = theme.palette.weaponType[type as keyof typeof theme.palette.weaponType] ?? theme.palette.text.secondary;
				return {
					display: "inline-block",
					// Raised from 0.62rem to clear the 11px floor for readability on mobile (was 9.92px).
					fontSize: dense ? "0.7rem" : "0.75rem",
					fontWeight: 700,
					letterSpacing: "0.06em",
					px: dense ? 0.6 : 1.1,
					py: dense ? 0.1 : 0.4,
					borderRadius: 1,
					color: tint,
					backgroundColor: `${tint}22`
				};
			}}
		>
			{type}
		</Box>
	);
});

/** Props for RarityStars. */
interface RarityStarsProps {
	/** The doll's rarity, 1 to 6. */
	rarity: number;
	/** Whether the form being shown is the Mod, which changes the colour. */
	isMod: boolean;
}

/**
 * A doll's rarity as that many stars.
 *
 * A real list, because the stars used to be `<li>` elements returned into a `Typography` that renders
 * a paragraph, which is invalid nesting and had no list around it.
 *
 * @param props Component props.
 * @returns The stars.
 */
export const RarityStars = memo(function RarityStars({ rarity, isMod }: RarityStarsProps) {
	return (
		<Box component="ul" sx={{ display: "inline-flex", alignItems: "center", gap: 0.25, listStyle: "none", m: 0, p: 0 }} aria-label={`${rarity} star${rarity === 1 ? "" : "s"}`}>
			{Array.from({ length: rarity }, (_value, index) => (
				<Box component="li" key={index} sx={{ display: "inline-flex" }}>
					<StarIcon sx={(theme) => ({ fontSize: "1.05rem", color: rarityColour(theme, rarity, isMod) })} />
				</Box>
			))}
		</Box>
	);
});

/** Props for RarityLabel. */
interface RarityLabelProps {
	/** The doll's rarity, 1 to 6. */
	rarity: number;
	/** Whether the form being shown is the Mod, which changes the colour. */
	isMod: boolean;
}

/**
 * The same rarity as a single figure, for places too narrow to draw six stars.
 *
 * @param props Component props.
 * @returns The label.
 */
export const RarityLabel = memo(function RarityLabel({ rarity, isMod }: RarityLabelProps) {
	return (
		<Box component="span" sx={(theme) => ({ fontSize: "0.7rem", fontWeight: 700, color: rarityColour(theme, rarity, isMod) })}>
			{rarity}
			{"★"}
		</Box>
	);
});
