import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	discoverRunners,
	registerRunner,
} from "../../../src/lib/provider/runner/runner-registry.js";
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

// Failure cases: adoption takes the whole project offline; cleanup loses the
// surviving process's registration, spool or approvals; a later send launches
// another runner; an abandoned candidate escapes the session's quarantine.
describe("startup runner quarantine through browser RPC", () => {
	it.each([
		false,
		true,
	])("refuses busy-session admission before queuing, approval=%s", async (approval) => {
		const evidence: Record<string, unknown> = { approval, passed: false };
		let harness: ProcessHarness | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Quarantined busy input");
			const sending = browser.send(
				sessionId,
				approval ? "approval-quarantine-admission" : "upgrade-long-turn",
			);
			void sending.catch(() => undefined);
			await browser.waitFor((frame) =>
				approval
					? frame["type"] === "permission_pending"
					: frame["type"] === "transcript_message" &&
						frame["role"] === "assistant",
			);
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			if (!owner) throw new Error("Missing busy owner");
			await harness.kill();
			await sending.catch(() => undefined);
			renameSync(owner.socketPath, `${owner.socketPath}.unreachable`);
			await harness.restart();
			const restored = await harness.connect(sessionId);
			const before = ownership(harness, sessionId);
			evidence["before"] = before;
			const inputId = randomUUID();
			for (const delivery of ["queue", "queue", "steer"] as const) {
				const result = await restored["run"](
					restored.rpc["input.submit"]({
						sessionId,
						inputId,
						originId: restored.originId,
						text: "blocked-busy-input",
						delivery,
					}),
				).catch(String);
				evidence[delivery] = result;
				evidence["afterSubmit"] = ownership(harness, sessionId);
				expect(result).toEqual(expect.stringMatching(/quarantined/));
				expect(ownership(harness, sessionId)).toEqual(before);
			}
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			const healthy = await restored.createSession(
				"Healthy beside busy quarantine",
			);
			expect(
				(await restored.send(healthy, "healthy-busy-neighbor")).chunks.join(""),
			).toBe(responseChunks("healthy-busy-neighbor").join(""));
			evidence["passed"] = true;
		} finally {
			if (harness) {
				evidence["logTail"] = harness.logTail;
				await harness.dispose();
				evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
			writeFileSync(
				`/tmp/conduit-phis-busy-${approval}-regression.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 60_000);

	it.each([
		"permission",
		"question",
	] as const)("preserves quarantined %s approvals across sends, answers, interruption and restart", async (kind) => {
		const evidence: Record<string, unknown> = { kind, passed: false };
		let harness: ProcessHarness | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession(
				"Quarantined approval answers",
			);
			const sending = browser.send(
				sessionId,
				kind === "permission"
					? "approval-quarantine-answer"
					: "question-fixed-quarantine-answer",
			);
			void sending.catch(() => undefined);
			const request = await browser.waitFor(
				(frame) => frame["type"] === `${kind}_pending`,
			);
			const answer = (
				client: typeof browser,
				decision: "allow" | "deny" | "allow_always",
			) =>
				kind === "permission"
					? client.answerApproval(request, decision)
					: decision === "deny"
						? client.rejectQuestion(request)
						: client["run"](
								client.rpc.AnswerQuestion({
									projectSlug: "process-test",
									originId: client.originId,
									commandId: randomUUID(),
									toolId: String(request["toolId"]),
									answers: { "0": "Continue" },
								}),
							).then(() => undefined);
			const before = ownership(harness, sessionId);
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			if (!owner) throw new Error("Missing approval owner");
			await harness.kill();
			await sending.catch(() => undefined);
			renameSync(owner.socketPath, `${owner.socketPath}.unreachable`);
			await harness.restart();
			let restored = await harness.connect(sessionId);
			evidence["before"] = before;
			expect(
				await restored["run"](
					restored.rpc["input.submit"]({
						sessionId,
						inputId: randomUUID(),
						originId: restored.originId,
						text: "",
						delivery: "queue",
					}),
				),
			).toEqual({ ok: true, sessionId, handedOff: false });
			expect(ownership(harness, sessionId)).toEqual(before);
			const inputId = randomUUID();
			for (const delivery of ["queue", "queue", "steer"] as const) {
				const result = await restored["run"](
					restored.rpc["input.submit"]({
						sessionId,
						inputId,
						originId: restored.originId,
						text: "blocked-before-question-resolution",
						delivery,
					}),
				).catch(String);
				evidence[`send-${delivery}`] = result;
				evidence["afterSend"] = ownership(harness, sessionId);
				expect(result).toEqual(expect.stringMatching(/quarantined/));
				expect(ownership(harness, sessionId)).toEqual(before);
			}
			for (const decision of ["allow", "deny", "allow_always"] as const) {
				const result = await answer(restored, decision).catch(String);
				evidence[decision] = result;
				evidence["afterAnswer"] = ownership(harness, sessionId);
				expect(result).toEqual(expect.stringMatching(/quarantined/));
				expect(ownership(harness, sessionId)).toEqual(before);
			}
			await expect(
				restored["run"](
					restored.rpc.CancelSession({
						sessionId,
						commandId: "phis-quarantined-stop",
					}),
				),
			).rejects.toThrow(/quarantined/);
			expect(ownership(harness, sessionId)).toEqual(before);
			await harness.kill();
			await harness.restart();
			restored = await harness.connect(sessionId);
			await expect(answer(restored, "allow")).rejects.toThrow(/quarantined/);
			expect(ownership(harness, sessionId)).toEqual(before);
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			await harness.kill();
			renameSync(`${owner.socketPath}.unreachable`, owner.socketPath);
			await harness.restart();
			restored = await harness.connect(sessionId);
			evidence["afterSocketRecovery"] = ownership(harness, sessionId);
			expect(ownership(harness, sessionId)).toEqual(before);
			await answer(restored, "allow");
			const recoveredHarness = harness;
			await vi.waitFor(() =>
				expect(ownership(recoveredHarness, sessionId).approvals).toEqual([
					expect.objectContaining({ status: "resolved" }),
				]),
			);
			expect(
				(await restored.send(sessionId, "after-approval-recovery")).chunks.join(
					"",
				),
			).toBe(responseChunks("after-approval-recovery").join(""));
			evidence["afterRecovery"] = ownership(harness, sessionId);
			evidence["passed"] = true;
		} finally {
			if (harness) {
				evidence["logTail"] = harness.logTail;
				await harness.dispose();
				evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
			writeFileSync(
				`/tmp/conduit-phis-${kind}-regression.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 120_000);

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
			if (processId === undefined) throw new Error("Missing permission owner");
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
				if (!current) throw new Error("Missing permission owner");
				process.kill(current.pid, "SIGKILL");
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
			writeFileSync(
				`/tmp/conduit-phis-orphan-${owner}-${withRunner}-regression.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 60_000);

	it("refuses queued Run now before interruption or steering side effects", async () => {
		const evidence: Record<string, unknown> = { passed: false };
		let harness: ProcessHarness | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Quarantined Run now");
			const sending = browser.send(sessionId, "upgrade-long-turn");
			void sending.catch(() => undefined);
			await browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["role"] === "assistant",
			);
			const inputId = randomUUID();
			expect(
				await browser["run"](
					browser.rpc["input.submit"]({
						sessionId,
						inputId,
						originId: browser.originId,
						text: "queued-before-quarantine",
						delivery: "queue",
					}),
				),
			).toEqual({ ok: true, sessionId, handedOff: false });
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			if (!owner) throw new Error("Missing queued input owner");
			await harness.kill();
			await sending.catch(() => undefined);
			renameSync(owner.socketPath, `${owner.socketPath}.unreachable`);
			await harness.restart();
			let restored = await harness.connect(sessionId);
			const before = ownership(harness, sessionId);
			evidence["before"] = before;
			for (const interrupt of [true, true, false, false]) {
				const result = await restored["run"](
					restored.rpc["input.sendNow"]({
						sessionId,
						inputId,
						originId: restored.originId,
						interrupt,
					}),
				).catch(String);
				evidence[`sendNow-${interrupt}`] = result;
				evidence["afterSendNow"] = ownership(harness, sessionId);
				expect(result).toEqual(expect.stringMatching(/quarantined/));
				expect(ownership(harness, sessionId)).toEqual(before);
			}
			const concurrent = await Promise.all(
				[true, true].map((interrupt) =>
					restored["run"](
						restored.rpc["input.sendNow"]({
							sessionId,
							inputId,
							originId: restored.originId,
							interrupt,
						}),
					).catch(String),
				),
			);
			evidence["concurrentRetries"] = concurrent;
			expect(concurrent).toEqual([
				expect.stringMatching(/quarantined/),
				expect.stringMatching(/quarantined/),
			]);
			expect(ownership(harness, sessionId)).toEqual(before);
			await harness.kill();
			await harness.restart();
			restored = await harness.connect(sessionId);
			await expect(
				restored["run"](
					restored.rpc["input.sendNow"]({
						sessionId,
						inputId,
						originId: restored.originId,
						interrupt: true,
					}),
				),
			).rejects.toThrow(/quarantined/);
			expect(ownership(harness, sessionId)).toEqual(before);
			expect(() => process.kill(owner.pid, 0)).not.toThrow();
			// Removing a queued input still works while the process is quarantined.
			expect(
				await restored["run"](
					restored.rpc["input.cancel"]({
						sessionId,
						inputId,
					}),
				),
			).toEqual({ ok: true });
			const cancelled = ownership(harness, sessionId);
			expect(cancelled.inputs).toContainEqual({
				input_id: inputId,
				state: "removed",
			});
			expect(cancelled.runs).toEqual(before.runs);
			expect(cancelled.commands).toEqual(before.commands);
			evidence["afterCancel"] = cancelled;
			await harness.kill();
			renameSync(`${owner.socketPath}.unreachable`, owner.socketPath);
			await harness.restart();
			restored = await harness.connect(sessionId);
			// Once usable, an input that is no longer queued keeps its usual refusal.
			expect(
				await restored["run"](
					restored.rpc["input.sendNow"]({
						sessionId,
						inputId,
						originId: restored.originId,
						interrupt: true,
					}),
				),
			).toEqual({ ok: false, reason: "already_started" });
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			const recovered = harness;
			await vi.waitFor(() =>
				expect(ownership(recovered, sessionId).runs).toEqual([
					expect.objectContaining({ status: "completed" }),
				]),
			);
			expect(
				(
					await restored.send(sessionId, "after-queued-quarantine-recovery")
				).chunks.join(""),
			).toBe(responseChunks("after-queued-quarantine-recovery").join(""));
			evidence["passed"] = true;
		} finally {
			if (harness) {
				evidence["logTail"] = harness.logTail;
				await harness.dispose();
				evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
			writeFileSync(
				"/tmp/conduit-phis-run-now-regression.json",
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 120_000);

	it.each([
		true,
		false,
	])("fences automatic upgrades while a surviving candidate quarantines the session, held=%s", async (held) => {
		const evidence: Record<string, unknown> = { held, passed: false };
		let harness: ProcessHarness | undefined;
		let candidate: ChildProcess | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
				buildId: "phis-old-build",
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession(
				"Quarantined candidate and older owner",
			);
			const sending = browser.send(
				sessionId,
				held ? "upgrade-long-turn" : "idle-upgrade-owner",
			);
			void sending.catch(() => undefined);
			await browser.waitFor(
				(frame) =>
					frame["type"] === "transcript_message" &&
					frame["role"] === "assistant",
			);
			if (!held) await sending;
			const owner = discoverRunners(harness.projectDir, harness.configDir).find(
				(entry) => entry.sessionId === sessionId,
			);
			if (!owner) throw new Error("Missing older owner");
			const runnerId = "abc123abc123";
			const socketPath = join(dirname(owner.socketPath), runnerId);
			candidate = spawn(
				process.execPath,
				["-e", "setInterval(() => {}, 1000)", socketPath, sessionId, runnerId],
				{ stdio: "ignore" },
			);
			await once(candidate, "spawn");
			if (!candidate.pid) throw new Error("Missing candidate PID");
			registerRunner({
				...owner,
				runnerId,
				socketPath,
				pid: candidate.pid,
				role: "candidate",
			});
			writeFileSync(`${socketPath}.spool`, "");
			await harness.kill();
			await sending.catch(() => undefined);
			const cursor = harness.marks.length;
			await harness.restart({ buildId: "phis-new-build" });
			const restored = await harness.connect(sessionId);
			expect(harness.logTail).toMatch(/is quarantined/);
			if (held)
				writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			await restored.waitFor(
				(frame) =>
					frame["type"] === "session_row" &&
					frame["id"] === sessionId &&
					frame["status"] === "idle",
			);
			// Allow the quiescent callback and the upgrade worker to settle.
			await new Promise((resolve) => setTimeout(resolve, 1500));
			evidence["marks"] = harness.marks.slice(cursor);
			evidence["registrations"] = discoverRunners(
				harness.projectDir,
				harness.configDir,
			);
			expect(
				harness.marks
					.slice(cursor)
					.filter(
						(mark) =>
							mark.kind === "runner-spawned" || mark.kind === "runner-upgrade",
					),
			).toEqual([]);
			expect(
				discoverRunners(harness.projectDir, harness.configDir)
					.map((entry) => entry.pid)
					.sort(),
			).toEqual([owner.pid, candidate.pid].sort());
			for (const text of ["blocked-upgrade-once", "blocked-upgrade-twice"]) {
				await expect(restored.send(sessionId, text)).rejects.toThrow(
					/quarantined/,
				);
			}
			evidence["passed"] = true;
		} finally {
			if (
				candidate &&
				candidate.exitCode === null &&
				candidate.signalCode === null
			) {
				const exited = once(candidate, "exit");
				candidate.kill("SIGKILL");
				await exited;
			}
			if (harness) {
				evidence["logTail"] = harness.logTail;
				await harness.dispose();
				evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
				expect(harness.remainingRunnerPids()).toEqual([]);
			}
			writeFileSync(
				`/tmp/conduit-phis-upgrade-held-${held}-regression.json`,
				JSON.stringify(evidence, null, 2),
			);
		}
	}, 60_000);

	it.each([
		["unreachable", false],
		["protocol", false],
		["unreachable", true],
		["run-ownership", true],
		["candidate-stop", true],
	] as const)(
		"contains %s runners, including candidate=%s, to their sessions",
		async (mode, candidate) => {
			const artifact = `/tmp/conduit-phis-${mode}-${candidate ? "candidate" : "owner"}.json`;
			const evidence: Record<string, unknown> = {
				mode,
				candidate,
				passed: false,
			};
			let harness: ProcessHarness | undefined;
			try {
				harness = await ProcessHarness.start({
					dist: "dist",
					restartProof: true,
					...(mode === "unreachable" || mode === "candidate-stop"
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
				const browser = await harness.connect();
				const healthy = await browser.createSession("Healthy session");
				await browser.send(healthy, "healthy-before-restart");
				const idle = await browser.createSession("Quarantined idle session");
				await browser.send(idle, "idle-before-restart");
				const pending = await browser.createSession(
					"Quarantined approval owner",
				);
				const waiting = browser.send(pending, "approval-quarantined-runner");
				void waiting.catch(() => undefined);
				await browser.waitFor(
					(frame) => frame["type"] === "permission_pending",
				);
				const before = ownership(harness, pending);
				expect(before.approvals).toEqual([
					expect.objectContaining({ status: "pending" }),
				]);
				expect(before.runs).toEqual([
					expect.objectContaining({ status: "running" }),
				]);
				await harness.kill();
				const retained = discoverRunners(harness.projectDir, harness.configDir)
					.filter(
						(entry) => entry.sessionId === idle || entry.sessionId === pending,
					)
					.map((entry) => {
						if (candidate && entry.sessionId === idle)
							registerRunner({ ...entry, role: "candidate" });
						return {
							...entry,
							registration: readFileSync(`${entry.socketPath}.json`, "utf8"),
							spool: createHash("sha256")
								.update(readFileSync(`${entry.socketPath}.spool`))
								.digest("hex"),
						};
					});
				expect(retained).toHaveLength(2);
				evidence["before"] = before;
				evidence["retained"] = retained;
				if (mode === "unreachable") {
					// A live process with a lost socket cannot answer a hello.
					for (const entry of retained) unlinkSync(entry.socketPath);
				} else {
					// Only this isolated daemon is denied signals to its retained PIDs.
					appendFileSync(
						join(harness.root, "runner-identity-fixture.mjs"),
						`\nimport { appendFileSync as recordStop } from "node:fs";
const deniedPids = new Set(${JSON.stringify(retained.map((entry) => entry.pid))});
const originalKill = process.kill;
process.kill = function(pid, signal) {
  if (deniedPids.has(pid) && signal !== 0) {
    recordStop(join(root, "denied-stops.jsonl"), JSON.stringify({ pid, signal, code: "EPERM" }) + "\\n");
    throw Object.assign(new Error("fixture EPERM"), { code: "EPERM" });
  }
  return originalKill.call(process, pid, signal);
};
${
	mode === "candidate-stop"
		? `
// The candidate answers hello but cannot receive its cooperative shutdown.
const runnerNet = (await import("node:net")).default;
const connect = runnerNet.createConnection;
const retainedPaths = new Set(${JSON.stringify(retained.map((entry) => entry.socketPath))});
runnerNet.createConnection = function(...args) {
  const socket = connect.apply(this, args);
  if (retainedPaths.has(args[0])) {
    const write = socket.write;
    socket.write = function(chunk, ...rest) {
      if (String(chunk).includes('"type":"shutdown"')) {
        recordStop(join(root, "denied-stops.jsonl"), JSON.stringify({ kind: "withheld-shutdown", socketPath: args[0] }) + "\\n");
        return true;
      }
      return write.call(this, chunk, ...rest);
    };
  }
  return socket;
};
syncBuiltinESMExports();
`
		: ""
}\n`,
					);
				}
				await harness.restart();
				const restored = await harness.connect();
				const healthyTurn = await restored.send(
					healthy,
					"healthy-after-restart",
				);
				evidence["healthyTurn"] = healthyTurn;
				expect(healthyTurn.chunks.join("")).toBe(
					responseChunks("healthy-after-restart").join(""),
				);
				expect(ownership(harness, pending)).toEqual(before);
				const failure =
					mode === "unreachable"
						? /quarantined.*(ENOENT|ECONNREFUSED)/i
						: mode === "protocol"
							? /quarantined.*protocol.*mismatch.*999/i
							: mode === "run-ownership"
								? /quarantined.*predates run ownership/i
								: /quarantined.*survived stop/i;
				// Repeat admission to prove that error cleanup never evicts ownership.
				for (const prompt of ["blocked-once", "blocked-twice"]) {
					const refusal = await restored.send(idle, prompt).catch(String);
					evidence[prompt] = refusal;
					expect(refusal).toEqual(expect.stringMatching(failure));
				}
				for (const entry of retained) {
					expect(() => process.kill(entry.pid, 0)).not.toThrow();
					expect(readFileSync(`${entry.socketPath}.json`, "utf8")).toBe(
						entry.registration,
					);
					expect(
						createHash("sha256")
							.update(readFileSync(`${entry.socketPath}.spool`))
							.digest("hex"),
					).toBe(entry.spool);
				}
				expect([
					...new Set(
						harness.marks.flatMap((mark) =>
							mark.kind === "runner-started" && mark.sessionId === idle
								? [mark.pid]
								: [],
						),
					),
				]).toEqual([retained.find((entry) => entry.sessionId === idle)?.pid]);
				expect(ownership(harness, pending)).toEqual(before);
				expect(harness.logTail).not.toMatch(/Failed to create relay/);
				evidence["passed"] = true;
			} catch (cause) {
				evidence["error"] = String(cause);
				throw cause;
			} finally {
				if (harness) {
					evidence["proof"] = harness.proof();
					evidence["logTail"] = harness.logTail;
					const denied = join(harness.root, "denied-stops.jsonl");
					if (existsSync(denied))
						evidence["deniedStops"] = readFileSync(denied, "utf8");
					await harness.dispose();
					evidence["remainingRunnerPids"] = harness.remainingRunnerPids();
					expect(harness.remainingRunnerPids()).toEqual([]);
				}
				writeFileSync(artifact, JSON.stringify(evidence, null, 2));
			}
		},
		60_000,
	);
});
