import { appendFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
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
import { InputDraftsTag } from "../../domain/project-services/Services/input-drafts.js";
import { ProviderRuntimeIngestionTag } from "../../domain/project-services/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { DEFAULT_CONFIG_DIR } from "../../env.js";
import { makeClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import { makeCommitAndSignal } from "../../persistence/effect/commit-and-signal.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../persistence/effect/event-store-effect.js";
import { ProjectionRunnerEffectTag } from "../../persistence/effect/projection-runner-effect.js";
import { makeRetireReplacedProcessPrompts } from "../../persistence/effect/retire-pending-prompts.js";
import type {
	ProviderControlCommandStatus,
	ProviderControlContext,
} from "../types.js";
import type {
	ProcessRunnerDeps,
	ProcessRunnerDriver,
} from "./process-runner-types.js";
import { makeProductionProcessTable } from "./process-table.js";
import {
	legacyAnswerCommandId,
	makeRunnerDispatch,
} from "./runner-dispatch.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import * as Entry from "./runner-entry-lifecycle.js";
import { runnerFailure } from "./runner-protocol.js";
import { makeRunnerReceiptStore } from "./runner-receipts.js";
import {
	discoverAllRunners,
	readRunnerEvidence,
	removeRunnerDiscovery,
	removeRunnerEvidence,
} from "./runner-registry.js";
import {
	makeRunnerRetirement,
	makeRunnerRunLifecycle,
} from "./runner-retirement.js";
import { makeRunnerSendGate } from "./runner-send-feeder.js";
import { makeRunnerSends, type SendBinding } from "./runner-sends.js";
import { log, makeRunnerStarter } from "./runner-starter.js";
import { failRunnerTurn } from "./runner-turn-failure.js";
import { makeSendScopes, type SendScope } from "./send-scope.js";
import {
	retrySettlementWrite,
	type SendEvidence,
	type SettlementTx,
	toStoreFault,
} from "./send-settlement.js";
import { settleSend } from "./send-settlement-outbox.js";
import type {
	AdmitSend,
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
	SessionRunner,
	SessionTurn,
} from "./session-runner.js";

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
		const processTable =
			deps.processTable ??
			makeProductionProcessTable((message) => log.warn(message));
		const clock = yield* Clock.Clock;
		const accountDisplayName = (
			input: Pick<SessionTurn, "account" | "instanceId"> | undefined,
		) =>
			input?.account?.name ||
			input?.account?.id ||
			input?.instanceId ||
			driver.driverKind;
		const lock = yield* Semaphore.make(1);
		const configDir = resolve(deps.daemonConfigDir ?? DEFAULT_CONFIG_DIR);
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
					holds: stops.holds,
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
			point: "before-hold" | "after-hold" | "after-release" | "before-gone",
			input: {
				readonly sessionId: string;
				readonly runId?: string;
				readonly commandId?: string;
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
		const sends = makeRunnerSends({
			sendScopes,
			runFork,
			withAccountScope: driver.withAccountScope,
			closing: () => stops.closing,
			currentEntry: (sessionId) => stops.currentEntry(sessionId),
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

		const stops: Effect.Success<ReturnType<typeof makeRunnerRetirement>> =
			yield* makeRunnerRetirement({
				receipts,
				processTable,
				driverKind: driver.driverKind,
				close: {
					lock,
					sends: sendScopes.closeAll,
					detach: Entry.detach,
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
				release: (input) =>
					Effect.gen(function* () {
						if (!sql) return { released: true };
						const { lifecycle } = yield* sessionCommit(input.sessionId);
						return yield* lifecycle.releaseRun(input).pipe(
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
					closeSends: sends.closeRunner,
					// The Gone settlement's first step; a test holds it here, after the loss.
					ingestion: (sessionId, entry) =>
						pauseSend("before-gone", { sessionId }).pipe(
							Effect.andThen(
								deps.recoveryForSession
									? ingestionForSession(sessionId)
									: Effect.succeed(entry?.ingestion ?? ingestion),
							),
						),
					projectRoot: deps.projectRootForSession,
					commit: commitSettlement,
					wake: wakeReactor,
				},
				sessionCommit,
				evict: (retirement) =>
					Effect.gen(function* () {
						const record = stops.records.get(retirement.runnerId);
						if (record) {
							const exceptCommandId = stops.endCommand(retirement.runnerId);
							yield* retireReplacedPrompts(
								stops.currentEntry(retirement.sessionId)?.runnerId ?? null,
								{
									sessionId: retirement.sessionId,
									expiredProcessId: retirement.runnerId,
									...(exceptCommandId ? { exceptCommandId } : {}),
								},
							);
							// The entry scope closed at the stop's commit (6.11); eviction
							// lets go only of the dead runner's socket.
							record.identity.entry?.connection?.destroy();
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
		const {
			start,
			createEntry,
			upgrade,
			recover,
			startStored,
			turnEnds,
			retireSurvivor,
			reportStart,
			detachSession,
			nativeSession,
		} = yield* makeRunnerStarter({
			deps,
			driver,
			runFork,
			configDir,
			lock,
			sql,
			projection,
			receipts,
			legacyRetirePrompts,
			sends,
			stops,
			emit,
			failBoundSend,
			ingestionForSession,
			wakeReactor,
			sessionCommit,
		});
		// Starter's acknowledge loop is forked above, so shutdown runs while it is alive.
		yield* Effect.addFinalizer(() =>
			stops.shutdown.pipe(
				Effect.catchCause((cause) =>
					Effect.logError("Runner shutdown failed", cause),
				),
			),
		);
		const { dispatch } = makeRunnerDispatch({
			deps,
			driver,
			runFork,
			lock,
			sql,
			sends,
			stops,
			starter: { start, createEntry, upgrade, retireSurvivor, reportStart },
			emit,
			failSendOnce,
			failBoundSend,
			accountDisplayName,
		});

		const gate = yield* makeRunnerSendGate({
			deps,
			driver,
			clock,
			sql,
			sends,
			stops,
			dispatch,
			startStored,
			sessionCommit,
			settleObservedSend,
			pauseSend,
			nativeSession,
		});

		class ProcessSessionRunner implements SessionRunner {
			setSendAdmission(admit: AdmitSend): void {
				sends.setAdmission(admit);
			}
			readonly sendScopes = sendScopes;
			readonly turnEnds = turnEnds;

			hasActiveTurnsEffect(sessionId: string): Effect.Effect<boolean> {
				return Effect.sync(() => {
					const entry = stops.currentEntry(sessionId);
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
					const entry = stops.currentEntry(sessionId);
					if (entry && entry.runnerId !== control.providerProcessId)
						return "gone";
					const unavailable = () =>
						runnerFailure(
							"get control command status",
							"The original runner command state is unavailable",
						);
					if (!entry) return yield* Effect.fail(unavailable());
					const pid = entry.pid ?? entry.child?.pid;
					if (pid !== undefined && !stops.pidAlive(pid, entry)) return "gone";
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
					const current = stops.currentEntry(sessionId);
					if (current && current.runnerId !== control.providerProcessId)
						return "gone";
					if (pid !== undefined && !stops.pidAlive(pid, entry)) return "gone";
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
					const entry = stops.currentEntry(sessionId);
					return entry && Entry.canControl(entry.lifecycle)
						? entry.runnerId
						: undefined;
				});
			}
			readonly detachSessionEffect = detachSession;
			readonly recoverEffect = recover(
				undefined,
				Effect.suspend(() => gate.recover()),
			);

			attachSessionsEffect(sessionIds: readonly string[]) {
				const ids = new Set(sessionIds);
				return recover(ids, gate.recover(ids));
			}

			ownsRetirementCleanupEffect(
				sessionId: string,
				runId: string,
			): Effect.Effect<boolean> {
				if (!sql) return Effect.succeed(false);
				return Effect.gen(function* () {
					// Migration 0097: no feeder owns an older build's unstarted claim; recovery settles it.
					const [modern] =
						yield* sql`SELECT 1 FROM provider_runs run JOIN provider_command_outbox command ON command.run_id = run.id AND command.session_id = run.session_id WHERE run.id = ${runId} AND run.session_id = ${sessionId} AND run.joined_into IS NULL AND run.legacy_claim = 0 AND run.status IN ('pending', 'running') AND command.effect_type = 'send_turn' AND command.status = 'running'`;
					if (modern) return true;
					return yield* sql<{
						held: number;
					}>`SELECT EXISTS (SELECT 1 FROM provider_runs requested
					JOIN provider_runs owner ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
					JOIN claude_runner_cursors stop ON stop.session_id = owner.session_id AND stop.retired_at IS NOT NULL
					WHERE requested.session_id = ${sessionId} AND requested.id = ${runId}
					AND owner.runner_id = stop.runner_id
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
							stops.pidAlive(
								identity.pid,
								identity.tag === "Verified" ? identity : undefined,
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
						const process =
							entry?.startTime !== undefined
								? { ...entry, pid: entry.pid ?? entry.child?.pid }
								: record.identity;
						const pid = process.pid;
						const alive = pid !== undefined && stops.pidAlive(pid, process);
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
					const entry = stops.currentEntry(sessionId);
					return (
						entry !== undefined &&
						Entry.countsTowardDemand(entry.lifecycle) &&
						(entry.upgrade.inFlight || entry.upgrade.state?.quiescent !== true)
					);
				});
			}

			getAccountSwitchBlockEffect(sessionId: string, account: Account) {
				return Effect.sync(() => {
					const entry = stops.currentEntry(sessionId);
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
					"sessionId" | "inputId" | "runId" | "account" | "continuation"
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
						runId: input.runId,
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

			readonly executeEffect = gate.submit;
		}
		const runner = new ProcessSessionRunner();

		const sessionRunner: SessionRunner & {
			readonly recoverEffect: Effect.Effect<void, SessionFailure>;
			readonly withTurnEffect: NonNullable<SessionRunner["withTurnEffect"]>;
		} = runner;
		return sessionRunner;
	});
