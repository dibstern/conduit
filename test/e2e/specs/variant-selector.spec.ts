// Tests the effort (thinking-level variant) control: the composer badge opens
// the model picker, whose Effort row lists the model's levels.
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
				const variant = {
					variant: String(params["variant"] ?? ""),
					variants: ["low", "medium", "high", "max"],
				};
				// The app rereads GetModels after a switch, as the server reports it.
				rpc.catalog = { ...rpc.catalog, variant };
				return { projectSlug: "myapp", ...variant };
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

const badge = (page: Page) => page.locator("[data-testid='variant-badge']");
const effortOption = (page: Page, variant: string) =>
	page.locator(`[data-testid='picker-effort-option-${variant}']`);

test.describe("Variant badge visibility", () => {
	test("shows variant badge when model has variants", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		await expect(badge(page)).toBeVisible();
		// Should show "default" when no variant is selected
		await expect(badge(page)).toContainText("Default");
	});

	test("hides variant badge when model has no variants", async ({
		page,
		baseURL,
	}) => {
		await setupWithoutVariants(page, baseURL);

		await expect(badge(page)).not.toBeVisible();
	});
});

/** The badge opens the model picker at its Effort row. */
async function openEffort(page: Page): Promise<void> {
	await badge(page).click();
	await expect(page.locator("[data-testid='picker-row-effort']")).toBeVisible();
}

test.describe("Effort row", () => {
	test("opens on badge click", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);
		await openEffort(page);
	});

	test("lists exactly the model's levels, with no Default", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);
		await openEffort(page);

		for (const variant of ["low", "medium", "high", "max"])
			await expect(effortOption(page, variant)).toBeVisible();
		await expect(
			page.locator("[data-testid^='picker-effort-option-']"),
		).toHaveCount(4);
		await expect(
			page
				.getByRole("radiogroup", { name: "Effort", exact: true })
				.getByRole("radio", { checked: true }),
		).toHaveCount(0);
	});

	test("selecting a level checks it and keeps the picker open", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);
		await openEffort(page);

		await effortOption(page, "high").click();
		await expect(effortOption(page, "high")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.locator("[data-testid='model-picker']")).toBeVisible();
	});

	test("closes on Escape", async ({ page, baseURL }) => {
		await setupWithVariants(page, baseURL);
		await openEffort(page);

		await page.keyboard.press("Escape");
		await expect(page.locator("[data-testid='model-picker']")).toBeHidden();
	});
});

test.describe("Effort selection updates UI", () => {
	test("selecting a level updates the badge label", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);
		await expect(badge(page)).toContainText("Default");

		await openEffort(page);
		await effortOption(page, "high").click();
		await expect(badge(page)).toContainText("High");
	});

	test("selecting another level replaces the previous one", async ({
		page,
		baseURL,
	}) => {
		await setupWithVariants(page, baseURL);

		await openEffort(page);
		await effortOption(page, "max").click();
		await expect(badge(page)).toContainText("Max");

		await effortOption(page, "low").click();
		await expect(badge(page)).toContainText("Low");
		await expect(effortOption(page, "max")).toHaveAttribute(
			"aria-checked",
			"false",
		);
	});

	test("a server-cleared variant restores Default and clears the picker selection", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);
		await openEffort(page);
		await effortOption(page, "max").click();
		await expect(badge(page)).toContainText("Max");
		await expect(badge(page)).toBeEnabled();

		control.sendMessage({
			type: "variant_info",
			variant: "",
			variants: ["low", "medium", "high", "max"],
		});
		await expect(badge(page)).toContainText("Default");
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

test.describe("Effort selection sends RPC request", () => {
	test("selecting a level sends SwitchVariant", async ({ page, baseURL }) => {
		const control = await setupWithVariants(page, baseURL);

		await openEffort(page);
		await effortOption(page, "high").click();

		await expect
			.poll(() => control.rpcCalls.at(-1))
			.toMatchObject({ sessionId: "sess-var-001", variant: "high" });
		expect(control.rpcCalls.at(-1)).not.toHaveProperty("projectSlug");
	});

	test("each selection sends its own SwitchVariant", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		await openEffort(page);
		await effortOption(page, "low").click();
		await expect(badge(page)).toContainText("Low");
		await expect(badge(page)).toBeEnabled();
		await expect
			.poll(() => control.rpcCalls.at(-1))
			.toMatchObject({ sessionId: "sess-var-001", variant: "low" });
		await effortOption(page, "max").click();
		await expect(badge(page)).toContainText("Max");
		await expect(badge(page)).toBeEnabled();
		await expect
			.poll(() => control.rpcCalls.map((call) => call["variant"]))
			.toEqual(["low", "max"]);
	});
});

test.describe("Server-pushed variant updates", () => {
	test("variant_info from server updates the badge", async ({
		page,
		baseURL,
	}) => {
		const control = await setupWithVariants(page, baseURL);

		await expect(badge(page)).toContainText("Default");

		// Server pushes a variant change
		control.sendMessage({
			type: "variant_info",
			variant: "medium",
			variants: ["low", "medium", "high", "max"],
		});

		await expect(badge(page)).toContainText("Medium");
	});
});

test.describe("Ctrl+T keyboard shortcut", () => {
	test("Ctrl+T cycles through variants", async ({ page, baseURL }) => {
		const control = await setupWithVariants(page, baseURL);

		await expect(badge(page)).toContainText("Default");

		// First Ctrl+T: default → low
		await page.keyboard.press("Control+t");
		await expect(badge(page)).toContainText("Low");

		await expect
			.poll(() => control.rpcCalls.find((call) => call["variant"] === "low"))
			.toMatchObject({
				sessionId: "sess-var-001",
				variant: "low",
			});

		// Second Ctrl+T: low → medium
		await page.keyboard.press("Control+t");
		await expect(badge(page)).toContainText("Medium");

		// Third: medium → high
		await page.keyboard.press("Control+t");
		await expect(badge(page)).toContainText("High");

		// Fourth: high → max
		await page.keyboard.press("Control+t");
		await expect(badge(page)).toContainText("Max");

		// Fifth: max → low (wraps without selecting default)
		await page.keyboard.press("Control+t");
		await expect(badge(page)).toContainText("Low");
	});
});
