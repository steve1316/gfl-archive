/**
 * Loads and drives the vendored Spine 2.1 runtime.
 *
 * The game ships Spine 2.1 skeletons and no maintained web runtime reads them, so `public/vendor/spine`
 * carries a frozen copy of PixiJS 4 plus a Girls' Frontline patched pixi-spine. See the README there.
 *
 * The runtime is plain UMD that expects to be loaded through script tags and to find its globals on
 * `window`, so it is injected on demand rather than imported. Nothing here runs until a doll page
 * actually wants an animation, which keeps 1.5 MB of vendor code off every other route.
 */

import type { StageRuntime } from "archive-kit";

import { claimPixiGlobal, withLoadLock } from "./pixiRuntimeLock";

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Runtime loading

/** Script filenames, in the order they must load. */
const RUNTIME_SCRIPTS = ["pixi.js", "pixi-spine-sjzs.js", "skb.js"];

/** Shared across callers so the 1.5 MB runtime is fetched at most once per session. */
let runtimePromise: Promise<void> | undefined;

/**
 * The Spine runtime's own `PIXI` (v4, with `.spine` attached), captured the moment its scripts finish loading. `lib/live2d.ts`
 * loads a different major version of PixiJS onto the same `window.PIXI` global, so while its scripts are loading,
 * `window.PIXI` points at that other runtime instead. This capture lets callers re-point the global back via `claimPixiGlobal`
 * before they run: the vendored `pixi-spine-sjzs.js` reads the bare global `PIXI` identifier inside some of its own methods
 * (such as `Spine.createMesh`), not a value closed over at load time, so a stale `window.PIXI` breaks it even when this
 * module's own calls use the captured reference directly. The claim happens inside `loadSkeletonData`, and again after every
 * `await` in its callers, since Live2D's loader can repoint the global while a caller is suspended waiting on a fetch.
 */
let spinePixi: unknown;

/**
 * The Spine runtime's own `PIXI`, captured when its scripts loaded. Callers must use this rather than `window.PIXI`, which may point at Live2D's
 * PixiJS after a Live2D page was visited in the same session.
 *
 * @returns The captured `PIXI`, or undefined before `loadSpineRuntime` has settled.
 */
export function spineRuntimePixi(): unknown {
	return spinePixi;
}

/**
 * Inject one script and wait for it.
 *
 * @param src URL to load.
 * @returns A promise that settles when the script has run.
 */
function loadScript(src: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const script = document.createElement("script");
		script.src = src;
		script.async = false;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error(`failed to load ${src}`));
		document.head.appendChild(script);
	});
}

/**
 * Load the Spine runtime, once.
 *
 * @returns A promise that settles when `PIXI.spine` and `SkeletonBinary` are available.
 */
export function loadSpineRuntime(): Promise<void> {
	if (runtimePromise) {
		return runtimePromise;
	}

	// These four must exist before pixi.js evaluates or it throws a ReferenceError on load. Only the
	// first three appear in naganeko's own HTML. `enable_clear_fail_step` is never assigned anywhere in
	// that project and gates whether flipX/flipY timelines are built, so it has to be falsy.
	const globals = window as unknown as Record<string, unknown>;
	globals.test_PMA_base = true;
	globals.test_PMA_Texture = false;
	globals.test_PMA_glstore = true;
	globals.enable_clear_fail_step = false;

	const base = `${import.meta.env.BASE_URL}vendor/spine/`;
	// Queued behind `withLoadLock` so a concurrent first load of the Live2D runtime cannot interleave its scripts
	// with these: see `pixiRuntimeLock.ts` for why that would attach `.spine` to the wrong `PIXI` object.
	runtimePromise = withLoadLock(() =>
		RUNTIME_SCRIPTS.reduce((chain, name) => chain.then(() => loadScript(`${base}${name}`)), Promise.resolve()).then(() => {
			spinePixi = (window as unknown as { PIXI: unknown }).PIXI;
		})
	);
	return runtimePromise;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Animation names

/**
 * Alternative names a skeleton may use for the same animation.
 *
 * The GIF filenames and the skeletons do not always agree. Sixty-eight dolls call their skill
 * animation `s`, against three that spell it out, and a handful use the game's internal names for
 * special attacks. Resolving through this table is what keeps a tab from doing nothing when clicked.
 */
const ANIMATION_ALIASES: Record<string, string[]> = {
	skill: ["skill", "s"],
	skill2: ["skill2", "s2"],
	crouch: ["crouch", "squat"],
	spattack: ["spattack", "spa", "sp1", "sp"],
	spattack2: ["spattack2", "spc", "sp2"],
	attack2: ["attack2", "attack1"],
	reload: ["reload", "squatreload"]
};

/**
 * Find the name a skeleton actually uses for a requested animation.
 *
 * @param available Animation names the skeleton defines.
 * @param name The name the UI asked for.
 * @returns The matching skeleton animation name, or undefined when it has none.
 */
export function resolveAnimation(available: readonly string[], name: string): string | undefined {
	for (const candidate of ANIMATION_ALIASES[name] ?? [name]) {
		if (available.includes(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Human-readable labels for skeleton animation names.
 *
 * Several names are the game's internal ones rather than anything a reader would recognise, and a few
 * skeletons carry animations the GIF era never exposed at all, such as the RF `snipe` pose. The enemy rigs
 * add a second set of internal names of their own: numbered skills, several death poses, and the dorm
 * poses the capturable Sangvis units keep inside their combat rig.
 */
const ANIMATION_LABELS: Record<string, string> = {
	wait: "Wait",
	wait2: "Wait 2",
	move: "Move",
	attack: "Attack",
	attack1: "Attack",
	attack2: "Attack 2",
	reload: "Reload",
	squatreload: "Reload (Crouched)",
	s: "Skill",
	skill: "Skill",
	skill2: "Skill 2",
	crouch: "Crouch",
	squat: "Crouch",
	snipe: "Snipe",
	action: "Action",
	action1: "Action",
	action2: "Action 2",
	spattack: "Special Attack",
	spattack2: "Special Attack 2",
	spa: "Special Attack",
	spc: "Special Attack 2",
	sp: "Special",
	sp1: "Special 1",
	sp2: "Special 2",
	s1: "Skill 1",
	skill1: "Skill 1",
	s2: "Skill 2",
	s3: "Skill 3",
	skill3: "Skill 3",
	s4: "Skill 4",
	skill4: "Skill 4",
	sp3: "Special 3",
	bossskill: "Boss Skill",
	bossskillactive: "Boss Skill (Active)",
	skillready: "Skill (Ready)",
	changemode: "Change Mode",
	freeze: "Freeze",
	landing: "Landing",
	die: "Die",
	die1: "Die",
	die2: "Die 2",
	die3: "Die 3",
	r_wait: "Idle",
	r_move: "Walk",
	victory: "Victory",
	victory2: "Victory 2",
	victoryloop: "Victory Loop",
	pick: "Pick",
	sit: "Sit",
	sit2: "Sit 2",
	lying: "Lying",
	violin: "Violin",
	book: "Book",
	therun2: "Run"
};

/** Preferred tab order. Anything not listed keeps its relative order and follows these. */
const ANIMATION_ORDER = [
	"wait",
	"wait2",
	"move",
	"attack",
	"attack1",
	"attack2",
	"snipe",
	"reload",
	"squatreload",
	"s",
	"skill",
	"s1",
	"skill1",
	"s2",
	"skill2",
	"s3",
	"skill3",
	"s4",
	"skill4",
	"crouch",
	"squat",
	"action",
	"action1",
	"action2",
	"spattack",
	"spa",
	"spattack2",
	"spc",
	"sp",
	"sp1",
	"sp2",
	"sp3",
	"bossskill",
	"bossskillactive",
	"skillready",
	"changemode",
	"freeze",
	"landing",
	"die",
	"die1",
	"die2",
	"die3",
	"victory",
	"victory2",
	"victoryloop",
	"r_wait",
	"r_move",
	"pick",
	"sit",
	"sit2",
	"lying"
];

/** One animation tab: the skeleton's own name, and what to show for it. */
export interface AnimationTab {
	/** The skeleton's animation name, used verbatim to play it. */
	value: string;
	/** Label for the tab. */
	label: string;
}

/**
 * Build the tab list for a skeleton.
 *
 * Every animation the skeleton defines gets a tab. Deriving the list from a fixed set instead left
 * real animations unreachable: `snipe` on nine rifles, and the dorm poses on three dolls that keep
 * them inside the combat rig rather than a separate one.
 *
 * @param available Animation names the skeleton defines.
 * @returns Tabs in a stable, readable order.
 */
export function animationTabs(available: readonly string[]): AnimationTab[] {
	const rank = (name: string) => {
		const index = ANIMATION_ORDER.indexOf(name);
		return index === -1 ? ANIMATION_ORDER.length : index;
	};
	return [...available]
		.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
		.map((value) => ({
			value,
			// Unknown names are shown as-is rather than hidden, so nothing is silently unreachable.
			label: ANIMATION_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1)
		}));
}

/**
 * The animation after the current one in a tab list, wrapping back to the first. Shared by the doll and HOC players, whose stage
 * advances on click in the same order the pills are drawn.
 *
 * @param tabs The tabs, in display order.
 * @param current The animation playing now.
 * @returns The next tab's animation, or undefined when there are no tabs.
 */
export function nextAnimationValue(tabs: readonly AnimationTab[], current: string): string | undefined {
	const index = tabs.findIndex((tab) => tab.value === current);
	return tabs[index === -1 || index + 1 >= tabs.length ? 0 : index + 1]?.value;
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Player

/** A mounted Spine animation, and the handles needed to drive or dispose of it. */
export interface SpinePlayer {
	/** Animation names this skeleton defines. */
	animations: string[];
	/** Play one animation by name, looping. Unknown names are ignored. */
	play: (name: string) => void;
	/** Resize the square stage and refit the skeleton inside it. */
	resize: (size: number) => void;
	/** Tear down the renderer and free its WebGL context. */
	destroy: () => void;
}

/** What `createSpinePlayer` needs to build a skeleton. */
export interface SpinePlayerOptions {
	/** Element to mount the canvas into. */
	container: HTMLElement;
	/** URL of the binary `.skel`. */
	skelUrl: string;
	/** URL of the `.atlas`. */
	atlasUrl: string;
	/** Directory the atlas's page images sit in, with a trailing slash. */
	imageBase: string;
	/** Canvas size in CSS pixels. */
	size?: number;
	/**
	 * Device pixels per CSS pixel for the canvas backing store.
	 *
	 * Pixi defaults this to 1, which on a 2.8125 ratio phone renders a 250x250 canvas and lets the
	 * compositor stretch it across 703x703 physical pixels. The texture is still the game's own 256px
	 * atlas, so this buys sharp edges and clean motion rather than new detail.
	 */
	resolution?: number;
	/** Animation to start with. */
	initialAnimation?: string;
}

/**
 * Load the runtime and parse one skeleton with its atlas.
 *
 * @param skelUrl URL of the binary `.skel`.
 * @param atlasUrl URL of the `.atlas`.
 * @param imageBase Directory the atlas's page images sit in, with a trailing slash.
 * @returns This runtime's `PIXI` and the parsed skeleton data.
 */
export async function loadSkeletonData(skelUrl: string, atlasUrl: string, imageBase: string): Promise<{ PIXI: any; skeletonData: any }> {
	await loadSpineRuntime();
	// Re-point the global at this runtime's own PIXI before touching it: see `spinePixi`'s docstring for why.
	claimPixiGlobal(spinePixi);
	const PIXI = spinePixi as any;
	const SkeletonBinary = (window as unknown as { SkeletonBinary: any }).SkeletonBinary;
	const runtime = PIXI.spine.SpineRuntime;

	const [skelBuffer, atlasText] = await Promise.all([fetch(skelUrl).then((response) => response.arrayBuffer()), fetch(atlasUrl).then((response) => response.text())]);
	// Re-claim after the fetch await: Live2D's loader or teardown could have repointed the global while this was suspended.
	claimPixiGlobal(spinePixi);

	// The .skel is Spine's binary format; skb.js converts it to the JSON the runtime parses.
	const binary = new SkeletonBinary();
	binary.data = new Uint8Array(skelBuffer);
	binary.scale = 1;
	binary.initJson();

	// The loader middleware does not fire for an in-memory skeleton, so the atlas chain is built by hand.
	//
	// The runtime's own `syncImageLoaderAdapter` cannot be used here: it accepts a baseUrl, carefully
	// appends a trailing slash to it, and then never reads it again, calling
	// `BaseTexture.fromImage(line)` with the bare filename from the atlas. Pages served from the same
	// directory as their images never notice. Ours are on a different host, so the texture resolved
	// against the page and 404'd, leaving a skeleton that posed and animated correctly while drawing
	// nothing at all.
	//
	// crossOrigin matters for the same reason: WebGL refuses to upload a texture from an image that was
	// not fetched in CORS mode. The asset host sends `access-control-allow-origin: *`.
	//
	// Each load gets its own base texture rather than one from `Texture.fromImage`, whose cache is keyed by URL. Two players showing the
	// same doll, such as the formation stage and its settings preview, would otherwise share one, and the first to be destroyed would
	// destroy it under the other, which then throws on every frame.
	const loadPage = (line: string, callback: (texture: unknown) => void) => {
		const image = new Image();
		image.crossOrigin = "anonymous";
		image.src = `${imageBase}${line}`;
		callback(new PIXI.BaseTexture(image));
	};
	const atlas = new runtime.Atlas(atlasText, loadPage, () => {});
	const skeletonData = new runtime.SkeletonJsonParser(new runtime.AtlasAttachmentParser(atlas)).readSkeletonData(binary.json);
	return { PIXI, skeletonData };
}

/**
 * Build a Spine player and mount it.
 *
 * @param options Where to mount and what to load.
 * @returns The mounted player.
 */
export async function createSpinePlayer(options: SpinePlayerOptions): Promise<SpinePlayer> {
	const { PIXI, skeletonData } = await loadSkeletonData(options.skelUrl, options.atlasUrl, options.imageBase);
	// Re-claim after the await: Live2D's loader or teardown could have repointed the global while this was suspended.
	claimPixiGlobal(PIXI);
	const size = options.size ?? 250;

	// Clamped, because fill cost grows with the square of this and there is nothing to gain past 3x.
	const resolution = Math.min(options.resolution ?? 1, 3);
	const app = new PIXI.Application(size, size, { backgroundColor: 0x000000, transparent: true, antialias: true, resolution, autoResize: true });
	options.container.appendChild(app.view);
	// Tracked so a resize can refit whichever animation is currently playing without the caller
	// having to remember and re-pass it.
	let currentSize = size;
	let currentAnimation: { duration: number; apply: (...args: unknown[]) => void } | undefined;

	const spine = new PIXI.spine.Spine(skeletonData);
	app.stage.addChild(spine);

	/**
	 * Widen a box to include every bone that is drawing something at the skeleton's current pose.
	 *
	 * Framing used to include every bone. Some rigs carry effect bones with nothing attached for most of an
	 * animation: Agent 416's Defender of Manhattan skin parks `eff_slight01` at x=484 against a body about 75
	 * wide, so the frame stretched to reach empty space and the chibi came out tiny and shoved to one side.
	 * An effect that is actually showing still counts, because its slot then has an attachment.
	 *
	 * @param box The box to widen, as [minX, maxX, minY, maxY].
	 * @param skeleton The posed skeleton.
	 * @returns Whether any visible bone was found.
	 */
	const addVisibleBones = (box: number[], skeleton: any): boolean => {
		let found = false;
		for (const slot of skeleton.slots) {
			if (slot.attachment && slot.a > 0) {
				box[0] = Math.min(box[0] as number, slot.bone.worldX);
				box[1] = Math.max(box[1] as number, slot.bone.worldX);
				box[2] = Math.min(box[2] as number, slot.bone.worldY);
				box[3] = Math.max(box[3] as number, slot.bone.worldY);
				found = true;
			}
		}
		return found;
	};

	/**
	 * Widen a box to include every bone, the fallback for a pose that draws nothing at all.
	 *
	 * @param box The box to widen, as [minX, maxX, minY, maxY].
	 * @param skeleton The posed skeleton.
	 */
	const addAllBones = (box: number[], skeleton: any) => {
		for (const bone of skeleton.bones) {
			box[0] = Math.min(box[0] as number, bone.worldX);
			box[1] = Math.max(box[1] as number, bone.worldX);
			box[2] = Math.min(box[2] as number, bone.worldY);
			box[3] = Math.max(box[3] as number, bone.worldY);
		}
	};

	// How far the drawn artwork extends past the visible bone positions, measured once from the setup pose.
	// Bones sit inside the silhouette, so fitting to bones alone crops hair, weapons and coat tails.
	let padLeft = 0;
	let padRight = 0;
	let padTop = 0;
	let padBottom = 0;

	{
		const skeleton = spine.skeleton;
		skeleton.setToSetupPose();
		skeleton.updateWorldTransform();
		const box = [Infinity, -Infinity, Infinity, -Infinity];
		if (!addVisibleBones(box, skeleton)) {
			addAllBones(box, skeleton);
		}
		const [minX, maxX, minY, maxY] = box as [number, number, number, number];
		spine.x = 0;
		spine.y = 0;
		spine.scale.set(1);
		app.renderer.render(app.stage);
		const drawn = spine.getLocalBounds();
		padLeft = Math.max(0, minX - drawn.x);
		padRight = Math.max(0, drawn.x + drawn.width - maxX);
		padTop = Math.max(0, minY - drawn.y);
		padBottom = Math.max(0, drawn.y + drawn.height - maxY);
	}

	/**
	 * Position and scale the skeleton so the whole animation stays in frame.
	 *
	 * Not every animation plays in place. Desert Eagle's `victoryloop` translates the rig far enough
	 * left that a sprite pinned at a fixed spot leaves the canvas entirely and the animation looks
	 * broken rather than merely off-centre. The extent is sampled across the whole duration, so the
	 * framing is chosen once and does not drift while it plays.
	 *
	 * @param animation The animation about to play.
	 * @param targetSize Square stage size in CSS pixels to fit within.
	 */
	const fitToAnimation = (animation: { duration: number; apply: (...args: unknown[]) => void }, targetSize: number) => {
		const skeleton = spine.skeleton;
		const steps = 20;
		const visible = [Infinity, -Infinity, Infinity, -Infinity];
		const all = [Infinity, -Infinity, Infinity, -Infinity];

		for (let step = 0; step <= steps; step++) {
			const time = (animation.duration * step) / steps;
			skeleton.setToSetupPose();
			animation.apply(skeleton, time, time, false, []);
			skeleton.updateWorldTransform();
			addVisibleBones(visible, skeleton);
			addAllBones(all, skeleton);
		}

		let [minX, maxX, minY, maxY] = (Number.isFinite(visible[0]) ? visible : all) as [number, number, number, number];
		if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
			return;
		}

		// A little breathing room on top of the measured artwork so nothing grazes the edge.
		const breathing = targetSize * 0.04;
		minX -= padLeft + breathing;
		maxX += padRight + breathing;
		minY -= padTop + breathing;
		maxY += padBottom + breathing;

		// Never enlarge, only shrink to fit. Scaling a chibi up looks worse than leaving it small.
		const fit = Math.min(targetSize / (maxX - minX), targetSize / (maxY - minY), 1);
		spine.scale.set(fit);
		// pixi-spine already flips the Y axis, so these bone coordinates share Pixi's orientation and
		// both axes centre the same way. Adding on Y instead pushes the skeleton off the top.
		spine.x = targetSize / 2 - ((minX + maxX) / 2) * fit;
		spine.y = targetSize / 2 - ((minY + maxY) / 2) * fit;
	};

	/**
	 * Refit whichever animation is currently playing to a stage size.
	 *
	 * @param targetSize Square stage size in CSS pixels to fit within.
	 */
	const fit = (targetSize: number) => {
		currentSize = targetSize;
		if (currentAnimation) {
			fitToAnimation(currentAnimation, targetSize);
		}
	};

	const animations: string[] = skeletonData.animations.map((animation: { name: string }) => animation.name);

	/**
	 * Play an animation by name.
	 *
	 * @param name The animation to play.
	 */
	const play = (name: string) => {
		// This runtime's setAnimation takes an Animation object, not a name. Passing a string fails at
		// the first tick with "current.animation.apply is not a function".
		const animation = skeletonData.findAnimation(resolveAnimation(animations, name) ?? name);
		if (animation) {
			currentAnimation = animation;
			fitToAnimation(animation, currentSize);
			spine.state.setAnimation(0, animation, true);
		}
	};

	/**
	 * Resize the stage and refit the skeleton.
	 *
	 * @param next New square size in CSS pixels.
	 */
	const resize = (next: number) => {
		if (next <= 0) {
			return;
		}
		app.renderer.resize(next, next);
		fit(next);
	};

	const first = options.initialAnimation && animations.includes(options.initialAnimation) ? options.initialAnimation : animations[0];
	if (first) {
		play(first);
	}

	return {
		animations,
		play,
		resize,
		destroy: () => {
			app.destroy(true, { children: true, texture: true, baseTexture: true });
		}
	};
}

// //////////////////////////////////////////////////////////////////////////////////////////////////
// //////////////////////////////////////////////////////////////////////////////////////////////////
// Stage runtime

/** An animation from parsed skeleton data, narrowed to what framing uses. */
interface SkeletonAnimation {
	/** Length in seconds. */
	duration: number;
	/** Poses a skeleton at a time: `(skeleton, lastTime, time, loop, events)`. */
	apply: (...args: unknown[]) => void;
}

/** How far the drawn artwork reaches past the visible bones on each side, measured once per skeleton from its setup pose. */
interface ArtPadding {
	/** Beyond the leftmost visible bone. */
	left: number;
	/** Beyond the rightmost visible bone. */
	right: number;
	/** Beyond the topmost visible bone. */
	top: number;
	/** Beyond the bottommost visible bone. */
	bottom: number;
}

/** What archive-kit's stage loads on this site: one rig's files. */
export interface SpineSource {
	/** URL of the binary `.skel`. */
	skelUrl: string;
	/** URL of the `.atlas`. */
	atlasUrl: string;
	/** Directory the atlas's page images sit in, with a trailing slash. */
	imageBase: string;
}

/**
 * Widen a box to include every bone that is drawing something at the skeleton's current pose. Effect bones with nothing attached stay out, or
 * a rig like Agent 416's Defender of Manhattan skin frames empty space and the chibi comes out tiny.
 *
 * @param box The box to widen, as [minX, maxX, minY, maxY].
 * @param skeleton The posed skeleton.
 * @returns Whether any visible bone was found.
 */
function widenToVisibleBones(box: number[], skeleton: any): boolean {
	let found = false;
	for (const slot of skeleton.slots) {
		if (slot.attachment && slot.a > 0) {
			box[0] = Math.min(box[0] as number, slot.bone.worldX);
			box[1] = Math.max(box[1] as number, slot.bone.worldX);
			box[2] = Math.min(box[2] as number, slot.bone.worldY);
			box[3] = Math.max(box[3] as number, slot.bone.worldY);
			found = true;
		}
	}
	return found;
}

/**
 * Widen a box to include every bone, the fallback for a pose that draws nothing at all.
 *
 * @param box The box to widen, as [minX, maxX, minY, maxY].
 * @param skeleton The posed skeleton.
 */
function widenToAllBones(box: number[], skeleton: any): void {
	for (const bone of skeleton.bones) {
		box[0] = Math.min(box[0] as number, bone.worldX);
		box[1] = Math.max(box[1] as number, bone.worldX);
		box[2] = Math.min(box[2] as number, bone.worldY);
		box[3] = Math.max(box[3] as number, bone.worldY);
	}
}

/**
 * Measure how far the drawn artwork extends past the visible bones, from the setup pose. Bones sit inside the silhouette, so fitting to bones
 * alone crops hair, weapons and coat tails.
 *
 * @param app The PixiJS application the skeleton is on, rendered once to measure.
 * @param spine The pixi-spine display object.
 * @returns The padding on each side.
 */
function measurePadding(app: any, spine: any): ArtPadding {
	const skeleton = spine.skeleton;
	skeleton.setToSetupPose();
	skeleton.updateWorldTransform();
	const box = [Infinity, -Infinity, Infinity, -Infinity];
	if (!widenToVisibleBones(box, skeleton)) {
		widenToAllBones(box, skeleton);
	}
	const [minX, maxX, minY, maxY] = box as [number, number, number, number];
	spine.x = 0;
	spine.y = 0;
	spine.scale.set(1);
	app.renderer.render(app.stage);
	const drawn = spine.getLocalBounds();
	return {
		left: Math.max(0, minX - drawn.x),
		right: Math.max(0, drawn.x + drawn.width - maxX),
		top: Math.max(0, minY - drawn.y),
		bottom: Math.max(0, drawn.y + drawn.height - maxY)
	};
}

/**
 * Position and scale the skeleton so the whole animation stays in frame. The extent is sampled across the whole duration, since some
 * animations walk the rig off its spot, so the framing is chosen once and does not drift while it plays. Never scales up, only down.
 *
 * @param spine The pixi-spine display object.
 * @param animation The animation about to play.
 * @param padding The artwork's reach past the bones.
 * @param width Stage width in CSS pixels.
 * @param height Stage height in CSS pixels.
 */
function fitSkeleton(spine: any, animation: SkeletonAnimation, padding: ArtPadding, width: number, height: number): void {
	const skeleton = spine.skeleton;
	const steps = 20;
	const visible = [Infinity, -Infinity, Infinity, -Infinity];
	const all = [Infinity, -Infinity, Infinity, -Infinity];
	for (let step = 0; step <= steps; step++) {
		const time = (animation.duration * step) / steps;
		skeleton.setToSetupPose();
		animation.apply(skeleton, time, time, false, []);
		skeleton.updateWorldTransform();
		widenToVisibleBones(visible, skeleton);
		widenToAllBones(all, skeleton);
	}
	let [minX, maxX, minY, maxY] = (Number.isFinite(visible[0]) ? visible : all) as [number, number, number, number];
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
		return;
	}
	// A little breathing room on top of the measured artwork so nothing grazes the edge.
	const breathing = Math.min(width, height) * 0.04;
	minX -= padding.left + breathing;
	maxX += padding.right + breathing;
	minY -= padding.top + breathing;
	maxY += padding.bottom + breathing;
	const fit = Math.min(width / (maxX - minX), height / (maxY - minY), 1);
	spine.scale.set(fit);
	// pixi-spine already flips the Y axis, so both axes centre the same way.
	spine.x = width / 2 - ((minX + maxX) / 2) * fit;
	spine.y = height / 2 - ((minY + maxY) / 2) * fit;
}

/**
 * Build a Spine runtime for archive-kit's `AnimationStage` inside `host`. One PixiJS application serves every rig the stage shows, and a new
 * rig swaps the skeleton inside it. Frames come from the stage's own loop through `update` rather than PixiJS's ticker, so the stage can stop
 * them while the chibi is off screen.
 *
 * @param host The element to mount the canvas in.
 * @returns The runtime.
 */
export async function createSpineRuntime(host: HTMLElement): Promise<StageRuntime<SpineSource>> {
	await loadSpineRuntime();
	claimPixiGlobal(spinePixi);
	const PIXI = spinePixi as any;
	let width = Math.max(1, host.clientWidth);
	let height = Math.max(1, host.clientHeight);
	// Clamped, because fill cost grows with the square of this and there is nothing to gain past 3x. Fixed for the stage's lifetime.
	const resolution = Math.min(window.devicePixelRatio || 1, 3);
	const app = new PIXI.Application(width, height, { backgroundColor: 0x000000, transparent: true, antialias: true, resolution, autoResize: true, autoStart: false });
	// The stage handles every pointer itself. Pixi's interaction manager would otherwise poll on the shared ticker every frame, off screen too.
	app.renderer.plugins.interaction?.removeEvents();
	host.appendChild(app.view);

	let spine: any = null;
	let skeletonData: any = null;
	let names: string[] = [];
	let padding: ArtPadding = { left: 0, right: 0, top: 0, bottom: 0 };
	let current: SkeletonAnimation | undefined;

	/**
	 * Play an animation by name, looping, framed for its whole length.
	 *
	 * @param name The animation, or an alias `resolveAnimation` knows.
	 */
	const play = (name: string) => {
		if (!spine || !skeletonData) {
			return;
		}
		// This runtime's setAnimation takes an Animation object, not a name. A string fails at the first tick.
		const animation = skeletonData.findAnimation(resolveAnimation(names, name) ?? name);
		if (animation) {
			current = animation;
			fitSkeleton(spine, animation, padding, width, height);
			spine.state.setAnimation(0, animation, true);
		}
	};

	return {
		async load(source, signal) {
			const loaded = await loadSkeletonData(source.skelUrl, source.atlasUrl, source.imageBase);
			if (signal.aborted) {
				return null;
			}
			// Re-claim after the await: Live2D's loader could have repointed the global meanwhile.
			claimPixiGlobal(spinePixi);
			if (spine) {
				app.stage.removeChild(spine);
				spine.destroy({ children: true, texture: true, baseTexture: true });
			}
			skeletonData = loaded.skeletonData;
			spine = new PIXI.spine.Spine(skeletonData);
			// The stage advances the skeleton through `update`, so pixi-spine's own clock stays off.
			spine.autoUpdate = false;
			app.stage.addChild(spine);
			padding = measurePadding(app, spine);
			names = skeletonData.animations.map((animation: { name: string }) => animation.name);
			current = undefined;
			// Pose something at once, for a stage whose entries name nothing this skeleton defines.
			const first = names[0];
			if (first) {
				play(first);
			}
			return null;
		},
		play,
		resize(nextWidth, nextHeight) {
			width = nextWidth;
			height = nextHeight;
			app.renderer.resize(width, height);
			if (spine && current) {
				fitSkeleton(spine, current, padding, width, height);
			}
		},
		setView(scale, x, y) {
			// A CSS translate then scale about the centre, which is what the stage's zoom describes.
			app.stage.scale.set(scale);
			app.stage.position.set((width / 2) * (1 - scale) + x, (height / 2) * (1 - scale) + y);
		},
		update(seconds) {
			if (!spine) {
				return;
			}
			// Vendored code reads the bare `PIXI` global while it builds meshes, so the global is claimed before every frame.
			claimPixiGlobal(spinePixi);
			spine.update(seconds);
			app.renderer.render(app.stage);
		},
		dispose() {
			app.destroy(true, { children: true, texture: true, baseTexture: true });
			spine = null;
		}
	};
}
