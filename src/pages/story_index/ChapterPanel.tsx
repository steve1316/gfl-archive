import { memo } from "react";
import { Link as RouterLink } from "react-router-dom";

import { Box, IconButton, Skeleton, Typography, alpha, styled } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";

import LoadError from "../../components/LoadError";
import { storyBackgroundUrl } from "../../lib/assets";
import type { StoryChapter, StoryChapterSummary } from "../../types/story";
import { pane } from "./styles";

/** The most placeholder rows drawn while a chapter loads. The longest chapter has 94 missions, which is far more than fits on screen. */
const SKELETON_ROWS = 8;

const styles = {
	banner: {
		position: "relative",
		display: "flex",
		flexDirection: "column",
		justifyContent: "flex-end",
		minHeight: 240,
		px: 2.5,
		pt: 2.25,
		pb: 2,
		borderBottom: 1,
		borderColor: "divider",
		backgroundSize: "cover",
		backgroundPosition: "center",
		"&::before": {
			content: '""',
			position: "absolute",
			inset: 0,
			background: (theme: Theme) => {
				const paper = theme.palette.background.paper;
				return `linear-gradient(180deg, ${alpha(paper, 0.13)} 0%, ${alpha(paper, 0.67)} 55%, ${paper} 100%)`;
			}
		},
		"& > *": { position: "relative" }
	},
	back: { position: "absolute", top: 8, left: 8, bgcolor: (theme: Theme) => alpha(theme.palette.background.paper, 0.7), "&:hover": { bgcolor: "background.paper" } },
	group: { color: "text.secondary" },
	label: { color: "secondary.main", fontSize: 26, fontWeight: 800, mr: 1.25 },
	name: { fontSize: 24, fontWeight: 700, textShadow: (theme: Theme) => `0 2px 10px ${theme.palette.common.black}` },
	count: { color: "text.secondary" },
	skeleton: { mx: 2.5, my: 1.375, height: 44 }
} satisfies Record<string, SxProps<Theme>>;

/**
 * One mission row. A single styled link with plain children, since the longest chapter lists 94 missions and a styled component per
 * cell made opening it block for ~80ms at 4x CPU throttle.
 */
const MissionLink = styled(RouterLink)(({ theme }) => ({
	display: "flex",
	gap: theme.spacing(1.75),
	padding: theme.spacing(1.375, 2.5),
	color: theme.palette.text.primary,
	textDecoration: "none",
	"& + &": { borderTop: `1px solid ${theme.palette.divider}` },
	"&:hover, &:focus-visible": { backgroundColor: theme.palette.raised },
	"& .number": { minWidth: 64, color: theme.palette.secondary.main, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
	"& .title": { fontWeight: 600 },
	"& .description": { color: theme.palette.text.secondary, fontSize: 13 }
}));

/** Props for {@link ChapterPanel}. */
interface ChapterPanelProps {
	/** The chapter as the index lists it, which is enough for the banner before its missions arrive. */
	summary: StoryChapterSummary;
	/** The heading the chapter sits under in the list. */
	group: string;
	/** The chapter's missions, or null while they load. */
	chapter: StoryChapter | null;
	/** Whether the missions failed to load. */
	failed: boolean;
	/** Tries the load again. */
	onRetry: () => void;
	/** Where the back button over the banner's corner leads, as the phone layout's way back to the list. Left out, there is no button. */
	backTo?: string;
}

/**
 * One chapter: a banner of its cover with its label and name, then its missions, each numbered and linking to the player.
 *
 * @param props The chapter, its group, its missions and their load state, and an optional back link.
 * @returns The panel.
 */
function ChapterPanel({ summary, group, chapter, failed, onRetry, backTo }: ChapterPanelProps) {
	const count = `${summary.missions} ${summary.missions === 1 ? "mission" : "missions"}`;

	return (
		<Box component="section" aria-labelledby="story-chapter-title" sx={pane}>
			<Box sx={styles.banner} style={{ backgroundImage: `url("${storyBackgroundUrl(summary.cover)}")` }}>
				{backTo && (
					<IconButton component={RouterLink} to={backTo} aria-label="All chapters" sx={styles.back}>
						<ArrowBackIcon />
					</IconButton>
				)}
				<Typography component="span" variant="overline" sx={styles.group}>
					{group}
				</Typography>
				<Typography component="h1" id="story-chapter-title">
					<Box component="span" sx={styles.label}>
						{summary.label}
					</Box>
					<Box component="span" sx={styles.name}>
						{summary.name}
					</Box>
				</Typography>
				<Typography component="span" sx={styles.count}>
					{count}
				</Typography>
			</Box>
			{failed ? (
				<LoadError what={summary.name} onRetry={onRetry} titleComponent="h2" />
			) : !chapter ? (
				Array.from({ length: Math.min(summary.missions, SKELETON_ROWS) }, (_, index) => <Skeleton key={index} variant="rounded" sx={styles.skeleton} />)
			) : (
				chapter.missions.map((mission) => (
					<MissionLink key={mission.id} to={`/story/${summary.id}/${encodeURIComponent(mission.scripts[0] ?? "")}`}>
						<span className="number">{mission.number}</span>
						<div>
							<div className="title">{mission.title}</div>
							<div className="description">{mission.description}</div>
						</div>
					</MissionLink>
				))
			)}
		</Box>
	);
}

export default memo(ChapterPanel);
