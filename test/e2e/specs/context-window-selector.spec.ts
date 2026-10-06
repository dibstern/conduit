// Tests context-window controls in the harness and model picker.

import { expect, type Page, test } from "@playwright/test";
import {
	contextWindowInitMessages,
	type MockMessage,
	noContextWindowInitMessages,
} from "../fixtures/mockup-state.js";
import { mockWsRpc } from "../helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../helpers/ws-mock.js";

async function waitForChatReady(page: Page): Promise<void> {
	await page.locator("#input").waitFor({ state: "visible", timeout: 10_000 });
	await page.locator(".connect-overlay").waitFor({
		state: "hidden",
		timeout: 10_000,
	});
}

async function setup(
	page: Page,
	baseURL?: string,
	initMessages: MockMessage[] = contextWindowInitMessages,
	sessionId = "sess-context-001",
) {
	const messages = initMessages.map((message) => ({ ...message }));
	const contextInfo = messages.find(
		(message) => message.type === "context_window_info",
	);
	const rpc = await mockWsRpc(page, {
		handlers: {
			SwitchContextWindow: (params) => {
				const contextWindow = String(params["contextWindow"] ?? "");
				if (contextInfo) contextInfo["contextWindow"] = contextWindow;
				return {
					projectSlug: String(params["projectSlug"] ?? "myapp"),
					contextWindow,
					options: contextInfo?.["options"] ?? [],
				};
			},
		},
	});
	const control = await mockRelayWebSocket(page, {
		initMessages: messages,
		responses: new Map(),
		initDelay: 0,
		messageDelay: 0,
	});
	await page.goto(`${baseURL ?? "http://localhost:4173"}/s/${sessionId}`);
	await waitForChatReady(page);
	await rpc.waitForRequest((request) => request.tag === "ViewSession");
	const modelInfo = messages.find((message) => message.type === "model_info");
	if (modelInfo) control.sendMessage({ ...modelInfo, sessionId });
	return { control, rpc, modelInfo, contextInfo };
}

async function openPicker(page: Page): Promise<void> {
	await page.getByTestId("model-picker-trigger").click();
	await expect(page.getByTestId("picker-row-model")).toBeVisible();
}

test.describe("Picker context row", () => {
	test("shows context controls when the active model has options", async ({
		page,
		baseURL,
	}) => {
		await setup(page, baseURL);
		await openPicker(page);

		await expect(page.getByTestId("picker-row-context")).toBeVisible();
		await expect(
			page.getByTestId("picker-context-option-200k"),
		).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/200K/,
		);
	});

	test("omits context controls when no windows are available", async ({
		page,
		baseURL,
	}) => {
		await setup(
			page,
			baseURL,
			noContextWindowInitMessages,
			"sess-context-none-001",
		);
		await openPicker(page);

		await expect(page.getByTestId("picker-row-context")).toHaveCount(0);
		await expect(page.getByTestId("picker-context-usage")).toHaveCount(0);
	});

	test("shows a single context window as static text", async ({
		page,
		baseURL,
	}) => {
		const initMessages = contextWindowInitMessages.map((message) =>
			message.type === "context_window_info"
				? {
						...message,
						options: [{ value: "200k", label: "200K", isDefault: true }],
					}
				: message.type === "mock_model_catalog"
					? { type: "mock_model_catalog", providers: [] }
					: message,
		);
		const { rpc } = await setup(page, baseURL, initMessages);
		await openPicker(page);

		const row = page.getByTestId("picker-row-context");
		await expect(row).toContainText("200K");
		await expect(row.getByRole("radio")).toHaveCount(0);
		await expect(page.getByTestId("picker-context-option-200k")).toHaveCount(0);
		expect(
			rpc
				.getRequests()
				.filter((request) => request.tag === "SwitchContextWindow"),
		).toHaveLength(0);
	});

	test("shows OpenCode's catalog context limit without a selector", async ({
		page,
		baseURL,
	}) => {
		const initMessages = contextWindowInitMessages.filter(
			(message) =>
				!["model_info", "mock_model_catalog", "context_window_info"].includes(
					message.type,
				),
		);
		initMessages.push(
			{ type: "model_info", model: "gpt-5", provider: "openai" },
			{
				type: "mock_model_catalog",
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						configured: true,
						models: [
							{
								id: "gpt-5",
								name: "GPT-5",
								provider: "openai",
								limit: { context: 200_000 },
							},
						],
					},
				],
			},
			{ type: "context_window_info", contextWindow: "", options: [] },
		);
		await setup(page, baseURL, initMessages);
		await openPicker(page);

		const row = page.getByTestId("picker-row-context");
		await expect(row).toContainText("200K");
		await expect(row.getByRole("radio")).toHaveCount(0);
	});
});

test.describe("Picker context selection", () => {
	test("shows the available context windows", async ({ page, baseURL }) => {
		await setup(page, baseURL);
		await openPicker(page);

		await expect(page.getByTestId("picker-context-option-200k")).toContainText(
			"200K",
		);
		await expect(page.getByTestId("picker-context-option-1m")).toContainText(
			"1M (beta)",
		);
		await expect(
			page.getByTestId("picker-row-context").getByRole("radio"),
		).toHaveCount(2);
	});

	test("selecting 1M updates the trigger and keeps the picker open", async ({
		page,
		baseURL,
	}) => {
		const { rpc } = await setup(page, baseURL);
		await openPicker(page);

		await page.getByTestId("picker-context-option-1m").click();

		const request = await rpc.waitForRequest(
			(request) => request.tag === "SwitchContextWindow",
		);
		expect(request.payload).toMatchObject({
			sessionId: "sess-context-001",
			contextWindow: "1m",
		});
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/1M \(beta\)/,
		);
		await expect(page.getByTestId("picker-context-option-1m")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("model-picker")).toBeVisible();
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
	});

	test("switches back to 200K without reopening the picker", async ({
		page,
		baseURL,
	}) => {
		const { rpc } = await setup(page, baseURL);
		await openPicker(page);

		await page.getByTestId("picker-context-option-1m").click();
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/1M \(beta\)/,
		);

		await page.getByTestId("picker-context-option-200k").click();

		await rpc.waitForRequest(
			(request) =>
				request.tag === "SwitchContextWindow" &&
				request.payload["contextWindow"] === "200k",
		);
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/200K/,
		);
		await expect(
			page.getByTestId("picker-context-option-200k"),
		).toHaveAttribute("aria-checked", "true");
		await expect(page.getByTestId("picker-row-model")).toBeVisible();
	});

	test("restores the saved context window after reload", async ({
		page,
		baseURL,
	}) => {
		const { control, rpc, modelInfo, contextInfo } = await setup(page, baseURL);
		await openPicker(page);
		await page.getByTestId("picker-context-option-1m").click();
		await rpc.waitForRequest(
			(request) => request.tag === "SwitchContextWindow",
		);
		await expect(page.getByTestId("picker-context-option-1m")).toHaveAttribute(
			"aria-checked",
			"true",
		);

		await page.reload();
		await waitForChatReady(page);
		await expect
			.poll(
				() =>
					rpc.getRequests().filter((request) => request.tag === "ViewSession")
						.length,
			)
			.toBeGreaterThan(1);
		if (modelInfo)
			control.sendMessage({ ...modelInfo, sessionId: "sess-context-001" });
		if (contextInfo) control.sendMessage(contextInfo);
		await openPicker(page);

		await expect(page.getByTestId("picker-context-option-1m")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/1M \(beta\)/,
		);
	});

	test("context_window_info from the server updates the root selection", async ({
		page,
		baseURL,
	}) => {
		const { control } = await setup(page, baseURL);
		await openPicker(page);

		await expect(
			page.getByTestId("picker-context-option-200k"),
		).toHaveAttribute("aria-checked", "true");

		control.sendMessage({
			type: "context_window_info",
			contextWindow: "1m",
			options: [
				{ value: "200k", label: "200K", isDefault: true },
				{ value: "1m", label: "1M (beta)" },
			],
		});

		await expect(page.getByTestId("picker-context-option-1m")).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(page.getByTestId("model-picker-trigger")).toHaveAccessibleName(
			/1M \(beta\)/,
		);
	});
});
