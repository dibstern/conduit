import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Effect, Result, Schema } from "effect";
import { expect, it } from "vitest";
import { SessionInfoSchema } from "../../src/lib/contracts/ws-rpc.js";
import { loadDaemonConfigResult } from "../../src/lib/daemon/config-persistence.js";
import { sessionPickEvents } from "../../src/lib/domain/relay/Services/session-pick.js";
import { makeCommitAndSignal } from "../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../src/lib/persistence/events.js";
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
} as const;

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
	(await exec("git", args, { cwd, timeout: 10_000 })).stdout.trim();

interface Spawn {
	command: string;
	args: string[];
	cwd: string;
	atMs: number;
}
interface Measurement {
	id: number;
	durationMs: number;
	spawns: Spawn[];
	loopDelayMs: { samples: number; p50: number; p99: number; max: number };
}

// One status command is one session git read, independent of the other
// commands used to implement a read. Keep all subprocess counts as well.
function gitCommand(spawn: Spawn) {
	if (spawn.command !== "git") return spawn.command;
	const args = spawn.args.slice();
	while (args[0]?.startsWith("-")) {
		const flag = args.shift();
		if (flag === "-C" || flag === "-c" || flag === "--git-dir") args.shift();
	}
	return `git ${args[0] ?? "unknown"}`;
}

function summarize(measurement: Measurement) {
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
		durationMs: Math.round(measurement.durationMs),
		spawns: measurement.spawns.length,
		spawnsPerMinute: Math.round(
			(measurement.spawns.length * 60_000) / measurement.durationMs,
		),
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
		instrumentation: "daemon child_process preload; git status counts one read",
	};
	const failures: string[] = [];
	const check = (condition: boolean, description: string) => {
		if (!condition) failures.push(description);
	};
	const metricsDir = join(harness.root, "budget");
	mkdirSync(metricsDir);
	const logFile = join(metricsDir, "daemon.log");
	let requestId = 0;
	const request = async (action: "begin" | "end") => {
		const id = ++requestId;
		writeFileSync(
			join(metricsDir, "request.tmp"),
			JSON.stringify({ id, action }),
		);
		renameSync(
			join(metricsDir, "request.tmp"),
			join(metricsDir, "request.json"),
		);
		let result: Measurement | undefined;
		const received = await until(() => {
			if (!existsSync(join(metricsDir, "response.json"))) return false;
			try {
				const value: Measurement = JSON.parse(
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
	const measure = async (run: () => Promise<unknown>) => {
		await request("begin");
		const logOffset = readFileSync(logFile, "utf8").length;
		await run();
		const result = summarize(await request("end"));
		const logs = readFileSync(logFile, "utf8").slice(logOffset);
		return { ...result, slowRpcCount: (logs.match(/slow rpc/g) ?? []).length };
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
		const preload = pathToFileURL(
			resolve("test/helpers/daemon-budget-preload.mjs"),
		);
		preload.searchParams.set("directory", metricsDir);
		await harness.restart({
			skipBrowserProbe: true,
			logFile,
			serviceEnvironment: {
				NODE_OPTIONS: `--import=${preload.href}`,
				CONDUIT_SLOW_RPC_MS: String(BUDGET.slowRpcMs),
			},
		});
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
		await delay(2_000);
		const idle = await measure(() => delay(BUDGET.idleMs));
		report["idle"] = idle;
		check(
			(idle.spawns * 60_000) / idle.durationMs <= BUDGET.idleSpawnsPerMinute,
			`idle: ${idle.spawnsPerMinute} spawns/min > ${BUDGET.idleSpawnsPerMinute}`,
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
			if (
				await until(
					() => latestRow(browser, changed.id)?.git?.head === head,
					BUDGET.externalCommitTimeoutMs,
				)
			)
				visibleMs = performance.now() - before - commitMs;
		});
		report["externalCommit"] = {
			...externalCommit,
			commitMs: Math.round(commitMs),
			visibleMs: visibleMs === null ? null : Math.round(visibleMs),
		};
		check(
			visibleMs !== null && visibleMs <= BUDGET.externalCommitVisibleMs,
			`external commit: ${visibleMs ?? "not observed"}ms > ${BUDGET.externalCommitVisibleMs}ms`,
		);

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
		report["churn"] = { ...churn, worktrees };
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
			listReads.push({ kind, ...measurement });
			check(
				measurement.spawns === BUDGET.listReadSpawns,
				`${kind}: ${measurement.spawns} spawns during read`,
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
