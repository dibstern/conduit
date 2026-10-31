import { fork } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FiberSet } from "effect";
import { expect } from "vitest";
import { connectRunner } from "../../../src/lib/provider/runner/runner-connection.js";
import type { RunnerHello } from "../../../src/lib/provider/runner/runner-protocol.js";
import type { SessionCommand } from "../../../src/lib/provider/runner/session-runner.js";

// Completion receipts and late replies must keep one send attempt from answering another.
it.effect("runner hello and status keep completed send attempts separate", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-attempt-"))),
			(root) =>
				Effect.sync(() => rmSync(root, { recursive: true, force: true })),
		);
		const socketPath = join(root, "runner.sock");
		const proof = join(root, "proof.jsonl");
		writeFileSync(proof, "");
		const listening = yield* Deferred.make<void, unknown>();
		const child = yield* Effect.acquireRelease(
			Effect.sync(() => {
				const child = fork(
					fileURLToPath(
						new URL("../../helpers/runner-attempt-fixture.ts", import.meta.url),
					),
					[socketPath, "session", "runner"],
					{
						execArgv: [
							"--import",
							pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
						],
						env: {
							...process.env,
							HOME: root,
							NODE_ENV: "test",
							CONDUIT_TEST_RUNNER_IDLE_MS: "null",
							CONDUIT_TEST_PROCESS_PROOF: proof,
						},
						stdio: ["ignore", "ignore", "pipe", "ipc"],
					},
				);
				// Capture readiness in the spawn step before the test fiber can yield.
				child.once("message", () =>
					Deferred.doneUnsafe(listening, Effect.void),
				);
				child.once("error", (cause) =>
					Deferred.doneUnsafe(listening, Effect.fail(cause)),
				);
				child.once("exit", (code, signal) =>
					Deferred.doneUnsafe(
						listening,
						Effect.die(`Runner exited before listening: ${code ?? signal}`),
					),
				);
				return child;
			}),
			(child) =>
				Effect.callback<void>((resume) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resume(Effect.void);
						return;
					}
					child.once("exit", () => resume(Effect.void));
					child.kill("SIGTERM");
				}),
		);
		yield* Deferred.await(listening);
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		let hello: RunnerHello | undefined;
		const connect = connectRunner({
			socketPath,
			sessionId: "session",
			runnerId: "runner",
			driverKind: "claude",
			deps: { workspaceRoot: root, daemonConfigDir: root },
			runFork,
			emit: () => Effect.succeed({}),
			onHello: (message) =>
				Effect.sync(() => {
					hello = message;
				}),
			onClose: () => {},
		});
		let connection = yield* connect;
		expect(hello).toMatchObject({
			crossAttemptNativeResumeFallback: true,
			sendJournalAnswers: true,
			sendAnswers: [],
		});
		let detached = 0;
		const disconnect = Effect.callback<void>((resume) => {
			let finished = false;
			const check = () => {
				if (
					finished ||
					readFileSync(proof, "utf8").split('"kind":"runner-detached"').length -
						1 <=
						detached
				)
					return;
				finished = true;
				detached++;
				resume(Effect.void);
			};
			const watcher = watch(proof, check);
			connection.destroy();
			check();
			return Effect.sync(() => watcher.close());
		});

		yield* Effect.addFinalizer(() => Effect.sync(() => connection.destroy()));
		const send: Extract<SessionCommand, { type: "send-turn" }> = {
			type: "send-turn",
			sinkId: "send:1",
			aborted: false,
			input: {
				sessionId: "session",
				inputId: "input",
				prompt: "first",
				workspaceRoot: root,
				extraFolders: [],
				history: [],
				providerState: {},
				images: [],
			},
		};
		expect(yield* connection.commandEffect("send", send, 1)).toMatchObject({
			cost: 1,
		});
		expect(yield* connection.commandEffect("send", send, 1)).toMatchObject({
			cost: 1,
		});
		expect(
			yield* connection.commandEffect("send", { ...send, sinkId: "send:2" }, 2),
		).toMatchObject({ cost: 2 });
		expect(yield* connection.commandStatusEffect("send", 1)).toBe("completed");
		expect(yield* connection.commandStatusEffect("send", 2)).toBe("completed");
		expect(yield* connection.commandStatusEffect("send", 3)).toBe(
			"not_received",
		);
		let executing = yield* Deferred.make<void>();
		const onExecuting = (message: unknown) => {
			if (
				typeof message !== "object" ||
				message === null ||
				!("type" in message) ||
				message.type !== "executing"
			)
				return;
			child.off("message", onExecuting);
			runFork(Deferred.succeed(executing, undefined).pipe(Effect.asVoid));
		};
		child.on("message", onExecuting);
		const held = yield* connection
			.commandEffect(
				"send",
				{
					...send,
					sinkId: "send:3",
					input: { ...send.input, prompt: "held" },
				},
				3,
			)
			.pipe(Effect.forkChild);
		yield* Deferred.await(executing);
		expect(yield* connection.commandStatusEffect("send", 3)).toBe("running");
		expect(yield* connection.commandStatusEffect("send", 4)).toBe(
			"not_received",
		);
		yield* Fiber.interrupt(held);
		expect(
			yield* connection.commandEffect(
				"terminal-send",
				{ ...send, sinkId: "terminal-send:1" },
				1,
			),
		).toMatchObject({ status: "completed" });
		for (const status of ["accepted", "joined", "indeterminate"]) {
			expect(
				yield* connection.commandEffect(
					status,
					{
						...send,
						sinkId: `${status}:1`,
						input: { ...send.input, prompt: status },
					},
					1,
				),
			).toMatchObject({ status });
		}
		expect(
			yield* connection.commandEffect(
				"fallback",
				{
					...send,
					sinkId: "fallback:1",
					input: { ...send.input, prompt: "resume-rejected" },
				},
				1,
			),
		).toMatchObject({ nativeResumeRejected: true });

		// S7 increments the attempt; the real host must keep that fallback's identity.
		yield* connection.commandEffect(
			"requeued",
			{
				...send,
				sinkId: "requeued:1",
				input: { ...send.input, prompt: "resume-rejected" },
			},
			1,
		);
		yield* disconnect;
		connection = yield* connect;
		expect(hello?.sendAnswers).toContainEqual(
			expect.objectContaining({
				commandId: "requeued",
				attempt: 1,
				nativeResumeFallback: false,
				status: "finished",
			}),
		);
		const fresh = {
			...send,
			sinkId: "requeued:2:native-resume-fallback",
			input: { ...send.input, prompt: "fresh", nativeResumeFallback: true },
		};
		const freshResult = yield* connection.commandEffect("requeued", fresh, 2);
		expect(freshResult).toMatchObject({ status: "completed" });
		expect(yield* connection.commandEffect("requeued", fresh, 2)).toEqual(
			freshResult,
		);
		const repeatedFallback = yield* Effect.exit(
			connection.commandEffect(
				"requeued",
				{ ...fresh, sinkId: "requeued:3:native-resume-fallback" },
				3,
			),
		);
		expect(Exit.isFailure(repeatedFallback)).toBe(true);
		yield* disconnect;
		connection = yield* connect;
		expect(hello?.sendAnswers).toContainEqual(
			expect.objectContaining({
				commandId: "requeued",
				attempt: 2,
				nativeResumeFallback: true,
				status: "finished",
			}),
		);
		executing = yield* Deferred.make<void>();
		child.on("message", onExecuting);
		const fallback = yield* connection
			.commandEffect(
				"fallback",
				{
					...send,
					sinkId: "fallback:1:native-resume-fallback",
					input: { ...send.input, prompt: "held", nativeResumeFallback: true },
				},
				1,
			)
			.pipe(Effect.forkChild);
		yield* Deferred.await(executing);
		yield* Fiber.interrupt(fallback);
		yield* connection.commandEffect("control", {
			type: "interrupt",
			sessionId: "session",
		});
		expect(yield* connection.commandStatusEffect("control")).toBe("completed");
		yield* disconnect;
		connection = yield* connect;
		expect(hello?.sendAnswers).toContainEqual({
			commandId: "send",
			attempt: 3,
			nativeResumeFallback: false,
			status: "running",
		});
		for (const commandId of [
			"terminal-send",
			"accepted",
			"joined",
			"indeterminate",
		])
			expect(hello?.sendAnswers).toContainEqual(
				expect.objectContaining({
					commandId,
					attempt: 1,
					nativeResumeFallback: false,
					status: "finished",
				}),
			);
		expect(hello?.sendAnswers).toContainEqual({
			commandId: "fallback",
			attempt: 1,
			nativeResumeFallback: true,
			status: "running",
		});
		expect(
			hello?.completedCommands?.some(
				({ commandId }) => commandId === "fallback",
			),
		).toBe(false);
		expect(hello?.bindings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sinkId: "send:1",
					commandId: "send",
					attempt: 1,
				}),
				expect.objectContaining({
					sinkId: "send:2",
					commandId: "send",
					attempt: 2,
				}),
				expect.objectContaining({
					sinkId: "send:3",
					commandId: "send",
					attempt: 3,
				}),
				expect.objectContaining({
					sinkId: "fallback:1:native-resume-fallback",
					commandId: "fallback",
					attempt: 1,
				}),
			]),
		);
		expect(hello?.completedCommands).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					commandId: "send",
					attempt: 1,
					result: expect.objectContaining({ cost: 1 }),
				}),
				expect.objectContaining({
					commandId: "send",
					attempt: 2,
					result: expect.objectContaining({ cost: 2 }),
				}),
				expect.objectContaining({ commandId: "control", attempt: 0 }),
			]),
		);
	}),
);
