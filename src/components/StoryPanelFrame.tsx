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

/** The frame's right and bottom edges in the art. */
const FRAME_RIGHT = ART_W - INSET;
const FRAME_BOTTOM = ART_H - INSET;

/** How far the frame sits inside its box, as a percentage of the box's width. Content padded by this clears the line at any width. */
export const FRAME_INSET_PCT = (100 * INSET) / ART_W;

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

/** The corner of the art the mark sits in, out to the frame's bottom right. It is drawn at one scale, so the panel never stretches it. */
const MARK_BOX = { left: 405, top: 112, width: FRAME_RIGHT - 405, height: FRAME_BOTTOM - 112 };

/** Where the amber bar ends, as a share of the panel's height. Text that starts below this line clears the bar at any width. */
export const BAR_BOTTOM_SHARE = BAR_BOTTOM / ART_H;

/** The panel's colours, taken from the sprite. `AMBER` is shared, so anything else drawing the game's chrome matches it. */
const STROKE = "rgba(236, 236, 236, 0.38)";
export const AMBER = "#dcbb50";
const MARK = "rgba(214, 214, 214, 0.55)";

/** What both drawings share: laid over the panel, deaf to the pointer, and free to draw past their box. */
const LAYER_SX = { position: "absolute", pointerEvents: "none", overflow: "visible" } as const;

/** The mark's layer, pinned to the frame's bottom right corner and sized by the panel's height alone. */
const MARK_SX = {
	...LAYER_SX,
	right: `${FRAME_INSET_PCT}%`,
	bottom: `${(100 * INSET) / ART_H}%`,
	height: `${(100 * MARK_BOX.height) / ART_H}%`,
	aspectRatio: `${MARK_BOX.width} / ${MARK_BOX.height}`
} as const;

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
 * non-scaling stroke, so it stays one pixel however far the panel is stretched. The mark is a second drawing scaled evenly by the
 * panel's height, so it keeps its shape at any width.
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
		`L ${FRAME_RIGHT} ${CUT_Y}`,
		`L ${FRAME_RIGHT} ${FRAME_BOTTOM}`,
		`L ${INSET} ${FRAME_BOTTOM}`,
		"Z"
	].join(" ");
	// The bar's left edge follows the cut, so it is a parallelogram rather than a rectangle.
	const bar = `M ${BAR_TOP - CUT_Y + CUT_END_X} ${BAR_TOP} L ${BAR_RIGHT} ${BAR_TOP} L ${BAR_RIGHT} ${BAR_BOTTOM} L ${BAR_BOTTOM - CUT_Y + CUT_END_X} ${BAR_BOTTOM} Z`;

	return (
		<>
			<Box component="svg" viewBox={`0 0 ${ART_W} ${ART_H}`} preserveAspectRatio="none" aria-hidden sx={{ ...LAYER_SX, inset: 0, width: "100%", height: "100%" }}>
				<path d={outline} fill="none" stroke={STROKE} strokeWidth={1} vectorEffect="non-scaling-stroke" />
				<path d={bar} fill={AMBER} />
			</Box>
			{/* Pinned to the frame's corner and scaled by the panel's height alone. Stretched with the outline, it smeared sideways on a wide panel. */}
			{marked && (
				<Box component="svg" viewBox={`${MARK_BOX.left} ${MARK_BOX.top} ${MARK_BOX.width} ${MARK_BOX.height}`} aria-hidden sx={MARK_SX}>
					{/* The stripes are a run of slanted bars, drawn individually so each keeps its angle. */}
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
				</Box>
			)}
		</>
	);
}
