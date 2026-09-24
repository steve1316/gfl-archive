/**
 * Many Spine skeletons on one shared PixiJS 4 canvas, for the formation simulator's stage.
 *
 * One canvas keeps the page to a single WebGL context however many dolls are placed, and lets chibis overlap in isometric depth order.
 */

import { claimPixiGlobal } from "./pixiRuntimeLock";
import { loadSkeletonData, loadSpineRuntime, releasePages, resolveAnimation, spineRuntimePixi } from "./spine";

/** Depth added to a chibi drawn on top, far below any real stage height. */
const ON_TOP_DEPTH = 1e6;

/** Horizontal travel, in CSS pixels, below which a walk keeps the chibi's current facing. */
const MIN_TURN_DISTANCE = 1;

/** Message `addActor` rejects with when the stage was destroyed while a rig loaded, which callers can expect on unmount. */
export const STAGE_DESTROYED_MESSAGE = "spine stage was destroyed";

/** Where one rig's files live. */
export interface SpineRigUrls {
	/** URL of the binary `.skel`. */
	skelUrl: string;
	/** URL of the `.atlas`. */
	atlasUrl: string;
	/** Directory holding the atlas page images, with a trailing slash. */
	imageBase: string;
}

/** One chibi on the stage. */
export interface StageActor {
	/** Animation names the skeleton defines. */
	animations: string[];
	/** Loop an animation by name. Unknown names are ignored. */
	play: (name: string) => void;
	/** Put the chibi's feet at a point, in CSS pixels. */
	setPosition: (x: number, y: number) => void;
	/** Walk the chibi's feet to a point over a duration, facing the way it walks, then face right again and call `onArrive`. */
	moveTo: (x: number, y: number, durationMs: number, onArrive?: () => void) => void;
	/** Scale the chibi. */
	setScale: (scale: number) => void;
	/** Show or hide the chibi. */
	setVisible: (visible: boolean) => void;
	/** Draw the chibi above every other one, such as while it is held, instead of in depth order. */
	setOnTop: (onTop: boolean) => void;
	/** Take the chibi off the stage and free its skeleton. */
	destroy: () => void;
}

/** The shared canvas. */
export interface SpineStage {
	/** Load a rig and add it as an actor at (0, 0). */
	addActor: (rig: SpineRigUrls) => Promise<StageActor>;
	/** Resize the canvas, in CSS pixels. */
	resize: (width: number, height: number) => void;
	/** Stop or restart rendering and animation. */
	setPaused: (paused: boolean) => void;
	/** Tear down the renderer and free its WebGL context. */
	destroy: () => void;
}

/**
 * Create the shared canvas and mount it.
 *
 * @param container Element to mount the canvas into.
 * @param width Canvas width in CSS pixels.
 * @param height Canvas height in CSS pixels.
 * @param resolution Device pixels per CSS pixel, clamped to 3.
 * @returns The stage.
 */
export async function createSpineStage(container: HTMLElement, width: number, height: number, resolution: number): Promise<SpineStage> {
	await loadSpineRuntime();
	const PIXI = spineRuntimePixi() as any;
	claimPixiGlobal(PIXI);
	const app = new PIXI.Application(width, height, { transparent: true, antialias: true, resolution: Math.min(resolution, 3), autoResize: true });
	container.appendChild(app.view);
	let destroyed = false;

	// Set when a chibi's position changes, so the stage sorts once per frame however many chibis moved.
	let depthDirty = false;
	const sortByDepth = () => {
		if (depthDirty) {
			depthDirty = false;
			const depth = (child: { y: number; onTop?: boolean }) => child.y + (child.onTop ? ON_TOP_DEPTH : 0);
			app.stage.children.sort((a: { y: number; onTop?: boolean }, b: { y: number; onTop?: boolean }) => depth(a) - depth(b));
		}
	};
	// Runs after the walk callbacks at normal priority and before the render at low priority, so a moved chibi is drawn in order that frame.
	app.ticker.add(sortByDepth, undefined, PIXI.UPDATE_PRIORITY.LOW + 1);

	const addActor = async (rig: SpineRigUrls): Promise<StageActor> => {
		const { PIXI: runtimePixi, skeletonData, pages } = await loadSkeletonData(rig.skelUrl, rig.atlasUrl, rig.imageBase);
		// Re-claim after the await: Live2D's loader or the stage's own teardown could have repointed the global while this was suspended.
		claimPixiGlobal(runtimePixi);
		const holder = new runtimePixi.Container();
		const spine = new runtimePixi.spine.Spine(skeletonData);
		spine.skeleton.setToSetupPose();
		spine.skeleton.updateWorldTransform();
		holder.addChild(spine);
		// Feet at the holder's origin. GFL combat rigs put the root bone on the ground under the feet, so the skeleton's own origin is
		// already the right anchor. The setup pose's bounds are not: shadows and long guns push their bottom and centre off the feet.
		spine.x = 0;
		spine.y = 0;

		if (destroyed) {
			// The stage went away while this rig was loading. PixiJS 4's Application.destroy nulls app.stage and app.ticker but
			// nothing here checks that, so building on it would throw. Drop what was just built and refuse instead.
			holder.destroy({ children: true, texture: true });
			releasePages(pages);
			throw new Error(STAGE_DESTROYED_MESSAGE);
		}
		app.stage.addChild(holder);

		const animations: string[] = skeletonData.animations.map((animation: { name: string }) => animation.name);
		let walk: ((delta: number) => void) | undefined;
		// Size and facing are kept apart so a resize during a walk keeps the chibi turned the way it walks. 1 faces right, -1 left.
		let size = 1;
		let facing = 1;
		const applyScale = () => holder.scale.set(size * facing, size);
		// True once this actor's own destroy has run, separately from the stage's, so a caller that holds a
		// stale reference after either teardown gets a no-op instead of touching a nulled app.stage/app.ticker.
		let gone = false;

		const stopWalk = () => {
			if (walk) {
				// The stage's own destroy nulls app.ticker before it can run our removal, so only touch it while
				// the stage is still alive. walk is cleared either way so this stays safe to call more than once.
				if (!destroyed) {
					app.ticker.remove(walk);
					// A finished or interrupted walk turns the chibi back to face the front. The holder is already torn down after the stage's destroy.
					facing = 1;
					applyScale();
				}
				walk = undefined;
			}
		};

		return {
			animations,
			play: (name) => {
				if (gone || destroyed) {
					return;
				}
				const animation = skeletonData.findAnimation(resolveAnimation(animations, name) ?? name);
				if (animation) {
					spine.state.setAnimation(0, animation, true);
				}
			},
			setPosition: (x, y) => {
				if (gone || destroyed) {
					return;
				}
				stopWalk();
				holder.x = x;
				holder.y = y;
				depthDirty = true;
			},
			moveTo: (x, y, durationMs, onArrive) => {
				if (gone || destroyed) {
					return;
				}
				stopWalk();
				const startX = holder.x;
				const startY = holder.y;
				const startTime = performance.now();
				if (Math.abs(x - startX) >= MIN_TURN_DISTANCE) {
					facing = x < startX ? -1 : 1;
					applyScale();
				}
				walk = () => {
					// durationMs <= 0 is an instant move: treat it as already arrived instead of dividing by a
					// non-positive number, which would produce Infinity/NaN and leave the holder off-stage.
					const progress = durationMs <= 0 ? 1 : Math.min(1, (performance.now() - startTime) / durationMs);
					holder.x = startX + (x - startX) * progress;
					holder.y = startY + (y - startY) * progress;
					depthDirty = true;
					if (progress >= 1) {
						stopWalk();
						onArrive?.();
					}
				};
				app.ticker.add(walk);
			},
			setScale: (scale) => {
				if (gone || destroyed) {
					return;
				}
				size = scale;
				applyScale();
			},
			setVisible: (visible) => {
				if (gone || destroyed) {
					return;
				}
				holder.visible = visible;
			},
			setOnTop: (onTop) => {
				if (gone || destroyed) {
					return;
				}
				holder.onTop = onTop;
				depthDirty = true;
			},
			destroy: () => {
				if (gone) {
					return;
				}
				gone = true;
				stopWalk();
				if (!destroyed) {
					// The stage's own destroy already tore down its children, so removing from a nulled
					// app.stage would throw. Only remove here when the stage itself is still alive.
					app.stage.removeChild(holder);
				}
				// Each load owns its textures (see `loadSkeletonData`), so they are freed with the actor, including pages no sprite referenced.
				holder.destroy({ children: true, texture: true });
				releasePages(pages);
			}
		};
	};

	return {
		addActor,
		resize: (nextWidth, nextHeight) => {
			if (destroyed) {
				return;
			}
			if (nextWidth > 0 && nextHeight > 0) {
				app.renderer.resize(nextWidth, nextHeight);
			}
		},
		setPaused: (paused) => {
			if (destroyed) {
				return;
			}
			if (paused) {
				app.stop();
			} else {
				app.start();
			}
		},
		destroy: () => {
			if (destroyed) {
				return;
			}
			destroyed = true;
			app.ticker.remove(sortByDepth);
			app.destroy(true, { children: true, texture: true, baseTexture: true });
		}
	};
}
