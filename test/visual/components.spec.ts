// ─── Storybook Visual Regression ─────────────────────────────────────────────
// Auto-discovers ALL stories from the built Storybook index.json and takes
// a screenshot of each. Uses Playwright's toHaveScreenshot() for golden-file
// comparison with a configurable diff threshold.
//
// Run:  pnpm test:storybook-visual           (compare against golden snapshots)
//       pnpm test:storybook-visual:update    (regenerate golden snapshots)
//
// Prerequisites: pnpm storybook:build (generates dist/storybook/)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errors, expect, test } from "@playwright/test";

// ─── Story Discovery ─────────────────────────────────────────────────────────

interface StoryEntry {
	id: string;
	title: string;
	name: string;
	type: "story" | "docs";
	tags?: string[];
}

const VIEWPORT_CAPTURE_TAG = "viewport-capture";

/** Fidelity-gate mode for migration swap commits — see playwright.config.ts. */
const STRICT = process.env["VISUAL_STRICT"] === "1";

/**
 * Re-test the known-flaky list instead of trusting it: `VISUAL_STRICT_ALL=1`
 * ignores STRICT_NONDETERMINISTIC entirely.
 *
 * A skip list with no way to re-run its members goes stale silently, and then
 * a story that was fixed months ago is still excluded from the only gate that
 * would notice it regressing. It also makes the list unfalsifiable as evidence:
 * measuring flake before adding an entry and after adding it compares different
 * denominators, so the second number looks like an improvement it did not earn.
 */
const STRICT_ALL = process.env["VISUAL_STRICT_ALL"] === "1";

/**
 * Stories that a strict recapture cannot reproduce on the very next strict run.
 * Measured 2026-08-03: recapture the whole suite under VISUAL_STRICT=1, then
 * re-run it immediately — 843 of 848 captures came back byte-identical, so
 * zero-diff is achievable here; these three are not, for their own reasons.
 * Each is a bug to fix (conduit-test-de3.20), not a tolerance to grant.
 */
const STRICT_NONDETERMINISTIC: Record<string, string> = {
	"chat-thinkingblock--active":
		"active/animated state the suite's animation disabling does not reach",
	"ui-menu--arrow-key-navigation":
		"play()-driven; keyboard navigation has not settled by capture time",
	// Re-measured 2026-08-06 with VISUAL_STRICT_ALL=1 over three consecutive
	// probes: which SettingsPanel story fails moves between runs (probe 1 Debug
	// + Notifications Enabled, probe 2 Default + Notifications Enabled + Debug,
	// probe 3 none). Naming only --default, as this list first did, left the
	// other two silently uncovered — the flake is the family's, not one story's.
	"overlays-settingspanel--default":
		"SettingsPanel stories share module state across parallel workers; which one fails moves between runs",
	"overlays-settingspanel--debug":
		"SettingsPanel stories share module state across parallel workers; which one fails moves between runs",
	"overlays-settingspanel--notifications-enabled":
		"SettingsPanel stories share module state across parallel workers; which one fails moves between runs",
};

function loadStories(): StoryEntry[] {
	const cwd = process.env["STORYBOOK_CWD"] ?? process.cwd();
	const indexPath = join(cwd, "dist", "storybook", "index.json");
	const data = JSON.parse(readFileSync(indexPath, "utf-8"));
	const entries: Record<string, StoryEntry> =
		data.entries ?? data.stories ?? {};
	return Object.values(entries).filter((e) => e.type === "story");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Inject CSS to freeze all animations and transitions for deterministic screenshots. */
async function freezeAnimations(
	page: import("@playwright/test").Page,
): Promise<void> {
	await page.addStyleTag({
		content: `*, *::before, *::after {
			animation-delay: -0.0001s !important;
			animation-duration: 0s !important;
			animation-play-state: paused !important;
			transition-duration: 0s !important;
			transition-delay: 0s !important;
			caret-color: transparent !important;
		}`,
	});
	await page.waitForTimeout(50);
}

/**
 * Wait for Storybook's current render to reach a terminal lifecycle phase.
 *
 * A fixed sleep races play() functions: ui-modal--escape-restores-focus
 * straddled the old 800ms boundary and was captured with its modal still open.
 * Older preview state may not expose a terminal phase; that timeout is surfaced
 * before falling back to the existing additive settle.
 */
async function waitForStoryTerminalPhase(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	await page
		.waitForFunction(
			(currentStoryId) => {
				const preview = (
					window as Window & {
						__STORYBOOK_PREVIEW__?: {
							storyRenders?: Array<{
								id?: string;
								phase?: string;
							}>;
						};
					}
				).__STORYBOOK_PREVIEW__;
				const render = preview?.storyRenders?.find(
					(candidate) => candidate.id === currentStoryId,
				);
				return ["finished", "errored", "aborted"].includes(render?.phase ?? "");
			},
			storyId,
			{
				polling: 50,
				timeout: 5_000,
			},
		)
		.catch((error: unknown) => {
			if (!(error instanceof errors.TimeoutError)) throw error;
			console.warn(
				`Storybook render phase did not reach a terminal state for ${storyId} within 5s; using the additive settle`,
			);
		});
}

/** Require a quiet window long enough to cover delayed portalled DOM teardown. */
const QUIET_MS = 150;

/** Bound permanently animating stories while keeping their timeout non-fatal. */
const QUIESCENCE_TIMEOUT_MS = 3_000;

/**
 * Wait for running animations and then for a mutation-free DOM window.
 *
 * Portalled content can outlive Storybook's terminal render phase. Observe the
 * document root so mutations outside #storybook-root also extend the settle.
 */
async function waitForDomQuiescence(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	await page
		.evaluate(
			async ({ quietMs, timeoutMs }) =>
				await new Promise<boolean>((resolve) => {
					let observer: MutationObserver | undefined;
					let quietTimer: number | undefined;
					let timeoutTimer: number | undefined;
					let resolved = false;

					const finish = (settled: boolean) => {
						if (resolved) return;
						resolved = true;
						observer?.disconnect();
						if (quietTimer !== undefined) window.clearTimeout(quietTimer);
						if (timeoutTimer !== undefined) window.clearTimeout(timeoutTimer);
						resolve(settled);
					};

					timeoutTimer = window.setTimeout(() => finish(false), timeoutMs);

					void Promise.allSettled(
						document.getAnimations().map((animation) => animation.finished),
					).then(() => {
						if (resolved) return;

						observer = new MutationObserver(() => {
							if (quietTimer !== undefined) {
								window.clearTimeout(quietTimer);
							}
							quietTimer = window.setTimeout(() => finish(true), quietMs);
						});
						observer.observe(document.documentElement, {
							childList: true,
							subtree: true,
							attributes: true,
							characterData: true,
						});
						quietTimer = window.setTimeout(() => finish(true), quietMs);
					});
				}),
			{ quietMs: QUIET_MS, timeoutMs: QUIESCENCE_TIMEOUT_MS },
		)
		.then((settled) => {
			if (settled) return;
			console.warn(
				`DOM did not quiesce for ${storyId} within ${QUIESCENCE_TIMEOUT_MS}ms; continuing to screenshot`,
			);
		})
		.catch((error: unknown) => {
			console.warn(
				`DOM quiescence wait failed for ${storyId}; continuing to screenshot`,
				error,
			);
		});
}

/**
 * Fail instead of screenshotting a render whose play() or Storybook lifecycle
 * failed. This runs after the existing additive settle so a terminal phase
 * cannot race its corresponding Storybook channel event.
 */
async function assertStoryRenderSucceeded(
	page: import("@playwright/test").Page,
	storyId: string,
): Promise<void> {
	const result = await page.evaluate((currentStoryId) => {
		const storybookWindow = window as Window & {
			__STORYBOOK_PREVIEW__?: {
				storyRenders?: Array<{
					id?: string;
					phase?: string;
				}>;
			};
			__STORYBOOK_ADDONS_PREVIEW?: {
				hasChannel?: () => boolean;
				getChannel?: () => {
					last?: (eventName: string) => unknown[] | undefined;
				};
			};
		};
		if (!storybookWindow.__STORYBOOK_PREVIEW__?.storyRenders) {
			return {
				apiError: "window.__STORYBOOK_PREVIEW__.storyRenders is unavailable",
			};
		}

		const render = storybookWindow.__STORYBOOK_PREVIEW__.storyRenders.find(
			(candidate) => candidate.id === currentStoryId,
		);
		if (!render || typeof render.phase !== "string") {
			return {
				apiError: `StoryRender state is unavailable for ${currentStoryId}`,
			};
		}

		const addons = storybookWindow.__STORYBOOK_ADDONS_PREVIEW;
		const channel =
			addons?.hasChannel?.() === true ? addons.getChannel?.() : undefined;
		if (!channel?.last) {
			return { apiError: "Storybook preview channel history is unavailable" };
		}

		const playException = channel.last("playFunctionThrewException")?.[0] as
			| { message?: unknown }
			| undefined;
		const storyFinished = channel.last("storyFinished")?.[0] as
			| { status?: unknown }
			| undefined;
		if (render.phase === "finished" && !storyFinished) {
			return { apiError: "Storybook storyFinished payload is unavailable" };
		}

		return {
			phase: render.phase,
			playError:
				typeof playException?.message === "string"
					? playException.message
					: undefined,
			finishedStatus:
				typeof storyFinished?.status === "string"
					? storyFinished.status
					: undefined,
		};
	}, storyId);

	if (result.apiError) {
		throw new Error(`Storybook render API unavailable: ${result.apiError}`);
	}
	if (
		result.phase === "errored" ||
		result.playError ||
		result.finishedStatus === "error"
	) {
		const detail = result.playError
			? `play() failed: ${result.playError}`
			: `render failed (phase=${result.phase}, status=${result.finishedStatus ?? "unknown"})`;
		throw new Error(`Story "${storyId}" ${detail}`);
	}
}

// ─── Tests ───────────────────────────────────────────────────────────────────

let stories: StoryEntry[];
try {
	stories = loadStories();
} catch {
	// If index.json doesn't exist (storybook not built), create a failing test
	test("Storybook must be built first", () => {
		throw new Error(
			"dist/storybook/index.json not found. Run: pnpm storybook:build",
		);
	});
	stories = [];
}

if (stories.length > 0) {
	// Group stories by component title for organized test output
	const byTitle = new Map<string, StoryEntry[]>();
	for (const story of stories) {
		const existing = byTitle.get(story.title) ?? [];
		existing.push(story);
		byTitle.set(story.title, existing);
	}

	// Stories intentionally excluded from screenshot capture:
	// 1. hidden/empty/closed states;
	// 2. behavior-only fixtures covered by dedicated browser specs; and
	// 3. stories whose final state is a transient interaction end-state.
	//
	// ui-modal--escape-restores-focus settles to a closed modal, visually
	// identical to every other closed-modal story and carrying no design
	// information. Storybook can report "finished" before Svelte tears down the
	// portaled dialog, so its screenshot races between open and closed states.
	// Its real value is behavioral and remains asserted by the story's own play()
	// through check:storybook and by modal-focus.spec.ts in a real browser,
	// including focus restoration. This is NOT a blessed-away regression.
	const SKIP_STORIES = new Set([
		"fixtures-modalfocus--default",
		"ui-modal--escape-restores-focus",
		"model-agentselector--single-agent",
		"model-agentselector--no-agents",
		"chat-pastepreview--empty",
		"overlays-confirmmodal--hidden",
		"overlays-imagelightbox--hidden",
		"overlays-qrmodal--hidden",
		"overlays-notifsettings--closed",
		"overlays-rewindbanner--inactive",
		"overlays-connectoverlay--connected",
	]);

	// Stories whose element dimensions vary across platforms (e.g. Mermaid SVGs
	// whose viewBox is computed from font metrics that differ between Docker
	// emulation and native CI Linux).  Two fixes applied:
	//
	// 1. min-height pins the element's bounding box so screenshot dimensions
	//    are identical everywhere (Playwright rejects size mismatches before
	//    any pixel comparison).
	// 2. maxDiffPixelRatio tolerates the remaining pixel-level differences
	//    caused by different font metrics between Docker-emulated and native
	//    CI Linux (measured at 0.03–0.04 in CI as of 2026-03-31).
	const SIZE_NORMALIZED_STORIES: Record<
		string,
		{ minHeight: number; maxDiffPixelRatio: number }
	> = {
		"chat-assistantmessage--with-mermaid": {
			minHeight: 320,
			maxDiffPixelRatio: 0.05,
		},
	};

	for (const [title, componentStories] of byTitle) {
		test.describe(title, () => {
			for (const story of componentStories) {
				test(story.name, async ({ page }) => {
					if (SKIP_STORIES.has(story.id)) {
						test.skip(true, "Intentionally excluded from visual capture");
						return;
					}

					const strictFlakeReason = STRICT_NONDETERMINISTIC[story.id];
					if (STRICT && !STRICT_ALL && strictFlakeReason) {
						// Announced, not silent: strict mode's whole value is that a red
						// run means something, so a story it cannot hold to zero-diff is
						// named here with its reason rather than left permanently red
						// (which trains everyone to ignore the colour) or quietly passed.
						test.skip(
							true,
							`[visual:strict] NOT covered by the fidelity gate — ${strictFlakeReason} (conduit-test-de3.20)`,
						);
						return;
					}

					await page.goto(`/iframe.html?id=${story.id}&viewMode=story`, {
						waitUntil: "domcontentloaded",
					});
					await waitForStoryTerminalPhase(page, story.id);
					// Keep the historical settle after the phase wait/fallback. Waiting may
					// only increase; shortening it risks baseline churn across all stories.
					await page.waitForTimeout(800);
					await waitForDomQuiescence(page, story.id);
					await assertStoryRenderSucceeded(page, story.id);
					await freezeAnimations(page);

					// Detect zero-height root (fixed-position content escapes flow)
					const root = page.locator("#storybook-root");
					const box = await root.boundingBox();

					// Pin element height for size-variable stories so screenshots
					// have identical dimensions across platforms.
					const sizeNorm = SIZE_NORMALIZED_STORIES[story.id];
					if (sizeNorm) {
						await page.addStyleTag({
							content: `#storybook-root { min-height: ${sizeNorm.minHeight}px; }`,
						});
						await page.waitForTimeout(50);
					}

					// Per-story tolerances are a per-CALL option, which beats the
					// config-level one — so leaving this in place under VISUAL_STRICT
					// would let a story quietly opt out of the fidelity gate while the
					// run still reported strict. Under strict the override is dropped
					// and the exemption is announced, so a story that then fails is
					// read as "not provably identical" rather than as a broken mode.
					if (sizeNorm && STRICT) {
						console.warn(
							`[visual:strict] ignoring the ${sizeNorm.maxDiffPixelRatio} tolerance for "${story.id}"; it is held to zero-diff like every other story.`,
						);
					}
					const screenshotOpts =
						sizeNorm && !STRICT
							? { maxDiffPixelRatio: sizeNorm.maxDiffPixelRatio }
							: {};
					// A zero-height root already falls back to the viewport, so it is
					// as safe as an explicit tag. The guard below only needs to police
					// the element-capture path — the one that can silently crop
					// content away and still produce a plausible image.
					const usesViewportCapture =
						story.tags?.includes(VIEWPORT_CAPTURE_TAG) ||
						!box ||
						box.height <= 0;

					if (!usesViewportCapture) {
						const escapedElement = await page.evaluate(() => {
							const storybookRoot =
								document.querySelector<HTMLElement>("#storybook-root");
							if (!storybookRoot) {
								return null;
							}

							const tolerance = 1;

							// Both capture modes clip at the viewport, so only the
							// on-screen part of a rect can ever differ between them.
							// Comparing raw rects instead flags content that is
							// off-canvas (a closed drawer parked at x=-260) or that
							// overflows the viewport edge (a 400px element in a 393px
							// viewport) — neither of which a page capture would
							// recover, so neither is a reason to switch modes.
							const clipToViewport = (r: DOMRect) => ({
								left: Math.max(r.left, 0),
								top: Math.max(r.top, 0),
								right: Math.min(r.right, window.innerWidth),
								bottom: Math.min(r.bottom, window.innerHeight),
							});
							const rootVisible = clipToViewport(
								storybookRoot.getBoundingClientRect(),
							);

							for (const element of document.querySelectorAll<HTMLElement>(
								"*",
							)) {
								if (
									element === storybookRoot ||
									element.contains(storybookRoot)
								) {
									continue;
								}

								const style = getComputedStyle(element);
								if (
									(style.position !== "fixed" &&
										style.position !== "absolute") ||
									style.display === "none" ||
									style.visibility === "hidden" ||
									Number.parseFloat(style.opacity) <= 0
								) {
									continue;
								}

								const rect = element.getBoundingClientRect();
								if (rect.width === 0 || rect.height === 0) {
									continue;
								}

								const visible = clipToViewport(rect);
								if (
									visible.right - visible.left <= 0 ||
									visible.bottom - visible.top <= 0
								) {
									continue;
								}

								const contained =
									visible.left >= rootVisible.left - tolerance &&
									visible.top >= rootVisible.top - tolerance &&
									visible.right <= rootVisible.right + tolerance &&
									visible.bottom <= rootVisible.bottom + tolerance;
								if (!contained) {
									return {
										tagName: element.tagName.toLowerCase(),
										classList: Array.from(element.classList),
									};
								}
							}

							return null;
						});

						if (escapedElement) {
							const elementName = [
								escapedElement.tagName,
								...escapedElement.classList,
							].join(".");
							throw new Error(
								`Story "${story.id}" has visible fixed or absolute content outside #storybook-root: ${elementName}. Add the "${VIEWPORT_CAPTURE_TAG}" tag to this story.`,
							);
						}
					}

					if (usesViewportCapture) {
						await expect(page).toHaveScreenshot(
							`${story.id}.png`,
							screenshotOpts,
						);
					} else {
						await expect(root).toHaveScreenshot(
							`${story.id}.png`,
							screenshotOpts,
						);
					}
				});
			}
		});
	}
}
