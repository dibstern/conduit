import { Context, Effect, Layer, Queue } from "effect";
import { SqlClient } from "effect/sql";
import * as Failure from "../../../effect/failure-classification.js";
import {
	type EventRetentionTag,
	makeEventRetention,
} from "./event-retention.js";
import { PersistenceProjectTag } from "./persistence-service.js";

/** Internal commit notification; the retention service itself exposes only drain. */
export class EventRetentionSchedulerTag extends Context.Service<
	EventRetentionSchedulerTag,
	{
		readonly kick: Effect.Effect<void>;
		/** The one retention the scheduler drains for a project; readers share it. */
		readonly retention: (
			projectId: string,
		) => Effect.Effect<EventRetentionTag["Service"]>;
	}
>()("EventRetentionScheduler") {}

/**
 * One scheduler per daemon over the shared store (82tn.16). A kick drains the deleted sessions of
 * the projects `projects` names, so a removed project's history is left alone (82tn.14); one
 * project's failed drain is logged and does not hold up the others.
 */
export const makeEventRetentionSchedulerLive = (
	projects: Effect.Effect<readonly string[]>,
) =>
	Layer.effect(
		EventRetentionSchedulerTag,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const retentions = new Map<string, EventRetentionTag["Service"]>();
			const retention = (projectId: string) =>
				Effect.suspend(() => {
					const known = retentions.get(projectId);
					if (known) return Effect.succeed(known);
					return makeEventRetention.pipe(
						Effect.provideService(SqlClient.SqlClient, sql),
						Effect.provideService(PersistenceProjectTag, { projectId }),
						Effect.tap((made) =>
							Effect.sync(() => retentions.set(projectId, made)),
						),
					);
				});
			const drain = (projectId: string) =>
				Effect.flatMap(retention(projectId), (made) =>
					Effect.suspend(() => made.drain()),
				).pipe(
					Effect.flatMap((report) =>
						report.eventsFreed > 0 || report.held.length > 0
							? Effect.logInfo("Event retention drain", {
									projectId,
									...report,
								})
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
			const kicks = yield* Queue.sliding<void>(1);
			yield* Queue.take(kicks).pipe(
				Effect.andThen(projects),
				Effect.flatMap((ids) => Effect.forEach(ids, drain, { discard: true })),
				Effect.forever,
				Effect.forkScoped,
			);
			return {
				kick: Queue.offer(kicks, undefined).pipe(Effect.asVoid),
				retention,
			};
		}),
	);
