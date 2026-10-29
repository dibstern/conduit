import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	Option,
	Semaphore,
} from "effect";
import { SqlClient } from "effect/sql";
import type { Account } from "../../contracts/account.js";
import {
	AccountSwitchBusy,
	accountSwitchBusyMessage,
} from "../../contracts/limit-recovery.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { InputDraftsTag } from "../../domain/relay/Services/input-drafts.js";
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
import { legacyRunnerRunQuery } from "./runner-legacy-classification.js";
import { replayLegacyRunnerSend } from "./runner-legacy-recovery.js";
import {
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
	type RunnerProcessTable,
	readRunnerEvidence,
	removeRunnerDiscovery,
	removeRunnerEvidence,
	runnerProcessTable,
} from "./runner-registry.js";
import {
	type Hold,
	makeRunnerRetirement,
	makeRunnerRunLifecycle,
} from "./runner-retirement.js";
import {
	makeRunnerSendFeeder,
	type OwnerSend,
	type SendWritePermission,
} from "./runner-send-feeder.js";
import { makeRunnerSends, type SendBinding } from "./runner-sends.js";
import { CANCELLED_TURN, makeRunnerStarter } from "./runner-starter.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import { makeSendAdmissionWait } from "./send-admission.js";
import { makeSendScopes, type SendScope } from "./send-scope.js";
import {
	retrySettlementWrite,
	type SendEvidence,
	type SettlementTx,
	sendRetryBackoff,
	terminalFailureResult,
	terminalTurnResult,
	toStoreFault,
} from "./send-settlement.js";
import { settleSend } from "./send-settlement-outbox.js";
import type {
	AdmitSend,
	SessionCommand,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

export interface ProcessRunnerDeps {
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
		const attachedEntries = () =>
			[...stops.records.values()].flatMap((record) =>
				record.identity.entry && record.tag._tag !== "Retired"
					? [record.identity.entry]
					: [],
			);
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
		const detachSession = (sessionId: string): Effect.Effect<void> =>
			lock
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
		const nativeSession = (
			sessionId: string,
		): Effect.Effect<ProviderNativeSession | undefined> =>
			Effect.sync(() => {
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
		const { start, createEntry, upgrade, recover, startStored, turnEnds } =
			yield* makeRunnerStarter({
				deps,
				driver,
				runFork,
				clock,
				configDir,
				runnerLabel,
				startupTimeoutMs,
				lock,
				sql,
				projection,
				receipts,
				legacyRetirePrompts,
				processTable,
				sends,
				stops,
				pidAlive,
				currentEntry,
				emit,
				failBoundSend,
				ingestionForSession,
				wakeReactor,
				nativeSession,
				detach,
				detachSession,
				releaseEntryWaiters,
				retireSurvivor,
			});
		// Starter's acknowledge loop is forked above, so shutdown runs while it is alive.
		yield* Effect.addFinalizer(() =>
			stops.shutdown.pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Runner shutdown failed", cause),
				),
			),
		);

		class ProcessSessionRunner implements SessionRunner {
			setSendAdmission(admit: AdmitSend): void {
				sends.setAdmission(admit);
			}
			readonly sendScopes = sendScopes;
			readonly turnEnds = turnEnds;

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
			readonly detachSessionEffect = detachSession;
			readonly recoverEffect = recover(
				undefined,
				Effect.suspend(() => recoverOwnerSends()),
			);

			attachSessionsEffect(sessionIds: readonly string[]) {
				const ids = new Set(sessionIds);
				return recover(ids, recoverOwnerSends(ids));
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

			readonly getNativeSessionEffect = nativeSession;

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
			start: startStored,
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
