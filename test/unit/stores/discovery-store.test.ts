// @vitest-environment jsdom
import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	applyGetAgentsResponse,
	applyGetModelsResponse,
	chooseModel,
	choosePermissionMode,
	clearDiscoveryState,
	discoveryState,
	extractCommandQuery,
	filterCommands,
	formatAgentLabel,
	formatModelName,
	getActiveContextWindowOptions,
	getActiveModel,
	getActiveModelVariants,
	getDraftPick,
	getEffectiveInstanceId,
	getModelDisplayName,
	getProviderGroups,
	getProviderGroupsForInstance,
	handleAgentList,
	handleCommandList,
	handleContextWindowInfo,
	handleDefaultModelInfo,
	handleHarnessDefaults,
	handleModelInfo,
	handleModelList,
	handlePermissionModeInfo,
	selectInstance,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import {
	applyInstanceListResponse,
	clearInstanceState,
} from "../../../src/lib/frontend/stores/instance.svelte.js";
import { applyProjectSetting } from "../../../src/lib/frontend/stores/project-settings.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import type { GetModelsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";
import type {
	AgentInfo,
	CommandInfo,
	ModelInfo,
	ProviderInfo,
} from "../../../src/lib/frontend/types.js";

const defaultInstances = (["claude", "opencode"] as const).map((driver) => ({
	id: driver,
	name: driver,
	driver,
	isDefault: true,
	port: driver === "opencode" ? 4096 : 0,
	managed: driver === "opencode",
	status: "healthy" as const,
	restartCount: 0,
	createdAt: 0,
}));

beforeEach(() => {
	clearDiscoveryState();
	clearInstanceState();
	applyInstanceListResponse({ instances: [] });
	handleDefaultModelInfo({});
	openSessionForSetup(null);
});

describe("formatAgentLabel", () => {
	it("returns name when available", () => {
		const agent: AgentInfo = { id: "a1", name: "My Agent" };
		expect(formatAgentLabel(agent)).toBe("My Agent");
	});

	it("falls back to id when name is empty", () => {
		const agent: AgentInfo = { id: "a1", name: "" };
		expect(formatAgentLabel(agent)).toBe("a1");
	});

	it("keeps model metadata out of the display label", () => {
		const agent: AgentInfo = { id: "Explore", name: "Explore", model: "haiku" };
		expect(formatAgentLabel(agent)).toBe("Explore");
	});
});

describe("formatModelName", () => {
	it("returns name when available", () => {
		const model: ModelInfo = {
			id: "m1",
			name: "GPT-4",
			provider: "openai",
		};
		expect(formatModelName(model)).toBe("GPT-4");
	});

	it("falls back to id when name is empty", () => {
		const model: ModelInfo = { id: "m1", name: "", provider: "openai" };
		expect(formatModelName(model)).toBe("m1");
	});
});

describe("getModelDisplayName", () => {
	it("resolves catalog names and tidies an uncatalogued id", () => {
		handleModelList({
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [{ id: "sonnet", name: "Sonnet 5", provider: "claude" }],
				},
			],
		});

		expect(getModelDisplayName("sonnet")).toBe("Sonnet 5");
		expect(getModelDisplayName("claude-sonnet-5")).toBe("Sonnet 5");
	});
});

describe("filterCommands", () => {
	const commands: CommandInfo[] = [
		{ name: "help" },
		{ name: "history" },
		{ name: "clear" },
		{ name: "compact" },
	];

	it("returns all commands for empty query", () => {
		expect(filterCommands(commands, "")).toEqual(commands);
	});

	it("filters by case-insensitive prefix", () => {
		expect(filterCommands(commands, "h")).toHaveLength(2);
		expect(filterCommands(commands, "H")).toHaveLength(2);
	});

	it("returns empty array for no match", () => {
		expect(filterCommands(commands, "z")).toHaveLength(0);
	});

	it("matches exact name", () => {
		const result = filterCommands(commands, "clear");
		expect(result).toHaveLength(1);
		const firstResult = result[0];
		assert.exists(firstResult, "expected discovered command");
		expect(firstResult.name).toBe("clear");
	});
});

describe("extractCommandQuery", () => {
	it("extracts query after slash at start of text", () => {
		expect(extractCommandQuery("/hel", 4)).toEqual({
			trigger: "/",
			query: "hel",
			start: 0,
			end: 4,
		});
	});

	it("extracts query after slash preceded by space", () => {
		expect(extractCommandQuery("text /cmd", 9)).toEqual({
			trigger: "/",
			query: "cmd",
			start: 5,
			end: 9,
		});
	});

	it("returns empty query for slash with nothing after", () => {
		expect(extractCommandQuery("/", 1)).toEqual({
			trigger: "/",
			query: "",
			start: 0,
			end: 1,
		});
	});

	it("returns null when no slash found", () => {
		expect(extractCommandQuery("no slash here", 13)).toBeNull();
	});

	it("returns null for slash in the middle of a word", () => {
		expect(extractCommandQuery("http://example", 14)).toBeNull();
	});
});

describe("handleAgentList", () => {
	it("sets agents from message", () => {
		const agents: AgentInfo[] = [
			{ id: "a1", name: "Agent 1" },
			{ id: "a2", name: "Agent 2" },
		];
		handleAgentList({
			providerScope: { id: "claude", name: "Claude" },
			agents,
			activeAgentId: "a1",
		});
		expect(discoveryState.agents).toHaveLength(2);
		expect(discoveryState.agentProviderScope).toEqual({
			id: "claude",
			name: "Claude",
		});
		expect(discoveryState.activeAgentId).toBe("a1");
	});

	it("stores provider scope from get agents RPC responses", () => {
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "build", name: "Build" }],
			activeAgentId: "build",
		});

		expect(discoveryState.agentProviderScope).toEqual({
			id: "opencode",
			name: "OpenCode",
		});
		expect(discoveryState.agents).toEqual([{ id: "build", name: "Build" }]);
	});

	it("clears stale active agent when a scoped list has no active override", () => {
		handleAgentList({
			providerScope: { id: "claude", name: "Claude" },
			agents: [],
			activeAgentId: "missing",
		});

		handleAgentList({
			providerScope: { id: "claude", name: "Claude" },
			agents: [{ id: "Explore", name: "Explore" }],
		});

		expect(discoveryState.activeAgentId).toBeNull();
	});
});

describe("handleModelList", () => {
	it("sets providers from message", () => {
		const providers: ProviderInfo[] = [
			{
				id: "p1",
				name: "Anthropic",
				configured: true,
				models: [{ id: "m1", name: "Claude", provider: "anthropic" }],
			},
		];
		handleModelList({ providers });
		expect(discoveryState.providers).toHaveLength(1);
		const firstProvider = discoveryState.providers[0];
		assert.exists(firstProvider, "expected discovered provider");
		expect(firstProvider.models).toHaveLength(1);
	});
});

describe("applyGetModelsResponse", () => {
	it.each([
		"update-first",
		"response-first",
	])("keeps live Claude models when an older GetModels response arrives %s", (order) => {
		applyInstanceListResponse({ instances: defaultInstances });
		handleHarnessDefaults({
			_tag: "harnessDefaults",
			claude: {
				status: "ok",
				pick: {
					modelId: "sonnet",
					providerId: "claude",
					effort: "high",
					contextWindow: "1m",
				},
			},
			opencode: { status: "missing" },
		});
		const applyResponse = () =>
			applyGetModelsResponse({
				projectSlug: "project-a",
				active: { model: "sonnet", provider: "claude" },
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						configured: true,
						models: [
							{
								id: "sonnet",
								name: "Sonnet",
								provider: "anthropic",
								variants: ["low"],
								contextWindowOptions: [{ value: "200k", label: "200K" }],
							},
						],
					},
				],
				variant: { variant: "high", variants: [] },
				contextWindow: { contextWindow: "1m", options: [] },
			});
		const applyUpdate = () =>
			applyProjectSetting({
				_tag: "providerModels",
				accountId: "claude",
				providers: [
					{
						id: "claude",
						name: "Anthropic - claude",
						configured: true,
						models: [
							{
								id: "sonnet",
								name: "Sonnet",
								provider: "claude",
								variants: ["high", "max"],
								contextWindowOptions: [{ value: "1m", label: "1M" }],
							},
						],
					},
				],
			});
		if (order === "update-first") {
			applyUpdate();
			applyResponse();
		} else {
			applyResponse();
			applyUpdate();
		}
		selectInstance("claude");
		expect(discoveryState.providers.map(({ id }) => id)).toEqual([
			"anthropic",
			"claude",
		]);
		expect(discoveryState.currentModelId).toBe("sonnet");
		expect(discoveryState.currentProviderId).toBe("claude");
		expect(discoveryState.currentVariant).toBe("high");
		expect(getActiveModelVariants()).toEqual(["high", "max"]);
		expect(getActiveContextWindowOptions()).toEqual([
			{ value: "1m", label: "1M" },
		]);
	});

	it("uses each account's Claude catalog for configured default and named account choices", () => {
		applyInstanceListResponse({
			instances: [
				{
					id: "personal",
					name: "Personal",
					driver: "claude",
					isDefault: true,
					port: 0,
					managed: false,
					status: "healthy",
					restartCount: 0,
					createdAt: 0,
				},
				{
					id: "claude-work",
					name: "Work",
					driver: "claude",
					isDefault: false,
					port: 0,
					managed: false,
					status: "stopped",
					restartCount: 0,
					createdAt: 0,
				},
			],
		});
		expect(getEffectiveInstanceId()).toBe("personal");
		expect(getProviderGroupsForInstance("claude")).toEqual([]);
		expect(getDraftPick()).toBeUndefined();
		for (const [instanceId, modelId] of [
			["personal", "sonnet"],
			["claude-work", "opus"],
		] as const) {
			selectInstance(instanceId);
			chooseModel({ modelId, providerId: "claude" });
			expect(getProviderGroupsForInstance(instanceId)).toEqual([]);
			expect(getDraftPick()).toBeUndefined();
			applyProjectSetting({
				_tag: "providerModels",
				accountId: instanceId,
				providers: [
					{
						id: "claude",
						name: "Claude",
						configured: true,
						models: [{ id: modelId, name: modelId, provider: "claude" }],
					},
				],
			});
			chooseModel({ modelId, providerId: "claude" });
			expect(
				getProviderGroupsForInstance(instanceId).map(
					({ provider }) => provider.id,
				),
			).toEqual(["claude"]);
			expect(getDraftPick()).toEqual({
				instanceId,
				model: {
					modelId,
					providerId: "claude",
					variant: "",
					contextWindow: "",
				},
				permissionMode: "ask",
			});
		}
		expect(getProviderGroups().map(({ provider }) => provider.id)).toEqual([
			"claude",
		]);
	});

	it("keeps an unknown draft account unroutable across account snapshots", () => {
		applyInstanceListResponse({ instances: defaultInstances });
		selectInstance("missing-account");
		expect(getEffectiveInstanceId()).toBeUndefined();
		expect(getDraftPick()).toBeUndefined();
		applyInstanceListResponse({
			instances: defaultInstances.map((account) =>
				account.driver === "claude" ? { ...account, id: "personal" } : account,
			),
		});
		expect(getEffectiveInstanceId()).toBeUndefined();
		expect(getDraftPick()).toBeUndefined();
	});

	it.each([
		"claude",
		"opencode",
	] as const)("falls back to the %s default when a live held account is removed", (driver) => {
		const account = defaultInstances.find(
			(account) => account.driver === driver,
		);
		assert.exists(account);
		applyInstanceListResponse({
			instances: [
				...defaultInstances,
				{ ...account, id: "work", isDefault: false },
			],
		});
		selectInstance("work");
		expect(getEffectiveInstanceId()).toBe("work");
		applyInstanceListResponse({ instances: defaultInstances });
		expect(getEffectiveInstanceId()).toBe(driver);
	});

	it.each([
		{ id: "claude", driver: "claude" },
		{ id: "claude-sdk", driver: "claude" },
		{ id: "opencode", driver: "opencode" },
	])("resolves the legacy $id draft ref through its driver default", ({
		id,
		driver,
	}) => {
		applyInstanceListResponse({
			instances: defaultInstances.map((account) => ({
				...account,
				id: `${account.driver}-default`,
			})),
		});
		selectInstance(id);
		expect(getEffectiveInstanceId()).toBe(`${driver}-default`);
	});

	it("keeps the global catalog when a scoped model response arrives", () => {
		const providers = [
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [{ id: "gpt", name: "GPT", provider: "openai" }],
			},
			{
				id: "claude",
				name: "Claude",
				configured: true,
				models: [{ id: "sonnet", name: "Sonnet", provider: "claude" }],
			},
		];
		handleModelList({ providers });
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "claude",
			providers: [],
		});
		const openCodeProvider = providers[0];
		assert.exists(openCodeProvider);
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode-work",
			providers: [{ ...openCodeProvider, instanceId: "opencode-work" }],
		});
		expect(discoveryState.providers).toEqual(providers);
	});

	it("does not revive removed Claude options from an older RPC response", () => {
		applyProjectSetting({
			_tag: "providerModels",
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [{ id: "sonnet", name: "Sonnet", provider: "claude" }],
				},
			],
		});
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [],
			active: { model: "sonnet", provider: "claude" },
			variant: { variant: "high", variants: ["high"] },
			contextWindow: {
				contextWindow: "1m",
				options: [{ value: "1m", label: "1M" }],
			},
		});
		selectInstance("claude");
		chooseModel({ modelId: "sonnet", providerId: "claude" });
		expect(getActiveModelVariants()).toEqual([]);
		expect(getActiveContextWindowOptions()).toEqual([]);
	});

	it("updates model discovery state from one RPC response", () => {
		applyInstanceListResponse({ instances: defaultInstances });
		const response: GetModelsResponse = {
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{
							id: "claude-sonnet",
							name: "Claude Sonnet",
							provider: "anthropic",
							variants: ["fast", "careful"],
							contextWindowOptions: [
								{ value: "200k", label: "200K", isDefault: true },
							],
						},
					],
				},
			],
			active: { model: "claude-sonnet", provider: "anthropic" },
			variant: { variant: "careful", variants: ["fast", "careful"] },
			contextWindow: {
				contextWindow: "200k",
				options: [{ value: "200k", label: "200K", isDefault: true }],
			},
			permissionMode: "acceptEdits",
			modelExecution: {
				requestedModel: "claude-sonnet",
				expectedModel: "claude-sonnet-5",
				actualModel: "claude-fable-4-0",
				drifted: true,
			},
		};

		selectInstance("opencode");
		applyGetModelsResponse(response);

		expect(getProviderGroupsForInstance("opencode")).toHaveLength(1);
		expect(discoveryState.currentModelId).toBe("claude-sonnet");
		expect(discoveryState.currentProviderId).toBe("anthropic");
		expect(discoveryState.currentVariant).toBe("careful");
		expect(discoveryState.availableVariants).toEqual(["fast", "careful"]);
		expect(discoveryState.currentContextWindow).toBe("200k");
		expect(discoveryState.availableContextWindowOptions).toEqual([
			{ value: "200k", label: "200K", isDefault: true },
		]);
		expect(discoveryState.permissionMode).toBe("acceptEdits");
		expect(discoveryState.modelExecution).toEqual(response.modelExecution);

		applyGetModelsResponse({ projectSlug: "project-a", providers: [] });
		expect(discoveryState.modelExecution).toBeNull();
	});
});

describe("handlePermissionModeInfo", () => {
	it("sets the session permission mode", () => {
		openSessionForSetup("session-permission", "project-a");
		handlePermissionModeInfo({ mode: "auto" });
		expect(discoveryState.permissionMode).toBe("auto");
	});
});

describe("an undo only undoes its own choice", () => {
	beforeEach(() => {
		openSessionForSetup("session-undo", "project-a");
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "opencode",
				providers: [],
				active: { model: "server-model", provider: "server-provider" },
			},
			"session-undo",
		);
	});
	it("leaves a newer choice alone when an older request fails", () => {
		handlePermissionModeInfo({ mode: "full" });

		const undoA = choosePermissionMode("acceptEdits");
		choosePermissionMode("ask"); // the user clicks again while A is in flight
		undoA(); // ...and only then does A come back rejected

		expect(discoveryState.permissionMode).toBe("ask");
	});

	it("drops its own choice, falling back to the server's value", () => {
		handlePermissionModeInfo({ mode: "full" });

		const undo = choosePermissionMode("acceptEdits");
		expect(discoveryState.permissionMode).toBe("acceptEdits");
		undo();

		expect(discoveryState.permissionMode).toBe("full");
	});

	it("leaves a server update that landed meanwhile alone", () => {
		const undo = choosePermissionMode("acceptEdits");
		handlePermissionModeInfo({ mode: "plan" });
		undo();

		expect(discoveryState.permissionMode).toBe("plan");
	});

	it("keeps a newer model choice when an older model request fails", () => {
		handleModelInfo({
			model: "server-model",
			provider: "server-provider",
		});

		const undoA = chooseModel({ modelId: "a", providerId: "p" });
		chooseModel({ modelId: "b", providerId: "p" });
		undoA();

		expect(discoveryState.currentModelId).toBe("b");
		expect(discoveryState.currentProviderId).toBe("p");
	});

	// The click is the thing being undone, not the value it wrote. Landing back
	// on a value an earlier failing request also asked for is a normal way to
	// use a dropdown, and it must not hand that earlier request the field.
	it("keeps a re-chosen mode when the first request for it fails", () => {
		handlePermissionModeInfo({ mode: "full" });

		const undoA = choosePermissionMode("acceptEdits");
		choosePermissionMode("ask");
		choosePermissionMode("acceptEdits"); // the user lands back where A was
		undoA();

		expect(discoveryState.permissionMode).toBe("acceptEdits");
	});

	it("keeps a re-chosen model when the first request for it fails", () => {
		handleModelInfo({
			model: "server-model",
			provider: "server-provider",
		});

		const undoA = chooseModel({ modelId: "a", providerId: "p" });
		chooseModel({ modelId: "b", providerId: "p" });
		chooseModel({ modelId: "a", providerId: "p" });
		undoA();

		expect(discoveryState.currentModelId).toBe("a");
		expect(discoveryState.currentProviderId).toBe("p");
	});
});

describe("draft model reads", () => {
	beforeEach(() => {
		applyInstanceListResponse({ instances: defaultInstances });
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{ id: "claude-4", name: "Claude 4", provider: "anthropic" },
						{ id: "existing", name: "Existing", provider: "anthropic" },
					],
				},
			],
		});
	});

	it("sets current model and provider IDs from a local draft pick", () => {
		chooseModel({
			modelId: "claude-4",
			providerId: "anthropic",
		});
		expect(discoveryState.currentModelId).toBe("claude-4");
		expect(discoveryState.currentProviderId).toBe("anthropic");
	});

	it("keeps a held model when a scoped response has empty active fields", () => {
		chooseModel({
			modelId: "existing",
			providerId: "anthropic",
		});
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [],
			active: { model: "", provider: "" },
		});
		expect(discoveryState.currentModelId).toBe("existing");
	});
});

describe("handleCommandList", () => {
	it("sets commands and marks as fetched", () => {
		const commands: CommandInfo[] = [
			{ name: "help", description: "Show help" },
		];
		handleCommandList({ commands });
		expect(discoveryState.commands).toHaveLength(1);
		expect(discoveryState.commandsFetched).toBe(true);
	});
});

describe("getActiveModel", () => {
	it("resolves a grouped model when the active id is a routing option", () => {
		applyInstanceListResponse({ instances: defaultInstances });
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [
				{
					id: "amazon-bedrock",
					name: "Amazon Bedrock",
					configured: true,
					models: [
						{
							id: "global.anthropic.claude-fable-5",
							name: "Claude Fable 5",
							provider: "amazon-bedrock",
							routingOptions: [
								{
									value: "global.anthropic.claude-fable-5",
									label: "Global",
									isDefault: true,
								},
								{ value: "us.anthropic.claude-fable-5", label: "US" },
							],
						},
					],
				},
			],
		});
		selectInstance("opencode");
		chooseModel({
			modelId: "us.anthropic.claude-fable-5",
			providerId: "amazon-bedrock",
		});
		expect(getActiveModel()?.name).toBe("Claude Fable 5");
	});
});

describe("handleDefaultModelInfo", () => {
	it("sets default model and provider IDs", () => {
		handleDefaultModelInfo({
			model: "claude-4",
			provider: "anthropic",
			variant: "high",
		});
		expect(discoveryState.defaultModelId).toBe("claude-4");
		expect(discoveryState.defaultProviderId).toBe("anthropic");
		expect(discoveryState.defaultVariant).toBe("high");
	});

	it("clears to empty string when fields are missing", () => {
		handleDefaultModelInfo({
			model: "existing",
			provider: "existing-provider",
			variant: "existing-variant",
		});
		handleDefaultModelInfo({
			model: undefined,
			provider: undefined,
			variant: undefined,
		});
		expect(discoveryState.defaultModelId).toBe("");
		expect(discoveryState.defaultProviderId).toBe("");
		expect(discoveryState.defaultVariant).toBe("");
	});

	it("updates when called with new values", () => {
		handleDefaultModelInfo({
			model: "model-a",
			provider: "provider-a",
			variant: "low",
		});
		handleDefaultModelInfo({
			model: "model-b",
			provider: "provider-b",
			variant: "high",
		});
		expect(discoveryState.defaultModelId).toBe("model-b");
		expect(discoveryState.defaultProviderId).toBe("provider-b");
		expect(discoveryState.defaultVariant).toBe("high");
	});
});

describe("session context-window reads", () => {
	beforeEach(() => {
		openSessionForSetup("session-context", "project-a");
	});

	it("sets the session context window and options from its response", () => {
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				providers: [],
				contextWindow: {
					contextWindow: "1m",
					options: [
						{ value: "200k", label: "200K" },
						{ value: "1m", label: "1M (beta)", isDefault: true },
					],
				},
			},
			"session-context",
		);

		expect(discoveryState.currentContextWindow).toBe("1m");
		expect(discoveryState.availableContextWindowOptions).toEqual([
			{ value: "200k", label: "200K" },
			{ value: "1m", label: "1M (beta)", isDefault: true },
		]);
	});

	it("clears session context-window state when its response omits the options", () => {
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				providers: [],
				contextWindow: {
					contextWindow: "1m",
					options: [{ value: "200k", label: "200K" }],
				},
			},
			"session-context",
		);
		applyGetModelsResponse(
			{ projectSlug: "project-a", providers: [] },
			"session-context",
		);

		expect(discoveryState.currentContextWindow).toBe("");
		expect(discoveryState.availableContextWindowOptions).toEqual([]);
	});
});

describe("getActiveContextWindowOptions", () => {
	beforeEach(() => applyInstanceListResponse({ instances: defaultInstances }));
	it("returns the server-provided context window options", () => {
		openSessionForSetup("session-context", "project-a");
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				providers: [],
				contextWindow: {
					contextWindow: "",
					options: [
						{ value: "200k", label: "200K", isDefault: true },
						{ value: "1m", label: "1M (beta)" },
					],
				},
			},
			"session-context",
		);

		expect(getActiveContextWindowOptions()).toEqual([
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		]);
	});

	it("prefers the selected model's own options over the server list", () => {
		const modelOptions = [
			{ value: "200k", label: "200k" },
			{ value: "1m", label: "1M", isDefault: true },
		];
		handleModelList({
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{
							id: "claude-opus-5",
							name: "Opus 5",
							provider: "claude",
							contextWindowOptions: modelOptions,
						},
					],
				},
			],
		});
		selectInstance("claude");
		chooseModel({
			modelId: "claude-opus-5",
			providerId: "claude",
		});
		// Stale server list from a previously-selected model must not win.
		handleContextWindowInfo({
			contextWindow: "",
			options: [{ value: "200k", label: "200K", isDefault: true }],
		});

		expect(getActiveContextWindowOptions()).toEqual(modelOptions);
	});

	it("keeps an empty Claude option list authoritative over the server list", () => {
		handleModelList({
			providers: [
				{
					id: "claude",
					name: "Claude",
					configured: true,
					models: [
						{ id: "claude-haiku-4-5", name: "Haiku", provider: "claude" },
					],
				},
			],
		});
		selectInstance("claude");
		chooseModel({
			modelId: "claude-haiku-4-5",
			providerId: "claude",
		});
		handleContextWindowInfo({
			contextWindow: "",
			options: [{ value: "200k", label: "200K", isDefault: true }],
		});

		expect(getActiveContextWindowOptions()).toEqual([]);
	});
});

describe("clearDiscoveryState", () => {
	it("resets provider-scoped agent state on project switch", () => {
		handleAgentList({
			providerScope: { id: "claude", name: "Claude" },
			agents: [{ id: "Explore", name: "Explore" }],
			activeAgentId: "Explore",
		});
		applyGetModelsResponse({
			projectSlug: "proj",
			providers: [],
			modelExecution: {
				expectedModel: "claude-sonnet-5",
				actualModel: "claude-fable-4-0",
				drifted: true,
			},
		});

		clearDiscoveryState();

		expect(discoveryState.agentProviderScope).toBeNull();
		expect(discoveryState.agents).toEqual([]);
		expect(discoveryState.activeAgentId).toBeNull();
		expect(discoveryState.modelExecution).toBeNull();
	});
});
