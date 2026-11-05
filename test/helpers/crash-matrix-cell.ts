// The Run Ledger crash matrix's invariants (82tn.32.14; CONTRACT.md 11.3, SEND-SCOPE-5 S9.5,
// S9.6), read from one session's store once every Run has ended. Each cell writes its result to
// CELLS; scripts/run-ledger/crash-matrix.mjs folds them into the matrix artifact.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect } from "vitest";

export const CELLS = "test-results/82tn-32-14-crash-matrix/cells";

const read = (storePath: string, sessionId: string) => {
	const db = new Database(storePath, { readonly: true });
	const all = <T>(sql: string) => db.prepare(sql).all(sessionId) as T[];
	try {
		return {
			runs: all<{ id: string; status: string }>(
				"SELECT id, status FROM provider_runs WHERE session_id = ?",
			),
			// 3.9, 4.8: a steer's main run is a Run Input of the Run it steered; it ends no Run.
			steerRuns: all<{ runId: string }>(
				"SELECT json_extract(r.data, '$.runId') AS runId FROM events r JOIN events s ON s.session_id = r.session_id AND s.type = 'input.sent' AND json_extract(s.data, '$.steer') = 1 AND json_extract(s.data, '$.inputId') = json_extract(r.data, '$.inputId') WHERE r.session_id = ? AND r.type = 'run.requested'",
			).map(({ runId }) => runId),
			ends: all<{ runId: string; outcome: string }>(
				"SELECT json_extract(entry_json, '$.runId') AS runId, json_extract(entry_json, '$.outcome') AS outcome FROM run_ledger_entries WHERE session_id = ? AND json_extract(entry_json, '$.kind') = 'end'",
			),
			// S9.6: once every Run has ended, an effect still running or held has no owner left.
			unowned: all<{ commandId: string }>(
				"SELECT command_id AS commandId FROM provider_command_outbox WHERE session_id = ? AND status IN ('running', 'held')",
			),
			shown: all<{ n: number }>(
				"SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND role = 'user' AND input_id IS NOT NULL GROUP BY input_id",
			).map(({ n }) => n),
			shownIds: all<{ inputId: string }>(
				"SELECT input_id AS inputId FROM messages WHERE session_id = ? AND role = 'user' AND input_id IS NOT NULL",
			).map(({ inputId }) => inputId),
			requeued: all<{ n: number }>(
				"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'input.requeued' GROUP BY json_extract(data, '$.inputId')",
			).map(({ n }) => n),
			turns: all<{ state: string }>(
				"SELECT state FROM turns WHERE session_id = ?",
			).map(({ state }) => state),
			sessionStatus: all<{ status: string }>(
				"SELECT status FROM sessions WHERE id = ?",
			)[0]?.status,
			steering: all<{ inputId: string }>(
				"SELECT input_id AS inputId FROM pending_inputs WHERE session_id = ? AND state = 'steering'",
			),
			transmissions: [
				...all<{ n: number }>(
					"SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'run.dispatched' AND json_extract(data, '$.commandId') IS NOT NULL GROUP BY json_extract(data, '$.commandId')",
				),
				...all<{ n: number }>(
					"SELECT attempt_count AS n FROM provider_command_outbox WHERE session_id = ?",
				),
			].map(({ n }) => n),
		};
	} finally {
		db.close();
	}
};

/** A failing cell's event log, to show why. */
const events = (storePath: string, sessionId: string) => {
	const db = new Database(storePath, { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, type, coalesce(json_extract(data, '$.runId'), json_extract(data, '$.requestedRunId')) AS runId, json_extract(data, '$.inputId') AS inputId, json_extract(data, '$.reason') AS reason FROM events WHERE session_id = ? AND type NOT IN ('text.delta', 'thinking.delta') ORDER BY sequence",
			)
			.all(sessionId);
	} finally {
		db.close();
	}
};

/** Each invariant's result over the session, `delivered` naming inputs that must show once. */
export const crashMatrixInvariants = (
	storePath: string,
	sessionId: string,
	delivered: readonly string[] = [],
) => {
	const store = read(storePath, sessionId);
	return {
		runEndsOnce:
			store.runs.length > 0 &&
			store.runs.every((run) => {
				const ends = store.ends.filter(({ runId }) => runId === run.id);
				// The ledger owns the outcome, which may differ from main's row (CONTRACT 5774-5776,
				// 857-859): a Stop asked ends interrupted though main's row reads error.
				return run.status === "joined" || store.steerRuns.includes(run.id)
					? ends.length === 0
					: ends.length === 1;
			}),
		everyRunningEffectHasOneOwner: store.unowned.length === 0,
		inputAtMostOnce:
			store.shown.every((n) => n <= 1) &&
			store.requeued.every((n) => n <= 1) &&
			delivered.every(
				(id) => store.shownIds.filter((shown) => shown === id).length === 1,
			),
		noStuckBusy:
			store.turns.every(
				(state) => state !== "pending" && state !== "running",
			) &&
			store.sessionStatus !== "busy" &&
			store.steering.length === 0,
		atMostFiveTransmissions: store.transmissions.every((n) => n <= 5),
	};
};

/** Proves one matrix cell's invariants and records them for the artifact. */
export const proveCrashMatrixCell = (
	cell: string,
	storePath: string,
	sessionId: string,
	delivered: readonly string[] = [],
) => {
	const invariants = crashMatrixInvariants(storePath, sessionId, delivered);
	const held = Object.values(invariants).every(Boolean);
	mkdirSync(CELLS, { recursive: true });
	writeFileSync(
		join(CELLS, `${cell.replaceAll("/", "--")}.json`),
		`${JSON.stringify({ cell, invariants, ...(held ? {} : { store: read(storePath, sessionId), events: events(storePath, sessionId) }) }, null, 2)}\n`,
	);
	expect(invariants).toEqual({
		runEndsOnce: true,
		everyRunningEffectHasOneOwner: true,
		inputAtMostOnce: true,
		noStuckBusy: true,
		atMostFiveTransmissions: true,
	});
};
