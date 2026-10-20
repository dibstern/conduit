import { Context, Effect, Layer, Queue } from "effect";
import * as Failure from "../../../effect/failure-classification.js";
import { EventRetentionTag } from "./event-retention.js";
import { PersistenceProjectTag } from "./persistence-service.js";

/** Internal commit notification; the retention service itself exposes only drain. */
export class EventRetentionSchedulerTag extends Context.Service<
	EventRetentionSchedulerTag,
	{ readonly kick: Effect.Effect<void> }
>()("EventRetentionScheduler") {}

export const EventRetentionSchedulerLive = Layer.effect(
	EventRetentionSchedulerTag,
	Effect.gen(function* () {
		const retention = yield* EventRetentionTag;
		const { projectId } = yield* PersistenceProjectTag;
		const kicks = yield* Queue.sliding<void>(1);
		yield* Effect.gen(function* () {
			yield* Queue.take(kicks);
			yield* Effect.suspend(() => retention.drain()).pipe(
				Effect.flatMap((report) =>
					report.eventsFreed > 0 || report.held.length > 0
						? Effect.logInfo("Event retention drain", { projectId, ...report })
						: Effect.void,
				),
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.interrupt
						: Effect.logError("Event retention drain failed", {
								projectId,
								cause,
							}),
				),
			);
		}).pipe(Effect.forever, Effect.forkScoped);
		return { kick: Queue.offer(kicks, undefined).pipe(Effect.asVoid) };
	}),
);
