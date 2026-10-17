import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunnerSocket } from "../../../src/lib/provider/claude/claude-runner-protocol.js";
import type { SessionTurn } from "../../../src/lib/provider/runner/session-runner.js";
import { ProcessHarness } from "../../helpers/process-harness.js";

const TIMEOUT = 120_000;

function sdkProof(harness: ProcessHarness) {
	return readFileSync(join(harness.root, "sdk-proof.ndjson"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function stored(harness: ProcessHarness, sessionId: string) {
	const db = new Database(harness.daemonStorePath(), { readonly: true });
	try {
		return {
			commands: db
				.prepare(
					"SELECT command_id, payload_json, attempt_count, status FROM provider_command_outbox WHERE session_id = ? AND effect_type = 'send_turn' ORDER BY request_sequence",
				)
				.all(sessionId) as Array<{
				command_id: string;
				payload_json: string;
				attempt_count: number;
				status: string;
			}>,
			turns: db
				.prepare(
					"SELECT state FROM turns WHERE session_id = ? ORDER BY requested_at",
				)
				.all(sessionId) as Array<{ state: string }>,
			errors: db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error'",
				)
				.all(sessionId) as Array<{ data: string }>,
		};
	} finally {
		db.close();
	}
}

describe("runner host at-most-once delivery through Claude's process seam", () => {
	const harnesses: ProcessHarness[] = [];
	afterEach(async () => {
		for (const harness of harnesses) {
			await harness.dispose();
			expect(harness.remainingRunnerPids()).toEqual([]);
		}
		harnesses.length = 0;
	});

	it.each([false, true])(
		"does not resend a command after a crash during send, even when replayed to a new runner (partial journal: %s)",
		async (partialJournal) => {
			const harness = ProcessHarness.create({
				dist: "dist",
				restartProof: true,
			});
			harnesses.push(harness);
			await harness.restart({
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
			});
			const browser = await harness.connect();
			const sessionId = await browser.createSession("Crash during Claude send");
			const prompt = "fail-before-assistant-restart";
			const pending = browser
				.send(sessionId, prompt, TIMEOUT)
				.catch(() => undefined);
			await vi.waitFor(
				() => {
					expect(
						sdkProof(harness).some(
							(mark) => mark["kind"] === "pre-assistant-held",
						),
					).toBe(true);
				},
				{ timeout: TIMEOUT },
			);
			const original = harness.marks.find(
				(mark) => mark.kind === "runner-started",
			);
			if (original?.kind !== "runner-started")
				throw new Error("Missing owned runner");
			const command = stored(harness, sessionId).commands[0];
			if (!command) throw new Error("Missing admitted command");
			const journalDirectory = join(
				dirname(original.socketPath),
				"sends",
				sessionId,
			);
			const journal = readdirSync(journalDirectory)
				.map(
					(filename) =>
						JSON.parse(
							readFileSync(join(journalDirectory, filename), "utf8"),
						) as Record<string, unknown>,
				)
				.find((record) => record["commandId"] === command.command_id);
			expect(journal).toMatchObject({
				commandId: command.command_id,
				attempt: command.attempt_count,
				runnerPid: original.pid,
				startedAt: expect.any(Number),
			});
			expect(journal).not.toHaveProperty("completedAt");
			expect(stored(harness, sessionId).turns).toEqual([{ state: "running" }]);
			await harness.kill();
			await pending;
			process.kill(original.pid, "SIGKILL");
			await vi.waitFor(
				() => expect(() => process.kill(original.pid, 0)).toThrow(),
				{ timeout: 10_000 },
			);
			if (partialJournal) {
				const filename = readdirSync(journalDirectory).find(
					(file) =>
						(
							JSON.parse(
								readFileSync(join(journalDirectory, file), "utf8"),
							) as Record<string, unknown>
						)["commandId"] === command.command_id,
				);
				if (!filename) throw new Error("Missing admission fence");
				writeFileSync(join(journalDirectory, filename), "{");
			}
			await harness.restart({
				startupTimeoutMs: TIMEOUT,
				runnerStartupTimeoutMs: TIMEOUT,
			});
			const recovered = await harness.connect(sessionId);
			await vi.waitFor(
				() => {
					const state = stored(harness, sessionId);
					expect(state.commands.map(({ status }) => status)).toEqual([
						"failed",
					]);
					expect(state.turns).toEqual([{ state: "error" }]);
					expect(state.errors).toHaveLength(1);
				},
				{ timeout: 20_000 },
			);
			expect(
				sdkProof(harness).filter(
					(mark) => mark["kind"] === "enqueue" && mark["prompt"] === prompt,
				),
			).toHaveLength(1);
			await recovered.send(sessionId, "explicit-next-message", TIMEOUT);
			await vi.waitFor(
				() =>
					expect(
						harness.marks.some(
							(mark) =>
								mark.kind === "runner-started" && mark.pid !== original.pid,
						),
					).toBe(true),
				{ timeout: 20_000 },
			);
			const replacement = harness.marks
				.filter((mark) => mark.kind === "runner-started")
				.at(-1);
			if (replacement?.kind !== "runner-started")
				throw new Error("Missing replacement runner");
			expect(replacement.pid).not.toBe(original.pid);
			await harness.kill();
			let direct: ClaudeRunnerSocket | undefined;
			try {
				const greeted = new Promise<ClaudeRunnerSocket>((resolve, reject) => {
					const socket = createConnection(replacement.socketPath);
					const peer = new ClaudeRunnerSocket(
						socket,
						(message) => {
							if (message.type === "hello") resolve(peer);
						},
						(failure) => reject(new Error(failure.message)),
					);
					direct = peer;
					socket.once("connect", () =>
						peer.write({
							type: "hello",
							protocolVersion: replacement.protocolVersion,
							buildId: replacement.buildId,
							config: {
								workspaceRoot: harness.projectDir,
								daemonConfigDir: harness.configDir,
							},
						}),
					);
				});
				direct = await Effect.runPromise(
					Effect.tryPromise(() => greeted).pipe(Effect.timeout("15 seconds")),
				);
				const failures = [];
				for (let replay = 0; replay < 2; replay++) {
					const result = await Effect.runPromise(
						direct
							.commandEffect(
								command.command_id,
								{
									type: "send-turn",
									sinkId: `${command.command_id}:${command.attempt_count}`,
									aborted: false,
									input: {
										...(JSON.parse(command.payload_json) as SessionTurn),
										commandAttempt: command.attempt_count,
									},
								},
								command.attempt_count,
							)
							.pipe(Effect.either, Effect.timeout("15 seconds")),
					);
					expect(result).toMatchObject({
						_tag: "Left",
						left: { code: "runner_send_uncertain", retryable: false },
					});
					failures.push(result);
				}
				expect(
					sdkProof(harness).filter(
						(mark) => mark["kind"] === "enqueue" && mark["prompt"] === prompt,
					),
				).toHaveLength(1);
				mkdirSync("test-results", { recursive: true });
				writeFileSync(
					partialJournal
						? "test-results/xqsg-6-claude-at-most-once-partial.json"
						: "test-results/xqsg-6-claude-at-most-once.json",
					JSON.stringify(
						{
							original,
							replacement,
							command,
							journal,
							partialJournal,
							failures,
							stored: stored(harness, sessionId),
							sdk: sdkProof(harness),
						},
						null,
						2,
					),
				);
			} finally {
				direct?.destroy();
			}
		},
		TIMEOUT * 3,
	);
});
