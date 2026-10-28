import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { RunnerMember } from "../../../src/lib/provider/runner/runner-receipts.js";
import {
	runnerMembersGone,
	runnerProcessTable,
} from "../../../src/lib/provider/runner/runner-registry.js";
import { isRecord } from "../../../src/lib/utils.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function installForcedStopFixture(harness: ProcessHarness): void {
	// Hold only the selected runner's control transport. Its sends and SDK
	// events still run, as do OS signals unless this test simulates failed kill.
	appendFileSync(
		join(harness.root, "runner-identity-fixture.mjs"),
		`
import { appendFileSync as d1Append } from "node:fs";
import { RunnerSocket as D1Socket } from ${JSON.stringify(pathToFileURL(resolve("dist/src/lib/provider/runner/runner-protocol.js")).href)};
import { runnerProcessTable as D1Processes } from ${JSON.stringify(pathToFileURL(resolve("dist/src/lib/provider/runner/runner-registry.js")).href)};
const d1Selection = join(root, "d1-selected-pid");
const d1Record = (kind, fields = {}) => d1Append(join(root, "d1-stop-proof.jsonl"), JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields }) + "\\n");
const d1Selected = pid => existsSync(d1Selection) && [JSON.parse(readFileSync(d1Selection, "utf8")).pid, JSON.parse(readFileSync(d1Selection, "utf8")).descendantPid].includes(Math.abs(pid));
const d1Write = D1Socket.prototype.write;
D1Socket.prototype.write = function(message) {
  if (message.type === "hello") d1Record("hello", { hello: message, startTime: childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim() });
  return d1Write.call(this, message);
};
if (/claude-session-runner\\.(js|ts)$/.test(process.argv[1] ?? "")) {
  setTimeout(() => process.exit(0), 120_000).unref();
  d1Record("runner-fixture-started", { startTime: childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim() });
  const reaperFailure = existsSync(join(root, "d1-reaper-failure")) ? readFileSync(join(root, "d1-reaper-failure"), "utf8") : undefined;
  const reaperSpawn = childProcess.spawn;
  childProcess.spawn = function(file, args, options) {
    const isReaper = file === "/bin/sh" && args?.includes("runner-reaper");
    if (isReaper && reaperFailure === "spawn-failure") {
      class ReaperSpawnFailure extends Error { code = "ENOENT"; }
      throw new ReaperSpawnFailure("Fixture reaper spawn failure");
    }
    const child = reaperSpawn(file, args, isReaper && reaperFailure === "wrong-group" ? { ...options, detached: true } : options);
    if (isReaper) {
      child.once("spawn", () => {
        try { d1Record("reaper-spawned", { childPid: child.pid, startTime: childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim() }); }
        catch { d1Record("reaper-exited-before-identity", { childPid: child.pid }); }
      });
      if (reaperFailure === "identity-failure") {
        const inspect = D1Processes.inspect;
        D1Processes.inspect = pid => pid === child.pid ? { state: "unknown" } : inspect(pid);
      }
    }
    return child;
  };
  syncBuiltinESMExports();
  process.on("SIGUSR1", () => {
    // Bound the child's lifetime even if the test fails before capturing its identity.
    const child = childProcess.spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => process.exit(0), 120_000); setInterval(() => {}, 1000); process.send({ ready: true });'], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, NODE_OPTIONS: "" },
    });
    child.once("message", () => {
      d1Record("child-started", { childPid: child.pid, startTime: childProcess.execFileSync("ps", ["-o", "lstart=", "-p", String(child.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim() });
      process.send?.({ channel: "conduit-process-test", kind: "runner-command", commandId: String(process.pid), type: "d1-child-ready" });
    });
  });
  const emit = process.emit;
  process.emit = function(event, ...args) {
    if (event === "SIGTERM" && d1Selected(process.pid)) {
      if (JSON.parse(readFileSync(d1Selection, "utf8")).leaderExits) {
        d1Record("leader-exit", { signal: "SIGTERM" });
        process.exit(0);
      }
      d1Record("ignored-signal", { signal: "SIGTERM" });
      return true;
    }
    return emit.call(this, event, ...args);
  };
} else {
  const write = D1Socket.prototype.write;
  let selectedSocket;
  D1Socket.prototype.write = function(message) {
    if (message.type === "command" && message.command.type === "send-turn" && existsSync(d1Selection) && message.command.input.sessionId === JSON.parse(readFileSync(d1Selection, "utf8")).sessionId) selectedSocket = this;
    if (this === selectedSocket && message.type === "command" && existsSync(d1Selection)) {
      const control = JSON.parse(readFileSync(d1Selection, "utf8"));
      if (message.command.type === "shutdown" && control.crash === "before-shutdown") {
        writeFileSync(d1Selection, JSON.stringify({ ...control, crash: undefined, consumedCrash: "before-shutdown" }));
        d1Record("crash-cut", { stage: "before-shutdown", target: control.pid });
        process.kill(process.pid, "SIGKILL");
        return;
      }
      if (message.command.type === "interrupt" || message.command.type === "end-session" || message.command.type === "shutdown") {
        d1Record("held-command", { type: message.command.type });
        return;
      }
    }
    return write.call(this, message);
  };
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (signal !== 0 && d1Selected(pid)) d1Record("signal", { childPid: pid, signal });
    const control = existsSync(d1Selection) ? JSON.parse(readFileSync(d1Selection, "utf8")) : {};
    const crash = stage => {
      if (control.crash !== stage || !d1Selected(pid)) return;
      writeFileSync(d1Selection, JSON.stringify({ ...control, crash: undefined, consumedCrash: stage }));
      d1Record("crash-cut", { stage, target: pid, signal });
      kill.call(process, process.pid, "SIGKILL");
    };
    if (signal === "SIGTERM") crash("before-term");
    if (signal === "SIGKILL" && d1Selected(pid) && control.crash === "refused-kill") {
      writeFileSync(d1Selection, JSON.stringify({ ...control, crash: undefined, consumedCrash: "refused-kill" }));
      d1Record("refused-kill", { target: pid, signal });
      setImmediate(() => kill.call(process, process.pid, "SIGKILL"));
      class RefusedSignal extends Error { code = "EPERM"; }
      throw new RefusedSignal("Fixture refused the first KILL");
    }
    if (signal === "SIGKILL" && d1Selected(pid) && control.surviveSigkill) {
      d1Record("refused-kill", { target: pid, signal });
      return true;
    }
    const delivered = kill.call(process, pid, signal);
    if (signal === "SIGTERM") crash("during-grace");
    if (signal === "SIGKILL") crash("after-kill");
    return delivered;
  };
  const spawn = childProcess.spawn;
  childProcess.spawn = function(...args) {
    const child = spawn(...args);
    if (args[1]?.some(arg => /claude-session-runner\\.(js|ts)$/.test(arg))) child.once("exit", (code, signal) => {
      d1Record("exit", { childPid: child.pid, code, signal });
      process.send?.({ channel: "conduit-process-test", kind: "runner-command", commandId: String(child.pid), type: "d1-exit-" + signal });
    });
    return child;
  };
  syncBuiltinESMExports();
}
`,
	);
}

function cursor(harness: ProcessHarness, runnerId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, attachment_id, retired_at, pid, start_time, owned_run_ids, reaper_pid, reaper_start_time, member_snapshot, signal_log, stop_state, stop_reason FROM claude_runner_cursors WHERE runner_id = ?",
			)
			.get(runnerId) as
			| {
					sequence: number;
					attachment_id: string;
					retired_at: number | null;
					pid: number | null;
					start_time: string | null;
					owned_run_ids: string;
					reaper_pid: number | null;
					reaper_start_time: string | null;
					member_snapshot: string;
					signal_log: string;
					stop_state: string | null;
					stop_reason: string | null;
			  }
			| undefined;
	} finally {
		db.close();
	}
}

function runnerRuns(harness: ProcessHarness, runnerId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				`SELECT run.id, run.runner_id, run.held_transmission, run.status, run.started_at, run.completed_at,
					command.command_id, command.status AS command_status, receipt.status AS receipt_status, turn.state AS turn_state
				FROM provider_runs run
				LEFT JOIN provider_command_outbox command ON command.run_id = run.id AND command.effect_type = 'send_turn'
				LEFT JOIN command_receipts receipt ON receipt.command_id = command.command_id
				LEFT JOIN turns turn ON turn.run_id = run.id
				WHERE run.runner_id = ? ORDER BY run.requested_at, run.id`,
			)
			.all(runnerId) as Array<{
			id: string;
			runner_id: string;
			held_transmission: number | null;
			status: string;
			started_at: number | null;
			completed_at: number | null;
			command_id: string | null;
			command_status: string | null;
			receipt_status: string | null;
			turn_state: string | null;
		}>;
	} finally {
		db.close();
	}
}

async function expectRunSettled(
	harness: ProcessHarness,
	runnerId: string,
	runId: string,
) {
	let settled: ReturnType<typeof runnerRuns>[number] | undefined;
	await vi.waitFor(
		() => {
			const runs = runnerRuns(harness, runnerId);
			settled = runs.find((run) => run.id === runId);
			assert(settled);
			expect(["error", "interrupted"]).toContain(settled.status);
			expect(settled).toMatchObject({
				completed_at: expect.any(Number),
				command_status: "failed",
				receipt_status: "side_effect_failed",
				turn_state: settled.status,
			});
			expect(
				runs.filter((run) => ["pending", "running"].includes(run.status)),
			).toEqual([]);
		},
		{ timeout: harness.remainingTimeMs(12_000) },
	);
	return settled;
}

function proof(harness: ProcessHarness): Array<Record<string, unknown>> {
	const path = join(harness.root, "d1-stop-proof.jsonl");
	return existsSync(path)
		? readFileSync(path, "utf8")
				.trim()
				.split("\n")
				.flatMap((line) => {
					const value: unknown = JSON.parse(line);
					return isRecord(value) ? [value] : [];
				})
		: [];
}

const evidenceDirectory =
	process.env["CONDUIT_RUNNER_EVIDENCE_DIR"] ??
	mkdtempSync(join(tmpdir(), "runner-reaper-evidence-"));
mkdirSync(evidenceDirectory, { recursive: true });
console.log(`Runner reaper evidence: ${evidenceDirectory}`);

function artifact(name: string): string {
	return join(evidenceDirectory, `${name}-${randomUUID()}.json`);
}

function identity(pid: number): RunnerMember {
	const observation = runnerProcessTable.inspect(pid);
	assert(observation.state === "running" && observation.startTime);
	return { pid, startTime: observation.startTime };
}

function signalOwned(member: RunnerMember, signal: NodeJS.Signals): void {
	const current = runnerProcessTable.inspect(member.pid);
	if (current.state === "running" && current.startTime === member.startTime) {
		try {
			process.kill(member.pid, signal);
		} catch (cause) {
			if (!isRecord(cause) || cause["code"] !== "ESRCH") throw cause;
		}
	}
}

async function cleanupOwned(
	harness: ProcessHarness,
	members: readonly RunnerMember[],
) {
	// Capture current members only while a saved identity still pins the original group.
	const all = [...members];
	for (const entry of proof(harness)) {
		if (
			(entry["kind"] === "runner-fixture-started" ||
				(entry["kind"] === "hello" &&
					isRecord(entry["hello"]) &&
					entry["hello"]["pid"] === entry["pid"])) &&
			typeof entry["pid"] === "number" &&
			typeof entry["startTime"] === "string"
		) {
			all.push({ pid: entry["pid"], startTime: entry["startTime"] });
			const hello = entry["hello"];
			if (
				isRecord(hello) &&
				isRecord(hello["reaper"]) &&
				typeof hello["reaper"]["pid"] === "number" &&
				typeof hello["reaper"]["startTime"] === "string"
			)
				all.push({
					pid: hello["reaper"]["pid"],
					startTime: hello["reaper"]["startTime"],
				});
		}
		if (
			["child-started", "reaper-spawned"].includes(String(entry["kind"])) &&
			typeof entry["childPid"] === "number" &&
			typeof entry["startTime"] === "string"
		)
			all.push({ pid: entry["childPid"], startTime: entry["startTime"] });
	}
	for (const pid of harness.runnerPids()) {
		const saved = all.find((member) => member.pid === pid);
		const group = runnerProcessTable.members?.(pid);
		const current = runnerProcessTable.inspect(pid);
		if (
			saved &&
			current.state === "running" &&
			current.startTime === saved.startTime &&
			current.pgid === pid
		)
			all.push(...(group ?? []));
	}
	try {
		for (const member of all) signalOwned(member, "SIGKILL");
		await vi.waitFor(
			() => expect(runnerMembersGone(runnerProcessTable, all)).toBe(true),
			{ timeout: 5000 },
		);
	} finally {
		await harness.dispose();
	}
}

async function selectedRunner(
	harness: ProcessHarness,
	leaderExits: boolean,
	extra: Record<string, unknown> = {},
	prompt = "stall-reaper-stop",
) {
	await harness.restart();
	const browser = await harness.connect();
	const sessionId = await browser.createSession("Reaper forced stop");
	await browser.send(sessionId, "reaper-before-stop");
	const runner = harness.marks.find(
		(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
	);
	assert(runner?.kind === "runner-started");
	const leader = identity(runner.pid);
	const hello = proof(harness).find(
		(mark) => mark["kind"] === "hello" && mark["pid"] === runner.pid,
	)?.["hello"];
	assert(isRecord(hello) && isRecord(hello["reaper"]));
	const reaper = hello["reaper"];
	assert(
		typeof reaper["pid"] === "number" &&
			typeof reaper["startTime"] === "string",
	);
	const reaperIdentity = { pid: reaper["pid"], startTime: reaper["startTime"] };
	expect(runnerProcessTable.inspect(reaperIdentity.pid)).toMatchObject({
		state: "running",
		startTime: reaperIdentity.startTime,
		pgid: leader.pid,
	});
	const selection = { pid: runner.pid, sessionId, leaderExits, ...extra };
	writeFileSync(
		join(harness.root, "d1-selected-pid"),
		JSON.stringify(selection),
	);
	signalOwned(leader, "SIGUSR1");
	await harness.waitForMark(
		(mark) =>
			mark.kind === "runner-command" &&
			mark.commandId === String(runner.pid) &&
			mark.type === "d1-child-ready",
	);
	const child = proof(harness).find(
		(mark) => mark["kind"] === "child-started" && mark["pid"] === runner.pid,
	);
	assert(typeof child?.["childPid"] === "number");
	const descendant = identity(child["childPid"]);
	writeFileSync(
		join(harness.root, "d1-selected-pid"),
		JSON.stringify({ ...selection, descendantPid: descendant.pid }),
	);
	const members = runnerProcessTable.members?.(runner.pid);
	assert(members);
	expect(members).toEqual(
		expect.arrayContaining([leader, reaperIdentity, descendant]),
	);
	const pending = browser.send(sessionId, prompt, 60_000);
	void pending.catch(() => undefined);
	await harness.waitForMark(
		(mark) =>
			mark.kind ===
				(prompt === "upgrade-long-turn" ? "assistant-held" : "enqueue") &&
			mark.prompt === prompt,
	);
	let acceptedRun: ReturnType<typeof runnerRuns>[number] | undefined;
	await vi.waitFor(
		() => {
			acceptedRun = runnerRuns(harness, basename(runner.socketPath)).find(
				(run) => run.status === "running",
			);
			expect(acceptedRun).toMatchObject({
				runner_id: basename(runner.socketPath),
				started_at: expect.any(Number),
				command_status: "running",
				turn_state: "running",
			});
		},
		{ timeout: harness.remainingTimeMs(10_000) },
	);
	assert(acceptedRun);
	return {
		browser,
		sessionId,
		runner,
		leader,
		reaper: reaperIdentity,
		descendant,
		members,
		pending,
		acceptedRun,
	};
}

async function expectGroupGone(
	harness: ProcessHarness,
	group: number,
	members: readonly RunnerMember[],
) {
	await vi.waitFor(
		() => {
			expect(runnerMembersGone(runnerProcessTable, members)).toBe(true);
			expect(
				(runnerProcessTable.members?.(group) ?? []).filter(
					(member) =>
						runnerProcessTable.inspect(member.pid).state === "running",
				),
			).toEqual([]);
		},
		{ timeout: harness.remainingTimeMs(20_000) },
	);
}

describe("runner forced stop with real processes", () => {
	it.each([
		"spawn-failure",
		"wrong-group",
		"identity-failure",
	])("keeps a runner usable and omits an unavailable reaper capability: %s", async (failure) => {
		const artifactPath = artifact(`capability-${failure}`);
		const evidence: Record<string, unknown> = {
			passed: false,
			failureMode: failure,
		};
		const harness = ProcessHarness.create({
			dist: "dist",
			deadline: performance.now() + 40_000,
		});
		try {
			installForcedStopFixture(harness);
			writeFileSync(join(harness.root, "d1-reaper-failure"), failure);
			await harness.restart();
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Unavailable reaper");
			const turn = await browser.send(sessionId, "reaper-fallback-turn");
			expect(turn.chunks.join("")).toBe(
				responseChunks("reaper-fallback-turn").join(""),
			);
			const runner = harness.marks.find(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			assert(runner?.kind === "runner-started");
			const hello = proof(harness).find(
				(entry) => entry["kind"] === "hello" && entry["pid"] === runner.pid,
			)?.["hello"];
			assert(isRecord(hello));
			expect(hello).not.toHaveProperty("reaper");
			evidence["hello"] = hello;
			evidence["passed"] = true;
		} catch (cause) {
			evidence["failure"] = String(cause);
			if (typeof evidence["runnerId"] === "string")
				evidence["retirementAfterFailure"] = cursor(
					harness,
					evidence["runnerId"],
				);
			throw cause;
		} finally {
			evidence["proof"] = proof(harness);
			try {
				await cleanupOwned(harness, []);
				evidence["cleanup"] = harness.proof();
			} catch (cause) {
				evidence["passed"] = false;
				evidence["cleanupFailure"] = String(cause);
				await Promise.reject(cause);
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
			}
		}
	}, 60_000);

	it.each([
		{ leaderExits: false, killReaper: false },
		{ leaderExits: true, killReaper: false },
		{ leaderExits: true, killReaper: true },
	])("clears a TERM-ignoring descendant and settles its accepted run: %j", async ({
		leaderExits,
		killReaper,
	}) => {
		const artifactPath = artifact(
			`stop-${leaderExits ? "leader-exits" : "leader-ignores"}-${killReaper ? "reaper-killed" : "reaper-alive"}`,
		);
		const evidence: Record<string, unknown> = {
			passed: false,
			leaderExits,
			killReaper,
		};
		const harness = ProcessHarness.create({
			dist: "dist",
			deadline: performance.now() + 75_000,
		});
		let members: RunnerMember[] = [];
		try {
			installForcedStopFixture(harness);
			const fixture = await selectedRunner(harness, leaderExits);
			members = [...fixture.members];
			evidence["acceptedRun"] = fixture.acceptedRun;
			evidence["before"] = {
				leader: fixture.leader,
				reaper: fixture.reaper,
				descendant: fixture.descendant,
				members,
			};
			if (killReaper) {
				signalOwned(fixture.reaper, "SIGKILL");
				await vi.waitFor(() =>
					expect(runnerMembersGone(runnerProcessTable, [fixture.reaper])).toBe(
						true,
					),
				);
			}
			await harness.requestRpc({
				_tag: "CancelSession",
				sessionId: fixture.sessionId,
				commandId: randomUUID(),
			});
			await fixture.pending;
			await expectGroupGone(harness, fixture.leader.pid, members);
			evidence["settledRun"] = await expectRunSettled(
				harness,
				basename(fixture.runner.socketPath),
				fixture.acceptedRun.id,
			);
			evidence["proof"] = proof(harness);
			evidence["retirement"] = cursor(
				harness,
				basename(fixture.runner.socketPath),
			);
			expect(proof(harness)).toContainEqual(
				expect.objectContaining({
					kind: leaderExits ? "leader-exit" : "ignored-signal",
					pid: fixture.leader.pid,
					signal: "SIGTERM",
				}),
			);
			if (!leaderExits) {
				const signals = proof(harness).filter(
					(mark) =>
						mark["kind"] === "signal" &&
						Math.abs(Number(mark["childPid"])) === fixture.leader.pid,
				);
				expect(signals.map((mark) => mark["signal"])).toEqual([
					"SIGTERM",
					"SIGKILL",
				]);
				expect(
					Number(signals[1]?.["at"]) - Number(signals[0]?.["at"]),
				).toBeGreaterThanOrEqual(2800);
				expect(proof(harness)).toContainEqual(
					expect.objectContaining({
						kind: "exit",
						childPid: fixture.leader.pid,
						code: null,
						signal: "SIGKILL",
					}),
				);
			}
			unlinkSync(join(harness.root, "d1-selected-pid"));
			const resumed = await fixture.browser.send(
				fixture.sessionId,
				"reaper-after-stop",
			);
			expect(resumed.chunks.join("")).toBe(
				responseChunks("reaper-after-stop").join(""),
			);
			const replacement = harness.marks
				.filter(
					(mark) =>
						mark.kind === "runner-started" &&
						mark.sessionId === fixture.sessionId,
				)
				.at(-1);
			assert(replacement?.kind === "runner-started");
			members.push(identity(replacement.pid));
			const originalQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === fixture.leader.pid,
			);
			const resumedQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === replacement.pid,
			);
			assert(originalQuery?.kind === "query" && resumedQuery?.kind === "query");
			expect(resumedQuery.sessionId).toBe(originalQuery.sessionId);
			evidence["replacement"] = replacement;
			evidence["nativeSessionId"] = resumedQuery.sessionId;
			evidence["passed"] = true;
		} catch (cause) {
			evidence["failure"] = String(cause);
			if (typeof evidence["runnerId"] === "string")
				evidence["retirementAfterFailure"] = cursor(
					harness,
					evidence["runnerId"],
				);
			throw cause;
		} finally {
			evidence["proof"] = proof(harness);
			try {
				await cleanupOwned(harness, members);
				evidence["cleanup"] = harness.proof();
			} catch (cause) {
				evidence["passed"] = false;
				evidence["cleanupFailure"] = String(cause);
				await Promise.reject(cause);
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
			}
		}
	}, 95_000);

	it("reaps a SIGKILLed leader independently of the paused daemon and prunes its settled record", async () => {
		const artifactPath = artifact("leader-crash-without-stop");
		const evidence: Record<string, unknown> = { passed: false };
		const harness = ProcessHarness.create({
			dist: "dist",
			deadline: performance.now() + 75_000,
		});
		let members: RunnerMember[] = [];
		let daemon: RunnerMember | undefined;
		try {
			installForcedStopFixture(harness);
			const fixture = await selectedRunner(harness, false);
			members = [...fixture.members];
			const daemonPid = harness.generations.at(-1)?.pid;
			assert(daemonPid);
			daemon = identity(daemonPid);
			signalOwned(daemon, "SIGSTOP");
			evidence["daemonPaused"] = daemon;
			evidence["before"] = {
				leader: fixture.leader,
				reaper: fixture.reaper,
				descendant: fixture.descendant,
				members,
			};
			signalOwned(fixture.leader, "SIGKILL");
			await expectGroupGone(harness, fixture.leader.pid, members);
			evidence["groupGoneWhileDaemonPaused"] = members.map((member) => ({
				...member,
				observation: runnerProcessTable.inspect(member.pid),
			}));
			signalOwned(daemon, "SIGCONT");
			daemon = undefined;
			await fixture.pending;
			await vi.waitFor(
				() =>
					expect(
						cursor(harness, basename(fixture.runner.socketPath)),
					).toBeUndefined(),
				{ timeout: harness.remainingTimeMs(12_000) },
			);
			evidence["pruned"] = true;
			evidence["passed"] = true;
		} catch (cause) {
			evidence["failure"] = String(cause);
			if (typeof evidence["runnerId"] === "string")
				evidence["retirementAfterFailure"] = cursor(
					harness,
					evidence["runnerId"],
				);
			throw cause;
		} finally {
			if (daemon) signalOwned(daemon, "SIGCONT");
			evidence["proof"] = proof(harness);
			try {
				await cleanupOwned(harness, members);
				evidence["cleanup"] = harness.proof();
			} catch (cause) {
				evidence["passed"] = false;
				evidence["cleanupFailure"] = String(cause);
				await Promise.reject(cause);
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
			}
		}
	}, 95_000);

	it.each([
		"before-shutdown",
		"before-term",
		"during-grace",
		"after-kill",
		"refused-kill",
	] as const)("recovers the durable members after a daemon crash %s", async (crash) => {
		const artifactPath = artifact(`crash-${crash}`);
		const evidence: Record<string, unknown> = { passed: false, crash };
		const harness = ProcessHarness.create({
			dist: "dist",
			restartProof: true,
			deadline: performance.now() + 100_000,
		});
		let members: RunnerMember[] = [];
		try {
			installForcedStopFixture(harness);
			const fixture = await selectedRunner(
				harness,
				false,
				{ crash },
				crash === "before-shutdown" ? "upgrade-long-turn" : undefined,
			);
			members = [...fixture.members];
			evidence["acceptedRun"] = fixture.acceptedRun;
			evidence["runnerId"] = basename(fixture.runner.socketPath);
			evidence["before"] = {
				leader: fixture.leader,
				reaper: fixture.reaper,
				descendant: fixture.descendant,
				members,
			};
			await harness
				.requestRpc({
					_tag: "CancelSession",
					sessionId: fixture.sessionId,
					commandId: randomUUID(),
				})
				.catch(() => undefined);
			await harness.waitForExit();
			await fixture.pending.catch(() => undefined);
			expect(harness.generations.at(-1)?.signal).toBe("SIGKILL");
			expect(proof(harness)).toContainEqual(
				expect.objectContaining({
					kind: crash === "refused-kill" ? "refused-kill" : "crash-cut",
				}),
			);
			const retired = cursor(harness, basename(fixture.runner.socketPath));
			assert(retired);
			expect(retired.retired_at).toEqual(expect.any(Number));
			expect(retired.pid).toBe(fixture.leader.pid);
			expect(retired.start_time).toBe(fixture.leader.startTime);
			expect(retired.reaper_pid).toBe(fixture.reaper.pid);
			expect(retired.reaper_start_time).toBe(fixture.reaper.startTime);
			expect(JSON.parse(retired.member_snapshot)).toEqual(
				expect.arrayContaining([
					fixture.leader,
					fixture.reaper,
					fixture.descendant,
				]),
			);
			expect(JSON.parse(retired.owned_run_ids)).toEqual([]);
			expect(
				runnerRuns(harness, basename(fixture.runner.socketPath)),
			).toContainEqual(
				expect.objectContaining({
					id: fixture.acceptedRun.id,
					runner_id: basename(fixture.runner.socketPath),
				}),
			);
			evidence["durableBeforeRestart"] = retired;
			evidence["observationsBeforeRestart"] = members.map((member) => ({
				...member,
				observation: runnerProcessTable.inspect(member.pid),
			}));
			if (crash !== "after-kill") {
				expect(
					runnerProcessTable.inspect(fixture.descendant.pid),
				).toMatchObject({
					state: "running",
					startTime: fixture.descendant.startTime,
				});
			}
			let lateText: string | undefined;
			if (crash === "before-shutdown") {
				expect(retired.stop_state).toBe("Requested");
				expect(retired.stop_reason).toEqual(expect.any(String));
				expect(JSON.parse(retired.signal_log)).toEqual([]);
				expect(
					proof(harness).filter((entry) => entry["kind"] === "signal"),
				).toEqual([]);
				for (const member of members)
					expect(runnerProcessTable.inspect(member.pid)).toMatchObject({
						state: "running",
						startTime: member.startTime,
					});
				writeFileSync(
					join(harness.root, "release-upgrade-turn"),
					"late output",
				);
				lateText = responseChunks("upgrade-long-turn")[2];
				assert(lateText);
				await vi.waitFor(
					() =>
						expect(
							readFileSync(`${fixture.runner.socketPath}.spool`, "utf8"),
						).toContain(lateText),
					{ timeout: harness.remainingTimeMs(10_000) },
				);
				evidence["spooledAfterStopCommit"] = lateText;
			}
			await harness.restart();
			await expectGroupGone(harness, fixture.leader.pid, members);
			evidence["settledRun"] = await expectRunSettled(
				harness,
				basename(fixture.runner.socketPath),
				fixture.acceptedRun.id,
			);
			if (lateText) {
				const browser = await harness.connect(fixture.sessionId);
				expect(
					JSON.stringify(await browser.history(fixture.sessionId)),
				).not.toContain(lateText);
				const db = new Database(harness.daemonStorePath(), { readonly: true });
				try {
					expect(
						db
							.prepare(
								"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'text.delta' AND data LIKE ?",
							)
							.get(fixture.sessionId, `%${lateText}%`),
					).toEqual({ count: 0 });
				} finally {
					db.close();
				}
				evidence["retiredOutputWasNotReplayed"] = true;
			}
			await vi.waitFor(
				() =>
					expect(
						cursor(harness, basename(fixture.runner.socketPath)),
					).toBeUndefined(),
				{ timeout: harness.remainingTimeMs(35_000) },
			);
			evidence["prunedAfterRestart"] = true;
			evidence["passed"] = true;
		} catch (cause) {
			evidence["failure"] = String(cause);
			if (typeof evidence["runnerId"] === "string")
				evidence["retirementAfterFailure"] = cursor(
					harness,
					evidence["runnerId"],
				);
			throw cause;
		} finally {
			evidence["proof"] = proof(harness);
			try {
				await cleanupOwned(harness, members);
				evidence["cleanup"] = harness.proof();
			} catch (cause) {
				evidence["passed"] = false;
				evidence["cleanupFailure"] = String(cause);
				await Promise.reject(cause);
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
			}
		}
	}, 120_000);

	it("does not adopt or replay a surviving retired runner after daemon restart", async () => {
		const artifactPath = artifact("retired-runner-no-replay");
		const evidence: Record<string, unknown> = { passed: false };
		const owned: RunnerMember[] = [];
		const harness = ProcessHarness.create({
			dist: "dist",
			restartProof: true,
			deadline: performance.now() + 100_000,
		});
		try {
			installForcedStopFixture(harness);
			await harness.restart();
			let browser = await harness.connect();
			const sessionId = await browser.createSession("Retired runner restart");
			await browser.send(sessionId, "r1-before-retirement");
			const first = harness.marks.find(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			assert(first?.kind === "runner-started");
			owned.push(identity(first.pid));
			const runnerId = basename(first.socketPath);
			const originalQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === first.pid,
			);
			assert(originalQuery?.kind === "query");
			evidence["firstPid"] = first.pid;
			evidence["nativeSessionId"] = originalQuery.sessionId;
			writeFileSync(
				join(harness.root, "d1-selected-pid"),
				JSON.stringify({ pid: first.pid, sessionId, surviveSigkill: true }),
			);
			const pending = browser.send(sessionId, "upgrade-long-turn", 90_000);
			void pending.catch(() => undefined);
			await harness.waitForMark(
				(mark) =>
					mark.kind === "assistant-held" && mark.prompt === "upgrade-long-turn",
			);
			const stopStartedAt = Date.now();
			await harness.requestRpc({
				_tag: "CancelSession",
				sessionId,
				commandId: randomUUID(),
			});
			const stopCompletedAt = Date.now();
			evidence["stopStartedAt"] = stopStartedAt;
			evidence["stopCompletedAt"] = stopCompletedAt;
			expect(() => process.kill(first.pid, 0)).not.toThrow();
			await vi.waitFor(
				() => {
					const row = cursor(harness, runnerId);
					expect(row?.retired_at).toEqual(expect.any(Number));
					expect(row?.attachment_id).toBe("");
				},
				{ timeout: harness.remainingTimeMs(20_000) },
			);
			const retired = cursor(harness, runnerId);
			assert(retired);
			expect(retired.pid).toBe(first.pid);
			expect(retired.start_time).toEqual(expect.any(String));
			evidence["retired_at"] = retired.retired_at;
			evidence["retiredCursor"] = retired;
			const held = runnerRuns(harness, runnerId).find(
				(run) => run.status === "running",
			);
			assert(held?.command_id);
			expect(held).toMatchObject({
				runner_id: runnerId,
				held_transmission: 1,
				completed_at: null,
				command_status: "running",
				receipt_status: "side_effect_requested",
				turn_state: "running",
			});
			evidence["heldWhileAlive"] = held;
			// The bounded Stop reply can precede the TERM grace deadline.
			await vi.waitFor(
				() =>
					expect(proof(harness)).toContainEqual(
						expect.objectContaining({
							kind: "refused-kill",
							target: -first.pid,
						}),
					),
				{ timeout: harness.remainingTimeMs(20_000) },
			);
			evidence["signals"] = proof(harness);
			await harness.kill();
			await pending.catch(() => undefined);
			evidence["daemonKilledAt"] = Date.now();
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			const lateText = responseChunks("upgrade-long-turn")[2];
			assert(lateText);
			await vi.waitFor(
				() =>
					expect(readFileSync(`${first.socketPath}.spool`, "utf8")).toContain(
						lateText,
					),
				{ timeout: harness.remainingTimeMs(20_000) },
			);
			evidence["spooledLateOutput"] = readFileSync(
				`${first.socketPath}.spool`,
				"utf8",
			);
			await harness.restart();
			evidence["daemonRestartedAt"] = Date.now();
			browser = await harness.connect(sessionId);
			expect(() => process.kill(first.pid, 0)).not.toThrow();
			expect(cursor(harness, runnerId)).toMatchObject({
				pid: retired.pid,
				start_time: retired.start_time,
				retired_at: retired.retired_at,
			});
			expect(
				runnerRuns(harness, runnerId).find(({ id }) => id === held.id),
			).toMatchObject({
				status: "running",
				held_transmission: 1,
				completed_at: null,
				command_status: "running",
			});
			expect(JSON.stringify(await browser.history(sessionId))).not.toContain(
				lateText,
			);
			const members = JSON.parse(retired.member_snapshot) as RunnerMember[];
			expect(members).toContainEqual(owned[0]);
			owned.push(...members);
			const terminal = browser.waitForTurnEnd(
				sessionId,
				0,
				harness.remainingTimeMs(15_000),
				held.command_id,
			);
			for (const member of members) signalOwned(member, "SIGKILL");
			await vi.waitFor(
				() => expect(runnerMembersGone(runnerProcessTable, members)).toBe(true),
				{ timeout: harness.remainingTimeMs(5000) },
			);
			await vi.waitFor(
				() => {
					const settled = runnerRuns(harness, runnerId).find(
						({ id }) => id === held.id,
					);
					expect(settled).toMatchObject({
						status: "interrupted",
						completed_at: expect.any(Number),
						command_status: "failed",
						receipt_status: "side_effect_failed",
						turn_state: "interrupted",
					});
					evidence["settledAfterGone"] = settled;
				},
				{ timeout: harness.remainingTimeMs(15_000) },
			);
			const settledDb = new Database(harness.daemonStorePath(), {
				readonly: true,
			});
			try {
				const terminals = (
					settledDb
						.prepare(
							"SELECT type, data FROM events WHERE session_id = ? AND json_extract(metadata, '$.runId') = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted') ORDER BY sequence",
						)
						.all(sessionId, held.id) as Array<{ type: string; data: string }>
				).map(({ type, data }) => ({
					type,
					data: JSON.parse(data) as unknown,
				}));
				expect(terminals).toEqual([
					{
						type: "turn.interrupted",
						data: { messageId: "", reason: "Provider process stopped" },
					},
				]);
				evidence["terminalsAfterGone"] = terminals;
			} finally {
				settledDb.close();
			}
			expect((await terminal)["status"]).toBe("idle");
			const resumed = await browser.send(sessionId, "r1-after-retirement");
			expect(resumed.chunks.join("")).toBe(
				responseChunks("r1-after-retirement").join(""),
			);
			expect(resumed.done["status"]).toBe("idle");
			const replacement = harness.marks
				.filter(
					(mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId,
				)
				.at(-1);
			assert(replacement?.kind === "runner-started");
			owned.push(identity(replacement.pid));
			expect(replacement.pid).not.toBe(first.pid);
			const resumedQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === replacement.pid,
			);
			assert(resumedQuery?.kind === "query");
			expect(resumedQuery.sessionId).toBe(originalQuery.sessionId);
			expect(JSON.stringify(await browser.history(sessionId))).not.toContain(
				lateText,
			);
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'text.delta' AND data LIKE ?",
						)
						.get(sessionId, `%${lateText}%`),
				).toEqual({ count: 0 });
			} finally {
				db.close();
			}
			await vi.waitFor(() => expect(cursor(harness, runnerId)).toBeUndefined());
			evidence["replacementPid"] = replacement.pid;
			evidence["resumedNativeSessionId"] = resumedQuery.sessionId;
			evidence["cursorAfterRestart"] = cursor(harness, runnerId);
			evidence["passed"] = true;
		} finally {
			try {
				await cleanupOwned(harness, owned);
				evidence["cleanup"] = harness.proof();
			} catch (cause) {
				evidence["passed"] = false;
				evidence["cleanupFailure"] = String(cause);
				await Promise.reject(cause);
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
				process.stdout.write(`R1 retired-restart artifact: ${artifactPath}\n`);
			}
		}
	}, 120_000);
});
