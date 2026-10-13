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
	isDefault: id === "claude" || id === "opencode",
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
		expect(getDraftPick()).toBeUndefined();
		handleModelList({
			accountId: "claude-2",
			providers: defaults.providers.filter(
				(provider) => provider.id === "claude",
			),
		});
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
		handleModelList({
			accountId: "claude-2",
			providers: defaults.providers.filter(
				(provider) => provider.id === "claude",
			),
		});
		applyGetModelsResponse(defaults);
		expect(getEffectiveInstanceId()).toBe("claude-2");
		chooseVariant("high");
		handleDefaultModelInfo({ model: "gpt", provider: "openai" });
		expect(getDraftPick()).toMatchObject({
			instanceId: "claude-2",
			model: { modelId: "sonnet", providerId: "claude", variant: "high" },
		});
	});

	it("uses the selected driver's default when the picked account disappears", () => {
		selectInstance("claude-2");
		applyInstanceListResponse({
			instances: instances.filter((instance) => instance.id !== "claude-2"),
			providerCapabilities: {},
		});
		expect(getEffectiveInstanceId()).toBe("claude");
		expect(getDraftPick()?.instanceId).toBe("claude");
	});

	it("follows a promoted default and never falls back to another driver", () => {
		clearDiscoveryState();
		applyInstanceListResponse({
			instances: instances
				.filter((instance) => instance.id === "claude-2")
				.map((instance) => ({ ...instance, isDefault: true })),
			providerCapabilities: {},
		});
		handleDefaultModelInfo({ model: "sonnet", provider: "claude" });
		expect(getEffectiveInstanceId()).toBe("claude-2");
		applyInstanceListResponse({
			instances: instances.filter((instance) => instance.driver === "opencode"),
			providerCapabilities: {},
		});
		expect(getEffectiveInstanceId()).toBeUndefined();
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
		const { applyInstanceListResponse: applyReloadedInstances } = await import(
			"../../../src/lib/frontend/stores/instance.svelte.js"
		);
		applyReloadedInstances({ instances });
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
