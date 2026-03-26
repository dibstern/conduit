// ─── E2E Debug Panel Tests ───────────────────────────────────────────────────
// Smoke tests for the WS debug observability feature: feature flags, debug
// panel, Settings debug tab, header bug icon, keyboard shortcut, and the
// window.__wsDebug() console API.
// Uses real relay backed by MockOpenCodeServer.

import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

// ─── Selectors ───────────────────────────────────────────────────────────────

const DEBUG_PANEL = ".debug-panel";
const DEBUG_BTN = "#debug-btn";
const SETTINGS_BTN = "#header-settings-btn";
const SETTINGS_PANEL = "#settings-panel";
const DEBUG_TAB = 'button:has-text("Debug")';
const DEBUG_TOGGLE =
	'button[role="switch"][aria-label="Connection debug panel"]';
const CLEAR_BTN = 'button[title="Clear log"]';
const CLOSE_BTN = 'button[title="Close panel"]';
const VERBOSE_BTN = 'button[title*="logging"]';

// ─── URL param activation ────────────────────────────────────────────────────

test.describe("Debug Panel — URL Activation", () => {
	test("?feats=debug activates the debug panel", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		// Debug panel should be visible
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });

		// Panel title
		await expect(page.locator(DEBUG_PANEL).getByText("WS Debug")).toBeVisible();

		// Header bug icon should appear
		await expect(page.locator(DEBUG_BTN)).toBeVisible();
	});

	test("debug flag persists to localStorage", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		// Wait for panel to confirm initialization completed
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });

		// Check localStorage
		const flags = await page.evaluate(() =>
			localStorage.getItem("feature-flags"),
		);
		expect(flags).not.toBeNull();
		const parsed = JSON.parse(flags as string);
		expect(parsed).toContain("debug");
	});
});

// ─── Keyboard shortcut ───────────────────────────────────────────────────────

test.describe("Debug Panel — Keyboard Shortcut", () => {
	test("Ctrl+Shift+D toggles the debug feature", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Panel should not be visible initially
		await expect(page.locator(DEBUG_PANEL)).not.toBeAttached();
		await expect(page.locator(DEBUG_BTN)).not.toBeAttached();

		// Press Ctrl+Shift+D to enable
		await page.keyboard.press("Control+Shift+KeyD");

		// Debug panel and bug icon should appear
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(DEBUG_BTN)).toBeVisible();

		// Press again to disable
		await page.keyboard.press("Control+Shift+KeyD");

		// Panel and icon should disappear
		await expect(page.locator(DEBUG_PANEL)).not.toBeAttached({
			timeout: 5_000,
		});
		await expect(page.locator(DEBUG_BTN)).not.toBeAttached();
	});
});

// ─── Settings tab ────────────────────────────────────────────────────────────

test.describe("Debug Panel — Settings Tab", () => {
	test("Settings Debug tab toggles the feature", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Open settings
		await page.locator(SETTINGS_BTN).click();
		await expect(page.locator(SETTINGS_PANEL)).toBeVisible();

		// Switch to Debug tab
		await page.locator(DEBUG_TAB).click();

		// Toggle should be off initially
		const toggle = page.locator(DEBUG_TOGGLE);
		await expect(toggle).toBeVisible();
		await expect(toggle).toHaveAttribute("aria-checked", "false");

		// Turn on
		await toggle.click();
		await expect(toggle).toHaveAttribute("aria-checked", "true");

		// Close settings
		await page.keyboard.press("Escape");

		// Debug panel and bug icon should now be visible
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });
		await expect(page.locator(DEBUG_BTN)).toBeVisible();
	});

	test("Settings toggle reflects URL-activated state", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		// Wait for panel to confirm feature is active
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });

		// Open settings and check toggle state
		await page.locator(SETTINGS_BTN).click();
		await expect(page.locator(SETTINGS_PANEL)).toBeVisible();
		await page.locator(DEBUG_TAB).click();

		await expect(page.locator(DEBUG_TOGGLE)).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
});

// ─── Header bug icon ────────────────────────────────────────────────────────

test.describe("Debug Panel — Header Bug Icon", () => {
	test("bug icon toggles panel visibility", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		// Panel starts visible (auto-shown on activation)
		await expect(page.locator(DEBUG_PANEL)).toBeVisible({ timeout: 5_000 });

		// Close panel via close button
		await page.locator(CLOSE_BTN).click();
		await expect(page.locator(DEBUG_PANEL)).toBeHidden();

		// Re-open via bug icon
		await page.locator(DEBUG_BTN).click();
		await expect(page.locator(DEBUG_PANEL)).toBeVisible();
	});
});

// ─── Panel UI elements ──────────────────────────────────────────────────────

test.describe("Debug Panel — Panel Content", () => {
	test("panel shows status and event log", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		const panel = page.locator(DEBUG_PANEL);
		await expect(panel).toBeVisible({ timeout: 5_000 });

		// Clear button exists
		await expect(page.locator(CLEAR_BTN)).toBeVisible();

		// Close button exists
		await expect(page.locator(CLOSE_BTN)).toBeVisible();

		// Should have logged some connection events (connect, ws:open, etc.)
		// Event entries are rows inside the scrollable log container
		// Wait briefly for events to populate
		await page.waitForTimeout(500);
		const logContainer = panel.locator(".overflow-y-auto");
		await expect(logContainer).toBeVisible();

		// Either there are event rows or "No events yet" — assert events exist
		const noEvents = panel.getByText("No events yet");
		const hasNoEvents = await noEvents.isVisible().catch(() => false);
		expect(hasNoEvents).toBe(false);
	});

	test("clear button resets the event log", async ({ page, relayUrl }) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		const panel = page.locator(DEBUG_PANEL);
		await expect(panel).toBeVisible({ timeout: 5_000 });

		// Wait for at least one event to be logged
		await page.waitForTimeout(500);

		// Click clear
		await page.locator(CLEAR_BTN).click();
		await page.locator('button:has-text("Clear")').last().click();

		// "No events yet" should appear
		await expect(panel.getByText("No events yet")).toBeVisible();
	});

	test("msgs:all toggle reveals additional messages", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(`${relayUrl}?feats=debug`);

		const panel = page.locator(DEBUG_PANEL);
		await expect(panel).toBeVisible({ timeout: 5_000 });
		await app.waitForConnected();

		// Wait for messages to flow through the WebSocket
		await page.waitForTimeout(1_000);

		// Verbose toggle should show "msgs:100" (throttled mode)
		const verboseBtn = page.locator(VERBOSE_BTN);
		await expect(verboseBtn).toHaveText("verbose:off");

		// Count events in throttled mode
		const logContainer = panel.locator(".overflow-y-auto");
		const throttledCount = await logContainer.locator("> div").count();
		expect(throttledCount).toBeGreaterThan(0);

		// Get total events from snapshot (includes throttled messages)
		const totalEvents = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e test
			return (window as any).__wsDebug?.().eventCount;
		});

		// Click to switch to verbose mode
		await verboseBtn.click();
		await expect(verboseBtn).toHaveText("verbose:on");

		// Verbose count should be >= throttled count
		const verboseCount = await logContainer.locator("> div").count();
		expect(verboseCount).toBeGreaterThanOrEqual(throttledCount);

		// If there were non-sampled messages in the buffer, verbose shows more
		if (totalEvents > throttledCount) {
			expect(verboseCount).toBeGreaterThan(throttledCount);
		}

		// Toggle back should restore original count
		await verboseBtn.click();
		await expect(verboseBtn).toHaveText("verbose:off");
		const restoredCount = await logContainer.locator("> div").count();
		expect(restoredCount).toBe(throttledCount);
	});
});

// ─── Console API ─────────────────────────────────────────────────────────────

test.describe("Debug Panel — Console API", () => {
	test("window.__wsDebug() returns a valid snapshot", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// __wsDebug is always registered, even without the debug flag
		const snapshot = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e test
			return (window as any).__wsDebug?.();
		});

		expect(snapshot).toBeDefined();
		expect(snapshot).toHaveProperty("timeInState");
		expect(snapshot).toHaveProperty("eventCount");
		expect(snapshot).toHaveProperty("events");
		expect(typeof snapshot.timeInState).toBe("number");
		expect(typeof snapshot.eventCount).toBe("number");
		expect(Array.isArray(snapshot.events)).toBe(true);
	});

	test("snapshot contains connection events after connect", async ({
		page,
		relayUrl,
	}) => {
		const app = new AppPage(page);
		await app.goto(relayUrl);

		// Wait for connection to establish
		await app.waitForConnected();

		const snapshot = await page.evaluate(() => {
			// biome-ignore lint/suspicious/noExplicitAny: e2e test
			return (window as any).__wsDebug?.();
		});

		expect(snapshot.eventCount).toBeGreaterThan(0);

		// Should have at least a "connect" event
		const eventNames = snapshot.events.map((e: { event: string }) => e.event);
		expect(eventNames).toContain("connect");
	});
});
