import type { Page } from "@playwright/test";
import { initMessages } from "../../test/e2e/fixtures/mockup-state.js";
import {
	mockWsRpc,
	type RpcMockControl,
} from "../../test/e2e/helpers/rpc-mock.js";
import {
	mockRelayWebSocket,
	type WsMockControl,
} from "../../test/e2e/helpers/ws-mock.js";
import { InputPage } from "../../test/e2e/page-objects/input.page.js";
import { PlaywrightDriver } from "./playwrightDriver.js";
import type { AcceptanceLifecycle, StepHandler } from "./runtime.js";
import { currentVisualMode } from "./visualMode.js";

const driver = new PlaywrightDriver();
const relayControls = new WeakMap<Page, WsMockControl>();
const rpcControls = new WeakMap<Page, RpcMockControl>();
const composerMessages = new WeakMap<Page, string>();

function exampleValue(example: Record<string, string>, key: string): string {
	const value = example[key];
	if (value == null) {
		throw new Error(`Missing example value for <${key}>`);
	}
	return value;
}

function booleanExampleValue(
	example: Record<string, string>,
	key: string,
): boolean {
	const value = exampleValue(example, key);
	if (value === "true") return true;
	if (value === "false") return false;
	throw new Error(`Malformed boolean example value for <${key}>: ${value}`);
}

function thresholdExampleValue(
	example: Record<string, string>,
	key: string,
): number {
	const value = exampleValue(example, key);
	const threshold = Number(value);
	if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
		throw new Error(`Malformed visual threshold for <${key}>: ${value}`);
	}
	return threshold;
}

export const conduitVisualHandlers: StepHandler[] = [
	{
		name: "serve conduit with mockup state",
		match: /^the conduit app is served with the ([a-z0-9-]+) mockup$/,
		run: async ({ world, match }) => {
			const mockup = match[1];
			if (mockup !== "connected") {
				throw new Error(`Unsupported conduit mockup: ${mockup ?? ""}`);
			}

			const relayControl = await mockRelayWebSocket(world.page, {
				initMessages,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			relayControls.set(world.page, relayControl);
			const rpcControl = await mockWsRpc(world.page, {
				handlers: {
					SendMessage: async () => undefined,
					SyncInputDraft: async () => undefined,
				},
			});
			rpcControls.set(world.page, rpcControl);

			const baseUrl =
				process.env["CONDUIT_BASE_URL"] ?? "http://localhost:4173";
			try {
				await world.page.goto(new URL("/p/myapp/", baseUrl).toString());
				await world.page.locator("#layout").waitFor({
					state: "attached",
					timeout: 30_000,
				});
				await world.page.locator("#connect-overlay").waitFor({
					state: "hidden",
					timeout: 30_000,
				});
				await world.page.locator("#input").waitFor({
					state: "visible",
					timeout: 10_000,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`INFRASTRUCTURE_ERROR: conduit preview did not become ready: ${message}`,
					{ cause: error },
				);
			}
		},
	},
	{
		name: "type into composer",
		match: /^I type (.*) into the composer$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			composerMessages.set(world.page, message);
			await new InputPage(world.page).type(message);
		},
	},
	{
		name: "send composer message",
		match: /^I send the composer message$/,
		run: async ({ world }) => {
			await new InputPage(world.page).send();
		},
	},
	{
		name: "replay sent message after session switch",
		match: /^the mock relay replays the sent message in a new session$/,
		run: async ({ world }) => {
			const message = composerMessages.get(world.page);
			const rpcControl = rpcControls.get(world.page);
			const relayControl = relayControls.get(world.page);
			if (message == null || !rpcControl || !relayControl) {
				throw new Error("Mock relay controls were not initialised");
			}

			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "SendMessage" && request.payload["text"] === message,
			);
			await relayControl.sendMessages([
				{ type: "session_switched", id: "sess-first-send" },
				{ type: "user_message", text: message },
			]);
		},
	},
	{
		name: "replay subagent session switch",
		match: /^the mock relay replays a session switch with parentID$/,
		run: async ({ world }) => {
			const relayControl = relayControls.get(world.page);
			if (!relayControl) throw new Error("Mock relay was not initialised");
			relayControl.sendMessage({
				type: "session_switched",
				id: "sess-subagent",
				parentID: "sess-mockup-001",
			});
		},
	},
	{
		name: "assert transcript message",
		match: /^the transcript shows (.*)$/,
		run: async ({ world, match }) => {
			const message = match[1] ?? "";
			await world.page
				.locator("#messages")
				.getByText(message, { exact: true })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "assert subagent parent link",
		match: /^the subagent parent link is visible$/,
		run: async ({ world }) => {
			await world.page
				.getByRole("button", { name: /PARENT/ })
				.waitFor({ state: "visible" });
		},
	},
	{
		name: "clear composer",
		match: /^I clear the composer$/,
		run: async ({ world }) => {
			await new InputPage(world.page).type("");
		},
	},
	{
		name: "assert send button state",
		match: /^the send button is (true|false)$/,
		run: async ({ world, example }) => {
			const expectedEnabled = booleanExampleValue(example, "enabled");
			const input = new InputPage(world.page);
			await world.page.waitForFunction(
				(expected) => {
					const send = document.getElementById(
						"send",
					) as HTMLButtonElement | null;
					return send != null && !send.disabled === expected;
				},
				expectedEnabled,
				{ timeout: 2_000 },
			);
			const actualEnabled = await input.sendBtn.isEnabled();
			if (actualEnabled !== expectedEnabled) {
				throw new Error(
					`Expected send button enabled=${expectedEnabled}, got ${actualEnabled}`,
				);
			}
		},
	},
	{
		name: "visually match composer region",
		match:
			/^the ([a-z0-9-]+) region visually matches ([a-z0-9-]+) at ([0-9]+(?:\.[0-9]+)?) percent$/,
		run: async ({ world, match, example }) => {
			const requestedRegion = match[1] ?? "";
			const regionId =
				requestedRegion === "composer" ? "input-area" : requestedRegion;
			const baseline = exampleValue(example, "baseline");
			const threshold = thresholdExampleValue(example, "threshold");
			const result = await world.driver.matchRegion(
				world.page,
				regionId,
				baseline,
				threshold,
				currentVisualMode(),
			);
			if (result.actualPath) world.artifacts.push(result.actualPath);
			if (result.diffPath) world.artifacts.push(result.diffPath);
			if (!result.matches) {
				throw new Error(
					`Visual match failed for ${baseline}: ${(result.diffRatio * 100).toFixed(2)}% of pixels differ. Artifacts: ${world.artifacts.join(", ")}`,
				);
			}
		},
	},
];

export const conduitVisualLifecycle: AcceptanceLifecycle = {
	createWorld: async () => ({
		page: await driver.newExecution(),
		driver,
		artifacts: [],
	}),
	afterScenario: async ({ world, error }) => {
		if (error && world.artifacts.length > 0) {
			process.stderr.write(`Visual artifacts: ${world.artifacts.join(", ")}\n`);
		}
		await world.driver.closeExecution();
	},
	afterFeature: async () => {
		await driver.close();
	},
};
