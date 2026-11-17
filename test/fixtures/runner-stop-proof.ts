import { DatabaseSync } from "node:sqlite";

export function readRunnerStopSnapshot(
	filename: string,
	runnerId: string,
	pid: number,
): unknown {
	// The daemon uses node:sqlite. A second SQLite engine in this process can
	// release its POSIX locks on close and invalidate its live WAL mapping.
	const db = new DatabaseSync(filename, { readOnly: true });
	try {
		return db
			.prepare(
				"SELECT runner_id, pid, retired_at, member_snapshot, signal_log, stop_state, retirement_state FROM claude_runner_cursors WHERE runner_id = ? AND pid = ?",
			)
			.get(runnerId, pid);
	} finally {
		db.close();
	}
}
