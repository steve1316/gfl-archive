import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TouchEvent } from "react";

import { Box, ButtonBase, Skeleton, useMediaQuery } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";

import DollCard from "./DollCard";
import LoadError from "./LoadError";
import SkinBackdrop from "./SkinBackdrop";
import { skinKeyOf } from "../lib/assets";
import { loadDoll } from "../lib/data";
import type { TDoll } from "../types/tdoll";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Configuration

/** How long each set of dolls is shown before the carousel moves on, in ms. */
const ADVANCE_MS = 15000;

/** Horizontal travel, in pixels, that counts as a swipe rather than a tap. */
const SWIPE_THRESHOLD = 40;

/** Height of the card's name, badges and id under its 1:2 art, measured at 83px and rounded up. */
const CARD_TEXT_HEIGHT = 84;

const styles = {
	// Relative and clipped, so the skin backdrop fills the hero and its slow zoom never spills past it.
	root: {
		position: "relative",
		overflow: "hidden",
		display: "flex",
		alignItems: "stretch",
		width: "100%"
	},
	// The whole side of the hero is the button, not just an arrow beside the cards, so a reader can click
	// anywhere to its left or right. The chevron sits against the cards so the target still reads as a control.
	side: (theme: Theme) => ({
		flex: "1 1 0",
		minWidth: 48,
		display: "flex",
		alignItems: "center",
		color: theme.palette.text.secondary,
		transition: "background-color 200ms, color 200ms",
		"&:hover": { color: theme.palette.text.primary },
		"&.Mui-disabled": { opacity: 0.3 },
		"& svg": { fontSize: 36 }
	}),
	sideLeft: (theme: Theme) => ({
		justifyContent: "flex-end",
		pr: { xs: 0.5, sm: 2 },
		"&:hover": { backgroundImage: `linear-gradient(to right, ${theme.palette.action.hover}, transparent)` }
	}),
	sideRight: (theme: Theme) => ({
		justifyContent: "flex-start",
		pl: { xs: 0.5, sm: 2 },
		"&:hover": { backgroundImage: `linear-gradient(to left, ${theme.palette.action.hover}, transparent)` }
	}),
	// Positioned, so it paints above the absolutely placed backdrop.
	centre: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		alignItems: "center",
		gap: 1.5,
		py: { xs: 4, sm: 6 },
		flexShrink: 0
	},
	cards: {
		display: "flex",
		gap: { xs: 1.5, md: 3 }
	},
	progressTrack: (theme: Theme) => ({
		width: "100%",
		height: 4,
		borderRadius: "999px",
		overflow: "hidden",
		backgroundColor: theme.palette.action.selected
	}),
	progressBar: (theme: Theme) => ({
		height: "100%",
		width: "100%",
		borderRadius: "999px",
		backgroundColor: theme.palette.primary.main,
		transformOrigin: "left center",
		"@keyframes dollCarouselProgress": {
			from: { transform: "scaleX(0)" },
			to: { transform: "scaleX(1)" }
		}
	})
} satisfies Record<string, SxProps<Theme>>;

/** The combined side styles, built once rather than as a fresh array on every render. */
const SIDE_LEFT_SX = [styles.side, styles.sideLeft];
const SIDE_RIGHT_SX = [styles.side, styles.sideRight];

/** Props for DollCarousel. */
interface DollCarouselProps {
	/** The pool of doll ids to draw from, already in random order. */
	ids: number[];
	/** Asks for a fresh pool. Called when stepping forward past the last set in the current one. */
	onShuffle?: () => void;
}

/**
 * Map a doll onto the card's props.
 *
 * @param doll The doll to show.
 * @returns Props for `DollCard`.
 */
function cardProps(doll: TDoll) {
	const form = doll.normal;
	return {
		id: form.id,
		name: form.name,
		type: form.type,
		rarity: form.rarity,
		isMod: false,
		image: form.assets.images.card ?? "",
		to: `/tdoll/${form.id}`
	};
}

/**
 * URL of a random full art for a doll, for the backdrop. A skin wins over the Mod, and the Mod shares the pool with the base art, so a doll
 * only shows its own art when it has no skins.
 *
 * @param doll The doll.
 * @returns The absolute URL, or null when the doll has no full art at all.
 */
function randomSkinUrl(doll: TDoll): string | null {
	const forms = Object.entries(doll.forms);
	const skinForms = forms.filter(([key]) => skinKeyOf(key) !== null);
	const pool = (skinForms.length > 0 ? skinForms : forms).flatMap(([, assets]) => assets.images.full ?? []);
	return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/**
 * Whether a keyboard event's target is a place the user types, so global shortcuts should back off.
 *
 * @param target The event target to check.
 * @returns True when the target is a text input, textarea, select, or any contenteditable element.
 */
function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) {
		return false;
	}
	if (target.isContentEditable) {
		return true;
	}
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * A set of dolls at a time, replaced on a timer, with the whole of each side of the hero as a button.
 *
 * The countdown bar and the swap are one CSS animation. The bar used to be a progress value fed by an interval,
 * and MUI eases every value change, so each reset to 0 slid back down from full and every new set appeared to
 * start already filled. Advancing on `animationend` also means pausing the bar pauses the timer, with nothing
 * to keep in sync. Only a finger held on the carousel pauses it, since hovering or focusing it should not stop the
 * cycle. The pool arrives shuffled, so a set is simply the next slice of it. Behind the cards, `SkinBackdrop` shows one random skin per
 * doll on screen, re-rolled every time a set is shown.
 *
 * @param props Component props.
 * @returns The carousel.
 */
export default memo(function DollCarousel({ ids, onShuffle }: DollCarouselProps) {
	const isNarrow = useMediaQuery("(max-width:599.95px)");
	const isMedium = useMediaQuery("(max-width:899.95px)");
	const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");

	const [dolls, setDolls] = useState<(TDoll | undefined)[]>([]);
	// True when a doll shard failed to load, which swaps the cards for a retry notice.
	const [loadFailed, setLoadFailed] = useState(false);
	// Bumped by the retry button to load the dolls again.
	const [loadAttempt, setLoadAttempt] = useState(0);
	// Index of the first doll on screen, rather than a page number, so a breakpoint change that alters how many
	// cards fit keeps the same doll at the front instead of jumping.
	const [start, setStart] = useState(0);
	const [paused, setPaused] = useState(false);
	const touchStart = useRef<{ x: number; y: number } | null>(null);

	useEffect(() => {
		let active = true;
		setStart(0);
		setDolls([]);
		setLoadFailed(false);
		Promise.all(ids.map((id) => loadDoll(id))).then(
			(loaded) => active && setDolls(loaded),
			() => active && setLoadFailed(true)
		);
		return () => {
			active = false;
		};
	}, [ids, loadAttempt]);

	// Only dolls that actually exist. MICA Team skips ids, so a random pick can land on a gap.
	const entries = useMemo(() => dolls.filter((doll): doll is TDoll => doll !== undefined), [dolls]);

	const perSet = isNarrow ? 1 : 3;
	const width = isNarrow ? 200 : isMedium ? 150 : 200;
	const shown = useMemo(() => entries.slice(start, start + perSet), [entries, start, perSet]);
	const skins = useMemo(() => shown.map(randomSkinUrl), [shown]);

	/** Show the next set, or ask for a fresh pool once this one has run out. */
	const advance = useCallback(() => {
		const next = start + perSet;
		if (next >= entries.length) {
			if (onShuffle) {
				onShuffle();
			} else {
				setStart(0);
			}
			return;
		}
		setStart(next);
	}, [start, perSet, entries.length, onShuffle]);

	/** Load the dolls again after a failed load. */
	const retryLoad = useCallback(() => setLoadAttempt((current) => current + 1), []);

	/** Show the previous set. Does nothing on the first. */
	const back = useCallback(() => setStart((current) => Math.max(0, current - perSet)), [perSet]);

	const handleTouchStart = useCallback((event: TouchEvent<HTMLDivElement>) => {
		setPaused(true);
		const touch = event.touches[0];
		touchStart.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
	}, []);

	const handleTouchEnd = useCallback(
		(event: TouchEvent<HTMLDivElement>) => {
			const origin = touchStart.current;
			const end = event.changedTouches[0] ?? null;
			if (origin !== null && end !== null) {
				const dx = end.clientX - origin.x;
				const dy = end.clientY - origin.y;
				// Without the vertical check a page scroll that drifts sideways also turns the carousel.
				if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
					if (dx < 0) {
						advance();
					} else {
						back();
					}
				}
			}
			touchStart.current = null;
			setPaused(false);
		},
		[advance, back]
	);

	const handleTouchCancel = useCallback(() => {
		touchStart.current = null;
		setPaused(false);
	}, []);

	// Held in a ref so the one window listener always calls the current handlers.
	const handlers = useRef({ advance, back });
	handlers.current = { advance, back };

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (isTypingTarget(event.target)) {
				return;
			}
			if (event.key === "ArrowLeft") {
				handlers.current.back();
			}
			if (event.key === "ArrowRight") {
				handlers.current.advance();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const cardHeight = width * 2 + CARD_TEXT_HEIGHT;
	const loading = entries.length === 0;
	const cycling = !reduceMotion && entries.length > perSet;

	return (
		<Box sx={styles.root} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchCancel}>
			{/* The phone layout softens the art, since its one card covers most of the only slice. */}
			<SkinBackdrop urls={skins} dwellMs={ADVANCE_MS} blur={isNarrow} paused={paused} reduceMotion={reduceMotion} />

			<ButtonBase onClick={back} disabled={loading || start === 0} aria-label="previous" sx={SIDE_LEFT_SX}>
				<ChevronLeftIcon />
			</ButtonBase>

			<Box sx={styles.centre}>
				{/* Keyed by the first doll so a new set remounts, which replays the entry animation. */}
				{loadFailed ? (
					<LoadError what="these T-Dolls" onRetry={retryLoad} />
				) : (
					<Box
						key={loading ? "loading" : shown[0]?.normal.id}
						sx={[
							styles.cards,
							{
								animation: reduceMotion ? "none" : "dollCarouselIn 360ms cubic-bezier(0.22, 0.61, 0.36, 1)",
								"@keyframes dollCarouselIn": {
									from: { opacity: 0, transform: "translateX(24px)" },
									to: { opacity: 1, transform: "none" }
								}
							}
						]}
					>
						{loading
							? Array.from({ length: perSet }, (_value, position) => <Skeleton key={position} variant="rounded" width={width} height={cardHeight} />)
							: shown.map((doll) => (
									<Box key={doll.normal.id} sx={{ width, flexShrink: 0 }}>
										<DollCard {...cardProps(doll)} />
									</Box>
								))}
					</Box>
				)}

				{/* The countdown to the next set. Keyed by the set so it restarts from empty, and the carousel moves
				    on when it finishes filling. Hidden when nothing counts down, rather than sitting at zero. */}
				<Box sx={[styles.progressTrack, { visibility: cycling ? "visible" : "hidden" }]} aria-hidden>
					{cycling && (
						<Box
							key={shown[0]?.normal.id}
							onAnimationEnd={advance}
							sx={[
								styles.progressBar,
								{
									animation: `dollCarouselProgress ${ADVANCE_MS}ms linear forwards`,
									animationPlayState: paused ? "paused" : "running"
								}
							]}
						/>
					)}
				</Box>
			</Box>

			<ButtonBase onClick={advance} disabled={loading || entries.length <= perSet} aria-label="next" sx={SIDE_RIGHT_SX}>
				<ChevronRightIcon />
			</ButtonBase>
		</Box>
	);
});
