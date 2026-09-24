import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import { Link, useParams } from "react-router-dom";

// MaterialUI imports
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import ZoomOutMapIcon from "@mui/icons-material/ZoomOutMap";
import { Box, Button, CardMedia, Chip, Container, Fab, Grid, Paper, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

// Component imports
import ArtPlaceholder from "../../components/ArtPlaceholder";
import Live2dStage from "../../components/Live2dStage";
import LoadError from "../../components/LoadError";
import ScrollToTop from "../../components/ScrollToTop";
import NotFound404 from "../../not_found_404";
import FairySkillPanel from "./FairySkillPanel";
import FairyStatsPanel from "./FairyStatsPanel";
import FairyTalentsPopover from "./FairyTalentsPopover";

import { FAB_EXPAND_SX, containArtSx } from "../../lib/artLayout";
import { fairyFormUrl, fairyLive2dModelUrl } from "../../lib/assets";
import { formatBuildTime } from "../../lib/buildTime";
import { FAIRY_MAX_STARS, fairyForm, fairyFormLabel } from "../../lib/fairyStats";
import { hasFairyForm, hasFairyLive2d } from "../../lib/processData";
import { useFairies } from "../../lib/useFairies";
import { useFairyLive2dMotions } from "../../lib/useLive2dMotions";
import type { Fairy, FairyConstants, FairyTalent } from "../../types/fairy";

const styles = {
	page: { pt: 2, pb: 3, maxWidth: 1200, mx: "auto" },
	section: { p: { xs: 2, md: 2.5 }, height: "100%" },
	sectionHeading: { mb: 1.5 },
	hero: { display: "flex", flexDirection: { xs: "column", md: "row" }, alignItems: { xs: "stretch", md: "flex-start" }, gap: { xs: 2, md: 3 } },
	// The art is the largest the game has at 512x512, so it leads the hero at close to its own size. This column also
	// carries the Art/Live2D toggle, so the stage stays the same size as the art.
	artColumn: { display: "flex", flexDirection: "column", gap: 1, width: { xs: "100%", md: 460 }, maxWidth: 512, mx: { xs: "auto", md: 0 }, flex: "none" },
	// The same full-width toggle the HOC card uses to switch between its rigs and Live2D.
	modeToggle: { width: "100%", "& .MuiToggleButton-root": { flex: 1 } },
	artBox: {
		position: "relative",
		width: "100%",
		aspectRatio: "1 / 1",
		borderRadius: "8px",
		overflow: "hidden",
		bgcolor: "action.hover"
	},
	placeholder: { position: "absolute", inset: 0, aspectRatio: "auto", height: "100%" },
	facts: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 },
	forms: { alignSelf: "flex-start" },
	chips: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 1 },
	name: { fontWeight: 700 },
	infoRow: { display: "flex", justifyContent: "space-between", gap: 2, py: 0.75, borderBottom: 1, borderColor: "divider", "&:last-of-type": { borderBottom: 0 } }
} satisfies Record<string, SxProps<Theme>>;

/** Props for FairyDetail. */
interface FairyDetailProps {
	/** The fairy to show. */
	fairy: Fairy;
	/** The shared stat constants. */
	constants: FairyConstants;
	/** Every fairy talent, for the talents popover. */
	talents: FairyTalent[];
}

/**
 * One loaded fairy's content: hero art and form picker, talents popover, stats, info and skill.
 *
 * Owns the chosen star rank itself and is keyed by the fairy's id from `FairyPage`, so switching to a different
 * fairy remounts this component and starts back at the highest star rank instead of carrying the old one over.
 *
 * @param props Component props.
 * @returns The fairy's content.
 */
function FairyDetail({ fairy, constants, talents }: FairyDetailProps) {
	const [stars, setStars] = useState(FAIRY_MAX_STARS);
	const [talentsAnchor, setTalentsAnchor] = useState<HTMLElement | null>(null);
	// Which the card shows in the art box. Kept separate from `hasLive2d` below so a form switch that drops the
	// model falls back to Art visually (via `live2dActive`) without losing the reader's choice if it comes back.
	const [mode, setMode] = useState<"art" | "live2d">("art");

	const form = fairyForm(constants, stars);
	const talentsOpen = talentsAnchor !== null;
	const hosted = hasFairyForm(fairy.id, form);
	const hasLive2d = hasFairyLive2d(fairy.id, form);
	const live2dActive = hasLive2d && mode === "live2d";

	const motions = useFairyLive2dMotions(hasLive2d ? fairy.id : undefined);
	const live2dModelUrl = fairyLive2dModelUrl(fairy.id, form);
	// Memoised, so the Live2D stage's memo holds across this page's own re-renders.
	const live2dOverlay = useMemo(
		() => (
			<Fab color="primary" component={Link} to={`/fairy/${fairy.id}/live2d?stars=${stars}`} sx={FAB_EXPAND_SX} aria-label="view full Live2D">
				<ZoomOutMapIcon />
			</Fab>
		),
		[fairy.id, stars]
	);

	const handleForm = useCallback(
		(_event: MouseEvent<HTMLElement>, value: number | null) => {
			if (value !== null) {
				const ranks = constants.forms[value - 1];
				if (ranks !== undefined && ranks[0] !== undefined) {
					setStars(ranks[0]);
				}
			}
		},
		[constants]
	);

	const handleOpenTalents = useCallback((event: MouseEvent<HTMLElement>) => setTalentsAnchor(event.currentTarget), []);

	const handleCloseTalents = useCallback(() => setTalentsAnchor(null), []);

	const handleMode = useCallback((_event: MouseEvent<HTMLElement>, value: "art" | "live2d" | null) => {
		if (value !== null) {
			setMode(value);
		}
	}, []);

	return (
		<main>
			<ScrollToTop />
			<Container sx={styles.page} maxWidth={false}>
				<Grid container spacing={2}>
					{/* Art, form picker, name, type and flavour text */}
					<Grid size={12}>
						<Paper sx={styles.section} variant="outlined">
							<Box sx={styles.hero}>
								<Box sx={styles.artColumn}>
									{hasLive2d ? (
										<ToggleButtonGroup value={mode} exclusive onChange={handleMode} size="small" sx={styles.modeToggle} aria-label="Art or Live2D">
											<ToggleButton value="art">Art</ToggleButton>
											<ToggleButton value="live2d">Live2D</ToggleButton>
										</ToggleButtonGroup>
									) : null}
									{live2dActive ? (
										<Live2dStage modelUrl={live2dModelUrl} motions={motions} label="Fairy Live2D model" resetCorner="left" overlay={live2dOverlay} sx={styles.artBox} />
									) : (
										<Box sx={styles.artBox}>
											{hosted ? (
												<CardMedia component="img" image={fairyFormUrl(fairy.id, form)} alt="" sx={containArtSx} />
											) : (
												<ArtPlaceholder name={fairy.name} sx={styles.placeholder} />
											)}
											{hosted ? (
												<Fab color="primary" component={Link} to={`/fairy/${fairy.id}/art?form=${form}`} sx={FAB_EXPAND_SX} aria-label="view full art">
													<ZoomOutMapIcon />
												</Fab>
											) : null}
										</Box>
									)}
								</Box>
								<Box sx={styles.facts}>
									<ToggleButtonGroup value={form} exclusive onChange={handleForm} size="small" sx={styles.forms} aria-label="Fairy form">
										{constants.forms.map((ranks, index) => (
											<ToggleButton key={index} value={index + 1} aria-label={fairyFormLabel(ranks)}>
												{fairyFormLabel(ranks)}
											</ToggleButton>
										))}
									</ToggleButtonGroup>
									<Typography component="h1" variant="h4" sx={styles.name}>
										{fairy.name}
									</Typography>
									<Box sx={styles.chips}>
										<Chip label={fairy.typeName} color="primary" variant="outlined" size="small" />
										<Button variant="outlined" size="small" startIcon={<AutoAwesomeOutlinedIcon />} onClick={handleOpenTalents} aria-haspopup="true" aria-expanded={talentsOpen}>
											Talents
										</Button>
										<FairyTalentsPopover anchorEl={talentsAnchor} open={talentsOpen} onClose={handleCloseTalents} talents={talents} />
									</Box>
									<Typography variant="body2" color="text.secondary">
										{fairy.tagline}
									</Typography>
									<Typography variant="body1" color="text.secondary">
										{fairy.introduce}
									</Typography>
								</Box>
							</Box>
						</Paper>
					</Grid>

					<Grid size={{ xs: 12, md: 6 }}>
						<Paper sx={styles.section} variant="outlined">
							<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
								Stats
							</Typography>
							<FairyStatsPanel fairy={fairy} constants={constants} stars={stars} onStarsChange={setStars} />
						</Paper>
					</Grid>

					<Grid size={{ xs: 12, md: 6 }}>
						<Paper sx={styles.section} variant="outlined">
							<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
								Info
							</Typography>
							<Box sx={styles.infoRow}>
								<Typography variant="body2" color="text.secondary">
									Type
								</Typography>
								<Typography variant="body2">{fairy.typeName}</Typography>
							</Box>
							<Box sx={styles.infoRow}>
								<Typography variant="body2" color="text.secondary">
									Production time
								</Typography>
								<Typography variant="body2">{fairy.productionSeconds === null ? "Not in production" : formatBuildTime(fairy.productionSeconds)}</Typography>
							</Box>
							<Box sx={styles.infoRow}>
								<Typography variant="body2" color="text.secondary">
									Source
								</Typography>
								<Typography variant="body2">{fairy.source}</Typography>
							</Box>
						</Paper>
					</Grid>

					<Grid size={12}>
						<Paper sx={styles.section} variant="outlined">
							<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
								Skill
							</Typography>
							<FairySkillPanel skill={fairy.skill} strategy={fairy.strategy} />
						</Paper>
					</Grid>
				</Grid>
			</Container>
		</main>
	);
}

/**
 * One Fairy's page: its stats at any level and star rank, its skill, and its production info.
 *
 * @returns The Fairy page, a loading state, a retry notice, or the 404 page for an unknown id.
 */
export default function FairyPage() {
	const { id: rawId } = useParams<{ id: string }>();
	const { data, loadFailed, retry } = useFairies();

	const fairy = data?.items.find((entry) => String(entry.id) === rawId);

	useEffect(() => {
		if (fairy) {
			document.title = `${fairy.name} - Fairy`;
			document.querySelector('meta[name="description"]')?.setAttribute("content", `${fairy.name}, a ${fairy.typeName} fairy`);
		}
	}, [fairy]);

	if (loadFailed) {
		return (
			<Container component="main" sx={styles.page}>
				<LoadError what="this fairy" onRetry={retry} titleComponent="h1" />
			</Container>
		);
	}
	if (data === null) {
		return <Box component="main" />;
	}
	if (fairy === undefined) {
		return <NotFound404 message={`There is no fairy with the id ${rawId ?? ""}.`} />;
	}

	// Keyed by fairy so switching to another fairy remounts this and resets its star rank to the highest.
	return <FairyDetail key={fairy.id} fairy={fairy} constants={data.constants} talents={data.talents} />;
}
