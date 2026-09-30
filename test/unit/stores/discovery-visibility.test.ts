// ─── Discovery Visibility Filtering Tests ────────────────────────────────────
import { beforeEach, describe, expect, it } from "vitest";
import {
	applyGetAgentsResponse,
	applyGetModelsResponse,
	chooseHiddenEntries,
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
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [...agents],
			hiddenAgents: ["opencode/plan"],
		});

		expect(getVisibleAgents()).toEqual([{ id: "build", name: "Build" }]);
	});

	it("never-brick: returns all agents when every agent is hidden", () => {
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [...agents],
			hiddenAgents: ["opencode/build", "opencode/plan"],
		});

		expect(getVisibleAgents()).toEqual(agents);
	});

	it("ignores hidden keys from a different scope", () => {
		applyGetAgentsResponse({
			projectSlug: "project-a",
			providerScope: { id: "opencode", name: "OpenCode" },
			agents: [...agents],
			hiddenAgents: ["claude/plan"],
		});

		expect(getVisibleAgents()).toEqual(agents);
	});

	// getVisibleProviderGroups()
	it("filters hidden models within a provider group", () => {
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [providerA],
			hiddenModels: ["openai/gpt-4o-mini"],
		});

		const groups = getVisibleProviderGroups();
		expect(groups).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[0]!.models).toEqual([
			{ id: "gpt-4o", name: "GPT-4o", provider: "openai" },
		]);
	});

	it("drops a provider group whose models are all hidden", () => {
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [providerA, providerB],
			hiddenModels: ["anthropic/claude-sonnet"],
		});

		const groups = getVisibleProviderGroups();
		expect(groups).toHaveLength(1);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(groups[0]!.provider.id).toBe("openai");
	});

	it("never-brick: returns unfiltered groups when all models everywhere are hidden", () => {
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [providerA, providerB],
			hiddenModels: [
				"openai/gpt-4o",
				"openai/gpt-4o-mini",
				"anthropic/claude-sonnet",
			],
		});

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
		handleVisibilityInfo({
			type: "visibility_info",
			hiddenModels: ["openai/gpt-4o"],
			hiddenAgents: ["opencode/plan"],
		});

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

// ─── Undoing a hide that the server refused ─────────────────────────────────

describe("an undo of a visibility change", () => {
	beforeEach(() => {
		handleVisibilityInfo({
			type: "visibility_info",
			hiddenModels: [],
			hiddenAgents: [],
		});
	});

	it("keeps a re-hidden model when the first request for it fails", () => {
		const undoA = chooseHiddenEntries({ hiddenModels: ["openai/gpt-4o"] });
		chooseHiddenEntries({ hiddenModels: [] }); // unhidden again
		chooseHiddenEntries({ hiddenModels: ["openai/gpt-4o"] }); // and back
		undoA();

		expect(discoveryState.hiddenModels).toEqual(["openai/gpt-4o"]);
	});

	it("leaves a pending agent hide alone when a model hide fails", () => {
		const undoModels = chooseHiddenEntries({
			hiddenModels: ["openai/gpt-4o"],
		});
		chooseHiddenEntries({ hiddenAgents: ["opencode/plan"] });
		undoModels();

		expect(discoveryState.hiddenModels).toEqual([]);
		expect(discoveryState.hiddenAgents).toEqual(["opencode/plan"]);
	});
});
