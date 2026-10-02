import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import { Cause, Deferred, Effect, FiberSet } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { isRecord } from "../../utils.js";
import type { HistoryMessage, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import { connectClaudeRunner } from "./claude-runner-connection.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerBuildId,
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
import {
	failClaudeRunnerTurn,
	observeClaudeRunnerTurn,
} from "./claude-runner-turn-failure.js";
import {
	type ClaudeRunnerUpgrade,
	makeClaudeRunnerUpgrade,
} from "./claude-runner-upgrade.js";
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
	readonly runnerId: string;
	verified: boolean;
	recovering?: boolean;
	pid?: number | undefined;
	child?: ChildProcess;
	connection?: ClaudeRunnerSocket;
	buildId?: string;
	candidate?: boolean;
	commandsInFlight: number;
	readonly upgrade: ClaudeRunnerUpgrade;
}

const log = createLogger("claude-process-session-runner");

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
		const configDir = resolve(deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR);
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const sql = sqlOption._tag === "Some" ? sqlOption.value : undefined;
		const receipts = sql
			? yield* makeClaudeRunnerReceiptStore(sql).pipe(Effect.orDie)
			: undefined;
		const children = new Map<string, RunnerChild>();
		const candidates = new Set<RunnerChild>();
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
		const upgradeMark = (
			sessionId: string,
			old: RunnerChild,
			phase: "warming" | "cancelled" | "failed" | "switched",
			replacement?: RunnerChild,
		) => {
			if (process.env["NODE_ENV"] !== "test" || !process.connected) return;
			const mark = {
				channel: "conduit-process-test",
				kind: "runner-upgrade",
				phase,
				sessionId,
				oldPid: old.pid,
				...(replacement?.pid ? { newPid: replacement.pid } : {}),
				at: process.hrtime.bigint().toString(),
			};
			const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
			if (proof) appendFileSync(proof, `${JSON.stringify(mark)}\n`);
			process.send?.(mark);
		};

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
						}).pipe(
							Effect.andThen(
								Effect.forEach([...candidates], stop, {
									discard: true,
									concurrency: 4,
								}),
							),
						);
					return Effect.forEach([...children.values(), ...candidates], stop, {
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

		const failed = (
			sessionId: string,
			entry: RunnerChild,
			failure: ClaudeSessionFailure,
		) => {
			const wasReady = entry.connection !== undefined;
			if (failure.code === "runner_idle_exit") entry.idleExiting = true;
			if (entry.stopping || entry.recovering || entry.failure || closing)
				return;
			entry.failure = failure;
			if (entry.candidate) return;
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

		const attach = (sessionId: string, entry: RunnerChild) =>
			connectClaudeRunner({
				socketPath: entry.socketPath,
				sessionId,
				runnerId: entry.runnerId,
				...(entry.pid !== undefined ? { pid: entry.pid } : {}),
				helloTimeoutMs: entry.child ? 10_000 : 2000,
				...(entry.candidate ? { preserveRole: true } : {}),
				deps: { ...deps, daemonConfigDir: configDir },
				...(receipts ? { receipts } : {}),
				runFork,
				emit: (received) => {
					const operation = Effect.suspend(() => {
						// A retired query's shutdown notices must not clear its replacement.
						if (
							entry.stopping &&
							children.get(sessionId) !== entry &&
							(received.type === "background-task" ||
								received.type === "cancel-interactions" ||
								(received.type === "event" &&
									received.event.type === "session.status"))
						)
							return Effect.succeed({});
						const binding =
							"sinkId" in received ? sinks.get(received.sinkId) : undefined;
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
						if (output.type === "read-turn-history")
							return binding
								? Effect.succeed({ history: binding.history })
								: Effect.fail(
										claudeRunnerFailure(
											output.type,
											"Claude turn history is no longer available",
										),
									);
						if (output.type === "release-sink" && binding?.pending) {
							binding.releaseRequested = true;
							return Effect.succeed({});
						}
						return emit(output, sessionId).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									observeClaudeRunnerTurn(output, binding);
									if (output.type === "release-sink")
										sinks.delete(output.sinkId);
								}),
							),
						);
					});
					return received.type === "materialize-subagents" ||
						received.type === "ensure-subagent-session" ||
						received.type === "read-turn-history"
						? operation
						: entry.outputs.withPermits(1)(operation);
				},
				onHello: (hello, connection) =>
					Effect.gen(function* () {
						entry.verified = true;
						entry.pid = hello.pid;
						entry.connection = connection;
						entry.buildId = hello.buildId;
						entry.upgrade.state = hello.upgradeState;
						for (const binding of entry.candidate
							? []
							: (hello.bindings ?? [])) {
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
							sinks.set(binding.sinkId, {
								sessionId,
								history,
								messageId: "",
								terminal: false,
								pending: false,
								accepted: true,
								releaseRequested: false,
								completed: undefined,
							});
						}
						for (const pending of entry.candidate
							? []
							: (hello.pendingOutputs ?? []))
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
				onCommandAccepted: (sinkId) => {
					const binding = sinks.get(sinkId);
					if (binding) binding.accepted = true;
				},
				onUpgradeState: (state) => {
					entry.upgrade.state = { ...entry.upgrade.state, ...state };
					upgrade(sessionId, entry);
				},
				onIdleExit: () => {
					entry.idleExiting = true;
					if (process.env["NODE_ENV"] === "test" && process.connected)
						process.send?.({
							channel: "conduit-process-test",
							kind: "runner-idle-exit-started",
							pid: entry.pid,
						});
				},
				onClose: (failure) => failed(sessionId, entry, failure),
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
						mkdirSync(claudeRunnerDirectory(deps.workspaceRoot, configDir), {
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
								...(entry.candidate ? ["upgrade"] : []),
							],
							{
								cwd: deps.workspaceRoot,
								env: { ...process.env, CONDUIT_CONFIG_DIR: configDir },
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
					failed(
						sessionId,
						entry,
						claudeRunnerFailure("spawn runner", "Claude runner exited"),
					);
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
			}).pipe(
				Effect.onError((cause) =>
					Effect.sync(() =>
						failed(
							sessionId,
							entry,
							claudeRunnerFailure("spawn runner", Cause.squash(cause)),
						),
					).pipe(Effect.andThen(stop(entry))),
				),
			);

		const createEntry = (): Effect.Effect<RunnerChild> =>
			Effect.gen(function* () {
				const runnerId = randomBytes(6).toString("hex");
				return {
					verified: false,
					runnerId,
					ready: yield* Deferred.make<
						ClaudeRunnerSocket,
						ClaudeSessionFailure
					>(),
					stopped: yield* Deferred.make<void>(),
					drained: yield* Deferred.make<void>(),
					stopping: false,
					ending: 0,
					idleExiting: false,
					commandsInFlight: 0,
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
					outputs: yield* Effect.makeSemaphore(1),
					socketPath: join(
						claudeRunnerDirectory(deps.workspaceRoot, configDir),
						runnerId,
					),
				} satisfies RunnerChild;
			});
		const eligible = (sessionId: string, entry: RunnerChild) =>
			!closing &&
			children.get(sessionId) === entry &&
			!entry.failure &&
			!entry.recovering &&
			!entry.stopping &&
			!entry.idleExiting &&
			entry.ending === 0 &&
			entry.commandsInFlight === 0 &&
			entry.buildId !== undefined &&
			entry.buildId !== claudeRunnerBuildId() &&
			entry.upgrade.state?.quiescent === true &&
			entry.upgrade.state.snapshot !== undefined;
		const upgrade = makeClaudeRunnerUpgrade<RunnerChild>({
			eligible,
			runFork,
			create: (_sessionId, old) =>
				createEntry().pipe(
					Effect.tap((entry) =>
						Effect.sync(() => {
							entry.candidate = true;
							entry.upgrade.state = old.upgrade.state;
							candidates.add(entry);
						}),
					),
				),
			warm: (sessionId, old, replacement) =>
				Effect.gen(function* () {
					const state = old.upgrade.state;
					const snapshot = state?.snapshot;
					if (!snapshot)
						return yield* Effect.fail(
							claudeRunnerFailure(
								"upgrade runner",
								"Session launch snapshot is missing",
							),
						);
					const connection = yield* start(sessionId, replacement);
					yield* Deferred.succeed(replacement.ready, connection);
					upgradeMark(sessionId, old, "warming", replacement);
					const { model, contextWindow, variant, permissionMode, ...launch } =
						snapshot.input;
					yield* connection.commandEffect(randomUUID(), {
						type: "pre-warm",
						sessionId,
						input: {
							...launch,
							...(state.liveConfiguration ?? {
								...(model ? { model } : {}),
								...(contextWindow ? { contextWindow } : {}),
								...(variant ? { variant } : {}),
								...(permissionMode ? { permissionMode } : {}),
							}),
							providerState: {
								...snapshot.input.providerState,
								...(state.resumeSessionId
									? { resumeSessionId: state.resumeSessionId }
									: {}),
							},
						},
						claudeSettingsOverrides: snapshot.claudeSettingsOverrides,
						shellEnv: snapshot.options.env ?? {},
						settingsSnapshot: snapshot,
					});
				}),
			commit: (sessionId, old, replacement, activity) =>
				Effect.gen(function* () {
					// A replacement cannot dedupe an old turn whose outbox completion
					// has not committed yet. Check this off the admission path.
					if (sql) {
						for (let retry = 0; ; retry++) {
							if (
								activity !== old.upgrade.activity ||
								!eligible(sessionId, old)
							)
								return false;
							const running = yield* sql<{
								command_id: string;
							}>`SELECT command_id FROM provider_command_outbox WHERE session_id = ${sessionId} AND status = 'running' AND effect_type = 'send_turn' LIMIT 1`.pipe(
								Effect.mapError((cause) =>
									claudeRunnerFailure("upgrade runner", cause),
								),
							);
							if (running.length === 0) break;
							if (retry === 99) return false;
							yield* Effect.sleep(10);
						}
					}
					const revision = yield* lock.withPermits(1)(
						Effect.sync(() => {
							if (
								activity !== old.upgrade.activity ||
								!eligible(sessionId, old) ||
								replacement.failure ||
								replacement.connection?.closed
							)
								return undefined;
							return old.upgrade.state?.revision;
						}),
					);
					const connection = old.connection;
					if (revision === undefined || !connection) return false;
					// The runner validates work and its revision atomically before retirement.
					const retired = yield* connection.retireEffect(revision).pipe(
						Effect.timeoutFail({
							duration: "1 second",
							onTimeout: () =>
								claudeRunnerFailure(
									"upgrade runner",
									"Retirement confirmation timed out",
								),
						}),
						Effect.onError(() =>
							Effect.sync(() => connection.write({ type: "upgrade-cancel" })),
						),
					);
					if (!retired) return false;
					return yield* lock.withPermits(1)(
						Effect.sync(() => {
							if (
								activity !== old.upgrade.activity ||
								!eligible(sessionId, old) ||
								replacement.failure ||
								replacement.connection?.closed
							) {
								connection.write({ type: "upgrade-cancel" });
								return false;
							}
							replacement.candidate = false;
							replacement.connection?.write({ type: "upgrade-activate" });
							children.set(sessionId, replacement);
							candidates.delete(replacement);
							candidates.add(old);
							upgradeMark(sessionId, old, "switched", replacement);
							runFork(
								stop(old).pipe(
									Effect.ensuring(Effect.sync(() => candidates.delete(old))),
								),
							);
							return true;
						}),
					);
				}),
			stop: (entry) =>
				stop(entry).pipe(
					Effect.ensuring(Effect.sync(() => candidates.delete(entry))),
				),
			failed: (sessionId, old, cause) => {
				log.warn(
					`Claude runner upgrade deferred for session ${sessionId}: ${claudeRunnerFailure("upgrade runner", cause).message}`,
				);
				upgradeMark(sessionId, old, "failed");
			},
			cancelled: (sessionId, old, replacement) =>
				upgradeMark(sessionId, old, "cancelled", replacement),
		});

		class ProcessClaudeSessionRunner implements ClaudeSessionRunner {
			readonly recoverEffect = Effect.gen(function* () {
				for (const registration of discoverClaudeRunners(
					deps.workspaceRoot,
					configDir,
				)) {
					const abandoned =
						registration.role === "candidate" ||
						children.has(registration.sessionId);
					const entry: RunnerChild = {
						...registration,
						verified: false,
						candidate: abandoned,
						stopping: false,
						recovering: true,
						ending: 0,
						idleExiting: false,
						commandsInFlight: 0,
						upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
						outputs: yield* Effect.makeSemaphore(1),
						drained: yield* Deferred.make<void>(),
						ready: yield* Deferred.make<
							ClaudeRunnerSocket,
							ClaudeSessionFailure
						>(),
						stopped: yield* Deferred.make<void>(),
					};
					if (abandoned) candidates.add(entry);
					else children.set(registration.sessionId, entry);
					let connected = yield* Effect.either(
						attach(registration.sessionId, entry),
					);
					// A previous server may still own the socket while its shutdown
					// drains. Rejected hellos do not prove that the runner is dead.
					for (
						let retry = 0;
						(connected._tag === "Left" || connected.right.closed) &&
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
					if (connected._tag === "Left" || connected.right.closed) {
						evict(registration.sessionId, entry);
						if (!runnerPidAlive(registration.pid)) {
							removeClaudeRunner(entry.socketPath);
							continue;
						}
						// Keep its registration, spool and approval ownership intact.
						// Startup must not orphan approvals or launch a second runner.
						return yield* Effect.fail(
							connected._tag === "Left"
								? connected.left
								: claudeRunnerFailure(
										"recover runner",
										"Claude runner disconnected during recovery",
									),
						);
					}
					yield* Deferred.succeed(entry.ready, connected.right);
					if (abandoned) {
						yield* stop(entry);
						candidates.delete(entry);
						continue;
					}
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
						entry.commandsInFlight += commands.length;
						for (const command of commands)
							runFork(
								command.pipe(
									Effect.catchAllCause((cause) =>
										Effect.logError("Claude command recovery failed", cause),
									),
									Effect.ensuring(
										Effect.sync(() => {
											entry.commandsInFlight--;
											upgrade(registration.sessionId, entry);
										}),
									),
								),
							);
					}
					upgrade(registration.sessionId, entry);
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
				let admitted: RunnerChild | undefined;
				let admittedSessionId = "";
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
					admittedSessionId = sessionId;
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
								if (
									command.type === "pre-warm" &&
									existing &&
									(existing.failure ||
										existing.idleExiting ||
										existing.stopping ||
										existing.ending > 0)
								)
									return { entry: undefined, draining: false };
								if (
									existing ||
									(command.type !== "send-turn" && command.type !== "pre-warm")
								) {
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
									if (existing && !draining) {
										existing.commandsInFlight++;
										admitted = existing;
										if (command.type === "send-turn")
											existing.upgrade.activity++;
									}
									return {
										entry: existing,
										draining,
										admission: existing?.endingReleased,
									};
								}
								const created: RunnerChild = yield* createEntry();
								created.commandsInFlight++;
								admitted = created;
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
					if (
						command.type === "pre-warm" &&
						(entry.failure ||
							entry.idleExiting ||
							entry.stopping ||
							entry.ending > 0)
					)
						return;
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
									...(entry.upgrade.state?.frozen
										? {
												claudeSettingsOverrides:
													entry.upgrade.state.snapshot?.claudeSettingsOverrides,
											}
										: {}),
									shellEnv: (entry.upgrade.state?.frozen
										? entry.upgrade.state.snapshot?.options.env
										: undefined) ??
										deps.shellEnv?.(command.input.workspaceRoot) ?? {
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
					return yield* connection
						.commandEffect(
							commandId,
							payload,
							command.type === "send-turn"
								? command.input.commandAttempt
								: undefined,
						)
						.pipe(
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
					Effect.ensuring(
						Effect.sync(() => {
							if (!admitted) return;
							admitted.commandsInFlight--;
							upgrade(admittedSessionId, admitted);
							admitted = undefined;
						}),
					),
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
					Effect.catchAll((failure) =>
						command.type === "pre-warm" &&
						(closing ||
							failure.code === "runner_idle_exit" ||
							child?.failure ||
							child?.idleExiting ||
							child?.stopping ||
							(child?.ending ?? 0) > 0)
							? Effect.succeed(undefined)
							: Effect.fail(failure),
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
