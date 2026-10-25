import { Effect, Layer, Stream } from "effect";
import { SqlClient } from "effect/sql";
import type { StoredEvent } from "../../../contracts/stored-event.js";
import { sendPushForEventEffect } from "../../../relay/sse-wiring.js";
import { PersistenceProjectTag } from "../../persistence/Services/persistence-service.js";
import { AlertLedgerTag } from "./alert-ledger.js";
import { ProviderTurnServiceTag } from "./provider-turn-service.js";
import { ConfigTag, LoggerTag } from "./services.js";
import { SessionEventBusTag } from "./session-event-bus.js";
import { SessionInboxTag } from "./session-inbox.js";

export const GOAL_STUCK_STOP_AFTER = 10;

/** React only to live commits. Replaying history must never stop a provider. */
export const GoalStuckStopReactorLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const bus = yield* SessionEventBusTag;
		const { projectId } = yield* PersistenceProjectTag;
		const turns = yield* ProviderTurnServiceTag;
		const inbox = yield* SessionInboxTag;
		const ledger = yield* AlertLedgerTag;
		const config = yield* ConfigTag;
		const log = yield* LoggerTag;
		const events = yield* bus.subscribe();
		const trackers = new Map<
			string,
			{ condition: string; setAt: number; count: number }
		>();

		const observe = (event: StoredEvent) =>
			Effect.gen(function* () {
				if (event.projectId !== projectId) return;
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
				const commandId = `goal-stuck:${event.eventId}`;
				// The outer effect installs the fence and forks the abort. Its result
				// waits for turn end, which must not block this event subscription.
				yield* inbox.withSession(
					sessionId,
					turns.beginStop({ clientId: "goal-stuck", commandId, sessionId }),
				);
				if (config.pushManager)
					yield* sendPushForEventEffect(
						config.pushManager,
						{
							_tag: "goal_stuck",
							sessionId,
							originId: commandId,
							reason: goal.lastReason ?? "",
						},
						log,
						{ slug: config.slug, sessionId },
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
