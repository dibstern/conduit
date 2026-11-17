import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ProcessHarness } from "../helpers/process-harness.js";

// Registration/discovery point reads are distinct from PortWatcher's table and
// environment reads and the shell reaper's pgid/ppid probes. .5 adds full budgets.
const runnerRead = (args: readonly string[]) =>
	args.some((arg) =>
		["pgid=,lstart=,stat=", "pid=,pgid=,lstart=,stat=", "command="].includes(
			arg,
		),
	);

it.skipIf(!["darwin", "linux"].includes(process.platform))(
	"boots over live runners and retired receipts without discovery or registration ps",
	async () => {
		const harness = ProcessHarness.create({ dist: "", logLevel: "warn" });
		harness.disableIdlePolicies();
		const metricsDir = join(harness.root, "boot-budget");
		mkdirSync(metricsDir);
		const bin = join(metricsDir, "bin");
		mkdirSync(bin);
		const psLog = join(metricsDir, "ps.jsonl");
		const daemonLog = join(metricsDir, "daemon.log");
		writeFileSync(psLog, "");
		writeFileSync(daemonLog, "");
		writeFileSync(
			join(bin, "ps"),
			`#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(psLog)}, JSON.stringify(args) + '\\n');
const child = spawnSync('/bin/ps', args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
			{ mode: 0o755 },
		);
		const report: Record<string, unknown> = {
			schemaVersion: 1,
			bead: "conduit-test-g43i.28.3",
			environment: {
				node: process.version,
				platform: process.platform,
				arch: process.arch,
			},
			budgets: { discoveryRegistrationPs: 0 },
		};
		const calls = () =>
			readFileSync(psLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as string[]);
		try {
			await harness.restart({ logFile: daemonLog, pathPrefix: bin });
			const before = await harness.connect();
			const sessions: string[] = [];
			for (let i = 0; i < 8; i++) {
				const id = await before.createSession(`Boot runner ${i}`);
				await before.send(id, `boot-budget-${i}`);
				sessions.push(id);
			}
			const live = harness.marks.filter(
				(mark) => mark.kind === "runner-started",
			);
			expect(new Set(live.map((mark) => mark.pid)).size).toBe(8);
			const registrationPs = calls();
			report["registration"] = {
				ps: registrationPs,
				runnerPs: registrationPs.filter(runnerRead),
			};
			// Every runner's shell reaper probes its pgid, proving the shim was inherited.
			expect(
				registrationPs.filter((args) => args.includes("pgid=")),
			).toHaveLength(8);
			await harness.kill();
			const db = new Database(harness.daemonStorePath());
			try {
				const insert = db.prepare(`INSERT INTO claude_runner_cursors
				(runner_id, sequence, session_id, pid, start_time, retired_at)
				VALUES (?, 0, ?, 2147483647, 'Mon Nov 17 14:03:22 2026', ?)`);
				for (let i = 0; i < 4; i++)
					insert.run(`dead0000000${i}`, sessions[i], Date.now());
			} finally {
				db.close();
			}
			report["fixture"] = {
				liveRunners: 8,
				retiredReceipts: 4,
				pids: live.map((mark) => mark.pid),
			};
			writeFileSync(psLog, "");
			writeFileSync(daemonLog, "");
			writeFileSync(
				join(metricsDir, "request.json"),
				JSON.stringify({ id: 0, action: "begin" }),
			);
			await harness.restart({
				logFile: daemonLog,
				pathPrefix: bin,
				serviceEnvironment: {
					CONDUIT_TEST_SUBPROCESS_BUDGET: metricsDir,
					CONDUIT_SLOW_RPC_MS: "100",
				},
			});
			const after = await harness.connect();
			// Recovered sessions must be usable, not merely present in the registry.
			for (const id of sessions) await after.history(id);
			const measured = harness.waitForMark(
				(mark) => mark.kind === "budget-snapshot" && mark.measurement.id === 1,
			);
			writeFileSync(
				join(metricsDir, "request.tmp"),
				JSON.stringify({ id: 1, action: "end" }),
			);
			renameSync(
				join(metricsDir, "request.tmp"),
				join(metricsDir, "request.json"),
			);
			const snapshot = await measured;
			assert.equal(snapshot.kind, "budget-snapshot");
			const measurement = snapshot.measurement;
			const ps = calls();
			const slowRpcLines = readFileSync(daemonLog, "utf8")
				.split("\n")
				.filter((line) => line.includes("slow rpc"));
			report["boot"] = {
				...measurement,
				ps,
				runnerPs: ps.filter(runnerRead),
				slowRpcLines,
			};
			assert.ok(
				measurement.loopDelayMs.samples > 0,
				"boot loop histogram must contain samples",
			);
			// Keep assertions separate so .5 can tighten all ps and loop/RPC budgets.
			expect(ps.filter(runnerRead), "boot discovery/registration ps").toEqual(
				[],
			);
			expect(registrationPs.filter(runnerRead), "registration ps").toEqual([]);
		} catch (error) {
			report["error"] = error instanceof Error ? error.message : String(error);
			throw error;
		} finally {
			try {
				await harness.dispose();
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					"test-results/daemon-boot-budget.json",
					`${JSON.stringify(report, null, 2).replaceAll(harness.root, "<fixture>")}\n`,
				);
			}
		}
	},
);
