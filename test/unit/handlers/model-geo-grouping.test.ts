// ─── Tests: Bedrock geo-routing model grouping ───────────────────────────────
// OpenCode's amazon-bedrock catalog lists each model once per inference-profile
// scope (bare id, us., eu., apac., global.). groupGeoRoutingModels collapses
// them into one entry with routingOptions (value = full model id), defaulting
// to the global profile — the only scope AWS guarantees is invokable from any
// commercial source region.

import { describe, it } from "@effect/vitest";
import { Cause, Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeOverridesStateLive } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	getModelsResponse,
	groupGeoRoutingModels,
} from "../../../src/lib/handlers/model.js";
import {
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const bedrockModel = (id: string, name: string) => ({
	id,
	name,
	provider: "amazon-bedrock",
});

describe("groupGeoRoutingModels", () => {
	it("groups geo-prefix variants into one entry defaulting to global", () => {
		const grouped = groupGeoRoutingModels([
			bedrockModel(
				"global.anthropic.claude-fable-5",
				"Claude Fable 5 (Global)",
			),
			bedrockModel("anthropic.claude-fable-5", "Claude Fable 5"),
			bedrockModel("us.anthropic.claude-fable-5", "Claude Fable 5 (US)"),
			bedrockModel("eu.anthropic.claude-fable-5", "Claude Fable 5 (EU)"),
		]);

		expect(grouped).toHaveLength(1);
		expect(grouped[0]).toMatchObject({
			id: "global.anthropic.claude-fable-5",
			name: "Claude Fable 5",
		});
		expect(grouped[0]?.routingOptions).toEqual([
			{
				value: "global.anthropic.claude-fable-5",
				label: "Global",
				isDefault: true,
			},
			{ value: "us.anthropic.claude-fable-5", label: "US" },
			{ value: "eu.anthropic.claude-fable-5", label: "EU" },
			{ value: "anthropic.claude-fable-5", label: "In-region" },
		]);
	});

	it("passes ungrouped models through unchanged", () => {
		const models = [
			bedrockModel("mistral.mistral-large-2402-v1:0", "Mistral Large"),
			bedrockModel(
				"global.anthropic.claude-haiku-4-5",
				"Claude Haiku (Global)",
			),
		];
		const grouped = groupGeoRoutingModels(models);
		expect(grouped).toEqual(models);
		expect(grouped[0]).not.toHaveProperty("routingOptions");
	});

	it.effect(
		"getModelsResponse sorts models by name within each provider",
		() => {
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
						connected: ["openai"],
						defaults: {},
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [
									{ id: "o3", name: "o3" },
									{ id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
									{ id: "gpt-4.1", name: "gpt-4.1" },
								],
							},
						],
					}),
				),
				getSession: vi.fn(() =>
					Effect.fail(new Cause.UnknownException("no session")),
				),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(
					OrchestrationEngineTag,
					withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [] })) }),
				),
				makeOverridesStateLive(),
			);

			return getModelsResponse().pipe(
				Effect.provide(layer),
				Effect.tap((response) => {
					const openai = response.providers.find((p) => p.id === "openai");
					expect(openai?.models.map((m) => m.name)).toEqual([
						"gpt-4.1",
						"GPT-5.6 Sol",
						"o3",
					]);
				}),
			);
		},
	);

	it.effect("getModelsResponse groups only the amazon-bedrock provider", () => {
		const modelService = {
			listProviders: vi.fn(() =>
				Effect.succeed({
					connected: ["amazon-bedrock", "openai"],
					defaults: {},
					providers: [
						{
							id: "amazon-bedrock",
							name: "Amazon Bedrock",
							models: [
								{ id: "anthropic.claude-fable-5", name: "Claude Fable 5" },
								{
									id: "global.anthropic.claude-fable-5",
									name: "Claude Fable 5 (Global)",
								},
							],
						},
						{
							id: "openai",
							name: "OpenAI",
							models: [
								{
									id: "us.gpt-5.6-sol",
									name: "us dot is not a geo prefix here",
								},
							],
						},
					],
				}),
			),
			getSession: vi.fn(() =>
				Effect.fail(new Cause.UnknownException("no session")),
			),
			persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
		};
		const layer = Layer.mergeAll(
			Layer.succeed(OpenCodeModelServiceTag, modelService),
			Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
			Layer.succeed(LoggerTag, makeMockLogger()),
			Layer.succeed(
				OrchestrationEngineTag,
				withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [] })) }),
			),
			makeOverridesStateLive(),
		);

		return getModelsResponse().pipe(
			Effect.provide(layer),
			Effect.tap((response) => {
				const bedrock = response.providers.find(
					(p) => p.id === "amazon-bedrock",
				);
				expect(bedrock?.models).toHaveLength(1);
				expect(bedrock?.models[0]).toMatchObject({
					id: "global.anthropic.claude-fable-5",
					name: "Claude Fable 5",
				});
				expect(bedrock?.models[0]?.routingOptions).toHaveLength(2);

				const openai = response.providers.find((p) => p.id === "openai");
				expect(openai?.models[0]).toMatchObject({ id: "us.gpt-5.6-sol" });
				expect(openai?.models[0]).not.toHaveProperty("routingOptions");
			}),
		);
	});
});
