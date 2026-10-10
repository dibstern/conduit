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
	getChosenModel,
	getEffectiveInstanceId,
	handleModelInfo,
	handleModelList,
	handlePermissionModeInfo,
	handleVariantInfo,
} from "../../../src/lib/frontend/stores/discovery.svelte.js";
import { applyProjectSetting } from "../../../src/lib/frontend/stores/project-settings.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import type { GetModelsResponse } from "../../../src/lib/frontend/transport/ws-rpc.js";

beforeEach(() => {
	clearClaudeSettingsState();
	clearDiscoveryState();
	sessionState.currentId = null;
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
		handleModelInfo({ model: "draft-choice", provider: "openai" });
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
			providers,
			active: { model: "native-default", provider: "openai" },
			variant: { variant: "low", variants: ["low", "high"] },
		});
		await hydration;
		if (order === "rpc-first") applyDefault();
		expect(discoveryState.defaultModelId).toBe("native-default");
		expect(discoveryState.currentModelId).toBe(modelId);
		expect(discoveryState.currentVariant).toBe("high");
		expect(getChosenModel("opencode")).toEqual({
			modelId,
			providerId: "openai",
			variant: "high",
		});
	});

	it("applies the session model after a draft binds to a session", () => {
		chooseModel({ modelId: "draft-choice", providerId: "openai" });
		chooseVariant("high");
		sessionState.currentId = "session-1";
		applyGetModelsResponse({
			projectSlug: "project-a",
			providers: [],
			active: { model: "session-model", provider: "openai" },
			variant: { variant: "low", variants: ["low"] },
		});
		expect(discoveryState.currentModelId).toBe("session-model");
		expect(discoveryState.currentVariant).toBe("low");
		expect(discoveryState.hasModelChoice).toBe(false);
	});
	it.each([
		false,
		true,
	])("follows a hydrated default only before an explicit draft effort choice (%s)", (chosen) => {
		handleModelList({
			providers: [
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
			],
		});
		handleModelInfo({ model: "old", provider: "openai" });
		if (chosen) chooseVariant("high");
		applyProjectSetting({
			_tag: "defaultModel",
			model: "native",
			provider: "claude",
			variant: "",
		});
		expect(discoveryState.defaultModelId).toBe("native");
		expect(discoveryState.currentModelId).toBe(chosen ? "old" : "native");
		expect(getEffectiveInstanceId()).toBe(chosen ? "opencode" : "claude");
		expect(getActiveModelVariants()).toEqual(chosen ? ["high"] : ["max"]);
		if (!chosen) chooseVariant("max");
		expect(getChosenModel(chosen ? "opencode" : "claude")).toEqual(
			chosen
				? { modelId: "old", providerId: "openai", variant: "high" }
				: { modelId: "native", providerId: "claude", variant: "max" },
		);
	});
	it.each([
		"draft-choice",
		"native-default",
	])("keeps the draft model %s in the creation request when a default is hydrated", (modelId) => {
		handleModelList({
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
		chooseModel({ modelId, providerId: "openai" });
		expect(getChosenModel("opencode")).toEqual({
			modelId,
			providerId: "openai",
		});

		applyProjectSetting({
			_tag: "defaultModel",
			model: "native-default",
			provider: "openai",
			variant: "",
		});

		expect(discoveryState.defaultModelId).toBe("native-default");
		expect(discoveryState.currentModelId).toBe(modelId);
		expect(getChosenModel("opencode")).toEqual({
			modelId,
			providerId: "openai",
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
		handlePermissionModeInfo({ mode: "acceptEdits" });

		applyProjectSetting({
			_tag: "defaultPermissionMode",
			mode: "full",
		});

		expect(discoveryState.defaultPermissionMode).toBe("full");
		expect(discoveryState.permissionMode).toBe("acceptEdits");
	});

	it("applies a defaultModel fact without changing the session variant", () => {
		handleVariantInfo({
			variant: "low",
			variants: ["low", "high"],
		});

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
