import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Deferred, Effect, FiberSet } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { isRecord } from "../../utils.js";
import type { HistoryMessage, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	ClaudeRunnerSocket,
	claudeRunnerFailure,
	claudeRunnerHelloFailure,
} from "./claude-runner-protocol.js";
import {
	failClaudeRunnerTurn,
	observeClaudeRunnerTurn,
} from "./claude-runner-turn-failure.js";
import type {
	ClaudeSessionCommand,
	ClaudeSessionFailure,
	ClaudeSessionOutput,
	ClaudeSessionOutputReply,
	ClaudeSessionRunner,
} from "./claude-session-runner.js";

interface RunnerChild {
	readonly ready: Deferred.Deferred<ClaudeRunnerSocket, ClaudeSessionFailure>;
	readonly stopped: Deferred.Deferred<void>;
	readonly drained: Deferred.Deferred<void>;
	readonly socketPath: string;
	readonly outputs: Effect.Semaphore;
	stopping: boolean;
	ending: number;
	endingReleased?: Deferred.Deferred<void>;
	idleExiting: boolean;
	failure?: ClaudeSessionFailure;
	child?: ChildProcess;
	connection?: ClaudeRunnerSocket;
}

const log = createLogger("claude-process-session-runner");

export const makeProcessClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: (
		output: ClaudeSessionOutput,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const lock = yield* Effect.makeSemaphore(1);
		const configDir = resolve(deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR);
		const children = new Map<string, RunnerChild>();
		const sinks = new Map<
			string,
			{
				sessionId: string;
				history: readonly HistoryMessage[];
				userMessageId?: string;
				messageId: string;
				terminal: boolean;
				pending: boolean;
				accepted: boolean;
				releaseRequested: boolean;
				completed: Deferred.Deferred<void> | undefined;
			}
		>();
		let closing = false;

		const stop = (entry: RunnerChild) =>
			Effect.gen(function* () {
				if (entry.stopping) return yield* Deferred.await(entry.stopped);
				entry.stopping = true;
				const cleanup = Effect.async<void>((resume) => {
					entry.connection?.destroy();
					const child = entry.child;
					let force: ReturnType<typeof setTimeout> | undefined;
					let deadline: ReturnType<typeof setTimeout> | undefined;
					const finish = () => {
						clearTimeout(force);
						clearTimeout(deadline);
						child?.off("exit", finish);
						resume(Effect.void);
					};
					if (
						!child?.pid ||
						child.exitCode !== null ||
						child.signalCode !== null
					) {
						finish();
						return;
					}
					child.once("exit", finish);
					force = setTimeout(() => {
						child.kill("SIGKILL");
						deadline = setTimeout(finish, 1000);
					}, 3000);
					child.kill("SIGTERM");
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => rmSync(entry.socketPath, { force: true })),
					),
				);
				// Let the server persist the same interruption/interaction cleanup
				// outputs as the in-process runner before closing its only channel.
				yield* Deferred.await(entry.ready).pipe(
					Effect.flatMap((connection) =>
						connection.commandEffect(randomUUID(), { type: "shutdown" }),
					),
					Effect.interruptible,
					Effect.timeout("1 second"),
					Effect.ignore,
					Effect.ensuring(cleanup),
					Effect.ensuring(Deferred.succeed(entry.stopped, undefined)),
				);
			}).pipe(Effect.uninterruptible);
		const evict = (sessionId: string, entry: RunnerChild) => {
			// A late close from an old child must not remove its replacement.
			if (children.get(sessionId) !== entry) return;
			children.delete(sessionId);
			for (const [sinkId, binding] of sinks)
				if (binding.sessionId === sessionId) sinks.delete(sinkId);
		};
		const shutdown = lock
			.withPermits(1)(
				Effect.suspend(() => {
					closing = true;
					return Effect.forEach([...children.values()], stop, {
						discard: true,
						concurrency: 4,
					}).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								children.clear();
								sinks.clear();
							}),
						),
					);
				}),
			)
			.pipe(Effect.uninterruptible);
		yield* Effect.addFinalizer(() => shutdown);

		const start = (sessionId: string, entry: RunnerChild) =>
			Effect.async<ClaudeRunnerSocket, ClaudeSessionFailure>((resume) => {
				let settled = false;
				const timer = setTimeout(
					() =>
						failed(
							claudeRunnerFailure(
								"spawn runner",
								"Claude runner startup timed out",
							),
						),
					10_000,
				);
				const finish = (
					result: Effect.Effect<ClaudeRunnerSocket, ClaudeSessionFailure>,
				) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resume(result);
				};
				const failed = (failure: ClaudeSessionFailure) => {
					const wasReady = settled;
					finish(Effect.fail(failure));
					if (entry.stopping || entry.failure) return;
					entry.failure = failure;
					const bindings = [...sinks].filter(
						([, binding]) => binding.sessionId === sessionId,
					);
					if (
						!entry.idleExiting &&
						(!wasReady ||
							failure.operation === "runner hello" ||
							bindings.some(([, binding]) => binding.pending))
					)
						log.error(
							`Claude runner failed for session ${sessionId}: ${failure.message}`,
						);
					// Warm completed turns retain a sink for background output. A
					// dead runner cannot release it, even when no send is waiting.
					runFork(
						entry.outputs
							.withPermits(1)(
								emit({
									type: "background-task",
									transition: { sessionId, kind: "session-ended" },
								}).pipe(
									Effect.andThen(
										Effect.forEach(
											bindings.filter(([, binding]) => !binding.pending),
											([sinkId]) => emit({ type: "release-sink", sinkId }),
											{ discard: true },
										),
									),
								),
							)
							.pipe(
								Effect.ignore,
								Effect.andThen(
									Effect.forEach(
										bindings.filter(
											([, binding]) => !entry.idleExiting || binding.accepted,
										),
										([, binding]) =>
											binding.completed
												? Deferred.await(binding.completed)
												: Effect.void,
										{ discard: true },
									),
								),
								Effect.ensuring(Effect.sync(() => evict(sessionId, entry))),
								Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
							),
					);
					runFork(stop(entry));
				};
				try {
					if (closing || entry.stopping) {
						failed(
							claudeRunnerFailure(
								"spawn runner",
								"Claude runner is shutting down",
							),
						);
						return;
					}
					const socketDir = resolve(configDir, "r");
					mkdirSync(socketDir, { recursive: true, mode: 0o700 });
					if (Buffer.byteLength(entry.socketPath) >= 104) {
						failed(
							claudeRunnerFailure(
								"spawn runner",
								"Conduit config directory is too long for a Claude runner Unix socket",
							),
						);
						return;
					}
					const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
					const child = spawn(
						process.execPath,
						[
							...process.execArgv,
							fileURLToPath(
								new URL(
									`../../../bin/claude-session-runner.${extension}`,
									import.meta.url,
								),
							),
							entry.socketPath,
						],
						{
							cwd: deps.workspaceRoot,
							env: { ...process.env, CONDUIT_CONFIG_DIR: configDir },
							stdio: ["ignore", "inherit", "inherit", "ipc"],
						},
					);
					entry.child = child;
					if (
						process.env["NODE_ENV"] === "test" &&
						process.connected &&
						child.pid
					)
						process.send?.({
							channel: "conduit-process-test",
							kind: "runner-spawned",
							pid: child.pid,
						});
					child.once("error", (cause) =>
						failed(claudeRunnerFailure("spawn runner", cause)),
					);
					child.once("exit", (code, signal) => {
						entry.connection?.destroy();
						failed(
							claudeRunnerFailure(
								"spawn runner",
								`Claude runner exited (${signal ?? code})`,
							),
						);
					});
					child.on("message", (value: unknown) => {
						if (!isRecord(value)) return;
						if (
							value["channel"] === "conduit-process-test" &&
							process.env["NODE_ENV"] === "test" &&
							process.connected
						)
							process.send?.(value);
						if (
							value["channel"] !== "conduit-claude-runner" ||
							value["type"] !== "listening"
						)
							return;
						const socket = createConnection(entry.socketPath);
						const connection = new ClaudeRunnerSocket(
							socket,
							(message) => {
								if (message.type === "idle-exit") {
									entry.idleExiting = true;
									connection.write({ type: "idle-exit-ack" });
									return;
								}
								if (message.type === "command-accepted") {
									const binding = sinks.get(message.sinkId);
									if (binding) binding.accepted = true;
									return;
								}
								if (message.type === "refused") {
									failed(message.failure);
									connection.destroy();
									return;
								}
								if (message.type === "hello") {
									const failure = claudeRunnerHelloFailure(message, "runner");
									if (failure) {
										connection.refuse(failure);
										failed(failure);
										return;
									}
									if (process.env["NODE_ENV"] === "test" && process.connected)
										process.send?.({
											channel: "conduit-process-test",
											kind: "runner-started",
											sessionId,
											pid: child.pid,
											socketPath: entry.socketPath,
											buildId: message.buildId,
											protocolVersion: message.protocolVersion,
										});
									finish(Effect.succeed(connection));
								} else if (message.type === "output") {
									const received = message.output;
									const binding =
										"sinkId" in received
											? sinks.get(received.sinkId)
											: undefined;
									// SDK failures need the same owner as socket failures,
									// especially when another user turn is already queued.
									const output =
										received.type === "event" &&
										received.event.type === "turn.error" &&
										binding?.userMessageId &&
										received.event.sessionId === binding.sessionId &&
										isRecord(received.event.data)
											? {
													...received,
													event: {
														...received.event,
														data: {
															...received.event.data,
															userMessageId: binding.userMessageId,
														},
													},
												}
											: received;
									let released = false;
									const operation: Effect.Effect<
										ClaudeSessionOutputReply,
										ClaudeSessionFailure
									> =
										output.type === "read-turn-history"
											? Effect.suspend(() => {
													const binding = sinks.get(output.sinkId);
													return binding
														? Effect.succeed({ history: binding.history })
														: Effect.fail(
																claudeRunnerFailure(
																	output.type,
																	"Claude turn history is no longer available",
																),
															);
												})
											: output.type === "release-sink"
												? Effect.suspend(() => {
														// Decide under the output permit: a command reply
														// may have finished while this frame was queued.
														if (binding?.pending) {
															binding.releaseRequested = true;
															return Effect.succeed({});
														}
														released = true;
														return emit(output);
													})
												: emit(output);
									const forwarding = operation.pipe(
										Effect.tap(() =>
											Effect.sync(() =>
												observeClaudeRunnerTurn(output, binding),
											),
										),
										Effect.matchCauseEffect({
											onFailure: (cause) =>
												Effect.sync(() =>
													connection.write({
														type: "output-reply",
														outputId: message.outputId,
														failure: claudeRunnerFailure(
															message.output.type,
															Cause.squash(cause),
														),
													}),
												),
											onSuccess: (result) =>
												Effect.sync(() => {
													connection.write({
														type: "output-reply",
														outputId: message.outputId,
														result,
													});
													if (
														message.output.type === "release-sink" &&
														released
													)
														sinks.delete(message.output.sinkId);
												}),
										}),
									);
									// Long subagent work must not block streaming or crash cleanup.
									runFork(
										output.type === "materialize-subagents" ||
											output.type === "ensure-subagent-session" ||
											output.type === "read-turn-history"
											? forwarding
											: entry.outputs.withPermits(1)(forwarding),
									);
								}
							},
							failed,
						);
						entry.connection = connection;
						socket.once("connect", () =>
							connection.write({
								type: "hello",
								protocolVersion:
									process.env["NODE_ENV"] === "test" &&
									process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"]
										? Number(
												process.env["CONDUIT_TEST_SERVER_PROTOCOL_VERSION"],
											)
										: CLAUDE_RUNNER_PROTOCOL_VERSION,
								buildId: BUILD_ID,
								config: {
									workspaceRoot: deps.workspaceRoot,
									materializeSubagents: deps.materializeSubagents ?? false,
									...(deps.subagentPollTimeoutMs !== undefined
										? { subagentPollTimeoutMs: deps.subagentPollTimeoutMs }
										: {}),
								},
							}),
						);
					});
					return Effect.sync(() => {
						clearTimeout(timer);
						evict(sessionId, entry);
					}).pipe(Effect.flatMap(() => stop(entry)));
				} catch (cause) {
					failed(claudeRunnerFailure("spawn runner", cause));
					return;
				}
			});

		class ProcessClaudeSessionRunner implements ClaudeSessionRunner {
			executeEffect(
				command: Extract<ClaudeSessionCommand, { type: "send-turn" }>,
			): Effect.Effect<TurnResult, ClaudeSessionFailure>;
			executeEffect(
				command: Exclude<ClaudeSessionCommand, { type: "send-turn" }>,
			): Effect.Effect<void, ClaudeSessionFailure>;
			executeEffect(
				command: ClaudeSessionCommand,
			): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure>;
			executeEffect(
				command: ClaudeSessionCommand,
			): Effect.Effect<TurnResult | undefined, ClaudeSessionFailure> {
				const turn =
					command.type === "send-turn"
						? {
								sessionId: command.input.sessionId,
								history: command.input.history,
								...(command.input.userMessageId
									? { userMessageId: command.input.userMessageId }
									: {}),
								messageId: "",
								terminal: false,
								pending: true,
								accepted: false,
								releaseRequested: false,
								completed: undefined as Deferred.Deferred<void> | undefined,
							}
						: undefined;
				let child: RunnerChild | undefined;
				let ending: RunnerChild | undefined;
				return Effect.gen(function* () {
					if (turn) turn.completed = yield* Deferred.make<void>();
					if (command.type === "shutdown") {
						yield* shutdown;
						return;
					}
					if (closing)
						return yield* Effect.fail(
							claudeRunnerFailure(
								command.type,
								"Claude runners are shutting down",
							),
						);
					const sessionId =
						command.type === "send-turn"
							? command.input.sessionId
							: "sessionId" in command
								? command.sessionId
								: sinks.get(command.sinkId)?.sessionId;
					if (!sessionId) return;
					let entry: RunnerChild | undefined;
					let draining = false;
					do {
						const selection = yield* lock.withPermits(1)(
							Effect.gen(function* () {
								if (closing)
									return yield* Effect.fail(
										claudeRunnerFailure(
											command.type,
											"Claude runners are shutting down",
										),
									);
								const existing = children.get(sessionId);
								if (existing || command.type !== "send-turn") {
									if (existing && command.type === "end-session") {
										if (existing.ending === 0)
											existing.endingReleased = yield* Deferred.make<void>();
										existing.ending++;
										ending = existing;
										if (process.env["NODE_ENV"] === "test" && process.connected)
											process.send?.({
												channel: "conduit-process-test",
												kind: "runner-end-selected",
												sessionId,
											});
									}
									const draining =
										command.type === "send-turn" &&
										(existing?.failure !== undefined ||
											existing?.idleExiting === true ||
											(existing?.ending ?? 0) > 0);
									if (
										existing &&
										!draining &&
										turn &&
										command.type === "send-turn"
									)
										sinks.set(command.sinkId, turn);
									return {
										entry: existing,
										draining,
										admission: existing?.endingReleased,
									};
								}
								const created: RunnerChild = {
									ready: yield* Deferred.make<
										ClaudeRunnerSocket,
										ClaudeSessionFailure
									>(),
									stopped: yield* Deferred.make<void>(),
									drained: yield* Deferred.make<void>(),
									stopping: false,
									ending: 0,
									idleExiting: false,
									outputs: yield* Effect.makeSemaphore(1),
									socketPath: join(
										configDir,
										"r",
										randomBytes(6).toString("hex"),
									),
								};
								children.set(sessionId, created);
								if (turn && command.type === "send-turn")
									sinks.set(command.sinkId, turn);
								runFork(
									start(sessionId, created).pipe(
										Effect.exit,
										Effect.flatMap((exit) =>
											Deferred.done(created.ready, exit),
										),
										Effect.asVoid,
									),
								);
								return { entry: created, draining: false };
							}),
						);
						entry = selection.entry;
						draining = selection.draining;
						// Old cleanup is session-wide. Finish it before a replacement
						// can register interactions or publish a new busy status.
						if (entry && draining)
							yield* Deferred.await(
								!entry.failure && !entry.idleExiting && selection.admission
									? selection.admission
									: entry.drained,
							);
					} while (draining);
					if (!entry) return;
					child = entry;
					const connection = yield* Deferred.await(entry.ready);
					if (closing)
						return yield* Effect.fail(
							claudeRunnerFailure(
								command.type,
								"Claude runners are shutting down",
							),
						);
					const payload =
						command.type === "send-turn"
							? {
									...command,
									// Only an agent switch consumes history. Keep it server-side
									// until requested rather than serializing it on every warm send.
									historyOnDemand: true,
									input: { ...command.input, history: [] },
									shellEnv: deps.shellEnv?.(command.input.workspaceRoot) ?? {
										...process.env,
									},
								}
							: command;
					const commandId =
						command.type === "send-turn"
							? (command.input.commandId ?? randomUUID())
							: randomUUID();
					if (command.type === "end-session") {
						const bindings = [...sinks.values()].filter(
							(binding) => binding.sessionId === sessionId,
						);
						return yield* connection
							.commandEffect(commandId, payload)
							.pipe(
								Effect.ensuring(
									stop(entry).pipe(
										Effect.andThen(
											Effect.suspend(() =>
												entry.failure
													? Deferred.await(entry.drained)
													: Effect.forEach(
															bindings,
															(binding) =>
																binding.completed
																	? Deferred.await(binding.completed)
																	: Effect.void,
															{ discard: true },
														).pipe(
															Effect.ensuring(
																Effect.sync(() => evict(sessionId, entry)),
															),
															Effect.ensuring(
																Deferred.succeed(entry.drained, undefined),
															),
														),
											),
										),
									),
								),
							);
					}
					return yield* connection.commandEffect(commandId, payload).pipe(
						Effect.tap(() => {
							if (!turn || command.type !== "send-turn") return Effect.void;
							return entry.outputs.withPermits(1)(
								Effect.gen(function* () {
									turn.pending = false;
									if (turn.releaseRequested || entry.failure) {
										yield* emit({
											type: "release-sink",
											sinkId: command.sinkId,
										});
										sinks.delete(command.sinkId);
									}
								}),
							);
						}),
					);
				}).pipe(
					Effect.retry({
						while: (failure) =>
							failure.code === "runner_idle_exit" &&
							turn !== undefined &&
							!turn.accepted &&
							!closing,
					}),
					Effect.onExit(() =>
						Effect.gen(function* () {
							if (ending && --ending.ending === 0 && ending.endingReleased)
								yield* Deferred.succeed(ending.endingReleased, undefined);
						}),
					),
					Effect.catchAllDefect((cause) =>
						Effect.fail(claudeRunnerFailure(command.type, cause)),
					),
					Effect.onError((cause) => {
						if (
							command.type !== "send-turn" ||
							!turn ||
							Cause.isInterruptedOnly(cause)
						)
							return Effect.void;
						const cleanup = failClaudeRunnerTurn(
							emit,
							command.sinkId,
							turn,
							claudeRunnerFailure(command.type, Cause.squash(cause)),
						).pipe(
							Effect.ensuring(Effect.sync(() => sinks.delete(command.sinkId))),
						);
						return child ? child.outputs.withPermits(1)(cleanup) : cleanup;
					}),
					Effect.ensuring(
						Effect.suspend(() =>
							turn?.completed
								? Deferred.succeed(turn.completed, undefined)
								: Effect.void,
						),
					),
				);
			}
		}
		return new ProcessClaudeSessionRunner();
	});
