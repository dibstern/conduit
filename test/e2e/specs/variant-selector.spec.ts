// ─── Variant Selector E2E Tests ──────────────────────────────────────────────
// Tests the thinking-level variant dropdown on the model selector.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import {
	noVariantInitMessages,
	variantInitMessages,
} from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

type Page = import("@playwright/test").Page;
type WsMockControl = Awaited<ReturnType<typeof mockRelayWebSocket>>;

/** The project URL for variant tests (must match fixture's current slug). */
const PROJECT_URL = "/p/myapp/";

/** Wait for the chat page to be ready (WS connected, input visible). */
async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

/** Set up WS mock with variant-enabled model, navigate, wait for ready. */
async function setupWithVariants(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: variantInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

/** Set up WS mock with model that has NO variants. */
async function setupWithoutVariants(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: noVariantInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

// ─── Group 1: Variant Badge Visibility ──────────────────────────────────────

test.describe("Variant badge visibility", () => {
	test("shows variant badge when model has variants", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toBeVisible();
		// Should show "default" when no variant is selected
		await expect(badge).toContainText("default");
	});

	test("hides variant badge when model has no variants", async ({
		page,
		baseURL,
	}) => {
		await setupWithoutVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).not.toBeVisible();
	});
});

// ─── Group 2: Variant Dropdown ──────────────────────────────────────────────

test.describe("Variant dropdown", () => {
	test("opens dropdown on badge click", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		const dropdown = page.locator("[data-testid='variant-dropdown']");
		await expect(dropdown).toBeVisible();
	});

	test("shows all variants plus default option", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		const dropdown = page.locator("[data-testid='variant-dropdown']");
		await expect(dropdown).toBeVisible();

		// Should have: default, low, medium, high, max
		await expect(
			page.locator("[data-testid='variant-option-default']"),
		).toBeVisible();
		await expect(
			page.locator("[data-testid='variant-option-low']"),
		).toBeVisible();
		await expect(
			page.locator("[data-testid='variant-option-medium']"),
		).toBeVisible();
		await expect(
			page.locator("[data-testid='variant-option-high']"),
		).toBeVisible();
		await expect(
			page.locator("[data-testid='variant-option-max']"),
		).toBeVisible();
	});

	test("closes dropdown after selecting a variant", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		// Select "high"
		await page.locator("[data-testid='variant-option-high']").click();

		const dropdown = page.locator("[data-testid='variant-dropdown']");
		await expect(dropdown).not.toBeVisible();
	});

	test("closes dropdown on Escape", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();
		await expect(
			page.locator("[data-testid='variant-dropdown']"),
		).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(
			page.locator("[data-testid='variant-dropdown']"),
		).not.toBeVisible();
	});
});

// ─── Group 3: Variant Selection Updates UI ──────────────────────────────────

test.describe("Variant selection updates UI", () => {
	test("selecting a variant updates the badge label", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("default");

		// Open dropdown and select "high"
		await badge.click();
		await page.locator("[data-testid='variant-option-high']").click();

		// Badge should now show "high"
		await expect(badge).toContainText("high");
	});

	test("selecting default clears the variant", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");

		// Select "max" first
		await badge.click();
		await page.locator("[data-testid='variant-option-max']").click();
		await expect(badge).toContainText("max");

		// Now select "default" to clear
		await badge.click();
		await page.locator("[data-testid='variant-option-default']").click();
		await expect(badge).toContainText("default");
	});
});

// ─── Group 4: Variant Selection Sends Correct WS Message ────────────────────

test.describe("Variant selection sends WS message", () => {
	test("selecting a variant sends switch_variant message", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();
		await page.locator("[data-testid='variant-option-high']").click();

		// Verify the correct WS message was sent
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "switch_variant",
		);
		expect(msg).toMatchObject({
			type: "switch_variant",
			variant: "high",
		});
	});

	test("selecting default sends switch_variant with empty string", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");

		// First select "low"
		await badge.click();
		await page.locator("[data-testid='variant-option-low']").click();

		// Then select "default"
		await badge.click();
		await page.locator("[data-testid='variant-option-default']").click();

		// Find the last switch_variant message (should be the "default" one)
		const msgs = control
			.getClientMessages()
			.filter(
				(m: unknown) =>
					typeof m === "object" &&
					m !== null &&
					(m as { type?: string }).type === "switch_variant",
			);
		expect(msgs.length).toBeGreaterThanOrEqual(2);
		expect(msgs[msgs.length - 1]).toMatchObject({
			type: "switch_variant",
			variant: "",
		});
	});
});

// ─── Group 5: Server-Pushed Variant Updates ─────────────────────────────────

test.describe("Server-pushed variant updates", () => {
	test("variant_info from server updates the badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("default");

		// Server pushes a variant change
		control.sendMessage({
			type: "variant_info",
			variant: "medium",
			variants: ["low", "medium", "high", "max"],
		});

		await expect(badge).toContainText("medium");
	});
});

// ─── Group 6: Ctrl+T Keyboard Shortcut ──────────────────────────────────────

test.describe("Ctrl+T keyboard shortcut", () => {
	test("Ctrl+T cycles through variants", async ({ page, baseURL }) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("default");

		// First Ctrl+T: default → low
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("low");

		// Verify WS message
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "switch_variant" &&
				(m as { variant?: string }).variant === "low",
		);
		expect(msg).toMatchObject({ type: "switch_variant", variant: "low" });

		// Second Ctrl+T: low → medium
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("medium");

		// Third: medium → high
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("high");

		// Fourth: high → max
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("max");

		// Fifth: max → back to default (wraps around)
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("default");
	});
});
