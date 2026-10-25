import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

// Failure cases: queued readiness loses to an overdue timer; a never-ready
// runner is accepted or leaks; EPERM hides a timeout or a late exit logs twice;
// a failed new runner kills an adopted runner.
describe("built runner startup deadlines", () => {
	it.each([
		"queued",
		"never",
		"eperm",
	] as const)("handles %s readiness after adopting a surviving runner", async (mode) => {
		const evidence: Record<string, unknown> = { mode, passed: false };
		let harness: ProcessHarness | undefined;
		try {
			harness = await ProcessHarness.start({
				dist: "dist",
				restartProof: true,
			});
			let browser = await harness.connect();
			const retainedSession = await browser.createSession("Retained runner");
			await browser.send(retainedSession, "before-startup-race");
			const retained = harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (retained?.kind !== "runner-started")
				throw new Error("Missing retained runner");
			evidence["retainedPid"] = retained.pid;
			await harness.kill();
			appendFileSync(
				join(harness.root, "runner-identity-fixture.mjs"),
				`\nimport { installRunnerStartupFixture } from ${JSON.stringify(new URL("../../helpers/runner-startup-fixture.ts", import.meta.url).href)};\ninstallRunnerStartupFixture(${JSON.stringify(harness.root)});\n`,
			);
			await harness.restart({ runnerStartupTimeoutMs: 3000 });
			browser = await harness.connect(retainedSession);
			expect(
				harness.marks.filter((mark) => mark.kind === "runner-started").at(-1),
			).toMatchObject({ pid: retained.pid });
			const sessionId = await browser.createSession("Startup deadline");
			writeFileSync(join(harness.root, "runner-startup-gate"), mode);
			const turn = await browser.send(sessionId, "startup-deadline-turn");
			evidence["turn"] = turn;
			evidence["parentOutcome"] =
				turn.done["attention"] === "error" ? "turn-failed" : "turn-completed";
			const proof = () =>
				readFileSync(
					join(harness?.root ?? "", "runner-startup-evidence.jsonl"),
					"utf8",
				)
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line) as Record<string, unknown>);
			const deadline = proof().find(
				(mark) => mark["kind"] === "parent-deadline",
			);
			if (
				!deadline ||
				typeof deadline["deadline"] !== "number" ||
				typeof deadline["startedAt"] !== "number" ||
				typeof deadline["childPid"] !== "number"
			)
				throw new Error("Missing deadline proof");
			evidence["deadline"] = deadline;
			expect(
				proof().find((mark) => mark["kind"] === "child-ready")?.["at"],
			).toBeLessThanOrEqual(deadline["startedAt"]);
			const childPid = deadline["childPid"];
			if (mode === "queued") {
				const sent = proof().find((mark) => mark["kind"] === "child-sent");
				const blocked = proof().find(
					(mark) => mark["kind"] === "parent-blocked",
				);
				const unblocked = proof().find(
					(mark) => mark["kind"] === "parent-unblocked",
				);
				expect(sent?.["error"]).toBeNull();
				expect(sent?.["at"]).toBeLessThan(deadline["deadline"]);
				expect(blocked?.["at"]).toBeLessThanOrEqual(sent?.["at"] as number);
				expect(unblocked?.["at"]).toBeGreaterThan(deadline["deadline"]);
				expect(turn.chunks.join("")).toBe(
					responseChunks("startup-deadline-turn").join(""),
				);
				expect(turn.done["status"]).toBe("idle");
				expect(() => process.kill(childPid, 0)).not.toThrow();
				expect(
					harness.marks.find(
						(mark) => mark.kind === "runner-started" && mark.pid === childPid,
					),
				).toBeDefined();
				expect(
					proof().filter((mark) => mark["kind"] === "parent-kill"),
				).toEqual([]);
				expect(
					proof().filter((mark) => mark["kind"] === "parent-exit"),
				).toEqual([]);
				expect(
					proof().find((mark) => mark["kind"] === "parent-received")?.["at"],
				).toBeGreaterThan(deadline["deadline"]);
			} else {
				expect(turn.done["attention"]).toBe("error");
				expect(turn.chunks).toEqual([]);
				if (mode === "eperm") {
					expect(() => process.kill(childPid, 0)).not.toThrow();
					expect(
						proof().find((mark) => mark["kind"] === "parent-exit"),
					).toBeUndefined();
					expect(
						proof().find((mark) => mark["kind"] === "parent-kill"),
					).toMatchObject({ childPid, error: "EPERM" });
				} else {
					await vi.waitFor(
						() =>
							expect(
								proof().find((mark) => mark["kind"] === "parent-exit"),
							).toBeDefined(),
						{ timeout: 5000 },
					);
					expect(() => process.kill(childPid, 0)).toThrow();
				}
				expect(
					proof().some(
						(mark) =>
							mark["kind"] === "parent-kill" &&
							mark["childPid"] === deadline["childPid"],
					),
				).toBe(true);
				expect(proof().some((mark) => mark["kind"] === "parent-received")).toBe(
					false,
				);
				expect(proof().some((mark) => mark["kind"] === "child-ready")).toBe(
					true,
				);
				expect(proof().some((mark) => mark["kind"] === "child-sent")).toBe(
					false,
				);
				await vi.waitFor(
					() =>
						expect(harness?.logTail).toMatch(
							/Runner startup timed out.*elapsedMs=\d+.*readinessLate=false.*exitCode=.*signal=/,
						),
					{ timeout: 5000 },
				);
				const timeoutLines = harness.logTail
					.split("\n")
					.filter((line) => line.includes("Runner startup timed out"));
				expect(timeoutLines).toHaveLength(1);
				const line = timeoutLines[0] ?? "";
				const exit = proof().find((mark) => mark["kind"] === "parent-exit");
				if (mode === "eperm") {
					expect(line).toContain("exited=false");
					expect(line).toContain("exitCode=not-exited signal=not-exited");
				} else {
					expect(line).toContain(
						`exitCode=${exit?.["exitCode"]} signal=${exit?.["signal"]}`,
					);
				}
				expect(line).toContain("readinessReceivedAfterMs=none");
				expect(
					Number(line.match(/elapsedMs=(\d+)/)?.[1]),
				).toBeGreaterThanOrEqual(3000);
			}
			expect(() => process.kill(retained.pid, 0)).not.toThrow();
			const retainedTurn = await browser.send(
				retainedSession,
				"retained-after-startup",
			);
			expect(retainedTurn.chunks.join("")).toBe(
				responseChunks("retained-after-startup").join(""),
			);
			evidence["retainedTurn"] = retainedTurn;
			evidence["passed"] = true;
		} finally {
			try {
				if (harness) {
					const path = join(harness.root, "runner-startup-evidence.jsonl");
					const observations = existsSync(path)
						? readFileSync(path, "utf8")
								.trim()
								.split("\n")
								.map((line) => JSON.parse(line) as Record<string, unknown>)
						: [];
					evidence["observations"] = observations;
					evidence["logTail"] = harness.logTail;
					evidence["remainingBeforeCleanup"] = harness.remainingRunnerPids();
					const exit = observations.find(
						(mark) => mark["kind"] === "parent-exit",
					);
					evidence["exitCode"] = exit?.["exitCode"] ?? null;
					evidence["signal"] = exit?.["signal"] ?? null;
					try {
						const childPid = observations.find(
							(mark) => mark["kind"] === "parent-deadline",
						)?.["childPid"];
						if (
							mode === "eperm" &&
							typeof childPid === "number" &&
							harness.remainingRunnerPids().includes(childPid)
						) {
							process.kill(childPid, "SIGKILL");
							await vi.waitFor(
								() =>
									expect(readFileSync(path, "utf8")).toContain(
										'"kind":"parent-exit"',
									),
								{ timeout: 5000 },
							);
							evidence["lateExitObserved"] = true;
						}
					} finally {
						await harness.dispose();
					}
					evidence["remainingAfterCleanup"] = harness.remainingRunnerPids();
					if (mode === "eperm") {
						evidence["logTailAfterLateExit"] = harness.logTail;
						expect(
							harness.logTail
								.split("\n")
								.filter((line) => line.includes("Runner startup timed out")),
						).toHaveLength(1);
					}
				}
			} finally {
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					`test-results/8xkg-startup-${mode}.json`,
					JSON.stringify(evidence, null, 2),
				);
			}
		}
	}, 45_000);
});
