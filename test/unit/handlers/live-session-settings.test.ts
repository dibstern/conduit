// Live picker changes must reach the provider query immediately, carrying the
// session's whole settings triple -- the provider diffs against what the query
// already has, so sending only the field that changed reads as "cleared" and
// silently resets the other two.
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import {
	makeOverridesStateLive,
	setContextWindow,
	setModel,
	setVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { applyLiveSessionSettings } from "../../../src/lib/handlers/model.js";
import { ProviderInstanceFailure } from "../../../src/lib/provider/errors.js";
import { ProviderRegistryLive } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { makeMockLogger } from "../../helpers/mock-factories.js";

type ApplyLiveSettingsEffect = Exclude<
	ProviderInstance["applyLiveSettingsEffect"],
	undefined
>;

function makeClaudeInstance(
	applyLiveSettingsEffect: ApplyLiveSettingsEffect,
): ProviderInstance {
	return {
		providerId: "claude",
		steering: false,
		applyLiveSettingsEffect,
		discoverEffect: () => Effect.die("not used"),
		sendTurnEffect: () => Effect.die("not used"),
		interruptTurnEffect: () => Effect.die("not used"),
		resolvePermissionEffect: () => Effect.die("not used"),
		resolveQuestionEffect: () => Effect.die("not used"),
		shutdownEffect: () => Effect.die("not used"),
		endSessionEffect: () => Effect.die("not used"),
	} satisfies ProviderInstance;
}

const layerFor = (instance: ProviderInstance) =>
	Layer.mergeAll(
		makeOverridesStateLive(),
		ProviderRegistryLive([instance]),
		Layer.succeed(LoggerTag, makeMockLogger()),
	);

describe("applyLiveSessionSettings", () => {
	it.effect(
		"sends the whole settings triple when only the effort level changed",
		() => {
			const applySpy: ApplyLiveSettingsEffect = vi.fn(() => Effect.void);
			const instance = makeClaudeInstance(applySpy);

			return Effect.gen(function* () {
				yield* setModel("s1", {
					providerID: "claude",
					modelID: "claude-opus-4-6",
				});
				yield* setContextWindow("s1", "1m");
				yield* setVariant("s1", "high");

				yield* applyLiveSessionSettings("s1");

				expect(applySpy).toHaveBeenCalledTimes(1);
				expect(applySpy).toHaveBeenCalledWith("s1", {
					modelId: "claude-opus-4-6",
					contextWindow: "1m",
					variant: "high",
				});
			}).pipe(Effect.provide(layerFor(instance)));
		},
	);

	it.effect(
		"swallows provider failures so the override write still stands",
		() => {
			const applyLiveSettingsEffect: ApplyLiveSettingsEffect = () =>
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "claude",
						operation: "applyLiveSettings",
						cause: new Error("query gone"),
					}),
				);
			const instance = makeClaudeInstance(applyLiveSettingsEffect);

			return Effect.gen(function* () {
				yield* setModel("s1", {
					providerID: "claude",
					modelID: "claude-opus-4-6",
				});
				// Must not reject: the provider stays latched out-of-sync and the
				// next turn re-applies, which is the pre-existing behaviour.
				yield* applyLiveSessionSettings("s1");
			}).pipe(Effect.provide(layerFor(instance)));
		},
	);

	it.effect("leaves non-Claude sessions alone", () => {
		const applySpy: ApplyLiveSettingsEffect = vi.fn(() => Effect.void);
		const instance = makeClaudeInstance(applySpy);

		return Effect.gen(function* () {
			yield* setModel("s1", { providerID: "openai", modelID: "gpt-4" });
			yield* applyLiveSessionSettings("s1");
			expect(applySpy).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layerFor(instance)));
	});
});
