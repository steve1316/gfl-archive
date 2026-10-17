import { memo, useEffect, useRef, useState } from "react";
import { Link as RouterLink } from "react-router-dom";

import { Box, Typography, alpha, styled } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import { storyBackgroundUrl } from "../../lib/assets";
import type { StoryChapterSummary } from "../../types/story";
import type { ChapterGroup } from "./groups";
import { pane } from "./styles";

/** How far past the visible list a row's art starts loading, so it is usually in place before the row scrolls in. */
const ART_MARGIN = "200px 0px";

/**
 * The toolbar mixin with each `minHeight` as `top`, so a heading on the phone list sticks just under the fixed navbar at every breakpoint.
 * It follows archive-kit's `fillBelowNavbar`, which reads the same mixin for heights.
 *
 * @param toolbar The theme's toolbar mixin, `theme.mixins.toolbar`, or one of its nested breakpoint rules.
 * @returns The style rules.
 */
function belowNavbar(toolbar: object): Record<string, unknown> {
	return Object.fromEntries(Object.entries(toolbar).map(([key, value]) => (key === "minHeight" ? ["top", value] : [key, typeof value === "object" && value !== null ? belowNavbar(value) : value])));
}

const styles = {
	// Pinned below the navbar with the page's own top padding above it and the same again below. The pane is only sticky on desktop
	// widths, where the theme's toolbar is its `sm`-and-up height.
	sticky: (theme: Theme) => {
		const navbar = (theme.mixins.toolbar[theme.breakpoints.up("sm")] as { minHeight: number }).minHeight;
		return { position: "sticky", top: `calc(${navbar}px + ${theme.spacing(3)})`, maxHeight: `calc(100vh - ${navbar}px - ${theme.spacing(6)})`, overflowY: "auto" };
	},
	pageHeading: (theme: Theme) => belowNavbar(theme.mixins.toolbar),
	heading: { position: "sticky", top: 0, zIndex: 2, display: "block", px: 1.75, pt: 1.5, pb: 0.75, bgcolor: "background.paper", color: "text.secondary" }
} satisfies Record<string, SxProps<Theme>>;

/**
 * One chapter row: its label, name and mission count over its cover, which starts halfway across and fades in from the left.
 * A single styled link with plain children, since the list redraws rows as the reader moves between chapters.
 */
const ChapterLink = styled(RouterLink)(({ theme }) => {
	const paper = theme.palette.background.paper;
	const shadow = `0 1px 4px ${theme.palette.common.black}`;
	return {
		position: "relative",
		display: "flex",
		alignItems: "center",
		gap: theme.spacing(1.25),
		minHeight: 60,
		padding: theme.spacing(0, 1.75),
		overflow: "hidden",
		color: theme.palette.text.primary,
		textDecoration: "none",
		"& > :not(.art)": { position: "relative", zIndex: 1 },
		"& .art": {
			position: "absolute",
			top: 0,
			bottom: 0,
			right: 0,
			left: "50%",
			backgroundSize: "100% auto",
			backgroundPosition: "50% 50%",
			backgroundRepeat: "no-repeat",
			opacity: 0.55,
			transition: "opacity .2s"
		},
		"& .art::after": { content: '""', position: "absolute", inset: 0, background: `linear-gradient(90deg, ${paper} 0%, ${alpha(paper, 0)} 50%)` },
		"&:hover .art, &[aria-current] .art, &:focus-visible .art": { opacity: 1 },
		"&[aria-current]": { boxShadow: `inset 3px 0 ${theme.palette.secondary.main}` },
		"&:focus-visible": { outline: `2px solid ${theme.palette.secondary.main}`, outlineOffset: -2 },
		"& .label": { minWidth: 44, color: theme.palette.secondary.main, fontWeight: 800 },
		"& .name": { flex: 1, textShadow: shadow },
		"& .count": { color: theme.palette.text.secondary, fontSize: 12, textShadow: shadow }
	};
});

/** Props for {@link ChapterRow}. */
interface ChapterRowProps {
	/** The chapter the row links to. */
	chapter: StoryChapterSummary;
	/** Whether the row has neared view, so its cover should load. */
	showArt: boolean;
	/** Whether this is the open chapter. */
	current: boolean;
	/** Called when the reader points at or focuses the row. */
	onIntent: (id: number) => void;
}

/**
 * One chapter row, memoized so moving between chapters redraws only the two rows whose state changed.
 *
 * @param props The chapter, its art, whether it is open, and the hover callback.
 * @returns The row.
 */
const ChapterRow = memo(function ChapterRow({ chapter, showArt, current, onIntent }: ChapterRowProps) {
	return (
		<ChapterLink to={`/story/${chapter.id}`} data-chapter={chapter.id} aria-current={current ? "page" : undefined} onMouseEnter={() => onIntent(chapter.id)} onFocus={() => onIntent(chapter.id)}>
			<span className="art" style={showArt ? { backgroundImage: `url("${storyBackgroundUrl(chapter.cover)}")` } : undefined} />
			<span className="label">{chapter.label}</span>
			<span className="name">{chapter.name}</span>
			<span className="count">{chapter.missions}</span>
		</ChapterLink>
	);
});

/** Props for {@link ChapterList}. */
interface ChapterListProps {
	/** The chapters under their headings, in display order. */
	groups: ChapterGroup[];
	/** The chapter to mark and scroll into view: the open one, or on a phone the one last opened. Null marks none. */
	selected: number | null;
	/** Whether the list keeps to the viewport and scrolls on its own, as the desktop side pane does. */
	sticky: boolean;
	/** Called when the reader points at or focuses a chapter, so its missions can start loading early. */
	onIntent: (id: number) => void;
}

/**
 * The chapter list: one row per chapter under its group heading, each with its cover faded in behind it from the middle.
 *
 * A row's art loads only once the row comes near view, so a first visit fetches the dozen covers on screen rather than all of them.
 *
 * @param props The groups, the open chapter, the layout and the hover callback.
 * @returns The list.
 */
function ChapterList({ groups, selected, sticky, onIntent }: ChapterListProps) {
	const paneRef = useRef<HTMLDivElement>(null);
	const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set());

	// One observer for the whole list. The sticky pane is its own scroll container, so it is the root there. On a phone the page scrolls.
	useEffect(() => {
		const pane = paneRef.current;
		if (!pane) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				const shown = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target as HTMLElement);
				if (shown.length === 0) {
					return;
				}
				shown.forEach((element) => observer.unobserve(element));
				setSeen((current) => new Set([...current, ...shown.map((element) => Number(element.dataset.chapter))]));
			},
			{ root: sticky ? pane : null, rootMargin: ART_MARGIN }
		);
		pane.querySelectorAll("[data-chapter]").forEach((element) => observer.observe(element));
		return () => observer.disconnect();
	}, [groups, sticky]);

	// The phone list centres the row it was left from.
	useEffect(() => {
		if (selected !== null) {
			paneRef.current?.querySelector(`[data-chapter="${selected}"]`)?.scrollIntoView({ block: sticky ? "nearest" : "center" });
		}
	}, [selected, sticky]);

	return (
		<Box ref={paneRef} component="nav" aria-label="Story chapters" sx={[pane, sticky && styles.sticky]}>
			{groups.map((group) => (
				<Box key={group.title} component="section">
					<Typography component="h2" variant="overline" sx={[styles.heading, !sticky && styles.pageHeading]}>
						{group.title}
					</Typography>
					{group.chapters.map((chapter) => (
						<ChapterRow key={chapter.id} chapter={chapter} showArt={seen.has(chapter.id)} current={chapter.id === selected} onIntent={onIntent} />
					))}
				</Box>
			))}
		</Box>
	);
}

export default memo(ChapterList);
