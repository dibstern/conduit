import { Context, Effect, Layer } from "effect";
import {
	DaemonTurns,
	DaemonTurnsLive,
} from "../../src/lib/domain/daemon/Services/daemon-turns.js";
import { makeContinuation } from "../../src/lib/domain/relay/Services/continuation.js";
import { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";

/**
 * A continuation whose daemon turns live for the caller's scope. Forking
 * `runLimitPolicies` lends it to that daemon's one limit-policy consumer, the
 * way a started relay does; the sweep stays manual.
 */
export const makeTestContinuation = Effect.gen(function* () {
	const daemon = yield* Layer.build(DaemonTurnsLive);
	const continuation = yield* makeContinuation.pipe(Effect.provide(daemon));
	const { projectId } = yield* EventStoreEffectTag;
	const runLimitPolicies = Effect.gen(function* () {
		const context =
			yield* Effect.context<
				Effect.Services<ReturnType<typeof continuation.applyLimitPolicy>>
			>();
		yield* Context.get(daemon, DaemonTurns).attach(projectId, {
			sweep: Effect.void,
			applyLimitPolicy: (sessionId) =>
				continuation
					.applyLimitPolicy(sessionId)
					.pipe(Effect.provideContext(context)),
		});
		return yield* Effect.never;
	}).pipe(Effect.scoped);
	return { ...continuation, runLimitPolicies };
});
