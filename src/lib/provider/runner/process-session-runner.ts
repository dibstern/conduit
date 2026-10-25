import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Cause,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Option,
	Schedule,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../contracts/account.js";
import {
	AccountSwitchBusy,
	accountSwitchBusyMessage,
} from "../../contracts/limit-recovery.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import {
	type PendingInteractionService,
	PendingInteractionServiceTag,
} from "../../domain/relay/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { createLogger } from "../../logger.js";
import { ClaudeEventPersistEffectTag } from "../../persistence/effect/claude-event-persist-effect.js";
import { makeRetireReplacedProcessPrompts } from "../../persistence/effect/retire-pending-prompts.js";
import { isRecord } from "../../utils.js";
import { STOP_ABORT_WAIT_MS } from "../orchestration-command-contracts.js";
import {
	type RunSettlementOwner,
	sessionRunOwnersQuery,
	settleSessionRuns,
} from "../session-run-settlement.js";
import type {
	ProviderControlCommandStatus,
	ProviderControlContext,
	ProviderNativeSession,
	TurnResult,
} from "../types.js";
import { connectRunner } from "./runner-connection.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
	runnerSinkId,
} from "./runner-protocol.js";
import type { RunnerProviderInstanceDeps } from "./runner-provider-instance.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "./runner-receipts.js";
import type { recoverRunnerCommands } from "./runner-recovery.js";
import {
	discoverAllRunners,
	discoverRunners,
	prepareRunnerDirectory,
	removeRunner,
	runnerDirectory,
	runnerPidAlive,
	runnerPidMatchesRegistration,
} from "./runner-registry.js";
import { failRunnerTurn, observeRunnerTurn } from "./runner-turn-failure.js";
import {
	makeRunnerUpgrade,
	type RunnerSourceDelivery,
	type RunnerUpgrade,
	type RunnerUpgradeState,
} from "./runner-upgrade.js";
import type {
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

interface RunnerChild {
	readonly sessionId: string;
	readonly registrationRoot?: string;
	launch?: Pick<SessionTurn, "workspaceRoot" | "extraFolders"> | undefined;
	readonly ready: Deferred.Deferred<RunnerSocket, SessionFailure>;
	readonly stopped: Deferred.Deferred<void>;
	readonly drained: Deferred.Deferred<void>;
	readonly socketPath: string;
	readonly outputs: Semaphore.Semaphore;
	lifecycle: Entry.RunnerEntryLifecycle;
	readonly runnerId: string;
	/** Exit callbacks run in the construction runtime, after recovery returns. */
	readonly ingestion?: ProviderRuntimeIngestion | undefined;
	readonly pendingInteractions?: PendingInteractionService | undefined;
	pid?: number | undefined;
	child?: ChildProcess;
	connection?: RunnerSocket;
	buildId?: string;
	capabilities?: {
		readonly stopsTasks: boolean;
		readonly rebindsAccount: boolean;
	};
	pendingSendCommands?: Map<string, number> | undefined;
	ownedRunIds?: Set<string>;
	/** One verified terminal delivery, including its release-sink unwind. */
	sourceDelivery?: RunnerSourceDelivery | undefined;
	deliveryWaiters?: Set<Deferred.Deferred<void>>;
	readonly upgrade: RunnerUpgrade;
}

export class RunnerProcessError extends Data.TaggedError("RunnerProcessError")<{
	readonly message: string;
}> {}

interface ProcessRunnerDeps {
	readonly accountResources?: RunnerProviderInstanceDeps["accountResources"];
	readonly accounts?: Effect.Effect<
		import("../../account-directory.js").AccountsState
	>;
	readonly daemonConfigDir?: string;
	readonly autoSettleAfterDays?: Effect.Effect<number | null | undefined>;
	readonly subagentPollTimeoutMs?: number;
	readonly projectRootForSession: NonNullable<
		RunnerProviderInstanceDeps["projectRootForSession"]
	>;
	readonly recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"];
}

export interface ProcessRunnerDriver {
	readonly spawnEnvironment?: Readonly<Record<string, string>>;
	/** Undelivered replays use the sendTurn callback's ordinary admission. */
	readonly admitsRecoveredSends?: boolean;
	readonly driverKind: string;
	/** The account owner retains this demand until the native sink is released. */
	readonly withAccountScope?: (
		accountId: string,
		work: Effect.Effect<void>,
	) => Effect.Effect<void, SessionFailure>;
	/** The payload resumes durable state on demand and needs no warm SDK query. */
	readonly coldUpgrade?: true;
	readonly connect: typeof connectRunner;
	readonly settingsDeferredCode: string;
	readonly warmCommand: (
		sessionId: string,
		state: import("./runner-upgrade.js").RunnerUpgradeState,
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot,
	) => Extract<SessionCommand, { type: "pre-warm" }>;
	readonly snapshotCommandSettings: (
		snapshot: import("./runner-upgrade.js").RunnerSettingsSnapshot | undefined,
	) => Omit<
		Extract<SessionCommand, { type: "send-turn" }>,
		"type" | "sinkId" | "aborted" | "input"
	>;
	readonly loginChange: (
		a: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
			readonly account?: SessionTurn["account"];
			readonly instanceId?: string;
			readonly shellConfig?: SessionTurn["shellConfig"];
		},
		b: {
			readonly configDir: import("./session-runner.js").SessionTurn["configDir"];
			readonly root: string;
			readonly account?: SessionTurn["account"];
			readonly instanceId?: string;
			readonly shellConfig?: SessionTurn["shellConfig"];
		},
	) => "None" | "Settings" | "Account";
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
		replayTurn: (
			accountId: string,
			input: SessionTurn,
			sinkId: string,
			work: (
				dispatch: (
					command: Effect.Effect<TurnResult | undefined, SessionFailure>,
				) => Effect.Effect<TurnResult | undefined, SessionFailure>,
			) => Effect.Effect<TurnResult | undefined, SessionFailure>,
		) => Effect.Effect<TurnResult | undefined, SessionFailure>,
		sendTurn: (
			commandId: string,
			command: Extract<SessionCommand, { type: "send-turn" }>,
			attempt: number,
		) => Effect.Effect<TurnResult | undefined, SessionFailure>,
		admitReplay: (
			sinkId: string,
			replay: Effect.Effect<TurnResult | undefined, SessionFailure>,
		) => Effect.Effect<TurnResult | undefined, SessionFailure>,
	) => Effect.Effect<
		Effect.Success<
			ReturnType<
				typeof recoverRunnerCommands<import("./session-runner.js").SessionTurn>
			>
		>,
		unknown,
		PersistenceProjectTag
	>;
}

const log = createLogger("process-session-runner");
const CANCELLED_TURN: TurnResult = {
	status: "cancelled",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

// Notification is private to admission; it never changes account eligibility.
const notifyEntry = (entry: Pick<RunnerChild, "deliveryWaiters">): void => {
	const waiters = [...(entry.deliveryWaiters ?? [])];
	// Completing a Deferred can synchronously register its next observation.
	entry.deliveryWaiters?.clear();
	for (const waiter of waiters) Deferred.doneUnsafe(waiter, Effect.void);
};

// Every lifecycle write goes through this boundary; reduction itself is pure.
const transition = (
	entry: Pick<RunnerChild, "lifecycle" | "deliveryWaiters" | "sourceDelivery">,
	event: Entry.RunnerEntryTransition,
) => {
	const ending = entry.lifecycle.end;
	entry.lifecycle = Entry.nextRunnerLifecycle(entry.lifecycle, event);
	if (!Entry.canReconfigure(entry.lifecycle)) entry.sourceDelivery = undefined;
	notifyEntry(entry);
	return event._tag === "FinishEnd" && ending?.pending === 1
		? ending.released
		: undefined;
};

const stop = (
	entry: Pick<
		RunnerChild,
		| "ready"
		| "stopped"
		| "socketPath"
		| "lifecycle"
		| "deliveryWaiters"
		| "pid"
		| "child"
		| "connection"
	>,
) =>
	Effect.gen(function* () {
		if (entry.lifecycle.stop) {
			yield* Deferred.await(entry.stopped);
			// A late verified hello may arrive after an unverified stop.
			if (
				entry.lifecycle.stop?.signal === "Signalled" ||
				!Entry.hasVerifiedIdentity(entry.lifecycle)
			)
				return;
		}
		transition(entry, { _tag: "Stop" });
		const cleanup = Effect.callback<void>((resume) => {
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
			const pid =
				child?.pid ??
				(Entry.hasVerifiedIdentity(entry.lifecycle) ? entry.pid : undefined);
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
					transition(entry, { _tag: "SignalStop" });
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
						const connection = yield* Effect.result(
							Effect.acquireRelease(
								connectRunner({
									...registration,
									// Runner builds predating driverKind were all Claude.
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
							connection._tag === "Failure" &&
							!runnerPidMatchesRegistration(registration)
						) {
							if (runnerPidAlive(registration.pid)) {
								log.warn(
									{
										...registration,
										// Runner builds predating driverKind were all Claude.
										driverKind: registration.driverKind ?? "claude",
										cause: connection.failure,
									},
									"Leaving unverified Runner after failed hello",
								);
							} else {
								yield* Effect.sync(() => removeRunner(registration.socketPath));
							}
							return;
						}
						const ready = yield* Deferred.make<RunnerSocket, SessionFailure>();
						if (connection._tag === "Success")
							yield* Deferred.succeed(ready, connection.success);
						else yield* Deferred.fail(ready, connection.failure);
						// A failed hello requires independent argv identity before signalling.
						yield* stop({
							ready,
							stopped: yield* Deferred.make<void>(),
							socketPath: registration.socketPath,
							pid: registration.pid,
							lifecycle: Entry.nextRunnerLifecycle(
								Entry.initialRunnerLifecycle(),
								{
									_tag: "Verify",
								},
							),
							...(connection._tag === "Success"
								? { connection: connection.success }
								: {}),
						});
						if (runnerPidAlive(registration.pid)) {
							return yield* new RunnerProcessError({
								message: `Runner ${registration.runnerId} survived shutdown`,
							});
						}
					}).pipe(
						Effect.catch((error) =>
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
					message: failures
						.map((exit) => Failure.renderCause(exit.cause))
						.join("\n"),
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
		const accountDisplayName = (
			input: Pick<SessionTurn, "account" | "instanceId"> | undefined,
		) =>
			input?.account?.name ||
			input?.account?.id ||
			input?.instanceId ||
			driver.driverKind;
		const lock = yield* Semaphore.make(1);
		const configDir = resolve(deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR);
		const startupTimeoutMs =
			process.env["NODE_ENV"] === "test"
				? Number(
						process.env["CONDUIT_TEST_RUNNER_STARTUP_TIMEOUT_MS"] ?? 10_000,
					)
				: 10_000;
		const sqlOption = yield* Effect.serviceOption(SqlClient.SqlClient);
		const sql = sqlOption._tag === "Some" ? sqlOption.value : undefined;
		const ingestionOption = yield* Effect.serviceOption(
			ProviderRuntimeIngestionTag,
		);
		const ingestion =
			ingestionOption._tag === "Some" ? ingestionOption.value : undefined;
		const ingestionForSession = (sessionId: string) =>
			deps.recoveryForSession
				? deps
						.recoveryForSession(sessionId)
						.pipe(Effect.map((recovery) => recovery?.ingestion))
				: Effect.succeed(ingestion);
		const receipts = sql
			? yield* makeRunnerReceiptStore(sql).pipe(Effect.orDie)
			: undefined;
		const legacyRetirePrompts = deps.recoveryForSession
			? undefined
			: yield* makeRetireReplacedProcessPrompts;
		const retireReplacedPrompts = (
			currentProcessId: string | null,
			owner: {
				readonly sessionId: string;
				readonly expiredProcessId?: string;
				readonly exceptCommandId?: string;
			},
		) =>
			deps.recoveryForSession
				? deps
						.recoveryForSession(owner.sessionId)
						.pipe(
							Effect.flatMap(
								(recovery) =>
									recovery?.retirePrompts(currentProcessId, owner) ??
									Effect.succeed(0),
							),
						)
				: (legacyRetirePrompts?.(currentProcessId, owner) ?? Effect.succeed(0));
		const observedProcesses = new Map<string, string>();
		const observeProcess = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				if (observedProcesses.get(sessionId) === entry.runnerId) return;
				const retirement = deps.recoveryForSession
					? (yield* deps.recoveryForSession(sessionId))?.retirePrompts(
							entry.runnerId,
						)
					: legacyRetirePrompts?.(entry.runnerId, { sessionId });
				// A skipped retirement must remain eligible when project services return.
				if (!retirement) return;
				yield* (
					entry.pendingInteractions
						? retirement.pipe(
								Effect.provideService(
									PendingInteractionServiceTag,
									entry.pendingInteractions,
								),
							)
						: retirement
				).pipe(
					Effect.mapError((cause) =>
						runnerFailure("retire replaced runner prompts", cause),
					),
				);
				observedProcesses.set(sessionId, entry.runnerId);
			});
		const children = new Map<string, RunnerChild>();
		const candidates = new Set<RunnerChild>();
		const quarantined = new Map<string, SessionFailure>();
		let recovering = false;
		// Liveness only: evicted children whose OS process may not have exited
		// yet. Pruned lazily by pid, never consulted for ownership.
		const exiting = new Set<RunnerChild>();
		const sinks = new Map<
			string,
			{
				sessionId: string;
				inputId?: string;
				runId?: string | undefined;
				commandId?: string;
				runnerId?: string;
				/** What a failed send places when the SDK never started it. */
				placement?: {
					inputId: string;
					text: string;
					images?: readonly string[];
				};
				messageId: string;
				pending: boolean;
				accepted: boolean;
				admission?: Deferred.Deferred<void>;
				releaseRequested: boolean;
			}
		>();
		const observeSourceDelivery = (
			entry: RunnerChild,
			state: RunnerUpgradeState | undefined,
		) => {
			const delivery = state?.sourceDelivery;
			const previous = entry.sourceDelivery;
			const binding = delivery ? sinks.get(delivery.sinkId) : undefined;
			// A released sink may disappear while its already-verified delivery unwinds.
			const retained =
				delivery &&
				previous &&
				previous.generation === delivery.generation &&
				previous.sinkId === delivery.sinkId &&
				previous.commandId === delivery.commandId &&
				previous.inputId === delivery.inputId &&
				previous.runId === delivery.runId;
			const owned =
				delivery &&
				binding?.sessionId === entry.sessionId &&
				binding.runnerId === entry.runnerId &&
				binding.commandId === delivery.commandId &&
				binding.inputId === delivery.inputId &&
				binding.runId === delivery.runId;
			entry.sourceDelivery =
				delivery?.sessionId === entry.sessionId &&
				delivery.runnerId === entry.runnerId &&
				Entry.canReconfigure(entry.lifecycle) &&
				(owned || retained)
					? delivery
					: undefined;
		};
		// These sends have no runner ownership yet, including while rebinding.
		const pendingSends = new Map<
			string,
			{
				sessionId: string;
				turnId: string;
				cancelled: Deferred.Deferred<void>;
			}
		>();
		let closing = false;
		const accountDemands = new Map<
			string,
			{
				readonly ready: Deferred.Deferred<void, SessionFailure>;
				readonly finished: Deferred.Deferred<void>;
				readonly dispatched: Deferred.Deferred<RunnerSocket>;
				readonly invalidated: Deferred.Deferred<void>;
			}
		>();
		const releaseSink = (sinkId: string) => {
			sinks.delete(sinkId);
			const demand = accountDemands.get(sinkId);
			if (demand) Deferred.doneUnsafe(demand.finished, Effect.void);
		};
		const retainAccount = (
			sinkId: string,
			accountId: string | undefined,
			sessionId: string,
			inputId?: string,
			connection?: RunnerSocket,
		) =>
			Effect.gen(function* () {
				const withAccountScope = driver.withAccountScope;
				if (!withAccountScope || !accountId) return;
				const existing = accountDemands.get(sinkId);
				if (existing) return yield* Deferred.await(existing.ready);
				const ready = yield* Deferred.make<void, SessionFailure>();
				const finished = yield* Deferred.make<void>();
				const dispatched = yield* Deferred.make<RunnerSocket>();
				const invalidated = yield* Deferred.make<void>();
				if (connection) yield* Deferred.succeed(dispatched, connection);
				accountDemands.set(sinkId, {
					ready,
					finished,
					dispatched,
					invalidated,
				});
				const interrupt = Deferred.await(dispatched).pipe(
					Effect.flatMap((connection) =>
						connection.commandEffect(randomUUID(), {
							type: "interrupt",
							sessionId,
							...(inputId ? { turnIds: [inputId] } : {}),
						}),
					),
				);
				runFork(
					withAccountScope(
						accountId,
						Deferred.succeed(ready, undefined).pipe(
							Effect.andThen(Deferred.await(finished)),
							Effect.onInterrupt(() =>
								Deferred.succeed(invalidated, undefined).pipe(
									Effect.andThen(
										Effect.suspend(() =>
											closing
												? Effect.void
												: Effect.raceFirst(
														Deferred.await(finished).pipe(Effect.interruptible),
														interrupt.pipe(
															Effect.ignore,
															Effect.andThen(Deferred.await(finished)),
															Effect.interruptible,
														),
													),
										),
									),
								),
							),
						),
					).pipe(
						Effect.onExit((exit) =>
							Effect.gen(function* () {
								yield* Deferred.done(
									ready,
									!closing &&
										Exit.isFailure(exit) &&
										Failure.isInterruptedOnly(exit.cause)
										? Exit.fail(
												runnerFailure(
													"retain account",
													"Cursor account was invalidated",
												),
											)
										: exit,
								);
								if (accountDemands.get(sinkId)?.finished === finished)
									accountDemands.delete(sinkId);
							}),
						),
						Effect.catchCause(() => Effect.void),
					),
				);
				yield* Deferred.await(ready);
			});
		const acknowledgeSends = (
			sessionId: string,
			entry: RunnerChild,
			connection: RunnerSocket,
		) =>
			Effect.gen(function* () {
				if (!sql || !entry.pendingSendCommands?.size) return;
				const rows = yield* sql<{
					command_id: string;
					attempt: number;
				}>`SELECT command_id, MAX(attempt_count) AS attempt FROM provider_command_outbox
				WHERE session_id = ${sessionId} AND effect_type = 'send_turn'
					AND status IN ('completed', 'failed') AND command_id IN ${sql.in([...entry.pendingSendCommands.keys()])}
				GROUP BY command_id`;
				if (closing || entry.connection !== connection || connection.closed)
					return;
				if (rows.length)
					connection.write({
						type: "settled-commands",
						commands: rows.map((row) => ({
							commandId: row.command_id,
							attempt: row.attempt,
						})),
					});
			}).pipe(
				Effect.catch((cause) =>
					Effect.logWarning("Runner send acknowledgement failed", cause),
				),
			);
		if (sql)
			yield* Effect.forkScoped(
				Effect.forever(
					Effect.sleep("1 second").pipe(
						Effect.andThen(
							Effect.suspend(() =>
								Effect.forEach(
									[...children],
									([sessionId, entry]) =>
										entry.connection
											? acknowledgeSends(sessionId, entry, entry.connection)
											: Effect.void,
									{ discard: true },
								),
							),
						),
					),
				),
			);
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
			entry.sourceDelivery = undefined;
			notifyEntry(entry);
			// A late close from an old child must not remove its replacement.
			if (children.get(sessionId) !== entry) return;
			children.delete(sessionId);
			// Usability ends before the OS process does; keep it visible to liveness.
			if ((entry.pid ?? entry.child?.pid) !== undefined) exiting.add(entry);
			// Undelivered sends belong to admission, including across retirement.
			for (const [sinkId, binding] of sinks)
				if (
					binding.sessionId === sessionId &&
					(binding.accepted || !binding.pending)
				)
					releaseSink(sinkId);
		};
		const releaseEntryWaiters = (
			entry: RunnerChild,
			cause: Cause.Cause<SessionFailure>,
		) =>
			Effect.gen(function* () {
				notifyEntry(entry);
				yield* Deferred.failCause(entry.ready, cause);
				yield* Deferred.succeed(entry.drained, undefined);
				const ending = entry.lifecycle.end;
				if (ending) yield* Deferred.succeed(ending.released, undefined);
			});
		const quarantine = (entry: RunnerChild, cause: SessionFailure) =>
			Effect.gen(function* () {
				const failure: SessionFailure = {
					...cause,
					code: "runner_quarantined",
					message: `Session ${entry.sessionId} is quarantined: ${cause.message}. Runner ${entry.runnerId} (pid ${entry.pid}) is still alive. Stop it and restart Conduit before sending again.`,
					retryable: false,
				};
				// Retain the entry, registration and spool. Neither a failed send nor
				// a late socket callback may replace this process or retire its prompts.
				quarantined.set(entry.sessionId, failure);
				transition(entry, { _tag: "Fail", failure });
				transition(entry, { _tag: "Recovered" });
				entry.connection?.destroy();
				// A disconnected runner cannot finish account invalidation. Recovery
				// will reacquire its holds from hello after the next server restart.
				if (children.get(entry.sessionId) === entry)
					for (const [sinkId, binding] of sinks)
						if (binding.sessionId === entry.sessionId) releaseSink(sinkId);
				yield* releaseEntryWaiters(entry, Cause.fail(failure));
				log.warn(failure.message);
			});
		const retireOrphan = (entry: RunnerChild) =>
			Effect.gen(function* () {
				const ownsEntry = () =>
					entry.lifecycle.candidate
						? candidates.has(entry)
						: children.get(entry.sessionId) === entry;
				if (closing || !ownsEntry()) return;
				yield* stop(entry).pipe(
					Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
				);
				if (closing || !ownsEntry()) return;
				if (entry.pid !== undefined && runnerPidAlive(entry.pid))
					return yield* quarantine(
						entry,
						runnerFailure("recover runner", "Abandoned runner survived stop"),
					);
				evict(entry.sessionId, entry);
				candidates.delete(entry);
			});
		const detach = (entry: RunnerChild, failure?: SessionFailure) => {
			entry.sourceDelivery = undefined;
			notifyEntry(entry);
			entry.connection?.destroy(failure);
			entry.child?.unref();
			if (entry.child?.connected) entry.child.disconnect();
		};
		const shutdown = lock
			.withPermits(1)(
				Effect.gen(function* () {
					closing = true;
					for (const entry of [...children.values(), ...candidates])
						notifyEntry(entry);
					for (const { finished } of accountDemands.values())
						Deferred.doneUnsafe(finished, Effect.void);
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
							(entry.child && Entry.needsStartupStop(entry.lifecycle))
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

		const settleExitedRuns = (
			sessionId: string,
			entry: RunnerChild,
			failure: SessionFailure,
			endCommandId?: string,
		) => {
			const bindings = [...sinks].filter(
				([, binding]) => binding.sessionId === sessionId,
			);
			const commands = [...(entry.pendingSendCommands ?? [])];
			return Effect.gen(function* () {
				const sessionIngestion = deps.recoveryForSession
					? yield* ingestionForSession(sessionId)
					: (entry.ingestion ?? ingestion);
				const reservations = new Set<string>();
				if (sql && sessionIngestion)
					for (const [commandId, attempt] of commands) {
						const [owner] = yield* sql<{
							run_id: string | null;
						}>`
							SELECT outbox.run_id AS run_id
							FROM provider_command_outbox outbox WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})
								AND session_id = ${sessionId} AND command_id = ${commandId} AND attempt_count = ${attempt}
							ORDER BY request_sequence LIMIT 1`;
						if (owner?.run_id) reservations.add(owner.run_id);
					}
				yield* Deferred.await(entry.stopped);
				const exitedPid = entry.pid ?? entry.child?.pid;
				if (!closing && exitedPid !== undefined && !runnerPidAlive(exitedPid)) {
					const current = children.get(sessionId);
					yield* retireReplacedPrompts(
						current && current !== entry ? current.runnerId : null,
						{
							sessionId,
							expiredProcessId: entry.runnerId,
							...(endCommandId ? { exceptCommandId: endCommandId } : {}),
						},
					);
				}
				if (process.env["NODE_ENV"] === "test")
					yield* Effect.sleep(
						Number(process.env["CONDUIT_TEST_RUNNER_FAILURE_DELAY_MS"] ?? 0),
					);
				yield* entry.outputs.withPermits(1)(
					lock.withPermits(1)(
						Effect.gen(function* () {
							const owners = new Map<string, RunSettlementOwner>();
							for (const runId of entry.ownedRunIds ?? [])
								reservations.add(runId);
							for (const [, binding] of bindings)
								if (binding.accepted && binding.runId)
									reservations.add(binding.runId);
							const pid = entry.pid ?? entry.child?.pid;
							if (
								!sql ||
								!sessionIngestion ||
								!reservations.size ||
								closing ||
								entry.lifecycle.activity._tag === "Recovering" ||
								entry.lifecycle.candidate ||
								children.get(sessionId) !== entry ||
								pid === undefined ||
								runnerPidAlive(pid)
							)
								return Effect.void;
							for (const reservation of reservations) {
								const [accepted] = yield* sql<{ run_id: string }>`
									SELECT COALESCE(joined_into, id) AS run_id FROM provider_runs
									WHERE session_id = ${sessionId} AND id = ${reservation}
										AND (${entry.lifecycle.idleExiting ? 1 : 0} = 0 OR status = 'running' OR started_at IS NOT NULL OR joined_into IS NOT NULL)`;
								if (accepted?.run_id)
									owners.set(accepted.run_id, { runId: accepted.run_id });
							}
							if (!owners.size) return;
							return yield* settleSessionRuns(
								sql,
								sessionId,
								failure.message,
								(events) => sessionIngestion.ingestBatch(events),
								{
									...(endCommandId ? {} : { errorCode: "runner_stopped" }),
									owners: [...owners.values()],
								},
							);
						}),
					),
				);
			});
		};
		const failed = (
			sessionId: string,
			entry: RunnerChild,
			failure: SessionFailure,
		) => {
			if (failure.code === "runner_idle_exit")
				transition(entry, { _tag: "IdleExit" });
			if (
				!Entry.canControl(entry.lifecycle) ||
				entry.lifecycle.activity._tag === "Recovering" ||
				closing
			)
				return;
			transition(entry, { _tag: "Fail", failure });
			runFork(Deferred.fail(entry.ready, failure));
			if (entry.lifecycle.candidate) return;
			const bindings = [...sinks].filter(
				([, binding]) => binding.sessionId === sessionId,
			);
			const settlement = settleExitedRuns(sessionId, entry, failure);
			if (
				!entry.lifecycle.idleExiting &&
				entry.lifecycle.activity._tag !== "StartupTimedOut"
			)
				log.error(
					`${runnerLabel} failed for session ${sessionId}: ${failure.message}`,
				);
			// Warm completed turns retain a sink for background output. A
			// dead runner cannot release it, even when no send is waiting.
			runFork(
				settlement
					.pipe(
						Effect.catch((cause) =>
							Effect.logError("Could not settle exited runner runs", cause),
						),
						Effect.andThen(
							entry.outputs.withPermits(1)(
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
							),
						),
					)
					.pipe(
						Effect.ignore,
						Effect.ensuring(Effect.sync(() => evict(sessionId, entry))),
						Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
					),
			);
			runFork(stop(entry));
		};

		const attach = (
			sessionId: string,
			entry: RunnerChild,
			identityOnly = false,
		) =>
			Effect.gen(function* () {
				const workspaceRoot =
					entry.launch?.workspaceRoot ??
					(yield* deps.projectRootForSession(sessionId)) ??
					entry.registrationRoot ??
					// Orphans and withheld projects need only a verified identity hello.
					(entry.lifecycle.candidate || Entry.isAwaitingProject(entry.lifecycle)
						? configDir
						: undefined);
				if (!workspaceRoot)
					return yield* Effect.fail(
						runnerFailure(
							"connect runner",
							`Session ${sessionId} has no registered project`,
						),
					);
				return yield* driver.connect({
					driverKind: driver.driverKind,
					socketPath: entry.socketPath,
					sessionId,
					runnerId: entry.runnerId,
					...(entry.pid !== undefined ? { pid: entry.pid } : {}),
					helloTimeoutMs: entry.child ? startupTimeoutMs : 2000,
					...(entry.lifecycle.candidate ? { preserveRole: true } : {}),
					...(identityOnly ? { identityOnly: true as const } : {}),
					deps: {
						workspaceRoot,
						...entry.launch,
						daemonConfigDir: configDir,
						...(deps.accounts ? { accounts: deps.accounts } : {}),
						// Replacements use current daemon memory, including changes during replacement.
						autoSettleAfterDays: deps.autoSettleAfterDays,
						...(deps.subagentPollTimeoutMs !== undefined
							? { subagentPollTimeoutMs: deps.subagentPollTimeoutMs }
							: {}),
					},
					// A verified orphan can be stopped without claiming history's cursor.
					...(receipts && !identityOnly ? { receipts } : {}),
					runFork,
					onOutputCommitted: (output) => {
						if (
							output.type === "event" &&
							output.event.type === "run.started" &&
							output.event.runId
						)
							(entry.ownedRunIds ??= new Set()).add(output.event.runId);
						observeRunnerTurn(
							output,
							"sinkId" in output ? sinks.get(output.sinkId) : undefined,
						);
					},
					emit: (received) => {
						// Keep output in the runner's spool until its project can ingest it.
						// The verified connection still permits native retirement meanwhile.
						if (identityOnly || Entry.isAwaitingProject(entry.lifecycle))
							return Effect.interrupt;
						const operation = Effect.suspend(() => {
							// A retired query's shutdown notices must not clear its replacement.
							if (
								entry.lifecycle.stop &&
								children.get(sessionId) !== entry &&
								(received.type === "background-task" ||
									received.type === "cancel-interactions" ||
									(received.type === "event" &&
										received.event.type === "session.status"))
							)
								return Effect.succeed({});
							const binding =
								"sinkId" in received ? sinks.get(received.sinkId) : undefined;
							if (received.type === "release-sink" && binding?.pending) {
								binding.releaseRequested = true;
								return Effect.succeed({});
							}
							return emit(received, sessionId).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										observeRunnerTurn(received, binding);
										if (received.type === "release-sink")
											releaseSink(received.sinkId);
									}),
								),
							);
						});
						return received.type === "ensure-subagent-session"
							? operation
							: entry.outputs.withPermits(1)(operation);
					},
					onHello: (hello, connection, replay) =>
						Effect.gen(function* () {
							transition(entry, { _tag: "Verify" });
							entry.pid = hello.pid;
							const ownsEntry = () =>
								(entry.lifecycle.candidate
									? candidates.has(entry)
									: children.get(sessionId) === entry) &&
								Entry.canControl(entry.lifecycle) &&
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
							entry.capabilities = {
								stopsTasks: hello.stopsTasks === true,
								rebindsAccount: hello.rebindsAccount === true,
							};
							const observed = entry.upgrade.state;
							const helloState = hello.upgradeState;
							const latest =
								observed &&
								(!helloState || observed.revision >= helloState.revision)
									? observed
									: helloState;
							const snapshot =
								latest?.snapshot ?? observed?.snapshot ?? helloState?.snapshot;
							entry.upgrade.state = latest
								? { ...latest, ...(snapshot ? { snapshot } : {}) }
								: undefined;
							notifyEntry(entry);
							// Identity and native controls suffice until the project can reattach.
							if (identityOnly || Entry.isAwaitingProject(entry.lifecycle))
								return;
							// Warming candidates have not replaced the active process yet.
							if (!entry.lifecycle.candidate)
								yield* lock.withPermits(1)(
									Effect.gen(function* () {
										yield* ensureAttached();
										yield* observeProcess(sessionId, entry);
										yield* ensureAttached();
									}),
								);
							yield* ensureAttached();
							entry.pendingSendCommands = hello.sendCommands
								? new Map(
										hello.sendCommands.map(({ commandId, attempt }) => [
											commandId,
											attempt,
										]),
									)
								: undefined;
							yield* acknowledgeSends(sessionId, entry, connection);
							const restoreAccounts: Effect.Effect<void, SessionFailure>[] = [];
							for (const binding of entry.lifecycle.candidate
								? []
								: (hello.bindings ?? [])) {
								let inputId: string | undefined;
								let runId: string | undefined;
								let messageId = "";
								let pending = false;
								let accountId: string | undefined;
								let activeTurn = false;
								let turnInputId: string | undefined;
								if (sql) {
									const rows = yield* sql<{
										provider_id: string;
										input_id: string | null;
										run_id: string | null;
										status: string;
										attempt_count: number;
										assistant_message_id: string | null;
										turn_state: string | null;
										turn_input_id: string | null;
									}>`SELECT outbox.provider_id, COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id,
										COALESCE(reservation.joined_into, reservation.id) AS run_id,
										outbox.status, outbox.attempt_count, turns.assistant_message_id, turns.state AS turn_state, turns.user_message_id AS turn_input_id
										FROM provider_command_outbox outbox
										LEFT JOIN provider_runs reservation ON reservation.session_id = outbox.session_id
											AND reservation.id = outbox.run_id
										LEFT JOIN turns ON turns.session_id = outbox.session_id
											AND turns.user_message_id = COALESCE(json_extract(outbox.payload_json, '$.continuation.cutOffMessageId'), json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId'))
										WHERE outbox.project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId}) AND outbox.command_id = ${binding.commandId ?? binding.sinkId} AND outbox.session_id = ${sessionId}`.pipe(
										Effect.mapError((cause) =>
											runnerFailure("restore runner history", cause),
										),
									);
									yield* ensureAttached();
									const row = rows[0];
									if (row) {
										accountId = row.provider_id;
										turnInputId = row.turn_input_id ?? undefined;
										activeTurn =
											row.turn_state === "pending" ||
											row.turn_state === "running";
										inputId = row.input_id ?? undefined;
										runId = row.run_id ?? undefined;
										// Acknowledged events will not replay after adoption.
										messageId = row.assistant_message_id ?? "";
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
								yield* ensureAttached();
								sinks.set(binding.sinkId, {
									sessionId,
									runnerId: entry.runnerId,
									...(binding.commandId
										? { commandId: binding.commandId }
										: {}),
									...(inputId ? { inputId } : {}),
									runId,
									messageId,
									pending,
									accepted: true,
									releaseRequested: false,
								});
								// Historical sinks remain available for output replay, but their
								// native lifetime ended. Older runners report only the history.
								if (
									binding.released === false ||
									(binding.released === undefined && activeTurn)
								) {
									restoreAccounts.push(
										Effect.gen(function* () {
											yield* ensureAttached();
											const turn = sinks.get(binding.sinkId);
											if (!turn) return;
											if (sql && turnInputId) {
												const rows = yield* sql<{
													state: string;
												}>`SELECT state FROM turns
												WHERE session_id = ${sessionId} AND user_message_id = ${turnInputId}`.pipe(
													Effect.mapError((cause) =>
														runnerFailure("restore runner history", cause),
													),
												);
												if (
													rows[0]?.state !== "pending" &&
													rows[0]?.state !== "running"
												)
													return;
											}
											const retained = yield* Effect.result(
												retainAccount(
													binding.sinkId,
													accountId ??
														hello.upgradeState?.snapshot?.input.account?.id,
													sessionId,
													inputId,
													connection,
												),
											);
											if (retained._tag === "Failure") {
												if (retained.failure.code !== "account_unavailable")
													return yield* Effect.fail(retained.failure);
												yield* failRunnerTurn(
													(output) => emit(output, sessionId),
													binding.sinkId,
													turn,
													retained.failure,
													driver.driverKind,
												);
												releaseSink(binding.sinkId);
												runFork(
													connection
														.commandEffect(randomUUID(), {
															type: "interrupt",
															sessionId,
															...(inputId ? { turnIds: [inputId] } : {}),
														})
														.pipe(Effect.ignore, Effect.asVoid),
												);
											}
										}),
									);
								}
							}
							for (const pending of entry.lifecycle.candidate
								? []
								: (hello.pendingOutputs ?? [])) {
								yield* ensureAttached();
								if (pending.sequence <= (hello.acknowledgedSequence ?? 0))
									yield* emit(pending.output, sessionId);
							}
							// A previous-build runner may have completed while the store still
							// says running. Commit its backlog before checking account demand.
							if (driver.withAccountScope && restoreAccounts.length > 0) {
								yield* replay ?? Effect.void;
								// Replay may settle a command before recovery can install its waiter.
								if (sql)
									yield* entry.outputs.withPermits(1)(
										Effect.gen(function* () {
											for (const binding of hello.bindings ?? []) {
												const turn = sinks.get(binding.sinkId);
												if (!turn?.pending) continue;
												const [command] = yield* sql<{ status: string }>`
													SELECT status FROM provider_command_outbox
													WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId}) AND session_id = ${sessionId}
														AND command_id = ${binding.commandId ?? binding.sinkId}`.pipe(
													Effect.mapError((cause) =>
														runnerFailure("restore runner history", cause),
													),
												);
												yield* ensureAttached();
												if (
													command?.status !== "completed" &&
													command?.status !== "failed"
												)
													continue;
												turn.pending = false;
												if (turn.releaseRequested) {
													yield* emit(
														{ type: "release-sink", sinkId: binding.sinkId },
														sessionId,
													);
													releaseSink(binding.sinkId);
												}
											}
										}),
									);
							}
							yield* Effect.all(restoreAccounts, { discard: true });
							yield* ensureAttached();
							// Recovery can await output ACKs that publish a newer revision.
							observeSourceDelivery(entry, entry.upgrade.state);
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
					onCommandsSettled: (commands) => {
						runFork(
							entry.outputs
								.withPermits(1)(
									Effect.gen(function* () {
										for (const { commandId, attempt } of commands) {
											const pending = entry.pendingSendCommands?.get(commandId);
											if (pending === undefined || pending > attempt) continue;
											if (sql) {
												const rows = yield* sql<{
													run_id: string | null;
												}>`SELECT run_id
											FROM provider_command_outbox WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId})
											AND session_id = ${sessionId} AND command_id = ${commandId}
											AND attempt_count = ${pending}`;
												for (const row of rows)
													if (row.run_id)
														(entry.ownedRunIds ??= new Set()).add(row.run_id);
											}
											if (entry.pendingSendCommands?.get(commandId) === pending)
												entry.pendingSendCommands.delete(commandId);
										}
									}),
								)
								.pipe(
									Effect.catch((cause) =>
										Effect.logWarning(
											"Runner send ownership acknowledgement failed",
											cause,
										),
									),
								),
						);
					},
					onUpgradeState: (state) => {
						if (
							entry.upgrade.state &&
							state.revision < entry.upgrade.state.revision
						)
							return;
						observeSourceDelivery(entry, state);
						const snapshot = state.snapshot ?? entry.upgrade.state?.snapshot;
						// Only snapshots are omitted when unchanged. An omitted cursor is cleared.
						entry.upgrade.state = {
							...state,
							...(snapshot ? { snapshot } : {}),
						};
						notifyEntry(entry);
						if (
							state.snapshot &&
							process.env["NODE_ENV"] === "test" &&
							process.env["CONDUIT_TEST_UPGRADE_SINK_PROOF"] === "1" &&
							process.connected
						)
							process.send?.({
								channel: "conduit-process-test",
								kind: "runner-snapshot-observed",
								sessionId,
							});
						upgrade(sessionId, entry);
					},
					onIdleExit: () => {
						transition(entry, { _tag: "IdleExit" });
						if (process.env["NODE_ENV"] === "test" && process.connected)
							process.send?.({
								channel: "conduit-process-test",
								kind: "runner-idle-exit-started",
								pid: entry.pid,
							});
					},
					onClose: (failure) => failed(sessionId, entry, failure),
				});
			});

		const start = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				const registrationRoot =
					entry.registrationRoot ??
					(yield* deps.projectRootForSession(sessionId));
				if (!registrationRoot)
					return yield* Effect.fail(
						runnerFailure(
							"spawn runner",
							`Session ${sessionId} has no registered project`,
						),
					);
				if (Buffer.byteLength(entry.socketPath) >= 104)
					return yield* Effect.fail(
						runnerFailure(
							"spawn runner",
							"Conduit config directory is too long for a Runner Unix socket",
						),
					);
				const child = yield* Effect.try({
					try: () => {
						if (closing || entry.lifecycle.stop)
							throw runnerFailure("spawn runner", "Runners are shutting down");
						prepareRunnerDirectory(registrationRoot, configDir);
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
									entry.lifecycle.candidate ? "upgrade" : "active",
									driver.driverKind,
								],
								{
									cwd: entry.launch?.workspaceRoot ?? registrationRoot,
									env: {
										...process.env,
										...driver.spawnEnvironment,
										CONDUIT_CONFIG_DIR: configDir,
									},
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
				const startupStartedAt = performance.now();
				let startupTimeoutElapsedMs: number | undefined;
				let listeningAfterMs: number | undefined;
				let startupTimeoutLogged = false;
				const logStartupTimeout = (exited: boolean) => {
					if (startupTimeoutElapsedMs === undefined || startupTimeoutLogged)
						return;
					startupTimeoutLogged = true;
					log.error(
						`${runnerLabel} failed for session ${sessionId}: Runner startup timed out pid=${child.pid} timeoutMs=${startupTimeoutMs} elapsedMs=${startupTimeoutElapsedMs} readinessReceivedAfterMs=${listeningAfterMs ?? "none"} readinessLate=${listeningAfterMs !== undefined && listeningAfterMs >= startupTimeoutMs} exited=${exited} exitCode=${exited ? child.exitCode : "not-exited"} signal=${exited ? child.signalCode : "not-exited"}`,
					);
				};
				child.once("exit", () => {
					logStartupTimeout(true);
					entry.connection?.destroy();
					failed(
						sessionId,
						entry,
						runnerFailure("spawn runner", "Runner exited"),
					);
					removeRunner(entry.socketPath);
				});
				yield* Effect.callback<void, SessionFailure>((resume) => {
					let timeoutCheck: NodeJS.Immediate | undefined;
					let settled = false;
					const cleanup = () => {
						clearTimeout(timer);
						clearImmediate(timeoutCheck);
						child.off("error", failed);
						child.off("exit", exited);
					};
					const failed = (cause: unknown) => {
						if (settled) return;
						settled = true;
						cleanup();
						resume(Effect.fail(runnerFailure("spawn runner", cause)));
					};
					const timer = setTimeout(() => {
						// A starved event loop can run this timer before reading queued IPC.
						// Give readiness one poll before committing the timeout failure.
						timeoutCheck = setImmediate(() => {
							if (settled || Entry.hasReadinessNotice(entry.lifecycle)) return;
							transition(entry, { _tag: "StartupTimedOut" });
							startupTimeoutElapsedMs = Math.round(
								performance.now() - startupStartedAt,
							);
							failed("Runner startup timed out");
							runFork(
								Deferred.await(entry.stopped).pipe(
									Effect.andThen(
										Effect.sync(() =>
											logStartupTimeout(
												child.exitCode !== null || child.signalCode !== null,
											),
										),
									),
								),
							);
						});
					}, startupTimeoutMs);
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
						transition(entry, { _tag: "Listening" });
						listeningAfterMs = Math.round(performance.now() - startupStartedAt);
						if (settled) return;
						settled = true;
						cleanup();
						resume(Effect.void);
					});
					return Effect.sync(() => {
						settled = true;
						cleanup();
					});
				});
				return yield* attach(sessionId, entry);
			}).pipe(
				Effect.tap(() =>
					Effect.sync(() => transition(entry, { _tag: "Ready" })),
				),
				Effect.onError((cause) =>
					Effect.sync(() => {
						detach(entry);
						failed(
							sessionId,
							entry,
							runnerFailure("spawn runner", Failure.squashCause(cause)),
						);
					}),
				),
			);

		const createEntry = (
			sessionId: string,
			owner?: {
				readonly projectId?: string | undefined;
				readonly ingestion?: ProviderRuntimeIngestion | undefined;
				readonly pendingInteractions?: PendingInteractionService | undefined;
			},
		): Effect.Effect<RunnerChild, SessionFailure> =>
			Effect.gen(function* () {
				const registrationRoot = yield* deps.projectRootForSession(
					sessionId,
					owner?.projectId,
				);
				if (!registrationRoot)
					return yield* Effect.fail(
						runnerFailure(
							"spawn runner",
							`Session ${sessionId} has no registered project`,
						),
					);
				const runnerId = randomBytes(6).toString("hex");
				return {
					sessionId,
					registrationRoot,
					ingestion: owner?.ingestion,
					pendingInteractions: owner?.pendingInteractions,
					lifecycle: Entry.initialRunnerLifecycle(),
					runnerId,
					ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
					stopped: yield* Deferred.make<void>(),
					drained: yield* Deferred.make<void>(),
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
					outputs: yield* Semaphore.make(1),
					socketPath: join(
						runnerDirectory(registrationRoot, configDir),
						runnerId,
					),
				} satisfies RunnerChild;
			});
		const eligible = (sessionId: string, entry: RunnerChild) =>
			!closing &&
			!recovering &&
			!quarantined.has(sessionId) &&
			children.get(sessionId) === entry &&
			Entry.canUpgrade(entry.lifecycle) &&
			entry.buildId !== undefined &&
			(entry.buildId !== runnerBuildId() ||
				(driver.driverKind === "cursor" &&
					entry.connection?.scopedCursorCredentials === false)) &&
			entry.upgrade.state?.quiescent === true &&
			(entry.upgrade.state.snapshot !== undefined ||
				driver.coldUpgrade === true);
		const upgrade = makeRunnerUpgrade<RunnerChild>({
			eligible,
			runFork,
			create: (sessionId, old) =>
				createEntry(sessionId, old).pipe(
					Effect.tap((entry) =>
						Effect.sync(() => {
							transition(entry, { _tag: "MakeCandidate" });
							entry.launch = old.launch ?? old.upgrade.state?.snapshot?.input;
							entry.upgrade.state = old.upgrade.state;
							candidates.add(entry);
						}),
					),
				),
			warm: (sessionId, old, replacement) => {
				const state = old.upgrade.state;
				const snapshot = state?.snapshot;
				const warm = Effect.gen(function* () {
					if (!snapshot && !driver.coldUpgrade)
						return yield* Effect.fail(
							runnerFailure(
								"upgrade runner",
								"Session launch snapshot is missing",
							),
						);
					const connection = yield* start(sessionId, replacement);
					yield* Deferred.succeed(replacement.ready, connection);
					upgradeMark(sessionId, old, "warming", replacement);
					if (state && snapshot)
						yield* connection.commandEffect(
							randomUUID(),
							driver.warmCommand(sessionId, state, snapshot),
						);
				});
				return snapshot?.input.account && deps.accountResources
					? deps.accountResources
							.use(snapshot.input.account, () => warm)
							.pipe(
								Effect.mapError((cause) =>
									runnerFailure("upgrade runner", cause),
								),
							)
					: warm;
			},
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
							}>`SELECT command_id FROM provider_command_outbox WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId}) AND session_id = ${sessionId} AND status = 'running' AND effect_type = 'send_turn' LIMIT 1`.pipe(
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
								replacement.lifecycle.failure ||
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
						Effect.timeoutOrElse({
							duration: "1 second",
							orElse: () =>
								Effect.fail(
									runnerFailure(
										"upgrade runner",
										"Retirement confirmation timed out",
									),
								),
						}),
						Effect.onError(() =>
							Effect.sync(() => connection.write({ type: "upgrade-cancel" })),
						),
					);
					if (!retired) return false;
					return yield* lock.withPermits(1)(
						Effect.gen(function* () {
							if (
								activity !== old.upgrade.activity ||
								!eligible(sessionId, old) ||
								replacement.lifecycle.failure ||
								replacement.connection?.closed
							) {
								connection.write({ type: "upgrade-cancel" });
								return false;
							}
							yield* observeProcess(sessionId, replacement);
							transition(replacement, { _tag: "Promote" });
							replacement.connection?.write({ type: "upgrade-activate" });
							children.set(sessionId, replacement);
							old.sourceDelivery = undefined;
							notifyEntry(old);
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
			getControlCommandStatusEffect(
				sessionId: string,
				control: ProviderControlContext,
			): Effect.Effect<ProviderControlCommandStatus, SessionFailure> {
				return Effect.gen(function* () {
					const entry = children.get(sessionId);
					if (entry && entry.runnerId !== control.providerProcessId)
						return "gone";
					const unavailable = () =>
						runnerFailure(
							"get control command status",
							"The original runner command state is unavailable",
						);
					if (!entry) return yield* Effect.fail(unavailable());
					const pid = entry.pid ?? entry.child?.pid;
					if (pid !== undefined && !runnerPidAlive(pid)) return "gone";
					const connection = entry.connection;
					if (
						!connection ||
						connection.closed ||
						!Entry.canControl(entry.lifecycle)
					)
						return yield* Effect.fail(unavailable());
					const status = yield* Effect.result(
						connection.commandStatusEffect(control.commandId),
					);
					const current = children.get(sessionId);
					if (current && current.runnerId !== control.providerProcessId)
						return "gone";
					if (pid !== undefined && !runnerPidAlive(pid)) return "gone";
					if (status._tag === "Failure")
						return yield* Effect.fail(status.failure);
					if (
						current !== entry ||
						entry.connection !== connection ||
						connection.closed ||
						!Entry.canControl(entry.lifecycle)
					)
						return yield* Effect.fail(unavailable());
					return status.success;
				});
			}
			getControlProcessIdEffect(
				sessionId: string,
			): Effect.Effect<string | undefined> {
				return Effect.sync(() => {
					const entry = children.get(sessionId);
					return entry && Entry.canControl(entry.lifecycle)
						? entry.runnerId
						: undefined;
				});
			}
			detachSessionEffect(sessionId: string): Effect.Effect<void> {
				return lock
					.withPermits(1)(
						Effect.gen(function* () {
							const entries = [...children.values(), ...candidates].filter(
								(entry) => entry.sessionId === sessionId,
							);
							for (const entry of entries) {
								const failure = runnerFailure(
									"detach runner",
									"Project released its runner attachment",
								);
								const detached = { ...failure, code: "runner_detached" };
								transition(entry, { _tag: "Fail", failure: detached });
								if (
									entry.pid === undefined ||
									(entry.child && Entry.needsStartupStop(entry.lifecycle))
								)
									yield* stop(entry);
								else detach(entry, detached);
								evict(sessionId, entry);
								candidates.delete(entry);
								yield* releaseEntryWaiters(entry, Cause.fail(detached));
							}
						}),
					)
					.pipe(Effect.uninterruptible);
			}
			readonly recoverEffect = this.attachRegisteredSessions();

			attachSessionsEffect(sessionIds: readonly string[]) {
				return this.attachRegisteredSessions(new Set(sessionIds));
			}

			attachRegisteredSessions(sessionIds?: ReadonlySet<string>) {
				return Effect.gen(function* () {
					// Discover every surviving candidate before scheduling replacements.
					if (!sessionIds) recovering = true;
					if (closing)
						return yield* Effect.fail(
							runnerFailure("recover runner", "Runners are shutting down"),
						);
					const recoveryScope = yield* Effect.serviceOption(
						PersistenceProjectTag,
					);
					const recoveryIngestion = yield* Effect.serviceOption(
						ProviderRuntimeIngestionTag,
					);
					const recoveryPending = yield* Effect.serviceOption(
						PendingInteractionServiceTag,
					);
					for (const registration of discoverAllRunners(configDir)) {
						// Runner builds predating driverKind were all Claude.
						if ((registration.driverKind ?? "claude") !== driver.driverKind)
							continue;
						if (
							sessionIds &&
							(!sessionIds.has(registration.sessionId) ||
								(children.get(registration.sessionId)?.runnerId ===
									registration.runnerId &&
									!Entry.isAwaitingProject(
										children.get(registration.sessionId)?.lifecycle,
									)))
						)
							continue;
						const persisted = sql
							? (yield* sql<{
									project_id: string;
								}>`SELECT project_id FROM sessions WHERE id = ${registration.sessionId} LIMIT 1`.pipe(
									Effect.mapError((cause) =>
										runnerFailure("recover runner session", cause),
									),
								))[0]
							: undefined;
						const outstandingEnd =
							sql && !persisted
								? (yield* sql<{
										command_id: string;
										project_key: string;
									}>`SELECT command_id, project_key FROM provider_command_outbox
										WHERE session_id = ${registration.sessionId}
											AND provider_process_id = ${registration.runnerId}
											AND effect_type = 'end_session'
											AND status IN ('pending', 'running', 'retryable_failed')
										ORDER BY request_sequence LIMIT 1`.pipe(
										Effect.mapError((cause) =>
											runnerFailure("recover runner cleanup", cause),
										),
									))[0]
								: undefined;
						const cleanupRoot = outstandingEnd
							? yield* deps.projectRootForSession(
									registration.sessionId,
									outstandingEnd.project_key,
								)
							: undefined;
						if (
							!deps.recoveryForSession &&
							persisted &&
							recoveryScope._tag === "Some" &&
							persisted.project_id !== recoveryScope.value.projectId
						)
							continue;
						const recovery = yield* deps.recoveryForSession?.(
							registration.sessionId,
						) ?? Effect.succeed(undefined);
						// Recovery also owns runners whose project cannot currently ingest.
						// Reattach their spool once the project's services become available.
						if (
							Entry.isAwaitingProject(
								children.get(registration.sessionId)?.lifecycle,
							) &&
							recovery
						)
							yield* runner.detachSessionEffect(registration.sessionId);
						const ingestion =
							recovery?.ingestion ??
							(deps.recoveryForSession
								? undefined
								: recoveryIngestion._tag === "Some"
									? recoveryIngestion.value
									: yield* ingestionForSession(registration.sessionId));
						// A committed End still owns its exact runner after session deletion.
						// Other orphaned warms need only an identity hello before stopping.
						let abandoned =
							(sql !== undefined && !persisted && !outstandingEnd) ||
							registration.role === "candidate" ||
							children.has(registration.sessionId);
						const entry: RunnerChild = {
							...registration,
							...(outstandingEnd
								? { registrationRoot: cleanupRoot ?? configDir }
								: {}),
							lifecycle: Entry.initialRunnerLifecycle({
								awaitingProject:
									!!deps.recoveryForSession && !!persisted && !recovery,
								candidate: abandoned,
							}),
							ingestion,
							pendingInteractions:
								recovery?.pending ??
								(recoveryPending._tag === "Some"
									? recoveryPending.value
									: undefined),
							upgrade: {
								activity: 0,
								inFlight: false,
								failures: 0,
								retryAt: 0,
							},
							outputs: yield* Semaphore.make(1),
							drained: yield* Deferred.make<void>(),
							ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
							stopped: yield* Deferred.make<void>(),
						};
						yield* lock.withPermits(1)(
							Effect.gen(function* () {
								if (closing)
									return yield* Effect.fail(
										runnerFailure(
											"recover runner",
											"Runners are shutting down",
										),
									);
								abandoned ||= children.has(registration.sessionId);
								if (abandoned) transition(entry, { _tag: "MakeCandidate" });
								if (abandoned) candidates.add(entry);
								else children.set(registration.sessionId, entry);
							}),
						);
						if (sql && outstandingEnd && !abandoned)
							runFork(
								sql<{ pending: number }>`SELECT EXISTS (
									SELECT 1 FROM provider_command_outbox
									WHERE command_id = ${outstandingEnd.command_id}
										AND project_key = ${outstandingEnd.project_key}
										AND session_id = ${registration.sessionId}
										AND provider_process_id = ${registration.runnerId}
										AND effect_type = 'end_session'
										AND status IN ('pending', 'running', 'retryable_failed')
								) AS pending`.pipe(
									Effect.map(([row]) => row?.pending === 1),
									// A failed read provides no terminal proof. The grace still bounds it.
									Effect.catch(() => Effect.succeed(true)),
									Effect.repeat({
										while: (pending) => pending,
										schedule: Schedule.spaced("100 millis"),
									}),
									// Give the captured End the same grace as native control delivery.
									Effect.timeoutOption(STOP_ABORT_WAIT_MS),
									Effect.andThen(retireOrphan(entry)),
								),
							);
						const ensureRecovering = Effect.suspend(() =>
							!closing &&
							Entry.canControl(entry.lifecycle) &&
							(entry.lifecycle.candidate
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
							let connected = yield* Effect.result(
								attach(registration.sessionId, entry, abandoned),
							);
							yield* ensureRecovering;
							// A previous server may still own the socket while its shutdown
							// drains. Rejected hellos do not prove that the runner is dead.
							for (
								let retry = 0;
								(connected._tag === "Failure"
									? connected.failure.code !== "runner_incompatible"
									: connected.success.closed) &&
								runnerPidAlive(registration.pid) &&
								retry < 4;
								retry++
							) {
								yield* Effect.sleep(100 * 2 ** retry);
								yield* ensureRecovering;
								connected = yield* Effect.result(
									attach(registration.sessionId, entry, abandoned),
								);
								yield* ensureRecovering;
							}
							if (
								connected._tag === "Failure" &&
								connected.failure.code === "runner_incompatible" &&
								runnerPidMatchesRegistration(registration)
							) {
								const failure = connected.failure;
								log.warn(failure.message);
								// A failed hello needs independent process identity before signalling.
								transition(entry, { _tag: "Verify" });
								yield* Deferred.fail(entry.ready, failure);
								yield* stop(entry);
								if (runnerPidAlive(registration.pid))
									return yield* quarantine(entry, failure);
								if (!abandoned && sql && ingestion) {
									// Only this runner's interactions lost their owner.
									yield* retireReplacedPrompts(null, {
										sessionId: registration.sessionId,
										expiredProcessId: registration.runnerId,
									}).pipe(
										Effect.mapError((cause) =>
											runnerFailure("refuse runner interactions", cause),
										),
									);
									const { owners } = yield* sessionRunOwnersQuery(
										sql,
										registration.sessionId,
										{ confirmedStop: true },
									).pipe(
										Effect.mapError((cause) =>
											runnerFailure("refuse runner owners", cause),
										),
									);
									yield* settleSessionRuns(
										sql,
										registration.sessionId,
										failure.message,
										(events) => ingestion.ingestBatch(events),
										{ errorCode: "runner_stopped", owners },
									).pipe(
										Effect.mapError((cause) =>
											runnerFailure("refuse runner", cause),
										),
									);
								}
								transition(entry, { _tag: "Recovered" });
								transition(entry, { _tag: "Fail", failure });
								evict(registration.sessionId, entry);
								candidates.delete(entry);
								yield* releaseEntryWaiters(entry, Cause.fail(failure));
								return;
							}
							if (connected._tag === "Failure" || connected.success.closed) {
								const failure =
									connected._tag === "Failure"
										? connected.failure
										: runnerFailure(
												"recover runner",
												"Runner disconnected during recovery",
											);
								if (!runnerPidAlive(registration.pid)) {
									transition(entry, { _tag: "Recovered" });
									const abandonedFailure: SessionFailure = {
										...failure,
										code: "runner_recovery_abandoned",
									};
									transition(entry, {
										_tag: "Fail",
										failure: abandonedFailure,
									});
									// Replay can allocate sinks before command waiters take ownership.
									yield* entry.outputs.withPermits(1)(
										Effect.gen(function* () {
											if (children.get(registration.sessionId) !== entry)
												return;
											for (const [sinkId, binding] of sinks) {
												if (binding.sessionId !== registration.sessionId)
													continue;
												yield* emit(
													{ type: "release-sink", sinkId },
													registration.sessionId,
												);
											}
										}),
									);
									evict(registration.sessionId, entry);
									candidates.delete(entry);
									yield* releaseEntryWaiters(
										entry,
										Cause.fail(abandonedFailure),
									);
									removeRunner(entry.socketPath);
									return;
								}
								// Keep its registration, spool and approval ownership intact.
								// Startup must not orphan approvals or launch a second runner.
								return yield* quarantine(entry, failure);
							}
							if (abandoned) {
								transition(entry, { _tag: "Recovered" });
								yield* Deferred.succeed(entry.ready, connected.success);
								// Shutdown skips retirement; waiters must still be released.
								yield* retireOrphan(entry).pipe(
									Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
								);
								return;
							}
							const commands =
								sql && persisted && !Entry.isAwaitingProject(entry.lifecycle)
									? yield* driver
											.recoverCommands(
												sql,
												registration.sessionId,
												connected.success,
												(sinkId, failure) => {
													const binding = sinks.get(sinkId);
													if (!binding?.pending) return Effect.void;
													if (
														failure.code === "cancelled" &&
														binding.runId &&
														ingestion
													)
														return entry.outputs
															.withPermits(1)(
																settleSessionRuns(
																	sql,
																	registration.sessionId,
																	failure.message,
																	(events) => ingestion.ingestBatch(events),
																	{
																		errorCode: "cancelled",
																		owners: [{ runId: binding.runId }],
																	},
																).pipe(
																	Effect.ensuring(
																		emit(
																			{ type: "release-sink", sinkId },
																			registration.sessionId,
																		).pipe(
																			Effect.ignore,
																			Effect.ensuring(
																				Effect.sync(() => releaseSink(sinkId)),
																			),
																		),
																	),
																),
															)
															.pipe(
																Effect.catch((cause) =>
																	Effect.logError(
																		"Could not settle recovered cancellation",
																		cause,
																	),
																),
															);
													return (
														entry.lifecycle.failure
															? Deferred.await(entry.stopped)
															: Effect.void
													).pipe(
														Effect.andThen(
															entry.outputs.withPermits(1)(
																failRunnerTurn(
																	(output) =>
																		emit(output, registration.sessionId),
																	sinkId,
																	binding,
																	failure,
																	driver.driverKind,
																).pipe(
																	Effect.ensuring(
																		Effect.sync(() => releaseSink(sinkId)),
																	),
																),
															),
														),
													);
												},
												() =>
													closing ||
													children.get(registration.sessionId) !== entry,
												runner.getNativeSessionEffect(registration.sessionId),
												(commandId, inputId, attempt, nativeResumeFallback) => {
													if (!driver.admitsRecoveredSends)
														entry.pendingSendCommands?.set(commandId, attempt);
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
												(accountId, input, sinkId, work) =>
													runner.withTurnEffect(
														input,
														sinkId,
														work((command) =>
															Effect.gen(function* () {
																// Write the replay frame before invalidation can issue Stop.
																const executing = yield* command.pipe(
																	Effect.forkChild({ startImmediately: true }),
																);
																const demand = accountDemands.get(sinkId);
																if (demand)
																	yield* Deferred.succeed(
																		demand.dispatched,
																		connected.success,
																	);
																return yield* Fiber.join(executing);
															}),
														),
														accountId,
													),
												(commandId, command, attempt) =>
													sinks.get(command.sinkId)?.accepted
														? connected.success.commandEffect(
																commandId,
																command,
																attempt,
															)
														: runner.executeEffect(command, entry).pipe(
																Effect.flatMap((result) =>
																	result.status === "cancelled"
																		? Effect.fail({
																				...runnerFailure(
																					"send-turn",
																					"Input cancelled before intake",
																				),
																				code: "cancelled",
																			})
																		: Effect.succeed(result),
																),
															),
												(sinkId, replay) =>
													Effect.suspend(() => {
														const pending = pendingSends.get(sinkId);
														return pending
															? Effect.raceFirst(
																	Deferred.await(pending.cancelled).pipe(
																		Effect.andThen(
																			Effect.fail({
																				...runnerFailure(
																					"send-turn",
																					"Input cancelled before intake",
																				),
																				code: "cancelled",
																			}),
																		),
																	),
																	replay,
																)
															: replay;
													}),
											)
											.pipe(
												Effect.provideService(PersistenceProjectTag, {
													projectId: persisted.project_id,
												}),
												Effect.map((commands) =>
													commands.map((command) => {
														const wait = command.wait.pipe(
															Effect.provideService(PersistenceProjectTag, {
																projectId: persisted.project_id,
															}),
															Effect.provideService(SqlClient.SqlClient, sql),
														);
														return {
															...command,
															wait: recovery
																? wait.pipe(
																		Effect.provideService(
																			ClaudeEventPersistEffectTag,
																			recovery.persist,
																		),
																	)
																: wait,
														};
													}),
												),
												Effect.mapError((cause) =>
													runnerFailure("recover runner commands", cause),
												),
											)
									: [];
							yield* lock.withPermits(1)(
								Effect.gen(function* () {
									yield* ensureRecovering;
									const admissions: Deferred.Deferred<void>[] = [];
									for (const command of commands) {
										let binding = sinks.get(command.sinkId);
										// The server can persist admission before the runner sees it.
										if (!binding) {
											binding = {
												sessionId: registration.sessionId,
												inputId: command.input.inputId,
												...(command.input.continuation
													? {}
													: {
															placement: {
																inputId: command.input.inputId,
																text:
																	command.input.text ?? command.input.prompt,
																...(command.input.images
																	? { images: command.input.images }
																	: {}),
															},
														}),
												messageId: command.messageId,
												...(command.runId ? { runId: command.runId } : {}),
												pending: true,
												accepted: false,
												releaseRequested: false,
											};
											sinks.set(command.sinkId, binding);
										}
										if (!binding.accepted) {
											binding.admission ??= yield* Deferred.make<void>();
											admissions.push(binding.admission);
										}
										const admission = binding.admission;
										// Own cancellation before replay captures env or prepares continuation.
										const reattaching =
											binding.accepted || !driver.admitsRecoveredSends;
										if (reattaching)
											transition(entry, { _tag: "AdmitCommand" });
										else
											pendingSends.set(command.sinkId, {
												sessionId: registration.sessionId,
												turnId:
													command.input.continuation?.cutOffMessageId ??
													command.input.inputId,
												cancelled: yield* Deferred.make<void>(),
											});
										runFork(
											command.wait.pipe(
												Effect.onExit(() => {
													return entry.outputs.withPermits(1)(
														Effect.gen(function* () {
															if (
																!binding ||
																sinks.get(command.sinkId) !== binding ||
																closing
															)
																return;
															binding.pending = false;
															if (
																binding.releaseRequested ||
																entry.lifecycle.failure
															) {
																yield* emit(
																	{
																		type: "release-sink",
																		sinkId: command.sinkId,
																	},
																	registration.sessionId,
																);
																releaseSink(command.sinkId);
															}
														}),
													);
												}),
												Effect.ensuring(
													admission
														? Deferred.succeed(admission, undefined)
														: Effect.void,
												),
												Effect.catchCause((cause) =>
													Effect.logError(
														"Runner command recovery failed",
														cause,
													),
												),
												Effect.ensuring(
													Effect.sync(() => {
														if (reattaching)
															transition(entry, { _tag: "FinishCommand" });
														else pendingSends.delete(command.sinkId);
														upgrade(registration.sessionId, entry);
													}),
												),
											),
										);
									}
									// Waiters own restored turns before commands or close callbacks run.
									transition(entry, { _tag: "Recovered" });
									if (admissions.length === 0)
										yield* Deferred.succeed(entry.ready, connected.success);
									else
										runFork(
											Effect.forEach(admissions, Deferred.await, {
												discard: true,
											}).pipe(
												Effect.andThen(ensureRecovering),
												Effect.flatMap(() =>
													connected.success.closed
														? Effect.fail(
																runnerFailure(
																	"recover runner",
																	"Runner disconnected during recovery",
																),
															)
														: Deferred.succeed(entry.ready, connected.success),
												),
												Effect.catch((failure) =>
													Deferred.fail(entry.ready, failure),
												),
											),
										);
									if (connected.success.closed)
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
								transition(entry, { _tag: "Recovered" });
								transition(entry, {
									_tag: "Fail",
									failure: runnerFailure(
										"recover runner",
										Failure.squashCause(exit.cause),
									),
								});
								entry.connection?.destroy();
								evict(registration.sessionId, entry);
								candidates.delete(entry);
								return releaseEntryWaiters(entry, exit.cause);
							}),
						);
					}
				}).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (!sessionIds) recovering = false;
							if (Exit.isSuccess(exit))
								for (const [sessionId, entry] of children)
									if (!sessionIds || sessionIds.has(sessionId))
										upgrade(sessionId, entry);
						}),
					),
				);
			}
			hasLiveProcessEffect(
				sessionId: string,
				processId?: string,
			): Effect.Effect<boolean> {
				return Effect.sync(() => {
					// Before hello only the spawned child's pid is known.
					const alive = (entry: RunnerChild) => {
						const pid = entry.pid ?? entry.child?.pid;
						return pid !== undefined && runnerPidAlive(pid);
					};
					for (const entry of exiting) if (!alive(entry)) exiting.delete(entry);
					const owns = (entry: RunnerChild | undefined) =>
						entry?.sessionId === sessionId &&
						(processId === undefined || entry.runnerId === processId) &&
						alive(entry);
					return (
						owns(children.get(sessionId)) ||
						[...candidates, ...exiting].some(
							(entry) =>
								(processId === undefined ||
									entry.lifecycle.failure?.code === "runner_quarantined") &&
								owns(entry),
						)
					);
				});
			}

			hasDemandEffect(sessionId: string): Effect.Effect<boolean> {
				return Effect.sync(() => {
					const entry = children.get(sessionId);
					return (
						entry !== undefined &&
						Entry.countsTowardDemand(entry.lifecycle) &&
						(entry.upgrade.inFlight || entry.upgrade.state?.quiescent !== true)
					);
				});
			}

			getSessionFailureEffect(sessionId: string) {
				return Effect.sync(() => quarantined.get(sessionId));
			}

			getAccountSwitchBlockEffect(sessionId: string, account: Account) {
				return Effect.sync(() => {
					const entry = children.get(sessionId);
					const snapshot = entry?.upgrade.state?.snapshot;
					if (
						!entry ||
						!Entry.canReconfigure(entry.lifecycle) ||
						!snapshot ||
						Entry.isQuiet(
							entry.lifecycle,
							entry.upgrade.state?.quiescent === true,
						)
					)
						return undefined;
					const live = snapshot.input;
					const target = {
						account,
						instanceId: account.id,
						configDir: "folder" in account ? account.folder : live.configDir,
						root: live.workspaceRoot,
						shellConfig: live.shellConfig,
					};
					if (
						driver.loginChange(
							{ ...live, root: live.workspaceRoot },
							target,
						) !== "Account"
					)
						return undefined;
					return new AccountSwitchBusy({
						sessionId,
						fromAccountId:
							live.account?.id ?? live.instanceId ?? driver.driverKind,
						toAccountId: account.id,
						message: accountSwitchBusyMessage(
							accountDisplayName(live),
							accountDisplayName(target),
						),
					});
				});
			}

			getNativeSessionEffect(
				sessionId: string,
			): Effect.Effect<ProviderNativeSession | undefined> {
				return Effect.sync(() => {
					const entry = children.get(sessionId);
					const state = entry?.upgrade.state;
					const snapshot = state?.snapshot;
					if (!entry || !Entry.canReconfigure(entry.lifecycle) || !snapshot)
						return undefined;
					return {
						instanceId: snapshot.input.instanceId ?? driver.driverKind,
						configDir: snapshot.input.configDir,
						agent: snapshot.input.agent,
						resumeSessionId: state?.resumeSessionId,
					};
				});
			}

			withTurnEffect<A, E, R>(
				input: SessionTurn,
				sinkId: string,
				work: Effect.Effect<A, E, R>,
				accountId: string | undefined = input.account?.id,
			): Effect.Effect<A, E | SessionFailure, R> {
				return retainAccount(
					sinkId,
					accountId,
					input.sessionId,
					input.inputId,
				).pipe(
					Effect.andThen(() => {
						const demand = accountDemands.get(sinkId);
						return demand
							? Effect.raceFirst(
									work.pipe(
										Effect.catchCause(
											(cause): Effect.Effect<never, E | SessionFailure> =>
												!closing &&
												!Deferred.isDoneUnsafe(demand.dispatched) &&
												Failure.isInterruptedOnly(cause)
													? Effect.fail(
															runnerFailure(
																"prepare turn",
																"Cursor account was invalidated",
															),
														)
													: Effect.failCause(cause),
										),
									),
									Deferred.await(demand.invalidated).pipe(
										Effect.andThen(
											Effect.suspend(() =>
												Deferred.isDoneUnsafe(demand.dispatched)
													? Effect.never
													: Effect.fail(
															runnerFailure(
																"prepare turn",
																"Cursor account was invalidated",
															),
														),
											),
										),
									),
								)
							: work;
					}),
					Effect.onError(() =>
						Effect.sync(() => {
							const demand = accountDemands.get(sinkId);
							if (demand && !Deferred.isDoneUnsafe(demand.dispatched))
								Deferred.doneUnsafe(demand.finished, Effect.void);
						}),
					),
				);
			}

			executeEffect(
				command: Extract<SessionCommand, { type: "send-turn" }>,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult, SessionFailure>;
			executeEffect(
				command: Exclude<SessionCommand, { type: "send-turn" }>,
				recovered?: RunnerChild,
			): Effect.Effect<void, SessionFailure>;
			executeEffect(
				command: SessionCommand,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult | undefined, SessionFailure>;
			executeEffect(
				command: SessionCommand,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult | undefined, SessionFailure> {
				const recoveredTurn =
					command.type === "send-turn" && recovered
						? sinks.get(command.sinkId)
						: undefined;
				const turn =
					command.type === "send-turn"
						? (recoveredTurn ?? {
								sessionId: command.input.sessionId,
								inputId: command.input.inputId,
								runId: command.input.runId,
								...(command.input.continuation
									? {}
									: {
											placement: {
												inputId: command.input.inputId,
												text: command.input.text ?? command.input.prompt,
												...(command.input.images
													? { images: command.input.images }
													: {}),
											},
										}),
								messageId: "",
								pending: true,
								accepted: false,
								releaseRequested: false,
							})
						: undefined;
				let child: RunnerChild | undefined;
				let sentToRunner = false;
				let admitted: RunnerChild | undefined;
				let admittedSessionId = "";
				let ending: RunnerChild | undefined;
				let cancelled: Deferred.Deferred<void> | undefined;
				let deliveryRegistration:
					| { entry: RunnerChild; changed: Deferred.Deferred<void> }
					| undefined;
				const execute = Effect.gen(function* () {
					const autoSettleAfterDays =
						command.type === "send-turn"
							? command.input.autoSettleAfterDays !== undefined
								? command.input.autoSettleAfterDays
								: yield* deps.autoSettleAfterDays ?? Effect.succeed(undefined)
							: undefined;
					if (command.type === "send-turn" && cancelled) {
						pendingSends.set(command.sinkId, {
							sessionId: command.input.sessionId,
							turnId:
								command.input.continuation?.cutOffMessageId ??
								command.input.inputId,
							cancelled,
						});
						sentToRunner = false;
					}
					const outputOwner = yield* currentRunnerOutput;
					if (command.type === "abort") {
						const pending = pendingSends.get(command.sinkId);
						if (pending) {
							yield* Deferred.succeed(pending.cancelled, undefined);
							return;
						}
					}
					if (command.type === "interrupt") {
						for (const pending of pendingSends.values())
							if (
								pending.sessionId === command.sessionId &&
								(command.turnIds === undefined ||
									command.turnIds.includes(pending.turnId))
							)
								yield* Deferred.succeed(pending.cancelled, undefined);
					}
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
					if (command.type === "send-turn")
						yield* retainAccount(
							command.sinkId,
							command.input.account?.id,
							sessionId,
							command.input.inputId,
						);
					let entry: RunnerChild | undefined;
					let draining = false;
					do {
						const selection = yield* lock.withPermits(1)(
							Effect.gen(function* () {
								if (closing)
									return yield* Effect.fail(
										runnerFailure(command.type, "Runners are shutting down"),
									);
								const refusal = quarantined.get(sessionId);
								if (refusal) return yield* Effect.fail(refusal);
								const existing = children.get(sessionId);
								if (
									command.control &&
									(!existing ||
										existing.runnerId !== command.control.providerProcessId ||
										!Entry.canControl(existing.lifecycle))
								)
									return yield* Effect.fail({
										...runnerFailure(
											command.type,
											"The target provider process is no longer running",
										),
										code: "provider_process_gone",
									});
								if (
									existing &&
									existing !== recovered &&
									(command.type === "send-turn" ||
										command.type === "pre-warm") &&
									!Deferred.isDoneUnsafe(existing.ready)
								) {
									if (command.type === "pre-warm")
										return { entry: undefined, draining: false };
									return {
										entry: existing,
										draining: true,
										recoveryPending: true,
									};
								}
								if (
									outputOwner &&
									(command.type === "answer-permission" ||
										command.type === "answer-question" ||
										command.type === "interaction-failed") &&
									existing?.runnerId !== outputOwner.runnerId
								)
									return { entry: undefined, draining: false };
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
									const loginChange =
										launch === undefined
											? "None"
											: driver.loginChange(
													{
														...launch,
														configDir: launch.configDir,
														root: launch.workspaceRoot,
													},
													{
														...command.input,
														configDir: command.input.configDir,
														root: command.input.workspaceRoot,
														shellConfig:
															command.input.shellConfig ?? command.shellConfig,
													},
												);
									const legacyCursor =
										driver.driverKind === "cursor" &&
										existing.connection?.scopedCursorCredentials === false;
									// Observe before checking, under selection. Await only after releasing it.
									const changed = Deferred.makeUnsafe<void>();
									(existing.deliveryWaiters ??= new Set()).add(changed);
									deliveryRegistration = { entry: existing, changed };
									const delivery = existing.sourceDelivery;
									if (
										command.type === "send-turn" &&
										loginChange === "Account" &&
										!foldersChanged &&
										!legacyCursor &&
										Entry.canReconfigure(existing.lifecycle) &&
										delivery?.sessionId === sessionId &&
										delivery.runnerId === existing.runnerId &&
										delivery.generation > 0
									) {
										return {
											entry: existing,
											draining: true,
											sourceDeliveryPending: changed,
										};
									}
									existing.deliveryWaiters.delete(changed);
									deliveryRegistration = undefined;
									const decision = Entry.decideSend({
										command: command.type,
										lifecycle: existing.lifecycle,
										quiescent: existing.upgrade.state?.quiescent === true,
										rebindsAccount:
											existing.capabilities?.rebindsAccount === true,
										changes: {
											folders: foldersChanged,
											login: loginChange,
											legacyCursor,
											settingsDeferred:
												existing.upgrade.settingsDeferred === true,
										},
									});
									switch (decision) {
										case "Refuse":
											log.info(
												`Account switch refused for session ${sessionId}: runner is busy`,
											);
											return yield* Effect.fail({
												...runnerFailure(
													command.type,
													accountSwitchBusyMessage(
														accountDisplayName(launch),
														accountDisplayName(command.input),
													),
												),
												code: "account_switch_busy",
												retryable: false,
											});
										case "Skip":
											return { entry: undefined, draining: false };
										case "Wait":
											return {
												entry: existing,
												draining: true,
												foldersPending: true,
											};
										case "Retire":
											transition(existing, {
												_tag: "BeginEnd",
												released: yield* Deferred.make<void>(),
											});
											return {
												entry: existing,
												draining: true,
												retire: existing,
											};
										case "DeferRebind":
											log.info(
												`Account rebind deferred for session ${sessionId}: runner is busy`,
											);
											break;
										case "Use":
											break;
										default: {
											const _exhaustive: never = decision;
											return _exhaustive;
										}
									}
								}
								if (
									command.type === "pre-warm" &&
									existing &&
									!Entry.canPreWarm(existing.lifecycle)
								)
									return { entry: undefined, draining: false };
								if (
									existing ||
									(command.type !== "send-turn" && command.type !== "pre-warm")
								) {
									if (existing && command.type === "end-session") {
										transition(existing, {
											_tag: "BeginEnd",
											released:
												existing.lifecycle.end?.released ??
												(yield* Deferred.make<void>()),
										});
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
										existing !== undefined &&
										Entry.mustDrainBeforeSend(existing.lifecycle);
									if (
										existing &&
										!draining &&
										turn &&
										command.type === "send-turn"
									)
										sinks.set(command.sinkId, turn);
									if (existing && !draining) {
										transition(existing, { _tag: "AdmitCommand" });
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
										admission: existing?.lifecycle.end?.released,
									};
								}
								const created: RunnerChild = yield* createEntry(sessionId, {
									projectId: command.input.projectId,
								});
								if (command.type === "send-turn" || command.type === "pre-warm")
									created.launch = {
										workspaceRoot: command.input.workspaceRoot,
										extraFolders: command.input.extraFolders,
									};
								transition(created, { _tag: "AdmitCommand" });
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
						if (
							"sourceDeliveryPending" in selection &&
							selection.sourceDeliveryPending
						) {
							const changed = selection.sourceDeliveryPending;
							yield* Deferred.await(changed).pipe(
								Effect.ensuring(
									Effect.sync(() => {
										deliveryRegistration?.entry.deliveryWaiters?.delete(
											changed,
										);
										deliveryRegistration = undefined;
									}),
								),
							);
							continue;
						}
						if ("recoveryPending" in selection && entry) {
							const waiting = entry;
							yield* Deferred.await(waiting.ready).pipe(
								Effect.catch((failure) =>
									children.get(sessionId) !== waiting && waiting.lifecycle.stop
										? Effect.void
										: Effect.fail(failure),
								),
							);
							continue;
						}
						if ("foldersPending" in selection) {
							yield* Effect.sleep("10 millis");
							continue;
						}
						if (selection.retire) {
							const retiring = selection.retire;
							yield* runner
								.executeEffect({ type: "end-session", sessionId }, retiring)
								.pipe(
									Effect.ensuring(
										Effect.gen(function* () {
											const released = transition(retiring, {
												_tag: "FinishEnd",
											});
											if (released)
												yield* Deferred.succeed(released, undefined);
										}),
									),
									Effect.uninterruptible,
								);
						}
						// Old cleanup is session-wide. Finish it before a replacement
						// can register interactions or publish a new busy status.
						if (entry && draining)
							yield* Deferred.await(
								!entry.lifecycle.failure &&
									!entry.lifecycle.idleExiting &&
									selection.admission
									? selection.admission
									: entry.drained,
							);
					} while (draining);
					if (!entry) return;
					child = entry;
					sentToRunner = false;
					// Restored controls must still reach the old query while a send
					// waits to rebind. That send is what keeps admission readiness gated.
					const connection =
						entry.connection &&
						(entry === recovered ||
							(command.type !== "send-turn" &&
								command.type !== "pre-warm" &&
								!entry.connection.closed &&
								Entry.canUseControlConnection(entry.lifecycle)))
							? entry.connection
							: yield* Deferred.await(entry.ready);
					if (
						command.control &&
						(children.get(sessionId) !== entry ||
							entry.runnerId !== command.control.providerProcessId ||
							!Entry.canControl(entry.lifecycle) ||
							connection.closed)
					)
						return yield* Effect.fail({
							...runnerFailure(
								command.type,
								"The target provider process is no longer running",
							),
							code: "provider_process_gone",
						});
					if (command.type === "pre-warm" && !Entry.canPreWarm(entry.lifecycle))
						return;
					if (closing)
						return yield* Effect.fail(
							runnerFailure(command.type, "Runners are shutting down"),
						);
					if (command.type === "stop-task" && !entry.capabilities?.stopsTasks)
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
									autoSettleAfterDays,
									shellConfig: command.input.shellConfig ?? command.shellConfig,
									...(entry.upgrade.state?.frozen
										? driver.snapshotCommandSettings(
												entry.upgrade.state.snapshot,
											)
										: {}),
									shellEnv: command.input.shellEnv ??
										command.shellEnv ?? {
											...process.env,
										},
								}
							: command.type === "pre-warm"
								? {
										...command,
										shellConfig:
											command.input.shellConfig ?? command.shellConfig,
										shellEnv: command.input.shellEnv ??
											command.shellEnv ?? {
												...process.env,
											},
									}
								: command;
					let commandId =
						command.control?.commandId ??
						(command.type === "send-turn"
							? command.input.inputId
							: randomUUID());
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
							WHERE project_key = (SELECT project_id FROM sessions WHERE id = ${sessionId}) AND session_id = ${sessionId} AND effect_type = 'send_turn'
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
						// Read after readiness, while End holds admission against new sends.
						const cohortRunning =
							sql && command.control?.retireRunIds
								? sql<{
										running: number;
									}>`SELECT EXISTS (SELECT 1 FROM provider_runs
								WHERE session_id = ${sessionId} AND id IN ${sql.in(command.control.retireRunIds)}
								AND status IN ('pending', 'running')) AS running`.pipe(
										Effect.map(([row]) => row?.running === 1),
										Effect.mapError((cause) =>
											runnerFailure("retirement cohort", cause),
										),
									)
								: Effect.succeed(true);
						if (!(yield* cohortRunning)) return;
						if (!recovered)
							for (const pending of pendingSends.values())
								if (pending.sessionId === sessionId)
									yield* Deferred.succeed(pending.cancelled, undefined);
						// A native rejection can arrive after the reply deadline. Terminal
						// facts already committed by this runner still forbid killing its
						// successor, even if the run projection has not caught up.
						const cohortUnconfirmed =
							sql && command.control?.retireRunIds
								? sql<{ running: number }>`SELECT EXISTS (
									SELECT 1 FROM provider_runs owner
									WHERE owner.session_id = ${sessionId} AND owner.id IN ${sql.in(command.control.retireRunIds)}
									AND owner.status IN ('pending', 'running') AND NOT EXISTS (
										SELECT 1 FROM events terminal WHERE terminal.session_id = owner.session_id
										AND json_extract(terminal.metadata, '$.runId') = owner.id
										AND terminal.type IN ('turn.completed', 'turn.error', 'turn.interrupted')
									)) AS running`.pipe(
										Effect.map(([row]) => row?.running === 1),
										Effect.mapError((cause) =>
											runnerFailure("retirement terminal facts", cause),
										),
									)
								: cohortRunning;
						const settlement = settleExitedRuns(
							sessionId,
							entry,
							runnerFailure("end-session", "Provider process stopped"),
							commandId,
						);
						const ended = yield* connection
							.commandEffect(commandId, payload)
							.pipe(
								Effect.as(true),
								Effect.catch((failure) =>
									failure.code === "stop_cohort_ended"
										? Effect.succeed(false)
										: Effect.fail(failure),
								),
								Effect.timeoutOption("1 second"),
								Effect.onExit((exit) =>
									// A stale native End must not become a forced process kill.
									Exit.isSuccess(exit) &&
									Option.isSome(exit.value) &&
									!exit.value.value
										? Effect.void
										: cohortUnconfirmed.pipe(
												Effect.flatMap((running) =>
													running ? stop(entry) : Effect.void,
												),
											),
								),
								Effect.result,
							);
						if (
							!entry.lifecycle.stop &&
							((ended._tag === "Success" &&
								Option.isSome(ended.success) &&
								!ended.success.value) ||
								!(yield* cohortUnconfirmed))
						)
							return;
						// A terminal committed during shutdown cannot skip dead-runner cleanup.
						if (entry.lifecycle.stop) yield* Deferred.await(entry.stopped);
						const pid = entry.pid ?? entry.child?.pid;
						if (pid !== undefined && runnerPidAlive(pid)) {
							const failure = runnerFailure(
								"end-session",
								"Runner survived Stop escalation",
							);
							yield* quarantine(entry, failure);
							return yield* Effect.fail(failure);
						}
						yield* settlement.pipe(
							Effect.mapError((cause) =>
								runnerFailure("settle stopped runner", cause),
							),
						);
						yield* entry.lifecycle.failure
							? Deferred.await(entry.drained)
							: Effect.sync(() => evict(sessionId, entry)).pipe(
									Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
								);
						return;
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
					if (command.type === "send-turn") {
						const pending = pendingSends.get(command.sinkId);
						if (pending && Deferred.isDoneUnsafe(pending.cancelled))
							return CANCELLED_TURN;
						pendingSends.delete(command.sinkId);
					}
					sentToRunner = true;
					if (command.type === "send-turn") {
						const demand = accountDemands.get(command.sinkId);
						if (demand)
							Deferred.doneUnsafe(
								demand.dispatched,
								Effect.succeed(connection),
							);
					}
					if (command.type === "send-turn")
						entry.pendingSendCommands?.set(
							commandId,
							command.input.commandAttempt ?? 0,
						);
					if (command.type === "send-turn") {
						const binding = sinks.get(command.sinkId);
						if (binding) {
							binding.commandId = commandId;
							binding.runnerId = entry.runnerId;
						}
					}
					return yield* connection.commandEffect(
						commandId,
						payload,
						command.type === "send-turn"
							? command.input.commandAttempt
							: undefined,
					);
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							deliveryRegistration?.entry.deliveryWaiters?.delete(
								deliveryRegistration.changed,
							);
							deliveryRegistration = undefined;
							if (!admitted) return;
							transition(admitted, { _tag: "FinishCommand" });
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
					Effect.catchDefect((cause) =>
						Effect.fail(runnerFailure(command.type, cause)),
					),
					Effect.catch((failure) =>
						command.type === "pre-warm" &&
						(closing ||
							failure.code === "runner_idle_exit" ||
							(child &&
								(Entry.mustDrainBeforeSend(child.lifecycle) ||
									child.lifecycle.stop)))
							? Effect.succeed(undefined)
							: Effect.fail(failure),
					),
					Effect.onError((cause) => {
						if (
							command.type !== "send-turn" ||
							recovered ||
							!turn ||
							closing ||
							child?.lifecycle.failure?.code === "runner_detached" ||
							Failure.isInterruptedOnly(cause)
						)
							return Effect.void;
						// Explicit End owns settlement after confirmed exit. A socket
						// failure during its graceful phase is not a process terminal.
						if (child?.lifecycle.end) return Deferred.await(child.stopped);
						const cleanup = failRunnerTurn(
							emit,
							command.sinkId,
							turn,
							runnerFailure(command.type, Failure.squashCause(cause)),
							driver.driverKind,
						).pipe(
							Effect.ensuring(Effect.sync(() => releaseSink(command.sinkId))),
						);
						return (
							// Abandoned adoption preserves a runner that never received this send.
							(
								child?.lifecycle.failure && sentToRunner
									? Deferred.await(child.stopped)
									: Effect.void
							).pipe(
								Effect.andThen(
									child ? child.outputs.withPermits(1)(cleanup) : cleanup,
								),
							)
						);
					}),
					Effect.onExit((exit) =>
						Effect.gen(function* () {
							if (
								command.type === "send-turn" &&
								!sentToRunner &&
								!recoveredTurn
							)
								releaseSink(command.sinkId);
							const entry = child;
							if (
								!recoveredTurn &&
								turn &&
								command.type === "send-turn" &&
								entry
							)
								yield* entry.outputs.withPermits(1)(
									Effect.gen(function* () {
										turn.pending = false;
										if (
											turn.releaseRequested ||
											entry.lifecycle.failure ||
											(recovered && Exit.isFailure(exit))
										) {
											yield* emit({
												type: "release-sink",
												sinkId: command.sinkId,
											});
											releaseSink(command.sinkId);
										}
									}),
								);
							else if (!recoveredTurn && turn) turn.pending = false;
							const released =
								ending && transition(ending, { _tag: "FinishEnd" });
							if (released) yield* Deferred.succeed(released, undefined);
						}),
					),
				);
				if (command.type !== "send-turn") return execute;
				return Effect.gen(function* () {
					cancelled =
						pendingSends.get(command.sinkId)?.cancelled ??
						(yield* Deferred.make<void>());
					if (command.aborted) yield* Deferred.succeed(cancelled, undefined);
					return yield* Effect.raceFirst(
						Deferred.await(cancelled).pipe(Effect.as(CANCELLED_TURN)),
						execute,
					).pipe(
						Effect.ensuring(
							Effect.gen(function* () {
								pendingSends.delete(command.sinkId);
								if (!sentToRunner && !recoveredTurn) {
									releaseSink(command.sinkId);
									yield* emit({
										type: "release-sink",
										sinkId: command.sinkId,
									}).pipe(Effect.ignore);
								}
							}),
						),
					);
				});
			}
		}
		const runner = new ProcessSessionRunner();
		const sessionRunner: SessionRunner & {
			readonly recoverEffect: Effect.Effect<void, SessionFailure>;
			readonly withTurnEffect: NonNullable<SessionRunner["withTurnEffect"]>;
		} = runner;
		return sessionRunner;
	});
