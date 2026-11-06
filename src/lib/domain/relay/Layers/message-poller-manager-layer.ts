import { Effect, FiberSet, Layer, Option } from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { formatErrorDetail } from "../../../errors.js";
import type { Message } from "../../../instance/sdk-types.js";
import type { ReadQueryEffectTag } from "../../../persistence/effect/read-query-effect.js";
import { MessagePollerManager } from "../../../relay/message-poller-impl.js";
import type { OpenCodeInstancesTag } from "../../daemon/Services/opencode-instances-service.js";
import { SessionActivityTag } from "../../daemon/Services/session-activity.js";
import {
	ConfigTag,
	LoggerTag,
	PollerManagerTag,
} from "../Services/services.js";
import {
	makeSessionOpenCodeClient,
	type SessionWorkspaceTag,
} from "../Services/session-workspace.js";

/** A project's message poller; a session counts as viewed while any tab on the daemon shows it. */
export const MessagePollerManagerLive: Layer.Layer<
	PollerManagerTag,
	never,
	| ConfigTag
	| LoggerTag
	| OpenCodeInstancesTag
	| ReadQueryEffectTag
	| SessionActivityTag
	| SessionWorkspaceTag
> = Layer.effect(
	PollerManagerTag,
	Effect.gen(function* () {
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const { hasViewers } = yield* SessionActivityTag;
		const sessionClient = yield* makeSessionOpenCodeClient;
		const reads = yield* FiberSet.make<Message[], unknown>();
		const run = yield* FiberSet.runtimePromise(reads)<never>();
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
			hasViewers,
			...(config.messagePollerInterval != null && {
				interval: config.messagePollerInterval,
			}),
			...(config.messagePollerSseSilence != null && {
				sseSilenceMs: config.messagePollerSseSilence,
			}),
		});

		yield* Effect.addFinalizer(() =>
			Effect.gen(function* () {
				// Stop timers, interrupt scoped reads, then wait for their callbacks to settle.
				const draining = manager.drain();
				yield* FiberSet.clear(reads);
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
