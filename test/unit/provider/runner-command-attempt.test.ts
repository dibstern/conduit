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
import { RunnerSocket } from "../../../src/lib/provider/runner/runner-protocol.js";
import { RunnerSendJournal } from "../../../src/lib/provider/runner/runner-send-journal.js";

for (const phase of ["newer-attempt", "fallback"] as const)
	it.effect(`S7round2 an old primary reply cannot answer a ${phase} send`, () =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "runner-reply-attempt-"))),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const received = yield* Deferred.make<void>();
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
										Deferred.succeed(received, undefined).pipe(Effect.asVoid),
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
			const send = yield* connection
				.commandEffect(
					"send",
					{
						type: "send-turn",
						sinkId:
							phase === "fallback" ? "send:2:native-resume-fallback" : "send:2",
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
					},
					2,
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(received);
			peer?.write({
				type: "command-reply",
				commandId: "send",
				attempt: phase === "fallback" ? 2 : 1,
				nativeResumeFallback: false,
				failure: { operation: "old attempt", message: "stale" },
			});
			peer?.write({
				type: "command-reply",
				commandId: "send",
				attempt: 2,
				nativeResumeFallback: phase === "fallback",
			});
			expect(yield* Fiber.join(send)).toBeUndefined();
		}),
	);

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
			const call = yield* journal
				.execute(
					"outbox-command",
					2,
					false,
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			expect(journal.answers).toEqual([
				{
					commandId: "outbox-command",
					attempt: 2,
					nativeResumeFallback: false,
					status: "running",
				},
			]);
			// A second journal inherits the same PID on disk, but owns no call.
			const successor = new RunnerSendJournal(root, "s", "claude");
			expect(successor.answers).toEqual([
				{
					commandId: "outbox-command",
					attempt: 2,
					nativeResumeFallback: false,
					status: "uncertain",
				},
			]);
			let deliveries = 0;
			const replay = yield* Effect.exit(
				successor.execute(
					"outbox-command",
					2,
					false,
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
			yield* journal.execute(
				"finished-void",
				3,
				false,
				Effect.succeed(undefined),
			);
			const failure = {
				operation: "send-turn",
				code: "rejected",
				message: "Rejected",
			};
			yield* Effect.exit(
				journal.execute("finished-failure", 4, false, Effect.fail(failure)),
			);
			const rejected = {
				status: "error",
				nativeResumeRejected: true,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			} satisfies import("../../../src/lib/provider/types.js").TurnResult;
			yield* journal.execute("fallback", 1, false, Effect.succeed(rejected));
			yield* journal.execute("fallback", 2, true, Effect.succeed(rejected));
			expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual(
				expect.arrayContaining([
					{
						commandId: "finished-void",
						attempt: 3,
						nativeResumeFallback: false,
						status: "finished",
					},
					{
						commandId: "finished-failure",
						attempt: 4,
						nativeResumeFallback: false,
						status: "finished",
						failure,
					},
					{
						commandId: "fallback",
						attempt: 1,
						nativeResumeFallback: false,
						status: "finished",
						result: rejected,
					},
					{
						commandId: "fallback",
						attempt: 2,
						nativeResumeFallback: true,
						status: "finished",
						result: rejected,
					},
				]),
			);
		}),
);

it.effect("S10 same-attempt fallback is the journal's effective answer", () =>
	Effect.gen(function* () {
		const root = yield* Effect.acquireRelease(
			Effect.sync(() =>
				mkdtempSync(join(tmpdir(), "journal-fallback-answer-")),
			),
			(root) =>
				Effect.sync(() => rmSync(root, { recursive: true, force: true })),
		);
		const journal = new RunnerSendJournal(root, "s", "claude");
		const rejected = {
			status: "error",
			nativeResumeRejected: true,
			cost: 0,
			tokens: { input: 0, output: 0 },
			durationMs: 0,
			providerStateUpdates: [],
		} satisfies import("../../../src/lib/provider/types.js").TurnResult;
		yield* journal.execute("send", 1, false, Effect.succeed(rejected));
		const entered = yield* Deferred.make<void>();
		const finish = yield* Deferred.make<typeof rejected>();
		const fallback = yield* journal
			.execute(
				"send",
				1,
				true,
				Deferred.succeed(entered, undefined).pipe(
					Effect.andThen(Deferred.await(finish)),
				),
			)
			.pipe(Effect.forkChild);
		yield* Deferred.await(entered);
		expect(journal.answers).toEqual([
			{
				commandId: "send",
				attempt: 1,
				nativeResumeFallback: true,
				status: "running",
			},
		]);
		expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual([
			{
				commandId: "send",
				attempt: 1,
				nativeResumeFallback: true,
				status: "uncertain",
			},
		]);
		yield* Deferred.succeed(finish, rejected);
		yield* Fiber.join(fallback);
		expect(journal.answers).toEqual([
			{
				commandId: "send",
				attempt: 1,
				nativeResumeFallback: true,
				status: "finished",
				result: rejected,
			},
		]);
		expect(new RunnerSendJournal(root, "s", "claude").answers).toEqual(
			journal.answers,
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
		const outcome = yield* Effect.exit(
			journal.execute(
				"send",
				1,
				false,
				Effect.sync(() => {
					renameSync(directory, moved);
					return undefined;
				}),
			),
		);
		renameSync(moved, directory);
		expect(Exit.isFailure(outcome)).toBe(true);
		expect(journal.answers).toEqual([
			{
				commandId: "send",
				attempt: 1,
				nativeResumeFallback: false,
				status: "uncertain",
			},
		]);
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
			yield* new RunnerSendJournal(root, "s", "claude").execute(
				"send",
				1,
				false,
				Effect.succeed(undefined),
			);
			const directory = join(root, "sends", "s");
			for (const content of [
				"{",
				JSON.stringify({ commandId: "send", attempt: 1 }),
			]) {
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

// Failure modes: fresh fallback blocked by the attempt increment, duplicate fallback,
// prior fallback already delivered, uncertain primary, and repeated daemon stops before delivery.
it.effect(
	"S7round2 journal accepts an unsent fresh fallback across requeued attempts exactly once",
	() =>
		Effect.gen(function* () {
			const root = yield* Effect.acquireRelease(
				Effect.sync(() => mkdtempSync(join(tmpdir(), "requeued-journal-"))),
				(root) =>
					Effect.sync(() => rmSync(root, { recursive: true, force: true })),
			);
			const journal = new RunnerSendJournal(root, "s", "claude");
			const rejected = {
				status: "error",
				nativeResumeRejected: true,
				cost: 0,
				tokens: { input: 0, output: 0 },
				durationMs: 0,
				providerStateUpdates: [],
			} satisfies import("../../../src/lib/provider/types.js").TurnResult;
			const completed = {
				...rejected,
				status: "completed",
				nativeResumeRejected: false,
			} satisfies import("../../../src/lib/provider/types.js").TurnResult;
			for (const attempt of [2, 4]) {
				const id = `requeued-${attempt}`;
				yield* journal.execute(id, 1, false, Effect.succeed(rejected));
				let deliveries = 0;
				const deliver = Effect.sync(() => {
					deliveries++;
					return completed;
				});
				expect(yield* journal.execute(id, attempt, true, deliver)).toEqual(
					completed,
				);
				expect(yield* journal.execute(id, attempt, true, deliver)).toEqual(
					completed,
				);
				expect(deliveries).toBe(1);
				expect(
					Exit.isFailure(
						yield* Effect.exit(journal.execute(id, attempt + 1, true, deliver)),
					),
				).toBe(true);
				expect(deliveries).toBe(1);
			}
			yield* journal.execute(
				"already-fell-back",
				1,
				false,
				Effect.succeed(rejected),
			);
			yield* journal.execute(
				"already-fell-back",
				1,
				true,
				Effect.succeed(rejected),
			);
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						journal.execute(
							"already-fell-back",
							2,
							true,
							Effect.succeed(completed),
						),
					),
				),
			).toBe(true);
			yield* journal.execute("uncertain", 1, false, Effect.succeed(rejected));
			const sending = yield* Deferred.make<void>();
			const unfinished = yield* journal
				.execute(
					"uncertain",
					2,
					false,
					Deferred.succeed(sending, undefined).pipe(
						Effect.andThen(Effect.never),
					),
				)
				.pipe(Effect.forkChild);
			yield* Deferred.await(sending);
			yield* Fiber.interrupt(unfinished);
			expect(
				Exit.isFailure(
					yield* Effect.exit(
						journal.execute("uncertain", 3, true, Effect.succeed(completed)),
					),
				),
			).toBe(true);
		}),
);
