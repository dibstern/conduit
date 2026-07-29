#!/usr/bin/env node

/**
 * Storybook Render Health Check
 *
 * Verifies every story in the built Storybook renders correctly:
 * - Page loads (HTTP 200)
 * - No JavaScript errors (excluding known noise)
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

		const info = await page.evaluate(() => {
			const root = document.querySelector("#storybook-root");
			if (!root) return { exists: false, width: 0, height: 0, children: 0 };
			const rect = root.getBoundingClientRect();
			return {
				exists: true,
				width: Math.round(rect.width),
				height: Math.round(rect.height),
				children: root.children.length,
			};
		});

		if (errors.length > 0) {
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
