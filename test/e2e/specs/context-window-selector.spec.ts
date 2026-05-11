// ─── Context Window Selector E2E Tests ──────────────────────────────────────
// Tests the Claude context-window dropdown on the model selector.

import { expect, test } from "@playwright/test";
import {
	contextWindowInitMessages,
	noContextWindowInitMessages,
} from "../fixtures/mockup-state.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;
type WsMockControl = Awaited<ReturnType<typeof mockRelayWebSocket>>;

const PROJECT_URL = "/p/myapp/";

async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

async function setupWithContextOptions(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: contextWindowInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

async function setupWithoutContextOptions(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const control = await mockRelayWebSocket(page, {
		initMessages: noContextWindowInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}${PROJECT_URL}`);
	await waitForChatReady(page);
	return control;
}

test.describe("Context window badge visibility", () => {
	test("shows context window badge when the active model has options", async ({
		page,
		baseURL,
	}) => {
		await setupWithContextOptions(page, baseURL);

		const badge = page.locator("[data-testid='context-window-badge']");
		await expect(badge).toBeVisible();
		await expect(badge).toContainText("200K");
	});

	test("hides context window badge when no options are available", async ({
		page,
		baseURL,
	}) => {
		await setupWithoutContextOptions(page, baseURL);

		await expect(
			page.locator("[data-testid='context-window-badge']"),
		).not.toBeVisible();
	});
});

test.describe("Context window dropdown", () => {
	test("shows all context window options", async ({ page, baseURL }) => {
		await setupWithContextOptions(page, baseURL);

		await page.locator("[data-testid='context-window-badge']").click();

		await expect(
			page.locator("[data-testid='context-window-dropdown']"),
		).toBeVisible();
		await expect(
			page.locator("[data-testid='context-window-option-200k']"),
		).toContainText("200K");
		await expect(
			page.locator("[data-testid='context-window-option-1m']"),
		).toContainText("1M (beta)");
	});

	test("selecting 1M updates the badge and sends switch_context_window", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithContextOptions(page, baseURL);

		const badge = page.locator("[data-testid='context-window-badge']");
		await badge.click();
		await page.locator("[data-testid='context-window-option-1m']").click();

		await expect(badge).toContainText("1M (beta)");
		const msg = await control.waitForClientMessage(
			(m: unknown) =>
				typeof m === "object" &&
				m !== null &&
				(m as { type?: string }).type === "switch_context_window",
		);
		expect(msg).toMatchObject({
			type: "switch_context_window",
			contextWindow: "1m",
		});
	});

	test("context_window_info from server updates the badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithContextOptions(page, baseURL);

		const badge = page.locator("[data-testid='context-window-badge']");
		await expect(badge).toContainText("200K");

		control.sendMessage({
			type: "context_window_info",
			contextWindow: "1m",
			options: [
				{ value: "200k", label: "200K", isDefault: true },
				{ value: "1m", label: "1M (beta)" },
			],
		});

		await expect(badge).toContainText("1M (beta)");
	});
});
