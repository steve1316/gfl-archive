import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";

// Component imports
import LazySection from "../../components/LazySection";
import LoadError from "../../components/LoadError";
import ScrollToTop from "../../components/ScrollToTop";
import NotFound404 from "../../not_found_404";
import ChibiPanel from "./ChibiPanel";
import type { ChibiMode } from "./ChibiPanel";
import DollHero from "./DollHero";
import PageBackdrop from "../../components/PageBackdrop";
import SkillsPanel from "./SkillsPanel";
import StatsPanel from "./StatsPanel";
import TilesPanel from "./TilesPanel";

// MaterialUI imports
import { Box, Container, Grid, Paper, Typography, alpha } from "@mui/material";
import type { SxProps, Theme } from "@mui/material";

import { skinFormKey } from "../../lib/assets";
import { loadDollDetails, loadSpineRigs } from "../../lib/data";
import { useSkinLive2dForms } from "../../lib/useLive2dMotions";
import type { SpineDollEntry } from "../../types/spine";
import type { TDoll as TDollData, TDollForm, TDollWithDetails } from "../../types/tdoll";

/** A doll paired with the form currently being displayed. */
interface DisplayTDoll extends TDollWithDetails {
	/** The form on screen: the base form, the Mod, or a skin. */
	selected: TDollForm;
}

const styles = {
	page: {
		pt: 2,
		pb: 3,
		// Wider than the xl breakpoint so a 1920 screen actually gets four usable columns, but still capped
		// so the sections do not stretch into a letterbox on an ultrawide.
		maxWidth: 1800,
		mx: "auto",
		// Lifts the content above the fixed backdrop, which would otherwise paint over it.
		position: "relative",
		zIndex: 1
	},
	// Translucent so the backdrop reads through the sections too, with a light blur behind the panel to keep
	// the text legible over the busier parts of the art.
	section: (theme: Theme) => ({
		p: { xs: 2, md: 2.5 },
		backgroundColor: alpha(theme.palette.background.paper, 0.7),
		backdropFilter: "blur(6px)"
	}),
	// The two sections under the hero share a row from a medium screen up, so they fill it to the taller one.
	// Narrower screens keep natural heights, where equalising would pair a card with the taller Animations one.
	rowSection: {
		height: { md: "100%" },
		// On a wide screen the panel inside grows with the card too, so the inner boxes end level. Between md and
		// lg the Abilities card stacks and runs far taller than the stat table, and a grown table there was a
		// large empty box, so the table keeps its own height and only the outer card matches.
		display: { md: "flex" },
		flexDirection: "column",
		"& > :last-child": { flexGrow: { md: 0, lg: 1 } }
	},
	sectionHeading: {
		mb: 1.5
	},
	// Skill and tile buffs side by side inside the Abilities card on a wide screen, stacked on a narrow one.
	abilities: {
		display: "flex",
		flexDirection: { xs: "column", lg: "row" },
		gap: 2
	},
	// Each half stretches to the card's height, and its panel fills the half, so the two inner boxes end level.
	// Tile buffs is a fixed 300px on a wide screen, about what its grid and one line of text need, and the
	// skill takes the rest, since its description is what wraps and makes the whole row taller.
	abilityPart: {
		display: "flex",
		flexDirection: "column",
		minWidth: 0,
		"& > :last-child": { flexGrow: 1 }
	},
	abilityHeading: {
		mb: 1,
		fontWeight: 600
	},
	// The Spine stage tracks its container, so this is what actually decides how large the chibi draws.
	chibiColumn: {
		maxWidth: { xs: 480, lg: 340 },
		mx: "auto"
	}
} satisfies Record<string, SxProps<Theme>>;

/** What the reader has chosen to look at, as kept in the page's query string. */
interface DollSelection {
	/** Whether the Mod is on screen. */
	mod: boolean;
	/** The key of the skin on screen, its skin id as a string, or null for the base art. */
	skin: string | null;
	/** Whether the damaged art is on screen. */
	damaged: boolean;
}

/**
 * Read the selected skin from the `skin` parameter.
 *
 * The parameter holds a skin id. Links from before the skin-id layout hold the skin's 1-based position instead, so a number that is not
 * one of the doll's skin ids is read as the Nth skin.
 *
 * @param param The `skin` parameter, or null when absent.
 * @param doll The doll the selection applies to.
 * @returns The selected skin's key, or null when the parameter names no skin the doll has.
 */
function readSkin(param: string | null, doll: TDollData): string | null {
	const skinIds = doll.skins?.skin_ids ?? [];
	if (param === null || param === "") {
		return null;
	}
	if (skinIds.some((skinId) => skinId !== null && String(skinId) === param)) {
		return param;
	}
	const position = Number(param);
	const skinId = Number.isInteger(position) && position >= 1 ? skinIds[position - 1] : undefined;
	return skinId === null || skinId === undefined ? null : String(skinId);
}

/**
 * Read the selection from the query string, dropping anything the doll does not have.
 *
 * @param params The page's query string.
 * @param doll The doll the selection applies to.
 * @returns The selection to open the page on.
 */
function readSelection(params: URLSearchParams, doll: TDollData): DollSelection {
	return {
		mod: params.get("mod") === "1" && doll.mod !== null,
		skin: readSkin(params.get("skin"), doll),
		damaged: params.get("damaged") === "1"
	};
}

/**
 * Write a selection into a query string, leaving any other parameters alone.
 *
 * @param params The query string to update in place.
 * @param selection The selection to write. Defaults are removed rather than written.
 */
function writeSelection(params: URLSearchParams, selection: DollSelection) {
	const entries: [string, string | null][] = [
		["mod", selection.mod ? "1" : null],
		["skin", selection.skin],
		["damaged", selection.damaged ? "1" : null]
	];
	for (const [key, value] of entries) {
		if (value === null) {
			params.delete(key);
		} else {
			params.set(key, value);
		}
	}
}

/**
 * Route wrapper that loads the doll before rendering it.
 *
 * @returns A placeholder while loading, a retry notice when the doll's data fails to load, then the doll's page.
 */
export default function TDoll() {
	const { id: routeId } = useParams<{ id?: string }>();
	const [searchParams] = useSearchParams();
	// The id comes from the /tdoll/:id route, falling back to the older ?id= query string.
	const rawId = routeId ?? searchParams.get("id") ?? "";
	const id = Number(rawId);
	// Undefined while loading, null once the shard has loaded without this id, and "failed" when the shard or profile file could not load.
	const [doll, setDoll] = useState<DisplayTDoll | null | undefined | "failed">(undefined);
	// The doll's Spine rigs: undefined while loading, null when none were published or the index could not load.
	const [spine, setSpine] = useState<SpineDollEntry | null | undefined>(undefined);
	// Bumped by the retry button to run the loads again.
	const [attempt, setAttempt] = useState(0);
	const retry = useCallback(() => setAttempt((current) => current + 1), []);

	// Only the shard holding this doll and its profile side file are fetched. A copy is stored rather than the cached object,
	// because `selected` is assigned onto it below and the cache is shared with every other route. A failed load shows a retry
	// notice rather than a page without its profile, since the same network problem usually takes the shard down with it.
	useEffect(() => {
		let active = true;
		setDoll(undefined);
		loadDollDetails(id).then(
			(found) => active && setDoll(found ? { ...found, selected: found.normal } : null),
			() => active && setDoll("failed")
		);
		return () => {
			active = false;
		};
	}, [id, attempt]);

	// The Spine index loads on its own, so the page renders as soon as the doll does. When it fails the page simply has no chibi.
	useEffect(() => {
		let active = true;
		setSpine(undefined);
		loadSpineRigs(id).then(
			(entry) => active && setSpine(entry ?? null),
			() => active && setSpine(null)
		);
		return () => {
			active = false;
		};
	}, [id, attempt]);

	if (doll === null) {
		return <NotFound404 message={`There is no T-Doll with the id ${rawId}.`} />;
	}

	if (doll === "failed") {
		return (
			<Box component="main">
				<LoadError what="this T-Doll" onRetry={retry} titleComponent="h1" />
			</Box>
		);
	}

	if (doll === undefined) {
		return (
			<Box component="main" sx={{ py: 3 }}>
				<Typography component="h1" variant="h5" align="center" color="textPrimary">
					Loading T-Doll...
				</Typography>
			</Box>
		);
	}

	// Keyed by id so switching dolls remounts rather than reusing stale state.
	return <TDollContent key={doll.normal.id} doll={doll} spine={spine} />;
}

/** Props for TDollContent. */
interface TDollContentProps {
	/** The doll to render, already loaded. */
	doll: DisplayTDoll;
	/** The doll's Spine rigs: undefined while loading, null when there are none or they could not load. */
	spine: SpineDollEntry | null | undefined;
}

/**
 * The doll page itself.
 *
 * @param props Component props.
 * @returns The doll's stats, skills, tiles, art and animations.
 */
function TDollContent({ doll, spine }: TDollContentProps) {
	const tdoll = doll;
	const [searchParams, setSearchParams] = useSearchParams();

	// The skin, Mod and damaged art the page opens on, from the query string. That is how closing the art viewer or
	// reloading comes back to the same art. The doll object is a per-mount copy, so setting its form here is safe.
	const [initial] = useState(() => {
		const selection = readSelection(searchParams, tdoll);
		tdoll.selected = selection.mod && tdoll.mod ? tdoll.mod : tdoll.normal;
		return selection;
	});

	///////////////////////////////////////////////////////////////////////////////////////////
	// Initialization of States
	///////////////////////////////////////////////////////////////////////////////////////////

	// Set initial states for the Normal/Mod modes.
	const [hasMod] = useState(tdoll.mod !== null);
	const [mode, setMode] = useState(initial.mod ? 1 : 0); // 0 for Normal, 1 for MOD.

	// Set initial states for the images.
	const [switchImage, setSwitchImage] = useState(initial.damaged); // If true, show Damaged version.
	// The key of the skin on screen, or null for the base art.
	const [skinKey, setSkinKey] = useState(initial.skin);

	// Whether the doll's Mod is currently the form on screen, which SkillsPanel uses to show Skill 2.
	const [showModSkill, setShowModSkill] = useState(initial.mod);

	// Owned here rather than in SkillsPanel so the whole page's selection state sits in one place,
	// alongside the Mod and skin state the hero drives.
	const [skillLevel, setSkillLevel] = useState(10);
	const [selectedSkill, setSelectedSkill] = useState(0); // 0 for Skill 1, 1 for Skill 2 if the doll has a Mod.

	// Which animation source the Animations card shows: the battle rig, the dorm rig, or the skin's Live2D model.
	const [chibiMode, setChibiMode] = useState<ChibiMode>("battle");

	// The doll's published Live2D forms, for the Animations card's Live2D toggle option. Null before the load
	// settles, undefined once resolved with no T-Doll skin Live2D models at all.
	const live2dForms = useSkinLive2dForms(tdoll.normal.id);

	///////////////////////////////////////////////////////////////////////////////////////////
	// useEffect and helper functions
	///////////////////////////////////////////////////////////////////////////////////////////

	/* eslint-disable */
	// Set HTML meta-data here using document API.
	useEffect(() => {
		document.title = `#${tdoll.normal.id} - ${tdoll.normal.name}`;
		document.querySelector('meta[name="description"]')?.setAttribute("content", `#${tdoll.normal.id} - ${tdoll.normal.name}`);
	}, [tdoll]);

	// Spine replaces the animation GIFs entirely. The combat and dorm rigs are separate skeletons, and
	// the dorm one often shares the combat atlas, which is why the index records the pair explicitly.
	const spineEntry = spine ?? undefined;
	// The Animations card is kept while the index loads, so the layout does not jump on the usual fast load, and dropped once there is
	// nothing to show.
	const showAnimations = spine !== null;

	const selectedSkinRigs = skinKey === null ? null : (spineEntry?.skins?.[skinKey] ?? null);
	// A Mod doll is a different chibi with its own animations, so the base rig cannot stand in for it.
	const modRigs = mode === 1 ? spineEntry?.mod : undefined;
	// A skin wins over the Mod rigs, since skins have no Mod rigs and the game shows the skin's own chibi
	// either way. A skin with no rig published falls back to the doll's own rigs rather than showing nothing.
	const rigs = selectedSkinRigs ?? modRigs ?? spineEntry;
	const spineRig = chibiMode === "dorm" ? (rigs?.dorm ?? rigs?.combat) : rigs?.combat;

	// The skin's resolved assets, from the manifest-derived form keyed `skin-<skinKey>`. Undefined when no skin is on screen or it has no art.
	const skinAssets = skinKey === null ? undefined : tdoll.forms[skinFormKey(skinKey)];

	// The portrait follows the selection. The Mod wearing a skin shows the skin's Mod-coloured card when it has one, else the skin's own
	// card, and a skin without hosted art falls back to the form's own portrait.
	const cardKind = switchImage ? "card_damaged" : "card";
	const tdollImage = (mode === 1 ? skinAssets?.modImages?.[cardKind] : undefined) ?? skinAssets?.images[cardKind] ?? tdoll.selected.assets.images[cardKind];

	// Keep the query string in step with the selection. Replacing rather than pushing means Back still leaves the page
	// instead of stepping through every skin clicked.
	useEffect(() => {
		const next = new URLSearchParams(searchParams);
		writeSelection(next, { mod: mode === 1, skin: skinKey, damaged: switchImage });
		if (next.toString() !== searchParams.toString()) {
			setSearchParams(next, { replace: true });
		}
	}, [mode, skinKey, switchImage, searchParams, setSearchParams]);

	// Whether the form currently on screen is the Mod. Drives both the rarity star colour and the
	// hero's Mod toggle, which stay in lockstep since they describe the same underlying state.
	const isModForm = tdoll.selected === tdoll.mod;

	// The Mod's spec sheet is null when it matches the base form's, so the base sheet stands in.
	const specs = (isModForm ? tdoll.specs.mod : null) ?? tdoll.specs.normal;

	// The Live2D key for the selection on screen, matching `skinLive2dModelUrl`'s own key scheme: `mod` only while
	// the Mod form is showing, and `base` for the base form's own skin slot when no skin is selected.
	const live2dForm = isModForm ? "mod" : "base";
	const live2dSkinKey = skinKey ?? "base";
	// The variants this exact form/skin actually has, such as ["normal"] or ["normal", "damaged"]. Passed to ChibiPanel so it can
	// resolve its own variant synchronously in render, instead of loading motions first to find out what exists.
	const live2dVariants = useMemo(() => live2dForms?.[live2dForm]?.[live2dSkinKey] ?? [], [live2dForms, live2dForm, live2dSkinKey]);
	const hasLive2d = live2dVariants.length > 0;

	// Falls back to Battle when the selection no longer has a Live2D model, such as switching to a skin with none
	// while Live2D is open. Effect-driven, rather than derived straight from hasLive2d during render, so returning
	// to a skin that does have a model leaves Live2D chosen again instead of the fallback sticking.
	useEffect(() => {
		if (!hasLive2d) {
			setChibiMode((current) => (current === "live2d" ? "battle" : current));
		}
	}, [hasLive2d]);

	// The backdrop's full art follows the same selection as the card portrait: the current skin when one is
	// shown, otherwise the Normal/Mod form, and the damaged version whenever the portrait has been flipped to
	// it. A skin worn by the Mod has only cards of its own, so the skin's full art stands in. The base Normal form
	// stands in when the selected form has no art at all. A form missing only its damaged art keeps its own
	// undamaged art rather than borrowing another outfit's.
	const artKind = switchImage ? "full_damaged" : "full";
	const artImages = skinKey !== null ? skinAssets?.images : tdoll.selected.assets.images;
	const heroArtUrl = artImages?.[artKind] ?? artImages?.full ?? tdoll.normal.assets.images[artKind] ?? tdoll.normal.assets.images.full;

	// The art viewer opens on the outfit on screen. A skin worn by the Mod has no full art of its own, so it opens on the
	// skin's full art, which is the same outfit, with `mod=1` so closing a pasted link comes back to the Mod.
	const artForm = skinKey !== null ? skinFormKey(skinKey) : isModForm ? "mod" : "normal";
	const artLink = `/tdoll/${tdoll.normal.id}/art?form=${artForm}${isModForm && skinKey !== null ? "&mod=1" : ""}${switchImage ? "&damaged=1" : ""}`;
	// New dolls and many upstream Mods arrive before their art is hosted. The viewer link is hidden when the outfit on screen has
	// no full art, rather than opening onto a different outfit.
	const hasFullArt = Boolean(tdoll.forms[artForm]?.images[artKind]);

	// Every handler below is wrapped in useCallback. The panels they are passed to are memoised, and a handler
	// recreated on each render would make every panel re-render on every change, whether or not it changed.

	///////////////////////////////////////////////////////////////////////////////////////////
	// Functions for switching between modes, like Mod or Dorm.
	///////////////////////////////////////////////////////////////////////////////////////////

	// Switch information/images/animations displayed between Normal or Mod. Will reset skin selected.
	const switchModes = useCallback(() => {
		const tdoll_temp = tdoll;

		setSkinKey(null); // Prevent skin image to be rendered if it was selected.

		// Perform check to see if the information shown should be Mod or not.
		if (mode === 0 && hasMod && tdoll.mod) {
			// Switch to Mod information.
			tdoll_temp.selected = tdoll.mod;
			setShowModSkill(true);
			setMode(1);
		} else {
			// Switch to Normal information.
			tdoll_temp.selected = tdoll.normal;
			setShowModSkill(false);
			setMode(0);
		}

		setSwitchImage(false); // Prevents duplicate click bug on the Card component.

		// Reset back to Skill 1 whenever the Mod toggle flips, in either direction.
		setSelectedSkill(0);
	}, [tdoll, mode, hasMod]);

	///////////////////////////////////////////////////////////////////////////////////////////
	// Functions for Card images
	///////////////////////////////////////////////////////////////////////////////////////////

	// Flip the portrait and backdrop between the normal and damaged art.
	const switchBetweenNormalDamagedCardImages = useCallback(() => setSwitchImage((current) => !current), []);

	// Switch back to base art for the current mode, undoing a skin selection. Leaves Normal/Mod alone,
	// since the Mod toggle already owns that axis. This only clears the skin one, the inverse of switchSkinSelected below.
	const switchToBaseArt = useCallback(() => {
		setSkinKey(null);
		setSwitchImage(false); // Prevents duplicate click bug on the Card component.
	}, []);

	// Show the skin whose pill was clicked, or go back to the base art when the Base pill's false arrives.
	const switchSkinSelected = useCallback(
		(_event: unknown, newValue: string | false) => {
			if (newValue === false) {
				switchToBaseArt();
				return;
			}

			setSkinKey(newValue);
			setSwitchImage(false); // Prevents duplicate click bug on the Card component.
		},
		[switchToBaseArt]
	);

	return (
		<main>
			<PageBackdrop artUrl={heroArtUrl} />
			<ScrollToTop />
			<Container sx={styles.page} maxWidth={false}>
				{/************** Every section on the page at once. From a medium screen up the animations share the hero's
				                row and Stats and Abilities sit below it, so a 1920x1080 screen shows the whole page. On a phone
				                everything stacks, with the animations last since they are the heaviest to load. **************/}
				<Grid container spacing={2}>
					{/************** T-Doll's hero: portrait, name, rarity, type, skin pills, Mod toggle, profile and spec sheet **************/}
					{/* Without the Animations card the hero takes the whole first row, so Stats and Abilities still pair up below it. */}
					<Grid size={showAnimations ? { xs: 12, md: 7, lg: 8, xl: 9 } : { xs: 12 }} sx={{ order: 0 }}>
						<DollHero
							name={tdoll.selected.name}
							id={tdoll.selected.id}
							type={tdoll.selected.type}
							rarity={tdoll.selected.rarity}
							isMod={isModForm}
							cardImage={tdollImage}
							onCardImageClick={switchBetweenNormalDamagedCardImages}
							artLink={artLink}
							hasFullArt={hasFullArt}
							skins={tdoll.skins}
							skinValue={skinKey ?? false}
							onSkinChange={switchSkinSelected}
							hasMod={hasMod}
							modOn={isModForm}
							onToggleMod={switchModes}
							profile={tdoll.profile}
							specs={specs}
							production={tdoll.production}
						/>
					</Grid>
					{/* Stats shares its small-screen row with the Animations card, so it takes the full row when that card is absent. */}
					<Grid size={{ xs: 12, sm: showAnimations ? 6 : 12, md: 5, lg: 4 }} sx={{ order: { xs: 1, md: 2 } }}>
						<Paper sx={[styles.section, styles.rowSection]} variant="outlined">
							<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
								Stats
							</Typography>
							{/* Keyed by doll so moving to another doll starts on the stat table rather than a view it may not have. */}
							<StatsPanel key={tdoll.normal.id} stats={tdoll.selected} exclusiveEquipment={tdoll.exclusiveEquipment} />
						</Paper>
					</Grid>

					{/************** Skill and tile buffs in one card. They are both what the doll does in a fight, and
					                apart they left the tile buffs as a mostly empty card in a row of taller ones. **************/}
					<Grid size={{ xs: 12, md: 7, lg: 8 }} sx={{ order: { xs: 2, sm: 3 } }}>
						<Paper sx={[styles.section, styles.rowSection]} variant="outlined">
							<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
								Abilities
							</Typography>
							<Box sx={styles.abilities}>
								<Box sx={[styles.abilityPart, { flex: { lg: "1 1 auto" } }]}>
									<Typography variant="subtitle2" component="h3" color="textSecondary" sx={styles.abilityHeading}>
										Skill
									</Typography>
									<SkillsPanel
										showModSkill={showModSkill}
										selectedSkill={selectedSkill}
										onSelectedSkillChange={setSelectedSkill}
										skillLevel={skillLevel}
										onSkillLevelChange={setSkillLevel}
										skill={tdoll.selected.skill}
										skill2={tdoll.selected.skill2}
										skill1Description={tdoll.selected.skill.description}
										modSkill2Description={tdoll.mod?.skill2?.description}
										dollId={tdoll.selected.id}
										skillImages={tdoll.skillImages}
										skill1Mentions={tdoll.selected.skill.equipmentMentions}
										modSkill2Mentions={tdoll.mod?.skill2?.equipmentMentions}
										exclusiveEquipment={tdoll.exclusiveEquipment}
									/>
								</Box>
								<Box sx={[styles.abilityPart, { flex: { lg: "0 0 300px" } }]}>
									<Typography variant="subtitle2" component="h3" color="textSecondary" sx={styles.abilityHeading}>
										Tile buffs
									</Typography>
									<TilesPanel tileSet={tdoll.selected.tile_set} />
								</Box>
							</Box>
						</Paper>
					</Grid>

					{showAnimations ? (
						<Grid size={{ xs: 12, sm: 6, md: 5, lg: 4, xl: 3 }} sx={{ order: { xs: 3, sm: 2, md: 1 } }}>
							<Paper sx={styles.section} variant="outlined">
								<Typography variant="h6" component="h2" sx={styles.sectionHeading}>
									Animations
								</Typography>
								<Box sx={styles.chibiColumn}>
									<LazySection minHeight={320}>
										<ChibiPanel
											mode={chibiMode}
											onSelectMode={setChibiMode}
											spineRig={spineRig}
											normalId={tdoll.normal.id}
											live2dForm={live2dForm}
											live2dSkinKey={live2dSkinKey}
											live2dVariants={live2dVariants}
											hasLive2d={hasLive2d}
										/>
									</LazySection>
								</Box>
							</Paper>
						</Grid>
					) : null}
				</Grid>
			</Container>
		</main>
	);
}
