import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

vi.mock(
	"../../../src/lib/frontend/transport/ws-rpc-client.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		getAgentsRpc: () => new Promise(() => {}),
		getCommandsRpc: () => new Promise(() => {}),
		getModelsRpc: () => new Promise(() => {}),
	}),
);

vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		navigate: vi.fn(),
	}),
);

import {
	applyGetModelsResponse,
	chooseVariant,
	clearDiscoveryState,
	discoveryState,
	getDraftPick,
	getEffectiveInstanceId,
	handleDefaultModelInfo,
	handleHarnessDefaults,
	handleModelList,
	selectInstance,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { attachedProjectState } from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	sessionState,
	switchToSession,
} from "../../../src/lib/frontend/stores/session.svelte.js";

const instances = ["claude", "claude-2", "opencode"].map((id) => ({
	id,
	name: id,
	port: 0,
	managed: false,
	status: "healthy" as const,
	restartCount: 0,
	createdAt: 0,
	driver: id === "opencode" ? "opencode" : "claude",
}));

const defaults = {
	projectSlug: "conduit",
	providers: [
		{
			id: "claude",
			name: "Claude",
			configured: true,
			models: [
				{
					id: "sonnet",
					name: "Sonnet",
					provider: "claude",
					variants: ["high"],
				},
			],
		},
		{
			id: "openai",
			name: "OpenAI",
			configured: true,
			models: [{ id: "gpt", name: "GPT", provider: "openai" }],
		},
	],
	instanceId: "claude",
	active: { model: "sonnet", provider: "claude" },
};

beforeEach(() => {
	clearDiscoveryState();
	sessionState.currentId = null;
	attachedProjectState.slug = "conduit";
	applyInstanceListResponse({ instances, providerCapabilities: {} });
	handleDefaultModelInfo({ model: "sonnet", provider: "claude" });
	handleModelList({ providers: defaults.providers });
	applyGetModelsResponse({
		projectSlug: "conduit",
		instanceId: "opencode",
		providers: defaults.providers.filter(
			(provider) => provider.id !== "claude",
		),
	});
	handleHarnessDefaults({
		_tag: "harnessDefaults",
		claude: {
			status: "ok",
			pick: {
				modelId: "sonnet",
				providerId: "claude",
				effort: "",
				contextWindow: "",
			},
		},
		opencode: {
			status: "ok",
			pick: {
				modelId: "gpt",
				providerId: "openai",
				effort: "",
				contextWindow: "",
			},
		},
	});
	applyGetModelsResponse(defaults);
});

describe("new session instance", () => {
	it("uses the project default harness until the draft picks an instance", () => {
		expect(getEffectiveInstanceId()).toBe("claude");
		selectInstance("claude-2");
		expect(getEffectiveInstanceId()).toBe("claude-2");
		expect(discoveryState.currentProviderId).toBe("claude");
	});

	it("loads that harness's default when the draft selects another harness", () => {
		selectInstance("opencode");
		expect(getEffectiveInstanceId()).toBe("opencode");
		expect(getDraftPick()).toMatchObject({
			instanceId: "opencode",
			model: { modelId: "gpt", providerId: "openai" },
		});
		expect(discoveryState.defaultProviderId).toBe("claude");
	});

	it("keeps a draft pick when default discovery is refreshed", () => {
		selectInstance("claude-2");
		applyGetModelsResponse(defaults);
		expect(getEffectiveInstanceId()).toBe("claude-2");
		chooseVariant("high");
		handleDefaultModelInfo({ model: "gpt", provider: "openai" });
		expect(getDraftPick()).toMatchObject({
			instanceId: "claude-2",
			model: { modelId: "sonnet", providerId: "claude", variant: "high" },
		});
	});

	it("keeps the held instance when it disappears instead of rerouting the pick", () => {
		selectInstance("claude-2");
		applyInstanceListResponse({
			instances: instances.filter((instance) => instance.id !== "claude-2"),
			providerCapabilities: {},
		});
		expect(getEffectiveInstanceId()).toBe("claude-2");
		expect(getDraftPick()?.instanceId).toBe("claude-2");
	});

	it("uses the first available instance when the derived instance is unavailable", () => {
		clearDiscoveryState();
		applyInstanceListResponse({
			instances: instances.filter((instance) => instance.id === "claude-2"),
			providerCapabilities: {},
		});
		handleDefaultModelInfo({ model: "sonnet", provider: "claude" });
		expect(getEffectiveInstanceId()).toBe("claude-2");
	});

	it("consumes the pick on session bind so the next draft starts on the default", () => {
		selectInstance("opencode");
		expect(discoveryState.hasInstanceChoice).toBe(true);
		switchToSession("picked-session", "conduit", () => new Promise(() => {}));
		expect(discoveryState.hasInstanceChoice).toBe(false);
		sessionState.currentId = null;
		expect(discoveryState.hasModelChoice).toBe(false);
		expect(getEffectiveInstanceId()).toBe("claude");
		sessionState.currentId = "picked-session";
		applyGetModelsResponse({
			...defaults,
			active: { model: "gpt", provider: "openai" },
		});
		sessionState.currentId = null;
		expect(getEffectiveInstanceId()).toBe("claude");
		applyGetModelsResponse(defaults);
		chooseVariant("high");
		expect(getEffectiveInstanceId()).toBe("claude");
		expect(getDraftPick()).toMatchObject({
			instanceId: "claude",
			model: { modelId: "sonnet", providerId: "claude", variant: "high" },
		});
		selectInstance("opencode");
		expect(getDraftPick()).toMatchObject({
			instanceId: "opencode",
			model: { modelId: "gpt", providerId: "openai" },
		});
	});

	it("does not persist an instance pick across a page load", async () => {
		const write = vi.fn();
		vi.stubGlobal("localStorage", {
			getItem: vi.fn(),
			setItem: write,
			removeItem: vi.fn(),
		});
		selectInstance("claude-2");
		expect(write).not.toHaveBeenCalled();
		vi.resetModules();
		const reloaded = await import(
			"../../../src/lib/frontend/stores/discovery.svelte.js"
		);
		reloaded.handleDefaultModelInfo({ model: "sonnet", provider: "claude" });
		reloaded.handleModelList({ providers: defaults.providers });
		reloaded.applyGetModelsResponse({
			projectSlug: "conduit",
			instanceId: "opencode",
			providers: defaults.providers.filter(
				(provider) => provider.id !== "claude",
			),
		});
		reloaded.handleHarnessDefaults({
			_tag: "harnessDefaults",
			claude: {
				status: "ok",
				pick: {
					modelId: "sonnet",
					providerId: "claude",
					effort: "",
					contextWindow: "",
				},
			},
			opencode: {
				status: "ok",
				pick: {
					modelId: "gpt",
					providerId: "openai",
					effort: "",
					contextWindow: "",
				},
			},
		});
		reloaded.applyGetModelsResponse(defaults);
		expect(reloaded.getEffectiveInstanceId()).toBe("claude");
		expect(reloaded.getDraftPick()?.instanceId).toBe("claude");
		vi.unstubAllGlobals();
	});
});
