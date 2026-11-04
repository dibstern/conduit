import { Clock, Data, Duration, Effect, Stream } from "effect";
import { SqlClient } from "effect/sql";
import { SessionEventBusTag } from "../domain/relay/Services/session-event-bus.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import {
	loadLedger,
	loadLedgerView,
} from "../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../persistence/events.js";
import { viewLedger } from "../provider/run-ledger/run-ledger-decider.js";
import { nativePolicies } from "../provider/run-ledger/run-ledger-policy-adapters.js";

/** A Stop tasks the ledger would reject, or one whose stop the provider refused; shown as is. */
export class StopTasksRefused extends Data.TaggedError("StopTasksRefused")<{
	readonly message: string;
}> {}

/** How long the browser waits for the provider's answers; a stop still in flight is not an error. */
const OUTCOME_WAIT = Duration.seconds(10);

/**
 * Stop tasks (CONTRACT.md 8.4, 2860-2867): one stop_task per task through the Run Ledger, never
 * touching a turn. The decision reads the ledger in the write that appends the request, so "all"
 * is the live tasks then. A rejection appends nothing; its reason mirrors decide's (2864) in words
 * a person reads. A task leaves only when a later snapshot drops it, so the reply waits for the
 * provider's answers, not for the tasks to end.
 */
export const stopTasks = (
	sessionId: string,
	tasks: "all" | readonly string[],
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* EventStoreEffectTag;
			const commit = yield* makeCommitAndSignal;
			// Subscribed before the write, so no answer lands unseen between the two.
			const answers = yield* (yield* SessionEventBusTag).subscribe({
				sessionId,
			});
			const now = yield* Clock.currentTimeMillis;
			const issued = yield* commit.write((project) =>
				Effect.gen(function* () {
					const ledger = yield* loadLedger(sessionId);
					const [session] = yield* sql<{ provider: string }>`
						SELECT provider FROM sessions WHERE id = ${sessionId}`;
					if (ledger === undefined || session === undefined)
						return yield* new StopTasksRefused({
							message: "This session no longer exists",
						});
					if (!nativePolicies[ledger.provider].capabilities.backgroundTasks)
						return yield* new StopTasksRefused({
							message: "This session's provider has no background tasks",
						});
					const view = viewLedger(ledger.state).tasks;
					if (view.tag === "unknown")
						return yield* new StopTasksRefused({
							message:
								"Background tasks are still being checked; try again in a moment",
						});
					if (view.tag === "none")
						return yield* new StopTasksRefused({
							message: "No background tasks are running",
						});
					const keys =
						tasks === "all"
							? view.tasks.map((task) => task.key)
							: view.tasks
									.filter((task) => tasks.includes(task.key.taskId))
									.map((task) => task.key);
					if (keys.length === 0)
						return yield* new StopTasksRefused({
							message:
								tasks.length === 1
									? "That background task has already finished"
									: "Those background tasks have already finished",
						});
					const [before] = yield* sql<{ last: number }>`
						SELECT COALESCE(MAX(request_sequence), 0) AS last FROM provider_command_outbox`;
					yield* project(
						yield* store.appendBatch([
							canonicalEvent(
								"tasks.stop_requested",
								sessionId,
								{ tasks: tasks === "all" ? "all" : keys },
								{ provider: session.provider, createdAt: now },
							),
						]),
					);
					// The rows the arm inserted for this request, in this transaction.
					return (yield* sql<{ command_id: string }>`
						SELECT command_id FROM provider_command_outbox
						WHERE session_id = ${sessionId} AND effect_type = 'stop_task'
							AND request_sequence > ${before?.last ?? 0}`).map(
						(row) => row.command_id,
					);
				}),
			);
			if (issued.length === 0) return;
			yield* answers.pipe(
				Stream.filter(
					(event) =>
						event.type === "evidence.effect_outcome" &&
						issued.includes(event.data.commandId),
				),
				Stream.take(issued.length),
				Stream.runDrain,
				Effect.timeoutOption(OUTCOME_WAIT),
			);
			// The rows, not the bus, are the record: a dropped signal still reads its outcome here.
			const refused = yield* sql<{ task_id: string }>`
				SELECT json_extract(payload_json, '$.effect.key.taskId') AS task_id
				FROM provider_command_outbox
				WHERE command_id IN ${sql.in(issued)}
					AND status IN ('failed', 'retryable_failed', 'cancelled')`;
			if (refused.length === 0) return;
			// 8.4 (2866): a failed stop is a diagnostic; a task it no longer names has ended anyway.
			const live = (yield* loadLedgerView(sessionId))?.tasks;
			const still = refused.filter(
				(row) =>
					live?.tag === "live" &&
					live.tasks.some((task) => task.key.taskId === row.task_id),
			);
			if (still.length > 0)
				return yield* new StopTasksRefused({
					message:
						still.length === 1
							? "Could not stop 1 background task; it is still running"
							: `Could not stop ${still.length} background tasks; they are still running`,
				});
		}),
	);
