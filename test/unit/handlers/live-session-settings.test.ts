// Live picker changes must reach the provider query immediately, carrying the
// session's whole settings triple -- the provider diffs against what the query
// already has, so sending only the field that changed reads as "cleared" and
// silently resets the other two.

import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { LoggerTag } from "../../../src/lib/domain/relay/Services/services.js";
import { applyLiveSessionSettings } from "../../../src/lib/handlers/model.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
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
		makePersistenceEffectLayer(":memory:", "test-project"),
		ProviderRegistryLive([instance]),
		Layer.succeed(LoggerTag, makeMockLogger()),
	);

const seedSessionPick = (pick: {
	modelProvider: string;
	modelId: string;
	variant: string;
	contextWindow: string;
}) =>
	Effect.gen(function* () {
		yield* (yield* ProjectionRunnerEffectTag).recover();
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO sessions
			(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
			VALUES ('s1', ${pick.modelProvider === "claude" ? "claude" : "opencode"}, 'Stored session',
				${pick.modelProvider}, ${pick.modelId}, ${pick.variant}, ${pick.contextWindow}, 1, 1)`;
	});

describe("applyLiveSessionSettings", () => {
	it.effect(
		"sends the whole settings triple when only the effort level changed",
		() => {
			const applySpy: ApplyLiveSettingsEffect = vi.fn(() => Effect.void);
			const instance = makeClaudeInstance(applySpy);

			return Effect.gen(function* () {
				yield* seedSessionPick({
					modelProvider: "claude",
					modelId: "claude-opus-4-6",
					variant: "low",
					contextWindow: "1m",
				});
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET variant = 'high' WHERE id = 's1'`;

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
		"swallows provider failures so the persisted pick still stands",
		() => {
			const applyLiveSettingsEffect: ApplyLiveSettingsEffect = vi.fn(() =>
				Effect.fail(
					new ProviderInstanceFailure({
						providerId: "claude",
						operation: "applyLiveSettings",
						cause: new Error("query gone"),
					}),
				),
			);
			const instance = makeClaudeInstance(applyLiveSettingsEffect);

			return Effect.gen(function* () {
				yield* seedSessionPick({
					modelProvider: "claude",
					modelId: "claude-opus-4-6",
					variant: "high",
					contextWindow: "1m",
				});
				// Must not reject: the provider stays latched out-of-sync and the
				// next turn re-applies, which is the pre-existing behaviour.
				yield* applyLiveSessionSettings("s1");
				expect(applyLiveSettingsEffect).toHaveBeenCalledWith("s1", {
					modelId: "claude-opus-4-6",
					variant: "high",
					contextWindow: "1m",
				});
				expect(
					yield* (yield* ReadQueryEffectTag).getSession("s1"),
				).toMatchObject({
					model_provider: "claude",
					model_id: "claude-opus-4-6",
					variant: "high",
					context_window: "1m",
				});
			}).pipe(Effect.provide(layerFor(instance)));
		},
	);

	it.effect("leaves non-Claude sessions alone", () => {
		const applySpy: ApplyLiveSettingsEffect = vi.fn(() => Effect.void);
		const instance = makeClaudeInstance(applySpy);

		return Effect.gen(function* () {
			yield* seedSessionPick({
				modelProvider: "openai",
				modelId: "gpt-4",
				variant: "",
				contextWindow: "",
			});
			yield* applyLiveSessionSettings("s1");
			expect(applySpy).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layerFor(instance)));
	});
});
