import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import type { Live2dStage } from "./live2d";
import { preloadLive2dRuntime, warmLive2dModel } from "./live2dPreload";
import type { AnimationTab } from "./spine";
import { nextAnimationValue } from "./spine";
import { IDLE_TAB_VALUE } from "./useLive2dMotions";

/** Load status of a mounted Live2D stage. */
export type Live2dStageStatus = "loading" | "ready" | "error";

/** Live2D stage state and controls, returned by `useLive2dStage`. */
export interface Live2dStageState {
	/** Load status of the mounted model. */
	status: Live2dStageStatus;
	/** The currently playing motion's model3 group, or "" before one has been chosen. */
	motion: string;
	/** Play a motion group and record it as current. Ignored while the stage isn't ready, so a click during a load can't move the selection to a motion that never plays. */
	playMotion: (group: string) => void;
	/** Play whichever tab comes after the current motion, the click-to-advance behaviour every stage shares. */
	advance: () => void;
	/** Re-run the load, for a failed load's retry button. */
	retry: () => void;
}

/**
 * Mount, drive and tear down a Live2D stage on a canvas, for the full-page fairy and T-Doll Live2D viewers. The cards use archive-kit's
 * animation stage through `components/Live2dStage.tsx` instead.
 *
 * Creates the stage whenever `modelUrl` is defined and destroys it whenever `modelUrl` changes, becomes undefined, or the caller unmounts.
 * Only one stage exists process-wide at a time (`createLive2dStage` destroys whatever stage came before it), and this hook's own effect
 * cleanup makes sure this caller's stage is torn down on every exit, so switching models or pages never leaks a WebGL context. The canvas
 * is measured once per model rather than tracked with a resize observer: `sizeRef` measures a separate box when the canvas's own box cannot
 * be trusted, such as the viewer's zoom container, which keeps a stable size while the canvas itself carries a zoom transform.
 *
 * The stage is paused while its canvas is scrolled out of view or the page is hidden, and resumes where it left off on return, so a
 * model nobody can see stops costing CPU and GPU time.
 *
 * The runtime loader is imported dynamically, gated on `modelUrl` being defined, so a page that renders this hook without a model never
 * parses `live2d.ts` at all. The same gate starts the runtime and model downloads through `live2dPreload.ts` before that import, so they run
 * in parallel instead of one after another.
 *
 * The caller must give its canvas element `key={modelUrl}`. Swapping models on a canvas that stays mounted, such as the viewer's star rank
 * picker while Live2D stays selected, tears down one WebGL context and creates another on the same canvas node, which reliably fails with a
 * `checkMaxIfStatementsInShader` error from the vendored runtime. Keying the canvas by `modelUrl` makes React mount a fresh node for each
 * model instead, sidestepping the failure.
 *
 * @param canvasRef The canvas to render into.
 * @param modelUrl URL of the model's `model3.json`, or undefined to keep the stage empty.
 * @param tabs The model's motion tabs, for `advance` and for picking the opening motion once the stage is ready.
 * @param sizeRef Element to measure for the canvas's pixel size, when it differs from the canvas itself.
 * @returns The stage's status, current motion, and the controls to drive it.
 */
export function useLive2dStage(canvasRef: RefObject<HTMLCanvasElement | null>, modelUrl: string | undefined, tabs: readonly AnimationTab[], sizeRef?: RefObject<HTMLElement | null>): Live2dStageState {
	const stageRef = useRef<Live2dStage | null>(null);
	const [status, setStatus] = useState<Live2dStageStatus>("loading");
	// Bumped by `retry` to run the load again.
	const [attempt, setAttempt] = useState(0);
	const [motion, setMotion] = useState("");

	useEffect(() => {
		if (modelUrl === undefined) {
			return;
		}
		const canvas = canvasRef.current;
		const sizeBox = sizeRef?.current ?? canvas;
		if (!canvas || !sizeBox) {
			return;
		}

		let active = true;
		setStatus("loading");
		setMotion("");

		// Start every download now. Aborted on cleanup, so a stage that unmounts or switches models mid-load stops warming the old one.
		const warmup = new AbortController();
		preloadLive2dRuntime();
		warmLive2dModel(modelUrl, warmup.signal);

		// Pause while the canvas is off screen or the page is hidden. Tracks this effect's own stage rather than `stageRef`, so a late
		// callback from this observer can never pause the stage a later model mounts.
		let stage: Live2dStage | undefined;
		let inView = true;
		const syncPaused = () => {
			stage?.setPaused(!inView || document.visibilityState === "hidden");
		};
		const observer = new IntersectionObserver((entries) => {
			inView = entries[entries.length - 1]?.isIntersecting ?? inView;
			syncPaused();
		});
		observer.observe(canvas);
		document.addEventListener("visibilitychange", syncPaused);

		const rect = sizeBox.getBoundingClientRect();
		const resolution = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(rect.width * resolution));
		canvas.height = Math.max(1, Math.round(rect.height * resolution));

		import("./live2d")
			.then(({ createLive2dStage }) => createLive2dStage(canvas, modelUrl))
			.then((created) => {
				if (!active) {
					created.destroy();
					return;
				}
				stage = created;
				stageRef.current = created;
				syncPaused();
				setStatus("ready");
			})
			.catch((error: unknown) => {
				console.error("Live2D model load failed:", error);
				if (active) {
					setStatus("error");
				}
			});

		return () => {
			active = false;
			warmup.abort();
			observer.disconnect();
			document.removeEventListener("visibilitychange", syncPaused);
			stageRef.current?.destroy();
			stageRef.current = null;
		};
		// canvasRef and sizeRef are stable ref objects; only the model itself and a retry should rebuild the stage.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [modelUrl, attempt]);

	// Picks the opening motion once the stage is up and the tabs have arrived, without overwriting one the reader already chose.
	useEffect(() => {
		if (status === "ready") {
			setMotion((current) => (current === "" ? (tabs.find((tab) => tab.value === IDLE_TAB_VALUE)?.value ?? tabs[0]?.value ?? "") : current));
		}
	}, [status, tabs]);

	const playMotion = useCallback((group: string) => {
		const stage = stageRef.current;
		// Matches the guard every original call site had: ignore input until the stage exists, so a click during a
		// load can't move the tile selection to a motion that never actually plays.
		if (!stage) {
			return;
		}
		stage.playMotion(group);
		setMotion(group);
	}, []);

	const advance = useCallback(() => {
		const next = nextAnimationValue(tabs, motion);
		if (next !== undefined) {
			playMotion(next);
		}
	}, [tabs, motion, playMotion]);

	const retry = useCallback(() => setAttempt((current) => current + 1), []);

	return { status, motion, playMotion, advance, retry };
}
