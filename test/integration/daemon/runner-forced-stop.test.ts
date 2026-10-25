import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
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
    if (signal === "SIGKILL" && d1Selected(pid) && JSON.parse(readFileSync(d1Selection, "utf8")).surviveSigkill) return true;
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
}

function cursor(harness: ProcessHarness, runnerId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return db
			.prepare(
				"SELECT sequence, attachment_id, retired_at, pid, start_time, owned_run_ids FROM claude_runner_cursors WHERE runner_id = ?",
			)
			.get(runnerId) as
			| {
					sequence: number;
					attachment_id: string;
					retired_at: number | null;
					pid: number | null;
					start_time: string | null;
					owned_run_ids: string;
			  }
			| undefined;
	} finally {
		db.close();
	}
}

describe("runner forced stop with real processes", () => {
	it("SIGKILLs a SIGTERM-ignoring runner and resumes the same native conversation", async () => {
		const artifactPath = join(
			mkdtempSync(join(tmpdir(), "conduit-r1-stop-artifact-")),
			"real-process-stop.json",
		);
		const evidence: Record<string, unknown> = { passed: false };
		const harness = ProcessHarness.create({
			dist: "dist",
			deadline: performance.now() + 100_000,
		});
		try {
			installForcedStopFixture(harness);
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
			const stoppedCursor = cursor(harness, basename(first.socketPath));
			evidence["retired_at"] = stoppedCursor?.retired_at ?? null;
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
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
				process.stdout.write(`R1 forced-stop artifact: ${artifactPath}\n`);
			}
		}
	}, 120_000);

	it("does not adopt or replay a surviving retired runner after daemon restart", async () => {
		const artifactPath = join(
			mkdtempSync(join(tmpdir(), "conduit-r1-restart-artifact-")),
			"retired-runner-restart.json",
		);
		const evidence: Record<string, unknown> = { passed: false };
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
			await pending;
			const stopCompletedAt = Date.now();
			evidence["stopStartedAt"] = stopStartedAt;
			evidence["stopCompletedAt"] = stopCompletedAt;
			evidence["signals"] = readFileSync(
				join(harness.root, "d1-stop-proof.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			expect(() => process.kill(first.pid, 0)).not.toThrow();
			await vi.waitFor(
				() => {
					const row = cursor(harness, runnerId);
					expect(row?.retired_at).toEqual(expect.any(Number));
					expect(row?.attachment_id).toBe("");
				},
				{ timeout: harness.remainingTimeMs(10_000) },
			);
			const retired = cursor(harness, runnerId);
			assert(retired);
			expect(retired.pid).toBe(first.pid);
			expect(retired.start_time).toEqual(expect.any(String));
			evidence["retired_at"] = retired.retired_at;
			evidence["retiredCursor"] = retired;
			await harness.kill();
			evidence["daemonKilledAt"] = Date.now();
			writeFileSync(join(harness.root, "release-upgrade-turn"), "release");
			const lateText = responseChunks("upgrade-long-turn")[2];
			assert(lateText);
			await vi.waitFor(
				() =>
					expect(readFileSync(`${first.socketPath}.spool`, "utf8")).toContain(
						lateText,
					),
				{ timeout: harness.remainingTimeMs(10_000) },
			);
			evidence["spooledLateOutput"] = readFileSync(
				`${first.socketPath}.spool`,
				"utf8",
			);
			await harness.restart();
			evidence["daemonRestartedAt"] = Date.now();
			browser = await harness.connect(sessionId);
			expect(() => process.kill(first.pid, 0)).not.toThrow();
			expect(cursor(harness, runnerId)).toEqual(retired);
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
			expect(cursor(harness, runnerId)).toEqual(retired);
			evidence["replacementPid"] = replacement.pid;
			evidence["resumedNativeSessionId"] = resumedQuery.sessionId;
			evidence["cursorAfterRestart"] = cursor(harness, runnerId);
			evidence["passed"] = true;
		} finally {
			try {
				await harness.dispose();
				evidence["cleanup"] = harness.proof();
			} finally {
				writeFileSync(artifactPath, JSON.stringify(evidence, null, 2));
				process.stdout.write(`R1 retired-restart artifact: ${artifactPath}\n`);
			}
		}
	}, 120_000);
});
