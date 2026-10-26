import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Cause,
	Clock,
	Data,
	Deferred,
	Effect,
	Exit,
	Fiber,
	FiberSet,
	Option,
	PubSub,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../contracts/account.js";
import type { AttachmentRef } from "../../contracts/attachment-ref.js";
import {
	AccountSwitchBusy,
	accountSwitchBusyMessage,
} from "../../contracts/limit-recovery.js";
import { RunnerWriteOrigin } from "../../contracts/stored-event.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { InputDraftsTag } from "../../domain/relay/Services/input-drafts.js";
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
import { makeClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../persistence/effect/projection-runner-effect.js";
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
import {
	type Grant,
	makeRunnerAuthority,
	type RunnerRecord,
} from "./runner-authority.js";
import { connectRunner } from "./runner-connection.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	legacyRunnerBindings,
	legacyRunnerRetainedSends,
	recoverLegacyRunnerCommands,
	replayLegacyRunnerSend,
} from "./runner-legacy-recovery.js";
import {
	type RunnerHello,
	type RunnerSendAnswer,
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
import {
	currentPendingSendOwner,
	runnerCommandEnded,
	runningRunnerCommands,
	settleRunnerCommandReply,
} from "./runner-recovery.js";
import {
	discoverAllRunners,
	discoverRunners,
	prepareRunnerDirectory,
	type RunnerProcessTable,
	removeRunner,
	runnerDirectory,
	runnerPidAlive,
	runnerPidMatchesRegistration,
	runnerProcessTable,
} from "./runner-registry.js";
import { runnerSendCommandsForProcess } from "./runner-send-journal.js";
import { failRunnerTurn, observeRunnerTurn } from "./runner-turn-failure.js";
import { makeRunnerUpgrade, type RunnerUpgrade } from "./runner-upgrade.js";
import { makeSendAdmissionWait } from "./send-admission.js";
import { makeSendScopes, type SendScope } from "./send-scope.js";
import type {
	AdmitSend,
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

interface RunnerChild {
	readonly recoveringCommands?: boolean;
	readonly ownsPendingSend?: Effect.Success<typeof currentPendingSendOwner>;
	grant?: Grant | undefined;
	outputAuthority?: { grant: Grant | undefined } | undefined;
	attachmentId?: string | undefined;
	readonly registeredAt?: number;
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
	startTime?: string | undefined;
	child?: ChildProcess;
	connection?: RunnerSocket;
	buildId?: string;
	capabilities?: {
		readonly stopsTasks: boolean;
		readonly rebindsAccount: boolean;
		readonly settlesAnswers: boolean;
		readonly declaresLogin: boolean;
	};
	interactionSinks?: Map<string, string>;
	pendingSendCommands?: Map<string, number> | undefined;
	ownedRunIds?: Set<string>;
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
	readonly processTable?: RunnerProcessTable;
	readonly autoSettleAfterDays?: Effect.Effect<number | null | undefined>;
	readonly subagentPollTimeoutMs?: number;
	readonly sessionForkSdk?: import("../claude/claude-provider-runtime.js").ClaudeSessionRunnerDeps["sessionForkSdk"];
	readonly claudeSettingsOverrides?: import("../claude/claude-provider-runtime.js").ClaudeSessionRunnerDeps["claudeSettingsOverrides"];
	readonly projectRootForSession: NonNullable<
		RunnerProviderInstanceDeps["projectRootForSession"]
	>;
	readonly recoveryForSession?: RunnerProviderInstanceDeps["recoveryForSession"];
}

export interface ProcessRunnerDriver {
	readonly spawnEnvironment?: Readonly<Record<string, string>>;
	readonly driverKind: string;
	readonly legacyReplayCommandFields?: (
		accountId: string,
	) => Effect.Effect<
		Partial<Extract<SessionCommand, { type: "send-turn" }>>,
		SessionFailure
	>;
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
}

const log = createLogger("process-session-runner");
const CANCELLED_TURN: TurnResult = {
	status: "cancelled",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

const legacyAnswerCommandId = (entry: RunnerChild, commandId: string) =>
	entry.capabilities?.settlesAnswers === true
		? undefined
		: `${commandId}:answer`;

// Every lifecycle write goes through this boundary; reduction itself is pure.
const transition = (
	entry: Pick<RunnerChild, "lifecycle">,
	event: Entry.RunnerEntryTransition,
) => {
	const ending = entry.lifecycle.end;
	entry.lifecycle = Entry.nextRunnerLifecycle(entry.lifecycle, event);
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
		| "pid"
		| "child"
		| "connection"
		| "startTime"
	>,
	processTable: RunnerProcessTable = runnerProcessTable,
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
		const cleanup = Effect.gen(function* () {
			entry.connection?.destroy();
			const child = entry.child;
			const pid =
				child?.pid ??
				(Entry.hasVerifiedIdentity(entry.lifecycle) ? entry.pid : undefined);
			if (
				!pid ||
				(child && (child.exitCode !== null || child.signalCode !== null))
			)
				return;
			const exited = () => {
				const current = processTable.inspect(pid);
				return (
					current.state === "gone" ||
					current.state === "zombie" ||
					(entry.startTime !== undefined &&
						current.startTime !== undefined &&
						current.startTime !== entry.startTime)
				);
			};
			const kill = (signal: NodeJS.Signals) =>
				Effect.sync(() => {
					try {
						const current = processTable.inspect(pid);
						if (exited()) return;
						if (current.state !== "running" || !current.startTime) return;
						entry.startTime ??= current.startTime;
						processTable.signal(pid, signal);
						transition(entry, { _tag: "SignalStop" });
					} catch (cause) {
						log.warn({ pid, signal, cause }, "Runner stop signal failed");
					}
				});
			const exitEvent = child
				? Effect.callback<void>((resume) => {
						const finish = () => resume(Effect.void);
						child.once("exit", finish);
						return Effect.sync(() => child.off("exit", finish));
					})
				: Effect.never;
			yield* Effect.raceFirst(
				child
					? exitEvent
					: Effect.sync(exited).pipe(
							Effect.repeat({
								while: (done) => !done,
								schedule: Schedule.spaced("25 millis"),
							}),
						),
				kill("SIGTERM").pipe(
					Effect.andThen(Effect.sleep("3 seconds")),
					Effect.andThen(kill("SIGKILL")),
					Effect.andThen(Effect.sleep("1 second")),
				),
			);
		}).pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (
						entry.pid !== undefined &&
						["gone", "zombie"].includes(processTable.inspect(entry.pid).state)
					)
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
	emitOutput: (
		output: SessionOutput,
		sessionId?: string,
		send?: SendScope,
	) => Effect.Effect<SessionOutputReply, SessionFailure>,
	driver: ProcessRunnerDriver,
) =>
	Effect.gen(function* () {
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		let providerAdmission: AdmitSend | undefined;
		const admitSend: AdmitSend = (request, work) =>
			providerAdmission
				? providerAdmission(request, work)
				: Effect.fail(
						runnerFailure("admit send", "Provider admission is not installed"),
					);
		const emit = (output: SessionOutput, sessionId?: string) =>
			emitOutput(
				output,
				sessionId,
				"sinkId" in output ? sinks.get(output.sinkId)?.sendScope : undefined,
			);
		const sendScopes = yield* makeSendScopes((sinkId, sessionId) =>
			emit({ type: "release-sink", sinkId }, sessionId),
		);
		const processTable = deps.processTable ?? runnerProcessTable;
		const clock = yield* Clock.Clock;
		const pidAlive = (pid: number, startTime?: string) => {
			const current = processTable.inspect(pid);
			return (
				!["gone", "zombie"].includes(current.state) &&
				!(
					startTime !== undefined &&
					current.startTime !== undefined &&
					current.startTime !== startTime
				)
			);
		};
		const stopRunner = (
			entry: RunnerChild,
			exceptCommandId?: string,
		): Effect.Effect<void, SessionFailure> =>
			stop(entry, processTable).pipe(
				Effect.andThen(() => {
					const pid = entry.pid ?? entry.child?.pid;
					return pid !== undefined &&
						pidAlive(pid, entry.startTime) &&
						authority.records.get(entry.runnerId)?.tag._tag !== "Retired"
						? retireSurvivor(
								entry,
								runnerFailure("stop runner", "Runner survived Stop escalation"),
								exceptCommandId,
							)
						: Effect.void;
				}),
			);
		const turnEnds = yield* PubSub.unbounded<string>();
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
		const projection = yield* Effect.serviceOption(ProjectionRunnerEffectTag);
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
		const authority = yield* makeRunnerAuthority<RunnerChild>(receipts);
		const currentEntry = (sessionId: string) => {
			for (const record of authority.records.values())
				if (
					record.identity.sessionId === sessionId &&
					(record.tag._tag === "Live" ||
						(record.tag._tag === "Starting" &&
							!record.identity.entry?.lifecycle.candidate))
				)
					return record.identity.entry;
			return undefined;
		};
		const activeEntries = () =>
			[...authority.records.values()].flatMap((record) => {
				const entry = record.identity.entry;
				return entry && currentEntry(entry.sessionId) === entry ? [entry] : [];
			});
		const attachedEntries = () =>
			[...authority.records.values()].flatMap((record) =>
				record.identity.entry && record.tag._tag !== "Retired"
					? [record.identity.entry]
					: [],
			);
		const tracked = (entry: RunnerChild) =>
			authority.records.get(entry.runnerId)?.identity.entry === entry;
		const identityFor = (entry: RunnerChild) => ({
			runnerId: entry.runnerId,
			sessionId: entry.sessionId,
			driverKind: driver.driverKind,
			pid: entry.pid ?? entry.child?.pid,
			startTime: entry.startTime,
			registeredAt: entry.registeredAt ?? 0,
			socketPath: entry.socketPath,
			attachmentId: entry.attachmentId,
			ownedRunIds: [...(entry.ownedRunIds ?? [])],
			signalled: entry.lifecycle.stop?.signal === "Signalled",
			entry,
		});
		const adoptEntry = (entry: RunnerChild, phase: "starting" | "live") =>
			authority.adopt([identityFor(entry)], phase).pipe(
				Effect.mapError((cause) => runnerFailure("adopt runner", cause)),
				Effect.flatMap(({ grants }) => {
					entry.grant = grants.get(entry.runnerId);
					if (entry.outputAuthority) entry.outputAuthority.grant = entry.grant;
					return grants.has(entry.runnerId)
						? Effect.void
						: Effect.fail(
								runnerFailure("adopt runner", "Runner authority was revoked"),
							);
				}),
			);
		const forgetExited = (entry: RunnerChild) => {
			const pid = entry.pid ?? entry.child?.pid;
			if (pid === undefined || !pidAlive(pid, entry.startTime))
				authority.forget(entry.runnerId);
		};
		const observeProcess = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				const grant = entry.grant;
				if (authority.records.get(entry.runnerId)?.observation === "Observed")
					return;
				const retirement = deps.recoveryForSession
					? (yield* deps.recoveryForSession(sessionId))?.retirePrompts(
							entry.runnerId,
						)
					: legacyRetirePrompts?.(entry.runnerId, { sessionId });
				// A skipped retirement must remain eligible when project services return.
				if (!retirement) return;
				const observed = yield* authority.guarded(
					grant,
					{ kind: "output" },
					(entry.pendingInteractions
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
					),
				);
				if (Option.isSome(observed)) authority.observe(entry.runnerId);
			});
		let recovering = false;
		const refusedReleases = new Set<string>();
		const sinks = new Map<
			string,
			{
				sessionId: string;
				sendScope?: SendScope;
				runnerId?: string | undefined;
				inputId?: string;
				runId?: string | undefined;
				/** What a failed send places when the SDK never started it. */
				placement?: {
					inputId: string;
					text: string;
					images?: readonly AttachmentRef[];
				};
				messageId: string;
				commandPending: boolean;
				accepted: boolean;
				outcomeEmitted?: boolean;
				admission?: Deferred.Deferred<void>;
			}
		>();
		const sendBindings = new WeakMap<
			SendScope,
			NonNullable<ReturnType<typeof sinks.get>>
		>();
		// Scope membership lasts through native cleanup; dispatched routes cancellation.
		const pendingSends = new Map<
			SendScope,
			{
				sessionId: string;
				turnId: string;
				cancelled: Deferred.Deferred<void>;
				dispatched: boolean;
			}
		>();
		let closing = false;
		const accountDemands = new Map<
			SendScope,
			{
				readonly ready: Deferred.Deferred<void, SessionFailure>;
				readonly finished: Deferred.Deferred<void>;
				readonly dispatched: Deferred.Deferred<RunnerSocket>;
				readonly invalidated: Deferred.Deferred<void>;
				readonly fiber: Fiber.Fiber<void, never>;
			}
		>();
		const bindSink = (
			sinkId: string,
			binding: NonNullable<ReturnType<typeof sinks.get>>,
		) =>
			Effect.gen(function* () {
				const send = binding.sendScope;
				if (!send) return yield* Effect.die("Missing admitted send handle");
				if (sinks.get(sinkId) === binding) {
					return binding;
				}
				return yield* sendScopes.acquire(
					send,
					sinkId,
					"manager sink",
					Effect.sync(() => {
						sinks.set(sinkId, binding);
						sendBindings.set(send, binding);
						return binding;
					}),
					(binding) =>
						Effect.sync(() => {
							if (sinks.get(sinkId) === binding) sinks.delete(sinkId);
						}),
				);
			});
		const bindPending = (
			send: SendScope,
			sinkId: string,
			pending: NonNullable<ReturnType<typeof pendingSends.get>>,
		) =>
			sendScopes.acquire(
				send,
				sinkId,
				"pending send",
				Effect.sync(() => {
					pendingSends.set(send, pending);
					return pending;
				}),
				(pending) =>
					Effect.sync(() => {
						if (pendingSends.get(send) === pending) pendingSends.delete(send);
					}),
			);
		const retryUnacceptedSend = (
			binding: NonNullable<ReturnType<typeof sinks.get>>,
			runnerId: string,
		) => {
			if (binding.accepted || !binding.commandPending) return;
			const send = binding.sendScope;
			if (send) sendScopes.requeue(send, runnerId);
			if (binding.runnerId === runnerId) binding.runnerId = undefined;
			const pending = send ? pendingSends.get(send) : undefined;
			if (pending && send?.assignment._tag === "Queued")
				pending.dispatched = false;
		};
		const failSendOnce = (
			binding: NonNullable<ReturnType<typeof sinks.get>>,
			failure: Effect.Effect<void>,
		) =>
			Effect.suspend(() => {
				if (binding.outcomeEmitted) return Effect.void;
				binding.outcomeEmitted = true;
				return failure;
			});
		const failBoundSend = (
			sinkId: string,
			binding: NonNullable<ReturnType<typeof sinks.get>>,
			entry: RunnerChild,
			failure: SessionFailure,
		) =>
			authority
				.guarded(
					entry.grant,
					{ kind: "output" },
					failSendOnce(
						binding,
						failRunnerTurn(
							(output) =>
								output.type === "release-sink"
									? Effect.succeed({})
									: emitOutput(output, binding.sessionId, binding.sendScope),
							sinkId,
							binding,
							failure,
							driver.driverKind,
						),
					),
				)
				.pipe(Effect.asVoid);
		const retainAccount = (
			send: SendScope,
			sinkId: string,
			accountId: string | undefined,
			connection?: RunnerSocket,
		) =>
			Effect.uninterruptibleMask((restore) =>
				Effect.gen(function* () {
					const withAccountScope = driver.withAccountScope;
					if (!withAccountScope || !accountId) return;
					const existing = accountDemands.get(send);
					if (existing) return yield* restore(Deferred.await(existing.ready));
					const ready = yield* Deferred.make<void, SessionFailure>();
					const finished = yield* Deferred.make<void>();
					const dispatched = yield* Deferred.make<RunnerSocket>();
					const invalidated = yield* Deferred.make<void>();
					if (connection) yield* Deferred.succeed(dispatched, connection);
					const interrupt = Deferred.await(dispatched).pipe(
						Effect.andThen(
							Effect.suspend(() => {
								if (send.assignment._tag === "Closed") return Effect.void;
								const pending = pendingSends.get(send);
								if (pending && !pending.dispatched)
									return Deferred.succeed(pending.cancelled, undefined).pipe(
										Effect.asVoid,
									);
								const assignment = send.assignment;
								const entry = currentEntry(send.sessionId);
								const binding = sinks.get(send.sinkId);
								if (
									assignment._tag !== "Dispatched" ||
									!entry?.connection ||
									entry.runnerId !== assignment.runnerId ||
									binding?.sendScope !== send
								)
									return Effect.void;
								return entry.connection
									.commandEffect(randomUUID(), {
										type: "interrupt",
										sessionId: send.sessionId,
										...(binding.inputId ? { turnIds: [binding.inputId] } : {}),
									})
									.pipe(Effect.asVoid);
							}),
						),
					);
					const fiber = runFork(
						withAccountScope(
							accountId,
							Deferred.succeed(ready, undefined).pipe(
								Effect.andThen(Deferred.await(finished)),
								Effect.onInterrupt(() =>
									Deferred.succeed(invalidated, undefined).pipe(
										Effect.andThen(
											Effect.suspend(() => {
												if (closing) return Effect.void;
												runFork(
													sendScopes
														.fork(
															send,
															"account invalidation abort",
															interrupt.pipe(Effect.ignore),
														)
														.pipe(Effect.asVoid),
												);
												return Deferred.await(finished).pipe(
													Effect.interruptible,
												);
											}),
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
								}),
							),
							Effect.catchCause(() => Effect.void),
						),
					);
					yield* sendScopes.acquire(
						send,
						sinkId,
						"account demand",
						Effect.sync(() => {
							const demand = {
								ready,
								finished,
								dispatched,
								invalidated,
								fiber,
							};
							accountDemands.set(send, demand);
							return demand;
						}),
						(demand) =>
							Effect.sync(() => {
								if (accountDemands.get(send) === demand)
									accountDemands.delete(send);
								Deferred.doneUnsafe(demand.finished, Effect.void);
							}).pipe(Effect.andThen(Fiber.join(demand.fiber))),
					);
					yield* restore(Deferred.await(ready));
				}),
			);
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
									activeEntries().map(
										(entry) => [entry.sessionId, entry] as const,
									),
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

		const evict = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				const record = authority.records.get(entry.runnerId);
				if (record?.identity.entry !== entry) return;
				for (const [sinkId, binding] of [...sinks]) {
					if (binding.runnerId !== entry.runnerId) continue;
					if (
						!binding.accepted &&
						binding.commandPending &&
						(entry.lifecycle.idleExiting ||
							entry.lifecycle.failure?.code === "runner_recovery_abandoned")
					) {
						retryUnacceptedSend(binding, entry.runnerId);
						continue;
					}
					const send = binding.sendScope;
					if (
						send?.assignment._tag !== "Dispatched" &&
						binding.commandPending
					) {
						const failure = entry.lifecycle.failure;
						if (
							failure?.code === "runner_idle_exit" ||
							failure?.code === "runner_recovery_abandoned"
						) {
							continue;
						}
						if (failure && failure.code !== "runner_detached") {
							yield* failSendOnce(
								binding,
								failRunnerTurn(
									(output) =>
										output.type === "release-sink"
											? Effect.succeed({})
											: emit(output, sessionId),
									sinkId,
									binding,
									failure,
									driver.driverKind,
								),
							);
						}
					}
				}
				if (entry.lifecycle.failure?.code === "runner_detached")
					authority.detach(entry.runnerId);
				else if (
					record &&
					record.tag._tag !== "Retired" &&
					record.tag._tag !== "Exiting"
				) {
					authority.captureBeforeRevoke(entry.runnerId, identityFor(entry));
					// Confirmed exits retain the existing failure/orphan settlement path.
					// Only survivor retirement takes durable cleanup ownership of runs.
					yield* authority.revoke(record.grant, "exited");
				}
				forgetExited(entry);
			}).pipe(
				Effect.ensuring(
					Effect.sync(() => {
						runFork(sendScopes.closeRunner(entry.runnerId));
					}),
				),
			);
		const releaseEntryWaiters = (
			entry: RunnerChild,
			cause: Cause.Cause<SessionFailure>,
		) =>
			Effect.gen(function* () {
				yield* Deferred.failCause(entry.ready, cause);
				yield* Deferred.succeed(entry.drained, undefined);
				const ending = entry.lifecycle.end;
				if (ending) yield* Deferred.succeed(ending.released, undefined);
			});
		const settleRetiredRuns = (
			registration: {
				readonly sessionId: string;
				readonly ownedRunIds?: readonly string[] | undefined;
			},
			entryIngestion: typeof ingestion,
		) =>
			Effect.gen(function* () {
				if (!sql || !registration.ownedRunIds?.length) return;
				const sessionIngestion = deps.recoveryForSession
					? yield* ingestionForSession(registration.sessionId)
					: (entryIngestion ?? ingestion);
				if (!sessionIngestion) return;
				yield* settleSessionRuns(
					sql,
					registration.sessionId,
					"Provider process stopped",
					(events) => sessionIngestion.ingestBatch(events),
					{
						owners: registration.ownedRunIds.map((runId) => ({ runId })),
					},
				).pipe(
					Effect.mapError((cause) =>
						runnerFailure("settle retired runner", cause),
					),
				);
			});
		const watchSurvivor = (record: RunnerRecord<RunnerChild>) => {
			if (record.watcher === "Watching" || record.identity.pid === undefined)
				return;
			if (!authority.startWatching(record.identity.runnerId)) return;
			runFork(
				Effect.gen(function* () {
					const { runnerId, sessionId, pid, startTime, socketPath } =
						record.identity;
					if (pid === undefined) return;
					const startedAt = yield* Clock.currentTimeMillis;
					const exited = () => {
						const current = processTable.inspect(pid);
						return (
							current.state === "gone" ||
							current.state === "zombie" ||
							(startTime !== undefined &&
								current.startTime !== undefined &&
								current.startTime !== startTime)
						);
					};
					const prune = Effect.gen(function* () {
						if (socketPath) removeRunner(socketPath);
						if (receipts) yield* receipts.pruneRetired(runnerId);
						authority.forget(runnerId);
					});
					for (const offset of [10_000, 30_000, 60_000]) {
						yield* Effect.sleep(
							Math.max(
								0,
								startedAt + offset - (yield* Clock.currentTimeMillis),
							),
						);
						if (exited()) return yield* prune;
						const current = processTable.inspect(pid);
						if (
							startTime &&
							current.state === "running" &&
							current.startTime === startTime
						) {
							try {
								processTable.signal(pid, "SIGKILL");
								authority.markSignalled(runnerId);
								if (receipts)
									yield* receipts.retire(
										authority.records.get(runnerId)?.identity ??
											record.identity,
									);
							} catch (cause) {
								log.warn(
									{ runnerId, pid, cause },
									"Runner survivor signal failed",
								);
							}
						}
						log.warn(
							{ runnerId, pid, signalled: record.identity.signalled === true },
							"Retried retired runner stop",
						);
						if (exited()) return yield* prune;
					}
					const notice = Effect.gen(function* () {
						if (!sql) return false;
						const [session] = yield* sql<{
							archived_at: number | null;
						}>`SELECT archived_at FROM sessions WHERE id = ${sessionId}`;
						if (!session || session.archived_at !== null) return true;
						const sessionIngestion = yield* ingestionForSession(sessionId);
						if (!sessionIngestion) return false;
						yield* authority.guarded(
							record.grant,
							{ kind: "evidence" },
							sessionIngestion.ingest({
								eventId: `runner-survivor-${runnerId}`,
								type: "turn.notice",
								providerId: driver.driverKind,
								sessionId,
								providerRefs: {},
								rawSource: { kind: "runner.manager" },
								createdAt: yield* Clock.currentTimeMillis,
								data: {
									text: authority.records.get(runnerId)?.identity.signalled
										? `The previous run (pid ${pid}) was told to stop but hasn't exited yet. It can't make further changes and will exit when the system releases it.`
										: `Conduit couldn't confirm pid ${pid} is the previous run, so it didn't stop it. It may still be running. Stop it manually if it is.`,
								},
							}),
						);
						return true;
					});
					let noticed = false;
					while (!exited()) {
						if (!noticed)
							noticed = yield* notice.pipe(
								Effect.catchCause((cause) =>
									Effect.logWarning(
										"Runner survivor notice failed",
										cause,
									).pipe(Effect.as(false)),
								),
							);
						// The deterministic event remains after exit. Missing project
						// services or a failed commit can retry without a duplicate banner.
						yield* Effect.sleep("10 seconds");
					}
					yield* prune;
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Runner survivor cleanup failed", cause),
					),
				),
			);
		};
		const retireRecord = (
			record: RunnerRecord<RunnerChild>,
			cause: SessionFailure,
			exceptCommandId?: string,
		) =>
			Effect.gen(function* () {
				const entry = record.identity.entry;
				if (record.tag._tag === "Retired" && record.watcher === "Watching") {
					watchSurvivor(record);
					return;
				}
				if (entry)
					authority.captureBeforeRevoke(entry.runnerId, identityFor(entry));
				const cleanup = yield* authority.revoke(record.grant, "retired", {
					ownedRunIds: entry
						? [...(entry.ownedRunIds ?? [])]
						: record.identity.ownedRunIds,
				});
				const registration = {
					...(authority.records.get(record.identity.runnerId)?.identity ??
						record.identity),
					ownedRunIds: cleanup.target.ownedRunIds,
				};
				const releases: Effect.Effect<void, SessionFailure>[] = [];
				if (entry) {
					transition(entry, { _tag: "Fail", failure: cause });
					transition(entry, { _tag: "Recovered" });
					entry.connection?.destroy();
					runFork(sendScopes.closeRunner(entry.runnerId));
					yield* releaseEntryWaiters(entry, Cause.fail(cause));
					// A cancelled Starting runner never owned session background state.
					if (!entry.lifecycle.candidate && !currentEntry(entry.sessionId))
						releases.push(
							emit(
								{
									type: "background-task",
									transition: {
										sessionId: entry.sessionId,
										kind: "session-ended",
									},
								},
								entry.sessionId,
							).pipe(Effect.asVoid),
						);
				}
				// Release admission before cleanup SQL can acquire the write permit.
				const detached = (operation: Effect.Effect<void, unknown>) =>
					operation.pipe(
						Effect.interruptible,
						Effect.timeout("3 seconds"),
						Effect.catchCause((failure) =>
							Effect.logWarning("Retired runner cleanup failed", failure),
						),
						Effect.forkDetach,
					);
				yield* detached(
					Effect.all(
						releases.map((release) =>
							authority.guarded(cleanup, { kind: "cleanup" }, release),
						),
						{ concurrency: 4, discard: true },
					),
				);
				authority.beginCleanup(registration.runnerId);
				yield* detached(
					authority
						.guarded(
							cleanup,
							{ kind: "cleanup" },
							Effect.gen(function* () {
								const current = currentEntry(registration.sessionId);
								yield* retireReplacedPrompts(current?.runnerId ?? null, {
									sessionId: registration.sessionId,
									expiredProcessId: registration.runnerId,
									...(exceptCommandId ? { exceptCommandId } : {}),
								});
								yield* settleRetiredRuns(registration, entry?.ingestion);
							}),
						)
						.pipe(
							Effect.asVoid,
							Effect.ensuring(
								Effect.sync(() => {
									authority.finishCleanup(registration.runnerId);
								}),
							),
						),
				);
				const retired = authority.records.get(registration.runnerId);
				if (retired) watchSurvivor(retired);
				log.warn(
					{ runnerId: registration.runnerId, pid: registration.pid },
					"Retired surviving runner",
				);
			}).pipe(Effect.uninterruptible);
		const retireSurvivor = (
			entry: RunnerChild,
			cause: SessionFailure,
			exceptCommandId?: string,
		) => {
			const record = authority.records.get(entry.runnerId);
			return record?.identity.entry === entry
				? retireRecord(record, cause, exceptCommandId)
				: Effect.void;
		};
		const retireOrphan = (entry: RunnerChild) =>
			Effect.gen(function* () {
				const ownsEntry = () =>
					entry.lifecycle.candidate
						? tracked(entry)
						: currentEntry(entry.sessionId) === entry;
				if (closing || !ownsEntry()) return;
				yield* stopRunner(entry).pipe(
					Effect.ensuring(Deferred.succeed(entry.drained, undefined)),
				);
				if (closing || !ownsEntry()) return;
				if (entry.pid !== undefined && pidAlive(entry.pid, entry.startTime))
					return yield* retireSurvivor(
						entry,
						runnerFailure("recover runner", "Abandoned runner survived stop"),
					);
				yield* evict(entry.sessionId, entry);
				forgetExited(entry);
			});
		const detach = (entry: RunnerChild, failure?: SessionFailure) => {
			entry.connection?.destroy(failure);
			entry.child?.unref();
			if (entry.child?.connected) entry.child.disconnect();
		};
		const shutdown = lock
			.withPermits(1)(
				Effect.gen(function* () {
					closing = true;
					yield* sendScopes.closeAll;
					const entries = attachedEntries();
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
								? stopRunner(entry)
								: Effect.sync(() => detach(entry)),
						{ discard: true, concurrency: 4 },
					).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								for (const runnerId of authority.records.keys())
									authority.forget(runnerId);
							}),
						),
						Effect.ensuring(release),
					);
				}),
			)
			.pipe(Effect.uninterruptible);
		yield* Effect.addFinalizer(() =>
			shutdown.pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Runner shutdown failed", cause),
				),
			),
		);

		const settleExitedRuns = (
			sessionId: string,
			entry: RunnerChild,
			failure: SessionFailure,
			endCommandId?: string,
		) => {
			const grant =
				authority.records.get(entry.runnerId)?.cleanup?.grant ?? entry.grant;
			const bindings = [...sinks].filter(
				([, binding]) => binding.runnerId === entry.runnerId,
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
				if (
					!closing &&
					exitedPid !== undefined &&
					(authority.records.get(entry.runnerId)?.tag._tag === "Retired" ||
						!pidAlive(exitedPid, entry.startTime))
				) {
					const current = currentEntry(sessionId);
					yield* authority
						.guarded(
							grant,
							{ kind: "cleanup" },
							retireReplacedPrompts(
								current && current !== entry ? current.runnerId : null,
								{
									sessionId,
									expiredProcessId: entry.runnerId,
									...(endCommandId ? { exceptCommandId: endCommandId } : {}),
								},
							),
						)
						.pipe(Effect.asVoid);
				}
				if (process.env["NODE_ENV"] === "test")
					yield* Effect.sleep(
						Number(process.env["CONDUIT_TEST_RUNNER_FAILURE_DELAY_MS"] ?? 0),
					);
				const settlement = lock.withPermits(1)(
					Effect.gen(function* () {
						const retired =
							authority.records.get(entry.runnerId)?.tag._tag === "Retired";
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
							pid === undefined ||
							(pidAlive(pid, entry.startTime) && !retired)
						)
							return Effect.void;
						const cleanup = grant?._tag === "Cleanup" ? grant : undefined;
						for (const reservation of reservations) {
							if (cleanup && !cleanup.target.ownedRunIds.includes(reservation))
								continue;
							const [accepted] = yield* sql<{ run_id: string }>`
									SELECT COALESCE(joined_into, id) AS run_id FROM provider_runs
									WHERE session_id = ${sessionId} AND id = ${reservation}
										AND (${entry.lifecycle.idleExiting ? 1 : 0} = 0 OR status = 'running' OR started_at IS NOT NULL OR joined_into IS NOT NULL)`;
							if (accepted?.run_id)
								owners.set(accepted.run_id, { runId: accepted.run_id });
						}
						if (!owners.size) return;
						return yield* authority
							.guarded(
								grant,
								{ kind: "cleanup" },
								settleSessionRuns(
									sql,
									sessionId,
									failure.message,
									(events) => sessionIngestion.ingestBatch(events),
									{
										...(endCommandId ? {} : { errorCode: "runner_stopped" }),
										owners: [...owners.values()],
									},
								),
							)
							.pipe(Effect.asVoid);
					}),
				);
				yield* authority.records.get(entry.runnerId)?.tag._tag === "Retired"
					? settlement
					: entry.outputs.withPermits(1)(settlement);
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
				([, binding]) => binding.runnerId === entry.runnerId,
			);
			const settlement = settleExitedRuns(sessionId, entry, failure);
			if (
				!entry.lifecycle.idleExiting &&
				entry.lifecycle.activity._tag !== "StartupTimedOut"
			)
				log.error(
					`${runnerLabel} failed for session ${sessionId}: ${failure.message}`,
				);
			// Notify unaccepted sends before eviction revokes their output authority.
			runFork(
				settlement
					.pipe(
						Effect.catch((cause) =>
							Effect.logError("Could not settle exited runner runs", cause),
						),
						Effect.andThen(
							entry.outputs.withPermits(1)(
								Effect.gen(function* () {
									yield* authority.guarded(
										entry.grant,
										{ kind: "output" },
										emit({
											type: "background-task",
											transition: { sessionId, kind: "session-ended" },
										}),
									);
									for (const [sinkId, binding] of bindings)
										if (
											!binding.accepted &&
											binding.sendScope?.assignment._tag === "Dispatched" &&
											binding.sendScope.assignment.runnerId === entry.runnerId
										)
											yield* failBoundSend(sinkId, binding, entry, failure);
								}),
							),
						),
					)
					.pipe(
						Effect.ignore,
						Effect.ensuring(
							Effect.gen(function* () {
								yield* evict(sessionId, entry);
								yield* Deferred.succeed(entry.drained, undefined);
							}),
						),
					),
			);
			runFork(
				stopRunner(entry).pipe(
					Effect.catchCause((cause) =>
						Effect.logError("Runner cleanup failed", cause),
					),
				),
			);
		};

		const attach = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				const outputAuthority = { grant: entry.grant };
				entry.outputAuthority = outputAuthority;
				const trackInteraction = (output: SessionOutput) => {
					if (
						output.type === "question-request" ||
						output.type === "permission-request"
					)
						(entry.interactionSinks ??= new Map()).set(
							`${output.type}:${output.request.requestId}`,
							output.sinkId,
						);
					else if (output.type === "cancel-interaction") {
						for (const kind of ["question-request", "permission-request"]) {
							const key = `${kind}:${output.requestId}`;
							if (entry.interactionSinks?.get(key) === output.sinkId)
								entry.interactionSinks.delete(key);
						}
					} else if (output.type === "release-sink") {
						for (const [key, sinkId] of entry.interactionSinks ?? [])
							if (sinkId === output.sinkId) entry.interactionSinks?.delete(key);
					}
				};
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

				let recoveredHello: RunnerHello | undefined;
				let recoveryBindings: NonNullable<RunnerHello["bindings"]> = [];
				const settleRecoveredSends = (
					answers: readonly RunnerSendAnswer[],
					requeueMissing: boolean,
				) =>
					Effect.gen(function* () {
						if (!sql || !entry.recoveringCommands) return;
						if (Option.isNone(projection))
							return yield* Effect.fail(
								runnerFailure(
									"settle runner reply",
									"Missing projection services",
								),
							);
						const [session] = yield* sql<{
							project_id: string;
						}>`SELECT project_id FROM sessions WHERE id = ${sessionId}`.pipe(
							Effect.mapError((cause) =>
								runnerFailure("settle runner reply", cause),
							),
						);
						if (session) {
							const accounts = yield* deps.accounts ??
								Effect.succeed(undefined);
							const project = { projectId: session.project_id };
							const store = yield* makeEventStoreEffect.pipe(
								Effect.provideService(PersistenceProjectTag, project),
								Effect.provideService(SqlClient.SqlClient, sql),
							);
							const commit = yield* makeCommitAndSignal.pipe(
								Effect.provideService(EventStoreEffectTag, store),
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.provideService(
									ProjectionRunnerEffectTag,
									projection.value,
								),
							);
							const persist = yield* makeClaudeEventPersistEffect.pipe(
								Effect.provideService(EventStoreEffectTag, store),
								Effect.provideService(SqlClient.SqlClient, sql),
								Effect.provideService(
									ProjectionRunnerEffectTag,
									projection.value,
								),
							);
							const recovery = yield* deps.recoveryForSession?.(sessionId) ??
								Effect.succeed(undefined);
							const drafts = yield* Effect.serviceOption(InputDraftsTag);
							const restoreDraft =
								recovery?.inputDrafts?.restore ??
								(Option.isSome(drafts) ? drafts.value.restore : undefined);
							const followUps: Effect.Effect<void>[] = [];
							yield* authority
								.guarded(
									outputAuthority.grant,
									{ kind: "output" },
									commit.write(
										(projectEvents, stamp) =>
											Effect.gen(function* () {
												const rows = yield* runningRunnerCommands(
													sql,
													driver.driverKind,
													(accountId) =>
														accounts?.accounts.find(
															({ id }) => id === accountId,
														)?.driver ??
														accounts?.deleted.find(({ id }) => id === accountId)
															?.driver ??
														(accountId === driver.driverKind
															? driver.driverKind
															: undefined),
													sessionId,
												);
												const now = clock.currentTimeMillisUnsafe();
												let changed = false;
												for (const row of rows) {
													// A call still unwinding in this daemon retains its exact claim.
													if (
														entry.ownsPendingSend?.(
															sessionId,
															row.command_id,
															row.request_sequence,
															row.attempt_count,
														)
													)
														continue;
													const answer = answers.find(
														({ commandId, attempt }) =>
															commandId === row.command_id &&
															attempt === row.attempt_count,
													);
													if (answer?.status === "running") continue;
													const completed =
														answer?.status === "finished" ? answer : undefined;
													if (completed) {
														changed =
															(yield* settleRunnerCommandReply(
																sql,
																row,
																completed.result,
																completed.failure,
																now,
																false,
																{
																	project: projectEvents,
																	nativeResumeFallback:
																		completed.nativeResumeFallback === true,
																	persistUserMessage:
																		persist.persistUserMessage,
																	...(restoreDraft ? { restoreDraft } : {}),
																	afterCommit: (effect) =>
																		followUps.push(effect),
																},
															)) || changed;
														continue;
													}
													if (answer?.status === "uncertain") {
														changed =
															(yield* settleRunnerCommandReply(
																sql,
																row,
																undefined,
																{
																	operation: "recover runner send",
																	message:
																		"The runner stopped after this message may have been sent. Retry the message explicitly.",
																	code: "runner_send_uncertain",
																	retryable: false,
																},
																now,
																false,
																{
																	project: projectEvents,
																	persistUserMessage:
																		persist.persistUserMessage,
																	...(restoreDraft ? { restoreDraft } : {}),
																	afterCommit: (effect) =>
																		followUps.push(effect),
																},
															)) || changed;
														continue;
													}
													if (!requeueMissing) continue;
													if (row.error_code === "delivery_indeterminate")
														continue;
													const requeued =
														yield* sql`UPDATE provider_command_outbox
									SET status = 'retryable_failed', next_attempt_at = ${now}, updated_at = ${now}
									WHERE request_sequence = ${row.request_sequence} AND project_key = ${row.project_key}
										AND session_id = ${sessionId} AND command_id = ${row.command_id}
										AND status = 'running' AND attempt_count = ${row.attempt_count} RETURNING command_id`;
													changed ||= requeued.length > 0;
												}
												if (changed)
													yield* stamp((version) =>
														sql<{
															id: string;
														}>`UPDATE sessions SET version = ${version} WHERE id = ${sessionId} RETURNING id`.pipe(
															Effect.map((rows) => rows.map(({ id }) => id)),
														),
													);
												return changed;
											}),
										{
											runnerId: entry.runnerId,
											projectId: session.project_id,
											afterCommit: Effect.suspend(() =>
												Effect.forEach(followUps, (effect) => effect, {
													discard: true,
												}),
											),
										},
									),
								)
								.pipe(
									Effect.tap((settled) =>
										Effect.sync(() => {
											if (
												Option.isSome(settled) &&
												settled.value &&
												recovery?.wakeReactor
											)
												runFork(recovery.wakeReactor);
										}),
									),
									Effect.mapError((cause) =>
										runnerFailure("settle runner reply", cause),
									),
								);
						}
					});
				const recoverLegacySends = (connection: RunnerSocket) =>
					sql
						? recoverLegacyRunnerCommands({
								sql,
								sessionId,
								driverKind: driver.driverKind,
								...(deps.accounts ? { accounts: deps.accounts } : {}),
								ownsPendingSend: (row) =>
									entry.ownsPendingSend?.(
										sessionId,
										row.command_id,
										row.request_sequence,
										row.attempt_count,
									) === true,
								retain: (commandId, attempt) =>
									entry.pendingSendCommands?.set(commandId, attempt),
								ready: Deferred.await(entry.ready).pipe(Effect.asVoid),
								replay: (row) =>
									replayLegacyRunnerSend({
										sql,
										row,
										driverKind: driver.driverKind,
										connection,
										deps: {
											...deps,
											...(driver.legacyReplayCommandFields
												? {
														replayCommandFields:
															driver.legacyReplayCommandFields,
													}
												: {}),
										},
										liveSession: runner.getNativeSessionEffect(sessionId),
										resolveSinkId: (commandId, inputId, attempt, fallback) => {
											const inputSink = runnerSinkId(
												inputId,
												attempt,
												fallback,
											);
											return sinks.has(inputSink)
												? inputSink
												: runnerSinkId(commandId, attempt, fallback);
										},
										closing: () =>
											closing ||
											currentEntry(sessionId) !== entry ||
											entry.connection !== connection ||
											connection.closed,
										send: (commandId, command, attempt) =>
											Effect.gen(function* () {
												const existing = sinks.get(command.sinkId);
												if (existing?.accepted)
													return yield* connection.commandEffect(
														commandId,
														command,
														attempt,
													);
												const admitted = yield* admitSend(
													{
														origin: { _tag: "Adopted" },
														sinkId: command.sinkId,
														input: command.input,
														isEnded: runnerCommandEnded(
															sql,
															sessionId,
															commandId,
															attempt,
														),
														refuse: () => Effect.void,
													},
													(send) =>
														Effect.gen(function* () {
															sendScopes.dispatch(send, entry.runnerId);
															yield* authority.guarded(
																outputAuthority.grant,
																{ kind: "output" },
																bindSink(command.sinkId, {
																	sendScope: send,
																	sessionId,
																	inputId: command.input.inputId,
																	runId: command.input.runId,
																	messageId: row.assistant_message_id ?? "",
																	runnerId: entry.runnerId,
																	commandPending: true,
																	accepted: true,
																}),
															);
															recoveryBindings = [
																...recoveryBindings,
																{
																	sessionId,
																	commandId,
																	attempt,
																	sinkId: command.sinkId,
																	released: false,
																},
															];
															yield* retainAccount(
																send,
																command.sinkId,
																row.provider_id,
																connection,
															);
															return yield* connection.commandEffect(
																commandId,
																command,
																attempt,
															);
														}),
												);
												return Option.getOrUndefined(admitted);
											}),
									}).pipe(
										(effect) =>
											authority.guarded(
												outputAuthority.grant,
												{ kind: "output" },
												effect,
											),
										Effect.flatMap(
											Option.match({
												onNone: () => Effect.interrupt,
												onSome: Effect.succeed,
											}),
										),
									),
								settle: (answer) => settleRecoveredSends([answer], false),
								release: (commandId) =>
									Effect.gen(function* () {
										for (const binding of recoveryBindings) {
											if (binding.commandId !== commandId) continue;
											const send = sinks.get(binding.sinkId)?.sendScope;
											if (send) yield* send.close;
										}
									}),
								closing: () =>
									closing ||
									currentEntry(sessionId) !== entry ||
									entry.connection !== connection ||
									connection.closed,
								fail: (failure) => failed(sessionId, entry, failure),
								runFork,
							})
						: Effect.void;
				return yield* driver.connect({
					driverKind: driver.driverKind,
					socketPath: entry.socketPath,
					sessionId,
					runnerId: entry.runnerId,
					...(entry.pid !== undefined ? { pid: entry.pid } : {}),
					helloTimeoutMs: entry.child ? startupTimeoutMs : 2000,
					...(entry.lifecycle.candidate ? { preserveRole: true } : {}),
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
					...(receipts ? { receipts } : {}),
					checkpoint: (operation) =>
						authority
							// A receipt records transport progress, including discarded Starting
							// output. Persist it before allowing the runner to truncate its spool.
							.guarded(outputAuthority.grant, { kind: "evidence" }, operation)
							.pipe(Effect.map(Option.isSome)),
					runFork,
					onOutputCommitted: (output) =>
						runFork(
							authority
								.guarded(outputAuthority.grant, { kind: "output" }, () => {
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
								})
								.pipe(Effect.asVoid),
						),
					emit: (output) => {
						if (output.type === "release-sink")
							return Effect.gen(function* () {
								const send = sinks.get(output.sinkId)?.sendScope;
								if (
									send?.assignment._tag !== "Dispatched" ||
									send.assignment.runnerId !== entry.runnerId
								) {
									const key = `${entry.runnerId}:${output.sinkId}`;
									if (!refusedReleases.has(key)) {
										refusedReleases.add(key);
										yield* Effect.logWarning(
											"Ignored release-sink from another runner",
											{
												runnerId: entry.runnerId,
												sinkId: output.sinkId,
											},
										);
									}
									return {};
								}
								trackInteraction(output);
								yield* send.close;
								return {};
							});
						const grant = outputAuthority.grant;
						const received =
							output.type === "event"
								? {
										...output,
										event: {
											...output.event,
											[RunnerWriteOrigin]: entry.runnerId,
										},
									}
								: output;
						if (Entry.isAwaitingProject(entry.lifecycle))
							return Effect.interrupt;
						return entry.outputs.withPermits(1)(
							authority
								.guarded(
									grant,
									{ kind: "output" },
									Effect.gen(function* () {
										const prepared = yield* authority.guarded(
											grant,
											{ kind: "output" },
											() => {
												trackInteraction(received);
												return "sinkId" in received
													? sinks.get(received.sinkId)
													: undefined;
											},
										);
										if (Option.isNone(prepared)) return {};
										const reply = yield* emit(received, sessionId);
										yield* authority.guarded(grant, { kind: "output" }, () => {
											observeRunnerTurn(received, prepared.value);
											if (
												prepared.value &&
												received.type === "event" &&
												received.event.sessionId === prepared.value.sessionId &&
												(!prepared.value.runId ||
													received.event.runId === prepared.value.runId) &&
												[
													"turn.completed",
													"turn.error",
													"turn.interrupted",
												].includes(received.event.type)
											)
												prepared.value.outcomeEmitted = true;
										});
										return reply;
									}),
								)
								.pipe(
									Effect.tap((result) =>
										Effect.gen(function* () {
											if (Option.isSome(result)) return;
											const receipt = yield* currentRunnerOutput;
											if (receipt)
												yield* Deferred.succeed(receipt.committed, undefined);
										}),
									),
									Effect.map(Option.getOrElse(() => ({}))),
								),
						);
					},
					onHello: (rawHello, connection, replay) =>
						Effect.gen(function* () {
							const hello = rawHello;
							recoveredHello = hello;
							recoveryBindings =
								hello.sendJournalAnswers === true
									? (hello.bindings ?? [])
									: legacyRunnerBindings(hello);
							if (hello.sendJournalAnswers === true) {
								// The journal owns classification. A retained call needs an admission
								// even when it has not emitted an output binding yet.
								for (const answer of hello.sendAnswers ?? []) {
									if (
										answer.status !== "running" ||
										recoveryBindings.some(
											(binding) =>
												binding.commandId === answer.commandId &&
												binding.attempt === answer.attempt &&
												binding.released !== true,
										)
									)
										continue;
									recoveryBindings = [
										...recoveryBindings,
										{
											sessionId,
											commandId: answer.commandId,
											attempt: answer.attempt,
											released: false,
											sinkId: runnerSinkId(
												answer.commandId,
												answer.attempt,
												answer.nativeResumeFallback,
											),
										},
									];
								}
							}
							transition(entry, { _tag: "Verify" });
							entry.pid = hello.pid;
							if (hello.pid !== undefined)
								entry.startTime ??= processTable.inspect(hello.pid).startTime;
							const ownsEntry = () =>
								(entry.lifecycle.candidate
									? tracked(entry)
									: currentEntry(sessionId) === entry) &&
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
							entry.attachmentId = (yield* currentRunnerOutput)?.attachmentId;
							yield* adoptEntry(
								entry,
								entry.lifecycle.candidate ? "starting" : "live",
							);
							entry.buildId = hello.buildId;
							entry.capabilities = {
								stopsTasks: hello.stopsTasks === true,
								rebindsAccount: hello.rebindsAccount === true,
								settlesAnswers: hello.settlesAnswers === true,
								declaresLogin: hello.declaresLogin === true,
							};
							log.info(
								`${runnerLabel} attached for session ${sessionId}: build ${hello.buildId}, answers ${entry.capabilities.settlesAnswers ? "runner-settled" : "legacy answer-question/answer-permission"}`,
							);
							entry.upgrade.state = hello.upgradeState;
							// Identity and native controls suffice until the project can reattach.
							if (Entry.isAwaitingProject(entry.lifecycle)) return;
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
							// Acknowledgement retention is independent of recovery ownership.
							entry.pendingSendCommands = new Map();
							for (const command of hello.sendJournalAnswers === true
								? (hello.sendAnswers ?? [])
								: legacyRunnerRetainedSends(hello)) {
								if (command.attempt === undefined) continue;
								entry.pendingSendCommands.set(
									command.commandId,
									Math.max(
										entry.pendingSendCommands.get(command.commandId) ?? -1,
										command.attempt,
									),
								);
							}
							yield* acknowledgeSends(sessionId, entry, connection);
							const restoreAccounts: Effect.Effect<void, SessionFailure>[] = [];
							for (const binding of entry.lifecycle.candidate
								? []
								: recoveryBindings) {
								if (binding.released === true) continue;
								let inputId: string | undefined;
								let runId: string | undefined;
								let messageId = "";
								let pending = false;
								let accountId: string | undefined;
								let activeTurn = false;
								let commandAttempt: number | undefined;
								if (sql) {
									const rows = yield* sql<{
										request_sequence: number;
										provider_id: string;
										input_id: string | null;
										run_id: string | null;
										status: string;
										attempt_count: number;
										assistant_message_id: string | null;
										turn_state: string | null;
										run_state: string | null;
									}>`SELECT outbox.request_sequence, outbox.provider_id, COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id,
										COALESCE(reservation.joined_into, reservation.id) AS run_id,
										outbox.status, outbox.attempt_count, turns.assistant_message_id, turns.state AS turn_state, owner.status AS run_state
										FROM provider_command_outbox outbox
										LEFT JOIN provider_runs reservation ON reservation.session_id = outbox.session_id
											AND reservation.id = outbox.run_id
										LEFT JOIN provider_runs owner ON owner.session_id = outbox.session_id
											AND owner.id = COALESCE(reservation.joined_into, reservation.id)
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
										if (
											entry.ownsPendingSend?.(
												sessionId,
												binding.commandId ?? binding.sinkId,
												row.request_sequence,
												row.attempt_count,
											)
										)
											continue;
										if (
											hello.sendJournalAnswers === true &&
											row.status === "running"
										) {
											const answer = hello.sendAnswers?.find(
												(answer) =>
													answer.commandId ===
														(binding.commandId ?? binding.sinkId) &&
													answer.attempt === row.attempt_count,
											);
											if (!answer || answer.status === "uncertain") continue;
											if (
												answer.status === "finished" &&
												(answer.failure ||
													(answer.result &&
														!["accepted", "joined", "indeterminate"].includes(
															answer.result.status,
														)))
											)
												continue;
											if (binding.attempt !== row.attempt_count) continue;
										}
										commandAttempt = row.attempt_count;
										accountId = row.provider_id;
										const state = row.run_state ?? row.turn_state;
										activeTurn = state === "pending" || state === "running";
										inputId = row.input_id ?? undefined;
										runId = row.run_id ?? undefined;
										// Acknowledged events will not replay after adoption.
										messageId = row.assistant_message_id ?? "";
										pending = row.status === "running";
									}
								}
								if (binding.released === undefined && !activeTurn && !pending)
									continue;
								yield* ensureAttached();
								// A new socket attachment retains the native send's existing admission.
								const adoption = {
									origin: { _tag: "Adopted" as const },
									sinkId: binding.sinkId,
									input: {
										sessionId,
										inputId: inputId ?? binding.commandId ?? binding.sinkId,
									},
									isEnded: sql
										? runnerCommandEnded(
												sql,
												sessionId,
												binding.commandId ?? binding.sinkId,
												commandAttempt,
											)
										: Effect.succeed(false),
									refuse: (failure: SessionFailure, send: SendScope) => {
										const turn = sinks.get(send.sinkId);
										return turn
											? failBoundSend(send.sinkId, turn, entry, failure).pipe(
													Effect.andThen(
														connection
															.commandEffect(randomUUID(), {
																type: "interrupt",
																sessionId,
																...(inputId ? { turnIds: [inputId] } : {}),
															})
															.pipe(Effect.ignore),
													),
												)
											: Effect.void;
									},
								};
								let admitted = sinks.get(binding.sinkId);
								if (!admitted || admitted.runnerId !== entry.runnerId) {
									const result = yield* admitSend(adoption, (sendScope) =>
										Effect.gen(function* () {
											sendScopes.dispatch(sendScope, entry.runnerId);
											const adopted = {
												sendScope,
												sessionId,
												runnerId: entry.runnerId,
												...(inputId ? { inputId } : {}),
												runId,
												messageId,
												commandPending: pending,
												accepted: true,
											};
											yield* authority.guarded(
												outputAuthority.grant,
												{ kind: "output" },
												bindSink(binding.sinkId, adopted),
											);
											return adopted;
										}),
									);
									if (Option.isNone(result)) continue;
									admitted = result.value;
								}
								const sendScope = admitted.sendScope;
								if (!sendScope)
									return yield* Effect.die(
										"Missing recovered send admission handle",
									);
								// Historical sinks remain available for output replay, but their
								// native lifetime ended. Older runners report only the history.
								if (
									binding.released === false ||
									(binding.released === undefined && (activeTurn || pending))
								) {
									const restoreAccount = Effect.gen(function* () {
										yield* ensureAttached();
										const turn = sinks.get(binding.sinkId);
										if (turn?.sendScope !== sendScope) return;
										yield* retainAccount(
											sendScope,
											binding.sinkId,
											accountId ??
												hello.upgradeState?.snapshot?.input.account?.id,
											connection,
										);
									});
									restoreAccounts.push(
										admitSend(
											{ ...adoption, retained: sendScope },
											() => restoreAccount,
										).pipe(
											Effect.asVoid,
											Effect.catchIf(
												(failure) => failure.code === "account_unavailable",
												() => Effect.void,
											),
										),
									);
								}
							}
							for (const pending of entry.lifecycle.candidate
								? []
								: (hello.pendingOutputs ?? [])) {
								yield* ensureAttached();
								yield* authority.guarded(
									outputAuthority.grant,
									{ kind: "output" },
									() => trackInteraction(pending.output),
								);
								if (pending.sequence <= (hello.acknowledgedSequence ?? 0))
									yield* authority.guarded(
										outputAuthority.grant,
										{ kind: "output" },
										emit(pending.output, sessionId),
									);
							}
							// A previous-build runner may have completed while the store still
							// says running. Commit its backlog before checking account demand.
							if (driver.withAccountScope && restoreAccounts.length > 0) {
								yield* replay ?? Effect.void;
								// Replay may settle a command before recovery can install its waiter.
								if (sql)
									yield* entry.outputs.withPermits(1)(
										Effect.gen(function* () {
											for (const binding of recoveryBindings) {
												const turn = sinks.get(binding.sinkId);
												if (!turn?.commandPending) continue;
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
												yield* Effect.sync(() => {
													turn.commandPending = false;
												});
											}
										}),
									);
							}
							yield* Effect.all(restoreAccounts, { discard: true });
							yield* ensureAttached();
							if (sql && entry.recoveringCommands) {
								// Native output must commit before interpreting transport replies.
								if (!driver.withAccountScope || restoreAccounts.length === 0)
									yield* replay ?? Effect.void;
								if (hello.sendJournalAnswers === true)
									yield* settleRecoveredSends(hello.sendAnswers ?? [], true);
								else yield* recoverLegacySends(connection);
							}
							if (process.env["NODE_ENV"] === "test" && process.connected)
								process.send?.({
									channel: "conduit-process-test",
									kind: "runner-started",
									sessionId,
									pid: hello.pid,
									socketPath: entry.socketPath,
									buildId: hello.buildId,
									protocolVersion: hello.protocolVersion,
									settlesAnswers: entry.capabilities.settlesAnswers,
									declaresLogin: entry.capabilities.declaresLogin,
									answerDialect: entry.capabilities.settlesAnswers
										? "runner"
										: "legacy",
								});
						}),
					onCommandReply: (reply) =>
						Effect.gen(function* () {
							if (
								recoveredHello?.sendJournalAnswers !== true ||
								reply.attempt === undefined
							)
								return;
							const held = recoveredHello.sendAnswers?.find(
								(answer) =>
									answer.status === "running" &&
									answer.commandId === reply.commandId &&
									answer.attempt === reply.attempt &&
									answer.nativeResumeFallback ===
										(reply.nativeResumeFallback === true),
							);
							if (!held) return;
							yield* settleRecoveredSends(
								[
									{
										...held,
										status: "finished",
										...(reply.result ? { result: reply.result } : {}),
										...(reply.failure ? { failure: reply.failure } : {}),
									},
								],
								false,
							);
						}),
					onCommandAccepted: (sinkId) =>
						runFork(
							authority
								.guarded(outputAuthority.grant, { kind: "output" }, () => {
									const binding = sinks.get(sinkId);
									if (binding) {
										binding.accepted = true;
										if (binding.admission)
											runFork(Deferred.succeed(binding.admission, undefined));
									}
								})
								.pipe(Effect.asVoid),
						),
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
														yield* authority.guarded(
															outputAuthority.grant,
															{ kind: "output" },
															() => {
																if (row.run_id)
																	(entry.ownedRunIds ??= new Set()).add(
																		row.run_id,
																	);
															},
														);
											}
											if (entry.pendingSendCommands?.get(commandId) === pending)
												yield* authority.guarded(
													outputAuthority.grant,
													{ kind: "output" },
													() => entry.pendingSendCommands?.delete(commandId),
												);
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
						const wasInFlight = entry.upgrade.state?.turnInFlight === true;
						const snapshot = state.snapshot ?? entry.upgrade.state?.snapshot;
						// Only snapshots are omitted when unchanged. An omitted cursor is cleared.
						entry.upgrade.state = {
							...state,
							...(snapshot ? { snapshot } : {}),
						};
						if (
							currentEntry(sessionId) === entry &&
							wasInFlight &&
							state.turnInFlight === false
						)
							PubSub.publishUnsafe(turnEnds, sessionId);
						upgrade(sessionId, entry);
					},
					onIdleExit: () => {
						transition(entry, { _tag: "IdleExit" });
						for (const binding of sinks.values())
							retryUnacceptedSend(binding, entry.runnerId);
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
							if (child.pid !== undefined)
								entry.startTime = processTable.inspect(child.pid).startTime;
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
			candidate = false,
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
				const entry = {
					registeredAt: Math.max(
						yield* Clock.currentTimeMillis,
						...[...authority.records.values()].map(
							(record) => (record.identity.registeredAt ?? 0) + 1,
						),
					),
					sessionId,
					registrationRoot,
					ingestion: owner?.ingestion,
					pendingInteractions: owner?.pendingInteractions,
					lifecycle: candidate
						? Entry.nextRunnerLifecycle(Entry.initialRunnerLifecycle(), {
								_tag: "MakeCandidate",
							})
						: Entry.initialRunnerLifecycle(),
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
				yield* adoptEntry(entry, "starting");
				return entry;
			});
		const eligible = (sessionId: string, entry: RunnerChild) =>
			!closing &&
			!recovering &&
			currentEntry(sessionId) === entry &&
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
				createEntry(sessionId, old, true).pipe(
					Effect.tap((entry) =>
						Effect.sync(() => {
							transition(entry, { _tag: "MakeCandidate" });
							entry.launch = old.launch ?? old.upgrade.state?.snapshot?.input;
							entry.upgrade.state = old.upgrade.state;
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
							transition(replacement, { _tag: "Promote" });
							replacement.connection?.write({ type: "upgrade-activate" });
							authority.captureBeforeRevoke(old.runnerId, identityFor(old));
							yield* adoptEntry(replacement, "live");
							runFork(sendScopes.closeRunner(old.runnerId));
							yield* observeProcess(sessionId, replacement);
							// Keep the old process visible to shutdown and liveness while
							// stopping, without granting it the warming candidate's output.

							upgradeMark(sessionId, old, "switched", replacement);
							runFork(
								Effect.suspend(() =>
									closing ? Effect.void : stopRunner(old),
								).pipe(
									Effect.ensuring(Effect.sync(() => forgetExited(old))),
									Effect.catchCause((cause) =>
										Effect.logError("Retiring upgraded runner failed", cause),
									),
								),
							);
							return true;
						}),
					);
				}),
			stop: (entry) =>
				Effect.suspend(() => (closing ? Effect.void : stopRunner(entry))).pipe(
					Effect.ensuring(Effect.sync(() => forgetExited(entry))),
					Effect.catchCause((cause) =>
						Effect.logError("Stopping upgrade candidate failed", cause),
					),
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
			setSendAdmission(admit: AdmitSend): void {
				providerAdmission = admit;
			}
			readonly sendScopes = sendScopes;
			readonly turnEnds = Effect.map(
				PubSub.subscribe(turnEnds),
				Stream.fromSubscription,
			);

			hasActiveTurnsEffect(sessionId: string): Effect.Effect<boolean> {
				return Effect.sync(() => {
					const entry = currentEntry(sessionId);
					return (
						entry !== undefined &&
						Entry.countsTowardDemand(entry.lifecycle) &&
						entry.upgrade.state?.turnInFlight === true
					);
				});
			}
			getControlCommandStatusEffect(
				sessionId: string,
				control: ProviderControlContext,
			): Effect.Effect<ProviderControlCommandStatus, SessionFailure> {
				return Effect.gen(function* () {
					const entry = currentEntry(sessionId);
					if (entry && entry.runnerId !== control.providerProcessId)
						return "gone";
					const unavailable = () =>
						runnerFailure(
							"get control command status",
							"The original runner command state is unavailable",
						);
					if (!entry) return yield* Effect.fail(unavailable());
					const pid = entry.pid ?? entry.child?.pid;
					if (pid !== undefined && !pidAlive(pid, entry.startTime))
						return "gone";
					const connection = entry.connection;
					if (
						!connection ||
						connection.closed ||
						!Entry.canControl(entry.lifecycle)
					)
						return yield* Effect.fail(unavailable());
					const legacyAnswerId = legacyAnswerCommandId(
						entry,
						control.commandId,
					);
					const [command] =
						legacyAnswerId && sql
							? yield* sql<{
									effect_type: string;
								}>`SELECT effect_type FROM provider_command_outbox
							WHERE session_id = ${sessionId} AND command_id = ${control.commandId} LIMIT 1`.pipe(
									Effect.mapError((cause) =>
										runnerFailure("get control command status", cause),
									),
								)
							: [];
					// Pre-outbox runners cannot answer command-status. Their final answer
					// receipt, not the resolve receipt, proves the whole handoff completed.
					const status = yield* Effect.result(
						legacyAnswerId &&
							(command?.effect_type === "resolve_question" ||
								command?.effect_type === "resolve_permission")
							? Effect.sync(() =>
									connection.observedCommandStatus(legacyAnswerId),
								)
							: connection.commandStatusEffect(control.commandId),
					);
					const current = currentEntry(sessionId);
					if (current && current.runnerId !== control.providerProcessId)
						return "gone";
					if (pid !== undefined && !pidAlive(pid, entry.startTime))
						return "gone";
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
					const entry = currentEntry(sessionId);
					return entry && Entry.canControl(entry.lifecycle)
						? entry.runnerId
						: undefined;
				});
			}
			detachSessionEffect(sessionId: string): Effect.Effect<void> {
				return lock
					.withPermits(1)(
						Effect.gen(function* () {
							const entries = attachedEntries().filter(
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
									yield* stopRunner(entry);
								else detach(entry, detached);
								yield* evict(sessionId, entry);
								forgetExited(entry);
								yield* releaseEntryWaiters(entry, Cause.fail(detached));
							}
						}),
					)
					.pipe(
						Effect.uninterruptible,
						Effect.catchCause((cause) =>
							Effect.logError("Runner detachment failed", cause),
						),
					);
			}
			readonly recoverEffect = this.attachRegisteredSessions();

			attachSessionsEffect(sessionIds: readonly string[]) {
				return this.attachRegisteredSessions(new Set(sessionIds));
			}

			attachRegisteredSessions(sessionIds?: ReadonlySet<string>) {
				return Effect.gen(function* () {
					const ownsPendingSend = yield* currentPendingSendOwner;
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
					const discovered = discoverAllRunners(configDir, processTable).filter(
						(registration) =>
							(registration.driverKind ?? "claude") === driver.driverKind &&
							(!sessionIds || sessionIds.has(registration.sessionId)),
					);
					const retiredRows = receipts
						? yield* receipts
								.retirements()
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("recover retired runners", cause),
									),
								)
						: [];
					// Scope discovery before adoption: an entry-less record still owns
					// authority. Daemon-wide recovery supplies each session's owner.
					const foreignSessions = new Set(
						sql && !deps.recoveryForSession && recoveryScope._tag === "Some"
							? (yield* sql<{ id: string }>`SELECT id FROM sessions
								WHERE id IN ${sql.in([...discovered, ...retiredRows].map((runner) => runner.sessionId))}
									AND project_id <> ${recoveryScope.value.projectId}`.pipe(
									Effect.mapError((cause) =>
										runnerFailure("scope recovered runners", cause),
									),
								)).map((row) => row.id)
							: [],
					);
					const registrations = discovered.filter(
						(registration) => !foreignSessions.has(registration.sessionId),
					);
					const identities = registrations.map((registration) => ({
						...registration,
						entry: undefined as RunnerChild | undefined,
					}));
					for (const retired of retiredRows) {
						if (foreignSessions.has(retired.sessionId)) continue;
						if (sessionIds && !sessionIds.has(retired.sessionId)) continue;
						if (
							identities.some(
								(identity) => identity.runnerId === retired.runnerId,
							)
						)
							continue;
						if (retired.driverKind !== driver.driverKind) continue;
						const adopted = yield* authority
							.adopt([retired], "starting")
							.pipe(
								Effect.mapError((cause) =>
									runnerFailure("recover retired runner", cause),
								),
							);
						for (const record of adopted.survivors)
							yield* retireRecord(
								record,
								runnerFailure(
									"recover retired runner",
									"Runner survived an earlier Stop",
								),
							);
					}
					// Legacy cursor rows have no owned_run_ids, and send_turn never
					// stores provider_process_id. Read the host's send journal before
					// adoption revokes a losing registration, without replaying output.
					const cursorOwners = receipts
						? yield* receipts
								.owners(identities.map((identity) => identity.runnerId))
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("recover runner cohort", cause),
									),
								)
						: [];
					const known = yield* Effect.forEach(identities, (identity) =>
						Effect.gen(function* () {
							const commands = yield* Effect.try({
								try: () =>
									runnerSendCommandsForProcess(
										dirname(identity.socketPath),
										identity.sessionId,
										driver.driverKind,
										identity.pid,
									),
								catch: (cause) =>
									runnerFailure("recover runner journal", cause),
							});
							const owned =
								sql && commands.length
									? yield* sql<{
											command_id: string;
											attempt_count: number;
											run_id: string;
										}>`
									SELECT command.command_id, command.attempt_count, COALESCE(run.joined_into, run.id) AS run_id
									FROM provider_command_outbox command JOIN provider_runs run
										ON run.id = command.run_id AND run.session_id = command.session_id
									WHERE command.session_id = ${identity.sessionId}
										AND command.project_key = (SELECT project_id FROM sessions WHERE id = ${identity.sessionId})
										AND command.effect_type = 'send_turn'
										AND command.command_id IN ${sql.in(commands.map((command) => command.commandId))}`.pipe(
											Effect.mapError((cause) =>
												runnerFailure("recover runner cohort", cause),
											),
										)
									: [];
							return {
								...identity,
								ownedRunIds: [
									...new Set([
										...(identity.ownedRunIds ?? []),
										...(cursorOwners.find(
											(owner) => owner.runnerId === identity.runnerId,
										)?.ownedRunIds ?? []),
										...owned
											.filter((row) =>
												commands.some(
													(command) =>
														command.commandId === row.command_id &&
														command.attempt === row.attempt_count,
												),
											)
											.map((row) => row.run_id),
									]),
								],
							};
						}),
					);
					// Discovery restores active process authority; hello still verifies
					// the socket and attachment before replay. Warm candidates have no
					// session authority until promotion, including after a restart.
					const active = yield* authority
						.adopt(
							known.filter((identity) => identity.role !== "candidate"),
							"live",
						)
						.pipe(
							Effect.mapError((cause) =>
								runnerFailure("recover runner authority", cause),
							),
						);
					const warming = yield* authority
						.adopt(
							known.filter((identity) => identity.role === "candidate"),
							"starting",
						)
						.pipe(
							Effect.mapError((cause) =>
								runnerFailure("recover warm runner authority", cause),
							),
						);
					for (const record of [...active.survivors, ...warming.survivors])
						yield* retireRecord(
							record,
							runnerFailure("recover runner", "Runner has no active authority"),
						);

					for (const registration of registrations) {
						if (
							!(
								registration.role === "candidate" ? warming : active
							).grants.has(registration.runnerId)
						)
							continue;
						if (
							sessionIds &&
							(!sessionIds.has(registration.sessionId) ||
								(currentEntry(registration.sessionId)?.runnerId ===
									registration.runnerId &&
									!Entry.isAwaitingProject(
										currentEntry(registration.sessionId)?.lifecycle,
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
						const recovery = yield* deps.recoveryForSession?.(
							registration.sessionId,
						) ?? Effect.succeed(undefined);
						// Recovery also owns runners whose project cannot currently ingest.
						// Reattach their spool once the project's services become available.
						if (
							Entry.isAwaitingProject(
								currentEntry(registration.sessionId)?.lifecycle,
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
							Boolean(currentEntry(registration.sessionId));
						const entry: RunnerChild = {
							...registration,
							recoveringCommands: !abandoned,
							ownsPendingSend,
							ownedRunIds: new Set(
								authority.records.get(registration.runnerId)?.identity
									.ownedRunIds ?? registration.ownedRunIds,
							),
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
								abandoned ||= Boolean(currentEntry(registration.sessionId));
								if (abandoned) transition(entry, { _tag: "MakeCandidate" });
								yield* adoptEntry(
									entry,
									registration.role === "candidate" ? "starting" : "live",
								);
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
									Effect.catchCause((cause) =>
										Effect.logError("Orphan runner cleanup failed", cause),
									),
								),
							);
						const ensureRecovering = Effect.suspend(() =>
							!closing &&
							Entry.canControl(entry.lifecycle) &&
							(entry.lifecycle.candidate
								? tracked(entry)
								: currentEntry(registration.sessionId) === entry)
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
								attach(registration.sessionId, entry),
							);
							yield* ensureRecovering;
							// A previous server may still own the socket while its shutdown
							// drains. Rejected hellos do not prove that the runner is dead.
							for (
								let retry = 0;
								(connected._tag === "Failure"
									? connected.failure.code !== "runner_incompatible"
									: connected.success.closed) &&
								pidAlive(registration.pid, registration.startTime) &&
								retry < 4;
								retry++
							) {
								yield* Effect.sleep(100 * 2 ** retry);
								yield* ensureRecovering;
								connected = yield* Effect.result(
									attach(registration.sessionId, entry),
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
								yield* stopRunner(entry);
								if (pidAlive(registration.pid, registration.startTime))
									return yield* retireSurvivor(entry, failure);
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
								yield* evict(registration.sessionId, entry);
								forgetExited(entry);
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
								if (!pidAlive(registration.pid, registration.startTime)) {
									transition(entry, { _tag: "Recovered" });
									const abandonedFailure: SessionFailure = {
										...failure,
										code: "runner_recovery_abandoned",
									};
									transition(entry, {
										_tag: "Fail",
										failure: abandonedFailure,
									});

									yield* evict(registration.sessionId, entry);
									forgetExited(entry);
									yield* releaseEntryWaiters(
										entry,
										Cause.fail(abandonedFailure),
									);
									removeRunner(entry.socketPath);
									return;
								}
								// Detach this registration so admission can create its replacement.
								return yield* retireSurvivor(entry, failure);
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
							yield* lock.withPermits(1)(
								Effect.gen(function* () {
									yield* ensureRecovering;
									transition(entry, { _tag: "Recovered" });
									yield* Deferred.succeed(entry.ready, connected.success);
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
								return Effect.gen(function* () {
									transition(entry, { _tag: "Recovered" });
									transition(entry, {
										_tag: "Fail",
										failure: runnerFailure(
											"recover runner",
											Failure.squashCause(exit.cause),
										),
									});
									entry.connection?.destroy();
									yield* evict(registration.sessionId, entry);
									forgetExited(entry);
									yield* releaseEntryWaiters(entry, exit.cause);
								});
							}),
						);
					}
				}).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
							if (!sessionIds) recovering = false;
							if (Exit.isSuccess(exit))
								for (const entry of activeEntries()) {
									const sessionId = entry.sessionId;
									if (!sessionIds || sessionIds.has(sessionId))
										upgrade(sessionId, entry);
								}
						}),
					),
				);
			}
			ownsRetirementCleanupEffect(sessionId: string, runId: string) {
				return Effect.sync(() =>
					[...authority.records.values()].some(
						(record) =>
							record.identity.sessionId === sessionId &&
							record.cleanup?._tag === "Settling" &&
							clock.currentTimeMillisUnsafe() < record.cleanup.deadline &&
							record.cleanup.ownedRunIds.includes(runId),
					),
				);
			}
			hasLiveProcessEffect(
				sessionId: string,
				processId?: string,
			): Effect.Effect<boolean> {
				return Effect.sync(() => {
					const records =
						processId === undefined
							? authority.records.values()
							: [authority.records.get(processId)];
					for (const record of records) {
						if (!record || record.identity.sessionId !== sessionId) continue;
						const runnerId = record.identity.runnerId;
						const entry = record.identity.entry;
						const pid = entry?.pid ?? entry?.child?.pid ?? record.identity.pid;
						const alive =
							pid !== undefined &&
							pidAlive(pid, entry?.startTime ?? record.identity.startTime);
						if (!alive && record.tag._tag === "Exiting")
							authority.forget(runnerId);
						if (
							alive &&
							record.identity.sessionId === sessionId &&
							(processId === undefined ||
								(runnerId === processId &&
									(record.tag._tag === "Live" ||
										record.tag._tag === "Starting")))
						)
							return true;
					}
					return false;
				});
			}

			hasDemandEffect(sessionId: string): Effect.Effect<boolean> {
				return Effect.sync(() => {
					const entry = currentEntry(sessionId);
					return (
						entry !== undefined &&
						Entry.countsTowardDemand(entry.lifecycle) &&
						(entry.upgrade.inFlight || entry.upgrade.state?.quiescent !== true)
					);
				});
			}

			getAccountSwitchBlockEffect(sessionId: string, account: Account) {
				return Effect.sync(() => {
					const entry = currentEntry(sessionId);
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
					const entry = currentEntry(sessionId);
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

			withTurnEffect<
				A,
				E,
				R,
				T extends Pick<SessionTurn, "sessionId" | "inputId" | "account">,
			>(
				input: T,
				sinkId: string,
				work: Effect.Effect<A, E, R>,
				scope: SendScope,
				accountId: string | undefined = input.account?.id,
			): Effect.Effect<A, E | SessionFailure, R> {
				return retainAccount(scope, sinkId, accountId).pipe(
					Effect.andThen(() => {
						const demand = accountDemands.get(scope);
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
				);
			}

			executeEffect(
				command: Extract<SessionCommand, { type: "send-turn" }>,
				send: SendScope,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult, SessionFailure>;
			executeEffect(
				command: Exclude<SessionCommand, { type: "send-turn" }>,
				send?: SendScope,
				recovered?: RunnerChild,
			): Effect.Effect<void, SessionFailure>;
			executeEffect(
				command: SessionCommand,
				send: SendScope,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult | undefined, SessionFailure>;
			executeEffect(
				command: SessionCommand,
				send?: SendScope,
				recovered?: RunnerChild,
			): Effect.Effect<TurnResult | undefined, SessionFailure> {
				const turn: NonNullable<ReturnType<typeof sinks.get>> | undefined =
					command.type === "send-turn"
						? {
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
													? {
															images: command.input.images.map(
																({ ref }) => ref,
															),
														}
													: {}),
											},
										}),
								messageId: "",
								runnerId: undefined,
								commandPending: true,
								accepted: false,
							}
						: undefined;
				let child: RunnerChild | undefined;
				let sentToRunner = false;
				let admitted: RunnerChild | undefined;
				let admittedSessionId = "";
				let ending: RunnerChild | undefined;
				let cancelled: Deferred.Deferred<void> | undefined;
				let pendingSend: ReturnType<typeof pendingSends.get>;
				let unsentReleased = false;
				const emitUnsent = (output: SessionOutput) =>
					Effect.suspend(() => {
						if (command.type !== "send-turn" || unsentReleased)
							return Effect.succeed({});
						const binding = sinks.get(command.sinkId);
						if (binding && binding !== turn) return Effect.succeed({});
						if (output.type !== "release-sink") return emit(output);
						unsentReleased = true;
						return Effect.succeed({});
					});
				const waitForAdmission =
					command.type === "send-turn"
						? makeSendAdmissionWait(
								command.input.sessionId,
								command.input.inputId,
							)
						: undefined;
				const execute = Effect.gen(function* () {
					const autoSettleAfterDays =
						command.type === "send-turn"
							? command.input.autoSettleAfterDays !== undefined
								? command.input.autoSettleAfterDays
								: yield* deps.autoSettleAfterDays ?? Effect.succeed(undefined)
							: undefined;
					if (command.type === "send-turn" && cancelled) {
						pendingSend = {
							sessionId: command.input.sessionId,
							turnId:
								command.input.continuation?.cutOffMessageId ??
								command.input.inputId,
							cancelled,
							dispatched: false,
						};
						if (turn?.sendScope)
							yield* bindPending(turn.sendScope, command.sinkId, pendingSend);
						sentToRunner = false;
					}
					const outputOwner = yield* currentRunnerOutput;
					if (command.type === "abort") {
						if (!send) return;
						if (
							send &&
							(send.assignment._tag === "Closed" ||
								(sinks.has(command.sinkId) &&
									sinks.get(command.sinkId)?.sendScope !== send))
						)
							return;
						const pending = pendingSends.get(send);
						if (pending && !pending.dispatched) {
							yield* Deferred.succeed(pending.cancelled, undefined);
							return;
						}
					}
					if (command.type === "interrupt") {
						for (const pending of pendingSends.values())
							if (
								!pending.dispatched &&
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
					if (command.type === "send-turn" && turn?.sendScope)
						yield* retainAccount(
							turn.sendScope,
							command.sinkId,
							command.input.account?.id,
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
								const existing = currentEntry(sessionId);
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
									if (process.env["NODE_ENV"] === "test" && process.connected)
										process.send?.({
											channel: "conduit-process-test",
											kind: "runner-admission",
											sessionId,
											command: command.type,
											decision,
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
												waitReason: foldersChanged
													? ("foldersPending" as const)
													: legacyCursor
														? ("legacyCursor" as const)
														: ("loginPending" as const),
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
									) {
										turn.runnerId = existing.runnerId;
										yield* bindSink(command.sinkId, turn);
									}
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

								if (turn && command.type === "send-turn") {
									turn.runnerId = created.runnerId;
									yield* bindSink(command.sinkId, turn);
								}
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
						if ("recoveryPending" in selection && entry) {
							const waiting = entry;
							yield* Deferred.await(waiting.ready).pipe(
								Effect.catch((failure) =>
									currentEntry(sessionId) !== waiting && waiting.lifecycle.stop
										? Effect.void
										: Effect.fail(failure),
								),
							);
							continue;
						}
						if ("foldersPending" in selection && selection.waitReason) {
							yield* waitForAdmission
								? waitForAdmission(
										selection.waitReason,
										Effect.sleep("10 millis"),
									)
								: Effect.sleep("10 millis");
							continue;
						}
						if (selection.retire) {
							const retiring = selection.retire;
							yield* runner
								.executeEffect(
									{ type: "end-session", sessionId },
									undefined,
									retiring,
								)
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
						(currentEntry(sessionId) !== entry ||
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
					const preserveReportedLogin = <
						Command extends Extract<
							SessionCommand,
							{ type: "send-turn" | "pre-warm" }
						>,
					>(
						payload: Command,
					): Command => {
						const snapshot = entry.upgrade.state?.snapshot;
						const launch = snapshot?.input;
						if (
							driver.driverKind === "claude" &&
							!entry.capabilities?.declaresLogin &&
							launch &&
							driver.loginChange(
								{ ...launch, root: launch.workspaceRoot },
								{
									...payload.input,
									configDir: payload.input.configDir,
									root: payload.input.workspaceRoot,
									shellConfig: payload.input.shellConfig ?? payload.shellConfig,
								},
							) === "None"
						) {
							// Old peers compare captures and absent account fields as values.
							// Keep their reported login until a declared setting really changes.
							const captured = {
								...payload,
								input: { ...payload.input },
								shellEnv: launch.shellEnv ?? snapshot?.options.env ?? {},
							};
							delete captured.input.account;
							delete captured.input.instanceId;
							delete captured.input.shellEnv;
							if (launch.account !== undefined)
								captured.input.account = launch.account;
							if (launch.instanceId !== undefined)
								captured.input.instanceId = launch.instanceId;
							if (launch.shellEnv !== undefined)
								captured.input.shellEnv = launch.shellEnv;
							return captured;
						}
						return payload;
					};
					const payload =
						command.type === "send-turn"
							? preserveReportedLogin({
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
								})
							: command.type === "pre-warm"
								? preserveReportedLogin({
										...command,
										shellConfig:
											command.input.shellConfig ?? command.shellConfig,
										shellEnv: command.input.shellEnv ??
											command.shellEnv ?? {
												...process.env,
											},
									})
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
								if (!pending.dispatched && pending.sessionId === sessionId)
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
													running ? stopRunner(entry, commandId) : Effect.void,
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
						if (pid !== undefined && pidAlive(pid, entry.startTime)) {
							const failure = runnerFailure(
								"end-session",
								"Runner survived Stop escalation",
							);
							yield* retireSurvivor(entry, failure, commandId);
						}
						// Retirement already owns bounded settlement of this runner's cohort.
						if (authority.records.get(entry.runnerId)?.tag._tag === "Retired")
							return;
						yield* settlement.pipe(
							Effect.mapError((cause) =>
								runnerFailure("settle stopped runner", cause),
							),
						);
						yield* entry.lifecycle.failure
							? Deferred.await(entry.drained)
							: Effect.gen(function* () {
									yield* evict(sessionId, entry);
									yield* Deferred.succeed(entry.drained, undefined);
								});
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
						const pending = turn?.sendScope
							? pendingSends.get(turn.sendScope)
							: undefined;
						if (pending && Deferred.isDoneUnsafe(pending.cancelled))
							return CANCELLED_TURN;
						if (pending) pending.dispatched = true;
					}
					if (command.type === "send-turn" && turn?.sendScope) {
						const demand = accountDemands.get(turn.sendScope);
						if (
							turn.sendScope.assignment._tag === "Closed" ||
							(demand && Deferred.isDoneUnsafe(demand.invalidated))
						)
							return CANCELLED_TURN;
						sendScopes.dispatch(turn.sendScope, entry.runnerId);
					}
					sentToRunner = true;
					if (command.type === "send-turn") {
						const demand = turn?.sendScope
							? accountDemands.get(turn.sendScope)
							: undefined;
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
					const legacyAnswerId = legacyAnswerCommandId(entry, commandId);
					// Some unflagged builds already settle and cancel during resolve.
					// Retain their sink so the final handshake receipt is still recorded.
					const legacySinkId =
						legacyAnswerId &&
						(command.type === "resolve-question" ||
							command.type === "resolve-permission")
							? entry.interactionSinks?.get(
									`${command.type === "resolve-question" ? "question" : "permission"}-request:${command.requestId}`,
								)
							: undefined;
					if (
						command.type === "abort" &&
						send &&
						(send.assignment._tag === "Closed" ||
							(sinks.has(command.sinkId) &&
								sinks.get(command.sinkId)?.sendScope !== send))
					)
						return;
					const execution = connection.commandEffect(
						commandId,
						payload,
						command.type === "send-turn"
							? command.input.commandAttempt
							: undefined,
					);
					const result = yield* execution;
					// Legacy resolve commands acknowledge the answer without releasing
					// canUseTool. Complete that handshake inside the outbox attempt, using
					// its original reply rather than the runner's redacted notification.
					if (legacyAnswerId && legacySinkId) {
						if (command.type === "resolve-question") {
							yield* connection.commandEffect(legacyAnswerId, {
								type: "answer-question",
								sinkId: legacySinkId,
								requestId: command.requestId,
								answers: command.answers,
							});
						} else if (command.type === "resolve-permission") {
							yield* connection.commandEffect(legacyAnswerId, {
								type: "answer-permission",
								sinkId: legacySinkId,
								requestId: command.requestId,
								response: command.control?.response ?? {
									decision: command.decision,
								},
							});
						}
					}
					return result;
				}).pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (!admitted) return;
							transition(admitted, { _tag: "FinishCommand" });
							upgrade(admittedSessionId, admitted);
							admitted = undefined;
						}),
					),
					Effect.retry({
						while: (failure) => {
							const retry =
								(failure.code === "runner_idle_exit" ||
									failure.code === "runner_recovery_abandoned") &&
								turn !== undefined &&
								!turn.accepted &&
								!closing;
							if (retry && command.type === "send-turn" && turn && child) {
								retryUnacceptedSend(turn, child.runnerId);
								sentToRunner = false;
							}
							return retry;
						},
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
							runnerFailure(command.type, Failure.squashCause(cause)).code ===
							"send_admission_timeout"
						)
							return Effect.void;
						if (
							command.type !== "send-turn" ||
							!turn ||
							closing ||
							child?.lifecycle.failure?.code === "runner_detached" ||
							Failure.isInterruptedOnly(cause)
						)
							return Effect.void;
						// Explicit End owns settlement after confirmed exit. A socket
						// failure during its graceful phase is not a process terminal.
						if (child?.lifecycle.end) return Deferred.await(child.stopped);
						const failure = runnerFailure(
							command.type,
							Failure.squashCause(cause),
						);
						const cleanup =
							child && sentToRunner
								? failBoundSend(command.sinkId, turn, child, failure)
								: failSendOnce(
										turn,
										failRunnerTurn(
											emitUnsent,
											command.sinkId,
											turn,
											failure,
											driver.driverKind,
										),
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
					Effect.onExit(() =>
						Effect.gen(function* () {
							const entry = child;
							if (turn && command.type === "send-turn" && entry && sentToRunner)
								yield* entry.outputs.withPermits(1)(
									Effect.gen(function* () {
										yield* Effect.sync(() => {
											turn.commandPending = false;
										});
									}),
								);
							else if (turn) turn.commandPending = false;
							const released =
								ending && transition(ending, { _tag: "FinishEnd" });
							if (released) yield* Deferred.succeed(released, undefined);
						}),
					),
				);
				if (command.type !== "send-turn") return execute;
				return Effect.gen(function* () {
					if (!send)
						return yield* Effect.die(
							"Send command requires its admitted handle",
						);
					if (turn && !turn.sendScope) turn.sendScope = send;
					cancelled =
						(turn?.sendScope
							? pendingSends.get(turn.sendScope)?.cancelled
							: undefined) ?? (yield* Deferred.make<void>());
					if (command.aborted) yield* Deferred.succeed(cancelled, undefined);
					return yield* Effect.raceFirst(
						Deferred.await(cancelled).pipe(Effect.as(CANCELLED_TURN)),
						execute,
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
