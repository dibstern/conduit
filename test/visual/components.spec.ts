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
import { expect, test } from "@playwright/test";

// ─── Story Discovery ─────────────────────────────────────────────────────────

interface StoryEntry {
	id: string;
	title: string;
	name: string;
	type: "story" | "docs";
	tags?: string[];
}

const VIEWPORT_CAPTURE_TAG = "viewport-capture";

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

/** Wait for the story to fully render (fonts, Storybook root, async content). */
async function _waitForStoryRender(
	page: import("@playwright/test").Page,
): Promise<void> {
	// Wait for Storybook root element
	await page
		.waitForSelector("#storybook-root", {
			state: "attached",
			timeout: 5_000,
		})
		.catch(() => {
			/* root may already be present */
		});
	// Wait for web fonts
	await page.evaluate(() => document.fonts.ready).catch(() => {});
	// Brief settle time for Svelte renders
	await page.waitForTimeout(200);
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

	// Stories that intentionally render nothing (hidden/empty/closed states)
	const SKIP_STORIES = new Set([
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
						test.skip(true, "Intentionally empty/hidden story");
						return;
					}

					await page.goto(`/iframe.html?id=${story.id}&viewMode=story`, {
						waitUntil: "domcontentloaded",
					});
					await page.waitForTimeout(800);
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

					const screenshotOpts = sizeNorm
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
