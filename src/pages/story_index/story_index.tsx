import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useParams } from "react-router-dom";

import { Box, CircularProgress, Container } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import LoadError from "../../components/LoadError";
import ScrollToTop from "../../components/ScrollToTop";
import { loadStoryChapter, loadStoryIndex } from "../../lib/data";
import type { StoryChapter, StoryChapterSummary, StoryIndex } from "../../types/story";
import ChapterList from "./ChapterList";
import ChapterPanel from "./ChapterPanel";
import { groupChapters } from "./groups";

const styles = {
	split: { display: "grid", gridTemplateColumns: "340px minmax(0, 1fr)", gap: 2, alignItems: "start" },
	loading: { display: "flex", justifyContent: "center", py: 6 }
} satisfies Record<string, SxProps<Theme>>;

/**
 * Start loading a chapter's missions before it is opened, so the click finds them cached. A failure is left for the real load to report.
 *
 * @param id The chapter id.
 */
function prefetchChapter(id: number) {
	loadStoryChapter(id).catch(() => {});
}

/**
 * The story index: the chapter list beside the open chapter's banner and missions.
 *
 * Each chapter has its own address, `/story/<id>`, and bare `/story` opens the first main story chapter. Only the open chapter's
 * missions are fetched and drawn, so switching chapters touches one panel rather than the whole list.
 *
 * @returns The page.
 */
export default function StoryIndexPage() {
	const { chapter: param } = useParams();
	const [index, setIndex] = useState<StoryIndex | null>(null);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [loaded, setLoaded] = useState<Record<number, StoryChapter>>({});
	const [failedChapter, setFailedChapter] = useState<number | null>(null);
	const [chapterAttempt, setChapterAttempt] = useState(0);

	const groups = useMemo(() => (index ? groupChapters(index.chapters) : []), [index]);
	// The open chapter and the heading it sits under. Bare `/story` opens the first chapter of the first group.
	const open = useMemo(() => {
		const matches = (chapter: StoryChapterSummary) => param === undefined || String(chapter.id) === param;
		const group = groups.find((candidate) => candidate.chapters.some(matches));
		const summary = group?.chapters.find(matches);
		return group && summary ? { summary, group: group.title } : null;
	}, [groups, param]);
	const selected = open?.summary.id ?? null;

	useEffect(() => {
		document.title = "Story";
	}, []);

	useEffect(() => {
		let active = true;
		setFailed(false);
		loadStoryIndex().then(
			(result) => active && setIndex(result),
			() => active && setFailed(true)
		);
		return () => {
			active = false;
		};
	}, [attempt]);

	// A late answer for a chapter the reader has already left still fills its own slot, but only the open chapter can report a failure.
	useEffect(() => {
		if (selected === null) {
			return;
		}
		let active = true;
		setFailedChapter(null);
		loadStoryChapter(selected).then(
			(chapter) => setLoaded((current) => (current[selected] ? current : { ...current, [selected]: chapter })),
			() => active && setFailedChapter(selected)
		);
		return () => {
			active = false;
		};
	}, [selected, chapterAttempt]);

	const retry = useCallback(() => setAttempt((count) => count + 1), []);
	const retryChapter = useCallback(() => setChapterAttempt((count) => count + 1), []);

	if (index && param !== undefined && !open) {
		return <Navigate to="/story" replace />;
	}

	return (
		<Box component="main" sx={{ py: 3 }}>
			<ScrollToTop />
			<Container maxWidth="xl">
				{failed ? (
					<LoadError what="the story index" onRetry={retry} titleComponent="h1" />
				) : !index || !open ? (
					<Box sx={styles.loading}>
						<CircularProgress aria-label="Loading the story index" />
					</Box>
				) : (
					<Box sx={styles.split}>
						<ChapterList groups={groups} selected={selected} sticky onIntent={prefetchChapter} />
						<ChapterPanel summary={open.summary} group={open.group} chapter={loaded[open.summary.id] ?? null} failed={failedChapter === open.summary.id} onRetry={retryChapter} />
					</Box>
				)}
			</Container>
		</Box>
	);
}
