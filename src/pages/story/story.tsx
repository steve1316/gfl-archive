import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { Link as RouterLink, useLocation, useParams } from "react-router-dom";

import { Box, Button, CircularProgress, Drawer, IconButton, Stack, Typography, useMediaQuery } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import MenuIcon from "@mui/icons-material/Menu";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import ReplayIcon from "@mui/icons-material/Replay";
import KeyboardIcon from "@mui/icons-material/Keyboard";
import HistoryIcon from "@mui/icons-material/History";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import AutorenewIcon from "@mui/icons-material/Autorenew";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import FullscreenIcon from "@mui/icons-material/Fullscreen";
import FullscreenExitIcon from "@mui/icons-material/FullscreenExit";
import SettingsIcon from "@mui/icons-material/Settings";

import {
	MOBILE_LANDSCAPE_QUERY,
	MobileStoryReader,
	STORY_END_Z,
	StoryCorner,
	StoryEndCard,
	StoryLogPanel,
	StorySettingsCard,
	StorySettingsPanel,
	StorySkipIcon,
	useAudioGate,
	useIsMobile,
	useStoryKeys,
	useStorySettings
} from "archive-kit";
import type { StoryChoice, StoryControl, StoryCornerProps, StoryCurrentLine, StoryLine } from "archive-kit";

import LoadError from "../../components/LoadError";
import StoryPanelFrame, { AMBER } from "../../components/StoryPanelFrame";
import ScrollToTop from "../../components/ScrollToTop";
import { storyAudioUrl, storyBackgroundUrl, storySpriteUrl, storyUiUrl } from "../../lib/assets";
import { loadStoryChapter, loadStoryIndex, loadStoryScene } from "../../lib/data";
import { hasStoryAudio, hasStoryBackground, hasStorySprite, hasStoryUi, storySpriteStem } from "../../lib/processData";
import { branchRegions, buildTimeline, linesRead, lineTotal, reachedChoices } from "../../lib/storyBranches";
import type { BranchMap } from "../../lib/storyBranches";
import { trackTitle } from "../../lib/storyMusic";
import type { StoryBeat, StoryChapter, StoryChapterSummary, StoryMission, StoryPage, StoryScene } from "../../types/story";

/** How long one character takes to type before the reader's speed and `SPEED_BASE` apply, in milliseconds. */
const TYPE_MS = 28;

/** How long autoplay waits on a finished page before advancing, in milliseconds. */
const AUTO_HOLD_MS = 1400;

/** Where the reader's place in each scene is remembered. */
const PROGRESS_KEY = "storyProgress";

/**
 * Where the reader's choice to silence the story was remembered before it joined the story settings. AK wrote the same key on this origin,
 * so muting one archive muted the other. It is read once, to seed the mute setting, and never written again.
 */
const MUTED_KEY = "storyMuted";

/** Where the old single volume setting was remembered. Read once, to seed both new volumes. */
const VOLUME_KEY = "storyVolume";

/** Where the reader's story settings are kept. AK shares this origin, so the key carries the site's name. */
const SETTINGS_KEY = "gfl.storySettings";

/** Where the fact that the reader has already been shown the keys is remembered. */
const HINT_KEY = "storyKeysSeen";

/**
 * What the text speed setting's 1x means here: the old speed slider's default. The game's own pace read too fast to follow, so the reader's
 * speed multiplies this rather than `TYPE_MS` alone.
 */
const SPEED_BASE = 0.75;

/** The game's own playback types, as the headings the scene menu groups chapters under. */
const CHAPTER_GROUPS: { type: number; label: string }[] = [
	{ type: 1, label: "Main Story" },
	{ type: 2, label: "Story Events" },
	{ type: 3, label: "Minor Events" }
];

/**
 * How loud the music sits under the dialogue, and how loud a sound effect fires over it.
 *
 * These are the balance between the two. The reader's BGM and SFX settings scale each.
 */
const MUSIC_VOLUME = 0.35;
const EFFECT_VOLUME = 0.6;

/**
 * The dot grid inside the dialogue panel, as the game draws it: a fine light dot every 6.5 pixels over a near-black fill.
 *
 * Kept a fixed size rather than scaled with the panel, so it stays a crisp one-pixel dot on any display instead of blurring the
 * way the stretched sprite did.
 */
const PANEL_DOTS = "radial-gradient(circle at 50% 50%, rgba(238, 238, 238, 0.13) 0, rgba(238, 238, 238, 0.13) 0.7px, rgba(0, 0, 0, 0) 1.2px)";
const PANEL_DOT_SIZE = "6.5px 6.5px";

/**
 * The two entries in the game's background table that are a wash rather than a picture, so they have no art to publish.
 *
 * `White` reads as its name suggests, but the game's own player draws it as a near-transparent black over a black page, so it
 * comes out black there. Ours follows that rather than the name.
 */
const BACKGROUND_WASHES = new Set(["black", "white"]);

/** How wide the dialogue box sits, as a share of the stage, matching the game's own layout. */
const BOX_WIDTH_PCT = 46;

/** How far a character is dropped below the top of the stage, as a share of its height. */
const SPRITE_DROP_PCT = 20;

/**
 * The window a character calling in is seen through, as shares of the stage's height.
 *
 * A comms character is not drawn whole: the game crops the sprite to head and shoulders and shows that inside a frame, which is
 * what makes the beat read as a call rather than someone standing in the room. Measured against the game's own player, where the
 * window is 330x480 of an 800-tall stage, sitting 10% down and centred on the sprite.
 */
const COMMS_WIDTH_CQH = 41.25;
const COMMS_HEIGHT_CQH = 60;
const COMMS_TOP_CQH = 10;

/** The game's own comms frame, drawn around the window as a nine-slice. */
const COMMS_FRAME = hasStoryUi() ? `url(${storyUiUrl("layerbord")})` : "none";

/**
 * How far the frame hangs outside the window it draws, again as shares of the stage's height.
 *
 * The art holds two frames offset from one another, so the drawn border is not symmetric: it sits further out on the left and the
 * bottom than on the other two sides. Measured from where the frame's ink actually lands around a 330x480 window.
 */
const COMMS_FRAME_INSET = { top: -0.72, right: -0.63, bottom: -2.86, left: -2.27 };

/**
 * How thick each side of the frame is drawn, and which bands of the art fill it.
 *
 * The side slices are wider than half the art, so the browser squeezes them to meet in the middle: that is what turns the art's
 * chunky corner brackets into the thin outline the game shows.
 */
const COMMS_FRAME_BORDER = { top: 4.6, right: 4.6, bottom: 7.5, left: 7.5 };
const COMMS_FRAME_SLICE = "37.5% 37.5% 60% 60%";

/**
 * What backs the window, under the picture and the screen.
 *
 * The game's own window is opaque: the scene behind it does not show through at all, and its teal is the screen's doing rather
 * than the backing's. Sampled across the game's window it reads a flat `rgb(15, 58, 58)`, which is what this screen over black
 * composites to.
 */
const COMMS_BACKING = "#000000";

/** The halftone screen laid over a caller, which is what makes the picture read as a feed rather than a person in the room. */
const COMMS_SCREEN = "radial-gradient(rgba(204, 204, 204, 0.47) 0, rgba(0, 255, 255, 0.2) 0.6px)";
const COMMS_SCREEN_SIZE = "3px 3px";

/** How long a character takes to arrive, in milliseconds. The game's own player slides them in from 20px to the left. */
const SPRITE_IN_MS = 200;

/** The arrival itself, shared by a character on stage and one calling in so both enter the same way. */
const SPRITE_IN = {
	animation: `storySpriteIn ${SPRITE_IN_MS}ms ease-out both`,
	"@keyframes storySpriteIn": {
		from: { opacity: 0, transform: "translateX(calc(-50% - 20px))" },
		to: { opacity: 1, transform: "translateX(-50%)" }
	}
};

/**
 * Where the player stops laying its chrome over the scene and stacks it underneath instead.
 *
 * Keyed on the viewport's shape rather than on `orientation`, so a narrow desktop window gets the readable layout too instead of
 * being a case nobody thought about. Taller than it is wide: a phone in portrait is 0.46 and a tablet 0.75, while a desktop
 * window narrowed to 900x800 is 1.13 and keeps the scene whole, which 13/10 took away from it far too early.
 */
const STACKED_QUERY = "(max-aspect-ratio: 1/1)";
const STACKED = `@media ${STACKED_QUERY}`;

/**
 * How far the panel's drawn frame sits inside its box, as a share of the box's width.
 *
 * `StoryPanelFrame` insets its outline by 8 of the artwork's 511 units and stretches to fit, so the line moves further in as the
 * panel gets wider. A fixed padding therefore crowds the text against it: at 876px the gap had closed to 6px.
 */
const FRAME_INSET_PCT = (100 * 8) / 511;

/** How many spoken lines the stacked layout keeps above the current one, to fill the space the 16:9 scene cannot use. */
const TRANSCRIPT_LINES = 4;

/**
 * How wide each black margin beside the scene has to be before the chrome moves into it, in pixels.
 *
 * A phone in landscape leaves about 224px a side, because the browser keeps its address bar and the page never scrolls, so the
 * scene is height-bound and narrow. A desktop leaves about 70 and a tablet none at all, and those keep the chrome over the scene.
 */
const CINEMA_MIN_MARGIN = 170;

/** The page on a phone: the whole screen on its side, where the reader hides the navbar. Last, so it wins over the bar heights in `main`. */
const PHONE_MAIN_SX = { [`@media ${MOBILE_LANDSCAPE_QUERY}`]: { height: "100dvh" } } as const;

/** The shared reader in this archive's colours: the cyan the story player already speaks in, and its amber for a picked choice. */
const READER_SX = (theme: Theme) => ({ "--reader-accent": theme.palette.secondary.main, "--reader-pick": AMBER });

/** The end card's way back: every chapter, since a scene has no list of its own to return to. */
const BACK_TO_CHAPTERS = { label: "Back to all chapters", to: "/story" };

/** Carried on every link into a scene from inside the player, telling it to open at the start rather than resume. */
const OPEN_AT_START = { restart: true };

/** How many pictures a scene warms at once. Enough to stay ahead of the reader without crowding out the one on screen. */
const PRELOAD_LANES = 4;

/** How long a screen fade takes to wash in or out, in milliseconds. */
const WASH_MS = 450;

/** How far a shake of range 1 moves the stage, as a share of its width. Scripts ask for ranges of about 5 to 8. */
const SHAKE_UNIT = 0.0015;

/** The longest a shake runs, in seconds. Scripts ask for up to 4, which reads as a fault rather than an impact. */
const SHAKE_MAX_S = 1.2;

const styles = {
	// The scene takes the whole of what the navbar leaves, and sits centred in it when the window is taller than 16:9.
	//
	// Measured against the viewport rather than the page: the wrapper above grows to its content, so a `height: 100%` here left a
	// 16:9 stage on a wide window taller than the space it had, pushing the panel off the bottom and giving the page a scrollbar.
	// The bar's own heights come from the theme, which is where MUI keeps the three it uses.
	main: (theme: Theme) => {
		const below = (height: unknown) => ({ height: `calc(100dvh - ${typeof height === "number" ? `${height}px` : String(height)})` });
		const bar = theme.mixins.toolbar as Record<string, unknown>;
		const queries = Object.fromEntries(
			Object.entries(bar)
				.filter(([key, value]) => key.startsWith("@media") && typeof value === "object" && value !== null && "minHeight" in value)
				.map(([key, value]) => [key, below((value as { minHeight: unknown }).minHeight)])
		);
		return {
			...below(bar.minHeight),
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			overflow: "hidden",
			bgcolor: "#05070c",
			// Queried by the stage, so it can take the lesser of the width it has and the width its height allows.
			containerType: "size",
			...queries
		};
	},
	// Holds the scene and its chrome. Above the breakpoint it is exactly the scene's box and the chrome is laid over it; below, it
	// becomes a column and the chrome falls into flow underneath.
	player: {
		position: "relative",
		// Whichever of the two the space allows: a `width: 100%` with a capped height stretched the scene instead of shrinking it.
		width: "min(100cqw, calc(100cqh * 16 / 9))",
		aspectRatio: "16 / 9",
		[STACKED]: { width: "100%", height: "100%", aspectRatio: "auto", display: "flex", flexDirection: "column" }
	},
	stage: {
		position: "relative",
		width: "100%",
		aspectRatio: "16 / 9",
		flex: "none",
		overflow: "hidden",
		// What a blanked background shows through as. The scene's own picture covers it whenever the scene is not blanked.
		bgcolor: "#000000",
		transition: `background-color ${WASH_MS}ms ease`,
		cursor: "pointer",
		userSelect: "none",
		// Queried by the characters, so a comms window can be sized against the stage rather than against its own slot.
		containerType: "size",
		// Keeps the end's black inside the stage, so the plates and the dialogue, which sit outside it, stay above it and usable.
		isolation: "isolate"
	},
	// The scene's picture, on its own layer so a beat that blanks the background fades it out and leaves the cast against the bare stage.
	scene: { position: "absolute", inset: 0, transition: `opacity ${WASH_MS}ms ease` },
	sprites: { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" },
	// One slot per character on stage, spread evenly across the full width: one sits centred, two at a third and two thirds.
	// Each is a square the height of the stage, dropped so the character is framed from the waist up, as the game draws them.
	spriteSlot: {
		position: "absolute",
		top: `${SPRITE_DROP_PCT}%`,
		height: "100%",
		aspectRatio: "1 / 1",
		transform: "translateX(-50%)",
		...SPRITE_IN
	},
	spriteArt: { width: "100%", height: "100%", objectFit: "contain", objectPosition: "top", display: "block" },
	// Where the window sits. It does not crop, because the frame is drawn hanging outside the window and would lose its outer edge.
	comms: {
		position: "absolute",
		top: `${COMMS_TOP_CQH}cqh`,
		width: `${COMMS_WIDTH_CQH}cqh`,
		height: `${COMMS_HEIGHT_CQH}cqh`,
		transform: "translateX(-50%)",
		...SPRITE_IN
	},
	// The window itself: the sprite is drawn at its usual size inside and this crops it, so the crop lands on the same part of the
	// character however tall the stage is.
	commsCrop: { position: "absolute", inset: 0, overflow: "hidden", bgcolor: COMMS_BACKING },
	// Drawn behind the caller, so the frame's own dark bands sit under them rather than over their face.
	commsFrame: {
		position: "absolute",
		top: `${COMMS_FRAME_INSET.top}cqh`,
		right: `${COMMS_FRAME_INSET.right}cqh`,
		bottom: `${COMMS_FRAME_INSET.bottom}cqh`,
		left: `${COMMS_FRAME_INSET.left}cqh`,
		pointerEvents: "none",
		borderStyle: "solid",
		borderWidth: `${COMMS_FRAME_BORDER.top}cqh ${COMMS_FRAME_BORDER.right}cqh ${COMMS_FRAME_BORDER.bottom}cqh ${COMMS_FRAME_BORDER.left}cqh`,
		borderImageSource: COMMS_FRAME,
		borderImageSlice: COMMS_FRAME_SLICE,
		borderImageRepeat: "stretch"
	},
	// The caller, drawn at the size a character on stage would be so the window crops the same part of them however tall the stage is.
	commsArt: {
		position: "absolute",
		left: "50%",
		top: `${SPRITE_DROP_PCT - COMMS_TOP_CQH}cqh`,
		width: "100cqh",
		height: "100cqh",
		transform: "translateX(-50%)",
		objectFit: "contain",
		objectPosition: "top",
		display: "block"
	},
	commsScreen: { position: "absolute", inset: 0, pointerEvents: "none", backgroundImage: COMMS_SCREEN, backgroundSize: COMMS_SCREEN_SIZE },
	// Where the margins are wide enough to hold the chrome, the three parts sit side by side and the scene is left alone.
	playerCinema: { width: "100%", height: "100%", aspectRatio: "auto", display: "flex", alignItems: "stretch" },
	stageCinema: { width: "auto", height: "100%", flex: "none" },
	// Three across, so ten plates take four rows with Full alone on the last. Two columns needed more rows than the height the browser leaves,
	// and shortening the plates to make them fit would have put them under the size a thumb hits. Relative, so the Settings card can open beside it.
	controlsCinema: { position: "relative", order: -1, flex: "none", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0.75, alignContent: "center", px: 1 },
	// The current line sits at the bottom of the column with whatever history fits above it.
	stackCinema: { position: "static", flex: "none", display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "stretch", gap: 0.75, px: 1, py: 1 },
	// The margin's own panel. The game's frame is a 511x158 drawing and this box is nearly square, so it is left off rather than
	// stretched into a shape the game never draws. The amber edge is what carries it instead.
	slab: {
		position: "relative",
		width: "100%",
		boxSizing: "border-box",
		display: "flex",
		flexDirection: "column",
		// Gives way only after the history above it has, and scrolls its own text rather than pushing past the column.
		flex: "0 1 auto",
		minHeight: 0,
		maxHeight: "100%",
		p: 1.25,
		bgcolor: "rgba(8, 9, 13, 0.9)",
		borderLeft: `3px solid ${AMBER}`
	},
	slabText: { whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 14, flex: 1, minHeight: 0, overflowY: "auto" },
	transcriptCinema: { display: "flex", flexDirection: "column", justifyContent: "flex-end", flex: "0 100 auto", minHeight: 0, overflow: "hidden", px: 0 },
	// Everything that sits along the bottom of the scene, stacked so a taller dialogue box pushes the hint up instead of meeting it.
	bottomStack: {
		position: "absolute",
		left: 0,
		right: 0,
		bottom: "3.5%",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: 1,
		px: 1,
		// Below the breakpoint it takes whatever height the scene leaves, so the panel grows rather than the page ending in black.
		[STACKED]: { position: "static", flex: 1, minHeight: 0, alignItems: "stretch", px: 1.5, pt: 2, pb: 1 }
	},
	// The lines already read, kept above the current one where the stacked layout has room for them. It takes the slack the scene
	// leaves rather than the panel doing it, since the panel's frame is one drawing and stretching it warps the notch and the bar.
	transcript: {
		display: "none",
		maskImage: "linear-gradient(to bottom, transparent 0, #000 1.4em)",
		WebkitMaskImage: "linear-gradient(to bottom, transparent 0, #000 1.4em)",
		[STACKED]: { display: "flex", flexDirection: "column", justifyContent: "flex-end", flex: 1, minHeight: 0, overflow: "hidden", px: 0.5, pb: 0.5 }
	},
	transcriptLine: { fontSize: 14, lineHeight: 1.55, color: "text.disabled", mb: 0.75 },
	transcriptSpeaker: { fontWeight: 700, color: "text.secondary" },
	// The dialogue box's panel.
	panel: {
		position: "relative",
		width: { xs: "94%", sm: `${BOX_WIDTH_PCT}%` },
		// Never shrinks: it is a flex item in the stacked column, and letting it give way clipped the last line of a long beat.
		// Padding that follows the frame instead of a fixed inset, so the text clears the drawn line at any panel width.
		[STACKED]: { width: "100%", flexShrink: 0, pl: `calc(${FRAME_INSET_PCT}% + 14px)`, pr: `calc(${FRAME_INSET_PCT}% + 14px)` },
		boxSizing: "border-box",
		// The panel carries its own mark in the bottom right, so the text is kept clear of that corner.
		p: { xs: 1.5, sm: 2.5 },
		pb: { xs: 2.5, sm: 3.5 },
		backgroundImage: PANEL_DOTS,
		backgroundSize: PANEL_DOT_SIZE,
		bgcolor: "rgba(10, 10, 12, 0.86)"
	},
	// One height, whatever the beat holds. The panel art carries a notch in its top right, and letting the box grow for a longer
	// line or for the end row restretched that art until the text sat under it.
	box: { position: "relative", minHeight: { xs: "8.6em", sm: "9.6em" }, [STACKED]: { minHeight: "11.2em" } },
	// The panel's flowing content, lifted over the drawn frame. The end row is positioned against the panel instead, so it is
	// deliberately left out of this.
	panelBody: { position: "relative", display: "flex", flexDirection: "column", minHeight: 0, flex: 1 },
	// The options alone, in the middle of the scene and as wide as the dialogue box, which stays where it is under them.
	choices: {
		position: "absolute",
		left: "50%",
		top: "50%",
		transform: "translate(-50%, -50%)",
		zIndex: 6,
		width: `${BOX_WIDTH_PCT}%`,
		display: "flex",
		flexDirection: "column",
		gap: "1.5cqh",
		maxHeight: "90%",
		overflowY: "auto",
		[STACKED]: { width: "86%" }
	},
	// The tints sit over the scene but under the dialogue, so a line spoken over a darkened scene is still readable.
	wash: { position: "absolute", inset: 0, pointerEvents: "none", transition: `opacity ${WASH_MS}ms ease` },
	// A beat's own transition, played once as it arrives and then gone, rather than a wash left sitting over the scene.
	fade: { position: "absolute", inset: 0, pointerEvents: "none", animation: `storyFade ${WASH_MS}ms ease-out both`, "@keyframes storyFade": { from: { opacity: 1 }, to: { opacity: 0 } } },
	// The game keeps its controls in the top left of the scene itself, as small square plates rather than a toolbar. Below the
	// breakpoint they become a row under the scene, where a thumb reaches them and they are not eating the picture.
	stageControls: {
		position: "absolute",
		top: "1%",
		left: "1.3%",
		display: "flex",
		gap: { xs: 0.5, sm: 1 },
		[STACKED]: {
			// Relative rather than static, so the Settings card can hang under the row.
			position: "relative",
			flex: "none",
			// Ten plates will not sit on one line at 384px without going under the size a thumb hits, so the row wraps instead.
			flexWrap: "wrap",
			rowGap: 0.75,
			justifyContent: "center",
			px: 1,
			py: 1,
			bgcolor: "rgba(0, 0, 0, 0.35)",
			borderTop: "1px solid",
			borderBottom: "1px solid",
			borderColor: "divider"
		}
	},
	stageButton: {
		minWidth: 0,
		// 48 tall is the smallest target a thumb hits reliably, so the plates narrow before they shorten.
		width: { xs: 40, sm: 45 },
		height: 48,
		p: 0.25,
		flexDirection: "column",
		gap: 0,
		color: "common.white",
		borderColor: "rgba(255, 255, 255, 0.53)",
		bgcolor: "rgba(0, 0, 0, 0.35)",
		borderRadius: "3px",
		lineHeight: 1,
		textTransform: "none",
		"&:hover": { borderColor: "common.white", bgcolor: "rgba(0, 0, 0, 0.6)" }
	},
	// Kept at every width. Eight unlabelled glyphs are not guessable, and Log, Reset and Skip least of all.
	stageButtonLabel: { fontSize: { xs: 9, sm: 10 }, lineHeight: 1.1 },
	// Autoplay is the one control that keeps working after it is pressed, so its plate says so: a dashed edge and a turning icon.
	stageButtonRunning: {
		borderStyle: "dashed",
		borderColor: "secondary.main",
		color: "secondary.main",
		"& .MuiSvgIcon-root": { animation: "storyAutoSpin 2.4s linear infinite" },
		"@keyframes storyAutoSpin": { from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } }
	},
	// A gap opens before each group of plates, so navigation and playback read as separate sets rather than one long row.
	plateGap: { ml: { xs: 1, sm: 1.75 } },
	// The Settings card hangs under the plates in the scene's corner, and centred under the row when it is stacked.
	settingsCard: { top: "calc(100% + 8px)", left: 0, [STACKED]: { left: "50%", transform: "translateX(-50%)" } },
	// In the wide layout's margin, the card opens beside the plate grid, over the scene's left edge.
	settingsCardCinema: { top: "50%", left: "calc(100% + 8px)", transform: "translateY(-50%)" },
	// The fullscreen control where the plates have left the scene: the bare icon in its corner, with no plate around it. The shadow
	// is what keeps it readable, since plenty of scenes play on snow or on a white wash.
	sceneFullscreen: {
		position: "absolute",
		// One above the kit's named end layer, so it still works once the scene is over.
		zIndex: STORY_END_Z + 1,
		top: "2.5%",
		left: "2%",
		width: 40,
		height: 40,
		color: "common.white",
		// Four one-pixel shadows, which is an outline in all but name. A blurred shadow alone vanished against a snow scene.
		filter: ["drop-shadow(1px 0 0 rgba(0, 0, 0, 0.85))", "drop-shadow(-1px 0 0 rgba(0, 0, 0, 0.85))", "drop-shadow(0 1px 0 rgba(0, 0, 0, 0.85))", "drop-shadow(0 -1px 0 rgba(0, 0, 0, 0.85))"].join(
			" "
		),
		"&:hover": { bgcolor: "transparent" }
	},
	// The keys, shown once and then only on request.
	hint: {
		display: "flex",
		// There are no keys to teach on a touch device, and tapping the scene to read on teaches itself.
		"@media (pointer: coarse)": { display: "none" },
		alignItems: "center",
		flexWrap: "wrap",
		justifyContent: "center",
		rowGap: 0.5,
		columnGap: 2,
		maxWidth: "92%",
		px: 2,
		py: 1,
		bgcolor: "rgba(8, 12, 20, 0.92)",
		border: "1px solid",
		borderColor: "rgba(255, 255, 255, 0.25)",
		borderRadius: 1,
		fontSize: 13
	},
	key: { display: "inline-block", px: 0.75, mx: 0.25, borderRadius: "3px", bgcolor: "#262b36", border: "1px solid #454f63", borderBottomWidth: "2px", fontSize: 12 },
	menuRow: { display: "flex", alignItems: "center", gap: 1.25, px: 2, minHeight: 48, fontSize: 13, borderLeft: "3px solid transparent", cursor: "pointer", "&:hover": { bgcolor: "action.hover" } },
	menuRowOn: { bgcolor: "action.selected", borderLeftColor: "secondary.main" },
	menuLabel: { color: "text.secondary", minWidth: 44, fontVariantNumeric: "tabular-nums" },
	menuCount: { ml: "auto", color: "text.disabled", fontSize: 11 },
	menuButton: { width: "100%", bgcolor: "transparent", border: 0, font: "inherit", color: "text.primary", textAlign: "left" },
	menuSub: { pl: 5, fontSize: 12.5, color: "text.secondary" },
	link: { textDecoration: "none", color: "text.primary" },
	menuHead: { px: 2, pt: 1.5, pb: 0.5, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "secondary.main", fontWeight: 700 },
	// The game's own choice bars: dark, with a thin light edge and the text centred.
	choiceButton: {
		justifyContent: "center",
		textAlign: "center",
		textTransform: "none",
		lineHeight: 1.45,
		fontSize: "max(13px, 2.05cqh)",
		fontWeight: 400,
		px: "2.2cqh",
		py: "1.25cqh",
		borderRadius: 0,
		color: "#f2f2f2",
		bgcolor: "rgba(12, 12, 14, 0.82)",
		border: "1px solid rgba(255, 255, 255, 0.5)",
		"&:hover": { bgcolor: "rgba(255, 255, 255, 0.14)", borderColor: "#ffffff" }
	},
	// Holds its line whether or not the beat names anyone: the panel art cuts a notch across its top right, and narration that
	// started at the very top of the box ran straight into it.
	// The stacked panel is tall enough that a 0.5 gap read as the body being part of the speaker's own line.
	speaker: { fontWeight: 800, color: "secondary.main", mb: 0.5, lineHeight: 1.6, height: "1.6em", [STACKED]: { mb: 1.25 } },
	// A fixed run of lines, scrolling past it, so a one-line beat and a three-line beat leave the box the same shape.
	// A fixed height, so the panel's frame is drawn at one size whatever the beat holds. Two lines is right at 46% of a wide stage
	// and far too few at 384px, where the same sentence wraps to four, so the stacked layout gets its own.
	text: {
		whiteSpace: "pre-wrap",
		lineHeight: 1.7,
		height: "3.4em",
		overflowY: "auto",
		// The frame's amber bar reaches across the top right. At 46% of a wide stage no line is long enough to meet it; at 384px
		// every line is, so the first one is cut short around it the way text wraps around a picture.
		[STACKED]: { height: "6.8em", "&::before": { content: '""', float: "right", width: "31%", height: "1.7em" } }
	},
	caret: { display: "inline-block", width: "0.5em", textAlign: "center", opacity: 0.7 },
	// Two readings of the same hint. A touch device has no keys to be told about, and was being told nothing at all instead.
	// The drawer's way back to the hint, hidden alongside it wherever there is no keyboard to describe.
	hintLink: { justifyContent: "flex-start", "@media (pointer: coarse)": { display: "none" } }
} satisfies Record<string, SxProps<Theme>>;

/** Where a reader had got to in one scene, as it is kept in storage. */
interface SceneProgress {
	/** How far into the played timeline they had read. */
	beat: number;
	/** The branch number taken at each choice, keyed by that choice's index into the scene's regions. */
	choices: Record<number, string>;
}

/** What the stage shows at a point in the scene, folded from every beat up to it. */
interface Stage {
	/** The background the scene is currently on, or null before any is set. */
	background: string | null;
	/** The music cue currently playing, or null before any is set. */
	bgm: string | null;
	/** Whether the scene is dimmed, which scripts use to hold a moment back while something else is read. */
	darkened: boolean;
	/** Whether the scene is under the night tint. */
	night: boolean;
	/** What the background is blanked to, leaving the cast against that colour until a later beat brings the picture back. */
	blankedTo: "black" | "white" | null;
}

/**
 * Every picture a scene will ask for, in the order its beats reach them.
 *
 * Beat order matters: warming them in that order means the pictures for the opening lines arrive first, so the reader is never
 * waiting on a character who was always going to appear two lines later.
 *
 * @param beats The scene's beats.
 * @param missionBackground The background the mission opens on, used before any beat names one.
 * @returns The URLs, each listed once.
 */
function sceneImages(beats: StoryBeat[], missionBackground?: string): string[] {
	const urls: string[] = [];
	const add = (url: string | null) => {
		if (url !== null && !urls.includes(url)) {
			urls.push(url);
		}
	};
	if (missionBackground && hasStoryBackground(missionBackground)) {
		add(storyBackgroundUrl(missionBackground));
	}
	for (const beat of beats) {
		for (const op of beat.ops) {
			if (op.type === "background" && op.value && !BACKGROUND_WASHES.has(op.value.toLowerCase()) && hasStoryBackground(op.value)) {
				add(storyBackgroundUrl(op.value));
			}
		}
		for (const sprite of beat.sprites) {
			if (!sprite.shown) {
				continue;
			}
			const stem = storySpriteStem(sprite.prefab);
			if (stem !== null) {
				add(storySpriteUrl(stem, hasStorySprite(sprite.prefab, sprite.expression) ? sprite.expression : 0));
			}
		}
	}
	return urls;
}

/**
 * Whether a beat opens with a flash rather than simply cutting.
 *
 * Only `白屏闪光` is a flash, and the scripts use it three times in all. The numbered pairs are not flashes: they blank the
 * background and hold it, which `stageAt` carries instead.
 *
 * @param beat The beat, or null.
 * @returns Whether the beat opens with a flash.
 */
function fadeAt(beat: StoryBeat | null): boolean {
	return (beat?.ops ?? []).some((op) => op.type === "whiteFlash");
}

/** A shake the script asked for on one beat. */
interface Shake {
	/** How long the stage shakes for, in seconds. */
	duration: number;
	/** How far it moves, in the script's own units. */
	range: number;
}

/**
 * A placeholder backdrop derived from the scene's background code.
 *
 * A beat's own background op is a scene-local index the game resolves in code it does not ship, so mid-scene changes cannot be
 * mapped to a picture. Deriving a hue from the code at least makes each backdrop distinct and stable, the way `ArtPlaceholder`
 * stands in for card art that is not hosted.
 *
 * @param background The background code, or null.
 * @returns A CSS gradient.
 */
function backdrop(background: string | null): string {
	if (background === null) {
		return "linear-gradient(160deg, #10141f, #05070c)";
	}
	let hash = 0;
	for (const character of background) {
		hash = (hash * 31 + character.charCodeAt(0)) % 360;
	}
	return `linear-gradient(160deg, hsl(${hash}, 28%, 22%), hsl(${(hash + 40) % 360}, 30%, 9%))`;
}

/**
 * Flatten a page's styled runs into plain text, for the backlog and for measuring how much has been typed.
 *
 * @param page The page.
 * @returns Its text.
 */
function pageText(page: StoryPage): string {
	return page.spans.map((span) => span.text).join("");
}

/**
 * The last page with text at or before the one on screen, and the beat it belongs to. A choice's own page is often empty, so this is the
 * line the dialogue box keeps showing while the options wait.
 *
 * @param played The beats the timeline plays.
 * @param at Index of the beat on screen.
 * @param page Index of the page on screen.
 * @returns The beat and page, or null when nothing has been said yet.
 */
function lastSaid(played: StoryBeat[], at: number, page: number): { beat: StoryBeat; page: StoryPage } | null {
	for (let index = at; index >= 0; index--) {
		const beat = played[index];
		const pages = beat ? (index === at ? beat.pages.slice(0, page + 1) : beat.pages) : [];
		for (let position = pages.length - 1; position >= 0; position--) {
			const entry = pages[position];
			if (beat && entry && pageText(entry).trim() !== "") {
				return { beat, page: entry };
			}
		}
	}
	return null;
}

/**
 * Every line read so far, oldest first, ending at the page on screen. A track's start comes before the beat that starts it, and each answered
 * choice before the first beat played at or after the point where the scene offered it, so the Log reads in the order the reader met them.
 *
 * @param played The beats the timeline plays.
 * @param upTo Index of the beat on screen.
 * @param page Index of the page on screen.
 * @param order Each of the scene's beats by its place in the script.
 * @param map The scene's branch map, or null before the scene loads.
 * @param choices The branch picked at each answered choice, keyed by its index into the map's regions.
 * @returns The lines.
 */
function logLines(played: StoryBeat[], upTo: number, page: number, order: Map<StoryBeat, number>, map: BranchMap | null, choices: Record<number, string>): StoryLine[] {
	// Each answered choice and the picked option's text, in the order the scene offers them.
	const picks = (map?.regions ?? []).flatMap((region, index) => {
		const option = region.options.find((entry) => entry.label === choices[index]);
		return option ? [{ start: region.start, text: option.text }] : [];
	});
	const lines: StoryLine[] = [];
	let next = 0;
	let playing: string | null = null;
	played.slice(0, upTo + 1).forEach((beat, position) => {
		const at = order.get(beat) ?? 0;
		for (let pick = picks[next]; pick !== undefined && pick.start <= at; pick = picks[next]) {
			lines.push({ speaker: null, text: pick.text, kind: "choice" });
			next += 1;
		}
		// The last cue a beat names is the one it plays, as `stageAt` reads it, and only a change starts a track.
		const cue = beat.ops.filter((op) => op.type === "bgm" && op.value).at(-1)?.value ?? null;
		if (cue !== null && cue !== playing) {
			playing = cue;
			const title = trackTitle(cue);
			if (title !== null) {
				lines.push({ speaker: null, text: title, kind: "track" });
			}
		}
		const pages = position === upTo ? beat.pages.slice(0, page + 1) : beat.pages;
		for (const entry of pages) {
			// A page with no text, such as a choice's own, is no line to read.
			if (pageText(entry).trim() !== "") {
				lines.push({ speaker: beat.speaker, text: pageText(entry) });
			}
		}
	});
	return lines;
}

/**
 * How wide the black margin beside the scene is, in pixels.
 *
 * The scene is always 16:9, so whatever its box cannot use is split evenly either side of it. Measured rather than inferred from
 * a breakpoint, since the height the browser leaves changes with its own chrome and there is no query that does the arithmetic.
 *
 * @param ref The player's outer box.
 * @returns The margin on one side, or 0 while it is unknown.
 */
function useSideMargin(ref: RefObject<HTMLElement | null>): number {
	const [margin, setMargin] = useState(0);
	useEffect(() => {
		const element = ref.current;
		if (element === null || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver((entries) => {
			const box = entries[0]?.contentRect;
			if (box !== undefined) {
				setMargin(Math.max(0, (box.width - (box.height * 16) / 9) / 2));
			}
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return margin;
}

/**
 * Whether an element is the one the browser is showing fullscreen, kept in step with the browser's own view of it.
 *
 * The reader can leave fullscreen without touching the plate, with the back gesture or `Esc`, so this follows the browser rather
 * than remembering what was asked for.
 *
 * @param ref The element the plate puts fullscreen.
 * @returns Whether it is fullscreen now.
 */
function useFullscreen(ref: RefObject<HTMLElement | null>): boolean {
	const [full, setFull] = useState(false);
	useEffect(() => {
		const sync = () => setFull(document.fullscreenElement === ref.current && ref.current !== null);
		sync();
		document.addEventListener("fullscreenchange", sync);
		return () => document.removeEventListener("fullscreenchange", sync);
	}, [ref]);
	return full;
}

/**
 * The stage as it stands at a beat, folded from the ops of every beat up to and including it.
 *
 * Background and music persist until something changes them, so they cannot be read off the current beat alone.
 *
 * @param beats The scene's beats.
 * @param upTo Index of the current beat.
 * @returns The stage.
 */
function stageAt(beats: StoryBeat[], upTo: number): Stage {
	const stage: Stage = { background: null, bgm: null, darkened: false, night: false, blankedTo: null };
	for (let index = 0; index <= upTo && index < beats.length; index++) {
		for (const op of beats[index]?.ops ?? []) {
			switch (op.type) {
				case "background":
					if (op.value) {
						stage.background = op.value;
						// A new scene starts in the clear, or a dimming meant for the last one would hang over it.
						stage.darkened = false;
						stage.night = false;
						stage.blankedTo = null;
					}
					break;
				case "bgm":
					if (op.value) {
						stage.bgm = op.value;
					}
					break;
				case "darken":
					stage.darkened = true;
					break;
				case "brighten":
					stage.darkened = false;
					break;
				case "night":
					stage.night = true;
					break;
				// The scripts write these as numbered pairs. The first blanks the background and the cast plays on against the bare
				// colour, which is how a scene holds a beat apart without cutting away. The second brings the picture back.
				case "blackscreenOn":
				case "fadePointOn":
					stage.blankedTo = "black";
					break;
				case "whitescreenOn":
					stage.blankedTo = "white";
					break;
				case "blackscreenOff":
				case "fadePointOff":
				case "whitescreenOff":
					stage.blankedTo = null;
					break;
				default:
					break;
			}
		}
	}
	return stage;
}

/**
 * The stage animation for one shake.
 *
 * @param shake The shake.
 * @returns An `sx` fragment holding the animation and its keyframes.
 */
function shakeSx(shake: Shake) {
	const amplitude = shake.range * SHAKE_UNIT * 100;
	return {
		animation: `storyShake ${shake.duration}s cubic-bezier(.36,.07,.19,.97) both`,
		"@keyframes storyShake": {
			"10%, 90%": { transform: `translateX(${-amplitude}%)` },
			"20%, 80%": { transform: `translateX(${amplitude * 1.8}%)` },
			"30%, 50%, 70%": { transform: `translateX(${-amplitude * 2.6}%)` },
			"40%, 60%": { transform: `translateX(${amplitude * 2.6}%)` }
		}
	};
}

/**
 * The shake a beat asks for.
 *
 * Scripts write it as `%%key=value%%` pairs, such as `%%type_id=2%%duration=3%%delay=0.1%%range=8`.
 *
 * @param beat The beat, or null.
 * @returns The shake, or null when the beat asks for none.
 */
function shakeAt(beat: StoryBeat | null): Shake | null {
	const op = beat?.ops.find((entry) => entry.type === "shake");
	if (!op) {
		return null;
	}
	const fields = new Map((op.value ?? "").split("%%").flatMap((part) => (part.includes("=") ? [part.split("=", 2) as [string, string]] : [])));
	const duration = Number(fields.get("duration"));
	const range = Number(fields.get("range"));
	// A script that named neither still wants a jolt, so fall back to a short one rather than dropping the beat's effect.
	// Clamped here rather than where it is played, so the value on a Shake is the one that actually runs.
	return { duration: Number.isFinite(duration) && duration > 0 ? Math.min(duration, SHAKE_MAX_S) : 0.6, range: Number.isFinite(range) && range > 0 ? range : 6 };
}

/**
 * The reader's volume from the old single slider, which seeds both new volumes until the reader changes a setting.
 *
 * @returns The saved volume, 0 to 1, or undefined when none was saved or storage is unavailable.
 */
function readOldVolume(): number | undefined {
	try {
		// Read as a string first: `Number(null)` is 0, which would silently open a reader who never set it on mute.
		const raw = window.localStorage.getItem(VOLUME_KEY);
		const saved = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Whether the reader had silenced the story under the old shared key, which seeds the mute setting until the reader saves settings.
 *
 * @returns True when the old key says muted, and false when it does not or storage is unavailable.
 */
function readOldMuted(): boolean {
	try {
		return window.localStorage.getItem(MUTED_KEY) === "1";
	} catch {
		return false;
	}
}

/**
 * Read where the reader had got to in a scene.
 *
 * Entries written before the player understood branches are a bare number. They restore as a beat index with no choices, which
 * the timeline then clamps back to the scene's first unanswered choice.
 *
 * @param scene The script name.
 * @returns The saved place, or the start of the scene when there is nothing saved or storage is unavailable.
 */
function readProgress(scene: string): SceneProgress {
	try {
		const saved = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<string, number | SceneProgress>;
		const entry = saved[scene];
		if (typeof entry === "number") {
			return { beat: entry, choices: {} };
		}
		return { beat: entry?.beat ?? 0, choices: entry?.choices ?? {} };
	} catch {
		return { beat: 0, choices: {} };
	}
}

/**
 * Remember where the reader has got to in a scene, and which way they went at each choice.
 *
 * @param scene The script name.
 * @param progress The place to save.
 */
function writeProgress(scene: string, progress: SceneProgress) {
	try {
		const saved = JSON.parse(window.localStorage.getItem(PROGRESS_KEY) ?? "{}") as Record<string, SceneProgress>;
		saved[scene] = progress;
		window.localStorage.setItem(PROGRESS_KEY, JSON.stringify(saved));
	} catch {
		// A private window or blocked storage just means the place is not remembered, which is not worth failing the page over.
	}
}

/**
 * The story player: one scene, advanced a page at a time.
 *
 * Where a script branches, the reader picks which way to go and only the beats of that alternative are played.
 *
 * @returns The page.
 */
export default function Story() {
	const { chapter: chapterParam, scene: sceneParam } = useParams();
	const location = useLocation();
	// Picking a scene is a request to read it, so it opens at the start. A reload or a pasted link still resumes where the
	// reader left off, which is the case the saved place is actually for.
	const openAtStart = (location.state as { restart?: boolean } | null)?.restart === true;
	const chapterId = Number(chapterParam);
	const sceneName = sceneParam ?? "";

	const [scene, setScene] = useState<StoryScene | null>(null);
	const [chapter, setChapter] = useState<StoryChapter | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [beatIndex, setBeatIndex] = useState(0);
	const [pageIndex, setPageIndex] = useState(0);
	// The reader has read on past the last line, so the scene's end shows. It is a step of its own, so the last line is read before the end covers it.
	const [finished, setFinished] = useState(false);
	// The branch number taken at each of the scene's choices, keyed by that choice's index into the branch map.
	const [choices, setChoices] = useState<Record<number, string>>({});
	// The count is stored with the text it belongs to. Keeping them apart let a new page render with the previous page's count
	// for one frame, which read as the line rolling backwards before it typed out.
	const [typing, setTyping] = useState({ text: "", count: 0 });
	const [backlogOpen, setBacklogOpen] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	// Whether the phone reader's Settings sheet covers the story, which the reader reports.
	const [sheetOpen, setSheetOpen] = useState(false);
	// The old single volume and the old shared mute, read once, seed the settings for anything the reader has not saved yet.
	const [seed] = useState(() => {
		const volume = readOldVolume();
		return { ...(volume === undefined ? {} : { bgm: volume, sfx: volume }), muted: readOldMuted() };
	});
	const settings = useStorySettings(SETTINGS_KEY, seed);
	const { auto, muted, setAuto, setMuted } = settings;
	// Starts the music and effects, and holds the music the browser refused until the reader's next click in the player.
	const { blocked, play: playAudio, resume: resumeAudio, forget: forgetAudio } = useAudioGate();
	// The chapter list behind the scene menu, fetched the first time the menu is opened rather than on every scene.
	const [menuChapters, setMenuChapters] = useState<StoryChapterSummary[] | null>(null);
	// Which chapter is open in the scene menu, and the missions of every chapter opened so far.
	const [openChapter, setOpenChapter] = useState<number | null>(null);
	const [chapterMissions, setChapterMissions] = useState<Record<number, StoryMission[]>>({});
	const [hintOpen, setHintOpen] = useState(() => {
		try {
			return window.localStorage.getItem(HINT_KEY) !== "1";
		} catch {
			return true;
		}
	});
	// Held in a ref as well so the keyboard handler can advance without being rebuilt on every character typed.
	const advanceRef = useRef<() => void>(() => {});
	// The looping music. One element reused across cues, so changing track does not leave the old one playing.
	const musicRef = useRef<HTMLAudioElement | null>(null);
	// The desktop player, which the Backlog panel sits in and whose clicks it spends on closing.
	const playerRef = useRef<HTMLDivElement | null>(null);
	// How much black sits either side of the scene, and whether it is enough to hold the chrome.
	const frameRef = useRef<HTMLDivElement | null>(null);
	const sideMargin = useSideMargin(frameRef);
	const cinema = sideMargin >= CINEMA_MIN_MARGIN;
	// The navbar sits outside this element, so putting it fullscreen takes the browser's chrome and ours away together.
	const fullscreen = useFullscreen(frameRef);
	const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
	// Read here as well as in the styles, since where the fullscreen control belongs is a question of markup, not of appearance.
	const stacked = useMediaQuery(STACKED_QUERY);
	// A phone reads through archive-kit's shared reader, so every archive reads the same on one. Desktop keeps the layout below.
	const phone = useIsMobile();
	// A panel covers the story: the Backlog, the scenes menu, or Settings as the desktop card or the phone's sheet. Keys and AUTO wait behind it.
	const paused = backlogOpen || menuOpen || settingsOpen || sheetOpen;

	const branches = useMemo(() => (scene ? branchRegions(scene.beats) : null), [scene]);
	// Only the beats the reader's choices actually reach. It stops at the first choice still unanswered, since what follows depends on it.
	const timeline = useMemo(() => (scene && branches ? buildTimeline(scene.beats, branches, choices) : { beats: [], pending: null, pendingIndex: -1, starts: {} }), [scene, branches, choices]);
	const beats = timeline.beats;
	const beat = beats[beatIndex] ?? null;
	const page = beat?.pages[pageIndex] ?? null;
	const full = page ? pageText(page) : "";
	const typed = typing.text === full ? typing.count : 0;
	const done = typed >= full.length;
	const atLast = beatIndex >= beats.length - 1 && (beat === null || pageIndex >= beat.pages.length - 1);
	// The reader has read everything the timeline holds and a choice is waiting, so the menu takes the dialogue box's place.
	const choosing = timeline.pending !== null && atLast && done;
	// Narrowed here rather than tested again in the JSX, so the menu reads one condition instead of two.
	const pending = choosing ? timeline.pending : null;
	const atEnd = timeline.pending === null && beats.length > 0 && atLast;

	const stage = useMemo(() => stageAt(beats, beatIndex), [beats, beatIndex]);
	const shake = useMemo(() => shakeAt(beat), [beat]);
	// While a choice waits, the dialogue box keeps the line said before it rather than the choice's own, often empty, page.
	const said = useMemo(() => (pending ? lastSaid(beats, beatIndex, pageIndex) : null), [pending, beats, beatIndex, pageIndex]);
	const fade = fadeAt(beat);
	// Resolved once a beat. Each sprite costs several scans of the published-art list, and the page re-renders on every typed character.
	const cast = useMemo(
		() =>
			(beat?.sprites ?? []).flatMap((sprite, position) => {
				// A slot the script named without an expression is a voice off screen, and one with no published art is usually the same
				// thing: a label such as a description of a voice. Either way the stage shows nobody and the box still names the speaker.
				const stem = sprite.shown ? storySpriteStem(sprite.prefab) : null;
				if (stem === null) {
					return [];
				}
				return [
					{
						key: `${sprite.prefab}-${position}`,
						prefab: sprite.prefab,
						calling: sprite.tags.commsBox !== undefined,
						// The expression the script asked for, or the plain pose when the game ships no art for it.
						src: storySpriteUrl(stem, hasStorySprite(sprite.prefab, sprite.expression) ? sprite.expression : 0)
					}
				];
			}),
		[beat]
	);
	const mission = useMemo(() => chapter?.missions.find((entry) => entry.scripts.includes(sceneName)) ?? null, [chapter, sceneName]);
	// The mission names its own scene art. A beat's own `background` op is a scene-local index the game resolves in code the data does
	// not ship, so it cannot be mapped to a picture - it still drives the fallback wash, which at least changes when the scene does.
	// Reaching the last line is otherwise indistinguishable from the player having stuck, so the end says so, and offers the
	// next scene of the mission when there is one. It comes one step after the last line, as AK's does.
	const ended = finished && atEnd;
	const nextScene = useMemo(() => {
		const scripts = mission?.scripts ?? [];
		const at = scripts.indexOf(sceneName);
		return at === -1 ? null : (scripts[at + 1] ?? null);
	}, [mission, sceneName]);
	// Every page with text is a line, so each click moves the count on by one. Only the path being read counts, and a choice not yet answered
	// counts its longest answer, so the total can only drop once the reader picks. The end shows the total, as AK's does.
	const lineCount = useMemo(() => (scene && branches ? lineTotal(scene.beats, branches, choices) : 0), [scene, branches, choices]);
	const lineAt = useMemo(() => linesRead(beats, beatIndex, pageIndex), [beats, beatIndex, pageIndex]);
	// Floored at 1: a stage-only opening beat has no line yet, and still reads "Line 1", as the kit's corner expects.
	// A scene with no lines at all shows no count.
	const progress = useMemo(() => (lineCount > 0 ? { at: ended ? lineCount : Math.max(1, lineAt), total: lineCount } : null), [lineCount, ended, lineAt]);
	// A new object only when the cue changes, so the corner shows a title once per track rather than on every beat.
	const cornerTrack = useMemo(() => {
		const title = trackTitle(stage.bgm);
		return title === null ? null : { title };
	}, [stage.bgm]);
	const corner = useMemo<StoryCornerProps>(() => ({ progress, track: cornerTrack }), [progress, cornerTrack]);
	// The end card's title and way on. Next opens the mission's next scene at its start, as the scenes menu does.
	const ending = useMemo(
		() => ({
			title: mission ? `${sceneName} ${mission.title}` : sceneName,
			next: nextScene ? { label: "Next scene", to: `/story/${chapterId}/${encodeURIComponent(nextScene)}`, state: OPEN_AT_START } : undefined
		}),
		[mission, sceneName, nextScene, chapterId]
	);
	const artwork = useMemo(() => (scene ? sceneImages(scene.beats, mission?.background) : []), [scene, mission]);
	const scenery = useMemo(() => (mission?.background && hasStoryBackground(mission.background) ? storyBackgroundUrl(mission.background) : null), [mission]);
	// A beat asking for black or white overrides the scene's own picture, which is how the scripts cut between places.
	const backing = useMemo(() => {
		if (stage.background !== null && BACKGROUND_WASHES.has(stage.background.toLowerCase())) {
			return "#000000";
		}
		// The beat names its own background now, so the mission's is only the opening shot before any beat has changed it.
		const code = stage.background ?? mission?.background ?? null;
		if (code !== null && hasStoryBackground(code)) {
			return `url(${storyBackgroundUrl(code)}) center / cover no-repeat`;
		}
		return scenery ? `url(${scenery}) center / cover no-repeat` : backdrop(stage.background);
	}, [stage.background, scenery, mission]);
	// Each beat's place in the script, mapped once per scene, so the Log can put a pick before the first beat played after its choice.
	const scriptOrder = useMemo(() => new Map((scene?.beats ?? []).map((entry, index): [StoryBeat, number] => [entry, index])), [scene]);
	// Every line read so far, the one on screen last, with picks and track starts between them. The phone's reader and the desktop Backlog both
	// read it. Bounded at the current page rather than the current beat, since a beat holds several pages and the later ones are not yet read.
	const readLines = useMemo(() => logLines(beats, beatIndex, pageIndex, scriptOrder, branches, choices), [beats, beatIndex, pageIndex, scriptOrder, branches, choices]);
	// The last few spoken lines before the one on screen, for the stacked layout to show above it. Picks and track starts stay in the Logs.
	const transcript = useMemo(() => {
		const spoken = readLines.filter((line) => line.kind === undefined);
		// The line in the box is left out: the page on screen, or at a choice the line kept from before it. A page with no text shows none.
		const boxed = !ended && (said !== null || (page !== null && pageText(page).trim() !== ""));
		return (boxed ? spoken.slice(0, -1) : spoken).slice(-TRANSCRIPT_LINES);
	}, [readLines, page, ended, said]);

	useEffect(() => {
		document.title = mission ? `${mission.title} - Story` : "Story";
	}, [mission]);

	useEffect(() => {
		if (openChapter === null || chapterMissions[openChapter] !== undefined) {
			return;
		}
		let active = true;
		const id = openChapter;
		loadStoryChapter(id).then(
			(loaded) => active && setChapterMissions((current) => ({ ...current, [id]: loaded.missions })),
			() => active && setChapterMissions((current) => ({ ...current, [id]: [] }))
		);
		return () => {
			active = false;
		};
	}, [openChapter, chapterMissions]);

	useEffect(() => {
		if (!menuOpen || menuChapters !== null) {
			return;
		}
		let active = true;
		loadStoryIndex().then(
			(index) => active && setMenuChapters(index.chapters),
			() => active && setMenuChapters([])
		);
		return () => {
			active = false;
		};
	}, [menuOpen, menuChapters]);

	useEffect(() => {
		let active = true;
		setFailed(false);
		setScene(null);
		Promise.all([loadStoryScene(sceneName), loadStoryChapter(chapterId)]).then(
			([loadedScene, loadedChapter]) => {
				if (!active) {
					return;
				}
				setScene(loadedScene);
				setChapter(loadedChapter);
				const saved = openAtStart ? { beat: 0, choices: {} } : readProgress(sceneName);
				const at = Math.max(0, saved.beat);
				// A place saved before a choice it holds a pick for, which Back used to leave, would replay that pick rather than offer the choice.
				setChoices(reachedChoices(saved.choices, buildTimeline(loadedScene.beats, branchRegions(loadedScene.beats), saved.choices).starts, at));
				setBeatIndex(at);
				setPageIndex(0);
				setTyping({ text: "", count: 0 });
				setFinished(false);
			},
			() => active && setFailed(true)
		);
		return () => {
			active = false;
		};
	}, [sceneName, chapterId, attempt, openAtStart]);

	// Type the current page out one character at a time. Restarts whenever the page changes.
	useEffect(() => {
		// A new speed carries on from where the line had got to. Only a new page starts again from nothing.
		setTyping((current) => (current.text === full ? current : { text: full, count: 0 }));
		if (full === "") {
			return;
		}
		const interval = window.setInterval(
			() => {
				setTyping((current) => {
					if (current.count >= full.length) {
						window.clearInterval(interval);
						return current;
					}
					return { text: full, count: current.count + 1 };
				});
			},
			TYPE_MS / (SPEED_BASE * settings.speed)
		);
		return () => window.clearInterval(interval);
	}, [full, settings.speed]);

	// Fetched ahead of the reader, a few at a time, so a character or a change of place is already in the cache when its beat
	// arrives. Nothing here blocks the scene: the pictures are only being warmed, and the stage draws whatever has landed.
	useEffect(() => {
		if (artwork.length === 0) {
			return;
		}
		let stopped = false;
		let next = 0;
		const warmOne = () => {
			if (stopped || next >= artwork.length) {
				return;
			}
			const image = new Image();
			image.onload = warmOne;
			image.onerror = warmOne;
			image.src = artwork[next] ?? "";
			next += 1;
		};
		for (let lane = 0; lane < PRELOAD_LANES; lane++) {
			warmOne();
		}
		return () => {
			// Anything already in flight finishes into the cache; this only stops new ones starting for a scene being left.
			stopped = true;
		};
	}, [artwork]);

	useEffect(() => {
		if (beats.length > 0 && beatIndex > beats.length - 1) {
			setBeatIndex(beats.length - 1);
			setPageIndex(0);
		}
	}, [beats, beatIndex]);

	useEffect(() => {
		// Guarded on the loaded scene: while a new one is being fetched the name has already changed but the beat has not, and
		// writing then would drop the old scene's position onto the new one, opening it part-read.
		if (scene && scene.name === sceneName && beatIndex > 0) {
			writeProgress(sceneName, { beat: beatIndex, choices });
		}
	}, [scene, sceneName, beatIndex, choices]);

	// The music follows the scene's current cue. A cue the game no longer ships simply leaves the stage quiet.
	useEffect(() => {
		const element = musicRef.current;
		if (!element) {
			return;
		}
		const cue = stage.bgm;
		const wanted = cue && hasStoryAudio(cue) ? storyAudioUrl(cue) : null;
		if (wanted === null) {
			forgetAudio(element);
			element.pause();
			element.removeAttribute("src");
			return;
		}
		if (!element.src.endsWith(wanted.slice(wanted.lastIndexOf("/") + 1))) {
			element.src = wanted;
		}
		if (muted) {
			// Muted, the music waits paused, and a click in the player must not start it.
			forgetAudio(element);
			element.pause();
		} else {
			// A browser may refuse to start audio before the reader has clicked. The gate then holds the track for the next click in the player.
			void playAudio(element, { keep: true });
		}
		// Without this the phone's notification shade falls back to the page's favicon and its URL, which says nothing useful.
		if ("mediaSession" in navigator) {
			const art = stage.background ?? mission?.background ?? null;
			navigator.mediaSession.metadata = new MediaMetadata({
				title: mission?.title ?? sceneName,
				artist: cue ?? undefined,
				album: "Griffin Archive",
				artwork: art !== null && hasStoryBackground(art) ? [{ src: storyBackgroundUrl(art), type: "image/webp" }] : []
			});
		}
	}, [stage.bgm, stage.background, muted, mission, sceneName, playAudio, forgetAudio]);

	// The music's volume follows the BGM setting live, apart from the effect above, so moving the slider leaves playback alone.
	useEffect(() => {
		if (musicRef.current) {
			musicRef.current.volume = MUSIC_VOLUME * settings.bgm;
		}
	}, [settings.bgm]);

	// Read through a ref, so moving the SFX slider does not fire the beat's sounds again.
	const sfxRef = useRef(settings.sfx);
	useEffect(() => {
		sfxRef.current = settings.sfx;
	}, [settings.sfx]);

	// Sound effects fire once as their beat is reached, over whatever music is playing. They are one-shots, so a new SFX level applies from the
	// next sound.
	useEffect(() => {
		if (muted || !beat) {
			return;
		}
		for (const op of beat.ops) {
			if (op.type !== "sfx" || !op.value || !hasStoryAudio(op.value)) {
				continue;
			}
			const effect = new Audio(storyAudioUrl(op.value));
			effect.volume = EFFECT_VOLUME * sfxRef.current;
			void playAudio(effect);
		}
	}, [beat, muted, playAudio]);

	const advance = useCallback(() => {
		if (!beat) {
			return;
		}
		// A part-typed page finishes first, so a click never skips text the reader has not seen.
		if (!done && full !== "") {
			setTyping({ text: full, count: full.length });
			return;
		}
		if (pageIndex + 1 < beat.pages.length) {
			setPageIndex((current) => current + 1);
			return;
		}
		if (beatIndex + 1 < beats.length) {
			setBeatIndex((current) => current + 1);
			setPageIndex(0);
			return;
		}
		// Reading on from the last line ends the scene. A choice still waiting never gets here, since its menu is showing.
		if (atEnd) {
			setFinished(true);
		}
	}, [beats, beat, done, full, pageIndex, beatIndex, atEnd]);
	advanceRef.current = advance;

	const back = useCallback(() => {
		// From the end, Back returns to the last line.
		if (ended) {
			setFinished(false);
			return;
		}
		if (pageIndex > 0) {
			setPageIndex((current) => current - 1);
			return;
		}
		const next = Math.max(0, beatIndex - 1);
		setBeatIndex(next);
		setPageIndex(Math.max(0, (beats[next]?.pages.length ?? 1) - 1));
		// Stepping back onto a choice forgets its pick, so reading on offers the choice again.
		setChoices((current) => reachedChoices(current, timeline.starts, next));
	}, [ended, pageIndex, beatIndex, beats, timeline.starts]);

	const restart = useCallback(() => {
		setBeatIndex(0);
		setPageIndex(0);
		setTyping({ text: "", count: 0 });
		setChoices({});
		setFinished(false);
	}, []);
	const toEnd = useCallback(() => {
		if (beats.length > 0) {
			setBeatIndex(beats.length - 1);
			setPageIndex(Math.max(0, (beats[beats.length - 1]?.pages.length ?? 1) - 1));
			// With no choice in the way, Skip lands on the end itself rather than the last line.
			setFinished(timeline.pending === null);
		}
	}, [beats, timeline.pending]);
	const choose = useCallback(
		(region: number, label: string) => {
			setChoices((current) => ({ ...current, [region]: label }));
			// The chosen alternative is appended to the timeline, so the next beat is the one that was just unlocked.
			setBeatIndex(beats.length);
			setPageIndex(0);
			setTyping({ text: "", count: 0 });
		},
		[beats]
	);
	const retry = useCallback(() => setAttempt((count) => count + 1), []);
	const toggleAuto = useCallback(() => setAuto(!auto), [auto, setAuto]);
	const toggleMuted = useCallback(() => setMuted(!muted), [muted, setMuted]);
	// Every click in the player lets blocked sound start. It notes first whether the sound was blocked, since the resume clears `blocked` before
	// the Sound plate's own handler runs.
	const blockedAtClick = useRef(false);
	const interact = useCallback(() => {
		blockedAtClick.current = blocked;
		resumeAudio();
	}, [blocked, resumeAudio]);
	// While the browser holds the sound back, the Sound plate shows it off and a press only lets the sound start. The `m` key does the same.
	const pressSound = useCallback(() => {
		if (blockedAtClick.current && !muted) {
			return;
		}
		toggleMuted();
	}, [muted, toggleMuted]);
	// Off while muted, and while the browser holds the sound back.
	const soundOff = muted || blocked;
	// The stage advances on a click, so a click landing on a choice button must not also count as advancing the scene.
	const stopBubbling = useCallback((event: MouseEvent) => event.stopPropagation(), []);
	const toggleFullscreen = useCallback(() => {
		if (document.fullscreenElement !== null) {
			void document.exitFullscreen().catch(() => {});
			return;
		}
		// Refused when the browser does not count this as a user gesture, which is nothing to report: the plate simply does nothing.
		void frameRef.current?.requestFullscreen().catch(() => {});
	}, []);
	const openMenu = useCallback(() => setMenuOpen(true), []);
	const closeMenu = useCallback(() => setMenuOpen(false), []);
	const showHint = useCallback(() => setHintOpen(true), []);
	const dismissHint = useCallback(() => {
		setHintOpen(false);
		try {
			window.localStorage.setItem(HINT_KEY, "1");
		} catch {
			// Not remembering it only means the reader is reminded again, which is the safer way to fail.
		}
	}, []);
	// Settings closes first, so the Backlog never opens under a card that would take its first click and Escape.
	const openBacklog = useCallback(() => {
		setSettingsOpen(false);
		setBacklogOpen(true);
	}, []);
	const closeBacklog = useCallback(() => setBacklogOpen(false), []);
	const openSettings = useCallback(() => setSettingsOpen(true), []);
	const closeSettings = useCallback(() => setSettingsOpen(false), []);
	const toggleChapter = useCallback((id: number) => setOpenChapter((current) => (current === id ? null : id)), []);

	// The desktop Settings card goes with the desktop layout. Left open when the phone's takes over, it would pause the story with nothing on screen.
	useEffect(() => {
		if (phone) {
			setSettingsOpen(false);
		}
	}, [phone]);

	// Autoplay waits for the page to finish typing, then holds before moving on. It waits behind any panel covering the story.
	useEffect(() => {
		if (!auto || paused || !done || choosing || ended) {
			return;
		}
		const timer = window.setTimeout(() => advanceRef.current(), AUTO_HOLD_MS / (SPEED_BASE * settings.speed));
		return () => window.clearTimeout(timer);
	}, [auto, paused, done, choosing, ended, settings.speed, beatIndex, pageIndex]);

	// Space, Enter and the right arrow read on and the left arrow steps back, each letting blocked sound start as a click does. The letters and
	// Escape are this archive's own. A focused plate keeps Space and Enter, a field keeps every key, and nothing acts while a panel covers the
	// story. The kit reads these through a ref, so the typewriter's ticks leave its listener alone.
	useStoryKeys({
		next: () => {
			resumeAudio();
			advanceRef.current();
		},
		back: () => {
			resumeAudio();
			back();
		},
		paused,
		extra: {
			Escape: () => {
				if (document.fullscreenElement === null) {
					setMenuOpen((open) => !open);
				}
			},
			a: toggleAuto,
			l: openBacklog,
			// The same as a press on the Sound plate: a click in the player first, then the plate's own handler.
			m: () => {
				interact();
				pressSound();
			},
			"?": () => setHintOpen((open) => !open)
		}
	});

	// The plate row, described once and drawn from the description.
	const plates = [
		{ key: "menu", label: "Menu", aria: "Scenes menu", icon: <MenuIcon fontSize="small" />, onClick: openMenu, disabled: false, gap: false },
		{ key: "settings", label: "Settings", aria: "Settings", icon: <SettingsIcon fontSize="small" />, onClick: openSettings, disabled: false, gap: false },
		{ key: "back", label: "Back", aria: "Back a line", icon: <ChevronLeftIcon fontSize="small" />, onClick: back, disabled: beatIndex === 0 && pageIndex === 0, gap: true },
		{ key: "next", label: "Next", aria: "Next line", icon: <ChevronRightIcon fontSize="small" />, onClick: advance, disabled: false, gap: false },
		{ key: "reset", label: "Reset", aria: "Restart the scene", icon: <ReplayIcon fontSize="small" />, onClick: restart, disabled: false, gap: false },
		{ key: "log", label: "Log", aria: "Backlog", icon: <HistoryIcon fontSize="small" />, onClick: openBacklog, disabled: false, gap: true },
		{
			key: "auto",
			label: "Auto",
			aria: auto ? "Stop autoplay" : "Autoplay",
			icon: auto ? <AutorenewIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />,
			onClick: toggleAuto,
			disabled: false,
			gap: false,
			running: auto
		},
		{
			key: "sound",
			label: "Sound",
			aria: soundOff ? "Turn sound on" : "Turn sound off",
			icon: soundOff ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />,
			onClick: pressSound,
			disabled: false,
			gap: false
		},
		{ key: "skip", label: "Skip", aria: "Skip to the end", icon: <StorySkipIcon fontSize="small" />, onClick: toEnd, disabled: ended || choosing, gap: false },
		// Stacked, it is inlaid in the scene's own corner instead: a ninth plate wrapped onto a row of its own down there.
		...(canFullscreen && !stacked
			? [
					{
						key: "full",
						label: fullscreen ? "Exit" : "Full",
						aria: fullscreen ? "Leave fullscreen" : "Fill the screen",
						icon: fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />,
						onClick: toggleFullscreen,
						disabled: false,
						gap: true
					}
				]
			: [])
	];

	// The scene's layers, drawn by both layouts: the picture, the cast, and the washes and fade over them.
	const stageLayers = (
		<>
			<Box sx={[styles.scene, { background: backing, opacity: stage.blankedTo === null ? 1 : 0 }]} />

			<Box sx={styles.sprites}>
				{cast.map((member, position) => {
					const left = `${(100 * (position + 1)) / (cast.length + 1)}%`;
					return member.calling ? (
						<Box key={member.key} sx={[styles.comms, { left }]}>
							<Box sx={styles.commsCrop}>
								<Box component="img" src={member.src} alt={member.prefab} sx={styles.commsArt} />
								<Box sx={styles.commsScreen} />
							</Box>
							<Box sx={styles.commsFrame} />
						</Box>
					) : (
						<Box key={member.key} sx={[styles.spriteSlot, { left }]}>
							<Box component="img" src={member.src} alt={member.prefab} sx={styles.spriteArt} />
						</Box>
					);
				})}
			</Box>

			<Box sx={[styles.wash, { bgcolor: "#0a1020", opacity: stage.night ? 0.42 : 0 }]} />
			<Box sx={[styles.wash, { bgcolor: "#000", opacity: stage.darkened ? 0.55 : 0 }]} />
			{fade && <Box key={`fade-${beatIndex}`} sx={[styles.fade, { bgcolor: "#ffffff" }]} />}
		</>
	);

	// The plates in the reader's own form. A tap on the scene or the box reads on, so there is no Next, and fullscreen comes from the reader.
	const phoneControls = useMemo<StoryControl[]>(
		() => [
			{ key: "menu", label: "Menu", ariaLabel: "Scenes menu", icon: <MenuIcon />, onClick: openMenu },
			{ key: "back", label: "Back", ariaLabel: "Back a line", icon: <ChevronLeftIcon />, onClick: back, disabled: beatIndex === 0 && pageIndex === 0, group: true },
			{ key: "reset", label: "Reset", ariaLabel: "Restart the scene", icon: <ReplayIcon />, onClick: restart },
			{ key: "log", label: "Log", ariaLabel: "Backlog", icon: <HistoryIcon />, onClick: openBacklog, group: true },
			{ key: "auto", label: "Auto", ariaLabel: auto ? "Stop autoplay" : "Autoplay", icon: auto ? <AutorenewIcon /> : <PlayArrowIcon />, onClick: toggleAuto, active: auto, spin: true },
			{ key: "sound", label: "Sound", ariaLabel: soundOff ? "Turn sound on" : "Turn sound off", icon: soundOff ? <VolumeOffIcon /> : <VolumeUpIcon />, onClick: pressSound },
			{ key: "skip", label: "Skip", ariaLabel: "Skip to the end", icon: <StorySkipIcon />, onClick: toEnd, disabled: ended || choosing }
		],
		[openMenu, back, beatIndex, pageIndex, restart, openBacklog, auto, toggleAuto, soundOff, pressSound, toEnd, ended, choosing]
	);
	const phoneChoices = useMemo<StoryChoice[] | null>(
		() => (pending ? pending.options.map((option) => ({ key: option.label, label: option.text, onPick: () => choose(timeline.pendingIndex, option.label) })) : null),
		[pending, choose, timeline.pendingIndex]
	);
	// Only the phone shows it, so the desktop does not type each line twice.
	const phoneCurrent: StoryCurrentLine | null = phone && !pending && !ended && page && full.trim() !== "" ? { speaker: beat?.speaker ?? null, text: renderTyped(page, typed), typing: !done } : null;

	return (
		<Box component="main" ref={frameRef} sx={phone && scene ? [styles.main, PHONE_MAIN_SX] : styles.main}>
			<ScrollToTop />
			{failed ? (
				<LoadError what="this scene" onRetry={retry} titleComponent="h2" />
			) : !scene ? (
				<Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
					<CircularProgress aria-label="Loading the scene" />
				</Box>
			) : phone ? (
				<MobileStoryReader
					scene={
						<Box key={shake ? `shake-${beatIndex}` : "stage"} sx={[styles.stage, { bgcolor: stage.blankedTo === "white" ? "#ffffff" : "#000000" }, shake ? shakeSx(shake) : {}]}>
							{stageLayers}
						</Box>
					}
					corner={corner}
					controls={phoneControls}
					lines={readLines}
					current={phoneCurrent}
					choices={phoneChoices}
					end={ended ? <StoryEndCard variant="inline" title={ending.title} next={ending.next} back={BACK_TO_CHAPTERS} onRestart={restart} color="secondary" /> : null}
					onAdvance={advance}
					onInteract={interact}
					logOpen={backlogOpen}
					onCloseLog={closeBacklog}
					logTitle="Backlog"
					settings={<StorySettingsPanel value={settings} sceneSize />}
					onPanelChange={setSheetOpen}
					sceneSize={settings.sceneSize}
					sx={READER_SX}
				/>
			) : (
				<Box ref={playerRef} sx={[styles.player, cinema ? styles.playerCinema : {}]} onClick={advance} onClickCapture={interact} role="button" tabIndex={-1} aria-label="Advance the scene">
					<Box
						// Keyed on the beat so a shake restarts when the reader reaches another one, rather than only on the first.
						key={shake ? `shake-${beatIndex}` : "stage"}
						sx={[styles.stage, cinema ? styles.stageCinema : {}, { bgcolor: stage.blankedTo === "white" ? "#ffffff" : "#000000" }, shake ? shakeSx(shake) : {}]}
					>
						{stageLayers}

						{canFullscreen && stacked && (
							<IconButton
								sx={styles.sceneFullscreen}
								aria-label={fullscreen ? "Leave fullscreen" : "Fill the screen"}
								onClick={(event) => {
									event.stopPropagation();
									toggleFullscreen();
								}}
							>
								{fullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
							</IconButton>
						)}

						<StoryCorner progress={corner.progress} track={corner.track} />
						{pending && (
							<Box sx={styles.choices} onClick={stopBubbling}>
								{pending.options.map((option) => (
									<Button key={option.label} sx={styles.choiceButton} onClick={() => choose(timeline.pendingIndex, option.label)}>
										{option.text}
									</Button>
								))}
							</Box>
						)}
						{ended && <StoryEndCard variant="stage" title={ending.title} next={ending.next} back={BACK_TO_CHAPTERS} onRestart={restart} color="secondary" />}
					</Box>

					<Box sx={[styles.stageControls, cinema ? styles.controlsCinema : {}, cinema ? { width: sideMargin } : {}]} onClick={stopBubbling}>
						{plates.map((plate) => (
							<Button
								key={plate.key}
								variant="outlined"
								sx={[styles.stageButton, plate.gap && !cinema ? styles.plateGap : {}, plate.running ? styles.stageButtonRunning : {}]}
								onClick={plate.onClick}
								disabled={plate.disabled}
								aria-label={plate.aria}
							>
								{plate.icon}
								<Box component="span" sx={styles.stageButtonLabel}>
									{plate.label}
								</Box>
							</Button>
						))}
						<StorySettingsCard open={settingsOpen} onClose={closeSettings} sx={cinema ? styles.settingsCardCinema : styles.settingsCard}>
							<StorySettingsPanel value={settings} />
						</StorySettingsCard>
					</Box>

					<Box sx={[styles.bottomStack, cinema ? styles.stackCinema : {}, cinema ? { width: sideMargin } : {}]}>
						{hintOpen && (
							<Box sx={styles.hint} onClick={stopBubbling}>
								<span>
									<Box component="kbd" sx={styles.key}>
										Space
									</Box>
									or
									<Box component="kbd" sx={styles.key}>
										&rarr;
									</Box>
									next line
								</span>
								<span>
									<Box component="kbd" sx={styles.key}>
										&larr;
									</Box>
									back
								</span>
								<span>
									<Box component="kbd" sx={styles.key}>
										Esc
									</Box>
									menu
								</span>
								<Button size="small" color="inherit" onClick={dismissHint}>
									Got it
								</Button>
							</Box>
						)}

						{/* Only drawn where the chrome is stacked, since the overlay layout has no room for it and the Log covers it there. */}
						<Box sx={[styles.transcript, cinema ? styles.transcriptCinema : {}]} aria-hidden>
							{transcript.map((entry, index) => (
								<Typography key={`${entry.speaker ?? ""}-${index}`} sx={styles.transcriptLine}>
									{entry.speaker && <Box component="span" sx={styles.transcriptSpeaker}>{`${entry.speaker}: `}</Box>}
									{entry.text}
								</Typography>
							))}
						</Box>

						{!ended && (
							<Box sx={cinema ? styles.slab : [styles.panel, styles.box]}>
								{!cinema && <StoryPanelFrame />}
								<Box sx={styles.panelBody}>
									{/* Always drawn, so narration starts on the same line a spoken beat does rather than riding up into the frame. */}
									<Typography variant="subtitle2" sx={styles.speaker} aria-hidden={!(said?.beat ?? beat)?.speaker}>
										{(said?.beat ?? beat)?.speaker ?? ""}
									</Typography>
									<Typography variant="body1" sx={cinema ? styles.slabText : styles.text}>
										{said ? renderTyped(said.page, pageText(said.page).length) : renderTyped(page, typed)}
										{!done && !said && (
											<Box component="span" sx={styles.caret}>
												|
											</Box>
										)}
									</Typography>
								</Box>
							</Box>
						)}
					</Box>

					{backlogOpen && <StoryLogPanel title="Backlog" lines={readLines} onClose={closeBacklog} container={playerRef} sx={READER_SX} />}
				</Box>
			)}

			{/* One long-lived element for the music. It sits outside the stage so redrawing a beat never restarts the track. */}
			<Box component="audio" ref={musicRef} loop preload="none" aria-hidden sx={{ display: "none" }} />

			{/* Inside whatever is fullscreen, since the browser draws nothing outside it: `main` on desktop, the reader on a phone. */}
			<Drawer anchor="left" open={menuOpen} onClose={closeMenu} container={() => (document.fullscreenElement as HTMLElement | null) ?? document.body}>
				<Box sx={{ width: { xs: 300, sm: 380 }, display: "flex", flexDirection: "column", height: "100%" }} role="presentation">
					<Stack direction="row" spacing={1} sx={{ px: 2, py: 1.5, alignItems: "baseline", borderBottom: "1px solid", borderColor: "divider" }}>
						<Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
							Scenes
						</Typography>
						<Button size="small" component={RouterLink} to="/story" onClick={closeMenu}>
							All chapters
						</Button>
					</Stack>

					<Box sx={{ flex: 1, overflowY: "auto", py: 0.5 }}>
						{/* The scenes of the mission being read sit at the top, since moving within a mission is the commonest jump. */}
						{mission && mission.scripts.length > 1 && (
							<>
								<Typography sx={styles.menuHead}>This mission</Typography>
								{mission.scripts.map((script) => (
									<Box
										key={script}
										component={RouterLink}
										to={`/story/${chapterId}/${encodeURIComponent(script)}`}
										state={OPEN_AT_START}
										onClick={closeMenu}
										sx={[styles.menuRow, styles.link, script === sceneName ? styles.menuRowOn : {}]}
									>
										<Box component="span" sx={styles.menuLabel}>
											{script}
										</Box>
									</Box>
								))}
							</>
						)}

						{menuChapters === null ? (
							<Box sx={{ display: "flex", justifyContent: "center", py: 3 }}>
								<CircularProgress size={24} aria-label="Loading the chapters" />
							</Box>
						) : (
							CHAPTER_GROUPS.map((group) => {
								const rows = menuChapters.filter((entry) => entry.type === group.type).sort((left, right) => left.order - right.order);
								if (rows.length === 0) {
									return null;
								}
								return (
									<Box key={group.type}>
										<Typography sx={styles.menuHead}>{group.label}</Typography>
										{rows.map((entry) => (
											<Box key={entry.id}>
												{/* A chapter holds many missions, so opening one lists them here rather than jumping to a page that does not exist. */}
												<Box
													component="button"
													type="button"
													onClick={() => toggleChapter(entry.id)}
													aria-expanded={openChapter === entry.id}
													sx={[styles.menuRow, styles.menuButton, entry.id === chapterId ? styles.menuRowOn : {}]}
												>
													<Box component="span" sx={styles.menuLabel}>
														{entry.label}
													</Box>
													<Box component="span">{entry.name}</Box>
													<Box component="span" sx={styles.menuCount}>
														{entry.missions}
													</Box>
												</Box>
												{openChapter === entry.id &&
													(chapterMissions[entry.id] === undefined ? (
														<Box sx={{ display: "flex", justifyContent: "center", py: 1 }}>
															<CircularProgress size={18} aria-label="Loading the missions" />
														</Box>
													) : (
														(chapterMissions[entry.id] ?? []).map((chapterMission) => (
															<Box
																key={chapterMission.id}
																component={RouterLink}
																to={`/story/${entry.id}/${encodeURIComponent(chapterMission.scripts[0] ?? "")}`}
																state={OPEN_AT_START}
																onClick={closeMenu}
																sx={[styles.menuRow, styles.link, styles.menuSub, chapterMission.scripts.includes(sceneName) ? styles.menuRowOn : {}]}
															>
																{chapterMission.title}
															</Box>
														))
													))}
											</Box>
										))}
									</Box>
								);
							})
						)}
					</Box>

					<Stack spacing={1} sx={{ px: 2, py: 1.5, borderTop: "1px solid", borderColor: "divider" }}>
						<Button size="small" startIcon={<KeyboardIcon fontSize="small" />} onClick={showHint} sx={styles.hintLink}>
							Keyboard shortcuts
						</Button>
					</Stack>
				</Box>
			</Drawer>
		</Box>
	);
}

/**
 * Render a page up to the number of characters typed so far, keeping each run's styling.
 *
 * @param page The page, or null when the beat has no text.
 * @param typed How many characters to show.
 * @returns The styled runs, truncated.
 */
function renderTyped(page: StoryPage | null, typed: number) {
	if (!page) {
		return null;
	}
	let remaining = typed;
	return page.spans.map((span, position) => {
		if (remaining <= 0) {
			return null;
		}
		const shown = span.text.slice(0, remaining);
		remaining -= span.text.length;
		const style = span.style ?? {};
		return (
			<Box
				key={position}
				component="span"
				sx={{
					color: style.color ? style.color : undefined,
					fontSize: style.size ? `${Number(style.size) / 26}rem` : undefined,
					fontWeight: style.b !== undefined ? 700 : undefined,
					fontStyle: style.i !== undefined ? "italic" : undefined
				}}
			>
				{shown}
			</Box>
		);
	});
}
