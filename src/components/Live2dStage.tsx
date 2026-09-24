import { memo, useEffect, useMemo } from "react";
import type { ReactNode } from "react";

import type { SxProps, Theme } from "@mui/material";

import { AnimationStage } from "archive-kit";
import type { StageEntry, StageRuntime } from "archive-kit";

import { preloadLive2dRuntime, warmLive2dModel } from "../lib/live2dPreload";
import { IDLE_TAB_VALUE, motionTabs } from "../lib/useLive2dMotions";
import type { Live2dMotion } from "../types/live2d";

/**
 * Build the Live2D runtime inside the stage. `lib/live2d.ts` is imported only now, so a page that never shows a model never parses it.
 *
 * @param host The element to mount the canvas in.
 * @returns The runtime.
 */
function buildLive2dRuntime(host: HTMLElement): Promise<StageRuntime<string>> {
	preloadLive2dRuntime();
	return import("../lib/live2d").then(({ createLive2dRuntime }) => createLive2dRuntime(host));
}

/** Props for Live2dStage. */
interface Live2dStageProps {
	/** URL of the model's `model3.json`. */
	modelUrl: string;
	/** The model's motions from the Live2D index, or null or undefined while they load. */
	motions: readonly Live2dMotion[] | null | undefined;
	/** The model's accessible name. */
	label: string;
	/** Told the motion group playing now, or null while nothing plays, such as for its dialogue line. */
	onMotionChange?: (group: string | null) => void;
	/** Drawn inside the stage box, such as a link to the full-page viewer. */
	overlay?: ReactNode;
	/** The bottom corner for the reset button. Left when `overlay` takes the bottom right. */
	resetCorner?: "left" | "right";
	/** Sizes the stage box. */
	sx?: SxProps<Theme>;
}

/**
 * One Live2D model on archive-kit's animation stage. A tap steps through its motion groups, Idle first, with the caption under the stage.
 * The model's files start downloading alongside the runtime rather than after it.
 *
 * @param props Component props.
 * @returns The stage and its caption.
 */
export default memo(function Live2dStage({ modelUrl, motions, label, onMotionChange, overlay, resetCorner, sx }: Live2dStageProps) {
	useEffect(() => {
		const warmup = new AbortController();
		warmLive2dModel(modelUrl, warmup.signal);
		return () => warmup.abort();
	}, [modelUrl]);

	// Idle first, since the stage starts on the first entry and the model opens on Idle.
	const entries = useMemo<StageEntry[]>(() => {
		const tabs = motionTabs(motions ?? []);
		const ordered = [...tabs.filter((tab) => tab.value === IDLE_TAB_VALUE), ...tabs.filter((tab) => tab.value !== IDLE_TAB_VALUE)];
		return ordered.map((tab) => ({ key: tab.value, label: tab.label }));
	}, [motions]);

	return (
		<AnimationStage
			runtime={buildLive2dRuntime}
			source={modelUrl}
			sourceKey={modelUrl}
			entries={entries}
			label={label}
			onEntryChange={onMotionChange}
			overlay={overlay}
			resetCorner={resetCorner}
			sx={sx}
		/>
	);
});
