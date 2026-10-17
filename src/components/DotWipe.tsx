import { memo, useEffect, useRef } from "react";

import { Box } from "@mui/material";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Module constants

/** The spacing between neighbouring dots, as a share of the stage's width. */
const PITCH = 0.031;

/** The radius a dot has to reach to meet its neighbours and leave no gap, as a share of the pitch. */
const FULL_RADIUS = 0.7;

/** How much of the run the wipe's front takes to cross the stage. The rest is each dot growing, so the front is soft rather than a hard edge. */
const SPREAD = 0.6;

/** Props for DotWipe. */
interface DotWipeProps {
	/** The colour the dots fill the stage with. */
	color: string;
	/** Whether the dots grow to cover the stage, or shrink away to uncover it. */
	direction: "cover" | "uncover";
	/** How long the wipe takes, in milliseconds. */
	durationMs: number;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Component

/**
 * The game's dotted screen fade: a grid of dots that swell from the right edge across to the left until they merge into one fill.
 *
 * Covering plays that forward and uncovering plays it back, so a stage that was dotted out is dotted back in.
 *
 * @param props Component props.
 * @returns A canvas laid over its parent.
 */
export default memo(function DotWipe({ color, direction, durationMs }: DotWipeProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const context = canvas?.getContext("2d");
		if (!canvas || !context) {
			return;
		}
		const scale = window.devicePixelRatio || 1;
		const width = canvas.clientWidth;
		const height = canvas.clientHeight;
		canvas.width = width * scale;
		canvas.height = height * scale;
		context.scale(scale, scale);
		context.fillStyle = color;

		const pitch = width * PITCH;
		const rowHeight = pitch * 0.866;
		const start = performance.now();
		let frame = 0;

		const draw = (now: number) => {
			const elapsed = Math.min(1, (now - start) / durationMs);
			const progress = direction === "cover" ? elapsed : 1 - elapsed;
			context.clearRect(0, 0, width, height);
			for (let row = 0, y = 0; y < height + pitch; row++, y = row * rowHeight) {
				for (let x = row % 2 === 0 ? 0 : pitch / 2; x < width + pitch; x += pitch) {
					// The right edge starts first, so a dot's turn comes later the further left it sits.
					const turn = (progress * (1 + SPREAD) - (1 - x / width)) / SPREAD;
					const radius = Math.min(1, Math.max(0, turn)) * FULL_RADIUS * pitch;
					if (radius > 0.5) {
						context.beginPath();
						context.arc(x, y, radius, 0, Math.PI * 2);
						context.fill();
					}
				}
			}
			if (elapsed < 1) {
				frame = requestAnimationFrame(draw);
			}
		};
		frame = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(frame);
	}, [color, direction, durationMs]);

	return <Box component="canvas" ref={canvasRef} sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} />;
});
