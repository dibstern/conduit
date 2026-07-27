import type { Page } from "@playwright/test";
import {
	claudeBoundSessionMessages,
	claudeInstanceAgents,
	dualDriverProviders,
	openCodeBoundSessionMessages,
	openCodeInstanceAgents,
	unboundInitMessages,
} from "../../test/e2e/fixtures/mockup-state.js";
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
/** Per-page mock instance list — mutated by the Add/Update/Remove RPC handlers
 *  so the SettingsPanel editor and the composer rail see consistent state. */
const mockInstances = new WeakMap<Page, Array<Record<string, unknown>>>();

/** Mirror the relay's makeInstanceId slugging so rail test ids stay stable. */
function instanceSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "") || "instance"
	);
}

/** Map a harness/instance display label (e.g. "OpenCode · Local") to the
 *  default instance id of its driver. */
function instanceIdForLabel(label: string): string {
	const driverName = (label.split("·")[0] ?? label).trim().toLowerCase();
	if (driverName !== "claude" && driverName !== "opencode") {
		throw new Error(`Unknown harness/instance label: ${label}`);
	}
	return driverName;
}

function requireRelayControl(page: Page): WsMockControl {
	const control = relayControls.get(page);
	if (!control) throw new Error("Mock relay was not initialised");
	return control;
}

function requireRpcControl(page: Page): RpcMockControl {
	const control = rpcControls.get(page);
	if (!control) throw new Error("Mock RPC was not initialised");
	return control;
}

async function openModelPicker(page: Page): Promise<void> {
	const picker = page.locator("#model-picker");
	if ((await picker.count()) === 0) {
		await page.getByTestId("model-picker-trigger").click();
	}
	await picker.waitFor({ state: "visible", timeout: 5_000 });
}

async function selectRailInstance(page: Page, label: string): Promise<void> {
	await openModelPicker(page);
	await page
		.getByTestId(`picker-instance-${instanceIdForLabel(label)}`)
		.click();
}

async function ensureAgentDropdownOpen(page: Page): Promise<void> {
	const dropdown = page.getByTestId("agent-dropdown");
	if ((await dropdown.count()) === 0) {
		await page.getByTestId("agent-selector-trigger").click();
	}
	await dropdown.waitFor({ state: "visible", timeout: 5_000 });
}

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
				initMessages: unboundInitMessages,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			relayControls.set(world.page, relayControl);
			const page = world.page;
			mockInstances.set(page, []);
			/** Instance bound by the composer's CreateSession — session-scoped
			 *  GetAgents afterwards returns that harness's agents (mirrors the
			 *  real server, where the created session is bound to the instance). */
			let createdSessionInstance: string | undefined;
			const rpcControl = await mockWsRpc(world.page, {
				handlers: {
					AddInstance: async (payload) => {
						const list = mockInstances.get(page) ?? [];
						const name =
							typeof payload["name"] === "string"
								? payload["name"]
								: "instance";
						const inst: Record<string, unknown> = {
							id: instanceSlug(name),
							name,
							port: typeof payload["port"] === "number" ? payload["port"] : 0,
							managed: payload["managed"] === true,
							status: "healthy",
							restartCount: 0,
							createdAt: 1,
							driver: payload["driver"] === "claude" ? "claude" : "opencode",
							...(typeof payload["configDir"] === "string"
								? { configDir: payload["configDir"] }
								: {}),
						};
						const next = [...list.filter((i) => i["id"] !== inst["id"]), inst];
						mockInstances.set(page, next);
						return { projectSlug: "myapp", instances: next };
					},
					UpdateInstance: async (payload) => {
						const list = mockInstances.get(page) ?? [];
						const next = list.map((i) =>
							i["id"] === payload["instanceId"]
								? {
										...i,
										...(typeof payload["name"] === "string"
											? { name: payload["name"] }
											: {}),
									}
								: i,
						);
						mockInstances.set(page, next);
						return { projectSlug: "myapp", instances: next };
					},
					RemoveInstance: async (payload) => {
						const next = (mockInstances.get(page) ?? []).filter(
							(i) => i["id"] !== payload["instanceId"],
						);
						mockInstances.set(page, next);
						return { projectSlug: "myapp", instances: next };
					},
					SendMessage: async () => undefined,
					SyncInputDraft: async () => undefined,
					SwitchPermissionMode: async (payload) => ({
						projectSlug: "myapp",
						mode: payload["mode"],
					}),
					CreateSession: async (payload) => {
						createdSessionInstance =
							typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: undefined;
						return { projectSlug: "myapp", sessionId: "sess-first-send" };
					},
					GetModels: async () => ({
						projectSlug: "myapp",
						providers: dualDriverProviders,
						active: { model: "claude-sonnet-4", provider: "anthropic" },
					}),
					GetAgents: async (payload) => {
						const instanceId =
							typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: payload["sessionId"] === "sess-first-send"
									? createdSessionInstance
									: undefined;
						const claude = instanceId === "claude";
						return {
							projectSlug: "myapp",
							...(instanceId != null ? { instanceId } : {}),
							providerScope: claude
								? { id: "claude", name: "Claude" }
								: { id: "opencode", name: "OpenCode" },
							agents: claude ? claudeInstanceAgents : openCodeInstanceAgents,
						};
					},
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

			const sendRequest = await rpcControl.waitForRequest(
				(request) =>
					request.tag === "SendMessage" && request.payload["text"] === message,
			);
			// Echo the sender's originId like the real relay: the sending tab
			// ignores its own broadcast and keeps its local echo (no duplicate).
			await relayControl.sendMessages([
				{ type: "session_switched", id: "sess-first-send" },
				{
					type: "user_message",
					text: message,
					originId: sendRequest.payload["originId"],
				},
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
		name: "set approvals mode",
		match: /^I set approvals to (ask|acceptEdits|auto)$/,
		run: async ({ world, match }) => {
			const mode = match[1] ?? "";
			await world.page.getByTestId("permission-mode-badge").click();
			await world.page.getByTestId(`permission-mode-option-${mode}`).click();
		},
	},
	{
		name: "assert approvals pill label",
		match: /^the approvals pill shows (Ask|Edits|All)$/,
		run: async ({ world, match }) => {
			const label = match[1] ?? "";
			await world.page.waitForFunction(
				(expected) => {
					const badge = document.querySelector(
						'[data-testid="permission-mode-badge"]',
					);
					return badge?.textContent?.trim().startsWith(expected) ?? false;
				},
				label,
				{ timeout: 2_000 },
			);
		},
	},
	{
		name: "session exists on harness",
		match: /^a session already exists on the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			const harness = match[1] ?? "";
			const relayControl = requireRelayControl(world.page);
			await relayControl.sendMessages(
				instanceIdForLabel(harness) === "claude"
					? claudeBoundSessionMessages
					: openCodeBoundSessionMessages,
			);
			// Wait until the binding reached the UI (trigger reflects the harness).
			await world.page.waitForFunction(
				(expected) => {
					const trigger = document.querySelector(
						'[data-testid="model-picker-trigger"]',
					);
					return trigger?.getAttribute("data-instance-id") === expected;
				},
				instanceIdForLabel(harness),
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "open model picker",
		match: /^I open the model picker$/,
		run: async ({ world }) => {
			await openModelPicker(world.page);
		},
	},
	{
		name: "select instance in rail",
		match: /^I select the (.+) instance in the rail$/,
		run: async ({ world, match }) => {
			await selectRailInstance(world.page, match[1] ?? "");
		},
	},
	{
		name: "select harness",
		match: /^I select the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			await selectRailInstance(world.page, match[1] ?? "");
			// Close the picker so follow-up steps interact with the toolbar.
			await world.page.keyboard.press("Escape");
			await world.page
				.locator("#model-picker")
				.waitFor({ state: "detached", timeout: 5_000 });
		},
	},
	{
		name: "assert session created on harness",
		match: /^a session is created on the (Claude|OpenCode) harness$/,
		run: async ({ world, match }) => {
			const expected = instanceIdForLabel(match[1] ?? "");
			const rpcControl = requireRpcControl(world.page);
			await rpcControl.waitForRequest(
				(request) =>
					request.tag === "CreateSession" &&
					request.payload["instanceId"] === expected,
			);
		},
	},
	{
		name: "assert model trigger instance icon",
		match: /^the model trigger shows the (Claude|OpenCode) instance icon$/,
		run: async ({ world, match }) => {
			await world.page.waitForFunction(
				(expected) => {
					const trigger = document.querySelector(
						'[data-testid="model-picker-trigger"]',
					);
					const icon = trigger?.querySelector("[data-driver]");
					return (
						trigger?.getAttribute("data-instance-id") === expected &&
						icon?.getAttribute("data-driver") === expected
					);
				},
				instanceIdForLabel(match[1] ?? ""),
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert rail instance selected",
		match: /^the (Claude|OpenCode) instance in the rail is selected$/,
		run: async ({ world, match }) => {
			const id = instanceIdForLabel(match[1] ?? "");
			await world.page.waitForFunction(
				(instanceId) => {
					const button = document.querySelector(
						`[data-testid="picker-instance-${instanceId}"]`,
					);
					return button?.getAttribute("aria-pressed") === "true";
				},
				id,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert other harness instances disabled",
		match: /^instances of other harnesses in the rail are disabled$/,
		run: async ({ world, example }) => {
			const bound = instanceIdForLabel(exampleValue(example, "harness"));
			const result = await world.page.evaluate((boundId) => {
				const buttons = Array.from(
					document.querySelectorAll('[data-testid^="picker-instance-"]'),
				);
				const others = buttons.filter(
					(b) => b.getAttribute("data-driver") !== boundId,
				);
				return {
					otherCount: others.length,
					allDisabled: others.every(
						(b) => b.getAttribute("aria-disabled") === "true",
					),
				};
			}, bound);
			if (result.otherCount === 0) {
				throw new Error("No other-harness instances rendered in the rail");
			}
			if (!result.allDisabled) {
				throw new Error(
					"Expected all other-harness rail instances to be disabled",
				);
			}
		},
	},
	{
		name: "assert agent selector lists agents",
		match: /^the agent selector lists (.+)$/,
		run: async ({ world, match }) => {
			await ensureAgentDropdownOpen(world.page);
			const agentIds = (match[1] ?? "").split(",").map((id) => id.trim());
			for (const agentId of agentIds) {
				await world.page
					.locator(`[data-testid="agent-option-${agentId}"]`)
					.waitFor({ state: "visible", timeout: 5_000 });
			}
		},
	},
	{
		name: "assert agent selector does not list agents",
		match: /^the agent selector does not list (.+)$/,
		run: async ({ world, match }) => {
			await ensureAgentDropdownOpen(world.page);
			const agentIds = (match[1] ?? "").split(",").map((id) => id.trim());
			await world.page.waitForFunction(
				(ids) =>
					ids.every(
						(id) =>
							document.querySelector(`[data-testid="agent-option-${id}"]`) ===
							null,
					),
				agentIds,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "assert agent selector scope label",
		match: /^the agent selector label shows (.+) agents$/,
		run: async ({ world, match }) => {
			await ensureAgentDropdownOpen(world.page);
			const scopeName = match[1] ?? "";
			await world.page.waitForFunction(
				(expected) => {
					const label = document.querySelector(
						'[data-testid="agent-scope-label"]',
					);
					return label?.textContent?.trim() === `${expected} agents`;
				},
				scopeName,
				{ timeout: 5_000 },
			);
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
	{
		name: "open settings to instances tab",
		match: /^I open settings to the Instances tab$/,
		run: async ({ world }) => {
			const page = world.page;
			await page.evaluate(() =>
				window.dispatchEvent(
					new CustomEvent("settings:open", { detail: { tab: "instances" } }),
				),
			);
			await page
				.locator("#settings-panel")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("settings-tab-instances").click();
			await page
				.locator("#instances-settings")
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "start adding a driver instance",
		match: /^I start adding a (OpenCode|Claude) instance$/,
		run: async ({ world, match }) => {
			const driverName = (match[1] ?? "").toLowerCase();
			await world.page.getByTestId("add-instance-btn").click();
			await world.page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await world.page
				.getByTestId(`instance-form-driver-${driverName}`)
				.click();
		},
	},
	{
		name: "add a named instance",
		match: /^I add an? (OpenCode|Claude) instance named (.+)$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const driverName = (match[1] ?? "").toLowerCase();
			const name = (match[2] ?? "").trim();
			await page.getByTestId("add-instance-btn").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId(`instance-form-driver-${driverName}`).click();
			await page.getByTestId("instance-form-name").fill(name);
			await page.getByTestId("instance-form-save").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "hidden", timeout: 5_000 });
			// Close settings so the composer/model-picker is interactable next.
			await page.getByTestId("settings-close-btn").click();
			await page
				.locator("#settings-panel")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "named instance already configured",
		match: /^a named (OpenCode|Claude) instance (.+) is already configured$/,
		run: async ({ world, match }) => {
			const driverName = (match[1] ?? "").toLowerCase();
			const name = (match[2] ?? "").trim();
			const inst: Record<string, unknown> = {
				id: instanceSlug(name),
				name,
				port: driverName === "opencode" ? 4099 : 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
				driver: driverName,
				...(driverName === "claude" ? { configDir: "/profiles/seed" } : {}),
			};
			// Seed BOTH the mock RPC store (so edit/remove RPCs stay consistent)
			// and the live frontend state (via a pushed instance_list).
			const list = [...(mockInstances.get(world.page) ?? []), inst];
			mockInstances.set(world.page, list);
			await requireRelayControl(world.page).sendMessages([
				{ type: "instance_list", instances: list },
			]);
		},
	},
	{
		name: "rename instance via edit",
		match: /^I rename the (.+) instance to (.+) via edit$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = instanceSlug((match[1] ?? "").trim());
			const to = (match[2] ?? "").trim();
			await page.getByTestId(`instance-row-${id}`).click();
			await page.getByTestId("edit-instance-btn").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("instance-form-name").fill(to);
			await page.getByTestId("instance-form-save").click();
			await page
				.getByTestId("instance-form")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "remove instance from settings",
		match: /^I remove the (.+) instance$/,
		run: async ({ world, match }) => {
			const page = world.page;
			const id = instanceSlug((match[1] ?? "").trim());
			await page.getByTestId(`instance-row-${id}`).click();
			await page.getByTestId("remove-instance-btn").click();
			await page
				.locator("#confirm-modal")
				.waitFor({ state: "visible", timeout: 5_000 });
			await page.getByTestId("confirm-modal-action").click();
			await page
				.locator("#confirm-modal")
				.waitFor({ state: "hidden", timeout: 5_000 });
		},
	},
	{
		name: "instances list shows name",
		match: /^the Instances list shows (.+)$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await world.page
				.locator("#instance-settings-list")
				.getByText(name, { exact: true })
				.waitFor({ state: "visible", timeout: 5_000 });
		},
	},
	{
		name: "instances list does not show name",
		match: /^the Instances list does not show (.+)$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await world.page.waitForFunction(
				(n) => {
					const list = document.querySelector("#instance-settings-list");
					return list ? !(list.textContent ?? "").includes(n) : true;
				},
				name,
				{ timeout: 5_000 },
			);
		},
	},
	{
		name: "instance is selectable in the rail",
		match: /^the (.+) instance is selectable in the rail$/,
		run: async ({ world, match }) => {
			const name = (match[1] ?? "").trim();
			await openModelPicker(world.page);
			// Rail buttons are icon-only and keyed by the instance's slug id.
			const railButton = world.page.getByTestId(
				`picker-instance-${instanceSlug(name)}`,
			);
			await railButton.waitFor({ state: "visible", timeout: 5_000 });
			const disabled = await railButton.getAttribute("aria-disabled");
			if (disabled === "true") {
				throw new Error(`Rail instance "${name}" is present but disabled`);
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
