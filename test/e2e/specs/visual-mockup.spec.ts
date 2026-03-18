// ─── Visual Mockup Comparison Tests ──────────────────────────────────────────
// Compares screenshots of the static mockup.html against the live app driven
// into the same state via canned WebSocket messages.
//
// Two modes:
//   1. Design convergence: mockup vs live (pixelmatch, logs diff %)
//   2. Visual regression: live UI toHaveScreenshot() (prevents regressions)
//
// Performance notes:
//   - Each test suite drives the live app only ONCE and takes all screenshots
//   - Messages are sent with 0ms delay (all arrive in a single microtask batch)
//   - User interaction uses page.evaluate() (1 IPC round-trip vs 4)
//   - We wait for the "done" handler to reset processing before Turn 2
//
// Tag: @visual — run with: pnpm test:visual
//
// These tests do NOT require a running OpenCode or relay server.
// The frontend is served by Vite preview, and WS is mocked.

import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	initMessages,
	turn1Messages,
	turn2Messages,
	userMessage1,
	userMessage2,
} from "../fixtures/mockup-state.js";
import {
	compareImages,
	freezeAnimations,
	waitForFonts,
	waitForIcons,
} from "../helpers/visual-helpers.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;

async function preparePageForScreenshot(page: Page) {
	await waitForFonts(page);
	await waitForIcons(page);
	await freezeAnimations(page);
}

/**
 * Normalize dynamic text that differs between static mockup and live app.
 * Must be called on BOTH pages before screenshots to ensure deterministic comparison.
 *
 * Normalizes:
 * - Thinking labels: random verb → "Thinking" (in-progress) or "Thought" (completed)
 * - Thinking duration: elapsed time → " 0.0s" (completed) or "" (in-progress)
 * - Session meta: relative timestamps → fixed text
 */
async function normalizeDynamicContent(page: Page) {
	await page.evaluate(() => {
		// ─ Thinking labels ─
		document.querySelectorAll(".thinking-item").forEach((item) => {
			const isDone = item.classList.contains("done");
			const label = item.querySelector(".thinking-label");
			if (label) label.textContent = isDone ? "Thought" : "Thinking";
			const duration = item.querySelector(".thinking-duration");
			if (duration) duration.textContent = isDone ? " 0.0s" : "";
		});

		// ─ Session meta text (timestamps + message counts) ─
		document.querySelectorAll(".session-item-meta").forEach((el) => {
			el.textContent = "";
		});
	});
}

function setupLiveAppWithMockWS(page: Page) {
	const responses = new Map<
		string,
		import("../fixtures/mockup-state.js").MockMessage[]
	>();
	responses.set(userMessage1, turn1Messages);
	responses.set(userMessage2, turn2Messages);

	// messageDelay: 0 — all messages arrive in a single microtask batch.
	// This eliminates the race condition where the test sends Turn 2 before
	// the "done" message resets processing=false (previously 5ms gap).
	return mockRelayWebSocket(page, {
		initMessages,
		responses,
		initDelay: 0,
		messageDelay: 0,
	});
}

/**
 * Send a user message by injecting text + dispatching Enter keydown.
 * Single page.evaluate() call = 1 IPC round-trip (vs 4 with fill+click+dispatch+keyboard).
 */
async function sendUserMessage(page: Page, text: string) {
	await page.evaluate((t) => {
		const input = document.getElementById("input") as HTMLTextAreaElement;
		if (!input) throw new Error("Input element #input not found");
		input.value = t;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Enter",
				code: "Enter",
				bubbles: true,
				cancelable: true,
			}),
		);
	}, text);
}

async function driveToMockupState(page: Page) {
	// Wait for WS connection + session list rendered + send button enabled
	await page.waitForFunction(
		() => {
			const send = document.getElementById("send") as HTMLButtonElement | null;
			const sessions = document.querySelector("[class*='session']");
			return send && !send.disabled && sessions;
		},
		{ timeout: 10_000 },
	);

	// Turn 1: send message
	await sendUserMessage(page, userMessage1);

	// Wait for Turn 1 to fully complete:
	// 1. turn-meta element appears (from "result" message)
	// 2. Send button exits "stop" mode (from "done" message resetting processing)
	await page.waitForSelector("[class*='turn-meta']", { timeout: 10_000 });
	await page.waitForFunction(
		() => !document.getElementById("send")?.classList.contains("stop"),
		{ timeout: 5_000 },
	);

	// Turn 2: send message
	await sendUserMessage(page, userMessage2);

	// Wait for Turn 2 tool items to render
	await page.waitForSelector("[class*='tool-item']", { timeout: 10_000 });
}

/**
 * Hide elements that exist in the live app but not in the mockup.
 * These are overlays, banners, hidden utility elements, etc.
 */
async function hideLiveOnlyElements(page: Page) {
	await page.evaluate(() => {
		const hide = (id: string) => {
			const el = document.getElementById(id);
			if (el) {
				el.style.display = "none";
				el.classList.add("hidden");
			}
		};
		// Connect overlay (should be hidden when connected, but may still be transitioning)
		hide("connect-overlay");
		// Elements not present in mockup
		hide("history-sentinel");
		hide("scroll-btn");
		hide("banner-container");
		hide("todo-sticky");
		hide("rewind-banner");
		hide("command-menu");
		hide("image-preview");
		hide("term-touch-toolbar");
		hide("image-lightbox");
		hide("confirm-modal");
		hide("qr-overlay");
		hide("rewind-modal");
		hide("paste-drop-zone");
	});
}

async function gotoLiveAndDrive(page: Page, baseURL: string | undefined) {
	await setupLiveAppWithMockWS(page);
	await page.goto(baseURL ?? "http://localhost:4173");
	await driveToMockupState(page);
	await hideLiveOnlyElements(page);
	await preparePageForScreenshot(page);
	await normalizeDynamicContent(page);
}

// ─── Debug: save screenshots and diff for inspection ─────────────────────────

const DEBUG_DIR = path.resolve(import.meta.dirname, "../../../test-debug");

function saveDebugImage(name: string, buffer: Buffer): void {
	fs.mkdirSync(DEBUG_DIR, { recursive: true });
	fs.writeFileSync(path.join(DEBUG_DIR, name), buffer);
}

// ─── Design Convergence: Mockup vs Live ──────────────────────────────────────
// Compares mockup screenshots against the live app. Fails if any region has
// differing pixels. All regions are compared in a single test to avoid
// re-driving app state.

test.describe("Visual: Mockup vs Live @visual", () => {
	test.setTimeout(60_000);

	test("all regions comparison", async ({ page, baseURL }) => {
		// ─ 1. Screenshot all mockup regions in one pass ─
		// Mockup is served by Vite preview (same CSS pipeline as live app)
		await page.goto(`${baseURL ?? "http://localhost:4173"}/mockup.html`);
		await preparePageForScreenshot(page);
		await normalizeDynamicContent(page);

		const mockupFull = (await page.screenshot({ fullPage: true })) as Buffer;
		const mockupMsg = (await page
			.locator("#messages")
			.screenshot()
			.catch(() => null)) as Buffer | null;
		const mockupInput = (await page
			.locator("#input-area")
			.screenshot()
			.catch(() => null)) as Buffer | null;

		// ─ 2. Drive live app once, screenshot all regions ─
		await gotoLiveAndDrive(page, baseURL);

		const liveFull = (await page.screenshot({ fullPage: true })) as Buffer;
		const liveMsg = (await page
			.locator("#messages")
			.screenshot()
			.catch(() => null)) as Buffer | null;
		const liveInput = (await page
			.locator("#input-area")
			.screenshot()
			.catch(() => null)) as Buffer | null;

		// ─ 3. Compare all regions — fail on any pixel difference ─
		const fullResult = compareImages(mockupFull, liveFull);
		console.log(
			`[visual] Full page diff: ${fullResult.diffCount} pixels (${(fullResult.diffRatio * 100).toFixed(2)}%)`,
		);

		// Save debug images when there are differences
		if (fullResult.diffCount > 0) {
			saveDebugImage("mockup-full.png", mockupFull);
			saveDebugImage("live-full.png", liveFull);
			saveDebugImage("diff-full.png", fullResult.diffImage);
		}

		expect(
			fullResult.diffCount,
			`Full page: ${fullResult.diffCount} pixels differ (${(fullResult.diffRatio * 100).toFixed(2)}%). Debug images saved to ${DEBUG_DIR}`,
		).toBe(0);

		expect(mockupMsg, "Mockup #messages not found").toBeTruthy();
		expect(liveMsg, "Live #messages not found").toBeTruthy();
		if (mockupMsg && liveMsg) {
			const msgResult = compareImages(mockupMsg, liveMsg);
			console.log(
				`[visual] Messages region diff: ${msgResult.diffCount} pixels (${(msgResult.diffRatio * 100).toFixed(2)}%)`,
			);
			expect(
				msgResult.diffCount,
				`Messages region: ${msgResult.diffCount} pixels differ (${(msgResult.diffRatio * 100).toFixed(2)}%)`,
			).toBe(0);
		}

		expect(mockupInput, "Mockup #input-area not found").toBeTruthy();
		expect(liveInput, "Live #input-area not found").toBeTruthy();
		if (mockupInput && liveInput) {
			const inputResult = compareImages(mockupInput, liveInput);
			console.log(
				`[visual] Input area diff: ${inputResult.diffCount} pixels (${(inputResult.diffRatio * 100).toFixed(2)}%)`,
			);
			expect(
				inputResult.diffCount,
				`Input area: ${inputResult.diffCount} pixels differ (${(inputResult.diffRatio * 100).toFixed(2)}%)`,
			).toBe(0);
		}
	});
});

// ─── Visual Regression: Lock live UI state ──────────────────────────────────
// Uses Playwright's toHaveScreenshot() to detect regressions.
// First run with --update-snapshots generates goldens; subsequent runs compare.
// All snapshots taken in a single test to avoid re-driving app state.

test.describe("Visual: Regression @visual", () => {
	test.setTimeout(60_000);

	test("live UI snapshots", async ({ page, baseURL }) => {
		await gotoLiveAndDrive(page, baseURL);

		await expect(page).toHaveScreenshot("live-full-page.png", {
			fullPage: true,
			maxDiffPixels: 50,
		});

		await expect(page.locator("#messages")).toHaveScreenshot(
			"live-messages.png",
			{ maxDiffPixels: 50 },
		);

		await expect(page.locator("#input-area")).toHaveScreenshot(
			"live-input-area.png",
			{ maxDiffPixels: 50 },
		);
	});
});
