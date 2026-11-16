import { Clock, Data, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { SessionInboxTag } from "../domain/project-services/Services/session-inbox.js";
import { makeCommitAndSignal } from "../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../persistence/effect/event-store-effect.js";
import { loadLedger } from "../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../persistence/events.js";
import {
	stopTaskKeys,
	viewLedger,
} from "../provider/run-ledger/run-ledger-decider.js";
import { nativePolicies } from "../provider/run-ledger/run-ledger-policy-adapters.js";

/** A Stop tasks the ledger would reject; shown as is. */
export class StopTasksRefused extends Data.TaggedError("StopTasksRefused")<{
	readonly message: string;
}> {}

/**
 * Stop tasks (CONTRACT.md 8.4, 2860-2867): one stop_task per task through the Run Ledger, never
 * touching a turn. The decision reads the ledger in the write that appends the request, so "all"
 * is the live tasks then. A rejection appends nothing; its reason is decide's own (`stopTaskKeys`,
 * 2864) in words a person reads. The reply is the decision: a task leaves only when a later snapshot drops it, and
 * a stop that fails, however late, is a timeline notice (the arm's, 2866).
 */
export const stopTasks = (
	sessionId: string,
	tasks: "all" | readonly string[],
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const now = yield* Clock.currentTimeMillis;
		yield* commit.write((project) =>
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
				// The browser names task ids; decide's own reading says what that issues or why not.
				const view = viewLedger(ledger.state).tasks;
				const keys = stopTaskKeys(
					view,
					tasks === "all" || view.tag !== "live"
						? "all"
						: view.tasks
								.map((task) => task.key)
								.filter((key) => tasks.includes(key.taskId)),
				);
				if (typeof keys === "string")
					return yield* new StopTasksRefused({
						message: {
							unknown:
								"Background tasks are still being checked; try again in a moment",
							none: "No background tasks are running",
							not_live:
								tasks.length === 1
									? "That background task is not running"
									: "Those background tasks are not running",
						}[keys],
					});
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
			}),
		);
	});

/** A confirm the ledger would reject (8.4, D45); shown as is, and the browser asks again. */
export class ConfirmEscalationRefused extends Data.TaggedError(
	"ConfirmEscalationRefused",
)<{ readonly message: string }> {}

/**
 * The browser's confirm of a stuck Stop's ask (CONTRACT.md 8.4, 2873-2877; D45, 2886-2890). It
 * names the snapshot entry the ask showed; the check reads the ledger in the write that appends
 * the confirm, so a newer snapshot rejects it and nothing is recorded. U2 sees the gate lift and
 * ends the process.
 */
export const confirmEscalation = (sessionId: string, snapshotEntry: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const now = yield* Clock.currentTimeMillis;
		yield* commit.write((project) =>
			Effect.gen(function* () {
				const ledger = yield* loadLedger(sessionId);
				const [session] = yield* sql<{ provider: string }>`
					SELECT provider FROM sessions WHERE id = ${sessionId}`;
				if (ledger === undefined || session === undefined)
					return yield* new ConfirmEscalationRefused({
						message: "This session no longer exists",
					});
				const pending = viewLedger(ledger.state).pendingConfirm;
				if (pending === undefined)
					return yield* new ConfirmEscalationRefused({
						message: "Nothing is waiting for a confirm",
					});
				if (pending.snapshotEntry !== snapshotEntry)
					return yield* new ConfirmEscalationRefused({
						message:
							"The background tasks changed; check the list and confirm again",
					});
				yield* project(
					yield* store.appendBatch([
						canonicalEvent(
							"escalation.confirmed",
							sessionId,
							{ snapshotEntry },
							{ provider: session.provider, createdAt: now },
						),
					]),
				);
			}),
		);
	});

/** A dismiss with no send held behind a close, or one that already started. */
export class DismissEscalationRefused extends Data.TaggedError(
	"DismissEscalationRefused",
)<{ readonly message: string }> {}

/**
 * The browser's dismiss of a send held behind the old process's close. Gap: CONTRACT.md 8.4
 * (2870-2899) gives the gate no cancel; the nearest reading withdraws the send, and the ledger
 * drops the held close with it (run-ledger-arm, input.cancelled). The message returns to the
 * composer with a notice; the process and its tasks stay.
 */
export const dismissEscalation = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [held] = yield* sql<{ command_id: string }>`
			SELECT command_id FROM provider_command_outbox
			WHERE session_id = ${sessionId} AND effect_type = 'end_session'
				AND status = 'held' AND command_id LIKE 'inbox-close:%'`;
		if (!held)
			return yield* new DismissEscalationRefused({
				message: "Nothing is waiting to be sent",
			});
		const outcome = yield* (yield* SessionInboxTag).cancel({
			clientId: "rpc",
			sessionId,
			inputId: held.command_id.slice("inbox-close:".length),
			restoreTo: { session: sessionId },
			restoreText: true,
		});
		if (outcome !== "accepted")
			return yield* new DismissEscalationRefused({
				message: "That message already started",
			});
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		yield* commit.write((project) =>
			Effect.gen(function* () {
				yield* project(
					yield* store.appendBatch([
						canonicalEvent("turn.notice", sessionId, {
							text: "Not sent: this message needs a new process for the session, and closing the current one would end its background tasks. It is back in the message box.",
						}),
					]),
				);
			}),
		);
	});
