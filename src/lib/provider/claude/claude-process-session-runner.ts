import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import { Cause, Deferred, Effect, Exit, FiberSet } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { isRecord } from "../../utils.js";
import { ClaudeRuntimeError } from "../event-sink-errors.js";
import type { HistoryMessage, TurnResult } from "../types.js";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";
import { connectClaudeRunner } from "./claude-runner-connection.js";
import {
	type ClaudeRunnerSocket,
	claudeRunnerBuildId,
	claudeRunnerFailure,
	claudeRunnerSinkId,
} from "./claude-runner-protocol.js";
import { makeClaudeRunnerReceiptStore } from "./claude-runner-receipts.js";
import { recoverClaudeRunnerCommands } from "./claude-runner-recovery.js";
import {
	claudeRunnerDirectory,
	discoverClaudeRunners,
	prepareClaudeRunnerDirectory,
	removeClaudeRunner,
	runnerPidAlive,
	runnerPidMatchesRegistration,
} from "./claude-runner-registry.js";
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
	stopSignalled?: boolean;
	ending: number;
	endingReleased?: Deferred.Deferred<void>;
	idleExiting: boolean;
	failure?: ClaudeSessionFailure;
	readonly runnerId: string;
	verified: boolean;
	listening?: boolean;
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

const stop = (
	entry: Pick<
		RunnerChild,
		| "ready"
		| "stopped"
		| "socketPath"
		| "stopping"
		| "stopSignalled"
		| "verified"
		| "pid"
		| "child"
		| "connection"
	>,
) =>
	Effect.gen(function* () {
		if (entry.stopping) {
			yield* Deferred.await(entry.stopped);
			// A late verified hello may arrive after an unverified stop.
			if (entry.stopSignalled || !entry.verified) return;
		}
		entry.stopping = true;
		const cleanup = Effect.async<void>((resume) => {
			entry.connection?.destroy();
			const child = entry.child;
			let force: ReturnType<typeof setTimeout> | undefined;
			let deadline: ReturnType<typeof setTimeout> | undefined;
			let exited: ReturnType<typeof setInterval> | undefined;
			const finish = () => {
				clearTimeout(force);
				clearTimeout(deadline);
				clearInterval(exited);
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
					entry.stopSignalled = true;
					process.kill(pid, signal);
				} catch {
					finish();
				}
			};
			force = setTimeout(() => {
				kill("SIGKILL");
				deadline = setTimeout(finish, 1000);
			}, 3000);
			if (!child) {
				exited = setInterval(() => {
					if (!runnerPidAlive(pid)) finish();
				}, 25);
				deadline = setTimeout(finish, 4100);
			}
			kill("SIGTERM");
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

/** Stop registered project runners for an explicit stop or project removal. */
export const stopRegisteredClaudeRunners = (
	workspaceRoot: string,
	configDir: string,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const registrations = yield* Effect.try({
				try: () => discoverClaudeRunners(workspaceRoot, configDir),
				catch: (cause) => new ClaudeRuntimeError({ message: String(cause) }),
			});
			const runFork = yield* FiberSet.makeRuntime<never, void, never>();
			const outcomes = yield* Effect.forEach(
				registrations,
				(registration) =>
					Effect.gen(function* () {
						const connection = yield* Effect.either(
							Effect.acquireRelease(
								connectClaudeRunner({
									...registration,
									deps: { workspaceRoot, daemonConfigDir: configDir },
									preserveRole: true,
									runFork: (effect) =>
										runFork(effect.pipe(Effect.interruptible)),
									// Relay scopes have drained. Do not acknowledge unpersisted output.
									emit: () => Effect.never,
									onHello: () => Effect.void,
									onClose: () => {},
								}),
								(connection) => Effect.sync(() => connection.destroy()),
							),
						);
						if (
							connection._tag === "Left" &&
							!runnerPidMatchesRegistration(registration)
						) {
							if (runnerPidAlive(registration.pid)) {
								log.warn(
									{ ...registration, cause: connection.left },
									"Leaving unverified Claude runner after failed hello",
								);
							} else {
								yield* Effect.sync(() =>
									removeClaudeRunner(registration.socketPath),
								);
							}
							return;
						}
						const ready = yield* Deferred.make<
							ClaudeRunnerSocket,
							ClaudeSessionFailure
						>();
						if (connection._tag === "Right")
							yield* Deferred.succeed(ready, connection.right);
						else yield* Deferred.fail(ready, connection.left);
						// A failed hello requires independent argv identity before signalling.
						yield* stop({
							ready,
							stopped: yield* Deferred.make<void>(),
							socketPath: registration.socketPath,
							pid: registration.pid,
							stopping: false,
							verified: true,
							...(connection._tag === "Right"
								? { connection: connection.right }
								: {}),
						});
						if (runnerPidAlive(registration.pid)) {
							return yield* new ClaudeRuntimeError({
								message: `Claude runner ${registration.runnerId} survived shutdown`,
							});
						}
					}).pipe(
						Effect.catchAll((error) =>
							runnerPidAlive(registration.pid)
								? Effect.fail(error)
								: Effect.sync(() =>
										removeClaudeRunner(registration.socketPath),
									),
						),
						Effect.exit,
					),
				{ concurrency: 4 },
			);
			const failures = outcomes.filter(Exit.isFailure);
			if (failures.length > 0) {
				return yield* new ClaudeRuntimeError({
					message: failures.map((exit) => Cause.pretty(exit.cause)).join("\n"),
				});
			}
		}),
	);

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
				inputId?: string;
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

		const evict = (sessionId: string, entry: RunnerChild) => {
			// A late close from an old child must not remove its replacement.
			if (children.get(sessionId) !== entry) return;
			children.delete(sessionId);
			for (const [sinkId, binding] of sinks)
				if (binding.sessionId === sessionId) sinks.delete(sinkId);
		};
		const releaseEntryWaiters = (
			entry: RunnerChild,
			cause: Cause.Cause<ClaudeSessionFailure>,
		) =>
			Effect.gen(function* () {
				yield* Deferred.failCause(entry.ready, cause);
				yield* Deferred.succeed(entry.drained, undefined);
				if (entry.endingReleased)
					yield* Deferred.succeed(entry.endingReleased, undefined);
			});
		const detach = (entry: RunnerChild) => {
			entry.connection?.destroy();
			entry.child?.unref();
			if (entry.child?.connected) entry.child.disconnect();
		};
		const shutdown = lock
			.withPermits(1)(
				Effect.gen(function* () {
					closing = true;
					const entries = [...children.values(), ...candidates];
					const release = Effect.forEach(
						entries,
						(entry) =>
							releaseEntryWaiters(
								entry,
								Cause.fail(
									claudeRunnerFailure(
										"shutdown",
										"Claude runners are shutting down",
									),
								),
							),
						{ discard: true },
					);
					return yield* Effect.forEach(
						entries,
						(entry) =>
							entry.pid === undefined ||
							(entry.child && !entry.listening && !entry.verified)
								? stop(entry)
								: Effect.sync(() => detach(entry)),
						{ discard: true, concurrency: 4 },
					).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								children.clear();
								sinks.clear();
							}),
						),
						Effect.ensuring(release),
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
				onOutputCommitted: (output) =>
					observeClaudeRunnerTurn(
						output,
						"sinkId" in output ? sinks.get(output.sinkId) : undefined,
					),
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
							binding?.inputId &&
							received.event.sessionId === binding.sessionId &&
							isRecord(received.event.data)
								? {
										...received,
										event: {
											...received.event,
											data: {
												...received.event.data,
												userMessageId: binding.inputId,
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
						const ownsEntry = () =>
							(entry.candidate
								? candidates.has(entry)
								: children.get(sessionId) === entry) &&
							!entry.failure &&
							!entry.stopping &&
							!closing;
						if (ownsEntry() && !connection.closed)
							entry.connection = connection;
						const ensureAttached = () =>
							Effect.suspend(() => {
								if (
									ownsEntry() &&
									entry.connection === connection &&
									!connection.closed
								)
									return Effect.void;
								connection.destroy();
								return Effect.fail(
									claudeRunnerFailure(
										"restore runner",
										"Claude runner attachment is no longer active",
									),
								);
							});
						yield* ensureAttached();
						entry.buildId = hello.buildId;
						entry.upgrade.state = hello.upgradeState;
						for (const binding of entry.candidate
							? []
							: (hello.bindings ?? [])) {
							let history: readonly HistoryMessage[] = [];
							let inputId: string | undefined;
							let messageId = "";
							let terminal = false;
							let pending = false;
							if (sql) {
								const rows = yield* sql<{
									payload_json: string;
									input_id: string | null;
									status: string;
									attempt_count: number;
									assistant_message_id: string | null;
									state: string | null;
								}>`SELECT outbox.payload_json, COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id, outbox.status, outbox.attempt_count, turns.assistant_message_id, turns.state
									FROM provider_command_outbox outbox
									LEFT JOIN turns ON turns.session_id = outbox.session_id
										AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
									WHERE outbox.command_id = ${binding.commandId ?? binding.sinkId} AND outbox.session_id = ${sessionId}`.pipe(
									Effect.mapError((cause) =>
										claudeRunnerFailure("restore runner history", cause),
									),
								);
								yield* ensureAttached();
								const row = rows[0];
								if (row) {
									const payload = JSON.parse(row.payload_json) as {
										history?: readonly HistoryMessage[];
									};
									history = payload.history ?? [];
									inputId = row.input_id ?? undefined;
									// Acknowledged events will not replay after adoption.
									messageId = row.assistant_message_id ?? "";
									terminal =
										row.state !== null &&
										row.state !== "pending" &&
										row.state !== "running";
									pending =
										row.status === "running" &&
										(binding.sinkId ===
											claudeRunnerSinkId(
												binding.commandId ?? binding.sinkId,
												row.attempt_count,
											) ||
											(inputId !== undefined &&
												binding.sinkId ===
													claudeRunnerSinkId(inputId, row.attempt_count)));
								}
							}
							const completed = pending
								? yield* Deferred.make<void>()
								: undefined;
							yield* ensureAttached();
							sinks.set(binding.sinkId, {
								sessionId,
								history,
								...(inputId ? { inputId } : {}),
								messageId,
								terminal,
								pending,
								accepted: true,
								releaseRequested: false,
								completed,
							});
						}
						for (const pending of entry.candidate
							? []
							: (hello.pendingOutputs ?? [])) {
							yield* ensureAttached();
							if (pending.sequence <= (hello.acknowledgedSequence ?? 0))
								yield* emit(pending.output, sessionId);
						}
						yield* ensureAttached();
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
						if (closing || entry.stopping)
							throw claudeRunnerFailure(
								"spawn runner",
								"Claude runners are shutting down",
							);
						prepareClaudeRunnerDirectory(deps.workspaceRoot, configDir);
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
						entry.child = child;
						entry.pid = child.pid;
						return child;
					},
					catch: (cause) => claudeRunnerFailure("spawn runner", cause),
				});
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
						entry.listening = true;
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
					Effect.sync(() => {
						detach(entry);
						failed(
							sessionId,
							entry,
							claudeRunnerFailure("spawn runner", Cause.squash(cause)),
						);
					}),
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
								Effect.suspend(() => (closing ? Effect.void : stop(old))).pipe(
									Effect.ensuring(Effect.sync(() => candidates.delete(old))),
								),
							);
							return true;
						}),
					);
				}),
			stop: (entry) =>
				Effect.suspend(() => (closing ? Effect.void : stop(entry))).pipe(
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
				if (closing)
					return yield* Effect.fail(
						claudeRunnerFailure(
							"recover runner",
							"Claude runners are shutting down",
						),
					);
				for (const registration of discoverClaudeRunners(
					deps.workspaceRoot,
					configDir,
				)) {
					let abandoned =
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
					yield* lock.withPermits(1)(
						Effect.gen(function* () {
							if (closing)
								return yield* Effect.fail(
									claudeRunnerFailure(
										"recover runner",
										"Claude runners are shutting down",
									),
								);
							abandoned ||= children.has(registration.sessionId);
							entry.candidate = abandoned;
							if (abandoned) candidates.add(entry);
							else children.set(registration.sessionId, entry);
						}),
					);
					const ensureRecovering = Effect.suspend(() =>
						!closing &&
						!entry.stopping &&
						!entry.failure &&
						(entry.candidate
							? candidates.has(entry)
							: children.get(registration.sessionId) === entry)
							? Effect.void
							: Effect.fail(
									claudeRunnerFailure(
										"recover runner",
										"Claude runner recovery is no longer active",
									),
								),
					);
					yield* Effect.gen(function* () {
						yield* ensureRecovering;
						let connected = yield* Effect.either(
							attach(registration.sessionId, entry),
						);
						yield* ensureRecovering;
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
							yield* ensureRecovering;
							connected = yield* Effect.either(
								attach(registration.sessionId, entry),
							);
							yield* ensureRecovering;
						}
						if (connected._tag === "Left" || connected.right.closed) {
							const failure =
								connected._tag === "Left"
									? connected.left
									: claudeRunnerFailure(
											"recover runner",
											"Claude runner disconnected during recovery",
										);
							if (!runnerPidAlive(registration.pid)) {
								entry.recovering = false;
								entry.failure = {
									...failure,
									code: "runner_recovery_abandoned",
								};
								evict(registration.sessionId, entry);
								candidates.delete(entry);
								yield* releaseEntryWaiters(entry, Cause.fail(entry.failure));
								removeClaudeRunner(entry.socketPath);
								return;
							}
							// Keep its registration, spool and approval ownership intact.
							// Startup must not orphan approvals or launch a second runner.
							return yield* Effect.fail(failure);
						}
						if (abandoned) {
							entry.recovering = false;
							yield* Deferred.succeed(entry.ready, connected.right);
							yield* Effect.suspend(() =>
								closing ? Effect.void : stop(entry),
							).pipe(
								Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
								Effect.ensuring(Effect.sync(() => candidates.delete(entry))),
							);
							return;
						}
						const commands = sql
							? yield* recoverClaudeRunnerCommands(
									sql,
									registration.sessionId,
									connected.right,
									(sinkId, failure) => {
										const binding = sinks.get(sinkId);
										if (!binding?.pending) return Effect.void;
										return entry.outputs.withPermits(1)(
											failClaudeRunnerTurn(
												(output) => emit(output, registration.sessionId),
												sinkId,
												binding,
												failure,
											).pipe(
												Effect.ensuring(
													Effect.sync(() => sinks.delete(sinkId)),
												),
											),
										);
									},
									() => closing,
									deps,
									(commandId, inputId, attempt) => {
										const sinkId = claudeRunnerSinkId(inputId, attempt);
										return sinks.has(sinkId)
											? sinkId
											: claudeRunnerSinkId(commandId, attempt);
									},
								).pipe(
									Effect.mapError((cause) =>
										claudeRunnerFailure("recover runner commands", cause),
									),
								)
							: [];
						yield* lock.withPermits(1)(
							Effect.gen(function* () {
								yield* ensureRecovering;
								entry.commandsInFlight += commands.length;
								for (const command of commands) {
									let binding = sinks.get(command.sinkId);
									// The server can persist admission before the runner sees it.
									if (!binding) {
										binding = {
											sessionId: registration.sessionId,
											history: command.input.history,
											inputId: command.input.inputId,
											messageId: command.messageId,
											terminal: command.terminal,
											pending: true,
											accepted: false,
											releaseRequested: false,
											completed: yield* Deferred.make<void>(),
										};
										sinks.set(command.sinkId, binding);
									}
									runFork(
										command.wait.pipe(
											Effect.tap(() => {
												if (
													!binding ||
													sinks.get(command.sinkId) !== binding ||
													closing
												)
													return Effect.void;
												return entry.outputs.withPermits(1)(
													Effect.gen(function* () {
														binding.pending = false;
														if (binding.releaseRequested || entry.failure) {
															yield* emit(
																{
																	type: "release-sink",
																	sinkId: command.sinkId,
																},
																registration.sessionId,
															);
															sinks.delete(command.sinkId);
														}
													}),
												);
											}),
											Effect.ensuring(
												binding?.completed
													? Deferred.succeed(binding.completed, undefined)
													: Effect.void,
											),
											Effect.catchAllCause((cause) =>
												Effect.logError(
													"Claude command recovery failed",
													cause,
												),
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
								// Waiters own restored turns before commands or close callbacks run.
								entry.recovering = false;
								yield* Deferred.succeed(entry.ready, connected.right);
								if (connected.right.closed)
									failed(
										registration.sessionId,
										entry,
										claudeRunnerFailure(
											"recover runner",
											"Claude runner disconnected during recovery",
										),
									);
								else upgrade(registration.sessionId, entry);
							}),
						);
					}).pipe(
						Effect.onExit((exit) => {
							if (exit._tag === "Success") return Effect.void;
							entry.recovering = false;
							entry.failure = claudeRunnerFailure(
								"recover runner",
								Cause.squash(exit.cause),
							);
							entry.connection?.destroy();
							evict(registration.sessionId, entry);
							candidates.delete(entry);
							return releaseEntryWaiters(entry, exit.cause);
						}),
					);
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
								inputId: command.input.inputId,
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
				let latestResumeSessionId: string | undefined;
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
									existing &&
									(command.type === "send-turn" || command.type === "pre-warm")
								) {
									const launch = existing.upgrade.state?.snapshot?.input;
									const previousExtra = launch?.extraFolders ?? [];
									const nextExtra = command.input.extraFolders ?? [];
									const foldersChanged =
										launch !== undefined &&
										(launch.workspaceRoot !== command.input.workspaceRoot ||
											previousExtra.length !== nextExtra.length ||
											previousExtra.some(
												(folder, index) => folder !== nextExtra[index],
											));
									if (foldersChanged && command.type === "pre-warm")
										return { entry: undefined, draining: false };
									if (
										foldersChanged &&
										!existing.failure &&
										!existing.recovering &&
										!existing.stopping &&
										!existing.idleExiting &&
										existing.ending === 0 &&
										existing.commandsInFlight === 0 &&
										existing.upgrade.state?.quiescent === true
									) {
										existing.endingReleased = yield* Deferred.make<void>();
										existing.ending++;
										return {
											entry: existing,
											draining: true,
											retire: existing,
										};
									}
								}
								if (
									command.type === "pre-warm" &&
									existing &&
									(existing.failure ||
										existing.recovering ||
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
										if (
											command.type === "send-turn" ||
											command.type === "apply-live-settings" ||
											command.type === "set-permission-mode"
										)
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
										Effect.onExit((exit) => Deferred.done(created.ready, exit)),
										Effect.ignore,
										Effect.asVoid,
									),
								);
								return { entry: created, draining: false };
							}),
						);
						entry = selection.entry;
						draining = selection.draining;
						if (selection.retire) {
							const retiring = selection.retire;
							yield* runner
								.executeEffect({ type: "end-session", sessionId })
								.pipe(
									Effect.ensuring(
										Effect.gen(function* () {
											if (--retiring.ending === 0 && retiring.endingReleased)
												yield* Deferred.succeed(
													retiring.endingReleased,
													undefined,
												);
										}),
									),
									Effect.uninterruptible,
								);
							latestResumeSessionId =
								retiring.upgrade.state?.resumeSessionId ??
								latestResumeSessionId;
						}
						// Old cleanup is session-wide. Finish it before a replacement
						// can register interactions or publish a new busy status.
						if (entry && draining)
							yield* Deferred.await(
								!entry.failure && !entry.idleExiting && selection.admission
									? selection.admission
									: entry.drained,
							);
						if (entry && draining)
							latestResumeSessionId =
								entry.upgrade.state?.resumeSessionId ?? latestResumeSessionId;
					} while (draining);
					if (!entry) return;
					child = entry;
					const connection = yield* Deferred.await(entry.ready);
					if (
						command.type === "pre-warm" &&
						(entry.failure ||
							entry.recovering ||
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
									input: {
										...command.input,
										history: [],
										providerState: latestResumeSessionId
											? {
													...command.input.providerState,
													resumeSessionId: latestResumeSessionId,
												}
											: command.input.providerState,
									},
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
					let commandId =
						command.type === "send-turn" ? command.input.inputId : randomUUID();
					if (
						command.type === "send-turn" &&
						sql &&
						command.input.commandAttempt !== undefined
					) {
						// A legacy retry can retain an outbox command id distinct from
						// its normalized input id. Preserve it for runner reattachment.
						const rows = yield* sql<{
							command_id: string;
						}>`SELECT command_id FROM provider_command_outbox
							WHERE session_id = ${sessionId} AND effect_type = 'send_turn'
								AND status = 'running' AND attempt_count = ${command.input.commandAttempt}
								AND COALESCE(json_extract(payload_json, '$.inputId'), json_extract(payload_json, '$.userMessageId'), json_extract(payload_json, '$.commandId'), json_extract(payload_json, '$.turnId')) = ${command.input.inputId}
							ORDER BY request_sequence LIMIT 1`.pipe(
							Effect.mapError((cause) =>
								claudeRunnerFailure("resolve runner command", cause),
							),
						);
						commandId = rows[0]?.command_id ?? commandId;
					}
					if (command.type === "end-session") {
						const bindings = [...sinks.values()].filter(
							(binding) => binding.sessionId === sessionId,
						);
						return yield* connection.commandEffect(commandId, payload).pipe(
							Effect.ensuring(
								stop(entry).pipe(
									Effect.andThen(
										Effect.suspend(() =>
											entry.failure
												? Deferred.await(entry.drained)
												: Effect.forEach(
														bindings.filter(
															(binding) =>
																!entry.idleExiting || binding.accepted,
														),
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
							latestResumeSessionId =
								admitted.upgrade.state?.resumeSessionId ??
								latestResumeSessionId;
							admitted.commandsInFlight--;
							upgrade(admittedSessionId, admitted);
							admitted = undefined;
						}),
					),
					Effect.retry({
						while: (failure) =>
							(failure.code === "runner_idle_exit" ||
								failure.code === "runner_recovery_abandoned") &&
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
							closing ||
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
		const runner = new ProcessClaudeSessionRunner();
		return runner;
	});
