import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
// The holder on the run row is the one copy of which runs a runner owns (CONTRACT.md 6.5), and the
// serving row picks a session's runner (6.9). These names belonged to the copies 32.13 deleted.
const deleted =
	/\bowned_run_ids\b|\bownedRunIds?\b|\bGonePending\b|\bnewestRunnerFirst\b/;
// Migration history keeps 0089's column, which 0093 drops.
const history = "src/lib/persistence/effect/migrations.ts";

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory()
			? sources(file)
			: /\.(ts|svelte)$/.test(file)
				? [file]
				: [];
	});
}

describe("old run-state copies", () => {
	it("stay deleted from src", () => {
		const offenders = sources(join(root, "src")).flatMap((file) => {
			const name = relative(root, file);
			if (name === history) return [];
			return readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					deleted.test(line) ? [`${name}:${index + 1}`] : [],
				);
		});
		expect(offenders).toEqual([]);
	});
});

// Run rows change only in the ledger's store, its projection and schema history (moved here
// from the relay-retired guard when the relay went, 82tn.16).
const runTables =
	/\b(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update|delete\s+from)\s+(?:provider_runs|run_ledger_entries|run_ledger_sessions)\b/gi;
const runStateWrites = (text: string): string[] => text.match(runTables) ?? [];

describe("Run state", () => {
	it("is written only in the Run Ledger", () => {
		const writes = new Map(
			sources(join(root, "src/lib"))
				.map(
					(file) =>
						[
							relative(root, file),
							runStateWrites(readFileSync(file, "utf8")).length,
						] as const,
				)
				.filter(([, count]) => count > 0),
		);
		expect(writes).toEqual(
			new Map([
				// Schema history: the session-delete cascade trigger, one backfill and the
				// upgrade's mark on an older build's unstarted claims (0097).
				["src/lib/persistence/effect/migrations.ts", 3],
				["src/lib/persistence/effect/projectors-effect.ts", 8],
				["src/lib/persistence/effect/run-ledger-arm.ts", 4],
			]),
		);
	});

	it.each([
		"sql`UPDATE provider_runs SET status = 'done'`",
		"sql`insert or replace into run_ledger_entries (a) values (1)`",
		"sql`DELETE FROM run_ledger_sessions WHERE session_id = 1`",
	])("finds the run-state write in %s", (text) => {
		expect(runStateWrites(text)).toHaveLength(1);
	});
});
