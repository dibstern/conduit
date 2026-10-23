import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

// A new process must retire only its session's stale asks, using that
// project's writer even though the adapter was built at daemon startup.
it("retires a previous process's prompts when a daemon adapter starts a session runner", async () => {
	const harness = await ProcessHarness.start({ restartProof: true });
	try {
		const browser = await harness.connect();
		const sessionId = await browser.createSession(
			"Retire replaced process prompts",
		);
		const promptId = randomUUID();
		const db = new Database(harness.daemonStorePath());
		try {
			const version =
				db
					.prepare<[string], { version: number }>(
						"SELECT COALESCE(MAX(stream_version) + 1, 0) AS version FROM events WHERE session_id = ?",
					)
					.get(sessionId)?.version ?? 0;
			const input = JSON.stringify({ command: "echo stale" });
			db.transaction(() => {
				db.prepare(
					"INSERT INTO events (project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at) VALUES ('process-test', ?, ?, ?, 'permission.asked', ?, '{}', 'claude', ?)",
				).run(
					randomUUID(),
					sessionId,
					version,
					JSON.stringify({
						id: promptId,
						sessionId,
						toolName: "Bash",
						input: { command: "echo stale" },
					}),
					Date.now(),
				);
				db.prepare(
					"INSERT INTO pending_approvals (id, session_id, type, status, tool_name, input, details, version, created_at, provider_process_id, provider_request_id) VALUES (?, ?, 'permission', 'pending', 'Bash', ?, '{}', ?, ?, 'replaced-process', 'stale-request')",
				).run(promptId, sessionId, input, version, Date.now());
			})();
		} finally {
			db.close();
		}
		await browser.preWarmSession(sessionId);
		const read = new Database(harness.daemonStorePath(), { readonly: true });
		try {
			expect(
				read
					.prepare<[string], { status: string }>(
						"SELECT status FROM pending_approvals WHERE id = ?",
					)
					.get(promptId)?.status,
			).toBe("resolved");
			expect(
				read
					.prepare<[string], { count: number }>(
						"SELECT COUNT(*) AS count FROM events WHERE type = 'permission.resolved' AND json_extract(data, '$.id') = ?",
					)
					.get(promptId)?.count,
			).toBe(1);
		} finally {
			read.close();
		}
	} finally {
		await harness.dispose();
	}
}, 60_000);
