import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

for (const phase of ["before-first-recovery-tick", "after-recovery-kill"])
	it(`preserves the daemon's SQLite locks ${phase}`, () => {
		const root = mkdtempSync(join(tmpdir(), "runner-stop-proof-"));
		try {
			// An unsafe reader can invalidate a live WAL mapping and SIGBUS the
			// writer. Isolate that red case from Vitest and probe the lock directly.
			const output = execFileSync(
				process.execPath,
				[
					"--import",
					"tsx",
					"--input-type=module",
					"-e",
					`
import { execFileSync } from "node:child_process";
import { existsSync, writeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readRunnerStopSnapshot } from ${JSON.stringify(new URL("../../fixtures/runner-stop-proof.ts", import.meta.url).href)};
const filename = ${JSON.stringify(join(root, "events.db"))};
const writer = new DatabaseSync(filename);
writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE claude_runner_cursors (runner_id, pid, retired_at, member_snapshot, signal_log, stop_state, retirement_state)");
const members = [{ pid: 123, startTime: "started" }, { pid: 123, startTime: "started", startKey: "d:1.1" }];
const signals = ${JSON.stringify(phase)} === "after-recovery-kill" ? [{ signal: "SIGKILL", target: -123, members, outcome: "delivered" }] : [];
writer.prepare("INSERT INTO claude_runner_cursors VALUES (?, ?, ?, ?, ?, ?, ?)").run("runner", 123, 1, JSON.stringify(members), JSON.stringify(signals), "Gone", "Complete");
writer.exec("BEGIN IMMEDIATE");
const contender = () => execFileSync(process.execPath, ["--input-type=module", "-e", \`
  import { DatabaseSync } from "node:sqlite";
  const db = new DatabaseSync(\${JSON.stringify(filename)}, { timeout: 0 });
  try { db.exec("BEGIN IMMEDIATE"); process.stdout.write("acquired"); db.exec("ROLLBACK"); }
  catch (error) { if (error.errcode !== 5) throw error; process.stdout.write("locked"); }
  finally { db.close(); }
\`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const before = contender();
const snapshot = readRunnerStopSnapshot(filename, "runner", 123);
const after = contender();
writeSync(1, JSON.stringify({ before, after, snapshot, wal: existsSync(filename + "-wal"), shm: existsSync(filename + "-shm") }));
// No further SQLite access: the intentionally unsafe red case lost its mapping.
process.exit(0);
`,
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			);
			const result: unknown = JSON.parse(output);
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				`test-results/runner-stop-proof-${phase}.json`,
				JSON.stringify({ phase, result }, null, 2),
			);
			expect(result).toMatchObject({
				before: "locked",
				after: "locked",
				wal: true,
				shm: true,
				snapshot: { runner_id: "runner", pid: 123, stop_state: "Gone" },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
