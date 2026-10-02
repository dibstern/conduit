import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import { Deferred, Effect, FiberSet } from "effect";
import { isRecord } from "../../utils.js";
import type { HistoryMessage, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import { connectClaudeRunner } from "./claude-runner-connection.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerFailure,
} from "./claude-runner-protocol.js";
import { makeClaudeRunnerReceiptStore } from "./claude-runner-receipts.js";
import { recoverClaudeRunnerCommands } from "./claude-runner-recovery.js";
import {
	claudeRunnerDirectory,
	discoverClaudeRunners,
	removeClaudeRunner,
	runnerPidAlive,
} from "./claude-runner-registry.js";
import { preserveClaudeRunners } from "./claude-runner-shutdown.js";
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
	readonly runnerId: string;
	stopping: boolean;
	verified: boolean;
	recovering?: boolean;
	pid?: number | undefined;
	child?: ChildProcess;
	connection?: ClaudeRunnerSocket;
}

export const makeProcessClaudeSessionRunner = (
	deps: ClaudeSessionRunnerDeps,
	emit: (
		output: ClaudeSessionOutput,
		sessionId?: string,
	) => Effect.Effect<ClaudeSessionOutputReply, ClaudeSessionFailure>,
) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const lock = yield* Effect.makeSemaphore(1);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const sql = sqlOption._tag === "Some" ? sqlOption.value : undefined;
		const receipts = sql
			? yield* makeClaudeRunnerReceiptStore(sql).pipe(Effect.orDie)
			: undefined;
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
					const pid = child?.pid ?? (entry.verified ? entry.pid : undefined);
					if (
						!pid ||
						(child && (child.exitCode !== null || child.signalCode !== null))
					) {
						finish();
						return;
					}
					child?.once("exit", finish);
					const kill = (signal: NodeJS.Signals) => {
						try {
							process.kill(pid, signal);
						} catch {
							finish();
						}
					};
					force = setTimeout(() => {
						kill("SIGKILL");
						deadline = setTimeout(finish, 1000);
					}, 3000);
					kill("SIGTERM");
					if (!child) deadline = setTimeout(finish, 4100);
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (entry.pid !== undefined && !runnerPidAlive(entry.pid))
								removeClaudeRunner(entry.socketPath);
						}),
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
					if (preserveClaudeRunners())
						return Effect.sync(() => {
							for (const entry of children.values()) {
								entry.stopping = true;
								entry.connection?.destroy();
								entry.child?.unref();
								if (entry.child?.connected) entry.child.disconnect();
							}
							children.clear();
							sinks.clear();
						});
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

		const attach = (sessionId: string, entry: RunnerChild) =>
			connectClaudeRunner({
				socketPath: entry.socketPath,
				sessionId,
				runnerId: entry.runnerId,
				...(entry.pid !== undefined ? { pid: entry.pid } : {}),
				deps,
				...(receipts ? { receipts } : {}),
				runFork,
				emit: (output) =>
					output.type === "read-turn-history"
						? Effect.succeed({
								history: sinks.get(output.sinkId)?.history ?? [],
							})
						: emit(output, sessionId).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										if (output.type === "release-sink")
											sinks.delete(output.sinkId);
									}),
								),
							),
				onHello: (hello, connection) =>
					Effect.gen(function* () {
						entry.verified = true;
						entry.pid = hello.pid;
						entry.connection = connection;
						for (const binding of hello.bindings ?? []) {
							let history: readonly HistoryMessage[] = [];
							if (sql) {
								const rows = yield* sql<{
									payload_json: string;
								}>`SELECT payload_json FROM provider_command_outbox WHERE command_id = ${binding.commandId ?? binding.sinkId} AND session_id = ${sessionId}`.pipe(
									Effect.mapError((cause) =>
										claudeRunnerFailure("restore runner history", cause),
									),
								);
								if (rows[0])
									history =
										(
											JSON.parse(rows[0].payload_json) as {
												history?: readonly HistoryMessage[];
											}
										).history ?? [];
							}
							sinks.set(binding.sinkId, { sessionId, history });
						}
						for (const pending of hello.pendingOutputs ?? [])
							if (pending.sequence <= (hello.acknowledgedSequence ?? 0))
								yield* emit(pending.output, sessionId);
						if (process.env["NODE_ENV"] === "test" && process.connected)
							process.send?.({
								channel: "conduit-process-test",
								kind: "runner-started",
								sessionId,
								pid: hello.pid,
								socketPath: entry.socketPath,
								buildId: hello.buildId,
								protocolVersion: hello.protocolVersion,
							});
					}),
				onClose: () => {
					if (entry.stopping || entry.recovering || closing) return;
					evict(sessionId, entry);
					if (entry.child) runFork(stop(entry));
				},
			});

		const start = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				if (Buffer.byteLength(entry.socketPath) >= 104)
					return yield* Effect.fail(
						claudeRunnerFailure(
							"spawn runner",
							"Conduit config directory is too long for a Claude runner Unix socket",
						),
					);
				const child = yield* Effect.try({
					try: () => {
						mkdirSync(claudeRunnerDirectory(deps.workspaceRoot), {
							recursive: true,
							mode: 0o700,
						});
						const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
						return spawn(
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
								sessionId,
								entry.runnerId,
							],
							{
								cwd: deps.workspaceRoot,
								env: process.env,
								detached: true,
								stdio: ["ignore", "inherit", "inherit", "ipc"],
							},
						);
					},
					catch: (cause) => claudeRunnerFailure("spawn runner", cause),
				});
				entry.child = child;
				entry.pid = child.pid;
				if (process.env["NODE_ENV"] === "test" && process.connected)
					process.send?.({
						channel: "conduit-process-test",
						kind: "runner-spawned",
						pid: child.pid,
						socketPath: entry.socketPath,
					});
				child.once("exit", () => {
					entry.connection?.destroy();
					evict(sessionId, entry);
					removeClaudeRunner(entry.socketPath);
				});
				yield* Effect.async<void, ClaudeSessionFailure>((resume) => {
					const timer = setTimeout(
						() =>
							resume(
								Effect.fail(
									claudeRunnerFailure(
										"spawn runner",
										"Claude runner startup timed out",
									),
								),
							),
						10_000,
					);
					const failed = (cause: unknown) => {
						clearTimeout(timer);
						resume(Effect.fail(claudeRunnerFailure("spawn runner", cause)));
					};
					child.once("error", failed);
					const exited = () => failed("Claude runner exited before listening");
					child.once("exit", exited);
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
						clearTimeout(timer);
						child.off("error", failed);
						child.off("exit", exited);
						resume(Effect.void);
					});
					return Effect.sync(() => clearTimeout(timer));
				});
				return yield* attach(sessionId, entry);
			}).pipe(Effect.onError(() => stop(entry)));

		class ProcessClaudeSessionRunner implements ClaudeSessionRunner {
			readonly recoverEffect = Effect.gen(function* () {
				for (const registration of discoverClaudeRunners(deps.workspaceRoot)) {
					if (children.has(registration.sessionId)) continue;
					const entry: RunnerChild = {
						...registration,
						verified: false,
						stopping: false,
						recovering: true,
						ready: yield* Deferred.make<
							ClaudeRunnerSocket,
							ClaudeSessionFailure
						>(),
						stopped: yield* Deferred.make<void>(),
					};
					children.set(registration.sessionId, entry);
					let connected = yield* Effect.either(
						attach(registration.sessionId, entry),
					);
					// A previous server may still own the socket while its shutdown
					// drains. Rejected hellos do not prove that the runner is dead.
					for (
						let retry = 0;
						connected._tag === "Left" &&
						runnerPidAlive(registration.pid) &&
						retry < 4;
						retry++
					) {
						yield* Effect.sleep(100 * 2 ** retry);
						connected = yield* Effect.either(
							attach(registration.sessionId, entry),
						);
					}
					entry.recovering = false;
					if (connected._tag === "Left") {
						evict(registration.sessionId, entry);
						if (!runnerPidAlive(registration.pid)) {
							removeClaudeRunner(entry.socketPath);
							continue;
						}
						// Keep its registration, spool and approval ownership intact.
						// Startup must not orphan approvals or launch a second runner.
						return yield* Effect.fail(connected.left);
					}
					yield* Deferred.succeed(entry.ready, connected.right);
					if (sql) {
						const commands = yield* recoverClaudeRunnerCommands(
							sql,
							registration.sessionId,
							connected.right,
						).pipe(
							Effect.mapError((cause) =>
								claudeRunnerFailure("recover runner commands", cause),
							),
						);
						for (const command of commands)
							runFork(
								command.pipe(
									Effect.catchAllCause((cause) =>
										Effect.logError("Claude command recovery failed", cause),
									),
								),
							);
					}
				}
			});
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
							if (existing?.pid && !runnerPidAlive(existing.pid)) {
								evict(sessionId, existing);
								removeClaudeRunner(existing.socketPath);
							} else if (existing || command.type !== "send-turn")
								return existing;
							const runnerId = randomBytes(6).toString("hex");
							const created: RunnerChild = {
								ready: yield* Deferred.make<
									ClaudeRunnerSocket,
									ClaudeSessionFailure
								>(),
								stopped: yield* Deferred.make<void>(),
								stopping: false,
								verified: false,
								runnerId,
								socketPath: join(
									claudeRunnerDirectory(deps.workspaceRoot),
									runnerId,
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
					if (
						process.env["NODE_ENV"] === "test" &&
						process.env["CONDUIT_TEST_HOLD_RUNNER_OUTPUT"] === command.type
					) {
						const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
						if (proof)
							appendFileSync(
								proof,
								`${JSON.stringify({ kind: "held-output", type: command.type })}\n`,
							);
						yield* Effect.never;
					}
					// Retransmission keeps the original attempt; an intentional outbox
					// retry advances it and must be allowed to execute again.
					return yield* connection.commandEffect(
						commandId,
						payload,
						command.type === "send-turn"
							? command.input.commandAttempt
							: undefined,
					);
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
