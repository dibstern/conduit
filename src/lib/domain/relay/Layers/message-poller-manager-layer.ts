import { Effect, FiberSet, Layer, Option, Scope } from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import type { Message } from "../../../instance/sdk-types.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { MessagePollerManager } from "../../../relay/message-poller-impl.js";
import type { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
} from "../Services/services.js";
import {
	makeSessionOpenCodeClient,
	type SessionWorkspaceTag,
} from "../Services/session-workspace.js";

export interface MessagePollerManagerLiveOptions {
	readonly hasViewers?: (sessionId: string) => boolean;
}

export const makeMessagePollerManagerLive = (
	options: MessagePollerManagerLiveOptions = {},
): Layer.Layer<
	PollerManagerTag,
	never,
	| ConfigTag
	| LoggerTag
	| OpenCodeInstancesTag
	| ReadQueryEffectTag
	| SessionWorkspaceTag
> =>
	Layer.effect(
		PollerManagerTag,
		Effect.gen(function* () {
			const config = yield* ConfigTag;
			const log = yield* LoggerTag;
			const sessionClient = yield* makeSessionOpenCodeClient;
			const readsScope = yield* Scope.fork(yield* Effect.scope);
			const run = yield* FiberSet.makeRuntimePromise<
				never,
				Message[],
				unknown
			>().pipe(Effect.provideService(Scope.Scope, readsScope));
			const pollerLog = log.child("poller-mgr");
			const manager = new MessagePollerManager({
				client: {
					session: {
						messages: (sessionId) =>
							run(
								Effect.gen(function* () {
									// Preserve the asynchronous handoff before starting native work.
									yield* Effect.yieldNow;
									const client = yield* sessionClient(sessionId);
									if (Option.isNone(client))
										return yield* Effect.fail(
											new Error(`Session ${sessionId} not found`),
										);
									return yield* Effect.tryPromise({
										try: (signal) =>
											client.value.session.messages(sessionId, { signal }),
										catch: (cause) => cause,
									});
								}).pipe(Effect.scoped),
							),
					},
				},
				log: pollerLog,
				...(options.hasViewers != null && { hasViewers: options.hasViewers }),
				...(config.messagePollerInterval != null && {
					interval: config.messagePollerInterval,
				}),
			});

			yield* Effect.addFinalizer((exit) =>
				Effect.gen(function* () {
					// Stop timers, interrupt scoped reads, then wait for their callbacks to settle.
					const draining = manager.drain();
					yield* Scope.close(readsScope, exit);
					yield* Effect.tryPromise({
						try: () => draining,
						catch: (cause) => cause,
					});
				}).pipe(
					Effect.catch((cause) =>
						Effect.sync(() =>
							pollerLog.warn(
								`Failed to drain message pollers during shutdown: ${formatErrorDetail(cause)}`,
							),
						),
					),
					Effect.catchCause((cause) =>
						Effect.sync(() =>
							pollerLog.warn(
								`Defect while draining message pollers during shutdown: ${Failure.renderCause(cause)}`,
							),
						),
					),
				),
			);

			return manager;
		}),
	);
