import type { Page } from "@playwright/test";
import {
	claudeInstanceAgents,
	dualDriverProviders,
	modelExecutionMockups,
	modelExecutionProviders,
	openCodeInstanceAgents,
	unboundInitMessages,
} from "../../../test/e2e/fixtures/mockup-state.js";
import { mockWsRpc } from "../../../test/e2e/helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import type { StepHandler } from "../runtime.js";
import {
	detailFeeds,
	inheritedClaudeCommitAttribution,
	instanceSlug,
	mockInstances,
	mockSessionSkills,
	relayControls,
	rpcControls,
} from "./shared.js";

const mockClaudeSettings = new WeakMap<Page, Record<string, unknown>>();

export const mockAppHandlers: StepHandler[] = [
	{
		name: "serve conduit with mockup state",
		match: /^the conduit app is served with the ([a-z0-9-]+) mockup$/,
		run: async ({ world, match }) => {
			const mockup = match[1];
			const modelExecutionMockup =
				mockup != null && mockup in modelExecutionMockups
					? modelExecutionMockups[mockup as keyof typeof modelExecutionMockups]
					: undefined;
			if (mockup !== "connected" && !modelExecutionMockup) {
				throw new Error(`Unsupported conduit mockup: ${mockup ?? ""}`);
			}

			const relayControl = await mockRelayWebSocket(world.page, {
				initMessages: modelExecutionMockup?.initMessages ?? unboundInitMessages,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			relayControls.set(world.page, relayControl);
			const page = world.page;
			mockInstances.set(page, []);
			mockClaudeSettings.set(page, { autoCompactEnabled: true });
			/** Instance bound by the composer's CreateSession — session-scoped
			 *  GetAgents afterwards returns that harness's agents (mirrors the
			 *  real server, where the created session is bound to the instance). */
			let createdSessionInstance: string | undefined;
			const rpcControl = await mockWsRpc(world.page, {
				handlers: {
					CreatePty: async () => ({ ok: true }),
					ResolveSession: async () => ({ projectSlug: "myapp" }),
					ViewSession: async () => ({ ok: true }),
					GetClaudeSettings: async () => ({
						projectSlug: "myapp",
						overrides: mockClaudeSettings.get(page) ?? {},
					}),
					SetClaudeSettings: async (payload) => {
						const overrides =
							typeof payload["overrides"] === "object" &&
							payload["overrides"] !== null
								? (payload["overrides"] as Record<string, unknown>)
								: {};
						mockClaudeSettings.set(page, overrides);
						relayControl.sendMessage({
							type: "claude_settings_info",
							overrides,
						});
						return { projectSlug: "myapp", overrides };
					},
					SetDefaultPermissionMode: async (payload) => ({
						projectSlug: "myapp",
						mode: payload["mode"],
					}),
					SetDefaultModel: async (payload) => ({
						projectSlug: "myapp",
						model: payload["model"],
						provider: payload["provider"],
					}),
					ReloadProviderSession: async (payload) => ({
						projectSlug: "myapp",
						sessionId: payload["sessionId"],
					}),
					ResolveClaudeSettings: async (payload) => ({
						projectSlug: "myapp",
						instanceId:
							typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: "claude",
						resolved: {
							alwaysThinkingEnabled: {},
							attribution: {
								value: { commit: inheritedClaudeCommitAttribution },
								source: "user",
								path: "/profiles/work/settings.json",
							},
							autoCompactEnabled: {
								value: true,
								source: "user",
								path: "/profiles/work/settings.json",
							},
							autoCompactWindow: {
								value: 12_000,
								source: "managed",
								path: "/Library/Application Support/ClaudeCode/managed-settings.json",
							},
							cleanupPeriodDays: {},
							disableAllHooks: {
								value: false,
								source: "user",
								path: "/profiles/work/settings.json",
							},
						},
					}),
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
					SendMessage: async (payload) => ({
						ok: true,
						sessionId: payload["sessionId"],
					}),
					SyncInputDraft: async () => undefined,
					GetSessionSkills: async () => ({
						loads: mockSessionSkills.get(page) ?? [],
					}),
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
						providers: modelExecutionMockup
							? modelExecutionProviders
							: dualDriverProviders,
						active: modelExecutionMockup
							? { model: "opus[1m]", provider: "claude" }
							: { model: "claude-sonnet-4", provider: "anthropic" },
						...(modelExecutionMockup
							? { modelExecution: modelExecutionMockup.modelExecution }
							: {}),
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
			rpcControl.detailFeed = detailFeeds.get(world.page) ?? "synchronize";

			const baseUrl =
				process.env["CONDUIT_BASE_URL"] ?? "http://localhost:4173";
			const initialShell = modelExecutionMockup?.initMessages.find(
				(message) => message.type === "shell_snapshot",
			);
			const shellSessions = initialShell?.["sessions"];
			const initialSession = Array.isArray(shellSessions)
				? shellSessions[0]?.id
				: undefined;
			const initialPath =
				typeof initialSession === "string"
					? `/s/${encodeURIComponent(initialSession)}`
					: "/?p=myapp";
			try {
				await world.page.goto(new URL(initialPath, baseUrl).toString());
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
				if (modelExecutionMockup) {
					await rpcControl.waitForRequest(
						(request) => request.tag === "GetModels",
					);
					await world.page
						.getByTestId("model-picker-trigger")
						.getByText("Opus", { exact: true })
						.waitFor({ state: "visible", timeout: 5_000 });
					// A feed that never synchronizes never renders the transcript.
					if (rpcControl.detailFeed === "synchronize")
						await world.page
							.locator("#messages")
							.getByText(modelExecutionMockup.transcriptText, { exact: true })
							.waitFor({ state: "visible", timeout: 5_000 });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`INFRASTRUCTURE_ERROR: conduit preview did not become ready: ${message}`,
					{ cause: error },
				);
			}
		},
	},
];
