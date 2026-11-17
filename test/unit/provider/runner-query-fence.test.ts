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
import { getConfigDir } from "../../../src/lib/daemon/config-persistence.js";
import {
	type ClaudeProviderInstanceDeps,
	makeClaudeSessionRunner,
} from "../../../src/lib/provider/claude/claude-provider-runtime.js";
import { makeClaudeRunnerLaunch } from "../../../src/lib/provider/claude/claude-runner-launch.js";
import type { ClaudeSessionRunnerDeps } from "../../../src/lib/provider/claude/claude-runner-payload.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import type {
	CanUseTool,
	SDKMessage,
} from "../../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../../src/lib/provider/event-sink-errors.js";
import * as ProcessTables from "../../../src/lib/provider/runner/process-table.js";
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
import { RunnerSinkBindings } from "../../../src/lib/provider/runner/runner-sink-bindings.js";
import { RunnerSpool } from "../../../src/lib/provider/runner/runner-spool.js";
import {
	currentRunnerQuery,
	type NativeSessionRunner,
	type SessionCommand,
	type SessionFailure,
	type SessionOutput,
	type SessionOutputReply,
} from "../../../src/lib/provider/runner/session-runner.js";
import {
	createMockQuery,
	makeErrorResult,
	makeSuccessResult,
} from "../../helpers/mock-sdk.js";
import { makeTestProcessTable } from "../../helpers/runner-process-table.js";
import {
	admitRunnerCommand,
	makeRunnerAdmission,
} from "../../helpers/runner-provider-admission.js";

type Emit = Parameters<RunnerLaunch["makeRunner"]>[1];

// The Claude launch's own output callback, recorded as the launch hands it to the payload.
const launched = vi.hoisted(() => ({ output: undefined as Emit | undefined }));
vi.mock("../../../src/lib/provider/claude/claude-sdk-module.js", async () => {
	const { Effect } = await import("effect");
	const { createMockQuery } = await import("../../helpers/mock-sdk.js");
	return {
		loadClaudeSdkTestModule: Effect.succeed({
			claudeSdk: { query: () => createMockQuery([]) },
		}),
	};
});
vi.mock(
	"../../../src/lib/provider/claude/claude-runner-payload.js",
	async (importActual) => {
		const actual =
			await importActual<
				typeof import("../../../src/lib/provider/claude/claude-runner-payload.js")
			>();
		return {
			...actual,
			makeClaudeSessionRunner: (
				...args: Parameters<typeof actual.makeClaudeSessionRunner>
			) => {
				launched.output = args[1];
				return actual.makeClaudeSessionRunner(...args);
			},
		};
	},
);
type OutputFrame = Extract<RunnerMessage, { type: "output" }>;

const event = (
	eventId: string,
	type: "text.delta" | "run.started" | "turn.interrupted",
): Extract<SessionOutput, { type: "event" }> => ({
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

/** One in-process runner host on a payload (a fake by default) whose test emits under a chosen query. */
const withHost = (
	body: (host: {
		readonly callbacks: RunnerLaunchCallbacks;
		readonly runner: NativeSessionRunner;
		readonly emit: Emit;
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
	makePayload: (
		callbacks: RunnerLaunchCallbacks,
		emit: Emit,
	) => ReturnType<RunnerLaunch["makeRunner"]> = () => {
		const executeEffect = () =>
			Effect.die("The fence fixture takes no commands");
		return Effect.succeed({
			hasLiveProcessEffect: () => Effect.succeed(true),
			executeEffect,
			executeNativeEffect: executeEffect,
		});
	},
) =>
	Effect.gen(function* () {
		const directory = mkdtempSync(join(tmpdir(), "query-fence-"));
		const socketPath = join(directory, "r.sock");
		const argv = Object.getOwnPropertyDescriptor(process, "argv");
		const send = Object.getOwnPropertyDescriptor(process, "send");
		const table = vi
			.spyOn(ProcessTables, "makeProductionProcessTable")
			.mockReturnValue(
				makeTestProcessTable({
					processes: new Map([
						[
							process.pid,
							{
								state: "running",
								startTime: "host-fixture",
								pgid: process.pid,
							},
						],
					]),
				}),
			);
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
				table.mockRestore();
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
		const ready = yield* Deferred.make<{
			readonly emit: Emit;
			readonly runner: NativeSessionRunner;
		}>();
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
							makeRunner: (_config, emit) =>
								makePayload(callbacks, emit).pipe(
									Effect.tap((runner) =>
										Deferred.succeed(ready, { emit, runner }),
									),
								),
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
		const { emit, runner } = yield* Deferred.await(ready);
		yield* body({
			callbacks,
			runner,
			emit,
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

it("keeps a coalesced delta with the query that produced it", async () => {
	await Effect.runPromise(
		Effect.scoped(
			withHost(({ callbacks, emit, outputs }) =>
				Effect.gen(function* () {
					const replaced = {};
					const replacement = {};
					const sink = new RunnerSinkBindings(emit).makeSessionSink(
						"sink-1",
						"session-1",
					);
					callbacks.queryStarted(replaced);
					for (const id of ["a-1", "a-2"])
						yield* sink
							.push(event(id, "text.delta").event)
							.pipe(Effect.provideService(currentRunnerQuery, replaced));
					callbacks.queryStarted(replacement);
					// The replacement's next output flushes the held "a-2" in its own fiber.
					yield* sink
						.push(event("b-1", "run.started").event)
						.pipe(Effect.provideService(currentRunnerQuery, replacement));
					expect(outputs().map(label)).toEqual(["a-1@0", "b-1@1"]);
				}),
			),
		),
	);
});

const claudeTurn = (
	inputId: string,
	input: Partial<Extract<SessionCommand, { type: "send-turn" }>["input"]> = {},
) => ({
	type: "send-turn" as const,
	sinkId: inputId,
	aborted: false,
	input: {
		sessionId: "session-1",
		inputId,
		prompt: inputId,
		history: [],
		providerState: {},
		workspaceRoot: "/tmp/ws",
		configDir: configuredClaudeConfigDir("/tmp/claude-account"),
		folderSource: "account" as const,
		extraFolders: [],
		model: { providerId: "claude", modelId: "sonnet" },
		...input,
	},
});

/** The real Claude payload on SDK queries that answer each prompt with a result (by default, success). */
const withClaudeHost = (
	body: (host: {
		readonly runner: NativeSessionRunner;
		readonly outputs: () => readonly OutputFrame[];
		readonly queries: readonly { readonly canUseTool?: CanUseTool }[];
	}) => Effect.Effect<void, unknown, import("effect").Scope.Scope>,
	options: {
		readonly answer?: (query: number) => SDKMessage;
		readonly prepareQuery?: ClaudeSessionRunnerDeps["prepareQuery"];
	} = {},
) => {
	const queries: { readonly canUseTool?: CanUseTool }[] = [];
	const queryFactory: NonNullable<
		ClaudeProviderInstanceDeps["queryFactory"]
	> = ({ prompt, options: query }) => {
		const index = queries.length;
		queries.push(query?.canUseTool ? { canUseTool: query.canUseTool } : {});
		const stream = (async function* (): AsyncGenerator<SDKMessage> {
			for await (const _message of prompt)
				yield options.answer?.(index) ?? makeSuccessResult();
		})();
		return Object.assign(createMockQuery([]), {
			[Symbol.asyncIterator]: () => stream,
		});
	};
	return withHost(
		({ runner, outputs }) => body({ runner, outputs, queries }),
		(callbacks, emit) =>
			makeClaudeSessionRunner(
				{
					daemonConfigDir: getConfigDir(),
					queryFactory,
					capabilitiesService: {
						get: () =>
							Effect.fail(
								new ClaudeBoundaryError({
									operation: "probeCapabilities",
									cause: "No live SDK in fence tests",
								}),
							),
					},
					onQueryStarted: callbacks.queryStarted,
					...(options.prepareQuery
						? { prepareQuery: options.prepareQuery }
						: {}),
				},
				emit,
			),
	);
};

/** querySeq of each completed turn, in order. */
const completions = (outputs: readonly OutputFrame[]) =>
	outputs.flatMap((frame) =>
		frame.output.type === "event" &&
		frame.output.event.type === "turn.completed"
			? [frame.querySeq]
			: [],
	);

it.each([
	["rebind", "interactive", 1],
	["discarded prewarm", "other-login", 1],
	["adopted prewarm", "same-login", 0],
] as const)("labels the Claude runner's %s under the query that produced it", async (_path, change, seq) => {
	await Effect.runPromise(
		Effect.scoped(
			withClaudeHost(({ runner, outputs, queries }) =>
				Effect.gen(function* () {
					const admission = yield* makeRunnerAdmission(runner, "claude");
					const first = claudeTurn("turn-1", {
						shellConfig: { interactive: false },
					});
					if (change === "interactive")
						yield* admitRunnerCommand(admission, runner, first);
					else
						yield* runner.executeEffect({
							type: "pre-warm",
							sessionId: "session-1",
							input: first.input,
						});
					yield* admitRunnerCommand(
						admission,
						runner,
						claudeTurn("turn-2", {
							shellConfig: { interactive: change === "interactive" },
							...(change === "other-login"
								? { configDir: configuredClaudeConfigDir("/tmp/other-account") }
								: {}),
						}),
					);
					expect(queries).toHaveLength(seq + 1);
					expect(completions(outputs())).toEqual(
						change === "interactive" ? [0, 1] : [seq],
					);
					// The replaced query's late permission callback is refused, never asked.
					if (seq === 0) return;
					const late = yield* Effect.promise(
						() =>
							queries[0]?.canUseTool?.(
								"Bash",
								{ command: "true" },
								{
									signal: new AbortController().signal,
									toolUseID: "late-tool",
									requestId: "late-request",
								},
							) ??
							Promise.reject(
								new Error("The replaced query had no permission callback"),
							),
					);
					expect(late?.behavior).toBe("deny");
					expect(
						outputs().some(
							(frame) => frame.output.type === "permission-request",
						),
					).toBe(false);
				}),
			),
		),
	);
});

it.each([
	["agent change", { agent: "plan" }],
	["rewind", { rewind: { resumeSessionAt: null } }],
	["fresh native id", { startFreshNativeSession: true }],
	["stop-after-foreground dispose", {}],
	["native-resume fallback", { nativeResumeFallback: true }],
] as const)("labels the Claude turn after a replacement by %s under its new query", async (path, replacing) => {
	const fallback = path === "native-resume fallback";
	await Effect.runPromise(
		Effect.scoped(
			withClaudeHost(
				({ runner, outputs, queries }) =>
					Effect.gen(function* () {
						const admission = yield* makeRunnerAdmission(runner, "claude");
						// The fallback's first send fails its resume, so the daemon retries it fresh.
						yield* admitRunnerCommand(
							admission,
							runner,
							claudeTurn(
								"turn-1",
								fallback ? { resumeSessionId: "stale-native" } : {},
							),
						).pipe(Effect.exit);
						if (path === "stop-after-foreground dispose")
							yield* runner.executeEffect({
								type: "interrupt",
								sessionId: "session-1",
								runIds: [],
							});
						yield* admitRunnerCommand(
							admission,
							runner,
							claudeTurn("turn-2", replacing),
						);
						expect(queries).toHaveLength(2);
						expect(completions(outputs())).toEqual(fallback ? [1] : [0, 1]);
					}),
				fallback
					? {
							answer: (query) =>
								query === 0
									? makeErrorResult({
											errors: [
												"Resume rejected by --resume-drops-turn: native context cannot be preserved",
											],
										})
									: makeSuccessResult(),
						}
					: {},
			),
		),
	);
});

it("never warms a query while another query for the session is live or setting up", async () => {
	const preparing = Deferred.makeUnsafe<void>();
	const prepared = Deferred.makeUnsafe<void>();
	await Effect.runPromise(
		Effect.scoped(
			withClaudeHost(
				({ runner, outputs, queries }) =>
					Effect.gen(function* () {
						const admission = yield* makeRunnerAdmission(runner, "claude");
						const preWarm = runner.executeEffect({
							type: "pre-warm",
							sessionId: "session-1",
							input: claudeTurn("warm").input,
						});
						const first = yield* Effect.forkChild(
							admitRunnerCommand(admission, runner, claudeTurn("turn-1")),
						);
						yield* Deferred.await(preparing);
						yield* preWarm;
						yield* Deferred.succeed(prepared, undefined);
						yield* Fiber.join(first);
						yield* preWarm;
						yield* admitRunnerCommand(admission, runner, claudeTurn("turn-2"));
						expect(queries).toHaveLength(1);
						expect(completions(outputs())).toEqual([0, 0]);
					}),
				{
					// Only the first cold query's setup waits, so a warm query cannot deadlock it.
					prepareQuery: () =>
						Effect.runPromise(
							Deferred.succeed(preparing, undefined).pipe(
								Effect.andThen((first) =>
									first ? Deferred.await(prepared) : Effect.void,
								),
							),
						),
				},
			),
		),
	);
});

it("keeps a replaced query's workspace move and native id out of the Claude launch's state", async () => {
	let launch: RunnerLaunch | undefined;
	const started: object[] = [];
	const output = (
		eventId: string,
		event:
			| { readonly type: "workspace.changed"; readonly path: string }
			| { readonly type: "turn.completed"; readonly nativeId: string },
	): SessionOutput => ({
		type: "event",
		sinkId: "sink-1",
		event: {
			eventId,
			providerId: "claude",
			sessionId: "session-1",
			runId: "run-1",
			rawSource: { kind: "claude.sdk" },
			createdAt: 0,
			...(event.type === "workspace.changed"
				? {
						type: event.type,
						providerRefs: {},
						data: { path: event.path, source: "tool" as const },
					}
				: {
						type: event.type,
						providerRefs: { providerSessionId: event.nativeId },
						data: {},
					}),
		},
	});
	await Effect.runPromise(
		Effect.scoped(
			withHost(
				({ callbacks, runner }) =>
					Effect.gen(function* () {
						const warm = {
							type: "pre-warm" as const,
							sessionId: "session-1",
							input: claudeTurn("warm").input,
						};
						launch?.acceptCommand(warm);
						yield* runner.executeNativeEffect(warm);
						const [replaced] = started;
						const replacement = {};
						callbacks.queryStarted(replacement);
						const under = (query: object | undefined, frame: SessionOutput) =>
							(launched.output?.(frame) ?? Effect.die("No launch output")).pipe(
								Effect.provideService(currentRunnerQuery, query),
							);
						yield* under(
							replaced,
							output("replaced-move", {
								type: "workspace.changed",
								path: "/tmp/ws-replaced",
							}),
						);
						// Its terminal still reaches the daemon (6.1), but names no native session to resume.
						yield* under(
							replaced,
							output("replaced-end", {
								type: "turn.completed",
								nativeId: "replaced-native",
							}),
						);
						expect(launch?.upgradeState()).toMatchObject({
							snapshot: { input: { workspaceRoot: "/tmp/ws" } },
						});
						expect(launch?.upgradeState().resumeSessionId).toBeUndefined();
						yield* under(
							replacement,
							output("current-move", {
								type: "workspace.changed",
								path: "/tmp/ws-current",
							}),
						);
						yield* under(
							replacement,
							output("current-end", {
								type: "turn.completed",
								nativeId: "current-native",
							}),
						);
						expect(launch?.upgradeState()).toMatchObject({
							snapshot: { input: { workspaceRoot: "/tmp/ws-current" } },
							resumeSessionId: "current-native",
						});
					}),
				(callbacks, emit) =>
					makeClaudeRunnerLaunch({
						...callbacks,
						queryStarted: (query) => {
							started.push(query);
							return callbacks.queryStarted(query);
						},
					}).pipe(
						Effect.orDie,
						Effect.tap((made) =>
							Effect.sync(() => {
								launch = made;
							}),
						),
						Effect.flatMap((made) =>
							made.makeRunner({ workspaceRoot: "/tmp/ws" }, emit),
						),
					),
			),
		),
	);
});
