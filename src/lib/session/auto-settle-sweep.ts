import type { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	type AutoSettleFacts,
	getAutoSettleOutlook,
} from "./auto-settle-policy.js";
import { readPersistedAutoSettleFacts } from "./auto-settle-reader.js";

export interface AutoSettleSweepPorts<SettleError> {
	readonly projectDir?: string;
	readonly hasViewer: (sessionId: string) => boolean;
	readonly hasLiveBackgroundWork: (sessionId: string) => boolean;
	readonly setSettled: (
		sessionId: string,
		mergedHead?: string,
	) => Effect.Effect<boolean, SettleError>;
}

export const settleIdleSessions = <SettleError>(
	ports: AutoSettleSweepPorts<SettleError>,
	idleWindowMs: number,
	now: number,
): Effect.Effect<
	number,
	SqlError | SettleError,
	SqlClient.SqlClient | PersistenceProjectTag
> =>
	Effect.gen(function* () {
		const { projectId } = yield* PersistenceProjectTag;
		const decide = (sessionId: string, facts: AutoSettleFacts) =>
			getAutoSettleOutlook(
				{
					...facts,
					hasViewer: ports.hasViewer(sessionId),
					hasLiveBackgroundWork: ports.hasLiveBackgroundWork(sessionId),
				},
				now,
				idleWindowMs,
			).kind === "due";
		const candidates = [
			...(yield* readPersistedAutoSettleFacts(
				projectId,
				now,
				undefined,
				ports.projectDir,
			)),
		].filter(([sessionId, facts]) => decide(sessionId, facts));
		let settled = 0;
		for (const [sessionId] of candidates) {
			// Read again at the decision point: another command may have changed the
			// projection since discovery, or a browser/task may have arrived.
			const facts = (yield* readPersistedAutoSettleFacts(
				projectId,
				now,
				sessionId,
				ports.projectDir,
			)).get(sessionId);
			if (facts === undefined || !decide(sessionId, facts)) continue;
			if (yield* ports.setSettled(sessionId, facts.mergedHead)) settled++;
		}
		return settled;
	});
