/**
 * The Run Ledger's alarm scheduler (CONTRACT.md 3.7, 2.1 row 215, 12.2): a main-side fiber, outside
 * src/lib/provider, that keeps one timer on its project's earliest session-row `alarm_at` and, when
 * it is due, appends `evidence.alarm_fired` for each due session in one write that projects it, so
 * the arm folds the fire in that write. It appends nothing else. Its only state is the rows, so
 * after a restart it fires the ledger stop deadline from the session row with no U2 restore (L6).
 * A commit that changes a row's alarm wakes it (the arm's ledgerAlarmWakes).
 */
import { Clock, Effect, Layer, Queue } from "effect";
import { SqlClient } from "effect/sql";
import * as Failure from "../../../effect/failure-classification.js";
import { makeCommitAndSignal } from "../../../persistence/effect/commit-and-signal.js";
import { EventStoreEffectTag } from "../../../persistence/effect/event-store-effect.js";
import { ledgerAlarmWakes } from "../../../persistence/effect/run-ledger-arm.js";
import { canonicalEvent } from "../../../persistence/events.js";

export const RunLedgerSchedulerLive = Layer.effectDiscard(
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const store = yield* EventStoreEffectTag;
		const commit = yield* makeCommitAndSignal;
		const kicks = yield* Queue.sliding<void>(1);
		const wake = () => Queue.offerUnsafe(kicks, undefined);
		const wakes = ledgerAlarmWakes.get(sql) ?? new Set<() => void>();
		ledgerAlarmWakes.set(sql, wakes.add(wake));
		yield* Effect.addFinalizer(() => Effect.sync(() => wakes.delete(wake)));
		// 3.7: a fire the arm finds nothing due for folds no entry and leaves its row as it was. It
		// is not fired again at that alarm until its ledger folds an entry, so it never spins.
		const fired = new Map<string, string>();
		const firedKey = (row: { alarm_at: number; entry_seq: number | null }) =>
			`${row.alarm_at}:${row.entry_seq ?? 0}`;
		const alarms = (dueBy: number) =>
			sql<{
				session_id: string;
				alarm_at: number;
				entry_seq: number | null;
				provider: string;
			}>`
				SELECT l.session_id, l.alarm_at, s.provider, (SELECT MAX(entry_seq)
					FROM run_ledger_entries r WHERE r.session_id = l.session_id) AS entry_seq
				FROM run_ledger_sessions l JOIN sessions s ON s.id = l.session_id
				WHERE l.alarm_at <= ${dueBy} AND s.project_id = ${store.projectId}
				ORDER BY l.alarm_at, l.session_id`.pipe(
				Effect.map((rows) =>
					rows.filter((row) => fired.get(row.session_id) !== firedKey(row)),
				),
			);
		const kicked = Queue.take(kicks);
		const step = Effect.gen(function* () {
			const now = yield* Clock.currentTimeMillis;
			const next = (yield* alarms(Number.MAX_SAFE_INTEGER))[0]?.alarm_at;
			if (next === undefined) return yield* kicked;
			if (next > now)
				return yield* Effect.raceFirst(kicked, Effect.sleep(next - now));
			const due = yield* commit.write((project) =>
				Effect.gen(function* () {
					// Re-read in the write: a fold since the read may have moved or closed it.
					const due = yield* alarms(now);
					if (due.length === 0) return due;
					yield* project(
						yield* store.appendBatch(
							due.map((row) =>
								canonicalEvent(
									"evidence.alarm_fired",
									row.session_id,
									{ alarmAt: row.alarm_at },
									{ provider: row.provider, createdAt: now },
								),
							),
						),
					);
					return due;
				}),
			);
			for (const row of due) fired.set(row.session_id, firedKey(row));
		}).pipe(
			Effect.catchCause((cause) =>
				Failure.isInterruptedOnly(cause)
					? Effect.interrupt
					: Effect.logError("Run Ledger alarm scheduler failed", cause).pipe(
							// A failed write retries after a pause, not in a spin.
							Effect.andThen(Effect.sleep("1 second")),
						),
			),
		);
		yield* Effect.forkScoped(Effect.forever(step));
	}),
);
