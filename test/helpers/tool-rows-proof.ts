// 82tn.45 E2E proof, shared by the four providers' run-ledger files: every tool row in a daemon's
// store carries a Run id the ledger knows and the project folder. Writes
// test-results/82tn-45-<provider>.json. How it could fail: a row has no run id or one the ledger
// never admitted; a row's folder is null, the daemon's cwd or another project's; the trace makes
// no tool row, so the proof passes on nothing.
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect } from "vitest";

export function proveToolRowsOnLedger(
	provider: "claude" | "codex" | "cursor" | "opencode",
	harness: { daemonStorePath(): string; projectDir: string },
): void {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const tools = db
			.prepare(
				"SELECT m.session_id AS sessionId, p.id, p.tool_name AS tool, p.status, p.run_id AS runId, p.folder, p.started_at AS startedAt, p.ended_at AS endedAt, p.ended_by AS endedBy, p.parent_tool_id AS parentToolId FROM message_parts p JOIN messages m ON m.id = p.message_id WHERE p.type = 'tool' ORDER BY p.created_at",
			)
			.all() as { runId: string | null; folder: string | null }[];
		const runs = (
			db
				.prepare(
					"SELECT DISTINCT json_extract(entry_json, '$.runId') AS runId FROM run_ledger_entries WHERE json_extract(entry_json, '$.runId') IS NOT NULL",
				)
				.all() as { runId: string }[]
		).map(({ runId }) => runId);
		const folders = [harness.projectDir, realpathSync(harness.projectDir)];
		const dir = resolve("test-results");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			resolve(dir, `82tn-45-${provider}.json`),
			`${JSON.stringify({ provider, folders, runs, tools }, null, 2)}\n`,
		);
		expect(tools.length).toBeGreaterThan(0);
		for (const row of tools) {
			expect(runs).toContain(row.runId);
			expect(folders).toContain(row.folder);
		}
	} finally {
		db.close();
	}
}
