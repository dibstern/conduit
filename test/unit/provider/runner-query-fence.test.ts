// Failure modes (CONTRACT 6.1, audit r4-3219 F1-F14): a replaced query's
// frame reaches the daemon; its evidence is dropped or stamped with the newer
// querySeq; a dropped request hangs; cleanup is dropped; the old query's
// earlier frames arrive after the new query's, live or replayed.
import { mkdtempSync, rmSync } from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { expect, it, vi } from "vitest";
import {
	type RunnerLaunch,
	type RunnerLaunchCallbacks,
	runSessionRunner,
} from "../../../src/lib/provider/runner/runner-host.js";
import {
	RUNNER_PROTOCOL_VERSION,
	type RunnerMessage,
	RunnerSocket,
	runnerBuildId,
} from "../../../src/lib/provider/runner/runner-protocol.js";
import { runnerProcessTable } from "../../../src/lib/provider/runner/runner-registry.js";
import { RunnerSpool } from "../../../src/lib/provider/runner/runner-spool.js";
import {
	currentRunnerQuery,
	type SessionFailure,
	type SessionOutput,
	type SessionOutputReply,
} from "../../../src/lib/provider/runner/session-runner.js";

type Emit = Parameters<RunnerLaunch["makeRunner"]>[1];
type OutputFrame = Extract<RunnerMessage, { type: "output" }>;

const event = (
	eventId: string,
	type: "text.delta" | "run.started" | "turn.interrupted",
): SessionOutput => ({
	type: "event",
	sinkId: "sink-1",
	event:
		type === "text.delta"
			? {
					eventId,
					providerId: "claude",
					sessionId: "session-1",
					runId: "run-1",
					type,
					providerRefs: {},
					rawSource: { kind: "claude.sdk" },
					createdAt: 0,
					data: { messageId: "m", partId: "p", text: eventId },
				}
			: type === "run.started"
				? {
						eventId,
						providerId: "claude",
						sessionId: "session-1",
						runId: "run-1",
						type,
						providerRefs: {},
						rawSource: { kind: "claude.sdk" },
						createdAt: 0,
						data: { inputId: "input-1", requestedRunId: "run-1" },
					}
				: {
						eventId,
						providerId: "claude",
						sessionId: "session-1",
						runId: "run-1",
						type,
						providerRefs: {},
						rawSource: { kind: "claude.sdk" },
						createdAt: 0,
						data: { messageId: "m" },
					},
});

const label = (frame: OutputFrame) =>
	`${frame.output.type === "event" ? frame.output.event.eventId : frame.output.type}@${frame.querySeq}`;

/** One in-process runner host on a fake payload whose test emits under a chosen query. */
const withHost = (
	body: (host: {
		readonly callbacks: RunnerLaunchCallbacks;
		readonly emitUnder: (
			query: object,
			output: SessionOutput,
		) => Effect.Effect<SessionOutputReply, SessionFailure>;
		readonly outputs: () => readonly OutputFrame[];
		readonly connect: (
			acknowledgedSequence: number,
			replies: boolean,
		) => Effect.Effect<void, unknown, import("effect").Scope.Scope>;
		readonly disconnect: () => Effect.Effect<void>;
	}) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
) =>
	Effect.gen(function* () {
		const directory = mkdtempSync(join(tmpdir(), "query-fence-"));
		const socketPath = join(directory, "r.sock");
		const argv = Object.getOwnPropertyDescriptor(process, "argv");
		const send = Object.getOwnPropertyDescriptor(process, "send");
		const inspect = vi
			.spyOn(runnerProcessTable, "inspect")
			.mockReturnValue({ state: "running", startTime: "host-fixture" });
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Host fixture must never exit the test process");
		});
		const kill = vi.spyOn(process, "kill").mockImplementation(() => {
			throw new Error("Host fixture must never signal a PID");
		});
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => {
				if (argv) Object.defineProperty(process, "argv", argv);
				if (send) Object.defineProperty(process, "send", send);
				else Reflect.deleteProperty(process, "send");
				vi.unstubAllEnvs();
				exit.mockRestore();
				kill.mockRestore();
				inspect.mockRestore();
				rmSync(directory, { recursive: true, force: true });
			}),
		);
		for (const key of Object.keys(process.env))
			if (key.startsWith("CONDUIT_TEST_RUNNER_")) vi.stubEnv(key, undefined);
		vi.stubEnv("NODE_ENV", "test");
		vi.stubEnv("CONDUIT_CONFIG_DIR", directory);
		vi.stubEnv("CONDUIT_TEST_RUNNER_IDLE_MS", "null");
		Object.defineProperty(process, "argv", {
			...argv,
			value: [process.execPath, "runner-host", socketPath, "session-1", "r-1"],
		});
		const listening = yield* Deferred.make<void>();
		Object.defineProperty(process, "send", {
			configurable: true,
			writable: true,
			value: (message: unknown) => {
				if (
					typeof message === "object" &&
					message !== null &&
					"type" in message &&
					message.type === "listening"
				)
					Deferred.doneUnsafe(listening, Effect.void);
				return true;
			},
		});
		const launched = yield* Deferred.make<RunnerLaunchCallbacks>();
		const emitReady = yield* Deferred.make<Emit>();
		let serverDisconnected = Deferred.makeUnsafe<void>();
		const disconnect = RunnerSpool.prototype.disconnect;
		const disconnected = vi
			.spyOn(RunnerSpool.prototype, "disconnect")
			.mockImplementation(function (this: RunnerSpool, peer) {
				disconnect.call(this, peer);
				Deferred.doneUnsafe(serverDisconnected, Effect.void);
			});
		yield* Effect.addFinalizer(() =>
			Effect.sync(() => disconnected.mockRestore()),
		);
		const host = yield* Effect.forkChild(
			Effect.scoped(
				runSessionRunner("claude", (callbacks) =>
					Deferred.succeed(launched, callbacks).pipe(
						Effect.as({
							makeRunner: (_config, emit) => {
								Deferred.doneUnsafe(emitReady, Effect.succeed(emit));
								const executeEffect = () =>
									Effect.die("The fence fixture takes no commands");
								return Effect.succeed({
									hasLiveProcessEffect: () => Effect.succeed(true),
									executeEffect,
									executeNativeEffect: executeEffect,
								});
							},
							upgradeState: () => ({}),
							acceptCommand: () => {},
							executeEffect: (runner, command) =>
								runner.executeNativeEffect(command),
						} satisfies RunnerLaunch),
					),
				),
			),
		);
		yield* Effect.addFinalizer(() => Fiber.interrupt(host));
		yield* Effect.raceFirst(Deferred.await(listening), Fiber.join(host));
		const callbacks = yield* Deferred.await(launched);
		const received: OutputFrame[] = [];
		let current: { client: RunnerSocket; closed: Deferred.Deferred<void> } =
			undefined as never;
		const connect = (acknowledgedSequence: number, replies: boolean) =>
			Effect.gen(function* () {
				const socket = new Socket();
				const closed = yield* Deferred.make<void>();
				const hello = yield* Deferred.make<void, SessionFailure>();
				const replayed = yield* Deferred.make<void>();
				socket.once("close", () => Deferred.doneUnsafe(closed, Effect.void));
				const client: RunnerSocket = new RunnerSocket(
					socket,
					(message) => {
						if (message.type === "hello")
							Deferred.doneUnsafe(hello, Effect.void);
						if (message.type === "refused")
							Deferred.doneUnsafe(hello, Effect.fail(message.failure));
						if (message.type === "upgrade-state")
							Deferred.doneUnsafe(replayed, Effect.void);
						if (message.type !== "output") return;
						received.push(message);
						if (replies && !socket.writableEnded)
							client.write({
								type: "output-reply",
								outputId: message.outputId,
								sequence: message.sequence,
								result: {},
							});
					},
					(failure) => Deferred.doneUnsafe(hello, Effect.fail(failure)),
				);
				current = { client, closed };
				yield* Effect.tryPromise(
					() =>
						new Promise<void>((done, fail) => {
							socket.once("error", fail);
							socket.connect(socketPath, done);
						}),
				);
				client.write({
					type: "hello",
					driverKind: "claude",
					protocolVersion: RUNNER_PROTOCOL_VERSION,
					buildId: runnerBuildId(),
					config: { workspaceRoot: directory, daemonConfigDir: directory },
				});
				yield* Deferred.await(hello);
				client.write({ type: "replay", acknowledgedSequence });
				yield* Deferred.await(replayed);
			});
		const disconnectClient = () =>
			Effect.gen(function* () {
				serverDisconnected = Deferred.makeUnsafe<void>();
				current.client.destroy();
				yield* Deferred.await(current.closed);
				yield* Deferred.await(serverDisconnected);
			});
		yield* connect(0, true);
		yield* Effect.addFinalizer(() => disconnectClient());
		const emit = yield* Deferred.await(emitReady);
		yield* body({
			callbacks,
			emitUnder: (query, output) =>
				emit(output).pipe(Effect.provideService(currentRunnerQuery, query)),
			outputs: () => received,
			connect,
			disconnect: disconnectClient,
		});
		expect(exit).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});

it("drops a replaced query's output at capture and passes its evidence under its own querySeq", async () => {
	await Effect.runPromise(
		Effect.scoped(
			withHost(({ callbacks, emitUnder, outputs }) =>
				Effect.gen(function* () {
					const replaced = {};
					const replacement = {};
					callbacks.queryStarted(replaced);
					yield* emitUnder(replaced, event("a-before", "text.delta"));
					callbacks.queryStarted(replacement);
					// Old and new overlap: the replaced query keeps producing while the new one streams.
					const request = yield* Effect.all(
						[
							emitUnder(replaced, event("a-late", "text.delta")),
							emitUnder(replacement, event("b-delta", "text.delta")),
							emitUnder(replaced, event("a-accepted", "run.started")),
							emitUnder(replacement, event("b-delta-2", "text.delta")),
							emitUnder(replaced, event("a-ended", "turn.interrupted")),
							emitUnder(replaced, {
								type: "permission-request",
								sinkId: "sink-1",
								request: {
									requestId: "late-permission",
									sessionId: "session-1",
									toolName: "Bash",
									toolInput: {},
									turnId: "run-1",
									providerItemId: "tool-1",
								},
							}).pipe(Effect.exit),
							emitUnder(replaced, {
								type: "background-task",
								transition: {
									sessionId: "session-1",
									kind: "snapshot",
									tasks: [{ id: "t", type: "local_bash", description: "late" }],
								},
							}),
							emitUnder(replaced, { type: "release-sink", sinkId: "sink-1" }),
						],
						{ concurrency: "unbounded" },
					).pipe(Effect.map((results) => results[5]));
					// A dropped request is refused, so its SDK callback never waits on the daemon.
					expect(Exit.isFailure(request)).toBe(true);
					const labels = outputs().map(label);
					expect(new Set(labels)).toEqual(
						new Set([
							"a-before@0",
							"b-delta@1",
							"a-accepted@0",
							"b-delta-2@1",
							"a-ended@0",
							"release-sink@0",
						]),
					);
					expect(labels).toHaveLength(6);
					expect(labels.indexOf("b-delta@1")).toBeLessThan(
						labels.indexOf("b-delta-2@1"),
					);
				}),
			),
		),
	);
});

it("delivers every frame a query emitted before its replacement ahead of the new query's, live and replayed", async () => {
	await Effect.runPromise(
		Effect.scoped(
			withHost(({ callbacks, emitUnder, outputs, connect, disconnect }) =>
				Effect.gen(function* () {
					const replaced = {};
					const replacement = {};
					callbacks.queryStarted(replaced);
					yield* emitUnder(replaced, event("a-live", "text.delta"));
					const acknowledged = outputs().at(-1)?.sequence ?? 0;
					yield* disconnect();
					// Spooled while the daemon is away; replay keeps each frame's own querySeq.
					const old = yield* Effect.forkChild(
						Effect.all(
							["a-1", "a-2", "a-3"].map((id) =>
								emitUnder(replaced, event(id, "text.delta")),
							),
						),
					);
					yield* Fiber.join(old);
					callbacks.queryStarted(replacement);
					yield* emitUnder(replacement, event("b-1", "text.delta"));
					yield* connect(acknowledged, true);
					yield* emitUnder(replacement, event("b-2", "text.delta"));
					const ordered = [...outputs()]
						.sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
						.map(label);
					expect(ordered).toEqual([
						"a-live@0",
						"a-1@0",
						"a-2@0",
						"a-3@0",
						"b-1@1",
						"b-2@1",
					]);
					expect(outputs().map(label)).toEqual(ordered);
				}),
			),
		),
	);
});
