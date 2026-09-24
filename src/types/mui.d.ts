import type { INGREDIENT_COLOURS, WEAPON_TYPE_COLOURS } from "../theme/palette";

/**
 * Extra palette slots this site needs.
 *
 * Weapon type and the collaboration ingredient colours are driven by the doll data rather than by a component's state, so they belong in the
 * palette instead of being written inline at each use. `raised` and `rarity` are declared by archive-kit instead. A second declaration of
 * the same slot here is a type error that `skipLibCheck` only hides.
 */
declare module "@mui/material/styles" {
	interface Palette {
		/** Weapon-class colours keyed by the doll's `type` value. */
		weaponType: Record<keyof typeof WEAPON_TYPE_COLOURS, string>;
		/** Drink-ingredient colours named in the VA-11 Hall-A collaboration skill text. */
		ingredient: Record<keyof typeof INGREDIENT_COLOURS, string>;
		/** The formation tile grid: an unused square, the lines between squares, the doll's own square, and a buffed one. */
		tile: { empty: string; line: string; self: string; buff: string };
		/** The two tones of the diagonal stripe behind the animation panel. */
		stripe: { dark: string; light: string };
	}

	interface PaletteOptions {
		/** Weapon-class colours keyed by the doll's `type` value. */
		weaponType?: Record<keyof typeof WEAPON_TYPE_COLOURS, string>;
		/** Drink-ingredient colours named in the VA-11 Hall-A collaboration skill text. */
		ingredient?: Record<keyof typeof INGREDIENT_COLOURS, string>;
		/** The formation tile grid: an unused square, the lines between squares, the doll's own square, and a buffed one. */
		tile?: { empty: string; line: string; self: string; buff: string };
		/** The two tones of the diagonal stripe behind the animation panel. */
		stripe?: { dark: string; light: string };
	}
}
