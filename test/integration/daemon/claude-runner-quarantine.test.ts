import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
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
					const turn = await restored.send(idle, prompt);
					evidence[prompt] = turn;
					expect(turn.done["attention"]).toBe("error");
					expect(turn.chunks).toEqual([]);
					const history = await restored.history(idle);
					evidence["history"] = history;
					expect(JSON.stringify(history)).toMatch(failure);
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
