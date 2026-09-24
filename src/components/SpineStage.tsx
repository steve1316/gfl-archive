import { memo, useMemo } from "react";

import type { SxProps, Theme } from "@mui/material";

import { AnimationStage } from "archive-kit";
import type { StageEntry } from "archive-kit";

import { animationTabs, createSpineRuntime } from "../lib/spine";
import type { SpineSource } from "../lib/spine";

/** Props for SpineStage. */
interface SpineStageProps {
	/** URL of the binary `.skel`. */
	skelUrl: string;
	/** URL of the `.atlas`. */
	atlasUrl: string;
	/** Directory holding the atlas page images, with a trailing slash. */
	imageBase: string;
	/** The animation names a tap steps through, ordered and labelled by `animationTabs`. Keep it stable, such as a rig's `anims`. */
	anims: readonly string[];
	/** The animation's accessible name. */
	label: string;
	/** False for a fixed preview that plays the first animation with no caption. Defaults to true. */
	interactive?: boolean;
	/** Sizes the stage box. */
	sx?: SxProps<Theme>;
}

/**
 * One Spine rig on archive-kit's animation stage. A tap steps through the rig's animations in `animationTabs` order, with the caption under
 * the stage, and the wheel or a pinch zooms.
 *
 * @param props Component props.
 * @returns The stage and its caption.
 */
export default memo(function SpineStage({ skelUrl, atlasUrl, imageBase, anims, label, interactive, sx }: SpineStageProps) {
	const source = useMemo<SpineSource>(() => ({ skelUrl, atlasUrl, imageBase }), [skelUrl, atlasUrl, imageBase]);
	const entries = useMemo<StageEntry[]>(() => animationTabs(anims).map((tab) => ({ key: tab.value, label: tab.label })), [anims]);
	return <AnimationStage runtime={createSpineRuntime} source={source} sourceKey={skelUrl} entries={entries} label={label} interactive={interactive} sx={sx} />;
});
