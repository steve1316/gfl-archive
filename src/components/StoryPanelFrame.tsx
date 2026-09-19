import { Box } from "@mui/material";

/**
 * The size the game draws the dialogue panel at, used as the drawing's coordinate space.
 *
 * Every figure below is measured from the game's own `DialogueBorder 1` sprite at that size, so the numbers can be checked against
 * the art rather than taken on trust.
 */
const ART_W = 511;
const ART_H = 158;

/** How far the drawn frame sits inside the art, which carries a soft shadow outside it. */
const INSET = 8;

/** Where the top edge breaks and cuts down to the right, and the level it settles at. */
const CUT_START_X = 327;
const CUT_END_X = 360;
const CUT_Y = 35;

/** The amber bar that fills the strip under the cut. */
const BAR_TOP = 37;
const BAR_BOTTOM = 49;
const BAR_RIGHT = 502;

/** The hazard stripes and the white block that sit on the bottom edge, under the mark. Eleven stripes across 56 pixels. */
const STRIPES = { left: 412, right: 468, top: 133, bottom: 140, step: 5.1, width: 3 };
const BLOCK = { left: 469, right: 493, top: 135, bottom: 139 };

/** The panel's colours, taken from the sprite. `AMBER` is shared, so anything else drawing the game's chrome matches it. */
const STROKE = "rgba(236, 236, 236, 0.38)";
export const AMBER = "#dcbb50";
const MARK = "rgba(214, 214, 214, 0.55)";

/** Props for StoryPanelFrame. */
interface StoryPanelFrameProps {
	/** Whether to draw the mark and its stripes. The choice menu uses the same frame without them. */
	marked?: boolean;
}

/**
 * The dialogue panel's frame, drawn rather than stretched from the sprite.
 *
 * The game's own art is 511x158, so a panel wider than that upscales it: 1.15x at a 1280 stage and 2.3x at 2560, which softened the
 * hairline border and the mark until neither read cleanly. Drawing the same shapes keeps them sharp at any size. The outline uses a
 * non-scaling stroke, so it stays one pixel however far the panel is stretched, and the mark is text rather than pixels.
 *
 * The panel's fill and its dot grid stay in CSS on the box behind this, since a repeating gradient tiles more cheaply than a path.
 *
 * One figure departs from the sprite on purpose: the game lets the mark overhang the white block by nine pixels, and here it ends
 * flush with it.
 *
 * @param props The component's props.
 * @returns The frame, drawn over the panel and ignoring pointer events.
 */
export default function StoryPanelFrame({ marked = true }: StoryPanelFrameProps) {
	const outline = [
		`M ${INSET} ${INSET}`,
		`L ${CUT_START_X} ${INSET}`,
		`L ${CUT_END_X} ${CUT_Y}`,
		`L ${ART_W - INSET} ${CUT_Y}`,
		`L ${ART_W - INSET} ${ART_H - INSET}`,
		`L ${INSET} ${ART_H - INSET}`,
		"Z"
	].join(" ");
	// The bar's left edge follows the cut, so it is a parallelogram rather than a rectangle.
	const bar = `M ${BAR_TOP - CUT_Y + CUT_END_X} ${BAR_TOP} L ${BAR_RIGHT} ${BAR_TOP} L ${BAR_RIGHT} ${BAR_BOTTOM} L ${BAR_BOTTOM - CUT_Y + CUT_END_X} ${BAR_BOTTOM} Z`;

	return (
		<Box
			component="svg"
			viewBox={`0 0 ${ART_W} ${ART_H}`}
			preserveAspectRatio="none"
			aria-hidden
			sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}
		>
			<path d={outline} fill="none" stroke={STROKE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
			<path d={bar} fill={AMBER} />
			{marked && (
				<>
					{/* The stripes are a run of slanted bars, drawn individually so they keep their angle when the panel is stretched. */}
					{Array.from({ length: Math.round((STRIPES.right - STRIPES.left) / STRIPES.step) }, (_, index) => {
						const x = STRIPES.left + index * STRIPES.step;
						const lean = STRIPES.bottom - STRIPES.top;
						return (
							<path
								key={x}
								d={`M ${x} ${STRIPES.bottom} L ${x + lean} ${STRIPES.top} L ${x + lean + STRIPES.width} ${STRIPES.top} L ${x + STRIPES.width} ${STRIPES.bottom} Z`}
								fill={AMBER}
							/>
						);
					})}
					<rect x={BLOCK.left} y={BLOCK.top} width={BLOCK.right - BLOCK.left} height={BLOCK.bottom - BLOCK.top} fill="#ffffff" />
					<text x={BLOCK.right} y={130} textAnchor="end" fill={MARK} style={{ fontSize: 12, letterSpacing: 0.2, fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif" }}>
						G.F.system
					</text>
				</>
			)}
		</Box>
	);
}
