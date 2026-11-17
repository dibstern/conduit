import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { ProcessHarness } from "../helpers/process-harness.js";

// Initial registration includes the shell reapers' own pgid probes.
const runnerRead = (args: readonly string[]) =>
	args.some((arg) =>
		["pgid=,lstart=,stat=", "pid=,pgid=,lstart=,stat=", "command="].includes(
			arg,
		),
	);

it.skipIf(!["darwin", "linux"].includes(process.platform))(
	"boots over live runners and retired receipts without ps or RPC stalls",
	async () => {
		const harness = ProcessHarness.create({
			dist: process.env["CONDUIT_TEST_DIST"] ?? "dist",
			logLevel: "warn",
		});
		harness.disableIdlePolicies();
		const metricsDir = join(harness.root, "boot-budget");
		mkdirSync(metricsDir);
		// Keep dev-server discovery outside the runner process-table budget.
		const procRoot = join(metricsDir, "port-watcher-proc");
		mkdirSync(join(procRoot, "net"), { recursive: true });
		writeFileSync(join(procRoot, "stat"), "btime 0\n");
		for (const table of ["tcp", "tcp6"])
			writeFileSync(
				join(procRoot, "net", table),
				"sl local_address rem_address st\n",
			);
		const serviceEnvironment = {
			CONDUIT_PORT_WATCH_PROC_ROOT: procRoot,
			CONDUIT_SLOW_RPC_MS: "100",
		};
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
appendFileSync(${JSON.stringify(psLog)}, JSON.stringify({ args, ppid: process.ppid }) + '\\n');
const child = spawnSync('/bin/ps', args, { stdio: 'inherit' });
process.exit(child.status ?? 1);
`,
			{ mode: 0o755 },
		);
		const report: Record<string, unknown> = {
			schemaVersion: 1,
			bead: "conduit-test-g43i.28.5",
			environment: {
				node: process.version,
				platform: process.platform,
				arch: process.arch,
			},
			budgets: { daemonPs: 0, slowRpcLines: 0, loopDelayMaxMs: 100 },
		};
		const calls = () =>
			readFileSync(psLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as { args: string[]; ppid: number });
		try {
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`
const { Effect: bootEffect } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("effect")).href)});
globalThis[Symbol.for("boot-wrap-process-table")] = table => {
  const observe = table.observe.bind(table);
  table.observe = query => observe(query).pipe(bootEffect.tap(() => bootEffect.sync(() => {
    process.send?.({ channel: "conduit-process-test", kind: "runner-command", commandId: String(query.pgid), type: "boot-stop-observed" });
  })));
  return table;
};
registerHooks({ load(url, context, nextLoad) {
  const loaded = nextLoad(url, context);
  if (/\\/process-table\\.(js|ts)$/.test(url)) return { ...loaded, source: Buffer.from(loaded.source).toString().replaceAll("makeProductionProcessTable", "bootMakeProductionProcessTable") + '\\nexport function makeProductionProcessTable(...args) { return globalThis[Symbol.for("boot-wrap-process-table")](bootMakeProductionProcessTable(...args)); }' };
  return loaded;
} });
`,
			);
			await harness.restart({
				logFile: daemonLog,
				pathPrefix: bin,
				serviceEnvironment,
			});
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
			const registrationDaemon = harness.generations.at(-1);
			assert(registrationDaemon);
			report["registration"] = {
				ps: registrationPs,
				runnerPs: registrationPs.filter(({ args }) => runnerRead(args)),
				daemonPid: registrationDaemon.pid,
				daemonPs: registrationPs.filter(
					(call) => call.ppid === registrationDaemon.pid,
				),
			};
			// Every runner's shell reaper probes its pgid, proving the shim was inherited.
			expect(
				registrationPs.filter(({ args }) => args.includes("pgid=")),
			).toHaveLength(8);
			await harness.kill();
			const db = new Database(harness.daemonStorePath());
			const stopPids = live.slice(0, 4).map((mark) => mark.pid);
			const retiredPids = stopPids.slice(0, 2);
			const candidatePids = stopPids.slice(2);
			try {
				const insert = db.prepare(`INSERT INTO claude_runner_cursors
				(runner_id, sequence, session_id, pid, start_time, retired_at)
				VALUES (?, 0, ?, 2147483647, 'Mon Nov 17 14:03:22 2026', ?)`);
				for (let i = 0; i < 4; i++)
					insert.run(`dead0000000${i}`, sessions[i], Date.now());
				const retire = db.prepare(`UPDATE claude_runner_cursors
					SET retired_at = ?, stop_state = 'Requested', stop_started_at = ?, stop_reason = 'explicit-stop'
					WHERE pid = ?`);
				for (const pid of retiredPids) retire.run(Date.now(), Date.now(), pid);
				// Recovery must commit fresh Stop intents as well as resume old ones.
				// This exercises the abandoned-candidate SQL write during boot.
				const abandon = db.prepare(`UPDATE claude_runner_cursors
					SET role = 'candidate' WHERE pid = ? AND retired_at IS NULL`);
				for (const pid of candidatePids) abandon.run(pid);
			} finally {
				db.close();
			}
			report["fixture"] = {
				liveRunners: 4,
				liveRetiredRunners: 2,
				liveAbandonedCandidates: 2,
				deadRetiredReceipts: 4,
				retiredPids,
				candidatePids,
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
					...serviceEnvironment,
					CONDUIT_TEST_SUBPROCESS_BUDGET: metricsDir,
				},
			});
			const after = await harness.connect();
			for (const pid of stopPids)
				await harness.waitForMark(
					(mark) =>
						mark.kind === "runner-command" &&
						mark.commandId === String(pid) &&
						mark.type === "boot-stop-observed",
				);
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
			const daemon = harness.generations.at(-1);
			assert(daemon);
			const daemonPs = ps.filter((call) => call.ppid === daemon.pid);
			const slowRpcLines = readFileSync(daemonLog, "utf8")
				.split("\n")
				.filter((line) => line.includes("slow rpc"));
			report["boot"] = {
				...measurement,
				ps,
				daemonPid: daemon.pid,
				daemonPs,
				slowRpcLines,
			};
			assert.ok(
				measurement.loopDelayMs.samples > 0,
				"boot loop histogram must contain samples",
			);
			expect(daemonPs, "daemon boot process-table reads").toEqual([]);
			expect(slowRpcLines, "boot slow RPCs").toEqual([]);
			expect(
				measurement.loopDelayMs.max,
				"boot maximum event-loop delay",
			).toBeLessThan(100);
			expect(
				registrationPs.filter(({ args }) => runnerRead(args)),
				"registration ps",
			).toEqual([]);
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
