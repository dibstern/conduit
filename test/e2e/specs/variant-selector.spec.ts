// Tests the thinking-level variant dropdown on the model selector.
//
// Uses WS mock — no real OpenCode or relay needed.
// Frontend served by Vite preview, WebSocket intercepted by page.routeWebSocket().

import { expect, test } from "@playwright/test";
import {
	noVariantInitMessages,
	variantInitMessages,
} from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

type Page = import("@playwright/test").Page;
type WsMockControl = Awaited<ReturnType<typeof mockRelayWebSocket>>;
type VariantSetupControl = WsMockControl & {
	readonly rpcCalls: Record<string, unknown>[];
};

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
): Promise<VariantSetupControl> {
	const rpcCalls: Record<string, unknown>[] = [];
	const rpc = await mockWsRpc(page, {
		stubs: {
			SwitchVariant: (params) => {
				rpcCalls.push({ ...params });
				return {
					projectSlug: "myapp",
					variant: String(params["variant"] ?? ""),
					variants: ["low", "medium", "high", "max"],
				};
			},
		},
	});
	const control = await mockRelayWebSocket(page, {
		initMessages: variantInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}/s/sess-var-001`);
	await waitForChatReady(page);
	await rpc.waitForRequest((request) => request.tag === "ViewSession");
	const modelInfo = variantInitMessages.find(
		(message) => message.type === "model_info",
	);
	if (modelInfo)
		control.sendMessage({ ...modelInfo, sessionId: "sess-var-001" });
	return Object.assign(control, { rpcCalls });
}

/** Set up WS mock with model that has NO variants. */
async function setupWithoutVariants(
	page: Page,
	baseURL?: string,
): Promise<WsMockControl> {
	const rpc = await mockWsRpc(page, {
		stubs: {
			SwitchVariant: (params) => ({
				projectSlug: "myapp",
				variant: String(params["variant"] ?? ""),
				variants: [],
			}),
		},
	});
	const control = await mockRelayWebSocket(page, {
		initMessages: noVariantInitMessages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}/s/sess-novar-001`);
	await waitForChatReady(page);
	await rpc.waitForRequest((request) => request.tag === "ViewSession");
	const modelInfo = noVariantInitMessages.find(
		(message) => message.type === "model_info",
	);
	if (modelInfo)
		control.sendMessage({ ...modelInfo, sessionId: "sess-novar-001" });
	return control;
}

test.describe("Variant badge visibility", () => {
	test("shows variant badge when model has variants", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toBeVisible();
		// Should show "default" when no variant is selected
		await expect(badge).toContainText("Default");
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

test.describe("Effort picker", () => {
	test("opens the shared picker on badge click", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		const dropdown = page.getByTestId("model-picker");
		await expect(dropdown).toBeVisible();
	});

	test("offers every provider variant with Default represented by no selection", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		const dropdown = page.getByTestId("model-picker");
		await expect(dropdown).toBeVisible();

		const choices = page.getByRole("radiogroup", {
			name: "Effort",
			exact: true,
		});
		await expect(choices.getByRole("radio")).toHaveText([
			"low",
			"medium",
			"high",
			"max",
		]);
		await expect(choices.getByRole("radio", { checked: true })).toHaveCount(0);
		await expect(
			choices.getByRole("radio", { name: "Default", exact: true }),
		).toHaveCount(0);
	});

	test("keeps the shared picker open after selecting a variant", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();

		// Select "high"
		await page.getByTestId("picker-effort-option-high").click();

		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-effort-option-high")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});

	test("closes dropdown on Escape", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();
		await expect(page.getByTestId("model-picker")).toBeVisible();

		await page.keyboard.press("Escape");
		await expect(page.getByTestId("model-picker")).not.toBeVisible();
	});
});

test.describe("Variant selection updates UI", () => {
	test("selecting a variant updates the badge label", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("Default");

		// Open dropdown and select "high"
		await badge.click();
		await page.getByTestId("picker-effort-option-high").click();

		// Badge should now show "high"
		await expect(badge).toContainText("High");
	});

	test("a server-cleared variant restores Default and clears the picker selection", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");

		// Select "max" first
		await badge.click();
		await page.getByTestId("picker-effort-option-max").click();
		await expect(badge).toContainText("Max");
		await expect(badge).toBeEnabled();

		control.sendMessage({
			type: "variant_info",
			variant: "",
			variants: ["low", "medium", "high", "max"],
		});
		await expect(badge).toContainText("Default");
		await expect(
			page
				.getByRole("radiogroup", { name: "Effort", exact: true })
				.getByRole("radio", { checked: true }),
		).toHaveCount(0);
		expect(control.rpcCalls).toEqual([
			expect.objectContaining({ sessionId: "sess-var-001", variant: "max" }),
		]);
	});
});

test.describe("Variant selection sends RPC request", () => {
	test("selecting a variant sends SwitchVariant request", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await badge.click();
		await page.getByTestId("picker-effort-option-high").click();

		await expect
			.poll(() => control.rpcCalls.at(-1))
			.toMatchObject({
				sessionId: "sess-var-001",
				variant: "high",
			});
		expect(control.rpcCalls.at(-1)).not.toHaveProperty("projectSlug");
	});

	test("explicit effort choices send their values without an implicit default reset", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");

		// First select "low"
		await badge.click();
		await page.getByTestId("picker-effort-option-low").click();
		await expect(badge).toContainText("Low");
		await expect(badge).toBeEnabled();

		await page.getByTestId("picker-effort-option-high").click();
		await expect(badge).toContainText("High");
		await expect(badge).toBeEnabled();

		await expect
			.poll(() => control.rpcCalls.at(-1))
			.toMatchObject({
				sessionId: "sess-var-001",
				variant: "high",
			});
		expect(control.rpcCalls).toEqual([
			expect.objectContaining({
				sessionId: "sess-var-001",
				variant: "low",
			}),
			expect.objectContaining({
				sessionId: "sess-var-001",
				variant: "high",
			}),
		]);
	});
});

test.describe("Server-pushed variant updates", () => {
	test("variant_info from server updates the badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("Default");

		// Server pushes a variant change
		control.sendMessage({
			type: "variant_info",
			variant: "medium",
			variants: ["low", "medium", "high", "max"],
		});

		await expect(badge).toContainText("Medium");
	});
});

test.describe("Ctrl+T keyboard shortcut", () => {
	test("Ctrl+T cycles through variants", async ({ page, baseURL }) => {
		const control = await setupWithVariants(page, baseURL);

		const badge = page.locator("[data-testid='variant-badge']");
		await expect(badge).toContainText("Default");

		// First Ctrl+T: default → low
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("Low");

		await expect
			.poll(() => control.rpcCalls.find((call) => call["variant"] === "low"))
			.toMatchObject({
				sessionId: "sess-var-001",
				variant: "low",
			});

		// Second Ctrl+T: low → medium
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("Medium");

		// Third: medium → high
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("High");

		// Fourth: high → max
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("Max");

		// Fifth: max → low (wraps without selecting default)
		await page.keyboard.press("Control+t");
		await expect(badge).toContainText("Low");
	});
});
