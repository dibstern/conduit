import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

interface IndexEntry {
	id: string;
	title: string;
	type: "story" | "docs";
	importPath: string;
}

const cwd = process.env["STORYBOOK_CWD"] ?? process.cwd();
const indexPath = join(cwd, "dist", "storybook", "index.json");
const indexSource = readFileSync(indexPath, "utf-8");
// iframe.html, NOT index.json, is the build fingerprint: it embeds Vite's
// content-hashed bundle names (assets/iframe-<hash>.js), so it changes whenever
// any source file changes. index.json is derived from the *story files* alone,
// so it is byte-identical across two worktrees at the same base commit and is
// unmoved by a component edit — it cannot detect either failure this guards.
const iframeSource = readFileSync(
	join(cwd, "dist", "storybook", "iframe.html"),
	"utf-8",
);
const index = JSON.parse(indexSource);
const entries: Record<string, IndexEntry> =
	index.entries ?? index.stories ?? {};
const allEntries = Object.values(entries);
const mdxDocs = allEntries.filter(
	(entry) => entry.type === "docs" && entry.importPath.endsWith(".mdx"),
);
const stories = allEntries.filter((entry) => entry.type === "story");

// Console/page noise that predates this check and is not a render failure.
const IGNORED_ERRORS = ["Unexpected token 'export'", "vite-inject-mocker"];

// Stories whose whole point is a not-rendered state (hidden/closed/empty), so an
// empty #storybook-root is the correct outcome rather than a render failure.
// They are still loaded and still fail on HTTP or JS errors — only the
// empty-root assertion is waived.
//
// The waiver is self-invalidating: `no stale empty-root exemptions` below fails
// if an entry here renders content or disappears from the index, so an
// exemption cannot outlive the reason it was granted.
const EXPECTED_EMPTY_ROOT = new Set([
	"overlays-confirmmodal--hidden",
	"overlays-qrmodal--hidden",
	"overlays-imagelightbox--hidden",
	"overlays-notifsettings--closed",
	"overlays-rewindbanner--inactive",
	"chat-pastepreview--empty",
]);

const realErrors = (messages: string[]): string[] =>
	messages.filter(
		(message) => !IGNORED_ERRORS.some((noise) => message.includes(noise)),
	);

test.describe("Built Storybook render health", () => {
	// Belt-and-braces behind `reuseExistingServer: false`. This is not
	// hypothetical: on 2026-08-20 a stale `python3 -m http.server` rooted in
	// another worktree's dist/storybook served this entire suite, and a run
	// containing a deliberately-broken component passed 451/451 green.
	//
	// The first version of this guard compared /index.json and did NOT catch it,
	// because index.json is derived from the story files alone — identical across
	// worktrees at the same commit, and unmoved by any component edit. iframe.html
	// embeds content-hashed bundle names, so it differs whenever the build does.
	// A guard that cannot fail on the scenario it was written for is worse than
	// no guard: it converts an open question into a false assurance.
	test("serves the build under test", async ({ request }) => {
		const response = await request.get("/iframe.html");
		expect(
			response.ok(),
			`/iframe.html returned HTTP ${response.status()}`,
		).toBe(true);
		expect(
			await response.text(),
			"the served port is serving a different Storybook build than dist/storybook — stop the stale server and re-run",
		).toBe(iframeSource);
	});

	test.describe("stories", () => {
		for (const entry of stories) {
			test(entry.id, async ({ page }) => {
				const pageErrors: string[] = [];
				page.on("pageerror", (error) => pageErrors.push(error.message));

				const response = await page.goto(`/iframe.html?id=${entry.id}`, {
					waitUntil: "domcontentloaded",
				});

				expect(
					response?.ok(),
					`${entry.id} returned HTTP ${response?.status()}`,
				).toBe(true);

				const root = page.locator("#storybook-root");
				if (EXPECTED_EMPTY_ROOT.has(entry.id)) {
					// Assert the exemption is still *earned*, not merely still listed.
					// If this story starts rendering content, the waiver is stale and
					// this fails — which is the only thing keeping the list above
					// from quietly outliving its reason.
					await page.waitForLoadState("networkidle");
					await expect(root).toBeAttached();
					expect(
						await root.evaluate((el) => el.childElementCount),
						`${entry.id} is exempt from the empty-root check but now renders content — remove it from EXPECTED_EMPTY_ROOT`,
					).toBe(0);
					// Text too, not just elements. A root holding only text nodes still
					// reports childElementCount 0, so an element-only check would let a
					// waived story start rendering visible content and keep its waiver.
					expect(
						(await root.textContent())?.trim() ?? "",
						`${entry.id} is exempt from the empty-root check but now renders visible text — remove it from EXPECTED_EMPTY_ROOT`,
					).toBe("");
				} else {
					// Child count, not text: a story can legitimately render only an
					// icon or a spacer, but a story that renders *nothing* is the
					// silent failure this whole pass exists to catch.
					await expect
						.poll(() => root.evaluate((el) => el.childElementCount), {
							message: `${entry.id} rendered an empty #storybook-root`,
						})
						.toBeGreaterThan(0);
				}

				// Settle BEFORE sampling errors. The first child appearing in the root
				// is not the end of the story: an `onMount` that throws after first
				// paint, and a `play()` that fails only in the production build, both
				// land after the poll above has already resolved. Sampling there rather
				// than here is the difference between observing the story and observing
				// its first frame.
				//
				// This is the one thing addon-vitest cannot cover for us. It runs
				// stories through `composedStory.run()` in its own Vite test
				// environment — never against this built artifact — so a lifecycle
				// failure that reproduces only in the production bundle is invisible to
				// it by construction. That was the deleted health script's real job, and
				// it is the coverage this block exists to keep.
				await page.waitForLoadState("networkidle");

				// Storybook catches render and play() throws and paints them into its
				// own error surface rather than rethrowing, so `pageerror` never sees
				// them. Without this, a story can fail loudly on screen and pass
				// silently here.
				await expect(page.locator("#error-message")).toBeEmpty();
				expect(realErrors(pageErrors)).toEqual([]);
			});
		}
	});

	test.describe("MDX docs", () => {
		for (const entry of mdxDocs) {
			test(entry.title, async ({ page }) => {
				const pageErrors: string[] = [];
				page.on("pageerror", (error) => pageErrors.push(error.message));

				const response = await page.goto(
					`/iframe.html?id=${entry.id}&viewMode=docs`,
					{ waitUntil: "domcontentloaded" },
				);

				expect(
					response?.ok(),
					`${entry.id} returned HTTP ${response?.status()}`,
				).toBe(true);
				await expect(page.locator("#storybook-docs")).toBeVisible();
				await expect(page.locator("#storybook-docs")).not.toBeEmpty();
				await expect(page.locator("#error-message")).toBeEmpty();
				expect(realErrors(pageErrors)).toEqual([]);
			});
		}
	});

	test("no stale empty-root exemptions", () => {
		const known = new Set(stories.map((entry) => entry.id));
		const missing = [...EXPECTED_EMPTY_ROOT].filter((id) => !known.has(id));
		expect(
			missing,
			"these ids are exempt from the empty-root check but no longer exist as stories",
		).toEqual([]);
	});
});
