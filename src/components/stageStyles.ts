import type { Theme } from "@mui/material";

/**
 * The striped card a chibi stage sits on, shared by the T-Doll, HOC and enemy cards. It is full width and square up to 340px, with the
 * Card's own radius and shadow. The stage clips to it, so a zoomed chibi never spills over the page.
 *
 * @param theme The active theme, for the stripe colours.
 * @returns The style.
 */
export const STRIPED_STAGE_SX = (theme: Theme) => ({
	width: "100%",
	aspectRatio: "1 / 1",
	maxHeight: 340,
	borderRadius: 1,
	boxShadow: 1,
	// Used https://stripesgenerator.com/ to generate the linear gradient stripes.
	backgroundImage: `linear-gradient(45deg, ${theme.palette.stripe.dark} 12.50%, ${theme.palette.stripe.light} 12.50%, ${theme.palette.stripe.light} 50%, ${theme.palette.stripe.dark} 50%, ${theme.palette.stripe.dark} 62.50%, ${theme.palette.stripe.light} 62.50%, ${theme.palette.stripe.light} 100%)`,
	backgroundSize: "5.66px 5.66px",
	cursor: "pointer"
});

/** A full-width toggle row above a stage, its buttons sharing the width evenly. Shared by the T-Doll, HOC and enemy cards. */
export const TOGGLE_ROW_SX = { width: "100%", mb: 1, "& .MuiToggleButton-root": { flex: 1 } } as const;
