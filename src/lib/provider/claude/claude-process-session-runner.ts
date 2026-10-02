import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Deferred, Effect, FiberSet } from "effect";
import { BUILD_ID } from "../../build-id.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { isRecord } from "../../utils.js";
import type { HistoryMessage, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import {
	CLAUDE_RUNNER_PROTOCOL_VERSION,
	ClaudeRunnerSocket,
	claudeRunnerFailure,
} from "./claude-runner-protocol.js";
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
	readonly socketPath: string;
	stopping: boolean;
	child?: ChildProcess;
	connection?: ClaudeRunnerSocket;
}

export const makeProcessClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: (
		output: ClaudeSessionOutput,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const lock = yield* Effect.makeSemaphore(1);
		const children = new Map<string, RunnerChild>();
		const sinks = new Map<
			string,
			{ sessionId: string; history: readonly HistoryMessage[] }
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
					finish(Effect.fail(failure));
					if (entry.stopping) return;
					evict(sessionId, entry);
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
					const socketDir = resolve(DEFAULT_CONFIG_DIR, "r");
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
							env: process.env,
							stdio: ["ignore", "inherit", "inherit", "ipc"],
						},
					);
					entry.child = child;
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
								if (message.type === "hello") {
									if (
										message.protocolVersion !==
											CLAUDE_RUNNER_PROTOCOL_VERSION ||
										message.buildId !== BUILD_ID
									) {
										failed(
											claudeRunnerFailure(
												"runner hello",
												"Claude runner protocol/build mismatch",
											),
										);
										connection.destroy();
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
									const output = message.output;
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
											: emit(output);
									runFork(
										operation.pipe(
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
														if (message.output.type === "release-sink")
															sinks.delete(message.output.sinkId);
													}),
											}),
										),
									);
								}
							},
							failed,
						);
						entry.connection = connection;
						socket.once("connect", () =>
							connection.write({
								type: "hello",
								protocolVersion: CLAUDE_RUNNER_PROTOCOL_VERSION,
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
				return Effect.gen(function* () {
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
					const entry = yield* lock.withPermits(1)(
						Effect.gen(function* () {
							const existing = children.get(sessionId);
							if (
								existing ||
								(command.type !== "send-turn" && command.type !== "pre-warm")
							)
								return existing;
							const created: RunnerChild = {
								ready: yield* Deferred.make<
									ClaudeRunnerSocket,
									ClaudeSessionFailure
								>(),
								stopped: yield* Deferred.make<void>(),
								stopping: false,
								socketPath: join(
									resolve(DEFAULT_CONFIG_DIR),
									"r",
									randomBytes(6).toString("hex"),
								),
							};
							children.set(sessionId, created);
							runFork(
								start(sessionId, created).pipe(
									Effect.exit,
									Effect.flatMap((exit) => Deferred.done(created.ready, exit)),
									Effect.asVoid,
								),
							);
							return created;
						}),
					);
					if (!entry) return;
					if (command.type === "send-turn")
						sinks.set(command.sinkId, {
							sessionId,
							history: command.input.history,
						});
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
							: command.type === "pre-warm"
								? {
										...command,
										shellEnv: deps.shellEnv?.(command.input.workspaceRoot) ?? {
											...process.env,
										},
									}
								: command;
					const commandId =
						command.type === "send-turn"
							? (command.input.commandId ?? randomUUID())
							: randomUUID();
					if (command.type === "end-session")
						return yield* connection
							.commandEffect(commandId, payload)
							.pipe(
								Effect.ensuring(
									stop(entry).pipe(
										Effect.ensuring(Effect.sync(() => evict(sessionId, entry))),
									),
								),
							);
					return yield* connection.commandEffect(commandId, payload);
				}).pipe(
					Effect.catchAllDefect((cause) =>
						Effect.fail(claudeRunnerFailure(command.type, cause)),
					),
					Effect.onError(() =>
						Effect.sync(() => {
							if (command.type === "send-turn") sinks.delete(command.sinkId);
						}),
					),
				);
			}
		}
		return new ProcessClaudeSessionRunner();
	});
