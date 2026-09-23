import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

// Component imports
import ScrollToTop from "../../components/ScrollToTop";
import DollCarousel from "../../components/DollCarousel";

// MaterialUI imports
import { Container, Button, Grid, Card, CardMedia, CardActionArea, CardActions, CardContent, Typography, Grow, Box } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

// MaterialUI icon imports
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";

import { uiUrl } from "../../lib/assets";
import { dollIdsWithArt } from "../../lib/data";

const tdoll_index_logo = uiUrl("tdoll_index_logo.jpg");
const equipment_index_logo = uiUrl("equipment_index_logo.jpg");
const hoc_index_logo = uiUrl("hoc_index_logo.jpg");
const fairy_index_logo = uiUrl("fairy_index_logo.jpg");
const enemy_index_logo = uiUrl("enemy_index_logo.jpg");
const formation_logo = uiUrl("formation_logo.jpg");
const story_logo = uiUrl("story_logo.jpg");

/**
 * Styles for this page, as `sx` entries.
 *
 * These were a style hook built inside the component body, so a fresh hook was created on every
 * render. `sx` needs no hook and the values sit at module scope with the rest of the configuration.
 */
const styles = {
	root: { py: 3 },
	// Padding lives inside the carousel, so its side buttons reach the hero's top and bottom edges.
	heroContent: { backgroundColor: "background.paper" },
	cardGrid: { py: 8 },
	// Centred, so a short last row sits under the middle of the rows above it.
	cardRow: { justifyContent: "center" },
	card: { height: "100%", display: "flex", flexDirection: "column" },
	// 16:9, held open by padding because the image is a background.
	cardMedia: { paddingTop: "56.25%" },
	cardContent: { flexGrow: 1 },
	cardButton: { display: "flex", margin: "10px", justifyContent: "flex-end" }
} satisfies Record<string, SxProps<Theme>>;

/** The section cards under the carousel. Static, so declared once here instead of rebuilt on every render. The links match the routes in App.tsx. */
const SECTION_CARDS = [
	{ title: "T-Doll Index", description: "View Index of T-Dolls along with additional information like statistics and sprite animations.", link: "/index", image: tdoll_index_logo },
	{ title: "Equipment Index", description: "View Index of Equipment available for T-Dolls.", link: "/equipment-index", image: equipment_index_logo },
	{ title: "HOC Index", description: "View Index of HOCs available.", link: "/hoc-index", image: hoc_index_logo },
	{ title: "Fairy Index", description: "View Index of Fairies available.", link: "/fairy-index", image: fairy_index_logo },
	{
		title: "Enemy Index",
		description: "View Index of every enemy in the game, and which of them Protocol Assimilation can capture.",
		link: "/enemy-index",
		image: enemy_index_logo
	},
	{ title: "Formation Simulator", description: "Simulate T-Doll formations and formation effects.", link: "/formation", image: formation_logo },
	{ title: "Story", description: "Read the main story and every side campaign, with the game's own art, music and sound effects.", link: "/story", image: story_logo }
];

/** Transform origin for each card's grow-in. A constant, since an inline object is a new prop every render. */
const GROW_STYLE = { transformOrigin: "0 0 0" };

/** How many dolls the carousel holds: four sets of three before it asks for a fresh pool. */
const CAROUSEL_SIZE = 12;

/** Every doll id with hosted art, read once. */
const DOLL_IDS_WITH_ART = dollIdsWithArt();

/**
 * Pick distinct doll ids with art, uniformly at random.
 *
 * @param count How many ids to return.
 * @returns Up to `count` distinct ids.
 */
function randomDollIds(count: number): number[] {
	const pool = [...DOLL_IDS_WITH_ART];
	for (let index = pool.length - 1; index > 0; index--) {
		const swap = Math.floor(Math.random() * (index + 1));
		[pool[index], pool[swap]] = [pool[swap] as number, pool[index] as number];
	}
	return pool.slice(0, count);
}

/**
 * The landing page: a doll carousel and cards linking to each section.
 *
 * @returns The home page.
 */
export default function Home() {
	// Held in state rather than derived, so previous and next are real history rather than fresh rolls and
	// the shuffle button can hand the carousel a whole new set.
	const [carouselIds, setCarouselIds] = useState(() => randomDollIds(CAROUSEL_SIZE));

	// Stable, so the memoised carousel does not re-render whenever the home page does.
	const reshuffle = useCallback(() => setCarouselIds(randomDollIds(CAROUSEL_SIZE)), []);

	// Set HTML meta-data here using document API.
	useEffect(() => {
		document.title = "Griffin Archive";
		document.querySelector('meta[name="description"]')?.setAttribute("content", "Database for Girls' Frontline featuring T-Dolls, equipment, Fairies, HOCs and enemies");
	}, []);

	return (
		<Box component="main" sx={styles.root}>
			<ScrollToTop />

			{/* Hero Unit */}
			<Box sx={{ boxShadow: 1 }}>
				{/* No container here: the carousel spans the hero, since each side of it is a button. */}
				<Box component="div" sx={styles.heroContent}>
					<DollCarousel ids={carouselIds} onShuffle={reshuffle} />
				</Box>
			</Box>
			{/* End of Hero Unit */}

			{/* Cards Section for Navigation */}
			{/* Wide enough for four cards a row. */}
			<Container sx={styles.cardGrid} maxWidth="lg">
				<Grid container spacing={4} sx={styles.cardRow}>
					{SECTION_CARDS.map((card, index) => {
						// Each card grows in 100ms after the one before it. This was a counter mutated during the map.
						return (
							<Grid key={card.title} size={{ xs: 12, sm: 6, md: 4, lg: 3 }}>
								<Grow in={true} style={GROW_STYLE} timeout={600 + index * 100}>
									<Card sx={styles.card}>
										{/* The artwork links to the section too. It was a button that did nothing and had no name. */}
										<CardActionArea component={Link} to={card.link} aria-label={card.title}>
											<CardMedia sx={styles.cardMedia} image={card.image} title={card.title} />
										</CardActionArea>
										<CardContent sx={styles.cardContent}>
											<Typography component="h2" variant="h5" gutterBottom>
												{card.title}
											</Typography>
											<Typography color="textSecondary">{card.description}</Typography>
										</CardContent>
										<CardActions sx={styles.cardButton}>
											{/* One link styled as a button, rather than a button nested inside a link, with a name for screen readers. */}
											<Button component={Link} to={card.link} size="small" variant="contained" color="primary" aria-label={`Open ${card.title}`}>
												<ArrowForwardIcon />
											</Button>
										</CardActions>
									</Card>
								</Grow>
							</Grid>
						);
					})}
				</Grid>
			</Container>
			{/* End of Cards Section */}
		</Box>
	);
}
