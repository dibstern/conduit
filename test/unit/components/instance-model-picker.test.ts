import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstanceModelPicker from "../../../src/lib/frontend/components/model/InstanceModelPicker.svelte";
import {
	clearDiscoveryState,
	discoveryState,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { ProviderInfo } from "../../../src/lib/frontend/types.js";

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

vi.mock("../../../src/lib/frontend/components/ui/Icon.svelte", emptyComponent);
vi.mock(
	"../../../src/lib/frontend/components/model/ModelVariant.svelte",
	closeableEmptyComponent,
);
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

const CLAUDE_PROVIDER: ProviderInfo = {
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
};

describe("InstanceModelPicker", () => {
	beforeEach(() => {
		getAgentsRpcSpy.mockClear();
		switchModelRpcSpy.mockClear();
		setDefaultModelRpcSpy.mockClear();
		reloadProviderSessionRpcSpy.mockClear();
		showToastSpy.mockClear();
		clearDiscoveryState();
		handleModelInfo({
			model: "claude-sonnet-4-7",
			provider: "claude",
		});
		handleDefaultModelInfo({
			model: "claude-sonnet-4-7",
			provider: "claude",
			variant: "",
		});
		handleModelList({ providers: [CLAUDE_PROVIDER] });
		sessionState.currentId = "session-1";
	});

	afterEach(() => {
		cleanup();
		sessionState.currentId = null;
	});

	// The drift indicator moved to InputArea (it is a status line, not a
	// control); its copy and gating are covered by features/model-drift.feature.
	it.each([
		null,
		"session-1",
	])("derives the displayed model from a default update only without a session (%s)", async (sessionId) => {
		sessionState.currentId = sessionId;
		const { getByTitle } = render(InstanceModelPicker);
		expect(getByTitle("Switch model").textContent).toContain("Sonnet 4.7");
		handleDefaultModelInfo({
			model: "claude-opus-4-7",
			provider: "claude",
			variant: "",
		});
		await tick();
		await waitFor(() => {
			expect(getByTitle("Switch model").textContent).toContain(
				sessionId ? "Sonnet 4.7" : "Opus 4.7",
			);
		});
	});

	// Turns persist the API form of the model ("opus[1m]"), and reopening a
	// session restores that string, while the SDK catalog may advertise only
	// the bare alias ("opus"). The trigger fell back to the raw id and the
	// phone tag sliced it to "opu".
	it.each([
		[390, "Opus"],
		[1024, "Opus"],
	])("labels a restored 1M-window model by its catalog entry at width %i", async (width, expected) => {
		window.innerWidth = width;
		handleModelList({
			providers: [
				{
					...CLAUDE_PROVIDER,
					models: [{ id: "opus", name: "Opus", provider: "claude" }],
				},
			],
		});
		handleModelInfo({
			model: "opus[1m]",
			provider: "claude",
		});
		const { getByTestId } = render(InstanceModelPicker);
		await tick();
		const label = getByTestId("model-picker-trigger")
			.querySelector(".model-label")
			?.textContent?.trim();
		expect(label).toBe(expected);
		window.innerWidth = 1024;
	});

	it("refreshes active-provider agents after switching model", async () => {
		const { container, getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-model"));
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
		expect(getAgentsRpcSpy).toHaveBeenCalledWith({
			projectSlug: "project-a",
			sessionId: "session-1",
		});
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("keeps a successful model switch when the follow-up agent refresh fails", async () => {
		getAgentsRpcSpy.mockRejectedValueOnce(new Error("agent discovery failed"));

		const { container, getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"][data-provider-id="claude"]',
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
		await waitFor(() => {
			expect(getAgentsRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
			});
		});
		expect(discoveryState.currentModelId).toBe("claude-opus-4-7");
		expect(discoveryState.currentProviderId).toBe("claude");
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("sets the default model through RPC", async () => {
		const { container, getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-model"));
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
		expect(discoveryState.defaultModelId).toBe("claude-opus-4-7");
		expect(discoveryState.defaultProviderId).toBe("claude");
	});

	it("renders screen-reader text for the default model star", async () => {
		const { getByText, getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-model"));

		const defaultModelText = getByText("Default model");
		expect(defaultModelText.classList.contains("sr-only")).toBe(true);
		expect(getByText("(default)").hasAttribute("title")).toBe(false);
	});

	it("reloads provider session through RPC", async () => {
		const { getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-model"));
		await fireEvent.click(getByTitle("Reload skills and commands from disk"));

		await waitFor(() => {
			expect(reloadProviderSessionRpcSpy).toHaveBeenCalledWith({
				projectSlug: "project-a",
				sessionId: "session-1",
				commandId: expect.any(String),
			});
		});
		expect(showToastSpy).toHaveBeenCalledWith("Reloading skills…", {
			duration: 1500,
		});
	});

	it("locks the harness to the bound instance for an existing session", async () => {
		handleModelList({
			providers: [
				CLAUDE_PROVIDER,
				{
					id: "anthropic",
					name: "Anthropic - opencode",
					configured: true,
					models: [
						{
							id: "claude-sonnet-4",
							name: "claude-sonnet-4",
							provider: "anthropic",
						},
					],
				},
			],
		});

		const { container, getByTitle, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTestId("picker-row-harness"));

		const claudeRail = container.querySelector<HTMLButtonElement>(
			'[data-testid="picker-instance-claude"]',
		);
		const opencodeRail = container.querySelector<HTMLButtonElement>(
			'[data-testid="picker-instance-opencode"]',
		);
		expect(claudeRail?.getAttribute("aria-pressed")).toBe("true");
		expect(opencodeRail?.getAttribute("aria-disabled")).toBe("true");

		// A disabled instance cannot change the bound harness or model scope.
		await fireEvent.click(opencodeRail as HTMLButtonElement);
		expect(claudeRail?.getAttribute("aria-pressed")).toBe("true");
		await fireEvent.click(getByTestId("picker-back"));
		await fireEvent.click(getByTestId("picker-row-model"));
		expect(
			container.querySelector('[data-model-id="claude-sonnet-4"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-model-id="claude-opus-4-7"]'),
		).not.toBeNull();
	});
});
