import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessHarness } from "../../helpers/process-harness.js";

interface ConfigRead {
	pid: number;
	api: string;
	writer: boolean;
	nextTurn: boolean;
	stack: string;
}

// A save or runner idle check rereads config; a busy runner settles mid-turn;
// the next turn retains the old policy or cannot replace an idle-exited runner.
describe("daemon config memory", () => {
	let harness: ProcessHarness | undefined;
	let evidence: Record<string, unknown> = {};
	let probePath: string | undefined;
	const reads = (): ConfigRead[] =>
		probePath && existsSync(probePath)
			? readFileSync(probePath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as ConfigRead)
			: [];

	afterEach(async ({ task }) => {
		if (!harness) return;
		const fixture = harness;
		const observedReads = reads();
		writeFileSync(join(fixture.root, "release-upgrade-turn"), "cleanup");
		try {
			await fixture.dispose();
			expect(fixture.remainingRunnerPids()).toEqual([]);
		} finally {
			mkdirSync("test-results", { recursive: true });
			writeFileSync(
				"test-results/82tn-18-config-memory.json",
				JSON.stringify(
					{
						bead: "conduit-test-82tn.18",
						name: task.name,
						result: task.result?.state,
						failures: task.result?.errors?.map(({ message }) => message),
						...evidence,
						configReads: observedReads,
						readCounts: {
							readers: observedReads.filter(({ writer }) => !writer).length,
							writerValidation: observedReads.filter(({ writer }) => writer)
								.length,
							nextTurnReaders: observedReads.filter(
								({ writer, nextTurn }) => !writer && nextTurn,
							).length,
							nextTurnWriterValidation: observedReads.filter(
								({ writer, nextTurn }) => writer && nextTurn,
							).length,
						},
						cleanup: fixture.proof(),
						remainingRunnerPids: fixture.remainingRunnerPids(),
					},
					null,
					2,
				),
			);
			harness = undefined;
			probePath = undefined;
			evidence = {};
		}
	});

	it("saves an idle setting for the next turn without runtime config reloads", async () => {
		const fixture = ProcessHarness.create({
			restartProof: true,
			runnerLifecycle: { idleDayMs: 500 },
		});
		harness = fixture;
		const configPath = join(fixture.configDir, "daemon.json");
		const startedPath = join(fixture.root, "config-memory-started");
		const nextTurnPath = join(fixture.root, "config-memory-next-turn");
		const activeProbesPath = join(fixture.root, "config-memory-probes.ndjson");
		probePath = join(fixture.root, "config-memory-reads.ndjson");
		const preloadPath = join(fixture.root, "config-memory-probe.mjs");
		writeFileSync(
			preloadPath,
			`import fs from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
const configPath = ${JSON.stringify(configPath)};
const startedPath = ${JSON.stringify(startedPath)};
const nextTurnPath = ${JSON.stringify(nextTurnPath)};
const probePath = ${JSON.stringify(probePath)};
const append = fs.appendFileSync;
append(${JSON.stringify(activeProbesPath)}, process.pid + "\\n");
for (const [owner, key] of [[fs, "readFileSync"], [fs, "readFile"], [promises, "readFile"]]) {
  const original = owner[key];
  owner[key] = function (...args) {
    if (String(args[0]) === configPath && fs.existsSync(startedPath)) {
      const stack = new Error().stack ?? "";
      append(probePath, JSON.stringify({ pid: process.pid, api: key, writer: stack.includes("config-persistence-layer"), nextTurn: fs.existsSync(nextTurnPath), stack }) + "\\n");
    }
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
`,
		);
		await fixture.restart({
			startupTimeoutMs: 60_000,
			serviceEnvironment: { NODE_OPTIONS: `--import=${preloadPath}` },
		});
		writeFileSync(startedPath, "ready");
		const browser = await fixture.connect();
		await browser.setAutoSettle(null);
		const sessionId = await browser.createSession("Config memory idle policy");
		const held = browser.send(sessionId, "upgrade-long-turn", 60_000);
		// Attach rejection handling while assertions control the held turn.
		void held.catch(() => undefined);
		await fixture.waitForMark((mark) => mark.kind === "assistant-held");
		const first = await fixture.waitForMark(
			(mark) => mark.kind === "runner-started" && mark.sessionId === sessionId,
		);
		if (first.kind !== "runner-started")
			throw new Error("Missing first runner");
		await browser.setAutoSettle(1);
		const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
			autoSettleAfterDays: number | null;
		};
		expect(saved.autoSettleAfterDays).toBe(1);
		await new Promise<void>((done) => setTimeout(done, 1200));
		expect(() => process.kill(first.pid, 0)).not.toThrow();
		expect(
			fixture.marks.some(
				(mark) =>
					mark.kind === "runner-idle-exit-started" && mark.pid === first.pid,
			),
		).toBe(false);
		writeFileSync(join(fixture.root, "release-upgrade-turn"), "release");
		expect((await held).done["status"]).toBe("idle");
		await new Promise<void>((done) => setTimeout(done, 1200));
		const retainedOriginalRunner = existsSync(first.socketPath);
		expect.soft(retainedOriginalRunner).toBe(true);
		writeFileSync(nextTurnPath, "next turn");
		const next = await browser.send(
			sessionId,
			"after-config-memory-save",
			30_000,
		);
		expect(next.done["status"]).toBe("idle");
		const nextRunner = fixture.marks
			.filter(
				(mark) =>
					mark.kind === "runner-started" && mark.sessionId === sessionId,
			)
			.at(-1);
		if (nextRunner?.kind !== "runner-started")
			throw new Error("Missing next-turn runner");
		expect.soft(nextRunner.pid).toBe(first.pid);
		await vi.waitFor(
			() => expect(() => process.kill(nextRunner.pid, 0)).toThrow(),
			{ timeout: 10_000 },
		);
		const activeProbePids = readFileSync(activeProbesPath, "utf8")
			.trim()
			.split("\n")
			.map(Number);
		expect(activeProbePids).toContain(fixture.proof().generations.at(-1)?.pid);
		expect(activeProbePids).toContain(first.pid);
		expect(activeProbePids).toContain(nextRunner.pid);
		evidence = {
			sessionId,
			savedAutoSettleAfterDays: saved.autoSettleAfterDays,
			firstRunner: first,
			nextRunner,
			activeProbePids,
			busyRunnerSurvivedSettingChange: true,
			inFlightTurnRetainedDisabledIdlePolicy: retainedOriginalRunner,
			nextTurnUsedSavedIdlePolicy: true,
		};
		expect.soft(reads().filter(({ writer }) => !writer)).toHaveLength(0);
		expect(
			reads().filter(({ writer, nextTurn }) => !writer && nextTurn),
		).toHaveLength(0);
	}, 90_000);
});
