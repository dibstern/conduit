// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("dompurify", () => ({
	default: { sanitize: (html: string) => html },
}));

import {
	claudeSettingsState,
	clearClaudeSettingsState,
} from "../../../src/lib/frontend/stores/claude-settings.svelte.js";
import {
	applyGetModelsResponse,
	chooseModel,
	chooseVariant,
	clearDiscoveryState,
	discoveryState,
	getActiveModelVariants,
	getDraftPick,
	getEffectiveInstanceId,
	handleModelList,
	handlePermissionModeInfo,
	selectInstance,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyInstanceListResponse } from "../../../src/lib/frontend/stores/instance.svelte.js";
import { applyProjectSetting } from "../../../src/lib/frontend/stores/project-settings.js";
import { openSessionForSetup } from "../../../src/lib/frontend/stories/session-setup.js";
import type { GetModelsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";

beforeEach(() => {
	clearClaudeSettingsState();
	clearDiscoveryState();
	openSessionForSetup(null);
	applyInstanceListResponse({
		instances: (["claude", "opencode"] as const).map((driver) => ({
			id: driver,
			name: driver,
			driver,
			isDefault: true,
			port: 0,
			managed: false,
			status: "healthy",
			restartCount: 0,
			createdAt: 0,
		})),
	});
});

describe("project-settings dispatch", () => {
	it.each([
		["setting-first", "draft-choice"],
		["rpc-first", "draft-choice"],
		["setting-first", "native-default"],
		["rpc-first", "native-default"],
		["setting-first", "effort-only"],
		["rpc-first", "effort-only"],
	])("preserves a draft picked during pending GetModels (%s, %s)", async (order, selection) => {
		const providers = [
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [
					{
						id: "draft-choice",
						name: "Draft",
						provider: "openai",
						variants: ["high"],
					},
					{
						id: "native-default",
						name: "Native",
						provider: "openai",
						variants: ["low", "high"],
					},
				],
			},
		];
		handleModelList({ providers });
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers,
			active: { model: "draft-choice", provider: "openai" },
		});
		let resolveModels!: (response: GetModelsResponse) => void;
		const hydration = new Promise<GetModelsResponse>((resolve) => {
			resolveModels = resolve;
		}).then(applyGetModelsResponse);
		const modelId = selection === "effort-only" ? "draft-choice" : selection;
		if (selection !== "effort-only")
			chooseModel({ modelId, providerId: "openai" });
		chooseVariant("high");
		const applyDefault = () =>
			applyProjectSetting({
				_tag: "defaultModel",
				model: "native-default",
				provider: "openai",
				variant: "low",
			});
		if (order === "setting-first") applyDefault();
		resolveModels({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers,
			active: { model: "native-default", provider: "openai" },
			variant: { variant: "low", variants: ["low", "high"] },
		});
		await hydration;
		if (order === "rpc-first") applyDefault();
		expect(discoveryState.defaultModelId).toBe("native-default");
		expect(discoveryState.currentModelId).toBe(modelId);
		expect(discoveryState.currentVariant).toBe("high");
		expect(getDraftPick()).toEqual({
			instanceId: "opencode",
			model: {
				modelId,
				providerId: "openai",
				variant: "high",
				contextWindow: "",
			},
			permissionMode: "ask",
		});
	});

	it("applies the session model after a draft binds to a session", () => {
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [
						{
							id: "draft-choice",
							name: "Draft",
							provider: "openai",
							variants: ["high"],
						},
					],
				},
			],
			active: { model: "draft-choice", provider: "openai" },
		});
		chooseModel({ modelId: "draft-choice", providerId: "openai" });
		chooseVariant("high");
		openSessionForSetup("session-1", "project-a");
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				providers: [],
				instanceId: "opencode",
				active: { model: "session-model", provider: "openai" },
				variant: { variant: "low", variants: ["low"] },
			},
			"session-1",
		);
		expect(discoveryState.currentModelId).toBe("session-model");
		expect(discoveryState.currentVariant).toBe("low");
		expect(discoveryState.hasModelChoice).toBe(false);
	});
	it.each([
		false,
		true,
	])("keeps a held harness default when the project default changes (%s)", (chosen) => {
		const providers = [
			{
				id: "openai",
				name: "OpenAI",
				configured: true,
				models: [
					{ id: "old", name: "Old", provider: "openai", variants: ["high"] },
				],
			},
			{
				id: "claude",
				name: "Claude",
				configured: true,
				models: [
					{
						id: "native",
						name: "Native",
						provider: "claude",
						variants: ["max"],
					},
				],
			},
		];
		handleModelList({ providers });
		selectInstance("opencode");
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers,
			active: { model: "old", provider: "openai" },
		});
		if (chosen) chooseVariant("high");
		applyProjectSetting({
			_tag: "defaultModel",
			model: "native",
			provider: "claude",
			variant: "",
		});
		expect(discoveryState.defaultModelId).toBe("native");
		expect(discoveryState.currentModelId).toBe("old");
		expect(getEffectiveInstanceId()).toBe("opencode");
		expect(getActiveModelVariants()).toEqual(["high"]);
		if (!chosen) chooseVariant("high");
		expect(getDraftPick()).toEqual({
			instanceId: "opencode",
			model: {
				modelId: "old",
				providerId: "openai",
				variant: "high",
				contextWindow: "",
			},
			permissionMode: "ask",
		});
	});
	it.each([
		"draft-choice",
		"native-default",
	])("keeps the draft model %s in the creation request when a default is hydrated", (modelId) => {
		applyGetModelsResponse({
			projectSlug: "project-a",
			instanceId: "opencode",
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					configured: true,
					models: [
						{ id: "draft-choice", name: "Draft", provider: "openai" },
						{ id: "native-default", name: "Default", provider: "openai" },
					],
				},
			],
		});
		selectInstance("opencode");
		chooseModel({ modelId, providerId: "openai" });
		expect(getDraftPick()).toEqual({
			instanceId: "opencode",
			model: { modelId, providerId: "openai", variant: "", contextWindow: "" },
			permissionMode: "ask",
		});

		applyProjectSetting({
			_tag: "defaultModel",
			model: "native-default",
			provider: "openai",
			variant: "",
		});

		expect(discoveryState.defaultModelId).toBe("native-default");
		expect(discoveryState.currentModelId).toBe(modelId);
		expect(getDraftPick()).toEqual({
			instanceId: "opencode",
			model: { modelId, providerId: "openai", variant: "", contextWindow: "" },
			permissionMode: "ask",
		});
	});

	it("applies a claudeSettings fact to the reactive settings state", () => {
		applyProjectSetting({
			_tag: "claudeSettings",
			overrides: {
				autoCompactEnabled: false,
				autoCompactWindow: 16_000,
			},
		});

		expect(claudeSettingsState.overrides).toEqual({
			autoCompactEnabled: false,
			autoCompactWindow: 16_000,
		});
	});

	it("applies a defaultPermissionMode fact without changing the session mode", () => {
		openSessionForSetup("current-session", "project-a");
		handlePermissionModeInfo({ mode: "acceptEdits" });

		applyProjectSetting({
			_tag: "defaultPermissionMode",
			mode: "full",
		});

		expect(discoveryState.defaultPermissionMode).toBe("full");
		expect(discoveryState.permissionMode).toBe("acceptEdits");
	});

	it("applies a defaultModel fact without changing the session variant", () => {
		openSessionForSetup("current-session", "project-a");
		applyGetModelsResponse(
			{
				projectSlug: "project-a",
				providers: [],
				instanceId: "opencode",
				active: { model: "session-model", provider: "anthropic" },
				variant: { variant: "low", variants: ["low", "high"] },
			},
			"current-session",
		);

		applyProjectSetting({
			_tag: "defaultModel",
			model: "claude-sonnet-4",
			provider: "anthropic",
			variant: "high",
		});

		expect(discoveryState.defaultModelId).toBe("claude-sonnet-4");
		expect(discoveryState.defaultProviderId).toBe("anthropic");
		expect(discoveryState.defaultVariant).toBe("high");
		expect(discoveryState.currentVariant).toBe("low");
	});
});
