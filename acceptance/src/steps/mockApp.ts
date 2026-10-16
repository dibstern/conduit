import { expect, type Page } from "@playwright/test";
import type { ClaudeSettingsOverrides } from "../../../src/lib/contracts/claude-settings.js";
import { WsRpcError } from "../../../src/lib/contracts/ws-rpc.js";
import type {
	HistoryMessage,
	SessionGit,
} from "../../../src/lib/shared-types.js";
import {
	claudeInstanceAgents,
	dualDriverProviders,
	modelExecutionMockups,
	modelExecutionProviders,
	openCodeInstanceAgents,
	unboundInitMessages,
} from "../../../test/e2e/fixtures/mockup-state.js";
import { mockDetailPage } from "../../../test/e2e/helpers/detail-projection-mock.js";
import { mockWsRpc } from "../../../test/e2e/helpers/rpc-mock.js";
import { mockRelayWebSocket } from "../../../test/e2e/helpers/ws-mock.js";
import { PINNED_CLOCK_MS } from "../playwrightDriver.js";
import type { StepHandler } from "../runtime.js";
import {
	createSessionDelays,
	detailFeeds,
	effortOptions,
	inheritedClaudeCommitAttribution,
	instanceSlug,
	mockInstances,
	mockSessionSkills,
	openSessionRoute,
	rejectedEffortSwitches,
	relayControls,
	requireRpcControl,
	rpcControls,
	serveModelCatalog,
	setSessionRowStatus,
} from "./shared.js";

const mockClaudeSettings = new WeakMap<Page, ClaudeSettingsOverrides>();
/** GetAgents replies wait on this until the provider lookup answers. */
const heldAgentLookups = new WeakMap<
	Page,
	{ promise: Promise<void>; resolve: () => void }
>();
const heldModelLookups = new WeakMap<
	Page,
	{ promise: Promise<void>; resolve: () => void }
>();

// The detail mock sends the last 50 messages first. Turn 3 needs two older pages.
const skillNavigationMessages = Array.from(
	{ length: 64 },
	(_, index): HistoryMessage[] => {
		const turn = index + 1;
		const userId = `msg-skill-nav-user-${turn}`;
		const created = PINNED_CLOCK_MS - 5 * 60_000 + turn * 1000;
		return [
			{
				id: userId,
				role: "user",
				time: { created },
				parts: [
					{
						id: `part-skill-nav-user-${turn}`,
						type: "text",
						text:
							turn === 42
								? "/user-skill Check navigation to my prompt"
								: `Navigation transcript turn ${turn}`,
					},
				],
			},
			{
				id: `msg-skill-nav-agent-${turn}`,
				role: "assistant",
				parentID: userId,
				time: { created: created + 1, completed: created + 900 },
				parts: [
					...(turn <= 3
						? [
								{
									id: `part-skill-nav-skill-${turn}`,
									type: "tool" as const,
									tool: "Skill",
									callID: `call-skill-nav-${turn}`,
									state: {
										status: "completed" as const,
										input: {
											_tag: "whole" as const,
											value: { tool: "Skill", name: "paged-skill" },
										},
										output: { _tag: "whole" as const, text: "Loaded." },
									},
									time: { start: created + 1, end: created + 500 },
								},
							]
						: []),
					{
						id: `part-skill-nav-reply-${turn}`,
						type: "text",
						text: `Reviewed transcript turn ${turn}.`,
					},
				],
				modelExecution: modelExecutionMockups["long-transcript"].modelExecution,
			},
		];
	},
).flat();

const skillNavigationMockup = {
	...modelExecutionMockups["long-transcript"],
	transcriptText: "Navigation transcript turn 64",
	initMessages: modelExecutionMockups["long-transcript"].initMessages.map(
		(message) =>
			message.type === "mock_transcript_snapshot"
				? {
						...message,
						history: { messages: skillNavigationMessages, hasMore: true },
					}
				: message,
	),
};

export const mockAppHandlers: StepHandler[] = [
	{
		name: "publish OpenCode instance status",
		match:
			/^the OpenCode instance (\S+) has (healthy|starting|unhealthy|stopped) status$/,
		run: ({ world, match }) => {
			const instances = mockInstances.get(world.page) ?? [];
			if (
				!instances.some(
					(instance) =>
						instance["id"] === match[1] && instance["driver"] === "opencode",
				)
			)
				throw new Error(`Missing OpenCode instance ${match[1]}`);
			const next = instances.map((instance) =>
				instance["id"] === match[1]
					? { ...instance, status: match[2] }
					: instance,
			);
			mockInstances.set(world.page, next);
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances: next,
			});
		},
	},
	{
		name: "seed the composer checkout through project and session subscriptions",
		match:
			/^the composer checkout is (.+) \/ (.+) as (worktree|branch|detached|folder)$/,
		run: ({ world, match }) => {
			const project = match[1] ?? "";
			const branch = match[2] ?? "";
			const kind = match[3];
			const git: SessionGit | undefined =
				kind === "folder"
					? undefined
					: kind === "detached"
						? { head: branch }
						: {
								branch,
								...(kind === "worktree" ? { worktree: project } : {}),
							};
			const projects = [
				{
					slug: "myapp",
					title: project,
					folders: [`/workspace/${project}`],
					...(git ? { git } : {}),
				},
			];
			const rpc = requireRpcControl(world.page);
			rpc.setDaemonList("SubscribeProjects", { projects });
			rpc.setResponse("GetProjects", { projects, current: "myapp" });
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Checkout requires an open session");
			setSessionRowStatus(world.page, sessionId, "idle", {
				workspace: null,
				git,
			});
		},
	},
	{
		name: "report uncommitted, upstream and operation state on the session shell",
		match:
			/^the checkout has uncommitted changes, (\d+) ahead, (\d+) behind( and a rebase in progress)?$/,
		run: ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Checkout requires an open session");
			const rpc = requireRpcControl(world.page);
			const row = rpc.shellRows?.find(
				(candidate) => (candidate as { id?: string }).id === sessionId,
			) as { git?: SessionGit } | undefined;
			setSessionRowStatus(world.page, sessionId, "idle", {
				git: {
					...row?.git,
					dirty: true,
					ahead: Number(match[1]),
					behind: Number(match[2]),
					...(match[3] ? { operation: "rebase" as const } : {}),
				},
			});
		},
	},
	{
		name: "report a workspace warning through the session shell",
		match: /^the session has a workspace (hint|mismatch) at (.+)$/,
		run: ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Workspace warning requires a session");
			const path = match[2] ?? "";
			const rpc = requireRpcControl(world.page);
			setSessionRowStatus(world.page, sessionId, "idle", {
				...(match[1] === "hint"
					? { workspaceHint: path }
					: { workspaceMismatch: { actualPath: path } }),
			});
			rpc.setHandler("MoveSessionWorkspace", ({ path: target }) => {
				setSessionRowStatus(world.page, sessionId, "idle", {
					workspaceHint: undefined,
					workspaceMismatch: undefined,
				});
				return { projectSlug: "myapp", directory: target };
			});
			rpc.setHandler("DismissWorkspaceHint", () => {
				setSessionRowStatus(world.page, sessionId, "idle", {
					workspaceHint: undefined,
				});
				return { ok: true };
			});
		},
	},
	{
		name: "bind the words session to a named OpenCode instance",
		match: /^the words session uses the OpenCode instance (.+)$/,
		run: async ({ world, match }) => {
			const sessionId = new URL(world.page.url()).pathname.split("/")[2];
			if (!sessionId) throw new Error("Instance binding requires a session");
			const instanceId = instanceSlug(match[1] ?? "");
			setSessionRowStatus(world.page, sessionId, "idle", {
				accountId: instanceId,
				resumes: [{ at: PINNED_CLOCK_MS, instanceId, reason: "user" }],
			});
			requireRpcControl(world.page).setStubs({
				GetAgents: () => ({
					projectSlug: "myapp",
					instanceId,
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: openCodeInstanceAgents,
					activeAgentId: "build",
				}),
			});
			await openSessionRoute(world.page, sessionId);
			await expect(
				world.page.locator("#input-area").getByTestId("harness-logo"),
			).toHaveAttribute("data-account", instanceId);
		},
	},
	{
		name: "configure picker Harness choices through mock subscriptions",
		match: /^the configured Harness choices are (.+)$/,
		run: async ({ world, match }) => {
			const available = {
				Claude: "claude",
				OpenCode: "opencode",
				Codex: "codex",
				Gemini: "gemini",
				Cursor: "cursor",
			} as const;
			const configured = (match[1] ?? "").split(", ").map((label) => {
				const entry = Object.entries(available).find(
					([name]) => name === label,
				);
				if (!entry) throw new Error(`Unknown mock Harness: ${label}`);
				return entry;
			});
			const instances = configured.map(([name, driver]) => ({
				id: driver,
				name,
				driver,
				isDefault: true,
				usageEligible: driver === "claude",
				port: driver === "opencode" ? 4096 : 0,
				managed: false,
				status: "healthy",
				restartCount: 0,
				createdAt: 1,
			}));
			mockInstances.set(world.page, instances);
			requireRpcControl(world.page).setDaemonList("SubscribeInstances", {
				instances,
			});
			const drivers = configured.map(([, driver]) => driver);
			const active = drivers.includes("claude")
				? { model: "claude-sonnet-4-5", provider: "claude" }
				: { model: "claude-sonnet-4", provider: "anthropic" };
			await serveModelCatalog(world.page, {
				providers: dualDriverProviders.filter((provider) =>
					drivers.includes(provider.id === "claude" ? "claude" : "opencode"),
				),
				active,
			});
			// The project's default model, not GetModels' active pick, picks a draft's harness.
			requireRpcControl(world.page).setProjectSetting({
				_tag: "defaultModel",
				...active,
				variant: "",
			});
		},
	},
	{
		name: "open a session on a named future-driver instance",
		match: /^a session is bound to the Codex instance (\S+)$/,
		run: async ({ world, match }) => {
			const instanceId = match[1] ?? "";
			const instances = (mockInstances.get(world.page) ?? []).map((instance) =>
				instance["driver"] === "codex"
					? { ...instance, id: instanceId, name: "Codex work" }
					: instance,
			);
			mockInstances.set(world.page, instances);
			const rpc = requireRpcControl(world.page);
			rpc.setDaemonList("SubscribeInstances", { instances });
			rpc.setStubs({
				GetAgents: () => ({
					projectSlug: "myapp",
					instanceId,
					providerScope: { id: "codex", name: "Codex" },
					agents: [],
				}),
			});
			const sessionId = "sess-bound-codex";
			const getModels = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			rpc.setStubs({
				GetModels: async (payload) => {
					const response = await getModels(payload);
					return {
						...response,
						...("sessionId" in payload && payload.sessionId === sessionId
							? { instanceId }
							: {}),
					};
				},
			});
			rpc.upsertShellRow({
				id: sessionId,
				title: "Codex session",
				accountId: instanceId,
				status: "idle",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, sessionId);
			await rpc.waitForRequest(
				(request) =>
					request.tag === "GetAgents" &&
					request.payload["sessionId"] === sessionId,
			);
		},
	},
	{
		name: "open a session before its stored pick replies",
		match:
			/^I open the (Claude|OpenCode) session before its stored pick replies$/,
		run: async ({ world, match }) => {
			let resolve = () => {};
			const promise = new Promise<void>((settle) => {
				resolve = settle;
			});
			heldModelLookups.set(world.page, { promise, resolve });
			const sessionId =
				match[1] === "Claude" ? "sess-bound-claude" : "sess-bound-opencode";
			requireRpcControl(world.page).upsertShellRow({
				id: sessionId,
				title: `${match[1]} session`,
				status: "idle",
				accountId: match[1] === "Claude" ? "claude" : "opencode",
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, sessionId);
		},
	},
	{
		name: "open a stored session pick without catalog offers",
		match:
			/^the (Claude|OpenCode) session has a stored pick without a catalog$/,
		run: async ({ world, match }) => {
			const claude = match[1] === "Claude";
			const instanceId = claude ? "claude" : "opencode";
			const sessionId = `sess-bound-${instanceId}`;
			const rpc = requireRpcControl(world.page);
			const previous = rpc.stubs.GetModels ?? rpc.catalogStubs().GetModels;
			rpc.setStubs({
				GetModels: (payload) =>
					!("sessionId" in payload) || payload.sessionId !== sessionId
						? previous(payload)
						: {
								defaultOpenCodeInstanceId: "opencode",
								projectSlug: "myapp",
								instanceId,
								providers: [],
								active: {
									model: claude ? "sonnet" : "nemotron-3-super-free",
									provider: instanceId,
								},
								variant: { variant: "high", variants: [] },
								contextWindow: {
									contextWindow: claude ? "200k" : "",
									options: [],
								},
							},
			});
			rpc.upsertShellRow({
				id: sessionId,
				title: `${match[1]} offline session`,
				status: "idle",
				accountId: instanceId,
				updatedAt: PINNED_CLOCK_MS,
			});
			await openSessionRoute(world.page, sessionId);
			await expect(
				world.page.getByTestId("model-picker-trigger").first(),
			).toHaveAttribute("data-instance-id", instanceId);
		},
	},
	{
		name: "assert the session pick with no offered choices",
		match:
			/^the session picker shows (\S+) from (\S+) with high effort and (\S+) context without offered choices$/,
		run: async ({ world, match }) => {
			const trigger = world.page
				.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				)
				.first();
			await expect(trigger).toHaveAttribute("data-shown-model", match[1] ?? "");
			await expect(trigger).toHaveAttribute(
				"data-shown-provider",
				match[2] ?? "",
			);
			await expect(trigger).toHaveAttribute("data-shown-effort", "high");
			await expect(trigger).toHaveAttribute(
				"data-shown-context-window",
				match[3] === "none" ? "" : (match[3] ?? ""),
			);
			const effortRow = world.page.getByTestId("picker-row-effort");
			await expect(effortRow).toContainText("high");
			await expect(effortRow).toHaveAttribute("aria-disabled", "true");
			await expect(effortRow.getByRole("radio")).toHaveCount(0);
			if (match[3] !== "none") {
				await expect(
					world.page.getByTestId("picker-row-context"),
				).toContainText(match[3] ?? "");
			}
		},
	},
	{
		name: "assert stored effort without offered choices in each composer tier",
		match:
			/^the (wide|narrow|phone) (icons|words) composer shows its stored effort without offered choices$/,
		run: async ({ world, match }) => {
			if (match[1] === "phone" && match[2] === "icons") {
				await expect(world.page.getByTestId("picker-row-effort")).toContainText(
					/high/i,
				);
				return;
			}
			const control = world.page
				.getByTestId(
					match[2] === "words" ? "composer-word-effort" : "variant-badge",
				)
				.first();
			await expect(control).toBeVisible();
			await expect(control).toBeDisabled();
			await expect(control).toContainText(/high/i);
		},
	},
	{
		name: "assert neutral session loading",
		match: /^the session composer shows a neutral loading state$/,
		run: async ({ world }) => {
			const trigger = world.page
				.locator(
					'[data-testid="model-picker-trigger"]:visible, [data-testid="composer-word-model"]:visible',
				)
				.first();
			for (const field of [
				"harness",
				"provider",
				"model",
				"effort",
				"context-window",
			]) {
				await expect(trigger).toHaveAttribute(`data-shown-${field}`, "");
			}
			await expect(
				world.page.locator('#input-area [data-testid="harness-logo"]'),
			).toHaveCount(0);
			await expect(trigger).toBeDisabled();
		},
	},
	{
		name: "release stored session pick",
		match: /^the session's stored pick replies$/,
		run: ({ world }) => {
			const held = heldModelLookups.get(world.page);
			if (!held) throw new Error("No stored session pick is held");
			held.resolve();
		},
	},
	{
		name: "hold the session's provider lookup",
		match: /^the session's provider lookup is held$/,
		run: ({ world }) => {
			let resolve = () => {};
			const promise = new Promise<void>((settle) => {
				resolve = settle;
			});
			heldAgentLookups.set(world.page, { promise, resolve });
		},
	},
	{
		name: "release the session's provider lookup",
		match: /^the session's provider lookup answers$/,
		run: ({ world }) => {
			const held = heldAgentLookups.get(world.page);
			if (!held) throw new Error("No provider lookup is held");
			held.resolve();
		},
	},
	{
		name: "serve conduit with mockup state",
		match: /^the conduit app is served with the ([a-z0-9-]+) mockup$/,
		run: async ({ world, match }) => {
			const mockup = match[1];
			const modelRequired = mockup === "model-required";
			const modelExecutionMockup =
				mockup === "skill-navigation"
					? skillNavigationMockup
					: mockup != null && mockup in modelExecutionMockups
						? modelExecutionMockups[
								mockup as keyof typeof modelExecutionMockups
							]
						: undefined;
			if (mockup !== "connected" && !modelRequired && !modelExecutionMockup) {
				throw new Error(`Unsupported conduit mockup: ${mockup ?? ""}`);
			}
			const providers = modelExecutionMockup
				? modelExecutionProviders
				: dualDriverProviders;

			const relayControl = await mockRelayWebSocket(world.page, {
				initMessages: modelExecutionMockup?.initMessages ?? unboundInitMessages,
				responses: new Map(),
				initDelay: 0,
				messageDelay: 0,
			});
			relayControls.set(world.page, relayControl);
			const page = world.page;
			// Account rows come from configured accounts, independently of cached models.
			const initialInstances = [
				{
					id: "claude",
					name: "Claude",
					driver: "claude",
					isDefault: true,
					usageEligible: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
				{
					id: "opencode",
					name: "OpenCode",
					driver: "opencode",
					isDefault: true,
					port: 4096,
					managed: true,
					status: "healthy",
					restartCount: 0,
					createdAt: 1,
				},
			];
			mockInstances.set(page, initialInstances);
			mockClaudeSettings.set(page, { autoCompactEnabled: true });
			const sessionVariants = new Map<string, string>();
			/** Instance bound by the composer's CreateSession — session-scoped
			 *  GetAgents afterwards returns that harness's agents (mirrors the
			 *  real server, where the created session is bound to the instance). */
			let createdSessionInstance: string | undefined;
			const sessionInstance = (sessionId: string | undefined) => {
				const row = rpcControls
					.get(page)
					?.shellRows?.find(
						(candidate) => (candidate as { id?: string }).id === sessionId,
					) as
					| {
							accountId?: string | null;
							resumes?: readonly { instanceId: string }[];
					  }
					| undefined;
				return (
					row?.accountId ??
					row?.resumes?.at(-1)?.instanceId ??
					(sessionId === "sess-first-send"
						? createdSessionInstance
						: [
									"sess-bound-claude",
									"sess-claude-settings",
									"sess-side-new",
									"sess-side-reply",
									"sess-side-unread",
									"sess-side-idle",
								].includes(String(sessionId))
							? "claude"
							: sessionId === "sess-bound-opencode" ||
									sessionId === "sess-mockup-001" ||
									sessionId === "sess-subagent"
								? "opencode"
								: modelExecutionMockup && sessionId
									? "claude"
									: undefined)
				);
			};
			const rpcControl = await mockWsRpc(world.page, {
				streams: {
					SubscribePtys: () => [
						{ _tag: "snapshot", rows: [] },
						{ _tag: "synchronized" },
					],
				},
				stubs: {
					ResolveSession: async () => ({ projectSlug: "myapp" }),
					ViewSession: async () => ({ ok: true }),
					CreateSession: async (payload) => {
						await new Promise((resolve) =>
							setTimeout(resolve, createSessionDelays.get(page) ?? 0),
						);
						createdSessionInstance =
							typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: undefined;
						rpcControl.upsertShellRow({
							id: "sess-first-send",
							accountId: createdSessionInstance ?? null,
							title: "New session",
							status: "idle",
							projectSlug: "myapp",
							updatedAt: PINNED_CLOCK_MS,
						});
						return { projectSlug: "myapp", sessionId: "sess-first-send" };
					},
					LoadMoreHistory: ({ sessionId, before }) => ({
						projectSlug: "myapp",
						sessionId,
						...mockDetailPage(page, sessionId, before),
					}),
					"input.submit": async ({ sessionId }) => ({
						ok: true,
						sessionId,
						handedOff: true,
					}),
					SyncInputDraft: async () => ({ ok: true }),
					SetDefaultPermissionMode: async (payload) => ({
						projectSlug: "myapp",
						mode: payload["mode"],
					}),
					SetDefaultModel: async (payload) => ({
						projectSlug: "myapp",
						model: payload["model"],
						provider: payload["provider"],
						variant: "",
						variants: [],
					}),
					GetSessionSkills: async () => ({
						loads: mockSessionSkills.get(page) ?? [],
					}),
					GetSkillContent: async (payload) => ({
						projectSlug:
							"projectSlug" in payload ? payload.projectSlug : "myapp",
						name: String(payload["name"] ?? ""),
						path: ".agents/skills/paged-skill/SKILL.md",
						content:
							"---\nname: paged-skill\ndescription: A navigation fixture\n---\n# Skill instructions\n\nReview the earlier runs before continuing.\n",
					}),
					SwitchPermissionMode: async (payload) => ({
						projectSlug: "myapp",
						mode: payload["mode"],
					}),
					SwitchVariant: async (payload) => {
						if (rejectedEffortSwitches.delete(page)) {
							throw new WsRpcError({
								message: "Effort switch rejected by the provider",
							});
						}
						sessionVariants.set(
							String(payload["sessionId"]),
							String(payload["variant"] ?? ""),
						);
						return {
							projectSlug: "myapp",
							variant: payload["variant"],
							variants: effortOptions.get(page) ?? [],
						};
					},
					GetModels: async (payload) => {
						const sessionId =
							"sessionId" in payload ? payload.sessionId : undefined;
						if (sessionId) await heldModelLookups.get(page)?.promise;
						const instanceId = sessionId
							? sessionInstance(sessionId)
							: typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: undefined;
						const claude = mockInstances
							.get(page)
							?.some(
								(instance) =>
									instance["id"] === instanceId &&
									instance["driver"] === "claude",
							);
						// Each server read refreshes Claude discovery on the settings stream.
						if (claude && instanceId)
							rpcControl.setProjectSetting({
								_tag: "providerModels",
								accountId: instanceId,
								providers: providers.filter(
									(provider) => provider.id === "claude",
								),
							});
						return {
							defaultOpenCodeInstanceId: "opencode",
							projectSlug: "myapp",
							...(instanceId ? { instanceId } : {}),
							providers:
								!sessionId && payload["instanceId"] && claude
									? []
									: providers.filter((provider) => provider.id !== "claude"),
							active:
								modelRequired && !sessionId
									? undefined
									: modelExecutionMockup
										? { model: "opus[1m]", provider: "claude" }
										: claude
											? { model: "claude-sonnet-4-5", provider: "claude" }
											: { model: "claude-sonnet-4", provider: "anthropic" },
							...(modelExecutionMockup
								? { modelExecution: modelExecutionMockup.modelExecution }
								: {}),
							variant: {
								variant: sessionVariants.get(String(sessionId)) ?? "",
								variants: effortOptions.get(page) ?? [],
							},
							contextWindow: {
								contextWindow: modelExecutionMockup ? "1m" : "",
								options: [],
							},
						};
					},
					GetAgents: async (payload) => {
						await heldAgentLookups.get(world.page)?.promise;
						const instanceId =
							typeof payload["instanceId"] === "string"
								? payload["instanceId"]
								: sessionInstance(
										"sessionId" in payload ? payload.sessionId : undefined,
									);
						const claude = (mockInstances.get(page) ?? []).some(
							(instance) =>
								instance["id"] === instanceId &&
								instance["driver"] === "claude",
						);
						return {
							projectSlug: "myapp",
							...(instanceId != null ? { instanceId } : {}),
							providerScope: claude
								? { id: "claude", name: "Claude" }
								: { id: "opencode", name: "OpenCode" },
							agents: claude ? claudeInstanceAgents : openCodeInstanceAgents,
						};
					},
					GetClaudeSettings: () => ({
						projectSlug: "myapp",
						overrides: mockClaudeSettings.get(page) ?? {},
					}),
					SetClaudeSettings: ({ overrides }) => {
						mockClaudeSettings.set(page, overrides);
						rpcControl.setProjectSetting({ _tag: "claudeSettings", overrides });
						return { projectSlug: "myapp", overrides };
					},
					ResolveClaudeSettings: (payload) => ({
						projectSlug: "myapp",
						instanceId: payload.instanceId,
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
				},
				handlers: {
					CreatePty: async () => ({ ok: true }),
					// A real daemon always lists its projects; a draft prefills from them.
					GetProjects: async () => ({
						projects: [
							{
								slug: "myapp",
								title: "myapp",
								folders: ["/myapp"],
							},
						],
						current: "myapp",
					}),
					ReloadProviderSession: async (payload) => ({
						projectSlug: "myapp",
						sessionId: payload["sessionId"],
					}),
					AddInstance: async (payload) => {
						const list = mockInstances.get(page) ?? [];
						const driver =
							payload["driver"] === "claude" ? "claude" : "opencode";
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
							driver,
							isDefault: !list.some(
								(instance) => instance["driver"] === driver,
							),
							usageEligible: driver === "claude",
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
										...(i["driver"] === "claude" &&
										typeof payload["configDir"] === "string"
											? { configDir: payload["configDir"] }
											: {}),
									}
								: i,
						);
						mockInstances.set(page, next);
						return { projectSlug: "myapp", instances: next };
					},
					SetDefault: async (payload) => {
						const next = (mockInstances.get(page) ?? []).map((instance) =>
							instance["driver"] === "claude"
								? {
										...instance,
										isDefault: instance["id"] === payload["instanceId"],
									}
								: instance,
						);
						mockInstances.set(page, next);
						rpcControl.setDaemonList("SubscribeInstances", { instances: next });
						return { instances: next };
					},
					RemoveInstance: async (payload) => {
						const next = (mockInstances.get(page) ?? []).filter(
							(i) => i["id"] !== payload["instanceId"],
						);
						mockInstances.set(page, next);
						return { projectSlug: "myapp", instances: next };
					},
				},
			});
			rpcControls.set(world.page, rpcControl);
			rpcControl.setDaemonList("SubscribeInstances", {
				instances: initialInstances,
			});
			rpcControl.detailFeed = detailFeeds.get(world.page) ?? "synchronize";
			rpcControl.setProjectSetting({
				_tag: "providerModels",
				providers: providers.filter((provider) => provider.id === "claude"),
			});
			rpcControl.setProjectSetting({
				_tag: "harnessDefaults",
				claude: modelRequired
					? { status: "missing" }
					: {
							status: "ok",
							pick: {
								modelId: "claude-sonnet-4-5",
								providerId: "claude",
								effort: "",
								contextWindow: "",
							},
						},
				opencode: modelRequired
					? { status: "missing" }
					: {
							status: "ok",
							pick: {
								modelId: "claude-sonnet-4",
								providerId: "anthropic",
								effort: "",
								contextWindow: "",
							},
						},
			});
			rpcControl.setProjectSetting({
				_tag: "defaultModel",
				model: "claude-sonnet-4",
				provider: "anthropic",
				variant: "",
			});

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
					// Phones show only a short tag, so wait on the accessible name.
					await world.page
						.locator('[data-testid="model-picker-trigger"][aria-label*="Opus"]')
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
