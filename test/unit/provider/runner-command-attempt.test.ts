import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, FiberSet } from "effect";
import { expect } from "vitest";
import {
	type RunnerMessage,
	RunnerSocket,
	sendToken,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";

for (const phase of ["newer-attempt", "fallback"] as const)
	it.effect(
		`S7round2 an old transmission's reply cannot answer a ${phase} send`,
		() =>
			Effect.gen(function* () {
				const root = yield* Effect.acquireRelease(
					Effect.sync(() =>
						mkdtempSync(join(tmpdir(), "runner-reply-attempt-")),
					),
					(root) =>
						Effect.sync(() => rmSync(root, { recursive: true, force: true })),
				);
				const received = yield* Deferred.make<RunnerMessage>();
				const runFork = yield* FiberSet.makeRuntime<never, void, never>();
				let peer: RunnerSocket | undefined;
				const server = yield* Effect.acquireRelease(
					Effect.sync(() =>
						createServer((socket) => {
							peer = new RunnerSocket(
								socket,
								(message) => {
									if (message.type === "command")
										runFork(
											Deferred.succeed(received, message).pipe(Effect.asVoid),
										);
								},
								() => {},
							);
						}),
					),
					(server) =>
						Effect.callback<void>((resume) => {
							peer?.destroy();
							server.close(() => resume(Effect.void));
						}),
				);
				const path = join(root, "runner.sock");
				yield* Effect.callback<void>((resume) => {
					server.listen(path, () => resume(Effect.void));
				});
				const connection = yield* Effect.acquireRelease(
					Effect.callback<RunnerSocket>((resume) => {
						const socket = createConnection(path, () =>
							resume(
								Effect.succeed(
									new RunnerSocket(
										socket,
										() => {},
										() => {},
									),
								),
							),
						);
					}),
					(connection) => Effect.sync(() => connection.destroy()),
				);
				// A fresh fallback is a new transmission, so each phase sends its own token.
				const previous = sendToken("hold", "send", 1);
				const current = sendToken("hold", "send", 2);
				const send = yield* connection
					.commandEffect(current, {
						type: "send-turn",
						sinkId: current,
						aborted: false,
						input: {
							sessionId: "session",
							inputId: "input",
							prompt: "first",
							nativeResumeFallback: phase === "fallback",
							workspaceRoot: root,
							extraFolders: [],
							history: [],
							providerState: {},
							images: [],
						},
					})
					.pipe(Effect.forkChild);
				expect(yield* Deferred.await(received)).toMatchObject({
					commandId: current,
					command: { mode: phase === "fallback" ? "fresh" : "resume" },
				});
				peer?.write({
					type: "command-reply",
					commandId: previous,
					failure: { operation: "old attempt", message: "stale" },
				});
				peer?.write({ type: "command-reply", commandId: current });
				expect(yield* Fiber.join(send)).toBeUndefined();
			}),
	);

const rejected = {
	status: "error",
	nativeResumeRejected: true,
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
} satisfies import("../../../src/lib/provider/types.js").TurnResult;

it.effect(
	"S10 journal answers use process call ownership and retained outcomes",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "journal-answers-"))),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const journal = new RunnerSendJournal(root, "s", "claude");
			const entered = yield* Deferred.make<void>();
			const outbox = sendToken("tx", "outbox-command", 2);
			const call = yield* journal
				.execute(
					outbox,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			expect(journal.answers).toEqual([{ token: outbox, status: "running" }]);
			// A second journal inherits the same PID on disk, but owns no call.
			const successor = new RunnerSendJournal(root, "s", "claude");
			expect(successor.answers).toEqual([
				{ token: outbox, status: "uncertain" },
			]);
			let deliveries = 0;
			const replay = yield* Effect.exit(
				successor.execute(
					outbox,
					Effect.sync(() => {
						deliveries++;
						return undefined;
					}),
				),
			);
			expect(Exit.isFailure(replay)).toBe(true);
			expect(deliveries).toBe(0);
			yield* Fiber.interrupt(call);
			expect(journal.answers).toEqual(successor.answers);
			const finishedVoid = sendToken("tx", "finished-void", 3);
			yield* journal.execute(finishedVoid, Effect.succeed(undefined));
			const failure = {
				operation: "send-turn",
				code: "rejected",
				message: "Rejected",
			};
			const finishedFailure = sendToken("tx", "finished-failure", 4);
			yield* Effect.exit(
				journal.execute(finishedFailure, Effect.fail(failure)),
			);
			// A rejected resume and its fresh fallback are two transmissions.
			const primary = sendToken("hold", "fallback", 1);
			const fallback = sendToken("hold", "fallback", 2);
			yield* journal.execute(primary, Effect.succeed(rejected));
			yield* journal.execute(fallback, Effect.succeed(rejected));
			expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual(
				expect.arrayContaining([
					{ token: finishedVoid, status: "finished" },
					{ token: finishedFailure, status: "finished", failure },
					{ token: primary, status: "finished", result: rejected },
					{ token: fallback, status: "finished", result: rejected },
				]),
			);
		}),
);

it.effect(
	"S10 a fresh fallback after a rejected resume is answered by its own token",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() =>
					mkdtempSync(join(tmpdir(), "journal-fallback-answer-")),
				),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const journal = new RunnerSendJournal(root, "s", "claude");
			const primary = sendToken("hold", "send", 1);
			const fallbackToken = sendToken("hold", "send", 2);
			yield* journal.execute(primary, Effect.succeed(rejected));
			const entered = yield* Deferred.make<void>();
			const finish = yield* Deferred.make<typeof rejected>();
			const fallback = yield* journal
				.execute(
					fallbackToken,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Deferred.await(finish)),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			const settledPrimary = {
				token: primary,
				status: "finished",
				result: rejected,
			};
			expect(journal.answers).toEqual(
				expect.arrayContaining([
					settledPrimary,
					{ token: fallbackToken, status: "running" },
				]),
			);
			expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual(
				expect.arrayContaining([
					settledPrimary,
					{ token: fallbackToken, status: "uncertain" },
				]),
			);
			yield* Deferred.succeed(finish, rejected);
			yield* Fiber.join(fallback);
			expect(journal.answers).toEqual(
				expect.arrayContaining([
					settledPrimary,
					{ token: fallbackToken, status: "finished", result: rejected },
				]),
			);
			expect(journal.answers).toHaveLength(2);
			expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual(
				expect.arrayContaining([...journal.answers]),
			);
		}),
);

it.effect("S10 failed completion persistence clears the owning call", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() => mkdtempSync(join(tmpdir(), "journal-write-failure-"))),
			(root) =>
				Effect.sync(() => rmSync(root, { recursive: true, force: true })),
		);
		const journal = new RunnerSendJournal(root, "s", "claude");
		const directory = join(root, "sends", "s");
		const moved = `${directory}-held`;
		const token = sendToken("hold", "send", 1);
		const outcome = yield* Effect.exit(
			journal.execute(
				token,
				Effect.sync(() => {
					renameSync(directory, moved);
					return undefined;
				}),
			),
		);
		renameSync(moved, directory);
		expect(Exit.isFailure(outcome)).toBe(true);
		expect(journal.answers).toEqual([{ token, status: "uncertain" }]);
	}),
);

it.effect(
	"S10 unreadable retained records reject a complete recovery snapshot",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "journal-corrupt-"))),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const token = sendToken("hold", "send", 1);
			yield* new RunnerSendJournal(root, "s", "claude").execute(
				token,
				Effect.succeed(undefined),
			);
			const directory = join(root, "sends", "s");
			for (const content of ["{", JSON.stringify({ token })]) {
				for (const name of readdirSync(directory))
					writeFileSync(join(directory, name), content);
				const failure = yield* Effect.try({
					try: () => new RunnerSendJournal(root, "s", "claude"),
					catch: (cause) => cause,
				}).pipe(Effect.flip);
				expect(failure).toMatchObject({ _tag: "RunnerSendJournalReadError" });
			}
			for (const name of readdirSync(directory)) {
				const filename = join(directory, name);
				chmodSync(filename, 0);
				const failure = yield* Effect.try({
					try: () => new RunnerSendJournal(root, "s", "claude"),
					catch: (cause) => cause,
				}).pipe(
					Effect.flip,
					Effect.ensuring(Effect.sync(() => chmodSync(filename, 0o600))),
				);
				expect(failure).toMatchObject({ _tag: "RunnerSendJournalReadError" });
			}
		}),
);

it.effect(
	"S7round2 journal delivers a fresh fallback transmission exactly once",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "requeued-journal-"))),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const journal = new RunnerSendJournal(root, "s", "claude");
			const completed = {
				...rejected,
				status: "completed",
				nativeResumeRejected: false,
			} satisfies import("../../../src/lib/provider/types.js").TurnResult;
			yield* journal.execute(
				sendToken("hold", "requeued", 1),
				Effect.succeed(rejected),
			);
			let deliveries = 0;
			const deliver = Effect.sync(() => {
				deliveries++;
				return completed;
			});
			const fallback = sendToken("hold", "requeued", 2);
			expect(yield* journal.execute(fallback, deliver)).toEqual(completed);
			expect(yield* journal.execute(fallback, deliver)).toEqual(completed);
			expect(
				yield* new RunnerSendJournal(root, "s", "claude").execute(
					fallback,
					deliver,
				),
			).toEqual(completed);
			expect(deliveries).toBe(1);
		}),
);
