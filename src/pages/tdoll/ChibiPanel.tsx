import { memo, useCallback, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Link } from "react-router-dom";

// MaterialUI imports
import { Fab, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

// MaterialUI icon imports
import ZoomOutMapIcon from "@mui/icons-material/ZoomOutMap";

import Live2dStage from "../../components/Live2dStage";
import SpineStage from "../../components/SpineStage";
import { STRIPED_STAGE_SX } from "../../components/stageStyles";
import { FAB_EXPAND_SX } from "../../lib/artLayout";
import { skinLive2dModelUrl, spineImageBase, spineUrl } from "../../lib/assets";
import { resolveSkinLive2dVariant, useSkinLive2dMotions } from "../../lib/useLive2dMotions";
import type { SpineRig } from "../../types/spine";

/** Which animation source is on screen: the battle rig, the dorm rig, or the skin's Live2D model. */
export type ChibiMode = "battle" | "dorm" | "live2d";

const styles = {
	// Shared by the Battle/Dorm/Live2D row and the Live2D Normal/Damaged row, matching the full-width toggle
	// `HocAnimationsPanel` uses for its own rig picker.
	toggleRow: {
		width: "100%",
		mb: 1,
		"& .MuiToggleButton-root": { flex: 1 }
	},
	variantRow: {
		width: "100%",
		mt: 1,
		"& .MuiToggleButton-root": { flex: 1 }
	},
	dialogueLine: {
		mt: 1,
		fontStyle: "italic",
		color: "text.secondary"
	}
} satisfies Record<string, SxProps<Theme>>;

/** Props for ChibiPanel. */
interface ChibiPanelProps {
	/** Which animation source is on screen: the battle rig, the dorm rig, or the skin's Live2D model. */
	mode: ChibiMode;
	/** Called with the tapped toggle's value when the reader switches between Battle, Dorm and Live2D. */
	onSelectMode: (mode: ChibiMode) => void;
	/** The Spine rig to play, or undefined when this doll has no published Spine data. */
	spineRig: SpineRig | undefined;
	/** The doll's base id, used to build the Spine and Live2D asset URLs. */
	normalId: number;
	/** `mod` when the Mod form is on screen, else `base`. Selects which Live2D model to load. */
	live2dForm: string;
	/** `base` for the form's own art, or the skin id as a string. Selects which Live2D model to load. */
	live2dSkinKey: string;
	/** The variants this exact form/skin actually has, such as `["normal"]` or `["normal", "damaged"]`. Empty when it has none. */
	live2dVariants: string[];
	/** Whether the current form/skin combination has a published Live2D model, so the Live2D toggle option can be offered. */
	hasLive2d: boolean;
}

/**
 * The doll's chibi animations: a Battle/Dorm/Live2D toggle, then archive-kit's animation stage, where a tap steps to the next animation or
 * motion and the caption names it. In Live2D mode, a Normal/Damaged toggle and the playing motion's dialogue line follow.
 *
 * @param props Component props.
 * @returns The mode toggle and the stage.
 */
export default memo(function ChibiPanel({ mode, onSelectMode, spineRig, normalId, live2dForm, live2dSkinKey, live2dVariants, hasLive2d }: ChibiPanelProps) {
	// The reader's raw Normal/Damaged pick, independent of the page's own damaged-art toggle, since a reader previewing a Live2D pose
	// is not necessarily asking to also flip the portrait and hero art. Null until they pick, so the default below applies.
	const [variantPreference, setVariantPreference] = useState<string | null>(null);
	// The motion group the stage is playing, for its dialogue line.
	const [motion, setMotion] = useState<string | null>(null);

	// Derived in render from the variants this exact form/skin actually has, so the first render after a skin change already names a model
	// that exists for the new skin.
	const variant = resolveSkinLive2dVariant(live2dVariants, variantPreference);
	const hasBothVariants = live2dVariants.length > 1;

	// Gated on the mode being "live2d", since each doll's motions are their own network request.
	const motionId = mode === "live2d" ? normalId : undefined;
	const normalMotions = useSkinLive2dMotions(motionId, live2dForm, live2dSkinKey, "normal");
	const damagedMotions = useSkinLive2dMotions(motionId, live2dForm, live2dSkinKey, "damaged");
	const motions = variant === "damaged" ? damagedMotions : normalMotions;
	const live2dModelUrl = skinLive2dModelUrl(normalId, live2dForm, live2dSkinKey, variant);

	// Read with ?? rather than a strict null check, since fairy and HOC motions omit `line` entirely, not just null it.
	const dialogueLine = motions?.find((entry) => entry.model3Group === motion)?.line ?? null;

	// Opens the full-page viewer on the exact combination this card is showing right now.
	const live2dViewerLink = `/tdoll/${normalId}/live2d?form=${live2dForm}&skin=${live2dSkinKey}&variant=${variant}`;
	const live2dOverlay = useMemo(
		() => (
			<Fab color="primary" component={Link} to={live2dViewerLink} sx={FAB_EXPAND_SX} aria-label="view full-page Live2D model">
				<ZoomOutMapIcon />
			</Fab>
		),
		[live2dViewerLink]
	);

	const handleModeChange = useCallback(
		(_event: MouseEvent<HTMLElement>, value: ChibiMode | null) => {
			// Clicking the selected button hands back null, which would leave no mode chosen.
			if (value !== null) {
				onSelectMode(value);
			}
		},
		[onSelectMode]
	);

	const handleVariantChange = useCallback((_event: MouseEvent<HTMLElement>, value: "normal" | "damaged" | null) => {
		if (value !== null) {
			setVariantPreference(value);
		}
	}, []);

	return (
		<>
			<ToggleButtonGroup size="small" value={mode} exclusive onChange={handleModeChange} sx={styles.toggleRow} aria-label="Animation mode">
				<ToggleButton value="battle">Battle</ToggleButton>
				<ToggleButton value="dorm">Dorm</ToggleButton>
				{hasLive2d ? <ToggleButton value="live2d">Live2D</ToggleButton> : null}
			</ToggleButtonGroup>

			{mode === "live2d" ? (
				<Live2dStage modelUrl={live2dModelUrl} motions={motions} label="T-Doll Live2D model" onMotionChange={setMotion} overlay={live2dOverlay} resetCorner="left" sx={STRIPED_STAGE_SX} />
			) : spineRig ? (
				<SpineStage
					skelUrl={spineUrl(normalId, spineRig.skel, "skel")}
					atlasUrl={spineUrl(normalId, spineRig.atlas, "atlas")}
					imageBase={spineImageBase(normalId, spineRig.atlas)}
					anims={spineRig.anims}
					label="T-Doll chibi animation"
					sx={STRIPED_STAGE_SX}
				/>
			) : null}

			{mode === "live2d" && hasBothVariants ? (
				<ToggleButtonGroup size="small" value={variant} exclusive onChange={handleVariantChange} sx={styles.variantRow} aria-label="Live2D variant">
					<ToggleButton value="normal">Normal</ToggleButton>
					<ToggleButton value="damaged">Damaged</ToggleButton>
				</ToggleButtonGroup>
			) : null}

			{mode === "live2d" && dialogueLine ? (
				<Typography variant="body2" sx={styles.dialogueLine}>
					{dialogueLine}
				</Typography>
			) : null}
		</>
	);
});
