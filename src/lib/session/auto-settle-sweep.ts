import type { SqlClient } from "@effect/sql";
import { Effect } from "effect";
import {
	type AutoSettleFacts,
	shouldSettleIdleSession,
} from "./auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "./auto-settle-reader.js";

export interface AutoSettleSweepPorts {
	readonly hasViewer: (sessionId: string) => boolean;
	readonly hasLiveBackgroundWork: (sessionId: string) => boolean;
	readonly setSettled: (sessionId: string) => Effect.Effect<boolean, unknown>;
	readonly broadcastSessionList: () => Effect.Effect<void, unknown>;
}

export const settleIdleSessions = (
	ports: AutoSettleSweepPorts,
	idleWindowMs: number,
	now: number,
): Effect.Effect<number, unknown, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const decide = (sessionId: string, facts: AutoSettleFacts) =>
			shouldSettleIdleSession(
				{
					...facts,
					hasViewer: ports.hasViewer(sessionId),
					hasLiveBackgroundWork: ports.hasLiveBackgroundWork(sessionId),
				},
				now,
				idleWindowMs,
			);
		const candidates = [...(yield* readPersistedAutoSettleFacts(now))].filter(
			([sessionId, facts]) => decide(sessionId, facts),
		);
		let settled = 0;
		for (const [sessionId] of candidates) {
			// Read again at the decision point: another command may have changed the
			// projection since discovery, or a browser/task may have arrived.
			const facts = (yield* readPersistedAutoSettleFacts(now, sessionId)).get(
				sessionId,
			);
			if (facts === undefined || !decide(sessionId, facts)) continue;
			if (yield* ports.setSettled(sessionId)) settled++;
		}
		if (settled > 0) yield* ports.broadcastSessionList();
		return settled;
	});
