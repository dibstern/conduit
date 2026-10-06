import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	makeOverridesStateLive,
	setDefaultModel,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { switchContextWindowForSession } from "../../../src/lib/handlers/context-window.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import {
	makeHandlerLogger,
	makeSessionSettingsLayer,
} from "../../helpers/handler-fakes.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const mockLogger = makeHandlerLogger;

describe("switchContextWindowForSession with Effect override state", () => {
	it.effect(
		"stores a supported session context window without legacy SessionOverrides",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200k", isDefault: true },
				{ value: "1m", label: "1M" },
			];
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				})),
			});
			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
				Layer.succeed(ProviderRegistryTag, new ProviderRegistry()),
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});

				const result = yield* switchContextWindowForSession({
					clientId: "client-1",
					sessionId: "session-42",
					contextWindow: "1m",
				});

				expect(yield* getContextWindow("session-42")).toBe("1m");
				expect(result).toEqual({
					contextWindow: "1m",
					options: contextWindowOptions,
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"stores a supported default context window without a session",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200k", isDefault: true },
				{ value: "1m", label: "1M" },
			];
			const engine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				})),
			});
			const layer = Layer.mergeAll(
				makeSessionSettingsLayer(),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
				Layer.succeed(ProviderRegistryTag, new ProviderRegistry()),
			);

			return Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});

				const result = yield* switchContextWindowForSession({
					clientId: "client-1",
					contextWindow: "1m",
				});

				expect(yield* getDefaultContextWindow()).toBe("1m");
				expect(result).toEqual({
					contextWindow: "1m",
					options: contextWindowOptions,
				});
			}).pipe(Effect.provide(layer));
		},
	);
});
