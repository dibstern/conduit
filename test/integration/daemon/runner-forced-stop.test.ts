import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("runner forced stop with real processes", () => {
	it("SIGKILLs a SIGTERM-ignoring runner and resumes the same native conversation", async () => {
		const artifactDir = "test-results/82tn-32-16";
		mkdirSync(artifactDir, { recursive: true });
		const evidence: Record<string, unknown> = { passed: false };
		const harness = ProcessHarness.create({
			dist: "dist",
			deadline: performance.now() + 100_000,
		});
		try {
			// Reuse the isolated harness preload. Hold only this runner's control
			// transport; its sends, SDK events and real OS signals still run.
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`
import { appendFileSync as d1Append } from "node:fs";
import { RunnerSocket as D1Socket } from ${JSON.stringify(pathToFileURL(resolve("dist/src/lib/provider/runner/runner-protocol.js")).href)};
const d1Selection = join(root, "d1-selected-pid");
const d1Record = (kind, fields = {}) => d1Append(join(root, "d1-stop-proof.jsonl"), JSON.stringify({ kind, at: Date.now(), pid: process.pid, ...fields }) + "\\n");
const d1Selected = pid => existsSync(d1Selection) && JSON.parse(readFileSync(d1Selection, "utf8")).pid === pid;
if (/claude-session-runner\\.(js|ts)$/.test(process.argv[1] ?? "")) {
  const emit = process.emit;
  process.emit = function(event, ...args) {
    if (event === "SIGTERM" && d1Selected(process.pid)) {
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
    return kill.call(process, pid, signal);
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
			await harness.restart();
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Forced stop resume");
			await browser.send(sessionId, "d1-before-stop");
			const first = harness.marks.find(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			);
			assert(first?.kind === "runner-started");
			const originalQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === first.pid,
			);
			assert(originalQuery?.kind === "query");
			evidence["firstPid"] = first.pid;
			evidence["nativeSessionId"] = originalQuery.sessionId;
			writeFileSync(
				join(harness.root, "d1-selected-pid"),
				JSON.stringify({ pid: first.pid, sessionId }),
			);
			const pending = browser.send(sessionId, "stall-d1-stop", 90_000);
			void pending.catch(() => undefined);
			// Observe the actual held turn rather than waiting a fixed duration.
			await harness.waitForMark(
				(mark) => mark.kind === "enqueue" && mark.prompt === "stall-d1-stop",
			);
			const stopStartedAt = Date.now();
			await harness.requestRpc({
				_tag: "CancelSession",
				sessionId,
				commandId: randomUUID(),
			});
			await harness.waitForMark(
				(mark) =>
					mark.kind === "runner-command" &&
					mark.commandId === String(first.pid) &&
					mark.type === "d1-exit-SIGKILL",
			);
			await pending;
			const stopCompletedAt = Date.now();
			unlinkSync(join(harness.root, "d1-selected-pid"));
			const proof = readFileSync(
				join(harness.root, "d1-stop-proof.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			evidence["signalsAndExit"] = proof;
			evidence["stopStartedAt"] = stopStartedAt;
			evidence["stopCompletedAt"] = stopCompletedAt;
			const signals = proof.filter((mark) => mark["kind"] === "signal");
			expect(signals.map((mark) => mark["signal"])).toEqual([
				"SIGTERM",
				"SIGKILL",
			]);
			expect(proof).toContainEqual(
				expect.objectContaining({
					kind: "ignored-signal",
					signal: "SIGTERM",
					pid: first.pid,
				}),
			);
			expect(
				Number(signals[1]?.["at"]) - Number(signals[0]?.["at"]),
			).toBeGreaterThanOrEqual(2800);
			expect(() => process.kill(first.pid, 0)).toThrow();
			const resumed = await browser.send(sessionId, "d1-after-stop");
			expect(resumed.chunks.join("")).toBe(
				responseChunks("d1-after-stop").join(""),
			);
			expect(resumed.done["status"]).toBe("idle");
			const replacement = harness.marks
				.filter(
					(mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId,
				)
				.at(-1);
			assert(replacement?.kind === "runner-started");
			expect(replacement.pid).not.toBe(first.pid);
			const resumedQuery = harness.marks.find(
				(mark) => mark.kind === "query" && mark.pid === replacement.pid,
			);
			assert(resumedQuery?.kind === "query");
			expect(resumedQuery.sessionId).toBe(originalQuery.sessionId);
			const resumedOptions = harness
				.claudeOptions()
				.find(
					(options) =>
						options.pid === replacement.pid &&
						options.prompt === "d1-after-stop",
				);
			expect(resumedOptions?.resumeId).toBe(originalQuery.sessionId);
			evidence["replacementPid"] = replacement.pid;
			evidence["resumedNativeSessionId"] = resumedQuery.sessionId;
			evidence["resumeOption"] = resumedOptions?.resumeId;
			evidence["passed"] = true;
		} finally {
			try {
				await harness.dispose();
				evidence["cleanup"] = harness.proof();
			} finally {
				writeFileSync(
					join(artifactDir, "real-process-stop.json"),
					JSON.stringify(evidence, null, 2),
				);
			}
		}
	}, 120_000);
});
