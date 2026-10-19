import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "@effect/sql";
import { Cause, Data, Deferred, Effect, Exit, FiberSet } from "effect";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { isRecord } from "../../utils.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
import { connectRunner } from "./runner-connection.js";
import {
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
	runnerSinkId,
} from "./runner-protocol.js";
import { makeRunnerReceiptStore } from "./runner-receipts.js";
import type { recoverRunnerCommands } from "./runner-recovery.js";
import {
	discoverRunners,
	prepareRunnerDirectory,
	removeRunner,
	runnerDirectory,
	runnerPidAlive,
	runnerPidMatchesRegistration,
} from "./runner-registry.js";
import { failRunnerTurn, observeRunnerTurn } from "./runner-turn-failure.js";
import { makeRunnerUpgrade, type RunnerUpgrade } from "./runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
} from "./session-runner.js";

interface RunnerChild {
	readonly ready: Deferred.Deferred<RunnerSocket, SessionFailure>;
	readonly stopped: Deferred.Deferred<void>;
	readonly drained: Deferred.Deferred<void>;
	readonly socketPath: string;
	readonly outputs: Effect.Semaphore;
	stopping: boolean;
	stopSignalled?: boolean;
	ending: number;
	endingReleased?: Deferred.Deferred<void>;
	idleExiting: boolean;
	failure?: SessionFailure;
	readonly runnerId: string;
	verified: boolean;
	listening?: boolean;
	recovering?: boolean;
	pid?: number | undefined;
	child?: ChildProcess;
	connection?: RunnerSocket;
	buildId?: string;
	stopsTasks?: boolean;
	draftPreWarm?: boolean;
	candidate?: boolean;
	commandsInFlight: number;
	readonly upgrade: RunnerUpgrade;
}

export class RunnerProcessError extends Data.TaggedError("RunnerProcessError")<{
	readonly message: string;
}> {}

interface ProcessRunnerDeps {
	readonly workspaceRoot: string;
	readonly daemonConfigDir?: string;
	readonly shellEnv?: (
		directory: string,
	) => Readonly<Record<string, string | undefined>>;
	readonly prepareShellEnv?: (directory: string) => Promise<boolean>;
}

export interface ProcessRunnerDriver {
	readonly driverKind: string;
	readonly connect: typeof connectRunner;
	readonly settingsDeferredCode: string;
	readonly warmCommand: (
		sessionId: string,
		state: import("./runner-upgrade.js").RunnerUpgradeState,
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot,
	) => Extract<SessionCommand, { type: "pre-warm" }>;
	readonly snapshotCommandSettings: (
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot | undefined,
	) => import("../claude/claude-runner-snapshot.js").RunnerCommandSettings;
	readonly sameAccountLogin: (
		a: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
		},
		b: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
		},
	) => boolean;
	readonly recoverCommands: (
		sql: SqlClient.SqlClient,
		sessionId: string,
		connection: RunnerSocket,
		failTurn: (sinkId: string, failure: SessionFailure) => Effect.Effect<void>,
		closing: () => boolean,
		liveSession: Effect.Effect<ProviderNativeSession | undefined>,
		resolveSinkId: (
			commandId: string,
			inputId: string,
			attempt: number,
			nativeResumeFallback?: boolean,
		) => string,
	) => Effect.Effect<
		Effect.Effect.Success<
			ReturnType<
				typeof recoverRunnerCommands<
					import("./session-runner.js").SessionTurn,
					unknown
				>
			>
		>,
		unknown
	>;
}

const log = createLogger("process-session-runner");

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
						removeRunner(entry.socketPath);
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
export const stopRegisteredRunners = (
	workspaceRoot: string,
	configDir: string,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			const registrations = yield* Effect.try({
				try: () => discoverRunners(workspaceRoot, configDir),
				catch: (cause) => new RunnerProcessError({ message: String(cause) }),
			});
			const runFork = yield* FiberSet.makeRuntime<never, void, never>();
			const outcomes = yield* Effect.forEach(
				registrations,
				(registration) =>
					Effect.gen(function* () {
						const connection = yield* Effect.either(
							Effect.acquireRelease(
								connectRunner({
									...registration,
									driverKind: registration.driverKind ?? "claude",
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
									{
										...registration,
										driverKind: registration.driverKind ?? "claude",
										cause: connection.left,
									},
									"Leaving unverified Runner after failed hello",
								);
							} else {
								yield* Effect.sync(() => removeRunner(registration.socketPath));
							}
							return;
						}
						const ready = yield* Deferred.make<RunnerSocket, SessionFailure>();
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
							return yield* new RunnerProcessError({
								message: `Runner ${registration.runnerId} survived shutdown`,
							});
						}
					}).pipe(
						Effect.catchAll((error) =>
							runnerPidAlive(registration.pid)
								? Effect.fail(error)
								: Effect.sync(() => removeRunner(registration.socketPath)),
						),
						Effect.exit,
					),
				{ concurrency: 4 },
			);
			const failures = outcomes.filter(Exit.isFailure);
			if (failures.length > 0) {
				return yield* new RunnerProcessError({
					message: failures.map((exit) => Cause.pretty(exit.cause)).join("\n"),
				});
			}
		}),
	);

export const makeProcessSessionRunner = (
	deps: ProcessRunnerDeps,
	emit: (
		output: SessionOutput,
		sessionId?: string,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
	driver: ProcessRunnerDriver,
) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const runnerLabel = `${driver.driverKind.charAt(0).toUpperCase()}${driver.driverKind.slice(1)} runner`;
		const lock = yield* Effect.makeSemaphore(1);
		const configDir = resolve(deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR);
		const startupTimeoutMs =
			process.env["NODE_ENV"] === "test"
				? Number(
						process.env["CONDUIT_TEST_RUNNER_STARTUP_TIMEOUT_MS"] ?? 10_000,
					)
				: 10_000;
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const sql = sqlOption._tag === "Some" ? sqlOption.value : undefined;
		const receipts = sql
			? yield* makeRunnerReceiptStore(sql).pipe(Effect.orDie)
			: undefined;
		const children = new Map<string, RunnerChild>();
		const candidates = new Set<RunnerChild>();
		const sinks = new Map<
			string,
			{
				sessionId: string;
				/** The turn's user message: a continuation's is its cut-off message. */
				userMessageId?: string;
				/** What a failed send places when the SDK never started it. */
				placement?: { inputId: string; text: string };
				messageId: string;
				terminal: boolean;
				pending: boolean;
				accepted: boolean;
				admission?: Deferred.Deferred<void>;
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
			cause: Cause.Cause<SessionFailure>,
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
									runnerFailure("shutdown", "Runners are shutting down"),
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
			failure: SessionFailure,
		) => {
			const wasReady = entry.connection !== undefined;
			if (failure.code === "runner_idle_exit") entry.idleExiting = true;
			if (entry.stopping || entry.recovering || entry.failure || closing)
				return;
			entry.failure = failure;
			runFork(Deferred.fail(entry.ready, failure));
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
					`${runnerLabel} failed for session ${sessionId}: ${failure.message}`,
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
			driver.connect({
				driverKind: driver.driverKind,
				socketPath: entry.socketPath,
				sessionId,
				runnerId: entry.runnerId,
				...(entry.pid !== undefined ? { pid: entry.pid } : {}),
				helloTimeoutMs: entry.child ? startupTimeoutMs : 2000,
				...(entry.candidate ? { preserveRole: true } : {}),
				deps: { ...deps, daemonConfigDir: configDir },
				...(receipts ? { receipts } : {}),
				runFork,
				onOutputCommitted: (output) =>
					observeRunnerTurn(
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
						if (output.type === "release-sink" && binding?.pending) {
							binding.releaseRequested = true;
							return Effect.succeed({});
						}
						return emit(output, sessionId).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									observeRunnerTurn(output, binding);
									if (output.type === "release-sink")
										sinks.delete(output.sinkId);
								}),
							),
						);
					});
					return received.type === "ensure-subagent-session"
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
									runnerFailure(
										"restore runner",
										"Runner attachment is no longer active",
									),
								);
							});
						yield* ensureAttached();
						entry.buildId = hello.buildId;
						entry.stopsTasks = hello.stopsTasks === true;
						entry.upgrade.state = hello.upgradeState;
						for (const binding of entry.candidate
							? []
							: (hello.bindings ?? [])) {
							let inputId: string | undefined;
							let userMessageId: string | undefined;
							let messageId = "";
							let terminal = false;
							let pending = false;
							if (sql) {
								const rows = yield* sql<{
									input_id: string | null;
									user_message_id: string | null;
									status: string;
									attempt_count: number;
									assistant_message_id: string | null;
									state: string | null;
								}>`SELECT COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id,
									COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS user_message_id,
									outbox.status, outbox.attempt_count, turns.assistant_message_id, turns.state
									FROM provider_command_outbox outbox
									LEFT JOIN turns ON turns.session_id = outbox.session_id
										AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
									WHERE outbox.command_id = ${binding.commandId ?? binding.sinkId} AND outbox.session_id = ${sessionId}`.pipe(
									Effect.mapError((cause) =>
										runnerFailure("restore runner history", cause),
									),
								);
								yield* ensureAttached();
								const row = rows[0];
								if (row) {
									inputId = row.input_id ?? undefined;
									userMessageId = row.user_message_id ?? undefined;
									// Acknowledged events will not replay after adoption.
									messageId = row.assistant_message_id ?? "";
									terminal =
										row.state !== null &&
										row.state !== "pending" &&
										row.state !== "running";
									pending =
										row.status === "running" &&
										(binding.sinkId ===
											runnerSinkId(
												binding.commandId ?? binding.sinkId,
												row.attempt_count,
											) ||
											(inputId !== undefined &&
												binding.sinkId ===
													runnerSinkId(inputId, row.attempt_count)));
								}
							}
							const completed = pending
								? yield* Deferred.make<void>()
								: undefined;
							yield* ensureAttached();
							sinks.set(binding.sinkId, {
								sessionId,
								...(userMessageId ? { userMessageId } : {}),
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
					if (binding) {
						binding.accepted = true;
						if (binding.admission)
							runFork(Deferred.succeed(binding.admission, undefined));
					}
				},
				onUpgradeState: (state) => {
					const snapshot = state.snapshot ?? entry.upgrade.state?.snapshot;
					// Only snapshots are omitted when unchanged. An omitted cursor is cleared.
					entry.upgrade.state = { ...state, ...(snapshot ? { snapshot } : {}) };
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
						runnerFailure(
							"spawn runner",
							"Conduit config directory is too long for a Runner Unix socket",
						),
					);
				const child = yield* Effect.try({
					try: () => {
						if (closing || entry.stopping)
							throw runnerFailure("spawn runner", "Runners are shutting down");
						prepareRunnerDirectory(deps.workspaceRoot, configDir);
						const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
						// Launch the real absolute file: Cursor finds native helpers in
						// ancestor node_modules directories of this entry, not its SDK import.
						const runnerEntry = fileURLToPath(
							new URL(
								`../../../bin/claude-session-runner.${extension}`,
								import.meta.url,
							),
						);
						// Runners outlive the server, so inherited stdio would keep writing
						// into whichever terminal first started them.
						const log = openSync(join(configDir, "runners.log"), "a", 0o600);
						try {
							const child = spawn(
								process.execPath,
								[
									...process.execArgv,
									runnerEntry,
									entry.socketPath,
									sessionId,
									entry.runnerId,
									entry.candidate ? "upgrade" : "active",
									driver.driverKind,
								],
								{
									cwd: deps.workspaceRoot,
									env: { ...process.env, CONDUIT_CONFIG_DIR: configDir },
									detached: true,
									stdio: ["ignore", log, log, "ipc"],
								},
							);
							entry.child = child;
							entry.pid = child.pid;
							return child;
						} finally {
							closeSync(log);
						}
					},
					catch: (cause) => runnerFailure("spawn runner", cause),
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
						runnerFailure("spawn runner", "Runner exited"),
					);
					removeRunner(entry.socketPath);
				});
				yield* Effect.async<void, SessionFailure>((resume) => {
					const timer = setTimeout(
						() =>
							resume(
								Effect.fail(
									runnerFailure("spawn runner", "Runner startup timed out"),
								),
							),
						startupTimeoutMs,
					);
					const failed = (cause: unknown) => {
						clearTimeout(timer);
						resume(Effect.fail(runnerFailure("spawn runner", cause)));
					};
					child.once("error", failed);
					const exited = () => failed("Runner exited before listening");
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
							value["channel"] !== `conduit-${driver.driverKind}-runner` ||
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
							runnerFailure("spawn runner", Cause.squash(cause)),
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
					ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
					stopped: yield* Deferred.make<void>(),
					drained: yield* Deferred.make<void>(),
					stopping: false,
					ending: 0,
					idleExiting: false,
					commandsInFlight: 0,
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
					outputs: yield* Effect.makeSemaphore(1),
					socketPath: join(
						runnerDirectory(deps.workspaceRoot, configDir),
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
			entry.buildId !== runnerBuildId() &&
			entry.upgrade.state?.quiescent === true &&
			entry.upgrade.state.snapshot !== undefined;
		const upgrade = makeRunnerUpgrade<RunnerChild>({
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
							runnerFailure(
								"upgrade runner",
								"Session launch snapshot is missing",
							),
						);
					const connection = yield* start(sessionId, replacement);
					yield* Deferred.succeed(replacement.ready, connection);
					upgradeMark(sessionId, old, "warming", replacement);
					yield* connection.commandEffect(
						randomUUID(),
						driver.warmCommand(sessionId, state, snapshot),
					);
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
									runnerFailure("upgrade runner", cause),
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
								runnerFailure(
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
				const failure = runnerFailure("upgrade runner", cause);
				if (failure.code === driver.settingsDeferredCode)
					old.upgrade.settingsDeferred = true;
				log.warn(
					`${runnerLabel} upgrade deferred for session ${sessionId}: ${failure.message}`,
				);
				upgradeMark(sessionId, old, "failed");
			},
			cancelled: (sessionId, old, replacement) =>
				upgradeMark(sessionId, old, "cancelled", replacement),
		});

		class ProcessSessionRunner implements SessionRunner {
			readonly recoverEffect = Effect.gen(function* () {
				if (closing)
					return yield* Effect.fail(
						runnerFailure("recover runner", "Runners are shutting down"),
					);
				for (const registration of discoverRunners(
					deps.workspaceRoot,
					configDir,
				)) {
					if ((registration.driverKind ?? "claude") !== driver.driverKind)
						continue;
					const persisted = sql
						? (yield* sql<{
								id: string;
							}>`SELECT id FROM sessions WHERE id = ${registration.sessionId} LIMIT 1`.pipe(
								Effect.mapError((cause) =>
									runnerFailure("recover runner session", cause),
								),
							)).length > 0
						: true;
					// Draft warms are not durable; verify their identity before stopping them.
					let abandoned =
						!persisted ||
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
						ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
						stopped: yield* Deferred.make<void>(),
					};
					yield* lock.withPermits(1)(
						Effect.gen(function* () {
							if (closing)
								return yield* Effect.fail(
									runnerFailure("recover runner", "Runners are shutting down"),
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
									runnerFailure(
										"recover runner",
										"Runner recovery is no longer active",
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
									: runnerFailure(
											"recover runner",
											"Runner disconnected during recovery",
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
								removeRunner(entry.socketPath);
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
							? yield* driver
									.recoverCommands(
										sql,
										registration.sessionId,
										connected.right,
										(sinkId, failure) => {
											const binding = sinks.get(sinkId);
											if (!binding?.pending) return Effect.void;
											return (
												entry.failure
													? Deferred.await(entry.stopped)
													: Effect.void
											).pipe(
												Effect.zipRight(
													entry.outputs.withPermits(1)(
														failRunnerTurn(
															(output) => emit(output, registration.sessionId),
															sinkId,
															binding,
															failure,
															driver.driverKind,
														).pipe(
															Effect.ensuring(
																Effect.sync(() => sinks.delete(sinkId)),
															),
														),
													),
												),
											);
										},
										() => closing,
										runner.getNativeSessionEffect(registration.sessionId),
										(commandId, inputId, attempt, nativeResumeFallback) => {
											const sinkId = runnerSinkId(
												inputId,
												attempt,
												nativeResumeFallback,
											);
											return sinks.has(sinkId)
												? sinkId
												: runnerSinkId(
														commandId,
														attempt,
														nativeResumeFallback,
													);
										},
									)
									.pipe(
										Effect.mapError((cause) =>
											runnerFailure("recover runner commands", cause),
										),
									)
							: [];
						yield* lock.withPermits(1)(
							Effect.gen(function* () {
								yield* ensureRecovering;
								entry.commandsInFlight += commands.length;
								const admissions: Deferred.Deferred<void>[] = [];
								for (const command of commands) {
									let binding = sinks.get(command.sinkId);
									// The server can persist admission before the runner sees it.
									if (!binding) {
										binding = {
											sessionId: registration.sessionId,
											userMessageId:
												command.input.continuation?.cutOffMessageId ??
												command.input.inputId,
											messageId: command.messageId,
											terminal: command.terminal,
											pending: true,
											accepted: false,
											releaseRequested: false,
											completed: yield* Deferred.make<void>(),
										};
										sinks.set(command.sinkId, binding);
									}
									if (!binding.accepted) {
										binding.admission ??= yield* Deferred.make<void>();
										admissions.push(binding.admission);
									}
									const admission = binding.admission;
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
											Effect.ensuring(
												admission
													? Deferred.succeed(admission, undefined)
													: Effect.void,
											),
											Effect.catchAllCause((cause) =>
												Effect.logError(
													"Runner command recovery failed",
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
								if (admissions.length === 0)
									yield* Deferred.succeed(entry.ready, connected.right);
								else
									runFork(
										Effect.forEach(admissions, Deferred.await, {
											discard: true,
										}).pipe(
											Effect.andThen(ensureRecovering),
											Effect.flatMap(() =>
												connected.right.closed
													? Effect.fail(
															runnerFailure(
																"recover runner",
																"Runner disconnected during recovery",
															),
														)
													: Deferred.succeed(entry.ready, connected.right),
											),
											Effect.catchAll((failure) =>
												Deferred.fail(entry.ready, failure),
											),
										),
									);
								if (connected.right.closed)
									failed(
										registration.sessionId,
										entry,
										runnerFailure(
											"recover runner",
											"Runner disconnected during recovery",
										),
									);
								else upgrade(registration.sessionId, entry);
							}),
						);
					}).pipe(
						Effect.onExit((exit) => {
							if (exit._tag === "Success") return Effect.void;
							entry.recovering = false;
							entry.failure = runnerFailure(
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
			getNativeSessionEffect(
				sessionId: string,
			): Effect.Effect<ProviderNativeSession | undefined> {
				return Effect.sync(() => {
					const entry = children.get(sessionId);
					const state = entry?.upgrade.state;
					const snapshot = state?.snapshot;
					if (
						!entry ||
						entry.failure ||
						entry.stopping ||
						entry.idleExiting ||
						entry.ending > 0 ||
						!snapshot
					)
						return undefined;
					return {
						instanceId: snapshot.input.instanceId ?? driver.driverKind,
						configDir: snapshot.input.configDir,
						agent: snapshot.input.agent,
						resumeSessionId: state?.resumeSessionId,
					};
				});
			}

			executeEffect(
				command: Extract<SessionCommand, { type: "send-turn" }>,
			): Effect.Effect<TurnResult, SessionFailure>;
			executeEffect(
				command: Exclude<SessionCommand, { type: "send-turn" }>,
			): Effect.Effect<void, SessionFailure>;
			executeEffect(
				command: SessionCommand,
			): Effect.Effect<TurnResult | undefined, SessionFailure>;
			executeEffect(
				command: SessionCommand,
			): Effect.Effect<TurnResult | undefined, SessionFailure> {
				const turn =
					command.type === "send-turn"
						? {
								sessionId: command.input.sessionId,
								userMessageId:
									command.input.continuation?.cutOffMessageId ??
									command.input.inputId,
								...(command.input.continuation
									? {}
									: {
											placement: {
												inputId: command.input.inputId,
												text: command.input.text ?? command.input.prompt,
											},
										}),
								messageId: "",
								terminal: false,
								pending: true,
								accepted: false,
								releaseRequested: false,
								completed: undefined as Deferred.Deferred<void> | undefined,
							}
						: undefined;
				let child: RunnerChild | undefined;
				let sentToRunner = false;
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
							runnerFailure(command.type, "Runners are shutting down"),
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
										runnerFailure(command.type, "Runners are shutting down"),
									);
								const existing = children.get(sessionId);
								if (
									existing &&
									(command.type === "send-turn" || command.type === "pre-warm")
								) {
									const snapshot = existing.upgrade.state?.snapshot;
									const launch = snapshot?.input;
									const previousExtra = new Set(launch?.extraFolders ?? []);
									const nextExtra = new Set(command.input.extraFolders ?? []);
									const extraFoldersChanged =
										previousExtra.size !== nextExtra.size ||
										[...previousExtra].some((folder) => !nextExtra.has(folder));
									const removedExtra = [...previousExtra].filter(
										(folder) => !nextExtra.has(folder),
									);
									const addedExtra = [...nextExtra].filter(
										(folder) => !previousExtra.has(folder),
									);
									// Secondary Enter/Exit swaps a configured folder's role. The
									// captured secondary-folder integration requires this reconciliation.
									const canReconcileExtraFolders =
										snapshot?.workspacePreviousRoot !== undefined &&
										previousExtra.size === nextExtra.size &&
										removedExtra.length === 1 &&
										addedExtra.length === 1 &&
										[...nextExtra].every((folder) =>
											snapshot.workspaceDirectories?.includes(folder),
										) &&
										(addedExtra[0] === snapshot.workspacePreviousRoot ||
											removedExtra[0] === launch?.workspaceRoot);
									const foldersChanged =
										launch !== undefined &&
										(launch.workspaceRoot !== command.input.workspaceRoot ||
											(extraFoldersChanged && !canReconcileExtraFolders));
									const accountFolderChanged =
										launch !== undefined &&
										!driver.sameAccountLogin(
											{
												configDir: launch.configDir,
												root: launch.workspaceRoot,
											},
											{
												configDir: command.input.configDir,
												root: command.input.workspaceRoot,
											},
										);
									if (foldersChanged && command.type === "pre-warm")
										return { entry: undefined, draining: false };
									// Only an idle runner restarts. Background tasks can keep one
									// busy for hours, and it can still serve the send meanwhile.
									const upgradeByRestart =
										command.type === "send-turn" &&
										existing.upgrade.settingsDeferred === true &&
										!existing.recovering &&
										existing.commandsInFlight === 0 &&
										existing.upgrade.state?.quiescent === true;
									if (
										(foldersChanged ||
											accountFolderChanged ||
											upgradeByRestart) &&
										!existing.failure &&
										!existing.stopping &&
										!existing.idleExiting &&
										existing.ending === 0
									) {
										// A turn's completion can reach the browser before the
										// runner reports quiescence. Do not admit the next turn
										// on its old folders while that final output drains.
										if (
											existing.recovering ||
											existing.commandsInFlight > 0 ||
											existing.upgrade.state?.quiescent !== true
										) {
											if (command.type === "pre-warm")
												return { entry: undefined, draining: false };
											return {
												entry: existing,
												draining: true,
												foldersPending: true,
											};
										}
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
						if ("foldersPending" in selection) {
							yield* Effect.sleep("10 millis");
							continue;
						}
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
						}
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
					sentToRunner = false;
					if (command.type === "pre-warm" && command.input.draftPreWarm)
						entry.draftPreWarm = true;
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
					if (
						command.type === "send-turn" &&
						entry.draftPreWarm &&
						deps.prepareShellEnv
					) {
						// Project RPC routing can prune a draft worktree's env cache.
						// Await its current capture before sampling, just as warming does.
						const prepareShellEnv = deps.prepareShellEnv;
						yield* Effect.tryPromise(() =>
							prepareShellEnv(command.input.workspaceRoot),
						).pipe(
							Effect.timeoutOption("10 seconds"),
							Effect.catchAllCause((cause) =>
								Effect.sync(() =>
									log.debug(
										`Draft environment readiness failed: ${String(cause)}`,
									),
								),
							),
						);
						if (entry.failure) return yield* Effect.fail(entry.failure);
						if (entry.stopping || entry.ending > 0)
							return yield* Effect.fail(
								runnerFailure(command.type, "Runner is ending"),
							);
						if (entry.idleExiting)
							return yield* Effect.fail({
								...runnerFailure(
									command.type,
									"Runner is no longer accepting turns",
								),
								code: "runner_idle_exit",
							});
					}
					if (closing)
						return yield* Effect.fail(
							runnerFailure(command.type, "Runners are shutting down"),
						);
					if (command.type === "stop-task" && !entry.stopsTasks)
						return yield* Effect.fail(
							runnerFailure(
								command.type,
								`Runner build ${entry.buildId ?? "unknown"} cannot stop background tasks`,
							),
						);
					const payload =
						command.type === "send-turn"
							? {
									...command,
									...(entry.upgrade.state?.frozen
										? driver.snapshotCommandSettings(
												entry.upgrade.state.snapshot,
											)
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
					if (command.type === "send-turn") entry.draftPreWarm = false;
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
								runnerFailure("resolve runner command", cause),
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
					sentToRunner = true;
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
						Effect.fail(runnerFailure(command.type, cause)),
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
						const cleanup = failRunnerTurn(
							emit,
							command.sinkId,
							turn,
							runnerFailure(command.type, Cause.squash(cause)),
							driver.driverKind,
						).pipe(
							Effect.ensuring(Effect.sync(() => sinks.delete(command.sinkId))),
						);
						return (
							// Abandoned adoption preserves a runner that never received this send.
							(
								child?.failure && sentToRunner
									? Deferred.await(child.stopped)
									: Effect.void
							).pipe(
								Effect.zipRight(
									child ? child.outputs.withPermits(1)(cleanup) : cleanup,
								),
							)
						);
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
		const runner = new ProcessSessionRunner();
		return runner;
	});
