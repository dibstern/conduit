// ─── Discovery Visibility Filtering Tests ────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyGetAgentsResponse,
	applyGetModelsResponse,
	clearDiscoveryState,
	discoveryState,
	getVisibleAgents,
	getVisibleProviderGroups,
	handleVisibilityInfo,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import type {
	AgentInfo,
	ProviderInfo,
} from "../../../src/lib/frontend/types.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const agents: AgentInfo[] = [
	{ id: "build", name: "Build" },
	{ id: "plan", name: "Plan" },
];

const providerA: ProviderInfo = {
	id: "openai",
	name: "OpenAI",
	configured: true,
	models: [
		{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		{ id: "gpt-4o-mini", name: "GPT-4o Mini", provider: "openai" },
	],
};

const providerB: ProviderInfo = {
	id: "anthropic",
	name: "Anthropic",
	configured: true,
	models: [
		{ id: "claude-sonnet", name: "Claude Sonnet", provider: "anthropic" },
	],
};

// ─── Reset state before each test ───────────────────────────────────────────

beforeEach(() => {
	clearDiscoveryState();
});

// ─── Visibility filtering ───────────────────────────────────────────────────

describe("visibility filtering", () => {
	// getVisibleAgents()
	it("filters agents whose <scopeId>/<agentId> key is hidden", () => {
		discoveryState.agentProviderScope = { id: "opencode", name: "OpenCode" };
		discoveryState.agents = [...agents];
		discoveryState.hiddenAgents = ["opencode/plan"];

		expect(getVisibleAgents()).toEqual([{ id: "build", name: "Build" }]);
	});

	it("never-brick: returns all agents when every agent is hidden", () => {
		discoveryState.agentProviderScope = { id: "opencode", name: "OpenCode" };
		discoveryState.agents = [...agents];
		discoveryState.hiddenAgents = ["opencode/build", "opencode/plan"];

		expect(getVisibleAgents()).toEqual(agents);
	});

	it("ignores hidden keys from a different scope", () => {
		discoveryState.agentProviderScope = { id: "opencode", name: "OpenCode" };
		discoveryState.agents = [...agents];
		discoveryState.hiddenAgents = ["claude/plan"];

		expect(getVisibleAgents()).toEqual(agents);
	});

	it("returns all agents when scope is null", () => {
		discoveryState.agentProviderScope = null;
		discoveryState.agents = [...agents];
		discoveryState.hiddenAgents = ["opencode/plan"];

		expect(getVisibleAgents()).toEqual(agents);
	});

	// getVisibleProviderGroups()
	it("filters hidden models within a provider group", () => {
		discoveryState.providers = [providerA];
		discoveryState.hiddenModels = ["openai/gpt-4o-mini"];

		const groups = getVisibleProviderGroups();
		expect(groups).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[0]!.models).toEqual([
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		]);
	});

	it("drops a provider group whose models are all hidden", () => {
		discoveryState.providers = [providerA, providerB];
		discoveryState.hiddenModels = ["anthropic/claude-sonnet"];

		const groups = getVisibleProviderGroups();
		expect(groups).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[0]!.provider.id).toBe("openai");
	});

	it("never-brick: returns unfiltered groups when all models everywhere are hidden", () => {
		discoveryState.providers = [providerA, providerB];
		discoveryState.hiddenModels = [
			"openai/gpt-4o",
			"openai/gpt-4o-mini",
			"anthropic/claude-sonnet",
		];

		const groups = getVisibleProviderGroups();
		expect(groups).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[0]!.models).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[1]!.models).toHaveLength(1);
	});

	it("handleVisibilityInfo updates state and clearDiscoveryState resets it", () => {
		handleVisibilityInfo({
			type: "visibility_info",
			hiddenModels: ["a/b"],
			hiddenAgents: ["c/d"],
		});

		expect(discoveryState.hiddenModels).toEqual(["a/b"]);
		expect(discoveryState.hiddenAgents).toEqual(["c/d"]);

		clearDiscoveryState();

		expect(discoveryState.hiddenModels).toEqual([]);
		expect(discoveryState.hiddenAgents).toEqual([]);
	});

	// RPC-reply paths (applyGetModelsResponse / applyGetAgentsResponse)
	it("applyGetModelsResponse with hiddenModels populates state", () => {
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
				},
			],
			hiddenModels: ["openai/gpt-4o"],
		});

		expect(discoveryState.hiddenModels).toEqual(["openai/gpt-4o"]);
	});

	it("applyGetAgentsResponse with hiddenAgents populates state", () => {
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "build", name: "Build" }],
			hiddenAgents: ["opencode/plan"],
		});

		expect(discoveryState.hiddenAgents).toEqual(["opencode/plan"]);
	});

	it("responses omitting hidden fields leave existing hidden state untouched", () => {
		discoveryState.hiddenModels = ["openai/gpt-4o"];
		discoveryState.hiddenAgents = ["opencode/plan"];

		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [],
		});
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [{ id: "build", name: "Build" }],
		});

		expect(discoveryState.hiddenModels).toEqual(["openai/gpt-4o"]);
		expect(discoveryState.hiddenAgents).toEqual(["opencode/plan"]);
	});
});
