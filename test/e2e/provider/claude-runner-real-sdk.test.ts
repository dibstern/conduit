/**
 * Uses the default build, a runner child and the existing Claude login.
 *
 * pnpm build
 * RUN_EXPENSIVE_E2E=1 npx --no-install vitest run --config vitest.e2e.config.ts \
 *   test/e2e/provider/claude-runner-real-sdk.test.ts
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeRunnerRegistration } from "../../../src/lib/provider/claude/claude-runner-registry.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const RUN_EXPENSIVE = process.env["RUN_EXPENSIVE_E2E"] === "1";

describe.skipIf(!RUN_EXPENSIVE)("Claude process runner E2E (real SDK)", () => {
	it(
		"completes a real turn in a child of the default build",
		async () => {
			const evidence = {
				ticket: "conduit-test-85kb.15",
				at: new Date().toISOString(),
				dist: resolve("dist"),
				model: "claude-haiku-4-5",
				prompt: "Reply with exactly: hello world",
				turnCompleted: false,
				serverPid: null as number | null,
				runnerPid: null as number | null,
				sessionId: null as string | null,
				text: "",
				runnerCursor: null as number | null,
				timings: {
					// Spawn is observed through server IPC at a 10 ms polling interval.
					// Its origin is session open; the first text delta and turn end use send start.
					runnerSpawnMs: null as number | null,
					firstEventMs: null as number | null,
					turnEndMs: null as number | null,
				},
				remainingRunnerPids: [] as number[],
			};
			let harness: ProcessHarness | undefined;
			let observer: ReturnType<typeof setInterval> | undefined;
			try {
				harness = await ProcessHarness.start({ dist: "dist", realSdk: true });
				const server = harness.generations[0];
				if (!server) throw new Error("Missing server PID proof");
				evidence.serverPid = server.pid;
				const browser = await harness.connect();
				await Effect.runPromise(
					browser.rpc
						.SetDefaultModel({
							projectSlug: "process-test",
							provider: "claude",
							model: evidence.model,
						})
						.pipe(Effect.timeout(15_000)),
				);
				const sessionOpenAt = process.hrtime.bigint();
				const activeHarness = harness;
				observer = setInterval(() => {
					if (
						evidence.timings.runnerSpawnMs === null &&
						activeHarness.marks.some((mark) => mark.kind === "runner-spawned")
					) {
						evidence.timings.runnerSpawnMs =
							Number(process.hrtime.bigint() - sessionOpenAt) / 1e6;
					}
				}, 10);
				const sessionId = await browser.createSession("Real SDK runner smoke");
				evidence.sessionId = sessionId;
				const cursor = browser.frames.length;
				const sendAt = process.hrtime.bigint();
				await Effect.runPromise(
					browser.rpc
						.SendMessage({
							projectSlug: "process-test",
							sessionId,
							originId: browser.originId,
							commandId: randomUUID(),
							text: evidence.prompt,
						})
						.pipe(Effect.timeout(15_000)),
				);
				await vi.waitFor(
					() =>
						expect(
							browser.frames
								.slice(cursor)
								.some(
									({ message }) =>
										message["type"] === "done" &&
										message["sessionId"] === sessionId,
								),
						).toBe(true),
					{ timeout: 120_000, interval: 50 },
				);
				const frames = browser.frames
					.slice(cursor)
					.filter(({ message }) => message["sessionId"] === sessionId);
				const deltas = frames.filter(
					({ message }) => message["type"] === "delta",
				);
				const firstEvent = deltas[0];
				const turnEnd = frames.find(
					({ message }) => message["type"] === "done",
				);
				if (!firstEvent || !turnEnd)
					throw new Error("Missing text or turn end");
				evidence.timings.firstEventMs = Number(firstEvent.at - sendAt) / 1e6;
				evidence.timings.turnEndMs = Number(turnEnd.at - sendAt) / 1e6;
				evidence.text = deltas
					.map(({ message }) => String(message["text"]))
					.join("");
				expect(evidence.text.trim()).toBe("hello world");
				expect(turnEnd.message["code"]).toBe(0);
				const runner = harness.marks.find(
					(mark) =>
						mark.kind === "runner-started" && mark.sessionId === sessionId,
				);
				if (runner?.kind !== "runner-started")
					throw new Error("Missing runner PID proof");
				evidence.runnerPid = runner.pid;
				expect(runner.pid).not.toBe(server.pid);
				expect(runner.pid).not.toBe(process.pid);
				expect(evidence.timings.runnerSpawnMs).not.toBeNull();
				const registration = JSON.parse(
					readFileSync(`${runner.socketPath}.json`, "utf8"),
				) as ClaudeRunnerRegistration;
				expect(registration).toMatchObject({ sessionId, pid: runner.pid });
				const db = new Database(
					join(harness.projectDir, ".conduit/events.db"),
					{
						readonly: true,
					},
				);
				try {
					const checkpoint = db
						.prepare(
							"SELECT sequence FROM claude_runner_cursors WHERE runner_id = ?",
						)
						.get(registration.runnerId) as { sequence: number } | undefined;
					expect(checkpoint?.sequence).toBeGreaterThan(0);
					evidence.runnerCursor = checkpoint?.sequence ?? null;
					await vi.waitFor(() => {
						const command = db
							.prepare(
								"SELECT status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn'",
							)
							.get(sessionId) as { status: string } | undefined;
						expect(command?.status).toBe("completed");
					});
				} finally {
					db.close();
				}
				evidence.turnCompleted = true;
			} finally {
				clearInterval(observer);
				try {
					await harness?.dispose();
				} finally {
					evidence.remainingRunnerPids = harness?.remainingRunnerPids() ?? [];
					mkdirSync("test-results", { recursive: true });
					writeFileSync(
						"test-results/85kb-15-real-sdk.json",
						JSON.stringify(evidence, null, 2),
					);
					expect(evidence.remainingRunnerPids).toEqual([]);
				}
			}
		},
		{ timeout: 150_000 },
	);
});
