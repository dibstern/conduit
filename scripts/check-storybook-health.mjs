#!/usr/bin/env node

/**
 * Storybook Render Health Check
 *
 * Verifies every story in the built Storybook renders correctly:
 * - Page loads (HTTP 200)
 * - No JavaScript errors (excluding known noise)
 * - Storybook's render and play() lifecycle succeeds
 * - #storybook-root has children
 * - Dimensions are reported
 *
 * Usage:
 *   npx http-server dist/storybook -p 6007 -s &
 *   node scripts/check-storybook-health.mjs
 *
 * Or use the package.json script:
 *   pnpm check:storybook
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const BASE_URL = process.env.STORYBOOK_URL || "http://localhost:6007";
const indexPath = join(process.cwd(), "dist", "storybook", "index.json");

// Known noise errors to ignore
const IGNORED_ERRORS = ["Unexpected token 'export'", "vite-inject-mocker"];

// Stories whose whole point is a not-rendered state (hidden/closed/empty), so an
// empty #storybook-root is the correct outcome, not a render failure. They are
// still loaded and still fail on HTTP errors and JS errors — only the
// empty-root check is waived.
//
// The waiver is self-invalidating: an entry that no longer renders empty (story
// deleted, renamed, or given a visible state) fails the check as a stale
// exemption, so this list cannot silently outlive its reason.
const EXPECTED_EMPTY_ROOT = new Set([
	"overlays-confirmmodal--hidden",
	"overlays-qrmodal--hidden",
	"overlays-imagelightbox--hidden",
	"overlays-notifsettings--closed",
	"overlays-rewindbanner--inactive",
	"chat-pastepreview--empty",
]);

function isIgnored(msg) {
	return IGNORED_ERRORS.some((pattern) => msg.includes(pattern));
}

let data;
try {
	data = JSON.parse(readFileSync(indexPath, "utf-8"));
} catch {
	console.error("ERROR: dist/storybook/index.json not found.");
	console.error("Run: pnpm storybook:build");
	process.exit(1);
}

const stories = Object.values(data.entries ?? {}).filter(
	(e) => e.type === "story",
);

console.log(`Checking ${stories.length} stories at ${BASE_URL}...\n`);

const browser = await chromium.launch();
const results = { pass: 0, warn: 0, skip: 0, fail: 0, errors: [] };
const unusedExemptions = new Set(EXPECTED_EMPTY_ROOT);

for (const story of stories) {
	const page = await browser.newPage({
		viewport: { width: 1440, height: 900 },
	});
	const errors = [];
	page.on("pageerror", (err) => {
		if (!isIgnored(err.message)) {
			errors.push(err.message);
		}
	});

	try {
		const resp = await page.goto(
			`${BASE_URL}/iframe.html?id=${story.id}&viewMode=story`,
			{ waitUntil: "domcontentloaded", timeout: 8000 },
		);

		if (!resp || resp.status() >= 400) {
			unusedExemptions.delete(story.id);
			console.log(`  FAIL  ${story.id} — HTTP ${resp?.status()}`);
			results.fail++;
			results.errors.push({
				id: story.id,
				reason: `HTTP ${resp?.status()}`,
			});
			await page.close();
			continue;
		}

		await page.waitForTimeout(800);

		const initialRenderState = await page.evaluate((storyId) => {
			const preview = window.__STORYBOOK_PREVIEW__;
			if (!preview || !Array.isArray(preview.storyRenders)) {
				return {
					apiError: "window.__STORYBOOK_PREVIEW__.storyRenders is unavailable",
				};
			}

			const render = preview.storyRenders.find(
				(candidate) => candidate.id === storyId,
			);
			if (!render) {
				return { apiError: `no StoryRender found for ${storyId}` };
			}
			if (typeof render.phase !== "string") {
				return { apiError: `StoryRender.phase is unavailable for ${storyId}` };
			}

			return { phase: render.phase };
		}, story.id);

		if (initialRenderState.apiError) {
			throw new Error(
				`Storybook render API unavailable: ${initialRenderState.apiError}`,
			);
		}

		if (
			!["finished", "errored", "aborted"].includes(initialRenderState.phase)
		) {
			await page.waitForFunction(
				(storyId) => {
					const render = window.__STORYBOOK_PREVIEW__?.storyRenders?.find(
						(candidate) => candidate.id === storyId,
					);
					return ["finished", "errored", "aborted"].includes(
						render?.phase ?? "",
					);
				},
				story.id,
				{ polling: 50, timeout: 4_200 },
			);
		}

		const info = await page.evaluate((storyId) => {
			const root = document.querySelector("#storybook-root");
			const rect = root?.getBoundingClientRect();
			const preview = window.__STORYBOOK_PREVIEW__;
			if (!preview || !Array.isArray(preview.storyRenders)) {
				return {
					apiError: "window.__STORYBOOK_PREVIEW__.storyRenders is unavailable",
				};
			}

			const render = preview.storyRenders.find(
				(candidate) => candidate.id === storyId,
			);
			if (!render || typeof render.phase !== "string") {
				return { apiError: `StoryRender state is unavailable for ${storyId}` };
			}

			const addons = window.__STORYBOOK_ADDONS_PREVIEW;
			const channel =
				typeof addons?.hasChannel === "function" && addons.hasChannel()
					? addons.getChannel()
					: undefined;
			if (!channel || typeof channel.last !== "function") {
				return { apiError: "Storybook preview channel history is unavailable" };
			}

			const playException = channel.last("playFunctionThrewException")?.[0];
			const storyFinished = channel.last("storyFinished")?.[0];
			if (render.phase === "finished" && !storyFinished) {
				return { apiError: "Storybook storyFinished payload is unavailable" };
			}

			return {
				exists: Boolean(root),
				width: Math.round(rect?.width ?? 0),
				height: Math.round(rect?.height ?? 0),
				children: root?.children.length ?? 0,
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
		}, story.id);

		if (info.apiError) {
			unusedExemptions.delete(story.id);
			console.log(`  FAIL  ${story.id} — Storybook API: ${info.apiError}`);
			results.fail++;
			results.errors.push({
				id: story.id,
				reason: `Storybook API: ${info.apiError}`,
			});
		} else if (
			info.phase === "errored" ||
			info.playError ||
			info.finishedStatus === "error"
		) {
			unusedExemptions.delete(story.id);
			const reason = info.playError
				? `play() failed: ${info.playError}`
				: `Storybook render failed (phase=${info.phase}, status=${info.finishedStatus ?? "unknown"})`;
			console.log(`  FAIL  ${story.id} — ${reason}`);
			results.fail++;
			results.errors.push({ id: story.id, reason });
		} else if (errors.length > 0) {
			// Failed for a reason the waiver never covered; don't also call it stale.
			unusedExemptions.delete(story.id);
			const msg = errors[0].slice(0, 80);
			console.log(`  FAIL  ${story.id} — JS error: ${msg}`);
			results.fail++;
			results.errors.push({
				id: story.id,
				reason: `JS error: ${msg}`,
			});
		} else if (!info.exists || info.children === 0) {
			if (EXPECTED_EMPTY_ROOT.has(story.id)) {
				unusedExemptions.delete(story.id);
				console.log(`  SKIP  ${story.id} — empty root by design`);
				results.skip++;
			} else {
				console.log(`  FAIL  ${story.id} — Empty #storybook-root`);
				results.fail++;
				results.errors.push({
					id: story.id,
					reason: "Empty #storybook-root",
				});
			}
		} else if (info.height === 0) {
			console.log(
				`  WARN  ${story.id} — Zero height (${info.width}x0, ${info.children} children)`,
			);
			results.warn++;
		} else {
			console.log(`  PASS  ${story.id} — ${info.width}x${info.height}`);
			results.pass++;
		}
	} catch (err) {
		unusedExemptions.delete(story.id);
		const msg = err.message.slice(0, 80);
		console.log(`  FAIL  ${story.id} — ${msg}`);
		results.fail++;
		results.errors.push({ id: story.id, reason: msg });
	} finally {
		await page.close();
	}
}

await browser.close();

for (const id of unusedExemptions) {
	console.log(`  FAIL  ${id} — stale EXPECTED_EMPTY_ROOT exemption`);
	results.fail++;
	results.errors.push({
		id,
		reason:
			"stale EXPECTED_EMPTY_ROOT exemption — story no longer exists or no longer renders empty; remove it from the allowlist",
	});
}

console.log(`\n${"=".repeat(60)}`);
console.log(
	`Results: ${results.pass} pass, ${results.warn} warn, ${results.skip} skip, ${results.fail} fail (${stories.length} total)`,
);
if (results.errors.length > 0) {
	console.log(`\nFailures:`);
	for (const e of results.errors) {
		console.log(`  ${e.id}: ${e.reason}`);
	}
}
process.exit(results.fail > 0 ? 1 : 0);
