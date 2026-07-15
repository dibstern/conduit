// ─── Discovery Store Tests ───────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyGetAgentsResponse,
	applyGetModelsResponse,
	clearDiscoveryState,
	discoveryState,
	extractSlashQuery,
	filterCommands,
	formatAgentLabel,
	formatModelName,
	getActiveContextWindowOptions,
	getActiveModel,
	handleAgentList,
	handleCommandList,
	handleContextWindowInfo,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	setActiveAgent,
	setActiveModel,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import type { GetModelsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";
import type {
	AgentInfo,
	CommandInfo,
	ModelInfo,
	ProviderInfo,
	RelayMessage,
} from "../../../src/lib/frontend/types.js";

// ─── Helper: cast incomplete test data to the expected type ─────────────────
// Tests deliberately pass incomplete objects to verify defensive handling.
function msg<T extends RelayMessage["type"]>(data: {
	type: T;
	[k: string]: unknown;
}): Extract<RelayMessage, { type: T }> {
	return data as Extract<RelayMessage, { type: T }>;
}

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	discoveryState.agents = [];
	discoveryState.agentProviderScope = null;
	discoveryState.activeAgentId = null;
	discoveryState.providers = [];
	discoveryState.currentModelId = "";
	discoveryState.currentProviderId = "";
	discoveryState.commands = [];
	discoveryState.commandsFetched = false;
	discoveryState.defaultModelId = "";
	discoveryState.defaultProviderId = "";
	discoveryState.currentVariant = "";
	discoveryState.availableVariants = [];
	discoveryState.currentContextWindow = "";
	discoveryState.availableContextWindowOptions = [];
});

// ─── Pure helper: formatAgentLabel ──────────────────────────────────────────

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

// ─── Pure helper: formatModelName ───────────────────────────────────────────

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

// ─── Pure helper: filterCommands ────────────────────────────────────────────

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
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(result[0]!.name).toBe("clear");
	});
});

// ─── Pure helper: extractSlashQuery ─────────────────────────────────────────

describe("extractSlashQuery", () => {
	it("extracts query after slash at start of text", () => {
		expect(extractSlashQuery("/hel", 4)).toEqual({
			query: "hel",
			start: 0,
			end: 4,
		});
	});

	it("extracts query after slash preceded by space", () => {
		expect(extractSlashQuery("text /cmd", 9)).toEqual({
			query: "cmd",
			start: 5,
			end: 9,
		});
	});

	it("returns empty query for slash with nothing after", () => {
		expect(extractSlashQuery("/", 1)).toEqual({ query: "", start: 0, end: 1 });
	});

	it("returns null when no slash found", () => {
		expect(extractSlashQuery("no slash here", 13)).toBeNull();
	});

	it("returns null for slash in the middle of a word", () => {
		expect(extractSlashQuery("http://example", 14)).toBeNull();
	});
});

// ─── handleAgentList ────────────────────────────────────────────────────────

describe("handleAgentList", () => {
	it("sets agents from message", () => {
		const agents: AgentInfo[] = [
			{ id: "a1", name: "Agent 1" },
			{ id: "a2", name: "Agent 2" },
		];
		handleAgentList({
			type: "agent_list",
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
		discoveryState.activeAgentId = "missing";

		handleAgentList({
			type: "agent_list",
			providerScope: { id: "claude", name: "Claude" },
			agents: [{ id: "Explore", name: "Explore" }],
		});

		expect(discoveryState.activeAgentId).toBeNull();
	});

	it("ignores non-array agents", () => {
		handleAgentList(msg({ type: "agent_list", agents: "bad" }));
		expect(discoveryState.agents).toHaveLength(0);
	});
});

// ─── handleModelList ────────────────────────────────────────────────────────

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
		handleModelList({ type: "model_list", providers });
		expect(discoveryState.providers).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(discoveryState.providers[0]!.models).toHaveLength(1);
	});

	it("ignores non-array providers", () => {
		handleModelList(msg({ type: "model_list", providers: null }));
		expect(discoveryState.providers).toHaveLength(0);
	});
});

describe("applyGetModelsResponse", () => {
	it("updates model discovery state from one RPC response", () => {
		const response: GetModelsResponse = {
			projectSlug: "project-a",
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
		};

		applyGetModelsResponse(response);

		expect(discoveryState.providers).toHaveLength(1);
		expect(discoveryState.currentModelId).toBe("claude-sonnet");
		expect(discoveryState.currentProviderId).toBe("anthropic");
		expect(discoveryState.currentVariant).toBe("careful");
		expect(discoveryState.availableVariants).toEqual(["fast", "careful"]);
		expect(discoveryState.currentContextWindow).toBe("200k");
		expect(discoveryState.availableContextWindowOptions).toEqual([
			{ value: "200k", label: "200K", isDefault: true },
		]);
	});
});

// ─── handleModelInfo ────────────────────────────────────────────────────────

describe("handleModelInfo", () => {
	it("sets current model and provider IDs (server sends 'model' and 'provider')", () => {
		handleModelInfo({
			type: "model_info",
			model: "claude-4",
			provider: "anthropic",
		});
		expect(discoveryState.currentModelId).toBe("claude-4");
		expect(discoveryState.currentProviderId).toBe("anthropic");
	});

	it("does not overwrite if fields are empty", () => {
		discoveryState.currentModelId = "existing";
		handleModelInfo({ type: "model_info", model: "", provider: "" });
		expect(discoveryState.currentModelId).toBe("existing");
	});
});

// ─── handleCommandList ──────────────────────────────────────────────────────

describe("handleCommandList", () => {
	it("sets commands and marks as fetched", () => {
		const commands: CommandInfo[] = [
			{ name: "help", description: "Show help" },
		];
		handleCommandList({ type: "command_list", commands });
		expect(discoveryState.commands).toHaveLength(1);
		expect(discoveryState.commandsFetched).toBe(true);
	});

	it("ignores non-array commands", () => {
		handleCommandList(msg({ type: "command_list", commands: 42 }));
		expect(discoveryState.commands).toHaveLength(0);
		expect(discoveryState.commandsFetched).toBe(false);
	});
});

// ─── setActiveAgent ─────────────────────────────────────────────────────────

describe("setActiveAgent", () => {
	it("sets the active agent ID", () => {
		setActiveAgent("agent-x");
		expect(discoveryState.activeAgentId).toBe("agent-x");
	});
});

// ─── setActiveModel ─────────────────────────────────────────────────────────

describe("setActiveModel", () => {
	it("sets model and provider IDs", () => {
		setActiveModel("model-y", "provider-z");
		expect(discoveryState.currentModelId).toBe("model-y");
		expect(discoveryState.currentProviderId).toBe("provider-z");
	});
});

// ─── getActiveModel with grouped routing options ────────────────────────────

describe("getActiveModel", () => {
	it("resolves a grouped model when the active id is a routing option", () => {
		discoveryState.providers = [
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
		];
		discoveryState.currentModelId = "us.anthropic.claude-fable-5";
		expect(getActiveModel()?.name).toBe("Claude Fable 5");
	});
});

// ─── handleDefaultModelInfo ─────────────────────────────────────────────────

describe("handleDefaultModelInfo", () => {
	it("sets default model and provider IDs", () => {
		handleDefaultModelInfo({
			type: "default_model_info",
			model: "claude-4",
			provider: "anthropic",
		});
		expect(discoveryState.defaultModelId).toBe("claude-4");
		expect(discoveryState.defaultProviderId).toBe("anthropic");
	});

	it("clears to empty string when fields are missing", () => {
		discoveryState.defaultModelId = "existing";
		discoveryState.defaultProviderId = "existing-provider";
		handleDefaultModelInfo(
			msg({
				type: "default_model_info",
				model: undefined,
				provider: undefined,
			}),
		);
		expect(discoveryState.defaultModelId).toBe("");
		expect(discoveryState.defaultProviderId).toBe("");
	});

	it("updates when called with new values", () => {
		handleDefaultModelInfo({
			type: "default_model_info",
			model: "model-a",
			provider: "provider-a",
		});
		handleDefaultModelInfo({
			type: "default_model_info",
			model: "model-b",
			provider: "provider-b",
		});
		expect(discoveryState.defaultModelId).toBe("model-b");
		expect(discoveryState.defaultProviderId).toBe("provider-b");
	});
});

// ─── Context window state ───────────────────────────────────────────────────

describe("handleContextWindowInfo", () => {
	it("sets the current context window and options from the server", () => {
		handleContextWindowInfo({
			type: "context_window_info",
			contextWindow: "1m",
			options: [
				{ value: "200k", label: "200K" },
				{ value: "1m", label: "1M (beta)", isDefault: true },
			],
		});

		expect(discoveryState.currentContextWindow).toBe("1m");
		expect(discoveryState.availableContextWindowOptions).toEqual([
			{ value: "200k", label: "200K" },
			{ value: "1m", label: "1M (beta)", isDefault: true },
		]);
	});

	it("falls back to empty state when the server sends no options", () => {
		discoveryState.currentContextWindow = "1m";
		discoveryState.availableContextWindowOptions = [
			{ value: "200k", label: "200K" },
		];

		handleContextWindowInfo(
			msg({
				type: "context_window_info",
				contextWindow: "",
				options: undefined,
			}),
		);

		expect(discoveryState.currentContextWindow).toBe("");
		expect(discoveryState.availableContextWindowOptions).toEqual([]);
	});
});

describe("getActiveContextWindowOptions", () => {
	it("returns the server-provided context window options", () => {
		discoveryState.availableContextWindowOptions = [
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		];

		expect(getActiveContextWindowOptions()).toEqual([
			{ value: "200k", label: "200K", isDefault: true },
			{ value: "1m", label: "1M (beta)" },
		]);
	});
});

describe("clearDiscoveryState", () => {
	it("resets provider-scoped agent state on project switch", () => {
		discoveryState.agentProviderScope = { id: "claude", name: "Claude" };
		discoveryState.agents = [{ id: "Explore", name: "Explore" }];
		discoveryState.activeAgentId = "Explore";

		clearDiscoveryState();

		expect(discoveryState.agentProviderScope).toBeNull();
		expect(discoveryState.agents).toEqual([]);
		expect(discoveryState.activeAgentId).toBeNull();
	});
});
