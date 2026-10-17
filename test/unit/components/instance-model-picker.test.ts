import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import InstanceModelPicker from "../../../src/lib/frontend/components/model/InstanceModelPicker.svelte";
import {
	applyGetModelsResponse,
	chooseModel,
	clearDiscoveryState,
	discoveryState,
	handleDefaultModelInfo,
	handleModelInfo,
	handleModelList,
	selectInstance,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { attachedProjectState } from "../../../src/lib/frontend/stores/router.svelte.js";
import {
	clearSessionState,
	sessionState,
} from "../../../src/lib/frontend/stores/session.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";
import type { ProviderInfo } from "../../../src/lib/frontend/types.js";
import { seedRootSessions } from "../stores/session-fixtures.js";

const getAgentsRpcSpy = vi.hoisted(() =>
	vi.fn((_input: unknown) =>
		Promise.resolve({ projectSlug: "project-a", agents: [] }),
	),
);
const switchModelRpcSpy = vi.hoisted(() =>
	vi.fn((input: { modelId: string; providerId: string }) =>
		Promise.resolve({
			projectSlug: "project-a",
			model: input.modelId,
			provider: input.providerId,
			variant: "fast",
			variants: ["standard", "fast"],
		}),
	),
);
const setDefaultModelRpcSpy = vi.hoisted(() =>
	vi.fn((input: { model: string; provider: string }) =>
		Promise.resolve({
			projectSlug: "project-a",
			model: input.model,
			provider: input.provider,
			variant: "",
			variants: [],
		}),
	),
);
const reloadSessionSpy = vi.hoisted(() =>
	vi.fn((_tag: string, input: { sessionId: string }) =>
		Promise.resolve({
			projectSlug: "project-a",
			sessionId: input.sessionId,
		}),
	),
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
vi.mock(
	"../../../src/lib/frontend/stores/router.svelte.js",
	async (importOriginal) => ({
		...(await importOriginal<object>()),
		getCurrentSlug: () => "project-a",
	}),
);
vi.mock("../../../src/lib/frontend/transport/ws-rpc-client.js", () => ({
	rpc: (
		tag:
			| "GetModels"
			| "GetCommands"
			| "GetAgents"
			| "SetDefaultModel"
			| "SwitchModel"
			| "ReloadProviderSession",
		input: never,
	) =>
		tag === "GetModels" || tag === "GetCommands"
			? Promise.reject(new Error("Catalog not configured in this fixture"))
			: tag === "ReloadProviderSession"
				? reloadSessionSpy(tag, input)
				: {
						GetAgents: getAgentsRpcSpy,
						SetDefaultModel: setDefaultModelRpcSpy,
						SwitchModel: switchModelRpcSpy,
					}[tag](input),
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
		Element.prototype.scrollIntoView = vi.fn();
		sessionViewState.compact = false;
		getAgentsRpcSpy.mockClear();
		switchModelRpcSpy.mockClear();
		setDefaultModelRpcSpy.mockClear();
		reloadSessionSpy.mockClear();
		showToastSpy.mockClear();
		clearDiscoveryState();
		clearSessionState();
		attachedProjectState.slug = "project-a";
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
					id: "opencode",
					name: "OpenCode",
					driver: "opencode",
					isDefault: true,
					port: 4096,
					managed: true,
					status: "healthy",
					restartCount: 0,
					createdAt: 0,
				},
			],
		});
		seedRootSessions([
			{
				id: "session-1",
				title: "Session",
				projectSlug: "project-a",
				accountId: "personal",
			},
		]);
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
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "claude",
				providers: [CLAUDE_PROVIDER],
				active: { model: "claude-sonnet-4-7", provider: "claude" },
				variant: { variant: "", variants: [] },
				contextWindow: { contextWindow: "", options: [] },
			},
			"session-1",
		);
	});

	afterEach(() => {
		cleanup();
		clearSessionState();
		applyInstanceListResponse({ instances: [] });
		sessionViewState.compact = false;
	});

	// The drift indicator moved to InputArea (it is a status line, not a
	// control); its copy and gating are covered by features/model-drift.feature.
	it.each([
		null,
		"session-1",
	])("keeps held draft and session models when the project default updates (%s)", async (sessionId) => {
		sessionState.currentId = sessionId;
		if (!sessionId) {
			selectInstance("claude");
			chooseModel({ modelId: "claude-sonnet-4-7", providerId: "claude" });
		}
		const { getByTitle } = render(InstanceModelPicker);
		expect(getByTitle("Switch model").textContent).toContain("Sonnet 4.7");
		handleDefaultModelInfo({
			model: "claude-opus-4-7",
			provider: "claude",
			variant: "",
		});
		await tick();
		await waitFor(() => {
			expect(getByTitle("Switch model").textContent).toContain("Sonnet 4.7");
		});
	});

	it.each([
		null,
		"session-1",
	])("uses Claude context metadata when OpenCode has the same model id (%s)", async (sessionId) => {
		sessionState.currentId = sessionId;
		handleModelList({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					configured: true,
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Sonnet",
							provider: "anthropic",
							contextWindowOptions: [{ value: "200k", label: "200K" }],
						},
					],
				},
				{
					...CLAUDE_PROVIDER,
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Sonnet",
							provider: "claude",
							contextWindowOptions: [{ value: "1m", label: "1M" }],
						},
					],
				},
			],
		});
		if (!sessionId) selectInstance("personal");
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "personal",
				providers: discoveryState.providers,
				active: { model: "claude-sonnet-4-7", provider: "claude" },
				variant: { variant: "", variants: [] },
				contextWindow: {
					contextWindow: "1m",
					options: [{ value: "1m", label: "1M" }],
				},
			},
			sessionId ?? undefined,
		);
		const { getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTestId("composer-harness-trigger"));
		expect(getByTestId("picker-row-context").textContent).toContain("1M");
	});

	// GetModels resolves a persisted API-form model to its catalog identity and
	// explicit context window before the composer displays it.
	it.each([
		[390, "Opus"],
		[1024, "Opus"],
	])("labels a resolved 1M-window GetModels pick by its catalog entry at width %i", async (width, expected) => {
		sessionViewState.compact = width <= 767;
		handleModelList({
			providers: [
				{
					...CLAUDE_PROVIDER,
					models: [{ id: "opus", name: "Opus", provider: "claude" }],
				},
			],
		});
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				instanceId: "claude",
				providers: discoveryState.providers,
				active: { model: "opus", provider: "claude" },
				variant: { variant: "", variants: [] },
				contextWindow: {
					contextWindow: "1m",
					options: [{ value: "1m", label: "1M" }],
				},
			},
			"session-1",
		);
		const { getByTestId } = render(InstanceModelPicker);
		await tick();
		const label = getByTestId("model-picker-trigger")
			.querySelector(".model-label")
			?.textContent?.trim();
		expect(label).toBe(expected);
	});

	it("refreshes active-provider agents after switching model", async () => {
		const { container, getByTitle } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"]',
		);
		expect(opus).not.toBeNull();

		await fireEvent.click(opus as HTMLButtonElement);

		await waitFor(() => {
			expect(switchModelRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
				modelId: "claude-opus-4-7",
				providerId: "claude",
			});
		});
		expect(getAgentsRpcSpy).toHaveBeenCalledWith({
			sessionId: "session-1",
		});
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("keeps a successful model switch when the follow-up agent refresh fails", async () => {
		getAgentsRpcSpy.mockRejectedValueOnce(new Error("agent discovery failed"));

		const { container, getByTitle } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		const opus = container.querySelector<HTMLButtonElement>(
			'[data-model-id="claude-opus-4-7"][data-provider-id="claude"]',
		);
		expect(opus).not.toBeNull();

		await fireEvent.click(opus as HTMLButtonElement);

		await waitFor(() => {
			expect(switchModelRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
				modelId: "claude-opus-4-7",
				providerId: "claude",
			});
		});
		await waitFor(() => {
			expect(getAgentsRpcSpy).toHaveBeenCalledWith({
				sessionId: "session-1",
			});
		});
		expect(discoveryState.currentModelId).toBe("claude-opus-4-7");
		expect(discoveryState.currentProviderId).toBe("claude");
		expect(discoveryState.currentVariant).toBe("fast");
		expect(discoveryState.availableVariants).toEqual(["standard", "fast"]);
	});

	it("sets the default model through RPC", async () => {
		const { container, getByTitle } = render(InstanceModelPicker);
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
		expect(discoveryState.defaultModelId).toBe("claude-opus-4-7");
		expect(discoveryState.defaultProviderId).toBe("claude");
	});

	it("renders screen-reader text for the default model star", async () => {
		const { getByText, getByTitle } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));

		const defaultModelText = getByText("Default model");
		expect(defaultModelText.classList.contains("sr-only")).toBe(true);
		expect(getByText("(default)").hasAttribute("title")).toBe(false);
	});

	it("reloads provider session through RPC", async () => {
		const { getByTitle } = render(InstanceModelPicker);
		await fireEvent.click(getByTitle("Switch model"));
		await fireEvent.click(getByTitle("Reload skills and commands from disk"));

		await waitFor(() => {
			expect(reloadSessionSpy).toHaveBeenCalledWith("ReloadProviderSession", {
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

		const { container, getByTestId } = render(InstanceModelPicker);
		await fireEvent.click(getByTestId("composer-harness-trigger"));

		const claudeRail = getByTestId("picker-harness-claude");
		const opencodeRail = getByTestId("picker-harness-opencode");
		expect(claudeRail.getAttribute("aria-checked")).toBe("true");
		expect(opencodeRail.getAttribute("aria-disabled")).toBe("true");

		// A disabled instance cannot change the bound harness or model scope.
		await fireEvent.click(opencodeRail);
		expect(claudeRail.getAttribute("aria-checked")).toBe("true");
		await fireEvent.click(getByTestId("picker-row-model"));
		expect(
			container.querySelector('[data-model-id="claude-sonnet-4"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-model-id="claude-opus-4-7"]'),
		).not.toBeNull();
	});
});
