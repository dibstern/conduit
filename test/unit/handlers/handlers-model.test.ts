import { describe, expect, it, vi } from "vitest";
import {
	handleGetModels,
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
} from "../../../src/lib/handlers/model.js";
import type { PayloadMap } from "../../../src/lib/handlers/payloads.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../../../src/lib/relay/relay-settings.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

vi.mock("../../../src/lib/relay/relay-settings.js", async (importOriginal) => {
	const original =
		await importOriginal<
			typeof import("../../../src/lib/relay/relay-settings.js")
		>();
	return {
		...original,
		saveRelaySettings: vi.fn(),
		loadRelaySettings: vi.fn().mockReturnValue({}),
	};
});

// ─── handleSetDefaultModel ──────────────────────────────────────────────────

describe("handleSetDefaultModel", () => {
	it("persists model and broadcasts model_info + default_model_info", async () => {
		const deps = createMockHandlerDeps();
		await handleSetDefaultModel(deps, "client-1", {
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
		expect(deps.overrides.setDefaultModel).toHaveBeenCalledWith({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "model_info" }),
		);
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({ type: "default_model_info" }),
		);
	});

	it("ignores empty provider or model", async () => {
		const deps = createMockHandlerDeps();
		await handleSetDefaultModel(deps, "client-1", {
			provider: "",
			model: "",
		});
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("ignores missing fields", async () => {
		const deps = createMockHandlerDeps();
		await handleSetDefaultModel(
			deps,
			"client-1",
			{} as unknown as PayloadMap["set_default_model"],
		);
		expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
	});

	it("calls saveRelaySettings with defaultModel so merge preserves defaultVariants", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "high" },
		});
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSetDefaultModel(deps, "client-1", {
			provider: "openai",
			model: "gpt-4o",
		});
		expect(saveRelaySettings).toHaveBeenCalledWith(
			expect.objectContaining({ defaultModel: "openai/gpt-4o" }),
			deps.config.configDir,
		);
		// saveRelaySettings is mocked here, but the real implementation (Task 1)
		// does load-merge-save, so existing defaultVariants are preserved
	});
});

// ─── handleSwitchVariant ────────────────────────────────────────────────────

describe("handleSwitchVariant", () => {
	it("stores variant per-session and broadcasts variant_info", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		await handleSwitchVariant(deps, "c1", { variant: "high" });
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "high");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});

	it("persists variant to defaultVariants in settings", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "high" });
		expect(saveRelaySettings).toHaveBeenCalledWith(
			{ defaultVariants: { "anthropic/claude-opus-4-6": "high" } },
			deps.config.configDir,
		);
	});

	it("sends variant_info to client when no session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "low" });
		// Without a session, sets the global default variant
		expect(deps.overrides.defaultVariant).toBe("low");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"c1",
			expect.objectContaining({ type: "variant_info", variant: "low" }),
		);
	});

	it("handles empty variant (reset to default)", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		await handleSwitchVariant(deps, "c1", { variant: "" });
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
	});
});

// ─── handleSwitchModel ──────────────────────────────────────────────────────

describe("handleSwitchModel", () => {
	it("restores persisted variant and sends variant_info after switching model", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [
						{
							id: "gpt-4o",
							name: "GPT-4o",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "openai/gpt-4o": "high" },
		});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o",
			providerId: "openai",
		});
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "high");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});

	it("clears variant when new model has no variants", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "openai",
					name: "OpenAI",
					models: [{ id: "gpt-4o-mini", name: "GPT-4o Mini" }],
				},
			],
			defaults: {},
			connected: ["openai"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o-mini",
			providerId: "openai",
		});
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "variant_info",
				variant: "",
				variants: [],
			}),
		);
	});

	it("validates persisted variant against available list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, medium: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		// Persisted variant "max" no longer available
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "max" },
		});
		await handleSwitchModel(deps, "c1", {
			modelId: "claude-opus-4-6",
			providerId: "anthropic",
		});
		// Should fall back to "" since "max" is not in available variants
		expect(deps.overrides.setVariant).toHaveBeenCalledWith("ses-1", "");
	});

	it("still sends model_info as before", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [],
			defaults: {},
			connected: [],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({});
		await handleSwitchModel(deps, "c1", {
			modelId: "gpt-4o",
			providerId: "openai",
		});
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"ses-1",
			expect.objectContaining({
				type: "model_info",
				model: "gpt-4o",
				provider: "openai",
			}),
		);
	});
});

// ─── handleSetDefaultModel — variant wiring ────────────────────────────────

describe("handleSetDefaultModel — variant wiring", () => {
	it("broadcasts variant_info after setting default model", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "high" },
		});
		await handleSetDefaultModel(deps, "c1", {
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});

	it("validates persisted variant and falls back to empty", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, medium: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		// Persisted variant "max" no longer exists
		vi.mocked(loadRelaySettings).mockReturnValue({
			defaultVariants: { "anthropic/claude-opus-4-6": "max" },
		});
		await handleSetDefaultModel(deps, "c1", {
			provider: "anthropic",
			model: "claude-opus-4-6",
		});
		expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "variant_info",
				variant: "",
			}),
		);
	});
});

// ─── handleGetModels — variant wiring ───────────────────────────────────────

describe("handleGetModels — variant wiring", () => {
	it("sends variant_info after model_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("ses-1");
		vi.mocked(deps.overrides.getVariant).mockReturnValue("high");
		vi.mocked(deps.overrides.getModel).mockReturnValue({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		});
		vi.mocked(deps.client.provider.list).mockResolvedValue({
			providers: [
				{
					id: "anthropic",
					name: "Anthropic",
					models: [
						{
							id: "claude-opus-4-6",
							name: "Claude Opus",
							variants: { low: {}, high: {} },
						},
					],
				},
			],
			defaults: {},
			connected: ["anthropic"],
		});
		vi.mocked(deps.client.session.get).mockResolvedValue({
			id: "ses-1",
			projectID: "proj-1",
			directory: "/tmp",
			title: "Test",
			version: "1",
			time: { created: 0, updated: 0 },
			modelID: "claude-opus-4-6",
			providerID: "anthropic",
		} as SessionDetail);
		await handleGetModels(deps, "c1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"c1",
			expect.objectContaining({
				type: "variant_info",
				variant: "high",
				variants: ["low", "high"],
			}),
		);
	});
});
