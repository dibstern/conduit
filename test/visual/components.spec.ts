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
}

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
		"features-agentselector--single-agent",
		"features-agentselector--no-agents",
		"features-pastepreview--empty",
		"overlays-confirmmodal--hidden",
		"overlays-imagelightbox--hidden",
		"overlays-qrmodal--hidden",
		"overlays-notifsettings--closed",
		"overlays-rewindbanner--inactive",
		"overlays-connectoverlay--connected",
	]);

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
					if (box && box.height > 0) {
						await expect(root).toHaveScreenshot(`${story.id}.png`);
					} else {
						// Fall back to full-page screenshot for overlays/modals
						await expect(page).toHaveScreenshot(`${story.id}.png`);
					}
				});
			}
		});
	}
}
