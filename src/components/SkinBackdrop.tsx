import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { AnimationEvent } from "react";

import { alpha, Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Configuration

/** How long one skin takes to fade into the next, in ms. */
const FADE_MS = 1200;

/** How far behind its left neighbour each slice starts its fade, in ms. */
const STAGGER_MS = 450;

/** How far each slice reaches into its neighbour, as a percentage of the hero's width, so neighbouring skins melt into each other. */
const FEATHER = 9;

const styles = {
	// The whole backdrop, laid behind the carousel's cards and side buttons.
	root: { position: "absolute", inset: 0, pointerEvents: "none" },
	// The held and running states for the zoom, set as a variable on the root so a tap re-styles one element rather than every layer.
	held: { "--skin-drift-state": "paused" },
	running: { "--skin-drift-state": "running" },
	// One skin in a slice. Every layer is a fade in or a fade out, so the outgoing skin clears while the incoming one arrives.
	layer: {
		position: "absolute",
		inset: 0,
		"@keyframes skinBackdropIn": { from: { opacity: 0 }, to: { opacity: 1 } },
		"@keyframes skinBackdropOut": { from: { opacity: 1 }, to: { opacity: 0 } }
	},
	// The art itself, zoomed past the slice and anchored high, since the full art is a 2048px square of a whole body with the face near the top.
	art: {
		position: "absolute",
		inset: 0,
		backgroundRepeat: "no-repeat",
		backgroundSize: "170% auto",
		backgroundPosition: "50% 22%",
		animationPlayState: "var(--skin-drift-state)",
		"@keyframes skinBackdropDrift": { from: { transform: "scale(1)" }, to: { transform: "scale(1.08)" } }
	},
	// Dims the art so the cards stay readable, and fades it into the hero's own colour at every edge.
	scrim: (theme: Theme) => {
		const paper = theme.palette.background.paper;
		return {
			position: "absolute",
			inset: 0,
			background: [
				`linear-gradient(to right, ${paper} 0%, transparent 14%, transparent 86%, ${paper} 100%)`,
				`linear-gradient(to bottom, ${paper} 0%, transparent 12%, transparent 80%, ${paper} 100%)`,
				alpha(paper, 0.45)
			].join(", ")
		};
	}
} satisfies Record<string, SxProps<Theme>>;

/** One skin a slice has shown, keyed so React keeps each layer's animation running across renders. */
interface Layer {
	/** Increases with every skin the slice shows. */
	id: number;
	/** The full art, or null to fade the slice to empty. */
	url: string | null;
}

/** How every skin in the backdrop moves and looks, shared by all its slices. */
interface ArtMotion {
	/** The CSS filter, which softens the art on phones. */
	filter: string;
	/** The slow zoom's CSS animation, or `none` for reduced motion. */
	animation: string;
}

/** Props for SkinSlice. */
interface SkinSliceProps {
	/** The full art this slice should show, or null for none. */
	url: string | null;
	/** How long to wait after the art loads before fading it in, in ms. */
	delay: number;
	/** The slice's position and edge mask within the hero. */
	sx: SxProps<Theme> | undefined;
	/** The filter and zoom every skin shares. */
	motion: ArtMotion;
}

/** Props for SkinBackdrop. */
interface SkinBackdropProps {
	/** One full art per doll on screen, left to right. Null leaves that slice empty. */
	urls: (string | null)[];
	/** How long each set stays up, in ms, which the slow zoom spans. */
	dwellMs: number;
	/** Whether to soften the art, which the single-card phone layout asks for. */
	blur: boolean;
	/** Whether the carousel is held, which freezes the zoom with the countdown. */
	paused: boolean;
	/** Whether the reader asked for reduced motion, which drops the zoom and the stagger. */
	reduceMotion: boolean;
}

/**
 * Where one slice sits within the hero, and the mask that feathers it into its neighbours. The outer edges stay hard, since the scrim fades
 * those. A lone slice has no neighbours, so it gets no mask at all.
 *
 * @param index The slice's position, from the left.
 * @param count How many slices share the hero.
 * @returns The slice's styles.
 */
function sliceSx(index: number, count: number): SxProps<Theme> {
	const width = 100 / count;
	const left = Math.max(0, index * width - FEATHER);
	const right = Math.min(100, (index + 1) * width + FEATHER);
	if (count === 1) {
		return { position: "absolute", inset: 0 };
	}
	const edge = ((FEATHER * 2) / (right - left)) * 100;
	const start = index === 0 ? 0 : edge;
	const end = index === count - 1 ? 100 : 100 - edge;
	const mask = `linear-gradient(to right, transparent, #000 ${start}%, #000 ${end}%, transparent)`;
	return { position: "absolute", top: 0, bottom: 0, left: `${left}%`, right: `${100 - right}%`, maskImage: mask, WebkitMaskImage: mask };
}

/**
 * One doll's band of the backdrop. A new skin waits until it has loaded, so a slow image never fades in half drawn, then fades in over
 * the old one as the old one fades out. The old layer unmounts once the fade ends, so a slice never holds more than one decoded skin at rest.
 *
 * @param props Component props.
 * @returns The slice.
 */
const SkinSlice = memo(function SkinSlice({ url, delay, sx, motion }: SkinSliceProps) {
	const [layers, setLayers] = useState<Layer[]>([]);
	const nextId = useRef(0);

	useEffect(() => {
		let cancelled = false;
		let timer: number | undefined;
		const show = () => {
			if (!cancelled) {
				timer = window.setTimeout(() => setLayers((current) => [...current.slice(-1), { id: nextId.current++, url }]), delay);
			}
		};
		let image: HTMLImageElement | null = null;
		if (url === null) {
			show();
		} else {
			image = new Image();
			image.src = url;
			// A skin that fails to load is skipped, leaving the previous one up rather than fading to nothing.
			image.decode().then(show, () => undefined);
		}
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			// Stops a download the reader has already stepped past.
			if (image !== null) {
				image.src = "";
			}
		};
	}, [url, delay]);

	/** Drop the faded-out layer once the new one is fully in. The zoom's own end bubbles up here too, so only the fade's end counts. */
	const handleFadeEnd = (event: AnimationEvent<HTMLDivElement>) => {
		if (event.target === event.currentTarget) {
			setLayers((current) => (current.length > 1 ? current.slice(-1) : current));
		}
	};

	return (
		<Box sx={sx}>
			{layers.map((layer, index) => {
				const incoming = index === layers.length - 1;
				return (
					<Box
						key={layer.id}
						onAnimationEnd={incoming ? handleFadeEnd : undefined}
						sx={[styles.layer, { animation: `${incoming ? "skinBackdropIn" : "skinBackdropOut"} ${FADE_MS}ms ease forwards` }]}
					>
						{layer.url !== null && <Box sx={[styles.art, motion, { backgroundImage: `url("${layer.url}")` }]} />}
					</Box>
				);
			})}
		</Box>
	);
});

/**
 * The home carousel's backdrop: one band per doll on screen, each showing one of that doll's skins, feathered into its neighbours and
 * dimmed so the cards stay readable. On a new set the bands fade to their new skins one after another, left to right, and each drifts slowly
 * closer while its set is up.
 *
 * @param props Component props.
 * @returns The backdrop.
 */
export default memo(function SkinBackdrop({ urls, dwellMs, blur, paused, reduceMotion }: SkinBackdropProps) {
	const count = urls.length;
	// Both memoised, so a tap that pauses the carousel re-renders only the root, not every slice.
	const slices = useMemo(() => Array.from({ length: count }, (_, index) => sliceSx(index, count)), [count]);
	const motion = useMemo<ArtMotion>(
		() => ({ filter: blur ? "blur(3px)" : "none", animation: reduceMotion ? "none" : `skinBackdropDrift ${dwellMs + FADE_MS}ms linear forwards` }),
		[blur, reduceMotion, dwellMs]
	);

	return (
		<Box sx={[styles.root, paused ? styles.held : styles.running]} aria-hidden>
			{urls.map((url, index) => (
				<SkinSlice key={index} url={url} delay={reduceMotion ? 0 : index * STAGGER_MS} sx={slices[index]} motion={motion} />
			))}
			<Box sx={styles.scrim} />
		</Box>
	);
});
