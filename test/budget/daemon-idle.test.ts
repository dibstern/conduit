import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { Effect, Fiber, Queue, Result, Schema, Stream } from "effect";
import { expect, it } from "vitest";
import { SessionInfoSchema } from "../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../src/lib/daemon/config-persistence.js";
import { sessionPickEvents } from "../../src/lib/domain/relay/Services/session-pick.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";
import type { DaemonBudgetMeasurement } from "../helpers/daemon-budget-metrics.js";
import {
	type ProcessBrowser,
	ProcessHarness,
} from "../helpers/process-harness.js";

// Final targets, deliberately red before g43i.4/.5. Do not raise them to fit
// the baseline after c329db13. No startup spawns or fixture git are counted.
const BUDGET = {
	idleMs: 30_000,
	idleSpawnsPerMinute: 6,
	loopP99Ms: 50,
	slowRpcMs: 500,
	externalCommitVisibleMs: 1_000,
	externalCommitTimeoutMs: 10_000,
	churnMs: 16_000,
	churnEveryMs: 500,
	tierIntervalMs: { Running: 15_000, Viewed: 5_000, Listed: 30_000 },
	listReadSpawns: 0,
	// PortWatcher, apart from the 6 a minute: the lsof listing listeners once per 2 s (CONTRACT 8.7,
	// 30 a minute), plus a process table, environment and cwd read only for a scan that listed a
	// socket the scan before it had not.
	portScanIntervalMs: 2_000,
	portScanReadsPerChange: 3,
} as const;

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
	(await exec("git", args, { cwd, timeout: 10_000 })).stdout.trim();

// One status command is one session git read, independent of the other
// commands used to implement a read. Keep all subprocess counts as well.
type Spawn = DaemonBudgetMeasurement["spawns"][number];

function gitCommand(spawn: Spawn) {
	if (spawn.command !== "git") return spawn.command;
	const args = spawn.args.slice();
	while (args[0]?.startsWith("-")) {
		const flag = args.shift();
		if (flag === "-C" || flag === "-c" || flag === "--git-dir") args.shift();
	}
	return `git ${args[0] ?? "unknown"}`;
}

/** Only PortWatcher runs lsof and ps through Subprocess; its listing names -iTCP. */
const isPortScan = ({ command }: Spawn) =>
	command === "lsof" || command === "ps";

function summarize(measurement: DaemonBudgetMeasurement) {
	const portScan = measurement.spawns.filter(isPortScan);
	const commands: Record<string, number> = {};
	const gitReads: Record<string, number> = {};
	for (const spawn of measurement.spawns) {
		const command = gitCommand(spawn);
		commands[command] = (commands[command] ?? 0) + 1;
		if (command === "git status")
			gitReads[spawn.cwd] = (gitReads[spawn.cwd] ?? 0) + 1;
	}
	const byCommand = Object.entries(commands).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	return {
		startedAtMs: measurement.startedAtMs,
		durationMs: Math.round(measurement.durationMs),
		spawns: measurement.spawns.length,
		spawnsPerMinute: Math.round(
			(measurement.spawns.length * 60_000) / measurement.durationMs,
		),
		otherSpawnsPerMinute: Math.round(
			((measurement.spawns.length - portScan.length) * 60_000) /
				measurement.durationMs,
		),
		portScan: {
			scans: portScan.filter(({ args }) => args.includes("-iTCP")).length,
			reads: portScan.filter(({ args }) => !args.includes("-iTCP")).length,
			ps: portScan.filter(({ command }) => command === "ps").length,
		},
		spawnsPerMinuteByCommand: Object.fromEntries(
			byCommand.map(([command, count]) => [
				command,
				Math.round((count * 60_000) / measurement.durationMs),
			]),
		),
		commands: Object.fromEntries(byCommand),
		gitReads: Object.fromEntries(
			Object.entries(gitReads).sort(([a], [b]) => a.localeCompare(b)),
		),
		loopDelayMs: measurement.loopDelayMs,
		spawnEvents: measurement.spawns,
		subprocess: measurement.subprocess,
	};
}

function latestRow(browser: ProcessBrowser, id: string) {
	return browser.frames
		.map(({ message }) => message)
		.filter((message) => message["type"] === "session_row")
		.filter(Schema.is(SessionInfoSchema))
		.filter((row) => row.id === id)
		.at(-1);
}

async function until(predicate: () => boolean, timeoutMs = 10_000) {
	const deadline = performance.now() + timeoutMs;
	while (!predicate() && performance.now() < deadline) await delay(10);
	return predicate();
}

/** An idle phase is wall-clock time by definition. */
const idleFor = (ms: number) => delay(ms);

/** Phase boundaries over the daemon's budget control files. */
function budgetProbe(metricsDir: string, logFile: string) {
	let requestId = 0;
	const request = async (action: "begin" | "end" | "snapshot") => {
		const id = ++requestId;
		writeFileSync(
			join(metricsDir, "request.tmp"),
			JSON.stringify({ id, action }),
		);
		renameSync(
			join(metricsDir, "request.tmp"),
			join(metricsDir, "request.json"),
		);
		let result: DaemonBudgetMeasurement | undefined;
		const received = await until(() => {
			if (!existsSync(join(metricsDir, "response.json"))) return false;
			try {
				const value: DaemonBudgetMeasurement = JSON.parse(
					readFileSync(join(metricsDir, "response.json"), "utf8"),
				);
				if (value.id === id) result = value;
			} catch {
				// The small snapshot may still be being written by the daemon.
			}
			return result !== undefined;
		});
		if (!received || !result) throw new Error(`Missing budget snapshot ${id}`);
		return result;
	};
	const waitForQuiescence = async () => {
		const deadline = performance.now() + 10_000;
		while (performance.now() < deadline) {
			const snapshot = await request("snapshot");
			if (
				snapshot.subprocess.active === 0 &&
				snapshot.subprocess.queued === 0 &&
				snapshot.subprocess.quietForMs >= 500
			)
				return snapshot;
		}
		throw new Error("Subprocess work did not settle between budget phases");
	};
	const measure = async (run: () => Promise<unknown>) => {
		await request("begin");
		const logOffset = readFileSync(logFile, "utf8").length;
		const runStartedAtMs = performance.timeOrigin + performance.now();
		await run();
		const runCompletedAtMs = performance.timeOrigin + performance.now();
		const result = summarize(await request("end"));
		const logs = readFileSync(logFile, "utf8").slice(logOffset);
		return {
			...result,
			runStartedAtMs,
			runCompletedAtMs,
			slowRpcCount: (logs.match(/slow rpc/g) ?? []).length,
		};
	};
	return { measure, waitForQuiescence };
}

it("keeps daemon git and loop delay within idle, read and churn budgets", async () => {
	const harness = ProcessHarness.create({ logLevel: "warn" });
	harness.disableIdlePolicies();
	const report: Record<string, unknown> = {
		schemaVersion: 1,
		bead: "conduit-test-g43i.1",
		budgets: BUDGET,
		environment: {
			node: process.version,
			platform: process.platform,
			arch: process.arch,
		},
		instrumentation:
			"conduit:subprocess-metrics diagnostics; git status counts one read",
	};
	const failures: string[] = [];
	const check = (condition: boolean, description: string) => {
		if (!condition) failures.push(description);
	};
	const metricsDir = join(harness.root, "budget");
	mkdirSync(metricsDir);
	const logFile = join(metricsDir, "daemon.log");
	const { measure, waitForQuiescence } = budgetProbe(metricsDir, logFile);
	// PortWatcher lists the machine's real listeners, which other processes open and close. An lsof
	// shim keeps each listing, so a phase's process reads are judged against what it listed.
	const scanDir = join(harness.root, "port-scans");
	mkdirSync(join(scanDir, "bin"), { recursive: true });
	const lsof = (process.env["PATH"] ?? "")
		.split(":")
		.map((dir) => join(dir, "lsof"))
		.find(existsSync);
	if (lsof)
		writeFileSync(
			join(scanDir, "bin", "lsof"),
			`#!/bin/sh\ncase "$*" in *-iTCP*) ;; *) exec '${lsof}' "$@" ;; esac\nscan=$(mktemp '${scanDir}/scan.XXXXXX') || exit 1\n'${lsof}' "$@" >"$scan.out"; rc=$?\ncat "$scan.out"; mv "$scan.out" "$scan.$rc"; rm -f "$scan"; exit $rc\n`,
			{ mode: 0o755 },
		);
	/** Listings that named a socket (pid, kernel address, name) the listing before had not. */
	const changedScans = (fromMs: number, toMs: number) => {
		const scans = readdirSync(scanDir)
			.filter((name) => /^scan\.\w+\.\d+$/.test(name))
			.map((name) => ({
				atMs: statSync(join(scanDir, name)).birthtimeMs,
				text: readFileSync(join(scanDir, name), "utf8"),
				ok: name.endsWith(".0"),
			}))
			.filter(({ ok, text }) => ok || text === "")
			.sort((a, b) => a.atMs - b.atMs);
		let before: ReadonlySet<string> = new Set();
		let changed = 0;
		for (const { atMs, text } of scans) {
			const sockets = new Set<string>();
			let pid = "";
			let device = "";
			for (const line of text.split("\n")) {
				if (line[0] === "p") pid = line.slice(1);
				else if (line[0] === "f") device = "";
				else if (line[0] === "d") device = line.slice(1);
				else if (line[0] === "n")
					sockets.add(`${pid} ${device} ${line.slice(1)}`);
			}
			if (
				atMs >= fromMs &&
				atMs <= toMs &&
				[...sockets].some((socket) => !before.has(socket))
			)
				changed++;
			before = sockets;
		}
		return changed;
	};
	const portScanCheck = (
		phase: string,
		measurement: Awaited<ReturnType<typeof measure>>,
	) => {
		const { scans, reads } = measurement.portScan;
		// A scan just before the phase may read inside it.
		const changed = changedScans(
			measurement.startedAtMs - BUDGET.portScanIntervalMs,
			measurement.startedAtMs + measurement.durationMs,
		);
		const maxScans =
			1 + Math.floor(measurement.durationMs / BUDGET.portScanIntervalMs);
		check(scans <= maxScans, `${phase}: ${scans} port scans > ${maxScans}`);
		check(
			reads <= BUDGET.portScanReadsPerChange * changed,
			`${phase}: ${reads} port scan process reads for ${changed} scans that listed a new socket`,
		);
		return { ...measurement.portScan, maxScans, changedScans: changed };
	};

	try {
		report["revision"] = await git(resolve("."), "rev-parse", "HEAD");
		const coldProject = join(harness.root, "cold-project");
		mkdirSync(coldProject);
		for (const directory of [harness.projectDir, coldProject]) {
			await git(directory, "init", "-b", "main");
			await git(directory, "config", "user.name", "Budget fixture");
			await git(directory, "config", "user.email", "budget@example.test");
			await git(directory, "config", "core.hooksPath", "/dev/null");
			writeFileSync(join(directory, "tracked.txt"), "initial\n");
			await git(directory, "add", "tracked.txt");
			await git(directory, "commit", "-m", "Initial fixture");
		}
		const config = Result.getOrThrow(loadDaemonConfigResult(harness.configDir));
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			JSON.stringify({
				...config,
				projects: [
					{
						path: harness.projectDir,
						folders: [harness.projectDir],
						slug: "process-test",
						addedAt: 1,
					},
					{
						path: coldProject,
						folders: [coldProject],
						slug: "cold-project",
						addedAt: 2,
					},
				],
			}),
		);
		const sessions: {
			id: string;
			path: string;
			folder: string;
			projectId: string;
		}[] = [];
		for (let index = 0; index < 30; index++) {
			const projectId = index < 27 ? "process-test" : "cold-project";
			const folder = index < 27 ? harness.projectDir : coldProject;
			const id = `budget-${String(index).padStart(2, "0")}`;
			const path = join(harness.root, id);
			await git(folder, "worktree", "add", "-b", id, path);
			// Keep the fixtures unmerged so automatic worktree settlement cannot
			// remove them while the performance phases are running.
			await git(path, "commit", "--allow-empty", "-m", `Work for ${id}`);
			await git(path, "branch", "--set-upstream-to=main");
			sessions.push({ id, path, folder, projectId });
		}
		for (const projectId of ["process-test", "cold-project"]) {
			await Effect.runPromise(
				Effect.gen(function* () {
					const commit = yield* makeCommitAndSignal;
					for (const session of sessions.filter(
						(s) => s.projectId === projectId,
					)) {
						yield* commit(
							[
								canonicalEvent("session.created", session.id, {
									sessionId: session.id,
									title: session.id,
									provider: "claude",
								}),
								...sessionPickEvents(session.id, {
									harness: "claude",
									model: { providerId: "claude", modelId: "sonnet" },
									effort: "",
									contextWindow: "200k",
								}),
								canonicalEvent("session.workspace_changed", session.id, {
									sessionId: session.id,
									path: session.path,
									cause: "launch",
									origin: "conduit",
									worktrees: { [session.folder]: session.path },
									ownership: [
										{
											folder: session.folder,
											path: session.path,
											branchName: session.id,
											head: "main",
										},
									],
								}),
							],
							{ publish: false },
						);
					}
				}).pipe(
					Effect.provide(
						makePersistenceEffectLayer(harness.daemonStorePath(), projectId),
					),
				),
			);
		}
		const missing = sessions[26];
		const changed = sessions[20];
		if (!missing || !changed) throw new Error("Missing fixture sessions");
		rmSync(missing.path, { recursive: true });
		report["fixture"] = {
			sessions: sessions.length,
			coldSessions: 3,
			missingSession: missing.id,
		};
		writeFileSync(
			join(metricsDir, "request.json"),
			JSON.stringify({ id: 0, action: "begin" }),
		);
		// The daemon inherits this process's PATH at start.
		const testPath = process.env["PATH"] ?? "";
		if (lsof) process.env["PATH"] = `${join(scanDir, "bin")}:${testPath}`;
		try {
			await harness.restart({
				skipBrowserProbe: true,
				logFile,
				serviceEnvironment: {
					CONDUIT_TEST_SUBPROCESS_BUDGET: metricsDir,
					CONDUIT_SLOW_RPC_MS: String(BUDGET.slowRpcMs),
				},
			});
		} finally {
			process.env["PATH"] = testPath;
		}
		const startupAt = performance.now();
		const startupDb = new Database(join(harness.configDir, "events.db"), {
			readonly: true,
			fileMustExist: true,
		});
		try {
			const publications = startupDb.prepare<[], { count: number }>(
				"SELECT COUNT(*) AS count FROM session_git_published",
			);
			expect(
				await until(() => publications.get()?.count === sessions.length + 2),
				"all session workspaces and project folders must publish before idle measurement",
			).toBe(true);
			const settled = await waitForQuiescence();
			report["startup"] = {
				durationMs: Math.round(performance.now() - startupAt),
				publications: publications.get()?.count,
				subprocess: settled.subprocess,
			};
		} finally {
			startupDb.close();
		}
		// Measure before connecting: SubscribeShell grants project Interests even
		// when the browser has never opened any of that project's sessions.
		const noInterests = await measure(() => idleFor(BUDGET.idleMs));
		const coldFolders = [
			coldProject,
			...sessions
				.filter(({ projectId }) => projectId === "cold-project")
				.map(({ path }) => path),
		];
		const coldReads = coldFolders.reduce(
			(reads, folder) => reads + (noInterests.gitReads[folder] ?? 0),
			0,
		);
		report["noInterests"] = {
			...noInterests,
			coldFolders,
			coldReads,
			portScan: portScanCheck("no Interests", noInterests),
		};
		check(coldReads === 0, `no Interests: ${coldReads} cold-project git reads`);
		const browser = await harness.connect(
			undefined,
			undefined,
			"process-test",
			false,
		);
		check(
			sessions.every(({ id }) => latestRow(browser, id) !== undefined),
			"all 30 sessions must reach the browser snapshot",
		);
		const idle = await measure(() => idleFor(BUDGET.idleMs));
		report["idle"] = { ...idle, portScan: portScanCheck("idle", idle) };
		const idlePortScan = idle.portScan.scans + idle.portScan.reads;
		check(
			((idle.spawns - idlePortScan) * 60_000) / idle.durationMs <=
				BUDGET.idleSpawnsPerMinute,
			`idle: ${idle.otherSpawnsPerMinute} spawns/min besides PortWatcher > ${BUDGET.idleSpawnsPerMinute}`,
		);
		check(
			idle.loopDelayMs.p99 < BUDGET.loopP99Ms,
			`idle: loop p99 ${idle.loopDelayMs.p99}ms >= ${BUDGET.loopP99Ms}ms`,
		);
		check(
			idle.loopDelayMs.samples > 0,
			"idle: loop sampler produced no samples",
		);

		// The shell subscription stays open. No list/read RPC forces this update.
		let visibleMs: number | null = null;
		let commitMs = 0;
		let expectedHead: string | undefined;
		const externalCommit = await measure(async () => {
			const before = performance.now();
			await git(
				changed.path,
				"commit",
				"--allow-empty",
				"-m",
				"External commit",
			);
			commitMs = performance.now() - before;
			const head = await git(changed.path, "rev-parse", "--short", "HEAD");
			expectedHead = head;
			if (
				await until(
					() => latestRow(browser, changed.id)?.git?.head === head,
					BUDGET.externalCommitTimeoutMs,
				)
			)
				visibleMs = performance.now() - before - commitMs;
		});
		const publicationDb = new Database(join(harness.configDir, "events.db"), {
			readonly: true,
			fileMustExist: true,
		});
		let publicationEvidence: unknown;
		try {
			publicationEvidence = {
				git: publicationDb
					.prepare(
						"SELECT directory, json_extract(git, '$.head') AS head, version FROM session_git_published WHERE directory LIKE ?",
					)
					.all(`%/${changed.id}`),
				session: publicationDb
					.prepare("SELECT id, version FROM sessions WHERE id = ?")
					.get(changed.id),
				sidebar: publicationDb
					.prepare(
						"SELECT session_id, version, json_extract(row, '$.version') AS rowVersion FROM session_sidebar WHERE session_id = ?",
					)
					.get(changed.id),
			};
		} finally {
			publicationDb.close();
		}
		report["externalCommit"] = {
			...externalCommit,
			portScan: portScanCheck("external commit", externalCommit),
			commitMs: Math.round(commitMs),
			visibleMs: visibleMs === null ? null : Math.round(visibleMs),
			expectedHead,
			observedHead: latestRow(browser, changed.id)?.git?.head,
			rowUpdates: browser.frames.filter(
				({ message }) =>
					message["type"] === "session_row" && message["id"] === changed.id,
			).length,
			publication: publicationEvidence,
		};
		check(
			visibleMs !== null && visibleMs <= BUDGET.externalCommitVisibleMs,
			`external commit: ${visibleMs ?? "not observed"}ms > ${BUDGET.externalCommitVisibleMs}ms`,
		);
		// Drain the commit's shared-ref refreshes before establishing churn tiers.
		report["beforeChurn"] = await measure(waitForQuiescence);

		// Real provider activity establishes Running, an open session establishes
		// Viewed, and the other eight worktrees are Listed in the sidebar.
		const running = sessions[0];
		const viewed = sessions[1];
		if (!running || !viewed) throw new Error("Missing churn sessions");
		await Effect.runPromise(
			browser.rpc["input.submit"]({
				sessionId: running.id,
				originId: browser.originId,
				inputId: randomUUID(),
				delivery: "queue",
				text: 'workspace-hint-tools {"writes":[],"holdBeforeResult":true}',
			}),
		);
		expect(
			await until(() => latestRow(browser, running.id)?.status === "busy"),
		).toBe(true);
		await browser.view(viewed.id);
		const churnSessions = sessions.slice(0, 10);
		const rounds: Record<string, number> = {};
		const churn = await measure(async () => {
			const deadline = performance.now() + BUDGET.churnMs;
			while (performance.now() < deadline) {
				await Promise.all(
					churnSessions.map(async ({ id, path }) => {
						writeFileSync(join(path, "tracked.txt"), `${rounds[id] ?? 0}\n`);
						await git(path, "status", "--porcelain");
						await git(path, "add", "tracked.txt");
						rounds[id] = (rounds[id] ?? 0) + 1;
					}),
				);
				await delay(BUDGET.churnEveryMs);
			}
		});
		const worktrees = churnSessions.map(({ id, path }) => {
			const tier =
				id === running.id ? "Running" : id === viewed.id ? "Viewed" : "Listed";
			const intervalMs = BUDGET.tierIntervalMs[tier];
			const maxReads = 1 + Math.floor(churn.durationMs / intervalMs);
			const reads = churn.gitReads[path] ?? 0;
			check(
				reads <= maxReads,
				`churn ${id} (${tier}): ${reads} reads > ${maxReads}`,
			);
			check(
				(rounds[id] ?? 0) >= 5,
				`churn ${id}: fewer than five status/add rounds`,
			);
			return { id, tier, intervalMs, reads, maxReads, rounds: rounds[id] ?? 0 };
		});
		report["churn"] = {
			...churn,
			worktrees,
			portScan: portScanCheck("churn", churn),
		};
		check(
			churn.loopDelayMs.p99 < BUDGET.loopP99Ms,
			`churn: loop p99 ${churn.loopDelayMs.p99}ms >= ${BUDGET.loopP99Ms}ms`,
		);
		check(
			churn.loopDelayMs.samples > 0,
			"churn: loop sampler produced no samples",
		);

		const listReads = [];
		for (const kind of [
			"projects",
			"warm-sessions",
			"cold-sessions",
			"missing-worktree",
		] as const) {
			const measurement = await measure(async () => {
				if (kind === "projects") {
					const result = await Effect.runPromise(browser.rpc.GetProjects({}));
					expect(result.projects.map(({ slug }) => slug).sort()).toEqual([
						"cold-project",
						"process-test",
					]);
				} else {
					const result = await Effect.runPromise(
						browser.rpc.ListDaemonSessions({
							scope: kind === "cold-sessions" ? "cold-project" : "process-test",
							...(kind === "missing-worktree" ? { search: missing.id } : {}),
						}),
					);
					expect(result.sessions).toHaveLength(
						kind === "cold-sessions" ? 3 : kind === "missing-worktree" ? 1 : 27,
					);
					if (kind === "missing-worktree")
						expect(result.sessions[0]?.workspaceMissing).toBeDefined();
				}
			});
			// The control-file end acknowledgment can arrive after a deferred
			// refresh starts. Keep that phase evidence and count the RPC itself.
			// PortWatcher's 2 s scan may land inside the RPC; it is counted, not caused, by the read.
			const duringRead = measurement.spawnEvents.filter(({ atMs }) => {
				const at = measurement.startedAtMs + atMs;
				return (
					at >= measurement.runStartedAtMs && at <= measurement.runCompletedAtMs
				);
			});
			const readSpawns = duringRead.filter(
				(spawn) => !isPortScan(spawn),
			).length;
			listReads.push({
				kind,
				...measurement,
				readSpawns,
				portScanReadSpawns: duringRead.length - readSpawns,
				outsideReadSpawns: measurement.spawns - duringRead.length,
			});
			check(
				readSpawns === BUDGET.listReadSpawns,
				`${kind}: ${readSpawns} spawns during read`,
			);
		}
		report["listReads"] = listReads;
	} catch (error) {
		report["error"] = error instanceof Error ? error.message : String(error);
		report["daemonLogTail"] = harness.logTail;
		report["runnerMarks"] = harness.marks;
		throw error;
	} finally {
		report["failures"] = failures;
		mkdirSync("test-results", { recursive: true });
		if (existsSync(logFile))
			writeFileSync("test-results/daemon-budget.log", readFileSync(logFile));
		try {
			await harness.dispose();
			report["cleanup"] = {
				remainingRunnerPids: harness.remainingRunnerPids(),
			};
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/daemon-budget.json",
				`${JSON.stringify(report, null, 2).replaceAll(harness.root, "<fixture>")}\n`,
			);
		}
	}
	expect(failures, "See test-results/daemon-budget.json").toEqual([]);
});

// A session diff spends git only while a viewer asks. Targets are set before
// the first measurement: if list p99 misses, live scopes use plain git diff.
const DIFF_BUDGET = {
	noViewerMs: 10_000,
	lists: 21,
	listP99Ms: 1_000,
	listSpawns: 6,
	fileSpawns: 1,
} as const;

const percentile = (samples: readonly number[], fraction: number) => {
	const sorted = [...samples].sort((a, b) => a - b);
	return Math.round(
		sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0,
	);
};

it("snapshots folders only for an open session diff and lists the conduit repository within budget", async () => {
	const harness = ProcessHarness.create({ logLevel: "warn" });
	harness.disableIdlePolicies();
	const repo = realpathSync(resolve("."));
	const store = join(harness.configDir, "folder-timeline");
	const report: Record<string, unknown> = {
		schemaVersion: 1,
		bead: "conduit-test-f02e9.2",
		budgets: DIFF_BUDGET,
		instrumentation:
			"diff spawns are snapshot commands (write-tree, add) plus private-store reads",
	};
	const failures: string[] = [];
	const check = (condition: boolean, description: string) => {
		if (!condition) failures.push(description);
	};
	const metricsDir = join(harness.root, "budget");
	mkdirSync(metricsDir);
	const logFile = join(metricsDir, "daemon.log");
	const { measure, waitForQuiescence } = budgetProbe(metricsDir, logFile);
	const diffSpawns = ({ spawnEvents }: { spawnEvents: Spawn[] }) =>
		spawnEvents.filter(
			(spawn) =>
				spawn.cwd.startsWith(store) ||
				["git write-tree", "git add"].includes(gitCommand(spawn)),
		).length;
	const sessionId = "budget-diff";

	try {
		report["revision"] = await git(repo, "rev-parse", "HEAD");
		const config = Result.getOrThrow(loadDaemonConfigResult(harness.configDir));
		writeFileSync(
			join(harness.configDir, "daemon.json"),
			JSON.stringify({
				...config,
				projects: [
					{ path: repo, folders: [repo], slug: "conduit", addedAt: 1 },
				],
			}),
		);
		await Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				yield* commit(
					[
						canonicalEvent("session.created", sessionId, {
							sessionId,
							title: sessionId,
							provider: "claude",
						}),
						...sessionPickEvents(sessionId, {
							harness: "claude",
							model: { providerId: "claude", modelId: "sonnet" },
							effort: "",
							contextWindow: "200k",
						}),
					],
					{ publish: false },
				);
			}).pipe(
				Effect.provide(
					makePersistenceEffectLayer(harness.daemonStorePath(), "conduit"),
				),
			),
		);
		writeFileSync(
			join(metricsDir, "request.json"),
			JSON.stringify({ id: 0, action: "begin" }),
		);
		await harness.restart({
			skipBrowserProbe: true,
			logFile,
			serviceEnvironment: { CONDUIT_TEST_SUBPROCESS_BUDGET: metricsDir },
		});
		await waitForQuiescence();
		const browser = await harness.connect(undefined, undefined, "conduit");
		const noViewer = await measure(() => idleFor(DIFF_BUDGET.noViewerMs));
		report["noViewer"] = { ...noViewer, diffSpawns: diffSpawns(noViewer) };
		check(
			diffSpawns(noViewer) === 0,
			`no viewer: ${diffSpawns(noViewer)} diff spawns`,
		);

		const scope = { kind: "unstaged" } as const;
		const list = () =>
			Effect.runPromise(browser.rpc.SessionDiffList({ sessionId, scope }));
		const firstAt = performance.now();
		let listing = await list();
		const firstListMs = Math.round(performance.now() - firstAt);
		const listMs: number[] = [];
		const lists = await measure(async () => {
			for (let index = 0; index < DIFF_BUDGET.lists; index++) {
				const at = performance.now();
				listing = await list();
				listMs.push(performance.now() - at);
			}
		});
		const listSpawns = diffSpawns(lists) / DIFF_BUDGET.lists;
		const listP99 = percentile(listMs, 0.99);
		report["viewer"] = {
			...lists,
			firstListMs,
			listMs: { p50: percentile(listMs, 0.5), p99: listP99 },
			listSpawns,
			files: listing.folders.map((folder) =>
				"files" in folder ? folder.files.length : folder.error,
			),
		};
		check(
			listP99 <= DIFF_BUDGET.listP99Ms,
			`list p99 ${listP99}ms > ${DIFF_BUDGET.listP99Ms}ms`,
		);
		check(
			listSpawns <= DIFF_BUDGET.listSpawns,
			`list: ${listSpawns} diff spawns per call`,
		);

		// The worktree's own changes decide whether a text file is listed.
		const text = listing.folders
			.flatMap((folder) =>
				"files" in folder
					? folder.files.map((file) => ({ folder: folder.folder, file }))
					: [],
			)
			.find(({ file }) => file.tier === "auto" && !file.binary);
		if (text) {
			const fileRead = await measure(() =>
				Effect.runPromise(
					browser.rpc.SessionDiffFile({
						sessionId,
						scope,
						revision: listing.revision,
						folder: text.folder,
						path: text.file.path,
						before: text.file.before,
						after: text.file.after,
					}),
				),
			);
			report["file"] = { ...fileRead, diffSpawns: diffSpawns(fileRead) };
			check(
				diffSpawns(fileRead) <= DIFF_BUDGET.fileSpawns,
				`file: ${diffSpawns(fileRead)} diff spawns`,
			);
		} else report["file"] = "no text change in the worktree";

		// Two devices watch the scope live, then both leave.
		const second = await harness.connect(undefined, undefined, "conduit");
		let opened: string[] = [];
		const live = await measure(async () => {
			const feeds = await Promise.all(
				[browser, second].map(async (device) => {
					const revisions = await Effect.runPromise(Queue.unbounded<string>());
					return {
						revisions,
						fiber: Effect.runFork(
							Stream.runForEach(
								device.rpc.SubscribeSessionDiff({ sessionId, scope }),
								({ revision }) => Queue.offer(revisions, revision),
							),
						),
					};
				}),
			);
			opened = await Promise.all(
				feeds.map(({ revisions }) => Effect.runPromise(Queue.take(revisions))),
			);
			await Effect.runPromise(
				Fiber.interruptAll(feeds.map(({ fiber }) => fiber)),
			);
		});
		report["live"] = {
			...live,
			diffSpawns: diffSpawns(live),
			opened,
		};
		check(
			diffSpawns(live) <= DIFF_BUDGET.listSpawns,
			`live: ${diffSpawns(live)} diff spawns to open two devices`,
		);
		check(new Set(opened).size === 1, `live: devices opened at ${opened}`);

		// The session stays viewed and its git state changes, so a watcher left
		// running would snapshot again.
		const viewing = Effect.runFork(
			Stream.runDrain(browser.rpc.SubscribeSessionTodos({ sessionId })),
		);
		const probe = join(repo, `.conduit-budget-probe-${randomUUID()}`);
		const closed = await measure(async () => {
			writeFileSync(probe, "probe\n");
			await idleFor(DIFF_BUDGET.noViewerMs);
		}).finally(() => {
			rmSync(probe, { force: true });
			return Effect.runPromise(Fiber.interrupt(viewing));
		});
		report["afterViewer"] = { ...closed, diffSpawns: diffSpawns(closed) };
		check(
			diffSpawns(closed) === 0,
			`after the viewer: ${diffSpawns(closed)} diff spawns`,
		);
	} catch (error) {
		report["error"] = error instanceof Error ? error.message : String(error);
		report["daemonLogTail"] = harness.logTail;
		throw error;
	} finally {
		report["failures"] = failures;
		try {
			await harness.dispose();
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/daemon-budget-diff.json",
				`${JSON.stringify(report, null, 2).replaceAll(harness.root, "<fixture>").replaceAll(repo, "<repo>")}\n`,
			);
		}
	}
	expect(failures, "See test-results/daemon-budget-diff.json").toEqual([]);
});
