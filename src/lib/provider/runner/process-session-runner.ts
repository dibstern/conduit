import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	Option,
	PubSub,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../contracts/account.js";
import {
	AccountSwitchBusy,
	accountSwitchBusyMessage,
} from "../../contracts/limit-recovery.js";
import { RunnerWriteOrigin } from "../../contracts/stored-event.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { InputDraftsTag } from "../../domain/relay/Services/input-drafts.js";
import { PendingInteractionServiceTag } from "../../domain/relay/Services/pending-interaction-service.js";
import { ProviderRuntimeIngestionTag } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
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
import { recordClaudeNativeResumeFallback } from "../claude/prepare-turn.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import { STOP_ABORT_WAIT_MS } from "../orchestration-command-contracts.js";
import {
	runSendCommandIdQuery,
	stopCovers,
} from "../session-run-settlement.js";
import type {
	ProviderControlCommandStatus,
	ProviderControlContext,
	ProviderNativeSession,
	TurnResult,
} from "../types.js";
import type { RunnerRecord } from "./runner-authority.js";
import type { connectRunner } from "./runner-connection.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	isLegacyRunner,
	legacyRunnerBindings,
	legacyRunnerRetainedSends,
	legacyRunnerRunPredicate,
	legacyRunnerRunQuery,
} from "./runner-legacy-classification.js";
import {
	recoverLegacyRunnerCommands,
	replayLegacyRunnerSend,
} from "./runner-legacy-recovery.js";
import {
	type RunnerHello,
	type RunnerSendAnswer,
	type RunnerSocket,
	runnerBuildId,
	runnerCommandReplied,
	runnerDeliveryEvidence,
	runnerFailure,
	runnerSinkId,
} from "./runner-protocol.js";
import type {
	RunnerDriverPieces,
	RunnerProviderInstanceDeps,
} from "./runner-provider-instance.js";
import {
	currentRunnerOutput,
	makeRunnerReceiptStore,
} from "./runner-receipts.js";
import {
	currentPendingSendOwner,
	runnerCommandEnded,
	runningRunnerCommands,
} from "./runner-recovery.js";
import {
	discoverAllRunners,
	prepareRunnerDirectory,
	type RunnerProcessTable,
	readRunnerEvidence,
	removeRunnerDiscovery,
	removeRunnerEvidence,
	runnerDirectory,
	runnerPidMatchesRegistration,
	runnerProcessTable,
} from "./runner-registry.js";
import {
	type Hold,
	makeRunnerRetirement,
	makeRunnerRunLifecycle,
} from "./runner-retirement.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import {
	makeRunnerSendFeeder,
	type OwnerSend,
	type SendWritePermission,
} from "./runner-send-feeder.js";
import { runnerSendCommandsForProcess } from "./runner-send-journal.js";
import { makeRunnerSends, type SendBinding } from "./runner-sends.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import { makeRunnerUpgrade } from "./runner-upgrade.js";
import { makeSendAdmissionWait } from "./send-admission.js";
import { makeSendScopes, type SendScope } from "./send-scope.js";
import {
	type HeldSendRef,
	retrySettlementWrite,
	type SendEvidence,
	type SettlementTx,
	sendRetryBackoff,
	terminalFailureResult,
	terminalTurnResult,
	toStoreFault,
} from "./send-settlement.js";
import {
	LegacySendKey,
	requeueLegacySend,
	settleLegacySend,
	settleSend,
} from "./send-settlement-outbox.js";
import type {
	AdmitSend,
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

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
	readonly legacyPrepareTurnEffect?: RunnerDriverPieces["prepareTurnEffect"];
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
		const emit = (output: SessionOutput, sessionId?: string) =>
			emitOutput(
				output,
				sessionId,
				"sinkId" in output ? sends.route(output.sinkId)?.sendScope : undefined,
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
			? yield* makeRunnerReceiptStore(sql, { configDir }).pipe(Effect.orDie)
			: undefined;
		const sessionCommit = (sessionId: string) =>
			Effect.gen(function* () {
				if (!sql || Option.isNone(projection))
					return yield* Effect.fail(
						runnerFailure(
							"send-turn",
							"Missing run ownership or projection services",
						),
					);
				const [session] = yield* sql<{
					project_id: string;
				}>`SELECT project_id FROM sessions WHERE id = ${sessionId}`.pipe(
					Effect.mapError((cause) => ({
						...runnerFailure("send-turn", cause),
						cause,
					})),
				);
				if (!session)
					return yield* Effect.fail(
						runnerFailure("send-turn", "Session is no longer available"),
					);
				const store = yield* makeEventStoreEffect.pipe(
					Effect.provideService(PersistenceProjectTag, {
						projectId: session.project_id,
					}),
					Effect.provideService(SqlClient.SqlClient, sql),
				);
				const commit = yield* makeCommitAndSignal.pipe(
					Effect.provideService(EventStoreEffectTag, store),
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(ProjectionRunnerEffectTag, projection.value),
				);
				const persist = yield* makeClaudeEventPersistEffect.pipe(
					Effect.provideService(EventStoreEffectTag, store),
					Effect.provideService(SqlClient.SqlClient, sql),
					Effect.provideService(ProjectionRunnerEffectTag, projection.value),
				);
				const recovery = yield* deps.recoveryForSession?.(sessionId) ??
					Effect.succeed(undefined);
				const drafts = yield* Effect.serviceOption(InputDraftsTag);
				const settlement = {
					driverKind: driver.driverKind,
					persistUserMessage: persist.persistUserMessage,
					...(recovery?.inputDrafts
						? { inputDrafts: recovery.inputDrafts }
						: Option.isSome(drafts)
							? { inputDrafts: drafts.value }
							: {}),
				};
				const lifecycle = makeRunnerRunLifecycle({
					sql,
					commit,
					eventStore: store,
					...settlement,
					wakeReactor: wakeReactor(sessionId),
					released: (input) => feeder.released(input),
				});
				return {
					store,
					commit,
					projector: projection.value,
					lifecycle,
					settlement,
				};
			});
		const wakeReactor = (sessionId: string) =>
			Effect.gen(function* () {
				const recovery = yield* deps.recoveryForSession?.(sessionId) ??
					Effect.succeed(undefined);
				if (recovery?.wakeReactor) runFork(recovery.wakeReactor);
			});
		// One settlement transaction with every duty of 4.7; publishes run after commit.
		const commitSettlement = (evidence: SendEvidence) =>
			Effect.gen(function* () {
				if (!sql) return;
				const { commit, settlement } = yield* sessionCommit(
					evidence.send.sessionId,
				);
				const followUps: Effect.Effect<void>[] = [];
				yield* commit.write(
					(project, stamp) => {
						followUps.length = 0;
						const tx: SettlementTx = {
							sql,
							project,
							stamp,
							...settlement,
							afterCommit: (effect) => followUps.push(effect),
						};
						return settleSend(tx, evidence);
					},
					{
						afterCommit: Effect.suspend(() =>
							Effect.forEach(followUps, (effect) => effect, {
								discard: true,
							}),
						),
					},
				);
			});
		const settleObservedSend = (evidence: SendEvidence) =>
			Effect.gen(function* () {
				yield* retrySettlementWrite(commitSettlement(evidence));
				yield* wakeReactor(evidence.send.sessionId);
			});

		const pauseSend = (
			point: "before-hold" | "after-hold" | "after-release",
			input: {
				readonly sessionId: string;
				readonly runId: string;
				readonly commandId: string;
				readonly runnerId?: string;
				readonly transmission?: number;
			},
		) =>
			Effect.gen(function* () {
				const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
				if (
					process.env["NODE_ENV"] !== "test" ||
					process.env["CONDUIT_TEST_SEND_CONTINUATION_PAUSE"] !== point ||
					!proof
				)
					return;
				const gate = join(
					dirname(proof),
					`conduit-test-send-continuation-${point}`,
				);
				if (!existsSync(gate)) return;
				const mark = {
					channel: "conduit-process-test",
					kind: "send-continuation-paused",
					point,
					...input,
				};
				appendFileSync(proof, `${JSON.stringify(mark)}\n`);
				process.send?.(mark);
				while (existsSync(gate)) yield* Effect.sleep("10 millis");
			});
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
		const currentEntry = (sessionId: string) => {
			const serving = stops.serving(sessionId);
			if (serving) return stops.records.get(serving)?.identity.entry;
			for (const record of stops.records.values())
				if (
					record.identity.sessionId === sessionId &&
					record.tag._tag === "Starting" &&
					record.identity.entry?.pid === undefined &&
					!record.identity.entry?.lifecycle.candidate
				)
					return record.identity.entry;
			return undefined;
		};
		const activeEntries = () =>
			[...stops.records.values()].flatMap((record) => {
				const entry = record.identity.entry;
				return entry && currentEntry(entry.sessionId) === entry ? [entry] : [];
			});
		const attachedEntries = () =>
			[...stops.records.values()].flatMap((record) =>
				record.identity.entry && record.tag._tag !== "Retired"
					? [record.identity.entry]
					: [],
			);
		const tracked = (entry: RunnerChild) =>
			stops.records.get(entry.runnerId)?.identity.entry === entry;
		const observeProcess = (sessionId: string, entry: RunnerChild) =>
			Effect.gen(function* () {
				const grant = stops.grantOf(entry);
				if (stops.records.get(entry.runnerId)?.observation === "Observed")
					return;
				const retirement = deps.recoveryForSession
					? (yield* deps.recoveryForSession(sessionId))?.retirePrompts(
							entry.runnerId,
						)
					: legacyRetirePrompts?.(entry.runnerId, { sessionId });
				// A skipped retirement must remain eligible when project services return.
				if (!retirement) return;
				const observed = yield* stops.guarded(
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
				if (Option.isSome(observed)) stops.observe(entry.runnerId);
			});
		const sends = makeRunnerSends({
			sendScopes,
			runFork,
			withAccountScope: driver.withAccountScope,
			closing: () => stops.closing,
			currentEntry,
		});
		const failSendOnce = (binding: SendBinding, failure: Effect.Effect<void>) =>
			Effect.suspend(() => (sends.outcome(binding) ? failure : Effect.void));
		const failBoundSend = (
			sinkId: string,
			binding: SendBinding,
			entry: RunnerChild,
			failure: SessionFailure,
		) =>
			stops
				.guarded(
					stops.grantOf(entry),
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
		const acknowledgeSends = (
			sessionId: string,
			entry: RunnerChild,
			connection: RunnerSocket,
		) =>
			Effect.gen(function* () {
				const pending = sends.pendingOn(entry);
				if (!sql || !pending.length) return;
				const rows = yield* sql<{
					command_id: string;
					attempt: number;
				}>`SELECT command_id, MAX(attempt_count) AS attempt FROM provider_command_outbox
				WHERE session_id = ${sessionId} AND effect_type = 'send_turn'
					AND status IN ('completed', 'failed') AND command_id IN ${sql.in(pending)}
				GROUP BY command_id`;
				if (
					stops.closing ||
					entry.connection !== connection ||
					connection.closed
				)
					return;
				if (rows.length)
					yield* lock.withPermits(1)(
						Effect.sync(() => {
							Entry.touch(entry);
							connection.write({
								type: "settled-commands",
								commands: rows.map((row) => ({
									commandId: row.command_id,
									attempt: row.attempt,
								})),
							});
							// This command invalidates a warming attempt, but may be the
							// last work at the current idle boundary. Keep its retry wake.
							upgrade(sessionId, entry);
						}),
					);
			}).pipe(retryRunnerPersistence);
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
		const pauseSwap = (
			phase: "after-prepare" | "after-commit",
			sessionId: string,
			old: RunnerChild,
			replacement: RunnerChild,
		) =>
			Effect.gen(function* () {
				const proof = process.env["CONDUIT_TEST_PROCESS_PROOF"];
				if (
					process.env["NODE_ENV"] !== "test" ||
					process.env["CONDUIT_TEST_RUNNER_SWAP_PAUSE"] !== phase ||
					!proof
				)
					return;
				const gate = join(
					dirname(proof),
					`conduit-test-hold-runner-swap-${phase}`,
				);
				const mark = {
					channel: "conduit-process-test",
					kind: "runner-swap-paused",
					phase,
					sessionId,
					oldRunnerId: old.runnerId,
					oldPid: old.pid,
					newRunnerId: replacement.runnerId,
					newPid: replacement.pid,
				};
				appendFileSync(proof, `${JSON.stringify(mark)}\n`);
				process.send?.(mark);
				while (existsSync(gate)) yield* Effect.sleep("10 millis");
			});

		const closeStoppedSends = (runnerId: string) =>
			Effect.gen(function* () {
				if (!sql) return yield* sends.closeRunner(runnerId);
				const held = yield* sql<{
					id: string;
				}>`SELECT id FROM provider_runs WHERE runner_id = ${runnerId} AND held_transmission IS NOT NULL AND status IN ('pending', 'running')`;
				yield* sends.closeRunner(
					runnerId,
					held.map(({ id }) => id),
				);
			}).pipe(
				Effect.mapError((cause) => runnerFailure("close stopped sends", cause)),
			);
		const evictStoppedEntry = (entry: RunnerChild) =>
			Effect.gen(function* () {
				Entry.end(entry);
				entry.connection?.destroy();
				yield* closeStoppedSends(entry.runnerId);
				yield* releaseEntryWaiters(
					entry,
					Cause.fail(
						entry.lifecycle.failure ??
							runnerFailure("stop runner", "Provider process stopped"),
					),
				);
			});
		const releaseEntryWaiters = (
			entry: RunnerChild,
			cause: Cause.Cause<SessionFailure>,
		) =>
			Effect.gen(function* () {
				Entry.notifyEntry(entry);
				yield* Deferred.failCause(entry.ready, cause);
				yield* Deferred.succeed(entry.drained, undefined);
				const ending = entry.lifecycle.end;
				if (ending) yield* Deferred.succeed(ending.released, undefined);
			});
		const detach = (entry: RunnerChild, failure?: SessionFailure) => {
			Entry.end(entry);
			entry.connection?.destroy(failure);
			entry.child?.unref();
			if (entry.child?.connected) entry.child.disconnect();
		};
		const stops: Effect.Success<ReturnType<typeof makeRunnerRetirement>> =
			yield* makeRunnerRetirement({
				receipts,
				processTable,
				driverKind: driver.driverKind,
				close: {
					lock,
					sends: sendScopes.closeAll,
					release: releaseEntryWaiters,
					detach,
				},
				...(sql
					? {
							holdRun: (sessionId: string, runId: string, commandId: string) =>
								sessionCommit(sessionId).pipe(
									Effect.flatMap(({ lifecycle }) =>
										lifecycle.holdRun({ sessionId, runId, commandId }),
									),
									Effect.mapError(toStoreFault),
								),
						}
					: {}),
				release: (input, stop) =>
					Effect.gen(function* () {
						if (!sql) return { released: true };
						const { lifecycle } = yield* sessionCommit(input.sessionId);
						return yield* lifecycle
							.releaseRun(input, stop ?? (() => Effect.succeed(undefined)))
							.pipe(
								Effect.mapError((cause) => ({
									...runnerFailure("release runner hold", cause),
									cause,
								})),
							);
					}),
				released: (input) =>
					Effect.gen(function* () {
						sends.released(input);
						yield* pauseSend("after-release", input);
					}),
				shutdown: (retirement) =>
					Effect.gen(function* () {
						const entry = stops.records.get(retirement.runnerId)?.identity
							.entry;
						if (!entry) return;
						// Release daemon resources after the durable fence, independently
						// of process survival and Gone-only outcome settlement.
						yield* closeStoppedSends(entry.runnerId);
						// A runner that never became ready has no connection to stop; the
						// Signal action owns its process. An interrupted adoption fails
						// ready with interruption, which Effect.ignore would not absorb.
						const ready = entry.connection
							? Exit.succeed(entry.connection)
							: yield* Effect.exit(Deferred.await(entry.ready));
						if (Exit.isFailure(ready)) return;
						yield* ready.value.commandEffect(
							`runner-stop:${retirement.runnerId}`,
							{
								type: "shutdown",
							},
						);
					}),
				settlement: {
					sql,
					configDir,
					ingestion: (sessionId, entry) =>
						deps.recoveryForSession
							? ingestionForSession(sessionId)
							: Effect.succeed(entry?.ingestion ?? ingestion),
					projectRoot: deps.projectRootForSession,
					commit: commitSettlement,
					wake: wakeReactor,
				},
				evict: (retirement) =>
					Effect.gen(function* () {
						const record = stops.records.get(retirement.runnerId);
						if (record) {
							const exceptCommandId = stops.endCommand(retirement.runnerId);
							yield* retireReplacedPrompts(
								currentEntry(retirement.sessionId)?.runnerId ?? null,
								{
									sessionId: retirement.sessionId,
									expiredProcessId: retirement.runnerId,
									...(exceptCommandId ? { exceptCommandId } : {}),
								},
							);
							yield* lock
								.withPermits(1)(
									Effect.suspend(() =>
										currentEntry(retirement.sessionId)
											? Effect.void
											: emit({
													type: "background-task",
													transition: {
														sessionId: retirement.sessionId,
														kind: "session-ended",
													},
												}),
									),
								)
								.pipe(Effect.interruptible, Effect.timeout("1 second"));
							if (record.identity.entry)
								yield* evictStoppedEntry(record.identity.entry);
						}
					}),
				prune: (retirement) =>
					Effect.gen(function* () {
						const evidence = readRunnerEvidence(
							configDir,
							retirement.runnerId,
							retirement.sessionId,
						);
						if (receipts) yield* receipts.pruneRetired(retirement.runnerId);
						const socketPath =
							stops.records.get(retirement.runnerId)?.identity.socketPath ??
							evidence?.socketPath ??
							discoverAllRunners(configDir, processTable).find(
								(registration) => registration.runnerId === retirement.runnerId,
							)?.socketPath;
						if (socketPath) {
							removeRunnerDiscovery(socketPath);
							removeRunnerEvidence(socketPath);
						}
					}),
				notice: (retirement) =>
					Effect.gen(function* () {
						if (
							retirement.stopReason ===
							JSON.stringify({ _tag: "CandidateAbandoned" })
						)
							return true;
						const pid = retirement.identity.pid;
						if (!sql || pid === undefined) return true;
						const [session] = yield* sql<{
							archived_at: number | null;
						}>`SELECT archived_at FROM sessions WHERE id = ${retirement.sessionId}`;
						if (!session || session.archived_at !== null) return true;
						const sessionIngestion = yield* ingestionForSession(
							retirement.sessionId,
						);
						if (!sessionIngestion) return false;
						yield* sessionIngestion.ingest({
							eventId: `runner-survivor-${retirement.runnerId}`,
							type: "turn.notice",
							providerId: driver.driverKind,
							sessionId: retirement.sessionId,
							providerRefs: {},
							rawSource: { kind: "conduit.runner-stop" },
							createdAt: yield* Clock.currentTimeMillis,
							data: {
								text:
									retirement.signal.tag !== "None"
										? `The previous run (pid ${pid}) was told to stop but hasn't exited yet. It can't change this session any more and will exit when the system releases it.`
										: `Conduit couldn't confirm pid ${pid} is the previous run, so it didn't stop it. It may still be running. Stop it manually if it is.`,
							},
						});
						return true;
					}),
			});
		const retireRecord = (
			record: RunnerRecord<RunnerChild>,
			cause: SessionFailure,
		): Effect.Effect<void, SessionFailure> =>
			Effect.gen(function* () {
				const entry = record.identity.entry;
				const alreadyRetired = record.tag._tag === "Retired";
				yield* stops.requestStop(
					entry
						? stops.retirementFor(entry)
						: stops.retirementForIdentity(record.identity),
				);
				if (!alreadyRetired)
					log.warn(
						`Retired surviving runner ${record.identity.runnerId}: ${cause.message}`,
					);
				if (entry) {
					Entry.transition(entry, { _tag: "Fail", failure: cause });
					Entry.transition(entry, { _tag: "Recovered" });
					yield* releaseEntryWaiters(entry, Cause.fail(cause));
				}
			});
		const retireSurvivor = (
			entry: RunnerChild,
			cause: SessionFailure,
		): Effect.Effect<void, SessionFailure> => {
			const record = stops.records.get(entry.runnerId);
			return record?.identity.entry === entry
				? retireRecord(record, cause)
				: Effect.void;
		};
		const retireOrphan = (
			entry: RunnerChild,
		): Effect.Effect<void, SessionFailure> =>
			Effect.gen(function* () {
				const ownsEntry = entry.lifecycle.candidate
					? tracked(entry)
					: currentEntry(entry.sessionId) === entry;
				if (stops.closing || !ownsEntry) return;
				// An orphan's session is gone or already served. EndSession is not
				// role-gated, so the commit stops whatever row it reads.
				yield* stops
					.stopRunner(entry, undefined, "stop", {
						_tag: "EndSession",
					})
					.pipe(Effect.ensuring(Deferred.succeed(entry.drained, undefined)));
			});
		yield* Effect.addFinalizer(() =>
			stops.shutdown.pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Runner shutdown failed", cause),
				),
			),
		);

		const failed = (
			sessionId: string,
			entry: RunnerChild,
			failure: SessionFailure,
		) => {
			if (failure.code === "runner_idle_exit")
				Entry.transition(entry, { _tag: "IdleExit" });
			if (
				!Entry.canControl(entry.lifecycle) ||
				entry.lifecycle.activity._tag === "Recovering" ||
				stops.closing
			)
				return;
			Entry.transition(entry, { _tag: "Fail", failure });
			if (
				!entry.lifecycle.idleExiting &&
				entry.lifecycle.activity._tag !== "StartupTimedOut"
			)
				log.error(
					`${runnerLabel} failed for session ${sessionId}: ${failure.message}`,
				);
			// The reconciler retries and logs the Stop commit.
			runFork(
				stops.stopRunner(entry, undefined, "failure").pipe(Effect.ignore),
			);
		};

		const attach = (
			sessionId: string,
			entry: RunnerChild,
			identityOnly = false,
		) =>
			Effect.gen(function* () {
				const outputAuthority = stops.attach(entry);
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
				const recoveredSendRefs = new Map<string, HeldSendRef>();
				const legacySendKeys = new Map<string, LegacySendKey>();
				const legacyKey = (commandId: string, attempt: number) =>
					JSON.stringify([commandId, attempt]);
				const answerKey = (
					commandId: string,
					attempt: number,
					fallback: boolean,
				) => JSON.stringify([commandId, attempt, fallback]);
				let recoveryBindings: NonNullable<RunnerHello["bindings"]> = [];
				const settleRecoveredSends = (
					answers: readonly RunnerSendAnswer[],
					requeueMissing: boolean,
					source: "journal" | "reply" = "journal",
				) => {
					const observedAt = clock.currentTimeMillisUnsafe();
					return Effect.gen(function* () {
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
							Effect.mapError((cause) => ({
								...runnerFailure("settle runner reply", cause),
								cause,
							})),
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
							const followUps: Effect.Effect<void>[] = [];
							yield* stops
								.guarded(
									stops.grantOf(outputAuthority),
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
													false,
													undefined,
													true,
												);
												const tx = {
													sql,
													project: projectEvents,
													stamp,
													driverKind: driver.driverKind,
													persistUserMessage: persist.persistUserMessage,
													...(recovery?.inputDrafts
														? { inputDrafts: recovery.inputDrafts }
														: Option.isSome(drafts)
															? { inputDrafts: drafts.value }
															: {}),
													afterCommit: (effect: Effect.Effect<void>) =>
														followUps.push(effect),
												};
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
													const legacy = legacySendKeys.get(
														legacyKey(row.command_id, row.attempt_count),
													);
													const [modern] = legacy
														? []
														: yield* sql`SELECT 1 FROM provider_runs run
															WHERE run.id = ${row.run_id} AND run.session_id = ${sessionId} AND run.joined_into IS NULL
															AND NOT ${legacyRunnerRunPredicate(sql, sessionId, sql`run.id`)}`;
													const [mode] = modern
														? yield* sql<{
																fallback: number | null;
															}>`SELECT json_extract(payload_json, '$.nativeResumeFallback') AS fallback FROM provider_command_outbox WHERE request_sequence = ${row.request_sequence}`
														: [];
													const answer = answers.find(
														({ commandId, attempt, nativeResumeFallback }) =>
															commandId === row.command_id &&
															attempt === row.attempt_count &&
															(!modern ||
																nativeResumeFallback ===
																	(mode?.fallback === 1)),
													);
													if (answer?.status === "running") continue;
													const completed =
														answer?.status === "finished" ? answer : undefined;
													if (completed) {
														// Modern resume refusals continue only after their C3 release.
														if (
															modern &&
															!completed.nativeResumeFallback &&
															(completed.result?.nativeResumeRejected ||
																isClaudeResumeRefused(
																	completed.failure ?? completed.result?.error,
																))
														)
															continue;
														if (modern) {
															const send = recoveredSendRefs.get(
																answerKey(
																	completed.commandId,
																	completed.attempt,
																	completed.nativeResumeFallback,
																),
															);
															if (!send) continue;
															if (source === "reply") {
																const result = completed.failure
																	? terminalFailureResult(completed.failure)
																	: terminalTurnResult(completed.result);
																if (result)
																	yield* settleSend(tx, {
																		_tag: "replied",
																		send,
																		result,
																		observedAt,
																	});
															} else
																yield* settleSend(tx, {
																	_tag: "journal_finished",
																	send,
																	answer: completed,
																	observedAt,
																});
														} else {
															const key = legacy;
															if (key)
																yield* settleLegacySend(
																	tx,
																	key,
																	completed.result,
																	completed.failure,
																	observedAt,
																	{
																		nativeResumeFallback:
																			completed.nativeResumeFallback,
																		driverKind: driver.driverKind,
																	},
																);
														}
														continue;
													}
													if (answer?.status === "uncertain") continue;
													if (!requeueMissing) continue;
													if (modern) continue;
													if (row.error_code === "delivery_indeterminate")
														continue;
													if (row.run_id) {
														// Inspect the requested run: row.run_id already resolves to its owner.
														// Steers retain their own replay rules after owner intake begins.
														const [startedOwner] =
															yield* sql`SELECT 1 FROM provider_command_outbox command
															JOIN provider_runs requested ON requested.id = command.run_id AND requested.session_id = command.session_id
															WHERE command.request_sequence = ${row.request_sequence} AND command.session_id = ${sessionId}
																AND requested.joined_into IS NULL AND (requested.status <> 'pending' OR requested.started_at IS NOT NULL)`;
														if (startedOwner) continue;
													}
													yield* requeueLegacySend(tx, row, observedAt);
												}
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
								.pipe(Effect.tap(() => wakeReactor(sessionId)));
						}
					}).pipe(
						retrySettlementWrite,
						Effect.mapError((cause) =>
							runnerFailure("settle runner reply", cause),
						),
					);
				};
				const recoverLegacySends = (connection: RunnerSocket) =>
					sql
						? Effect.gen(function* () {
								// C 7.4: a runner without journal answers replays every running
								// send, selected by the capability check alone.
								return yield* recoverLegacyRunnerCommands({
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
										sends.retain(entry, commandId, attempt),
									ready: Deferred.await(entry.ready).pipe(Effect.asVoid),
									replay: (row, replayLock) => {
										let admittedSend: SendScope | undefined;
										const withAdmission = <A>(
											input: Parameters<AdmitSend>[0]["input"],
											sinkId: string,
											work: (
												send: SendScope,
											) => Effect.Effect<A, SessionFailure>,
											journaled = false,
										) => {
											const retained = sends.route(sinkId)?.sendScope;
											return sends.admit(
												{
													origin: { _tag: "Adopted" },
													sinkId,
													input,
													...(retained
														? { retained }
														: admittedSend
															? { previous: admittedSend }
															: {}),
													isEnded: runnerCommandEnded(
														sql,
														sessionId,
														row.command_id,
														row.attempt_count,
													),
													refuse: () => Effect.void,
												},
												(send) =>
													Effect.gen(function* () {
														admittedSend = send;
														const pending = {
															sessionId,
															turnId:
																input.continuation?.cutOffMessageId ??
																input.inputId,
															cancelled: yield* Deferred.make<void>(),
														};
														yield* stops
															.guarded(
																stops.grantOf(outputAuthority),
																{ kind: "output" },
																Effect.gen(function* () {
																	yield* sends.bind(sinkId, {
																		sendScope: send,
																		sessionId,
																		commandId: row.command_id,
																		inputId: input.inputId,
																		runId: input.runId,
																		messageId: row.assistant_message_id ?? "",
																		commandPending: true,
																	});
																	yield* sends.bindPending(
																		send,
																		sinkId,
																		pending,
																	);
																	if (journaled) sends.dispatch(send, entry);
																	if (
																		!recoveryBindings.some(
																			(binding) =>
																				binding.commandId === row.command_id &&
																				binding.sinkId === sinkId,
																		)
																	)
																		recoveryBindings = [
																			...recoveryBindings,
																			{
																				sessionId,
																				commandId: row.command_id,
																				attempt: row.attempt_count,
																				sinkId,
																				released: false,
																			},
																		];
																}),
															)
															.pipe(
																Effect.flatMap(
																	Option.match({
																		onNone: () => Effect.interrupt,
																		onSome: Effect.succeed,
																	}),
																),
															);
														return yield* Effect.raceFirst(
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
															work(send),
														);
													}),
											);
										};
										return replayLegacyRunnerSend({
											sql,
											row,
											replayLock,
											driverKind: driver.driverKind,
											connection,
											...(driver.legacyPrepareTurnEffect
												? { prepareTurnEffect: driver.legacyPrepareTurnEffect }
												: {}),
											deps,
											admitReplay: (input, sinkId, replay, journaled = false) =>
												withAdmission(
													input,
													sinkId,
													(send) =>
														sends
															.retainAccount(
																send,
																sinkId,
																input.account?.id ?? row.provider_id,
																connection,
															)
															.pipe(
																Effect.catchIf(
																	() => journaled,
																	() => Effect.void,
																),
																Effect.andThen(replay),
															),
													journaled,
												).pipe(
													Effect.map(
														(outcome) =>
															Option.getOrUndefined(outcome) ?? {
																result: undefined,
																nativeResumeFallback:
																	input.nativeResumeFallback === true,
															},
													),
													Effect.catchIf(
														(failure) => failure.code === "cancelled",
														() =>
															Effect.succeed({
																result: CANCELLED_TURN,
																nativeResumeFallback:
																	input.nativeResumeFallback === true,
															}),
													),
												),
											liveSession: runner.getNativeSessionEffect(sessionId),
											resolveSinkId: (
												commandId,
												inputId,
												attempt,
												fallback,
											) => {
												const inputSink = runnerSinkId(
													inputId,
													attempt,
													fallback,
												);
												return sends.route(inputSink)
													? inputSink
													: runnerSinkId(commandId, attempt, fallback);
											},
											closing: () =>
												stops.closing ||
												currentEntry(sessionId) !== entry ||
												entry.connection !== connection ||
												connection.closed,
											send: (commandId, command, attempt) => {
												const dispatch = (send: SendScope) =>
													Effect.gen(function* () {
														if (send.assignment._tag === "Closed")
															return CANCELLED_TURN;
														yield* sends.retainAccount(
															send,
															command.sinkId,
															row.provider_id,
															connection,
														);
														const pending = sends.pending(send);
														if (
															pending &&
															Deferred.isDoneUnsafe(pending.cancelled)
														)
															return CANCELLED_TURN;
														sends.dispatch(send, entry);
														const targetConnection = connection;
														return yield* targetConnection.commandEffect(
															commandId,
															command,
															attempt,
														);
													});
												const retained = sends.route(command.sinkId)?.sendScope;
												return retained
													? dispatch(retained)
													: withAdmission(
															command.input,
															command.sinkId,
															dispatch,
														).pipe(Effect.map(Option.getOrUndefined));
											},
										}).pipe(
											(effect) =>
												stops.guarded(
													stops.grantOf(outputAuthority),
													{ kind: "output" },
													effect,
												),
											Effect.flatMap(
												Option.match({
													onNone: () => Effect.interrupt,
													onSome: Effect.succeed,
												}),
											),
										);
									},
									settle: (answer, key) => {
										if (key)
											legacySendKeys.set(
												legacyKey(answer.commandId, answer.attempt),
												key,
											);
										return settleRecoveredSends([answer], false);
									},
									release: (commandId) =>
										Effect.gen(function* () {
											for (const binding of recoveryBindings) {
												if (binding.commandId !== commandId) continue;
												const send = sends.route(binding.sinkId)?.sendScope;
												if (send) yield* send.close;
											}
										}),
									closing: () =>
										stops.closing ||
										currentEntry(sessionId) !== entry ||
										entry.connection !== connection ||
										connection.closed,
									fail: (failure) => failed(sessionId, entry, failure),
									runFork,
								});
							}).pipe(
								Effect.mapError((cause) =>
									runnerFailure("recover legacy runner sends", cause),
								),
							)
						: Effect.void;
				return yield* driver.connect({
					driverKind: driver.driverKind,
					socketPath: entry.socketPath,
					sessionId,
					runnerId: entry.runnerId,
					...(entry.pid !== undefined ? { pid: entry.pid } : {}),
					helloTimeoutMs: entry.child ? startupTimeoutMs : 2000,
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
					checkpoint: (operation) =>
						stops
							// A receipt records transport progress, including discarded Starting
							// output. Persist it before allowing the runner to truncate its spool.
							.guarded(
								stops.grantOf(outputAuthority),
								{ kind: "evidence" },
								operation,
							)
							.pipe(Effect.map(Option.isSome)),
					runFork,
					onOutputCommitted: (output) =>
						runFork(
							stops
								.guarded(
									stops.grantOf(outputAuthority),
									{ kind: "output" },
									() => {
										if (
											output.type === "event" &&
											output.event.type === "run.started" &&
											output.event.runId
										)
											Entry.ownRun(entry, output.event.runId);
										sends.observe(
											output,
											"sinkId" in output
												? sends.route(output.sinkId)
												: undefined,
										);
									},
								)
								.pipe(Effect.asVoid),
						),
					emit: (output) => {
						if (identityOnly) return Effect.interrupt;
						if (output.type === "release-sink")
							return Effect.gen(function* () {
								const send = sends.route(output.sinkId)?.sendScope;
								if (
									send?.assignment._tag !== "Dispatched" ||
									send.assignment.runnerId !== entry.runnerId
								) {
									if (sends.refused(entry.runnerId, output.sinkId))
										yield* Effect.logWarning(
											"Ignored release-sink from another runner",
											{
												runnerId: entry.runnerId,
												sinkId: output.sinkId,
											},
										);
									return {};
								}
								Entry.trackInteraction(entry, output);
								yield* send.close;
								return {};
							});
						const grant = stops.grantOf(outputAuthority);
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
							stops
								.guarded(
									grant,
									{ kind: "output" },
									Effect.gen(function* () {
										const prepared = yield* stops.guarded(
											grant,
											{ kind: "output" },
											() => {
												Entry.trackInteraction(entry, received);
												return "sinkId" in received
													? sends.route(received.sinkId)
													: undefined;
											},
										);
										if (Option.isNone(prepared)) return {};
										const reply = yield* emit(received, sessionId);
										yield* stops.guarded(grant, { kind: "output" }, () => {
											sends.observe(received, prepared.value);
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
												sends.outcome(prepared.value);
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
							if (sql && !identityOnly) {
								const accounts = yield* deps.accounts ??
									Effect.succeed(undefined);
								const rows = yield* runningRunnerCommands(
									sql,
									driver.driverKind,
									(accountId) =>
										accounts?.accounts.find(({ id }) => id === accountId)
											?.driver ??
										accounts?.deleted.find(({ id }) => id === accountId)
											?.driver ??
										(accountId === driver.driverKind
											? driver.driverKind
											: undefined),
									sessionId,
									false,
									undefined,
									true,
								);
								for (const row of rows) {
									const key = yield* LegacySendKey.prove(sql, row);
									if (key)
										legacySendKeys.set(
											legacyKey(row.command_id, row.attempt_count),
											key,
										);
								}
							}
							// A main-built runner's replay settles its held sends too (C 7.4).
							if (sql && !identityOnly) {
								const held = yield* sql<{
									run_id: string;
									command_id: string;
									request_sequence: number;
									attempt_count: number;
									transmission: number;
									fallback: number | null;
								}>`SELECT run.id AS run_id, command.command_id, command.request_sequence,
									command.attempt_count, run.held_transmission AS transmission,
									json_extract(command.payload_json, '$.nativeResumeFallback') AS fallback
									FROM provider_runs run JOIN provider_command_outbox command
									ON command.run_id = run.id AND command.session_id = run.session_id
									WHERE run.session_id = ${sessionId} AND run.runner_id = ${entry.runnerId}
									AND run.held_transmission IS NOT NULL AND run.status IN ('pending', 'running')
									AND command.effect_type = 'send_turn'`;
								for (const row of held)
									recoveredSendRefs.set(
										answerKey(
											row.command_id,
											row.attempt_count,
											row.fallback === 1,
										),
										{
											sessionId,
											runId: row.run_id,
											commandId: row.command_id,
											requestSequence: row.request_sequence,
											attempt: row.attempt_count,
											runnerId: entry.runnerId,
											transmission: row.transmission,
										},
									);
							}
							recoveryBindings = isLegacyRunner(hello)
								? legacyRunnerBindings(hello)
								: (hello.bindings ?? []);
							if (!isLegacyRunner(hello)) {
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
							const ownsEntry = () =>
								(entry.lifecycle.candidate
									? tracked(entry)
									: currentEntry(sessionId) === entry) &&
								Entry.canControl(entry.lifecycle) &&
								!stops.closing;
							Entry.connect(entry, {
								hello,
								connection,
								attachmentId: (yield* currentRunnerOutput)?.attachmentId,
								startTime: (pid) => processTable.inspect(pid).startTime,
								owns: ownsEntry,
							});
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
							connection.commandDispatch = (write, message) =>
								lock.withPermits(1)(
									Effect.suspend(() => {
										const state = stops.state(entry.runnerId);
										if (
											"record" in state &&
											!(
												message.type === "command" &&
												message.command.type === "shutdown"
											)
										)
											return Effect.fail({
												...runnerFailure(
													"write runner command",
													"Runner is stopping",
												),
												delivery: { _tag: "NotSent" },
											});
										Entry.touch(entry);
										return write;
									}),
								);
							// A committed serving candidate must activate before replay or send.
							if (!entry.lifecycle.candidate) {
								yield* lock.withPermits(1)(
									Effect.sync(() => {
										Entry.touch(entry);
										connection.write({ type: "upgrade-activate" });
									}),
								);
							}
							yield* stops.adoptEntry(
								entry,
								entry.lifecycle.candidate ? "starting" : "live",
							);
							Entry.identify(entry, hello);
							log.info(
								`${runnerLabel} attached for session ${sessionId}: build ${hello.buildId}, answers ${hello.settlesAnswers === true ? "runner-settled" : "legacy answer-question/answer-permission"}`,
							);
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
							// Acknowledgement retention is independent of recovery ownership.
							sends.recovered(
								entry,
								isLegacyRunner(hello)
									? legacyRunnerRetainedSends(hello)
									: (hello.sendAnswers ?? []),
							);
							if (sql && !isLegacyRunner(hello)) {
								const held = yield* sql<{
									run_id: string;
									command_id: string;
									transmission: number;
									attempt_count: number;
									native_resume_fallback: number | null;
								}>`SELECT run.id AS run_id, command.command_id, run.held_transmission AS transmission, command.attempt_count, json_extract(command.payload_json, '$.nativeResumeFallback') AS native_resume_fallback FROM provider_runs run JOIN provider_command_outbox command ON command.run_id = run.id AND command.session_id = run.session_id WHERE run.session_id = ${sessionId} AND run.runner_id = ${entry.runnerId} AND run.held_transmission IS NOT NULL AND run.status IN ('pending', 'running') AND command.effect_type = 'send_turn'`;
								for (const transmission of held) {
									const answer = hello.sendAnswers?.find(
										(answer) =>
											answer.commandId === transmission.command_id &&
											answer.attempt === transmission.attempt_count &&
											answer.nativeResumeFallback ===
												(transmission.native_resume_fallback === 1),
									);
									if (
										answer?.status === "finished" &&
										!answer.nativeResumeFallback &&
										(answer.result?.nativeResumeRejected ||
											isClaudeResumeRefused(
												answer.failure ?? answer.result?.error,
											))
									) {
										yield* stops.release({
											sessionId,
											runId: transmission.run_id,
											runnerId: entry.runnerId,
											commandId: transmission.command_id,
											transmission: transmission.transmission,
											reason: "ResumeRejected",
										});
										continue;
									}
									// Retained journal evidence owns this transmission. Finished
									// answers settle below; uncertain answers must remain held.
									if (answer || hello.drainsConnections !== true) continue;
									const status = yield* connection.commandStatusEffect(
										transmission.command_id,
										transmission.attempt_count,
										transmission.native_resume_fallback === 1
											? true
											: undefined,
									);
									if (status === "not_received")
										yield* stops.release({
											sessionId,
											runId: transmission.run_id,
											runnerId: entry.runnerId,
											commandId: transmission.command_id,
											transmission: transmission.transmission,
											reason: "NotSent",
										});
								}
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
										if (!isLegacyRunner(hello) && row.status === "running") {
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
										const turn = sends.route(send.sinkId);
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
								let admitted = sends.route(binding.sinkId);
								if (!admitted || sends.runnerOf(admitted) !== entry.runnerId) {
									const result = yield* sends.admit(adoption, (sendScope) =>
										Effect.gen(function* () {
											sends.dispatch(sendScope, entry);
											const adopted = {
												sendScope,
												sessionId,
												...(binding.commandId
													? { commandId: binding.commandId }
													: {}),
												...(inputId ? { inputId } : {}),
												runId,
												messageId,
												commandPending: pending,
											};
											yield* stops.guarded(
												stops.grantOf(outputAuthority),
												{ kind: "output" },
												sends.bind(binding.sinkId, adopted),
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
										const turn = sends.route(binding.sinkId);
										if (turn?.sendScope !== sendScope) return;
										yield* sends.retainAccount(
											sendScope,
											binding.sinkId,
											accountId ??
												hello.upgradeState?.snapshot?.input.account?.id,
											connection,
										);
									});
									restoreAccounts.push(
										sends
											.admit(
												{ ...adoption, retained: sendScope },
												() => restoreAccount,
											)
											.pipe(
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
								yield* stops.guarded(
									stops.grantOf(outputAuthority),
									{ kind: "output" },
									() => Entry.trackInteraction(entry, pending.output),
								);
								if (pending.sequence <= (hello.acknowledgedSequence ?? 0))
									yield* stops.guarded(
										stops.grantOf(outputAuthority),
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
												const turn = sends.route(binding.sinkId);
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
												yield* Effect.sync(() => sends.commandSettled(turn));
											}
										}),
									);
							}
							yield* Effect.all(restoreAccounts, { discard: true });
							yield* ensureAttached();
							// Replay may publish a newer delivery state even without recovered sends.
							if (
								(!driver.withAccountScope || restoreAccounts.length === 0) &&
								!entry.recoveringCommands &&
								entry.upgrade.state?.sourceDelivery
							)
								yield* replay ?? Effect.void;
							if (sql && entry.recoveringCommands) {
								if (
									replay &&
									(!driver.withAccountScope || restoreAccounts.length === 0)
								) {
									// Request backlog now, without making startup wait for its commits.
									runFork(
										replay.pipe(
											Effect.catchCause((cause) =>
												Deferred.await(entry.ready).pipe(
													Effect.ignore,
													Effect.andThen(
														Effect.sync(() =>
															failed(
																sessionId,
																entry,
																runnerFailure(
																	"runner replay",
																	Failure.squashCause(cause),
																),
															),
														),
													),
												),
											),
										),
									);
								}
								// Journal answers do not wait for backlog delivery to unblock startup.
								if (!isLegacyRunner(hello))
									yield* settleRecoveredSends(hello.sendAnswers ?? [], true);
								else yield* recoverLegacySends(connection);
							}
							// Recovery can await output ACKs that publish a newer revision.
							Entry.observeDelivery(
								entry,
								entry.upgrade.state?.sourceDelivery,
								sends.delivers(entry, entry.upgrade.state?.sourceDelivery),
							);
							if (process.env["NODE_ENV"] === "test" && process.connected)
								process.send?.({
									channel: "conduit-process-test",
									kind: "runner-started",
									sessionId,
									pid: hello.pid,
									socketPath: entry.socketPath,
									buildId: hello.buildId,
									protocolVersion: hello.protocolVersion,
									settlesAnswers: hello.settlesAnswers === true,
									declaresLogin: hello.declaresLogin === true,
									answerDialect: hello.settlesAnswers ? "runner" : "legacy",
								});
						}).pipe(
							Effect.mapError((cause) =>
								runnerFailure("restore runner", cause),
							),
						),
					onCommandReply: (reply) =>
						Effect.gen(function* () {
							if (
								!recoveredHello ||
								isLegacyRunner(recoveredHello) ||
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
								"reply",
							);
						}),
					onCommandsSettled: (commands) => {
						runFork(
							entry.outputs
								.withPermits(1)(
									Effect.gen(function* () {
										for (const { commandId, attempt } of commands) {
											const pending = sends.pendingAttempt(entry, commandId);
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
														yield* stops.guarded(
															stops.grantOf(outputAuthority),
															{ kind: "output" },
															() => {
																if (row.run_id) Entry.ownRun(entry, row.run_id);
															},
														);
											}
											if (sends.pendingAttempt(entry, commandId) === pending)
												yield* stops.guarded(
													stops.grantOf(outputAuthority),
													{ kind: "output" },
													() => sends.settled(entry, commandId, pending),
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
						if (
							!Entry.upgradeState(
								entry,
								state,
								sends.delivers(entry, state.sourceDelivery),
							)
						)
							return;
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
						if (
							currentEntry(sessionId) === entry &&
							wasInFlight &&
							state.turnInFlight === false
						)
							PubSub.publishUnsafe(turnEnds, sessionId);
						upgrade(sessionId, entry);
					},
					onIdleExit: () => {
						Entry.transition(entry, { _tag: "IdleExit" });
						runFork(
							stops
								.requestStop(stops.retirementFor(entry), { _tag: "Idle" })
								.pipe(Effect.ignore),
						);
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
				// Registration may wait on SQLite; capture readiness at process creation.
				const noticeListening = (value: unknown) => {
					if (
						isRecord(value) &&
						value["channel"] === `conduit-${driver.driverKind}-runner` &&
						value["type"] === "listening"
					)
						Entry.transition(entry, { _tag: "Listening" });
				};
				const child = yield* Effect.try({
					try: () => {
						if (stops.closing || entry.lifecycle.stop)
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
							child.on("message", noticeListening);
							Entry.bindProcess(entry, {
								child,
								pid: child.pid,
								startTime: (pid) => processTable.inspect(pid).startTime,
							});
							return child;
						} finally {
							closeSync(log);
						}
					},
					catch: (cause) => runnerFailure("spawn runner", cause),
				});
				const registered = yield* lock
					.withPermits(1)(
						stops.register(
							entry.runnerId,
							stops.identityFor(entry),
							entry.lifecycle.candidate ? "candidate" : "serving",
						),
					)
					.pipe(
						Effect.mapError((cause) => ({
							...runnerFailure("register runner", cause),
							cause,
							...(cause._tag === "StoreUnavailable" ? { retryable: true } : {}),
						})),
						// The reconciler owns the cleanup Stop; the start fails with
						// the register fault at once.
						Effect.tapError(() =>
							Effect.sync(() =>
								runFork(
									stops
										.requestStop(stops.retirementFor(entry), {
											_tag: "CandidateAbandoned",
										})
										.pipe(Effect.ignore),
								),
							),
						),
					);
				if (registered === "Lost") {
					yield* stops.requestStop(stops.retirementFor(entry), {
						_tag: "CandidateAbandoned",
					});
					return undefined;
				}
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
				});
				yield* Effect.callback<void, SessionFailure>((resume) => {
					child.off("message", noticeListening);
					if (Entry.hasReadinessNotice(entry.lifecycle)) {
						resume(Effect.void);
						return;
					}
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
							Entry.transition(entry, { _tag: "StartupTimedOut" });
							startupTimeoutElapsedMs = Math.round(
								performance.now() - startupStartedAt,
							);
							failed("Runner startup timed out");
							runFork(
								stops
									.awaitStop(entry.runnerId, "Escalated")
									.pipe(
										Effect.ignore,
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
						Entry.transition(entry, { _tag: "Listening" });
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
				Effect.tap((connection) =>
					Effect.sync(() => {
						if (connection) Entry.transition(entry, { _tag: "Ready" });
					}),
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
			owner?: Pick<
				RunnerChild,
				"ingestion" | "pendingInteractions" | "launch" | "launchSnapshot"
			> & { readonly projectId?: string | undefined },
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
						...[...stops.records.values()].map(
							(record) => (record.identity.registeredAt ?? 0) + 1,
						),
					),
					sessionId,
					registrationRoot,
					ingestion: owner?.ingestion,
					pendingInteractions: owner?.pendingInteractions,
					launch: owner?.launch,
					launchSnapshot: owner?.launchSnapshot,
					lifecycle: candidate
						? Entry.nextRunnerLifecycle(Entry.initialRunnerLifecycle(), {
								_tag: "MakeCandidate",
							})
						: Entry.initialRunnerLifecycle(),
					runnerId,
					ready: yield* Deferred.make<RunnerSocket, SessionFailure>(),
					drained: yield* Deferred.make<void>(),
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
					outputs: yield* Semaphore.make(1),
					socketPath: join(
						runnerDirectory(registrationRoot, configDir),
						runnerId,
					),
				} satisfies RunnerChild;
				yield* stops.adoptEntry(entry, "starting");
				return entry;
			});
		const eligible = (sessionId: string, entry: RunnerChild) =>
			!stops.closing &&
			!stops.inRecovery &&
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
				createEntry(
					sessionId,
					{
						ingestion: old.ingestion,
						pendingInteractions: old.pendingInteractions,
						launch: old.launch ?? old.upgrade.state?.snapshot?.input,
						// Host revisions are local to a child; only launch data crosses upgrades.
						launchSnapshot: old.upgrade.state?.snapshot,
					},
					true,
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
					if (!connection)
						return yield* Effect.fail(
							runnerFailure(
								"upgrade runner",
								"Candidate registration was lost",
							),
						);
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
					let expectedActivity = activity;
					let committed = false;
					const cancel = lock.withPermits(1)(
						Effect.sync(() => {
							Entry.touch(old);
							old.connection?.write({ type: "upgrade-cancel" });
						}),
					);
					return yield* Effect.gen(function* () {
						// A replacement cannot dedupe an old turn whose outbox completion
						// has not committed yet. Check this off the admission path.
						if (sql) {
							const drainDelay =
								yield* Schedule.toStepWithSleep(runnerRetrySchedule);
							const drainDeadline = clock.currentTimeMillisUnsafe() + 1_000;
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
								if (
									retry === 99 ||
									clock.currentTimeMillisUnsafe() >= drainDeadline
								)
									return false;
								yield* drainDelay(undefined).pipe(
									Effect.orDie,
									Effect.timeoutOption(
										Math.max(
											0,
											drainDeadline - clock.currentTimeMillisUnsafe(),
										),
									),
								);
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
								expectedActivity = Entry.touch(old);
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
						);
						if (!retired) return false;
						yield* pauseSwap("after-prepare", sessionId, old, replacement);
						return yield* lock.withPermits(1)(
							Effect.gen(function* () {
								if (
									expectedActivity !== old.upgrade.activity ||
									!eligible(sessionId, old) ||
									replacement.lifecycle.failure ||
									replacement.connection?.closed
								) {
									return false;
								}
								yield* stops.requestStop(stops.retirementFor(old), {
									_tag: "Superseded",
									successor: replacement.runnerId,
								});
								committed = true;
								yield* pauseSwap("after-commit", sessionId, old, replacement);
								Entry.transition(replacement, { _tag: "Promote" });
								Entry.touch(replacement);
								replacement.connection?.write({ type: "upgrade-activate" });
								yield* stops.adoptEntry(replacement, "live");
								yield* sends.closeRunner(old.runnerId);
								yield* observeProcess(sessionId, replacement).pipe(
									Effect.catchCause((cause) =>
										Effect.logWarning(
											"Upgraded runner prompt observation deferred",
											cause,
										),
									),
								);
								// Keep the old process visible to shutdown and liveness while
								// stopping, without granting it the warming candidate's output.

								Entry.end(old);
								upgradeMark(sessionId, old, "switched", replacement);
								return true;
							}),
						);
					}).pipe(
						Effect.ensuring(
							Effect.suspend(() =>
								!committed && !stops.closing ? cancel : Effect.void,
							),
						),
					);
				}),
			stop: (entry) =>
				// The commit reads the role: a promoted candidate is Ignored.
				Effect.suspend(() =>
					stops.closing
						? Effect.void
						: stops.stopRunner(entry, undefined, "stop", {
								_tag: "CandidateAbandoned",
							}),
				).pipe(Effect.ignore),
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
				sends.setAdmission(admit);
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
					// A failed status request stays uncertain even when its runner dies.
					const status = yield* legacyAnswerId &&
					(command?.effect_type === "resolve_question" ||
						command?.effect_type === "resolve_permission")
						? Effect.sync(() =>
								connection.observedCommandStatus(legacyAnswerId),
							)
						: connection.commandStatusEffect(control.commandId);
					const current = currentEntry(sessionId);
					if (current && current.runnerId !== control.providerProcessId)
						return "gone";
					if (pid !== undefined && !pidAlive(pid, entry.startTime))
						return "gone";
					if (
						current !== entry ||
						entry.connection !== connection ||
						connection.closed ||
						!Entry.canControl(entry.lifecycle)
					)
						return yield* Effect.fail(unavailable());
					return status;
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
								Entry.transition(entry, { _tag: "Fail", failure: detached });
								detach(entry, detached);
								stops.detach(entry.runnerId);
								yield* sends.closeRunner(entry.runnerId);
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
					if (ownsPendingSend)
						for (const entry of activeEntries())
							if (!sessionIds || sessionIds.has(entry.sessionId))
								Entry.ownPendingSends(entry, ownsPendingSend);
					// Discover every surviving candidate before scheduling replacements.
					return yield* stops.recovering(
						sessionIds,
						Effect.gen(function* () {
							if (stops.closing)
								return yield* Effect.fail(
									runnerFailure("recover runner", "Runners are shutting down"),
								);
							const recoveryIngestion = yield* Effect.serviceOption(
								ProviderRuntimeIngestionTag,
							);
							const recoveryPending = yield* Effect.serviceOption(
								PendingInteractionServiceTag,
							);
							const discovered = discoverAllRunners(
								configDir,
								processTable,
							).filter(
								(registration) =>
									(registration.driverKind ?? "claude") === driver.driverKind &&
									(!sessionIds || sessionIds.has(registration.sessionId)),
							);
							// Each recovery reads its caller's project scope; a per-session
							// recovery owner scopes its own sessions.
							const projectScope = deps.recoveryForSession
								? Option.none()
								: yield* Effect.serviceOption(PersistenceProjectTag);
							const recovered = yield* stops
								.recover((row) =>
									Effect.gen(function* () {
										if (
											row.driverKind !== driver.driverKind ||
											(sessionIds && !sessionIds.has(row.sessionId))
										)
											return false;
										if (!sql || Option.isNone(projectScope)) return true;
										const [session] = yield* sql<{
											project_id: string;
										}>`SELECT project_id FROM sessions WHERE id = ${row.sessionId}`.pipe(
											Effect.mapError((cause) =>
												runnerFailure("scope recovered runner", cause),
											),
										);
										return (
											!session ||
											session.project_id === projectScope.value.projectId
										);
									}),
								)
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("recover runners", cause),
									),
								);
							for (const row of recovered.rows) {
								if (
									row.driverKind !== driver.driverKind ||
									row.role !== "serving" ||
									row.retiredAt !== null ||
									(sessionIds && !sessionIds.has(row.sessionId)) ||
									discovered.some(
										(registration) => registration.runnerId === row.runnerId,
									) ||
									row.identity.pid === undefined
								)
									continue;
								const root = yield* deps.projectRootForSession(row.sessionId);
								if (!root) continue;
								// The row owns the slot; registry files only locate identity.
								// Hello still verifies this deterministic transport's peer.
								discovered.push({
									runnerId: row.runnerId,
									sessionId: row.sessionId,
									driverKind: row.driverKind,
									pid: row.identity.pid,
									...(row.identity.tag === "Verified"
										? { startTime: row.identity.startTime }
										: {}),
									socketPath: join(
										runnerDirectory(root, configDir),
										row.runnerId,
									),
									buildId: "recovered",
									registeredAt: row.sequence,
								});
							}
							const foreignSessions = new Set(
								sql && Option.isSome(projectScope)
									? (yield* sql<{
											id: string;
										}>`SELECT id FROM sessions WHERE id IN ${sql.in(discovered.map((registration) => registration.sessionId))} AND project_id <> ${projectScope.value.projectId}`.pipe(
											Effect.mapError((cause) =>
												runnerFailure("scope recovered runners", cause),
											),
										)).map((row) => row.id)
									: [],
							);
							// A registration locates a host, but cannot grant a serving slot.
							// Hosts missed by the listening -> cursor commit window are attached
							// for identity verification and abandoned cleanup only.
							const unregistered = new Set(
								discovered
									.filter(
										(registration) =>
											!recovered.rows.some(
												(row) => row.runnerId === registration.runnerId,
											) &&
											!recovered.rejected.some(
												(error) => error.runnerId === registration.runnerId,
											),
									)
									.map((registration) => registration.runnerId),
							);
							const registrations = discovered.filter(
								(registration) =>
									!foreignSessions.has(registration.sessionId) &&
									(unregistered.has(registration.runnerId) ||
										recovered.rows.some(
											(row) =>
												row.runnerId === registration.runnerId &&
												row.role === "serving" &&
												row.retiredAt === null &&
												// recover registered a Stop for it without waiting.
												stops.state(row.runnerId)._tag === "Running",
										)) &&
									!recovered.rejected.some(
										(error) => error.runnerId === registration.runnerId,
									),
							);
							const identities = registrations.map((registration) => ({
								...registration,
								entry: undefined as RunnerChild | undefined,
							}));
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
								: { rows: [], rejected: [] };
							const known = yield* Effect.forEach(
								identities.filter(
									(identity) =>
										!cursorOwners.rejected.some(
											(error) => error.runnerId === identity.runnerId,
										),
								),
								(identity) =>
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
													...(cursorOwners.rows.find(
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
							// Only durable serving rows restore process authority. Other hosts
							// get a Starting grant solely to verify hello and retire the host.
							const active = yield* stops
								.adopt(
									known.filter(
										(identity) => !unregistered.has(identity.runnerId),
									),
									"live",
								)
								.pipe(
									Effect.mapError((cause) =>
										runnerFailure("recover runner authority", cause),
									),
								);
							for (const registration of registrations) {
								const missingCursor = unregistered.has(registration.runnerId);
								if (!missingCursor && !active.grants.has(registration.runnerId))
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
									missingCursor ||
									(sql !== undefined && !persisted && !outstandingEnd) ||
									Boolean(currentEntry(registration.sessionId));
								const entry: RunnerChild = {
									...registration,
									recoveringCommands: !abandoned,
									ownsPendingSend,
									ownedRunIds: new Set(
										stops.records.get(registration.runnerId)?.identity
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
								};
								yield* lock.withPermits(1)(
									Effect.gen(function* () {
										if (stops.closing)
											return yield* Effect.fail(
												runnerFailure(
													"recover runner",
													"Runners are shutting down",
												),
											);
										abandoned ||= Boolean(currentEntry(registration.sessionId));
										if (abandoned)
											Entry.transition(entry, { _tag: "MakeCandidate" });
										yield* stops.adoptEntry(
											entry,
											missingCursor ? "starting" : "live",
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
												schedule: runnerRetrySchedule,
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
									!stops.closing &&
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
								// Startup never waits on a Stop commit. The reconciler retries it,
								// and the entry's waiters settle once the stop finishes or fails.
								const stopUnawaited = (
									stop: Effect.Effect<void, SessionFailure>,
								) =>
									runFork(
										stop.pipe(
											Effect.catchCause((cause) =>
												releaseEntryWaiters(entry, cause).pipe(
													// Shutdown interrupts a Stop still committing; that is not an error.
													Effect.andThen(
														Failure.isInterruptedOnly(cause)
															? Effect.void
															: Effect.logError(
																	"Runner recovery stop failed",
																	cause,
																),
													),
												),
											),
										),
									);
								const attachAndRecover = Effect.gen(function* () {
									yield* ensureRecovering;
									const reconnectDelay =
										yield* Schedule.toStepWithSleep(runnerRetrySchedule);
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
										pidAlive(registration.pid, registration.startTime) &&
										retry < 4;
										retry++
									) {
										yield* reconnectDelay(undefined).pipe(Effect.orDie);
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
										Entry.transition(entry, { _tag: "Verify" });
										// Fail, not a user Stop: Settle ends its uncertain sends as
										// delivery_indeterminate (CONTRACT 4.9, 7.3).
										Entry.transition(entry, { _tag: "Fail", failure });
										yield* Deferred.fail(entry.ready, failure);
										stopUnawaited(
											Effect.gen(function* () {
												yield* stops.stopRunner(entry, undefined, "failure");
												if (pidAlive(registration.pid, registration.startTime))
													return yield* retireSurvivor(entry, failure);
												Entry.transition(entry, { _tag: "Recovered" });
												Entry.transition(entry, { _tag: "Fail", failure });
												yield* stops.stopRunner(entry);
												yield* releaseEntryWaiters(entry, Cause.fail(failure));
											}),
										);
										return;
									}
									if (
										connected._tag === "Failure" ||
										connected.success.closed
									) {
										const failure =
											connected._tag === "Failure"
												? connected.failure
												: runnerFailure(
														"recover runner",
														"Runner disconnected during recovery",
													);
										if (!pidAlive(registration.pid, registration.startTime)) {
											Entry.transition(entry, { _tag: "Recovered" });
											const abandonedFailure: SessionFailure = {
												...failure,
												code: "runner_recovery_abandoned",
												retryable: true,
											};
											Entry.transition(entry, {
												_tag: "Fail",
												failure: abandonedFailure,
											});
											stopUnawaited(
												stops
													.stopRunner(entry, undefined, "failure")
													.pipe(
														Effect.andThen(
															releaseEntryWaiters(
																entry,
																Cause.fail(abandonedFailure),
															),
														),
													),
											);
											return;
										}
										// Detach this registration so admission can create its replacement.
										stopUnawaited(retireSurvivor(entry, failure));
										return;
									}
									if (abandoned) {
										Entry.transition(entry, { _tag: "Recovered" });
										yield* Deferred.succeed(entry.ready, connected.success);
										// Shutdown skips retirement; waiters must still be released.
										stopUnawaited(
											retireOrphan(entry).pipe(
												Effect.ensuring(
													Deferred.succeed(entry.drained, undefined),
												),
											),
										);
										return;
									}
									yield* lock.withPermits(1)(
										Effect.gen(function* () {
											yield* ensureRecovering;
											Entry.transition(entry, { _tag: "Recovered" });
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
										if (exit._tag === "Success" || stops.closing)
											return Effect.void;
										// Interruption is no stop reason (6.3), but its waiters must settle.
										if (Failure.isInterruptedOnly(exit.cause))
											return releaseEntryWaiters(entry, exit.cause);
										return Effect.sync(() => {
											Entry.transition(entry, { _tag: "Recovered" });
											Entry.transition(entry, {
												_tag: "Fail",
												failure: runnerFailure(
													"recover runner",
													Failure.squashCause(exit.cause),
												),
											});
											entry.connection?.destroy();
											stopUnawaited(
												stops
													.stopRunner(entry)
													.pipe(
														Effect.andThen(
															releaseEntryWaiters(entry, exit.cause),
														),
													),
											);
										});
									}),
								);
								if (missingCursor)
									runFork(
										attachAndRecover.pipe(
											Effect.catch((failure) =>
												Effect.logWarning(
													"Runner attachment recovery failed",
													failure,
												),
											),
										),
									);
								else yield* attachAndRecover;
							}
						}).pipe(Effect.tap(() => recoverOwnerSends(sessionIds))),
					);
				}).pipe(
					Effect.onExit((exit) =>
						Effect.sync(() => {
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
			ownsRetirementCleanupEffect(
				sessionId: string,
				runId: string,
			): Effect.Effect<boolean> {
				if (!sql) return Effect.succeed(false);
				return Effect.gen(function* () {
					const [modern] =
						yield* sql`SELECT 1 FROM provider_runs run JOIN provider_command_outbox command ON command.run_id = run.id AND command.session_id = run.session_id WHERE run.id = ${runId} AND run.session_id = ${sessionId} AND run.joined_into IS NULL AND run.status IN ('pending', 'running') AND command.effect_type = 'send_turn' AND command.status = 'running'`;
					if (modern && !(yield* legacyRunnerRunQuery(sql, sessionId, runId)))
						return true;
					return yield* sql<{
						held: number;
					}>`SELECT EXISTS (SELECT 1 FROM provider_runs requested
					JOIN provider_runs owner ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
					JOIN claude_runner_cursors stop ON stop.session_id = owner.session_id AND stop.retired_at IS NOT NULL
					WHERE requested.session_id = ${sessionId} AND requested.id = ${runId}
					AND (owner.runner_id = stop.runner_id OR (owner.runner_id IS NULL AND requested.id IN (SELECT value FROM json_each(stop.owned_run_ids))))
				) AS held`.pipe(
						Effect.map(([row]) => row?.held === 1),
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"Could not read runner retirement ownership",
								cause,
							).pipe(Effect.as(true)),
						),
					);
				}).pipe(
					Effect.catchCause((cause) =>
						Effect.logWarning("Owner recovery hand-off failed", cause).pipe(
							Effect.as(true),
						),
					),
				);
			}
			hasLiveProcessEffect(
				sessionId: string,
				processId?: string,
			): Effect.Effect<boolean> {
				return Effect.sync(() => {
					for (const runnerId of processId === undefined
						? stops.recoveredRunnerIds
						: []) {
						const state = stops.state(runnerId);
						if (
							!("record" in state) ||
							state._tag === "Settled" ||
							state.record.sessionId !== sessionId
						)
							continue;
						const identity = state.record.identity;
						if (
							identity.pid !== undefined &&
							pidAlive(
								identity.pid,
								identity.tag === "Verified" ? identity.startTime : undefined,
							)
						)
							return true;
					}
					const records =
						processId === undefined
							? stops.records.values()
							: [stops.records.get(processId)];
					for (const record of records) {
						if (!record || record.identity.sessionId !== sessionId) continue;
						const runnerId = record.identity.runnerId;
						const entry = record.identity.entry;
						const pid = entry?.pid ?? entry?.child?.pid ?? record.identity.pid;
						const alive =
							pid !== undefined &&
							pidAlive(pid, entry?.startTime ?? record.identity.startTime);
						if (
							alive &&
							record.identity.sessionId === sessionId &&
							(processId === undefined ||
								(runnerId === processId &&
									(record.tag._tag === "Live" ||
										record.tag._tag === "Starting" ||
										// A runner owns its End until that End's Stop reaches Escalated.
										(stops.endCommand(runnerId) !== undefined &&
											["Committing", "Requested", "Escalating"].includes(
												stops.state(runnerId)._tag,
											)))))
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
				T extends Pick<
					SessionTurn,
					"sessionId" | "inputId" | "account" | "continuation"
				>,
			>(
				input: T,
				sinkId: string,
				work: Effect.Effect<A, E, R>,
				scope: SendScope,
				accountId: string | undefined = input.account?.id,
			): Effect.Effect<A, E | SessionFailure, R> {
				return Effect.gen(function* () {
					const pending = sends.pending(scope) ?? {
						sessionId: input.sessionId,
						turnId: input.continuation?.cutOffMessageId ?? input.inputId,
						cancelled: yield* Deferred.make<void>(),
					};
					yield* sends.bindPending(scope, sinkId, pending);
					return yield* Effect.raceFirst(
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
						sends.retainAccount(scope, sinkId, accountId).pipe(
							Effect.andThen(() => {
								const demand = sends.demand(scope);
								return demand
									? Effect.raceFirst(
											work.pipe(
												Effect.catchCause(
													(cause): Effect.Effect<never, E | SessionFailure> =>
														!stops.closing &&
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
						),
					);
				});
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
				if (command.type !== "send-turn")
					return this.executeCommandEffect(command, send, recovered).pipe(
						Effect.as(undefined),
					);
				if (!send)
					return Effect.die("Send command requires its admitted handle");
				if (!sql || !command.input.runId)
					return this.executeCommandEffect(command, send, recovered);
				const runId = command.input.runId;
				return Effect.gen({ self: this }, function* () {
					const [run] = yield* sql<{
						joined_into: string | null;
						runner_id: string | null;
						held_transmission: number | null;
					}>`SELECT joined_into, runner_id, held_transmission
						FROM provider_runs WHERE id = ${runId} AND session_id = ${command.input.sessionId}`.pipe(
						retrySettlementWrite,
						Effect.mapError((cause) => runnerFailure("send-turn", cause)),
					);
					const legacy = yield* legacyRunnerRunQuery(
						sql,
						command.input.sessionId,
						runId,
					).pipe(
						retrySettlementWrite,
						Effect.mapError((cause) => runnerFailure("send-turn", cause)),
					);
					if (run?.joined_into || legacy)
						return yield* this.executeCommandEffect(
							command,
							send,
							recovered,
							undefined,
							legacy,
						);
					const commandId =
						(yield* runSendCommandIdQuery(
							sql,
							command.input.sessionId,
							runId,
						).pipe(
							retrySettlementWrite,
							Effect.mapError((cause) => runnerFailure("send-turn", cause)),
						)) ?? command.input.inputId;
					const pending = sends.pending(send) ?? {
						sessionId: command.input.sessionId,
						turnId:
							command.input.continuation?.cutOffMessageId ??
							command.input.inputId,
						cancelled: yield* Deferred.make<void>(),
					};
					yield* sends.bindPending(send, command.sinkId, {
						...pending,
						owner: true,
					});
					const [claim] = yield* sql<{
						request_sequence: number;
						attempt_count: number;
					}>`SELECT request_sequence, attempt_count
						FROM provider_command_outbox WHERE session_id = ${command.input.sessionId}
						AND run_id = ${runId} AND command_id = ${commandId} AND effect_type = 'send_turn'
						AND (${command.input.commandAttempt ?? null} IS NULL OR attempt_count = ${command.input.commandAttempt ?? null})
						ORDER BY request_sequence DESC LIMIT 1`.pipe(
						retrySettlementWrite,
						Effect.mapError((cause) => runnerFailure("read send claim", cause)),
					);
					const feederInput: OwnerSend = {
						...(claim
							? {
									requestSequence: claim.request_sequence,
									attempt: claim.attempt_count,
								}
							: {}),
						sessionId: command.input.sessionId,
						runId,
						commandId,
					};
					const result = yield* feeder
						.send(
							feederInput,
							(hold, permission) =>
								Effect.gen(function* () {
									yield* pauseSend("after-hold", {
										...feederInput,
										runnerId: hold.runner,
										transmission: hold.transmission,
									});
									const [payload] = yield* retrySettlementWrite(sql<{
										fallback: number;
									}>`SELECT COALESCE(json_extract(payload_json, '$.nativeResumeFallback'), 0) AS fallback
								FROM provider_command_outbox WHERE session_id = ${feederInput.sessionId} AND run_id = ${runId} AND command_id = ${commandId}
								ORDER BY request_sequence DESC LIMIT 1`).pipe(
										Effect.mapError((cause) =>
											runnerFailure("read send mode", cause),
										),
									);
									if (
										(payload?.fallback === 1) !==
										permission.nativeResumeFallback
									)
										return yield* transmitStoredOwner(
											feederInput,
											hold,
											permission,
										);
									return yield* runner
										.executeCommandEffect(
											command,
											send,
											recovered,
											hold,
											false,
											permission,
										)
										.pipe(
											Effect.catchIf(
												(failure) =>
													runnerCommandReplied(failure) &&
													!runnerDeliveryEvidence(failure) &&
													!isClaudeResumeRefused(failure),
												(failure) =>
													Effect.succeed(terminalFailureResult(failure)),
											),
											Effect.map((reply) =>
												reply
													? {
															...reply,
															runnerSend: {
																runnerId: hold.runner,
																transmission: hold.transmission,
															},
														}
													: reply,
											),
										);
								}),
							command.input.nativeResumeFallback === true,
							send.close,
						)
						.pipe(
							Effect.mapError((cause) => runnerFailure("send-turn", cause)),
						);
					const [open] = yield* retrySettlementWrite(
						sql`SELECT 1 FROM provider_runs WHERE id = ${runId} AND session_id = ${command.input.sessionId} AND status IN ('pending', 'running')`,
					).pipe(
						Effect.mapError((cause) =>
							runnerFailure("read send lifetime", cause),
						),
					);
					if (result?.status !== "completed" && (!result || !open))
						yield* send.close;
					return result ?? CANCELLED_TURN;
				});
			}

			executeCommandEffect(
				command: Extract<SessionCommand, { type: "send-turn" }>,
				send: SendScope,
				recovered?: RunnerChild,
				held?: Extract<Hold, { _tag: "Held" }>,
				legacySend?: boolean,
				permission?: SendWritePermission,
			): Effect.Effect<TurnResult, SessionFailure>;
			executeCommandEffect(
				command: Exclude<SessionCommand, { type: "send-turn" }>,
				send?: SendScope,
				recovered?: RunnerChild,
				held?: Extract<Hold, { _tag: "Held" }>,
				legacySend?: boolean,
				permission?: SendWritePermission,
			): Effect.Effect<void, SessionFailure>;
			executeCommandEffect(
				command: SessionCommand,
				send: SendScope,
				recovered?: RunnerChild,
				held?: Extract<Hold, { _tag: "Held" }>,
				legacySend?: boolean,
				permission?: SendWritePermission,
			): Effect.Effect<TurnResult | undefined, SessionFailure>;
			executeCommandEffect(
				command: SessionCommand,
				send?: SendScope,
				recovered?: RunnerChild,
				held?: Extract<Hold, { _tag: "Held" }>,
				legacySend = false,
				permission?: SendWritePermission,
			): Effect.Effect<TurnResult | undefined, SessionFailure> {
				const turn: SendBinding | undefined =
					command.type === "send-turn"
						? {
								sessionId: command.input.sessionId,
								...(send ? { sendScope: send } : {}),
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
								commandPending: true,
							}
						: undefined;
				let child: RunnerChild | undefined;
				let sentToRunner = false;
				let admitted: RunnerChild | undefined;
				let admittedSessionId = "";
				let cancelled: Deferred.Deferred<void> | undefined;
				let unsentReleased = false;
				const emitUnsent = (output: SessionOutput) =>
					Effect.suspend(() => {
						if (command.type !== "send-turn" || unsentReleased)
							return Effect.succeed({});
						const binding = sends.route(command.sinkId);
						if (binding && binding !== turn) return Effect.succeed({});
						if (output.type !== "release-sink") return emit(output);
						unsentReleased = true;
						return Effect.succeed({});
					});
				let deliveryRegistration:
					| { entry: RunnerChild; changed: Deferred.Deferred<void> }
					| undefined;
				let deliveryDeadline: number | undefined;
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
						const pendingSend = (turn?.sendScope
							? sends.pending(turn.sendScope)
							: undefined) ?? {
							sessionId: command.input.sessionId,
							turnId:
								command.input.continuation?.cutOffMessageId ??
								command.input.inputId,
							cancelled,
						};
						if (turn?.sendScope)
							yield* sends.bindPending(
								turn.sendScope,
								command.sinkId,
								pendingSend,
							);
						sentToRunner = false;
					}
					const outputOwner = yield* currentRunnerOutput;
					if (command.type === "abort") {
						if (!send) return;
						if (
							send &&
							(send.assignment._tag === "Closed" ||
								(sends.route(command.sinkId) !== undefined &&
									sends.route(command.sinkId)?.sendScope !== send))
						)
							return;
						// Owner sends end through settleSend or a durable Stop; non-owner
						// sends (joined steers, legacy and direct sends) keep the
						// in-memory cancel the recall needs.
						const pending = sends.pending(send);
						if (pending && !sends.dispatched(send) && !pending.owner) {
							yield* Deferred.succeed(pending.cancelled, undefined);
							return;
						}
					}
					if (command.type === "interrupt") {
						yield* sends.cancelUndispatched(command.sessionId, command.turnIds);
					}
					if (command.type === "shutdown") {
						yield* stops.shutdown;
						return;
					}
					if (stops.closing)
						return yield* Effect.fail(
							runnerFailure(command.type, "Runners are shutting down"),
						);
					const sessionId =
						command.type === "send-turn"
							? command.input.sessionId
							: "sessionId" in command
								? command.sessionId
								: sends.route(command.sinkId)?.sessionId;
					if (!sessionId) return;
					admittedSessionId = sessionId;
					if (command.type === "send-turn" && turn?.sendScope)
						yield* sends.retainAccount(
							turn.sendScope,
							command.sinkId,
							command.input.account?.id,
						);
					let entry: RunnerChild | undefined;
					// Admission parks on this entry. Only a new gate step may pick another holder.
					let selectedEntry = held
						? stops.records.get(held.runner)?.identity.entry
						: currentEntry(sessionId);
					let selecting = true;
					while (selecting) {
						const selection = yield* lock.withPermits(1)(
							Effect.gen(function* () {
								if (stops.closing)
									return yield* Effect.fail(
										runnerFailure(command.type, "Runners are shutting down"),
									);
								const existing = selectedEntry;
								// An interrupted adoption settles ready but leaves its survivor
								// Recovering with no failure or stop. A send needs the serving
								// slot, so it retires that survivor as a failed adoption would
								// (CONTRACT 6.7, 6.3). Under the lock, after the closing check,
								// shutdown can never see it retire a live survivor (Q28).
								if (
									existing &&
									existing !== recovered &&
									existing.lifecycle.activity._tag === "Recovering" &&
									!existing.lifecycle.failure &&
									!existing.lifecycle.stop &&
									Deferred.isDoneUnsafe(existing.ready) &&
									(command.type === "send-turn" || command.type === "pre-warm")
								)
									yield* retireSurvivor(
										existing,
										runnerFailure(
											"recover runner",
											"Runner adoption was interrupted",
										),
									);
								if (held && (!existing || existing.runnerId !== held.runner))
									return yield* Effect.fail({
										...runnerFailure(
											"send-turn",
											"Holder is no longer attached",
										),
										delivery: { _tag: "NotSent" },
									});
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
									Entry.watch(existing, changed);
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
									Entry.unwatch(existing, changed);
									deliveryRegistration = undefined;
									const decision = Entry.decideSend({
										command: command.type,
										lifecycle: existing.lifecycle,
										quiescent: existing.upgrade.state?.quiescent === true,
										rebindsAccount:
											existing.capabilities?.rebindsAccount === true &&
											// The capability predates guarded account admission. The
											// shared dev sentinel cannot establish the child's build.
											(loginChange !== "Account" ||
												(existing.buildId !== "dev" &&
													existing.buildId === runnerBuildId())),
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
												retryable: true,
											});
										case "Skip":
											return { entry: undefined, draining: false };
										case "Wait":
											Entry.watch(existing, changed);
											deliveryRegistration = { entry: existing, changed };
											return {
												entry: existing,
												draining: true,
												foldersPending: changed,
												waitReason: foldersChanged
													? ("foldersPending" as const)
													: legacyCursor
														? ("legacyCursor" as const)
														: ("loginPending" as const),
											};
										case "Retire":
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
										yield* sends.bind(command.sinkId, turn);
									}
									if (existing && !draining) {
										Entry.transition(existing, { _tag: "AdmitCommand" });
										admitted = existing;
										Entry.touch(existing);
									}
									return {
										entry: existing,
										draining,
										admission: existing?.lifecycle.end?.released,
									};
								}
								const created: RunnerChild = yield* createEntry(sessionId, {
									projectId: command.input.projectId,
									launch: {
										workspaceRoot: command.input.workspaceRoot,
										extraFolders: command.input.extraFolders,
									},
								});
								Entry.transition(created, { _tag: "AdmitCommand" });
								admitted = created;

								if (turn && command.type === "send-turn") {
									yield* sends.bind(command.sinkId, turn);
								}
								runFork(
									start(sessionId, created).pipe(
										Effect.onExit((exit) =>
											Exit.isFailure(exit)
												? Deferred.failCause(created.ready, exit.cause)
												: exit.value
													? Deferred.succeed(created.ready, exit.value)
													: Deferred.fail(
															created.ready,
															runnerFailure(
																"start runner",
																"Serving registration was lost",
															),
														),
										),
										Effect.ignore,
										Effect.asVoid,
									),
								);
								return { entry: created, draining: false };
							}),
						);
						entry = selection.entry;
						selecting = selection.draining;
						if (
							"sourceDeliveryPending" in selection &&
							selection.sourceDeliveryPending
						) {
							const changed = selection.sourceDeliveryPending;
							const now = yield* Clock.currentTimeMillis;
							// Notifications and successor producers share this send's budget.
							deliveryDeadline ??= now + STOP_ABORT_WAIT_MS;
							const failure: SessionFailure = {
								operation: command.type,
								code: "account_switch_busy",
								retryable: true,
								message:
									"Source delivery did not finish before account-switch admission. Resend the turn.",
							};
							if (now >= deliveryDeadline) return yield* Effect.fail(failure);
							yield* Deferred.await(changed).pipe(
								Effect.timeoutOrElse({
									duration: deliveryDeadline - now,
									orElse: () => Effect.fail(failure),
								}),
								Effect.ensuring(
									Effect.sync(() => {
										if (deliveryRegistration)
											Entry.unwatch(deliveryRegistration.entry, changed);
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
									currentEntry(sessionId) !== waiting && waiting.lifecycle.stop
										? Effect.void
										: Effect.fail(failure),
								),
							);
							continue;
						}
						if (
							"foldersPending" in selection &&
							selection.foldersPending &&
							selection.waitReason &&
							entry
						) {
							const changed = selection.foldersPending;
							const waitingEntry = entry;
							const wait = Deferred.await(changed).pipe(
								Effect.ensuring(
									Effect.sync(() => Entry.unwatch(waitingEntry, changed)),
								),
							);
							yield* waitForAdmission
								? waitForAdmission(selection.waitReason, wait)
								: wait;
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
											const released = Entry.transition(retiring, {
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
						if (held && selection.draining)
							return yield* Effect.fail({
								...runnerFailure("send-turn", "Runner stopped before write"),
								delivery: { _tag: "NotSent" },
							});
						if (entry && selection.draining) {
							yield* Deferred.await(
								!entry.lifecycle.failure &&
									!entry.lifecycle.idleExiting &&
									selection.admission
									? selection.admission
									: entry.drained,
							);
							selectedEntry = undefined;
						}
					}
					if (!entry) return;
					child = entry;
					sentToRunner = false;
					// Restored controls must still reach the old query while a send
					// waits to rebind. That send is what keeps admission readiness gated.
					let connection =
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
					if (stops.closing)
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
					const launchEntry = entry;
					const preserveReportedLogin = <
						Command extends Extract<
							SessionCommand,
							{ type: "send-turn" | "pre-warm" }
						>,
					>(
						payload: Command,
					): Command => {
						const snapshot = launchEntry.upgrade.state?.snapshot;
						const launch = snapshot?.input;
						if (
							driver.driverKind === "claude" &&
							!launchEntry.capabilities?.declaresLogin &&
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
						held &&
						command.input.runId
					) {
						commandId =
							(yield* runSendCommandIdQuery(
								sql,
								sessionId,
								command.input.runId,
							).pipe(
								Effect.mapError((cause) =>
									runnerFailure("resolve runner command", cause),
								),
							)) ?? commandId;
					} else if (
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
						const cohort = command.control?.retireRunIds;
						if (sql && cohort) {
							const [row] = yield* sql<{ running: number }>`SELECT EXISTS (
								SELECT 1 FROM provider_runs owner WHERE owner.session_id = ${sessionId}
								AND owner.id IN ${sql.in(cohort)} AND owner.status IN ('pending', 'running')
								AND (owner.runner_id = ${entry.runnerId} OR owner.runner_id IS NULL)
								AND NOT EXISTS (SELECT 1 FROM events terminal WHERE terminal.session_id = owner.session_id
									AND json_extract(terminal.metadata, '$.runId') = owner.id
									AND terminal.type IN ('turn.completed', 'turn.error', 'turn.interrupted'))
							) AS running`.pipe(
								Effect.mapError((cause) =>
									runnerFailure("retirement cohort", cause),
								),
							);
							if (!row?.running) return;
						}
						yield* stops.stopRunner(entry, commandId, "stop", {
							_tag: command.control?.projectRemoved
								? "ProjectRemoved"
								: "EndSession",
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
							? sends.pending(turn.sendScope)
							: undefined;
						if (pending && Deferred.isDoneUnsafe(pending.cancelled))
							return CANCELLED_TURN;
						const holder = held?.runner ?? entry.runnerId;
						const serving = stops.records.get(holder)?.identity.entry;
						if (!serving)
							return yield* Effect.fail(
								runnerFailure("send-turn", "Serving runner is not attached"),
							);
						entry = serving;
						connection =
							entry.connection ?? (yield* Deferred.await(entry.ready));
						child = entry;
					}
					if (command.type === "send-turn" && turn?.sendScope) {
						const demand = sends.demand(turn.sendScope);
						if (
							turn.sendScope.assignment._tag === "Closed" ||
							(demand && Deferred.isDoneUnsafe(demand.invalidated))
						)
							return CANCELLED_TURN;
						sends.dispatch(turn.sendScope, entry, {
							sinkId: command.sinkId,
							commandId,
							attempt: command.input.commandAttempt ?? 0,
						});
					}
					sentToRunner = true;
					if (command.type === "send-turn") {
						const demand = turn?.sendScope
							? sends.demand(turn.sendScope)
							: undefined;
						if (demand)
							Deferred.doneUnsafe(
								demand.dispatched,
								Effect.succeed(connection),
							);
					}
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
							(sends.route(command.sinkId) !== undefined &&
								sends.route(command.sinkId)?.sendScope !== send))
					)
						return;
					if (
						command.type === "send-turn" &&
						permission &&
						!permission.consume()
					)
						return yield* Effect.fail({
							...runnerFailure(
								"send-turn",
								"Transmission was released before write",
							),
							delivery: { _tag: "NotSent" },
						});
					const execution = connection.commandEffect(
						commandId,
						payload,
						command.type === "send-turn"
							? command.input.commandAttempt
							: undefined,
						permission?.current,
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
							if (deliveryRegistration)
								Entry.unwatch(
									deliveryRegistration.entry,
									deliveryRegistration.changed,
								);
							deliveryRegistration = undefined;
							if (!admitted) return;
							Entry.transition(admitted, { _tag: "FinishCommand" });
							upgrade(admittedSessionId, admitted);
							admitted = undefined;
						}),
					),
					Effect.catchDefect((cause) =>
						Effect.fail(runnerFailure(command.type, cause)),
					),
					Effect.mapError((failure) =>
						command.type === "send-turn" &&
						held &&
						!sentToRunner &&
						!("delivery" in failure) &&
						!("replied" in failure) &&
						// Admission timeout is permanent (4.7); the feeder settles it.
						failure.code !== "send_admission_timeout"
							? { ...failure, delivery: { _tag: "NotSent" as const } }
							: failure,
					),
					Effect.catch((failure) =>
						command.type === "pre-warm" &&
						(stops.closing ||
							failure.code === "runner_idle_exit" ||
							(child &&
								(Entry.mustDrainBeforeSend(child.lifecycle) ||
									child.lifecycle.stop)))
							? Effect.succeed(undefined)
							: Effect.fail(failure),
					),
					Effect.onError((cause) => {
						if (
							command.type === "send-turn" &&
							command.input.runId &&
							!legacySend
						)
							return Effect.void;
						if (
							runnerFailure(command.type, Failure.squashCause(cause)).code ===
							"send_admission_timeout"
						)
							return Effect.void;
						if (
							command.type !== "send-turn" ||
							!turn ||
							stops.closing ||
							child?.lifecycle.failure?.code === "runner_detached" ||
							Failure.isInterruptedOnly(cause)
						)
							return Effect.void;
						// Explicit End owns settlement after confirmed exit. A socket
						// failure during its graceful phase is not a process terminal.
						if (child?.lifecycle.end && sentToRunner)
							return stops
								.awaitStop(child.runnerId, "Escalated")
								.pipe(Effect.ignore);
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
									? stops
											.awaitStop(child.runnerId, "Escalated")
											.pipe(Effect.ignore)
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
									Effect.sync(() => sends.commandSettled(turn)),
								);
							else if (turn) sends.commandSettled(turn);
						}),
					),
				);
				if (command.type !== "send-turn") return execute;
				return Effect.gen(function* () {
					if (!send)
						return yield* Effect.die(
							"Send command requires its admitted handle",
						);
					if (held) return yield* execute;
					cancelled =
						(turn?.sendScope
							? sends.pending(turn.sendScope)?.cancelled
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
		const transmitStoredOwner = (
			input: OwnerSend,
			held: Extract<Hold, { _tag: "Held" }>,
			permission: SendWritePermission,
		): Effect.Effect<TurnResult | undefined, SessionFailure> =>
			Effect.gen(function* () {
				if (!sql || stops.closing) return yield* Effect.interrupt;
				const accounts = yield* deps.accounts ?? Effect.succeed(undefined);
				const [row] = yield* runningRunnerCommands(
					sql,
					driver.driverKind,
					(accountId) =>
						accounts?.accounts.find(({ id }) => id === accountId)?.driver ??
						accounts?.deleted.find(({ id }) => id === accountId)?.driver ??
						(accountId === driver.driverKind ? driver.driverKind : undefined),
					input.sessionId,
					false,
					input,
				);
				if (!row) return;
				const replayLock = yield* Semaphore.make(1);
				let admitted: SendScope | undefined;
				let first = true;
				const sendPrepared = (
					_id: string,
					command: Extract<SessionCommand, { type: "send-turn" }>,
				) =>
					Effect.gen(function* () {
						if (!admitted)
							return yield* Effect.fail(
								runnerFailure("transmit owner send", "Missing admitted send"),
							);
						if (!first) return yield* runner.executeEffect(command, admitted);
						first = false;
						const attempt = yield* Effect.result(
							runner
								.executeCommandEffect(
									command,
									admitted,
									undefined,
									held,
									false,
									permission,
								)
								.pipe(
									Effect.catchIf(
										(failure) =>
											runnerCommandReplied(failure) &&
											!runnerDeliveryEvidence(failure) &&
											!isClaudeResumeRefused(failure),
										(failure) => Effect.succeed(terminalFailureResult(failure)),
									),
								),
						);
						const resumeRejected =
							attempt._tag === "Failure"
								? isClaudeResumeRefused(attempt.failure)
								: attempt.success?.nativeResumeRejected ||
									isClaudeResumeRefused(attempt.success?.error);
						if (driver.driverKind === "claude" && resumeRejected)
							yield* retrySettlementWrite(
								stops.release({
									...input,
									runnerId: held.runner,
									transmission: held.transmission,
									reason: "ResumeRejected",
								}),
							).pipe(
								Effect.mapError((cause) =>
									runnerFailure("release resume refusal", cause),
								),
							);
						if (attempt._tag === "Failure")
							return yield* Effect.fail(attempt.failure);
						return attempt.success
							? {
									...attempt.success,
									runnerSend: {
										runnerId: held.runner,
										transmission: held.transmission,
									},
								}
							: attempt.success;
					});
				const outcome = yield* replayLegacyRunnerSend({
					sql,
					row,
					driverKind: driver.driverKind,
					replayLock,
					...(driver.legacyPrepareTurnEffect
						? { prepareTurnEffect: driver.legacyPrepareTurnEffect }
						: {}),
					deps: {
						...(deps.accounts ? { accounts: deps.accounts } : {}),
						autoSettleAfterDays: deps.autoSettleAfterDays,
						recoveryForSession: deps.recoveryForSession,
						sessionForkSdk: deps.sessionForkSdk,
						claudeSettingsOverrides: deps.claudeSettingsOverrides,
					},
					admitReplay: (turn, sinkId, replay) =>
						sends
							.admit(
								{
									origin: { _tag: "Adopted" },
									input: turn,
									sinkId,
									isEnded: runnerCommandEnded(
										sql,
										row.session_id,
										row.command_id,
										row.attempt_count,
									),
								},
								(send) =>
									Effect.gen(function* () {
										admitted = send;
										const pending = sends.pending(send) ?? {
											sessionId: turn.sessionId,
											turnId: turn.inputId,
											cancelled: yield* Deferred.make<void>(),
										};
										yield* sends.bindPending(send, sinkId, {
											...pending,
											owner: true,
										});
										return yield* replay;
									}),
							)
							.pipe(
								Effect.map(
									Option.getOrElse(() => ({
										result: undefined,
										nativeResumeFallback: false,
									})),
								),
							),
					liveSession: runner.getNativeSessionEffect(row.session_id),
					resolveSinkId: (id, _inputId, attempt, fallback) =>
						runnerSinkId(id, attempt, fallback),
					send: sendPrepared,
					sendRetained: sendPrepared,
					closing: () => stops.closing,
				}).pipe(
					Effect.catch((failure) =>
						Effect.gen(function* () {
							if (stops.closing) return yield* Effect.interrupt;
							if (!first) return yield* Effect.fail(failure);
							const evidence: Extract<
								SendEvidence,
								{ readonly _tag: "failed" }
							> = {
								_tag: "failed",
								observedAt: clock.currentTimeMillisUnsafe(),
								failure,
								send: {
									sessionId: row.session_id,
									runId: input.runId,
									commandId: row.command_id,
									requestSequence: row.request_sequence,
									attempt: row.attempt_count,
								},
							};
							yield* retrySettlementWrite(
								Effect.gen(function* () {
									const { lifecycle } = yield* sessionCommit(row.session_id);
									yield* lifecycle.releaseRun(
										{
											sessionId: row.session_id,
											runId: input.runId,
											commandId: row.command_id,
											runnerId: held.runner,
											transmission: held.transmission,
											reason: "NotSent",
										},
										() => Effect.void,
										evidence,
									);
								}),
							);
							yield* admitted?.close ?? Effect.void;
							return { result: undefined, nativeResumeFallback: false };
						}),
					),
				);
				const result = terminalTurnResult(outcome.result);
				if (result && outcome.result?.runnerSend)
					yield* settleObservedSend({
						_tag: "replied",
						observedAt: clock.currentTimeMillisUnsafe(),
						result,
						send: {
							sessionId: row.session_id,
							runId: input.runId,
							commandId: row.command_id,
							requestSequence: row.request_sequence,
							attempt: row.attempt_count,
							...outcome.result.runnerSend,
						},
					});
				return outcome.result;
			}).pipe(
				Effect.mapError((cause) => runnerFailure("transmit owner send", cause)),
			);

		const awaitRun = (
			input: Pick<OwnerSend, "sessionId" | "runId">,
			includeCoverage = false,
		) =>
			Effect.gen(function* () {
				if (!sql) return yield* Effect.never;
				let ordinal = 0;
				while (true) {
					const snapshot = yield* Effect.result(
						Effect.gen(function* () {
							const { commit } = yield* sessionCommit(input.sessionId);
							const changed = commit.committed();
							const [run] = yield* sql<{
								status: string;
							}>`SELECT status FROM provider_runs WHERE id = ${input.runId} AND session_id = ${input.sessionId}`;
							const ended =
								!run ||
								!["pending", "running"].includes(run.status) ||
								(includeCoverage &&
									(yield* stopCovers(sql, input.sessionId, input.runId)));
							return { ended, changed };
						}),
					);
					if (snapshot._tag === "Failure") {
						const fault = toStoreFault(snapshot.failure);
						if (fault._tag === "StoreRejected") return yield* fault;
						yield* Effect.sleep(sendRetryBackoff(++ordinal));
						continue;
					}
					ordinal = 0;
					if (snapshot.success.ended) return;
					yield* snapshot.success.changed;
				}
			});

		const feeder = yield* makeRunnerSendFeeder({
			hold: (input) =>
				Effect.suspend(() =>
					stops.closing
						? Effect.interrupt
						: pauseSend("before-hold", input).pipe(
								Effect.andThen(
									stops.holdRun(input.sessionId, input.runId, input.commandId),
								),
							),
				),
			start: (input) =>
				Effect.gen(function* () {
					if (!sql || stops.closing) return yield* Effect.interrupt;
					const [row] = yield* sql<{
						project_key: string;
						payload_json: string;
					}>`SELECT project_key, payload_json FROM provider_command_outbox
					WHERE session_id = ${input.sessionId} AND run_id = ${input.runId} AND command_id = ${input.commandId}
					ORDER BY request_sequence DESC LIMIT 1`;
					if (!row) return "Started" as const;
					const payload = yield* Effect.try((): unknown =>
						JSON.parse(row.payload_json),
					);
					if (
						!isRecord(payload) ||
						typeof payload["workspaceRoot"] !== "string"
					)
						return yield* Effect.fail(
							runnerFailure("start runner", "Invalid stored send payload"),
						);
					const created = yield* createEntry(input.sessionId, {
						projectId: row.project_key,
						launch: {
							workspaceRoot: payload["workspaceRoot"],
							extraFolders: Array.isArray(payload["extraFolders"])
								? payload["extraFolders"].filter(
										(folder): folder is string => typeof folder === "string",
									)
								: [],
						},
					});
					const started = yield* Deferred.make<void, SessionFailure>();
					runFork(
						start(input.sessionId, created).pipe(
							Effect.onExit((exit) =>
								Effect.gen(function* () {
									if (Exit.isFailure(exit)) {
										yield* Deferred.failCause(created.ready, exit.cause);
										yield* Deferred.failCause(started, exit.cause);
									} else {
										if (exit.value)
											yield* Deferred.succeed(created.ready, exit.value);
										else
											yield* Deferred.fail(
												created.ready,
												runnerFailure(
													"start runner",
													"Serving registration was lost",
												),
											);
										yield* Deferred.succeed(started, undefined);
									}
								}),
							),
							Effect.ignore,
						),
					);
					yield* Deferred.await(started);
					return "Started" as const;
				}).pipe(
					Effect.catchIf(
						() => stops.closing,
						() => Effect.interrupt,
					),
					Effect.mapError((cause) => ({
						...runnerFailure("start runner", cause),
						...(toStoreFault(cause)._tag === "StoreUnavailable"
							? { retryable: true }
							: {}),
					})),
				),
			release: (input) => stops.release(input),
			failed: (input, failure, held) => {
				const observedAt = clock.currentTimeMillisUnsafe();
				return Effect.gen(function* () {
					if (!sql) return;
					yield* retrySettlementWrite(
						Effect.gen(function* () {
							const [row] = yield* sql<{
								request_sequence: number;
								attempt_count: number;
							}>`SELECT request_sequence, attempt_count FROM provider_command_outbox
							WHERE session_id = ${input.sessionId} AND run_id = ${input.runId} AND command_id = ${input.commandId}
							AND (${input.requestSequence ?? null} IS NULL OR request_sequence = ${input.requestSequence ?? null})
							AND (${input.attempt ?? null} IS NULL OR attempt_count = ${input.attempt ?? null}) ORDER BY request_sequence DESC LIMIT 1`;
							if (!row) return;
							if (!held)
								return yield* commitSettlement({
									_tag: "failed",
									observedAt,
									failure,
									send: {
										...input,
										requestSequence: row.request_sequence,
										attempt: row.attempt_count,
									},
								});
							// A held send is released unwritten and settled in one commit, so
							// its ref is unheld even when the input was built by a release.
							const { lifecycle } = yield* sessionCommit(input.sessionId);
							yield* lifecycle.releaseRun(
								{
									sessionId: input.sessionId,
									runId: input.runId,
									commandId: input.commandId,
									runnerId: held.runner,
									transmission: held.transmission,
									reason: "NotSent",
								},
								() => Effect.void,
								{
									_tag: "failed",
									observedAt,
									failure,
									send: {
										sessionId: input.sessionId,
										runId: input.runId,
										commandId: input.commandId,
										requestSequence: row.request_sequence,
										attempt: row.attempt_count,
									},
								},
							);
						}),
					);
					yield* wakeReactor(input.sessionId);
				}).pipe(
					Effect.mapError((cause) =>
						runnerFailure("settle start refusal", cause),
					),
				);
			},
			awaitRun,
			clean: (runnerId) =>
				Effect.gen(function* () {
					if (!receipts) return;
					const { rows } = yield* receipts.runners();
					const row = rows.find((candidate) => candidate.runnerId === runnerId);
					if (!row) return;
					// The reconciler owns an unavailable commit; this waits for it.
					yield* stops.requestStop(
						{ ...row, members: [] },
						{ _tag: "CandidateAbandoned" },
					);
				}).pipe(Effect.mapError(toStoreFault)),
			park: (predecessor) => {
				const window = Effect.sleep(
					Math.max(0, predecessor.until - clock.currentTimeMillisUnsafe()),
				);
				// The Stop state is read once, here. Only a Stop in progress has an
				// end to await. An unloaded (Running), legacy (already Escalated) or
				// ended (Gone, Settled) predecessor holds the gate until its window
				// ends; awaiting it would poll or return at once and re-step. A
				// rejected commit fails only the Stop's waiters, so the window ends
				// the park.
				const stop = stops.state(predecessor.runner)._tag;
				return stop === "Requested" ||
					stop === "Escalating" ||
					stop === "Committing"
					? Effect.raceFirst(
							stops
								.awaitStop(predecessor.runner, "Escalated")
								.pipe(Effect.catch(() => Effect.never)),
							window,
						)
					: window;
			},
			transmitAdopted: transmitStoredOwner,
		});

		const recoverOwnerSends = (sessionIds?: ReadonlySet<string>) =>
			Effect.gen(function* () {
				if (!sql || stops.closing) return;
				const accounts = yield* deps.accounts ?? Effect.succeed(undefined);
				const ownsPending = yield* currentPendingSendOwner;
				const rows = yield* runningRunnerCommands(
					sql,
					driver.driverKind,
					(accountId) =>
						accounts?.accounts.find(({ id }) => id === accountId)?.driver ??
						accounts?.deleted.find(({ id }) => id === accountId)?.driver ??
						(accountId === driver.driverKind ? driver.driverKind : undefined),
				);
				for (const row of rows) {
					if (
						!row.run_id ||
						(sessionIds && !sessionIds.has(row.session_id)) ||
						ownsPending?.(
							row.session_id,
							row.command_id,
							row.request_sequence,
							row.attempt_count,
						)
					)
						continue;
					// As for recovered registrations, a send whose project is not
					// served stays with the reactor's project gate; the project's
					// attachment recovers it once it is served.
					if (!(yield* deps.projectRootForSession(row.session_id))) continue;
					const [unheld] =
						yield* sql`SELECT 1 FROM provider_runs WHERE id = ${row.run_id} AND session_id = ${row.session_id}
					AND joined_into IS NULL AND runner_id IS NULL AND status IN ('pending','running')`;
					if (
						!unheld ||
						(yield* legacyRunnerRunQuery(sql, row.session_id, row.run_id))
					)
						continue;
					const [rejected] = yield* sql<{
						instance_id: string;
						fork_refused: number;
					}>`SELECT COALESCE(json_extract(command.payload_json, '$.account.id'), json_extract(command.payload_json, '$.instanceId'), command.provider_id) AS instance_id,
					(COALESCE(json_extract(command.payload_json, '$.clearInheritedGoal'), 0) OR COALESCE(json_extract(command.payload_json, '$.forkSession'), 0) OR session.forked_from IS NOT NULL) AS fork_refused
					FROM provider_command_outbox command JOIN sessions session ON session.id = command.session_id WHERE command.request_sequence = ${row.request_sequence}
					AND COALESCE(json_extract(command.payload_json, '$.nativeResumeFallback'), 0) = 0
					AND EXISTS (SELECT 1 FROM events WHERE session_id = command.session_id AND type = 'run.released'
						AND json_extract(data, '$.runId') = command.run_id AND json_extract(data, '$.commandId') = command.command_id AND json_extract(data, '$.reason') = 'ResumeRejected')`;
					if (rejected) {
						const { commit } = yield* sessionCommit(row.session_id);
						yield* commit.write(() =>
							Effect.gen(function* () {
								const [eligible] =
									yield* sql`SELECT 1 FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
								WHERE command.request_sequence = ${row.request_sequence} AND command.attempt_count = ${row.attempt_count} AND command.status = 'running'
								AND run.runner_id IS NULL AND run.status IN ('pending', 'running')`;
								if (!eligible) return;
								yield* recordClaudeNativeResumeFallback(sql, {
									sessionId: row.session_id,
									instanceId: rejected.instance_id,
									commandId: row.command_id,
									requestSequence: row.request_sequence,
									attempt: row.attempt_count,
									forkRefused: rejected.fork_refused !== 0,
								});
							}),
						);
					}
					yield* feeder.enqueue({
						sessionId: row.session_id,
						runId: row.run_id,
						commandId: row.command_id,
						requestSequence: row.request_sequence,
						attempt: row.attempt_count,
					});
				}
			}).pipe(
				Effect.mapError((cause) => runnerFailure("recover owner sends", cause)),
			);

		const sessionRunner: SessionRunner & {
			readonly recoverEffect: Effect.Effect<void, SessionFailure>;
			readonly withTurnEffect: NonNullable<SessionRunner["withTurnEffect"]>;
		} = runner;
		return sessionRunner;
	});
