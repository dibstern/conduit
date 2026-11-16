import { Context, Effect, Layer, Option } from "effect";
import {
	DaemonTurns,
	DaemonTurnsLive,
} from "../../src/lib/domain/daemon/Services/daemon-turns.js";
import { makeContinuation } from "../../src/lib/domain/project-services/Services/continuation.js";
import { makeProviderRuntimeIngestionLive } from "../../src/lib/domain/project-services/Services/provider-runtime-ingestion-service.js";
import { EventStoreEffectTag } from "../../src/lib/persistence/effect/event-store-effect.js";

/** The daemon's DaemonTurns when the test provides one; otherwise the test is its own daemon. */
export const DaemonTurnsOrOwn = Layer.unwrap(
	Effect.map(Effect.serviceOption(DaemonTurns), (shared) =>
		Option.isSome(shared)
			? Layer.succeed(DaemonTurns, shared.value)
			: DaemonTurnsLive,
	),
);

/** Provider runtime ingestion over the daemon's turns, or the test's own when it has no daemon. */
export const makeTestProviderRuntimeIngestionLive = (
	options?: Parameters<typeof makeProviderRuntimeIngestionLive>[0],
) =>
	makeProviderRuntimeIngestionLive(options).pipe(
		Layer.provide(DaemonTurnsOrOwn),
	);

export const ProviderRuntimeIngestionLive =
	makeTestProviderRuntimeIngestionLive();

/**
 * A continuation whose daemon turns live for the caller's scope. Forking
 * `runLimitPolicies` lends it to that daemon's one limit-policy consumer, the
 * way an opened project does; the sweep stays manual.
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
