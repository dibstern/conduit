import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	RUNNER_PROTOCOL_VERSION,
	RunnerSocket,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { discoverRunners } from "../../../src/lib/provider/runner/runner-registry.js";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

function ownership(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			approvals: db
				.prepare(
					"SELECT id, status, provider_process_id FROM pending_approvals WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId),
			runs: db
				.prepare(
					"SELECT id, status FROM provider_runs WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId),
			commands: db
				.prepare(
					"SELECT command_id, status, run_id FROM provider_command_outbox WHERE session_id = ? ORDER BY request_sequence",
				)
				.all(sessionId),
			receipts: db
				.prepare(
					"SELECT command_id, status FROM command_receipts WHERE session_id = ? ORDER BY command_id",
				)
				.all(sessionId),
			inputs: db
				.prepare(
					"SELECT input_id, state FROM pending_inputs WHERE session_id = ? ORDER BY input_id",
				)
				.all(sessionId),
			events: db
				.prepare(
					"SELECT type, data FROM events WHERE session_id = ? AND (type LIKE 'input.%' OR type IN ('question.resolved', 'permission.resolved', 'tool.completed')) ORDER BY sequence",
				)
				.all(sessionId),
		};
	} finally {
		db.close();
	}
}

function retirement(harness: ProcessHarness, runnerId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT retired_at, attachment_id, pid FROM claude_runner_cursors WHERE runner_id = ?",
			)
			.get(runnerId);
	} finally {
		db.close();
	}
}

function sendState(harness: ProcessHarness, sessionId: string, prompt: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		const run = db
			.prepare<
				[string, string],
				{
					id: string;
					status: string;
					runner_id: string | null;
					held_transmission: number | null;
				}
			>(
				"SELECT run.id, run.status, run.runner_id, run.held_transmission FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id WHERE command.session_id = ? AND command.effect_type = 'send_turn' AND instr(command.payload_json, ?) > 0 ORDER BY command.request_sequence DESC LIMIT 1",
			)
			.get(sessionId, JSON.stringify(prompt));
		assert(run, `Missing run for ${prompt}`);
		return {
			run,
			terminals: db
				.prepare<[string, string, string], { type: string; data: string }>(
					"SELECT type, data FROM events WHERE session_id = ? AND type IN ('turn.completed', 'turn.error', 'turn.interrupted') AND (json_extract(metadata, '$.runId') = ? OR json_extract(data, '$.runId') = ?) ORDER BY sequence",
				)
				.all(sessionId, run.id, run.id),
		};
	} finally {
		db.close();
	}
}

describe("runner retirement through browser RPC", () => {
	it("releases a failed forced kill and resumes on a fresh runner", async () => {
		const evidence: Record<string, unknown> = { passed: false };
		const harness = ProcessHarness.create({
			dist: "dist",
			restartProof: true,
			deadline: performance.now() + 120_000,
		});
		try {
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`
import { appendFileSync as d1RecordStop } from "node:fs";
import { RunnerSocket as D1Socket } from ${JSON.stringify(pathToFileURL(resolve("dist/src/lib/provider/runner/runner-protocol.js")).href)};
const d1Selection = join(root, "d1-denied-stop");
const d1Selected = pid => existsSync(d1Selection) && JSON.parse(readFileSync(d1Selection, "utf8")).pid === Math.abs(pid);
if (!/claude-session-runner\\.(js|ts)$/.test(process.argv[1] ?? "")) {
  const write = D1Socket.prototype.write;
  let selectedSocket;
  D1Socket.prototype.write = function(message) {
    if (message.type === "command" && message.command.type === "send-turn" && existsSync(d1Selection) && message.command.input.sessionId === JSON.parse(readFileSync(d1Selection, "utf8")).sessionId) selectedSocket = this;
    if (this === selectedSocket && message.type === "command" && ["interrupt", "end-session", "shutdown"].includes(message.command.type)) return;
    return write.call(this, message);
  };
  const kill = process.kill;
  process.kill = function(pid, signal) {
    if (signal !== 0 && d1Selected(pid)) {
      d1RecordStop(join(root, "d1-denied-signals.jsonl"), JSON.stringify({ pid, signal, at: Date.now() }) + "\\n");
      throw Object.assign(new Error("Fixture denied runner signal"), { code: "EPERM" });
    }
    return kill.call(process, pid, signal);
  };
}
`,
			);
			await harness.restart();
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Failed kill release");
			await browser.send(sessionId, "before-failed-kill");
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			assert(owner);
			const native = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === owner.pid,
			);
			assert(native?.kind === "query");
			writeFileSync(
				join(harness.root, "d1-denied-stop"),
				JSON.stringify({ pid: owner.pid, sessionId }),
			);
			const pending = browser.send(sessionId, "stall-failed-kill", 60_000);
			void pending.catch(() => undefined);
			await harness.waitForMark(
				(mark) =>
					mark.kind === "enqueue" && mark.prompt === "stall-failed-kill",
			);
			const stop = harness.requestRpc({
				_tag: "CancelSession",
				sessionId,
				commandId: randomUUID(),
			});
			void stop.catch(() => undefined);
			await vi.waitFor(
				() =>
					expect(retirement(harness, owner.runnerId)).toEqual({
						retired_at: expect.any(Number),
						attachment_id: "",
						pid: owner.pid,
					}),
				{ timeout: 40_000 },
			);
			await vi.waitFor(
				() =>
					expect(
						readFileSync(join(harness.root, "d1-denied-signals.jsonl"), "utf8"),
					).toContain('"signal":"SIGKILL"'),
				{ timeout: 5_000 },
			);
			evidence["retired"] = retirement(harness, owner.runnerId);
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			const held = sendState(harness, sessionId, "stall-failed-kill");
			expect(held.run).toMatchObject({
				status: "running",
				runner_id: owner.runnerId,
				held_transmission: 1,
			});
			expect(held.terminals).toEqual([]);
			evidence["heldWhileAlive"] = held;
			const denied = readFileSync(
				join(harness.root, "d1-denied-signals.jsonl"),
				"utf8",
			);
			expect(denied).toContain('"signal":"SIGTERM"');
			expect(denied).toContain('"signal":"SIGKILL"');
			evidence["signals"] = denied;
			expect(harness.signalOwnedRunner(owner.pid, "SIGKILL")).toBe(true);
			await vi.waitFor(() =>
				expect(harness.remainingRunnerPids()).not.toContain(owner.pid),
			);
			await vi.waitFor(
				() =>
					expect(
						sendState(harness, sessionId, "stall-failed-kill").run.status,
					).toBe("interrupted"),
				{ timeout: 15_000 },
			);
			const settled = sendState(harness, sessionId, "stall-failed-kill");
			expect(settled.terminals.map(({ type }) => type)).toEqual([
				"turn.interrupted",
			]);
			expect(JSON.parse(settled.terminals[0]?.data ?? "null")).toMatchObject({
				reason: "Provider process stopped",
			});
			expect(ownership(harness, sessionId).runs).not.toContainEqual(
				expect.objectContaining({ status: "running" }),
			);
			evidence["settledAfterGone"] = settled;
			await stop;
			await pending;
			const next = await browser.send(sessionId, "after-failed-kill");
			expect(next.chunks.join("")).toBe(
				responseChunks("after-failed-kill").join(""),
			);
			const replacement = discoverRunners(
				harness.projectDir,
				harness.configDir,
			).find(
				(entry) =>
					entry.sessionId === sessionId && entry.runnerId !== owner.runnerId,
			);
			assert(replacement);
			expect(replacement.pid).not.toBe(owner.pid);
			const resumedQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === replacement.pid,
			);
			assert(resumedQuery?.kind === "query");
			expect(resumedQuery.sessionId).toBe(native.sessionId);
			evidence["replacement"] = replacement;
			evidence["resumedNativeSessionId"] = native.sessionId;
			evidence["passed"] = true;
		} finally {
			evidence["proof"] = harness.proof();
			evidence["logTail"] = harness.logTail;
			await harness.dispose();
			evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
			mkdirSync("test-results/82tn-32-16", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-16/failed-kill-release.json",
				JSON.stringify(evidence, null, 2),
			);
			harness.assertNoRunners();
		}
	}, 150_000);

	it("retires an unreachable owner across restart and drops its late spool", async () => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
		});
		const evidence: Record<string, unknown> = { passed: false };
		try {
			const browser = await harness.connect();
			const sessionId = await browser.createSession(
				"Retired owner after restart",
			);
			await browser.send(sessionId, "before-retired-restart");
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			assert(owner);
			const native = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === owner.pid,
			);
			assert(native?.kind === "query");
			const pending = browser.send(sessionId, "upgrade-long-turn");
			void pending.catch(() => undefined);
			await harness.waitForMark(
				(mark) =>
					mark.kind === "assistant-held" && mark.prompt === "upgrade-long-turn",
			);
			await harness.kill();
			await pending.catch(() => undefined);
			renameSync(owner.socketPath, `${owner.socketPath}.unreachable`);
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`
import { unlinkSync as d1Unlink } from "node:fs";
import { appendFileSync as d1DeniedRetired } from "node:fs";
const d1Kill = process.kill;
process.kill = function(pid, signal) {
  if (Math.abs(pid) === ${owner.pid} && signal !== 0) {
    d1DeniedRetired(join(root, "retired-denied-signals.jsonl"), JSON.stringify({ pid, signal }) + "\\n");
    throw Object.assign(new Error("Fixture retained retired runner"), { code: "EPERM" });
  }
  return d1Kill.call(process, pid, signal);
};
const d1Spawn = childProcess.spawn;
childProcess.spawn = function(...args) {
  const refusal = join(root, "refuse-next-runner-start");
  if (args[1]?.some(arg => /claude-session-runner\\.(js|ts)$/.test(arg)) && existsSync(refusal)) {
    d1Unlink(refusal);
    throw Object.assign(new Error("Synthetic replacement spawn failure"), { code: "ENOENT" });
  }
  return d1Spawn.apply(this, args);
};
syncBuiltinESMExports();
`,
			);
			await harness.restart();
			let restored = await harness.connect(sessionId);
			expect(harness.logTail).toContain("Retired surviving runner");
			await vi.waitFor(() =>
				expect(retirement(harness, owner.runnerId)).toEqual({
					retired_at: expect.any(Number),
					attachment_id: "",
					pid: owner.pid,
				}),
			);
			const held = sendState(harness, sessionId, "upgrade-long-turn");
			expect(held.run).toMatchObject({
				status: "running",
				runner_id: owner.runnerId,
				held_transmission: 1,
			});
			expect(held.terminals).toEqual([]);
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			evidence["heldWhileAlive"] = held;
			const lateText = responseChunks("upgrade-long-turn").at(-1);
			assert(lateText);
			let observer: RunnerSocket | undefined;
			const spooled = new Promise<void>((resolve, reject) => {
				let received = false;
				const socket = createConnection(`${owner.socketPath}.unreachable`);
				const peer = new RunnerSocket(
					socket,
					(message) => {
						if (received) return;
						if (message.type === "hello") {
							peer.write({
								type: "replay",
								acknowledgedSequence: 0,
								preserveRole: true,
							});
						} else if (
							message.type === "output" &&
							message.output.type === "event" &&
							message.output.event.type === "text.delta" &&
							JSON.stringify(message.output.event.data).includes(lateText)
						) {
							received = true;
							resolve();
						} else if (message.type === "output") {
							peer.write({
								type: "output-reply",
								outputId: message.outputId,
								sequence: message.sequence,
								result: {},
							});
						}
					},
					reject,
				);
				observer = peer;
				socket.once("connect", () =>
					peer.write({
						type: "hello",
						protocolVersion: RUNNER_PROTOCOL_VERSION,
						buildId: owner.buildId,
						config: {
							workspaceRoot: harness.projectDir,
							daemonConfigDir: harness.configDir,
						},
					}),
				);
			});
			try {
				writeFileSync(
					join(harness.root, "release-upgrade-turn"),
					"release retired output",
				);
				await spooled;
			} finally {
				observer?.destroy();
			}
			await harness.kill();
			renameSync(`${owner.socketPath}.unreachable`, owner.socketPath);
			await harness.restart();
			restored = await harness.connect(sessionId);
			expect(readFileSync(`${owner.socketPath}.spool`, "utf8")).toContain(
				lateText,
			);
			expect(retirement(harness, owner.runnerId)).toEqual({
				retired_at: expect.any(Number),
				attachment_id: "",
				pid: owner.pid,
			});
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			expect(sendState(harness, sessionId, "upgrade-long-turn")).toEqual(held);
			const db = new Database(harness.daemonStorePath(), { readonly: true });
			try {
				expect(
					db
						.prepare(
							"SELECT sequence FROM events WHERE session_id = ? AND type = 'text.delta' AND json_extract(data, '$.text') = ?",
						)
						.all(sessionId, lateText),
				).toEqual([]);
			} finally {
				db.close();
			}
			evidence["lateSpoolFencedWhileAlive"] = {
				lateText,
				retired: retirement(harness, owner.runnerId),
				held: sendState(harness, sessionId, "upgrade-long-turn"),
			};
			evidence["deniedSignals"] = readFileSync(
				join(harness.root, "retired-denied-signals.jsonl"),
				"utf8",
			);
			expect(harness.signalOwnedRunner(owner.pid, "SIGKILL")).toBe(true);
			await vi.waitFor(() =>
				expect(harness.remainingRunnerPids()).not.toContain(owner.pid),
			);
			await vi.waitFor(
				() =>
					expect(
						sendState(harness, sessionId, "upgrade-long-turn").run.status,
					).toBe("interrupted"),
				{ timeout: 35_000 },
			);
			const settled = sendState(harness, sessionId, "upgrade-long-turn");
			expect(settled.terminals.map(({ type }) => type)).toEqual([
				"turn.interrupted",
			]);
			expect(JSON.parse(settled.terminals[0]?.data ?? "null")).toMatchObject({
				reason: "Provider process stopped",
			});
			expect(ownership(harness, sessionId).runs).not.toContainEqual(
				expect.objectContaining({ status: "running" }),
			);
			evidence["settledAfterGone"] = settled;
			writeFileSync(
				join(harness.root, "refuse-next-runner-start"),
				"refuse once",
			);
			const runsBeforeTransientFailure = ownership(harness, sessionId).runs
				.length;
			const retried = await restored.send(
				sessionId,
				"replacement-start-refusal",
			);
			expect(retried.chunks.join("")).toBe(
				responseChunks("replacement-start-refusal").join(""),
			);
			expect(retried.done).toMatchObject({ status: "idle" });
			expect(retried.done).not.toMatchObject({ attention: "error" });
			expect(JSON.stringify(await restored.history(sessionId))).not.toContain(
				"Synthetic replacement spawn failure",
			);
			const retriedState = sendState(
				harness,
				sessionId,
				"replacement-start-refusal",
			);
			expect(retriedState.run).toMatchObject({
				status: "completed",
				held_transmission: 1,
			});
			expect(retriedState.terminals.map(({ type }) => type)).toEqual([
				"turn.completed",
			]);
			const retriedEnqueues = harness.marks.filter(
				(mark) =>
					mark.kind === "enqueue" &&
					mark.prompt === "replacement-start-refusal",
			);
			expect(retriedEnqueues).toHaveLength(1);
			expect(ownership(harness, sessionId).runs).toHaveLength(
				runsBeforeTransientFailure + 1,
			);
			evidence["continuedAfterTransientSpawnFailure"] = {
				state: retriedState,
				nativeEnqueues: retriedEnqueues.length,
			};
			const next = await restored.send(sessionId, "after-retired-restart");
			expect(next.chunks.join("")).toBe(
				responseChunks("after-retired-restart").join(""),
			);
			const replacement = discoverRunners(
				harness.projectDir,
				harness.configDir,
			).find(
				(entry) =>
					entry.sessionId === sessionId && entry.runnerId !== owner.runnerId,
			);
			assert(replacement);
			expect(replacement.pid).not.toBe(owner.pid);
			const resumedQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === replacement.pid,
			);
			assert(resumedQuery?.kind === "query");
			expect(resumedQuery.sessionId).toBe(native.sessionId);
			const registrations = discoverRunners(
				harness.projectDir,
				harness.configDir,
			);
			expect(registrations).toContainEqual(
				expect.objectContaining({
					runnerId: replacement.runnerId,
					pid: replacement.pid,
				}),
			);
			expect(
				(
					await restored.send(sessionId, "after-retired-socket-returns")
				).chunks.join(""),
			).toBe(responseChunks("after-retired-socket-returns").join(""));
			evidence["oldPid"] = owner.pid;
			evidence["replacementPid"] = replacement.pid;
			evidence["resumedNativeSessionId"] = native.sessionId;
			evidence["registrations"] = registrations;
			evidence["passed"] = true;
		} finally {
			evidence["proof"] = harness.proof();
			evidence["logTail"] = harness.logTail;
			await harness.dispose();
			evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
			mkdirSync("test-results/82tn-32-16", { recursive: true });
			writeFileSync(
				"test-results/82tn-32-16/retired-restart.json",
				JSON.stringify(evidence, null, 2),
			);
			harness.assertNoRunners();
		}
	}, 90_000);

	it.each([
		"protocol",
		"run-ownership",
		"candidate-stop",
	] as const)("releases a %s survivor without affecting a healthy neighbor", async (mode) => {
		const harness = await ProcessHarness.start({
			dist: "dist",
			restartProof: true,
			...(mode === "candidate-stop"
				? {}
				: {
						runnerLifecycle: {
							runnerHelloAfterFirst: true,
							...(mode === "protocol"
								? { runnerHelloProtocolVersion: 999 }
								: { runnerHelloWithoutRunIds: true }),
						},
					}),
		});
		const evidence: Record<string, unknown> = { mode, passed: false };
		try {
			const browser = await harness.connect();
			const healthy = await browser.createSession("Healthy beside a survivor");
			await browser.send(healthy, "healthy-before-retirement");
			const sessionId = await browser.createSession("Incompatible survivor");
			await browser.send(sessionId, "before-incompatible-retirement");
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			assert(owner);
			if (mode === "candidate-stop") {
				const db = new Database(harness.daemonStorePath());
				try {
					db.prepare(
						"UPDATE claude_runner_cursors SET role = 'candidate' WHERE runner_id = ?",
					).run(owner.runnerId);
				} finally {
					db.close();
				}
			}
			await harness.kill();
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`
import { appendFileSync as d1Denied } from "node:fs";
const d1Kill = process.kill;
process.kill = function(pid, signal) {
  if (Math.abs(pid) === ${owner.pid} && signal !== 0) {
    d1Denied(join(root, "denied-stops.jsonl"), JSON.stringify({ pid, signal }) + "\\n");
    throw Object.assign(new Error("Fixture denied runner signal"), { code: "EPERM" });
  }
  return d1Kill.call(process, pid, signal);
};
${
	mode === "candidate-stop"
		? `
const d1Net = (await import("node:net")).default;
const d1Connect = d1Net.createConnection;
d1Net.createConnection = function(...args) {
  const socket = d1Connect.apply(this, args);
  if (args[0] === ${JSON.stringify(owner.socketPath)}) {
    const write = socket.write;
    socket.write = function(chunk, ...rest) {
      if (String(chunk).includes('"type":"shutdown"')) return true;
      return write.call(this, chunk, ...rest);
    };
  }
  return socket;
};
syncBuiltinESMExports();`
		: ""
}
`,
			);
			await harness.restart();
			const restored = await harness.connect(sessionId);
			await vi.waitFor(() =>
				expect(retirement(harness, owner.runnerId)).toEqual({
					retired_at: expect.any(Number),
					attachment_id: "",
					pid: owner.pid,
				}),
			);
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			const expectedReason =
				mode === "protocol"
					? /protocol.*mismatch/i
					: mode === "run-ownership"
						? /predates run ownership/i
						: /Retired surviving runner/;
			expect(harness.logTail).toMatch(expectedReason);
			expect(harness.logTail).not.toMatch(/Failed to create relay/);
			expect(
				(await restored.send(healthy, "healthy-after-retirement")).chunks.join(
					"",
				),
			).toBe(responseChunks("healthy-after-retirement").join(""));
			expect(
				(
					await restored.send(sessionId, "after-incompatible-retirement")
				).chunks.join(""),
			).toBe(responseChunks("after-incompatible-retirement").join(""));
			evidence["registrations"] = discoverRunners(
				harness.projectDir,
				harness.configDir,
			);
			evidence["deniedSignals"] = existsSync(
				join(harness.root, "denied-stops.jsonl"),
			)
				? readFileSync(join(harness.root, "denied-stops.jsonl"), "utf8")
				: "";
			evidence["passed"] = true;
		} finally {
			evidence["proof"] = harness.proof();
			evidence["logTail"] = harness.logTail;
			await harness.dispose();
			evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
			mkdirSync("test-results/82tn-32-16", { recursive: true });
			writeFileSync(
				`test-results/82tn-32-16/retired-${mode}.json`,
				JSON.stringify(evidence, null, 2),
			);
			harness.assertNoRunners();
		}
	}, 60_000);
	it.each([
		{ owner: "legacy", withRunner: true },
		{ owner: "legacy", withRunner: false },
		{ owner: "current", withRunner: true },
		{ owner: "replaced", withRunner: true },
		{ owner: "gone", withRunner: false },
	])("cleans only orphaned permissions, owner=$owner, healthy runner=$withRunner", async ({
		owner,
		withRunner,
	}) => {
		const evidence: Record<string, unknown> = {
			owner,
			withRunner,
			passed: false,
		};
		let harness: ProcessHarness | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession(
				"Orphaned legacy permission",
			);
			if (withRunner) await browser.send(sessionId, "healthy-permission-owner");
			const current = discoverRunners(
				harness.projectDir,
				harness.configDir,
			).find((entry) => entry.sessionId === sessionId);
			const processId =
				owner === "legacy"
					? null
					: owner === "current"
						? current?.runnerId
						: `${owner}-process`;
			assert(processId !== undefined, "Missing permission owner");
			await harness.kill();
			const id = randomUUID();
			const db = new Database(harness.daemonStorePath());
			try {
				const version =
					db
						.prepare<[string], { version: number }>(
							"SELECT COALESCE(MAX(stream_version) + 1, 0) AS version FROM events WHERE session_id = ?",
						)
						.get(sessionId)?.version ?? 0;
				const at = Date.now();
				const input = { command: "echo stale" };
				db.transaction(() => {
					db.prepare(
						"INSERT INTO events (project_id, event_id, session_id, stream_version, type, data, metadata, provider, created_at) VALUES ('process-test', ?, ?, ?, 'permission.asked', ?, '{}', 'claude', ?)",
					).run(
						randomUUID(),
						sessionId,
						version,
						JSON.stringify({ id, sessionId, toolName: "Bash", input }),
						at,
					);
					db.prepare(
						"INSERT INTO pending_approvals (id, session_id, type, status, tool_name, input, details, version, created_at, provider_process_id, provider_request_id) VALUES (?, ?, 'permission', 'pending', 'Bash', ?, '{}', ?, ?, ?, NULL)",
					).run(id, sessionId, JSON.stringify(input), version, at, processId);
				})();
			} finally {
				db.close();
			}
			evidence["before"] = ownership(harness, sessionId);
			await harness.restart();
			const restored = await harness.connect(sessionId);
			evidence["afterRecovery"] = ownership(harness, sessionId);
			if (owner === "current") {
				expect(ownership(harness, sessionId).approvals).toEqual([
					{ id, status: "pending", provider_process_id: processId },
				]);
				// Once that specific owner is gone, the same ask becomes orphaned.
				await harness.kill();
				assert(current, "Missing permission owner");
				expect(harness.signalOwnedRunner(current.pid, "SIGKILL")).toBe(true);
				await vi.waitFor(() =>
					expect(() => process.kill(current.pid, 0)).toThrow(),
				);
				await harness.restart();
			}
			expect(ownership(harness, sessionId).approvals).toEqual([
				{ id, status: "resolved", provider_process_id: processId },
			]);
			const response = await (owner === "current"
				? await harness.connect(sessionId)
				: restored
			).send(sessionId, "after-orphan-cleanup");
			evidence["send"] = response;
			evidence["afterSend"] = ownership(harness, sessionId);
			expect(response.chunks.join("")).toBe(
				responseChunks("after-orphan-cleanup").join(""),
			);
			evidence["passed"] = true;
		} finally {
			if (harness) {
				evidence["logTail"] = harness.logTail;
				await harness.dispose();
				evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
			mkdirSync("test-results/82tn-32-16", { recursive: true });
			writeFileSync(
				`test-results/82tn-32-16/orphan-${owner}-${withRunner}-regression.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 60_000);
});
