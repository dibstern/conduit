import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { PersistenceProjectTag } from "../domain/persistence/Services/persistence-service.js";
import {
	AgentLivenessTag,
	OrchestrationEngineTag,
} from "../domain/relay/Services/services.js";
import { SessionInboxTag } from "../domain/relay/Services/session-inbox.js";
import * as Failure from "../effect/failure-classification.js";
import { isSessionQuiescent } from "./worktree-cleanup-rules.js";
import { readSessionQuiescence } from "./worktree-cleanup-sweep.js";

/** Stop before sweeping so this run can remove the now-unused checkouts. */
export const stopQuiescentSettledAgents = (now: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const { projectId } = yield* PersistenceProjectTag;
		const inbox = yield* SessionInboxTag;
		const engine = yield* OrchestrationEngineTag;
		const agentIsLive = yield* AgentLivenessTag;
		const eligible = (sessionId: string) =>
			Effect.gen(function* () {
				if (!(yield* agentIsLive(sessionId))) return false;
				const state = yield* readSessionQuiescence(now, sessionId);
				return state.facts?.settledAt != null && isSessionQuiescent(state);
			});
		const sessions = yield* sql<{ id: string }>`
			SELECT id FROM sessions WHERE project_id = ${projectId} AND settled_at IS NOT NULL`;
		for (const { id: sessionId } of sessions) {
			yield* Effect.gen(function* () {
				if (!(yield* eligible(sessionId))) return;
				yield* inbox.withSession(
					sessionId,
					Effect.gen(function* () {
						if (!(yield* eligible(sessionId))) return;
						// An unresponsive runner must not hold the sole cleanup worker.
						// Interrupting the wait runs the runner's process-stop finalizer.
						yield* engine
							.dispatchEffect({
								type: "end_session",
								commandId: randomUUID(),
								sessionId,
							})
							.pipe(Effect.timeout("30 seconds"));
					}),
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Failure.isInterruptedOnly(cause)
						? Effect.failCause(cause)
						: Effect.logWarning("Could not stop settled session agent", {
								sessionId,
								cause: Failure.renderCause(cause),
							}),
				),
			);
		}
	});
