import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelSelector from "../../../src/lib/frontend/components/model/ModelSelector.svelte";
import {
	clearDiscoveryState,
	discoveryState,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

const wsSendSpy = vi.hoisted(() => vi.fn());
const getAgentsRpcSpy = vi.hoisted(() =>
	vi.fn(async (_input: unknown) => ({ projectSlug: "project-a", agents: [] })),
);
const switchModelRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: { modelId: string; providerId: string }) => ({
		projectSlug: "project-a",
		model: input.modelId,
		provider: input.providerId,
		variant: "fast",
		variants: ["standard", "fast"],
	})),
);
const setDefaultModelRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: { model: string; provider: string }) => ({
		projectSlug: "project-a",
		model: input.model,
		provider: input.provider,
		variant: "",
		variants: [],
	})),
);
const reloadProviderSessionRpcSpy = vi.hoisted(() =>
	vi.fn(async (input: { projectSlug: string; sessionId: string }) => ({
		projectSlug: input.projectSlug,
		sessionId: input.sessionId,
	})),
);
const showToastSpy = vi.hoisted(() => vi.fn());
const emptyComponent = vi.hoisted(
	() => async () => import("../../helpers/Empty.svelte"),
);
const closeableEmptyComponent = vi.hoisted(
	() => async () => import("../../helpers/CloseableEmpty.svelte"),
);

vi.mock(
	"../../../src/lib/frontend/components/shared/Icon.svelte",
	emptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/model/ModelVariant.svelte",
	closeableEmptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/model/ContextWindowSelector.svelte",
	closeableEmptyComponent,
);
vi.mock(
	"../../../src/lib/frontend/components/shared/use-click-outside.svelte.js",
	() => ({
		clickOutside: () => ({ destroy: () => {} }),
	}),
);
vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	wsSend: (...args: unknown[]) => wsSendSpy(...args),
}));
vi.mock("../../../src/lib/frontend/stores/router.svelte.js", () => ({
	getCurrentSlug: () => "project-a",
}));
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	getAgentsRpc: (input: unknown) => getAgentsRpcSpy(input),
	reloadProviderSessionRpc: (input: {
		projectSlug: string;
		sessionId: string;
		commandId: string;
	}) => reloadProviderSessionRpcSpy(input),
	setDefaultModelRpc: (input: { model: string; provider: string }) =>
		setDefaultModelRpcSpy(input),
	switchModelRpc: (input: { modelId: string; providerId: string }) =>
		switchModelRpcSpy(input),
}));
vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: showToastSpy,
}));

describe("ModelSelector", () => {
	beforeEach(() => {
		wsSendSpy.mockClear();
		getAgentsRpcSpy.mockClear();
		switchModelRpcSpy.mockClear();
		setDefaultModelRpcSpy.mockClear();
		reloadProviderSessionRpcSpy.mockClear();
		showToastSpy.mockClear();
		clearDiscoveryState();
		discoveryState.currentModelId = "claude-sonnet-4-7";
		discoveryState.currentProviderId = "claude";
		discoveryState.defaultModelId = "claude-sonnet-4-7";
		discoveryState.defaultProviderId = "claude";
		discoveryState.providers = [
			{
				id: "claude",
				name: "Anthropic - claude",
				configured: true,
				models: [
					{
						id: "claude-sonnet-4-7",
						name: "Claude Sonnet 4.7",
						provider: "claude",
					},
					{
						id: "claude-opus-4-7",
						name: "Claude Opus 4.7",
						provider: "claude",
					},
				],
			},
		];
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
	});

	it("refreshes active-provider agents after switching model", async () => {
		const { container, getByTitle } = render(ModelSelector);
		await fireEvent.click(getByTitle("Switch model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"]',
		);
		expect(opus).not.toBeNull();

		await fireEvent.click(opus as HTMLButtonElement);

		await waitFor(() => {
			expect(switchModelRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				modelId: "claude-opus-4-7",
				providerId: "claude",
			});
		});
		expect(wsSendSpy).not.toHaveBeenCalled();
		expect(getAgentsRpcSpy).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "session-1",
		});
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("keeps a successful model switch when the follow-up agent refresh fails", async () => {
		getAgentsRpcSpy.mockRejectedValueOnce(new Error("agent discovery failed"));
		discoveryState.providers = [
			...discoveryState.providers,
			{
				id: "opencode",
				name: "OpenCode Zen",
				configured: true,
				models: [
					{
						id: "nemotron-3-super-free",
						name: "Nemotron 3 Super Free",
						provider: "opencode",
					},
				],
			},
		];

		const { container, getByTitle } = render(ModelSelector);
		await fireEvent.click(getByTitle("Switch model"));
		const nemotron = container.querySelector<HTMLButtonElement>(
			'[data-model-id="nemotron-3-super-free"][data-provider-id="opencode"]',
		);
		expect(nemotron).not.toBeNull();

		await fireEvent.click(nemotron as HTMLButtonElement);

		await waitFor(() => {
			expect(switchModelRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				modelId: "nemotron-3-super-free",
				providerId: "opencode",
			});
		});
		await waitFor(() => {
			expect(getAgentsRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
			});
		});
		expect(discoveryState.currentModelId).toBe("nemotron-3-super-free");
		expect(discoveryState.currentProviderId).toBe("opencode");
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("sets the default model through RPC", async () => {
		const { container, getByTitle } = render(ModelSelector);
		await fireEvent.click(getByTitle("Switch model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"]',
		);
		const defaultButton = opus?.parentElement?.querySelector<HTMLButtonElement>(
			'[title="Set as default model"]',
		);
		expect(defaultButton).not.toBeNull();

		await fireEvent.click(defaultButton as HTMLButtonElement);

		await waitFor(() => {
			expect(setDefaultModelRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				model: "claude-opus-4-7",
				provider: "claude",
			});
		});
		expect(wsSendSpy).not.toHaveBeenCalled();
		expect(discoveryState.defaultModelId).toBe("claude-opus-4-7");
		expect(discoveryState.defaultProviderId).toBe("claude");
	});

	it("reloads provider session through RPC", async () => {
		const { getByTitle } = render(ModelSelector);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTitle("Reload skills and commands from disk"));

		await waitFor(() => {
			expect(reloadProviderSessionRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				commandId: expect.any(String),
			});
		});
		expect(wsSendSpy).not.toHaveBeenCalled();
		expect(showToastSpy).toHaveBeenCalledWith("Reloading skills…", {
			duration: 1500,
		});
	});
});
