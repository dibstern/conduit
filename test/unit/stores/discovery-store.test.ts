// ─── Discovery Store Tests ───────────────────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	discoveryState,
	extractSlashQuery,
	filterCommands,
	formatAgentLabel,
	formatModelName,
	handleAgentList,
	handleCommandList,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	setActiveAgent,
	setActiveModel,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
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
	discoveryState.activeAgentId = null;
	discoveryState.providers = [];
	discoveryState.currentModelId = "";
	discoveryState.currentProviderId = "";
	discoveryState.commands = [];
	discoveryState.commandsFetched = false;
	discoveryState.defaultModelId = "";
	discoveryState.defaultProviderId = "";
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
		expect(extractSlashQuery("/hel", 4)).toBe("hel");
	});

	it("extracts query after slash preceded by space", () => {
		expect(extractSlashQuery("text /cmd", 9)).toBe("cmd");
	});

	it("returns empty string for slash with nothing after", () => {
		expect(extractSlashQuery("/", 1)).toBe("");
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
		handleAgentList({ type: "agent_list", agents, activeAgentId: "a1" });
		expect(discoveryState.agents).toHaveLength(2);
		expect(discoveryState.activeAgentId).toBe("a1");
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
