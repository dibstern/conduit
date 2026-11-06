import { Effect, Layer, Option, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { StoredEvent } from "../../../contracts/stored-event.js";
import { createLogger } from "../../../logger.js";
import { sendPushForEventEffect } from "../../../relay/sse-wiring.js";
import { DaemonTurns } from "../../daemon/Services/daemon-turns.js";
import { PushManagerTag } from "../../server/Services/push-service.js";
import { AlertLedgerTag, makeAlertLedger } from "./alert-ledger.js";
import { ProviderTurns } from "./provider-turn-service.js";
import { SessionEventBusTag } from "./session-event-bus.js";

export const GOAL_STUCK_STOP_AFTER = 10;

/** One daemon reactor for every project, on the daemon's session event bus.
 *  React only to live commits. Replaying history must never stop a provider. */
export const GoalStuckStopReactorLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const bus = yield* SessionEventBusTag;
		const turns = yield* ProviderTurns;
		const { serialised } = yield* DaemonTurns;
		const ledger = yield* makeAlertLedger;
		const pushManager = yield* (yield* PushManagerTag).getLegacyManager;
		const log = createLogger("daemon");
		const events = yield* bus.subscribe();
		const trackers = new Map<
			string,
			{ condition: string; setAt: number; count: number }
		>();

		const observe = (event: StoredEvent) =>
			Effect.gen(function* () {
				const sessionId = event.sessionId;
				const previous = trackers.get(sessionId);
				// Native goal continuations can look like user messages. Only a real
				// prompt handoff starts a fresh allowance; steers stay in this turn.
				if (event.type === "input.sent" && !event.data.steer) {
					if (previous) previous.count = 0;
					return;
				}
				if (event.type !== "session.goal_changed") return;
				const { goal, pausedReason } = event.data;
				if (goal === null) {
					trackers.delete(sessionId);
					return;
				}
				const sameGoal =
					previous?.condition === goal.condition &&
					previous.setAt === goal.setAt;
				const tracker = sameGoal
					? previous
					: { condition: goal.condition, setAt: goal.setAt, count: 0 };
				trackers.delete(sessionId);
				trackers.set(sessionId, tracker);
				// Match the projector's bound on idle session retention.
				if (trackers.size > 32) {
					const oldest = trackers.keys().next().value;
					if (oldest !== undefined) trackers.delete(oldest);
				}
				if (!sameGoal || pausedReason !== undefined) return;
				const [row] = yield* sql<{ goal_stuck: string | null }>`
					SELECT goal_stuck FROM sessions WHERE id = ${sessionId}`;
				tracker.count = row?.goal_stuck != null ? tracker.count + 1 : 0;
				if (tracker.count < GOAL_STUCK_STOP_AFTER) return;
				tracker.count = 0;
				// A provider runs only while a relay serves its project, so a removed or
				// unserved project has nothing to stop.
				const served = turns.served(event.projectId);
				if (Option.isNone(served)) return;
				const commandId = `goal-stuck:${event.eventId}`;
				// Fails when main refuses the Stop; the inner effect waits for turn
				// end, which must not block this event subscription.
				yield* serialised(sessionId)(
					served.value.beginStop({
						clientId: "goal-stuck",
						commandId,
						sessionId,
					}),
				);
				if (Option.isSome(pushManager))
					yield* sendPushForEventEffect(
						pushManager.value,
						{
							_tag: "goal_stuck",
							sessionId,
							originId: commandId,
							reason: goal.lastReason ?? "",
						},
						log,
						{ slug: event.projectId, sessionId },
					).pipe(
						Effect.provideService(AlertLedgerTag, ledger),
						Effect.catchCause((cause) =>
							Effect.logWarning("Could not notify about stuck goal", cause),
						),
						Effect.forkScoped({ uninterruptible: "inherit" }),
					);
			});

		yield* Stream.runForEach(events, (event) =>
			observe(event).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Could not stop stuck goal", cause),
				),
			),
		).pipe(Effect.forkScoped({ uninterruptible: "inherit" }));
	}),
);
