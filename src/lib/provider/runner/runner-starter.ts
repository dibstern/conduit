import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	Cause,
	Clock,
	Deferred,
	Effect,
	Exit,
	type FiberSet,
	Option,
	PubSub,
	Schedule,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/sql";
import { RunnerWriteOrigin } from "../../contracts/stored-event.js";
import { PersistenceProjectTag } from "../../domain/persistence/Services/persistence-service.js";
import { InputDraftsTag } from "../../domain/project-services/Services/input-drafts.js";
import { PendingInteractionServiceTag } from "../../domain/project-services/Services/pending-interaction-service.js";
import {
	type ProviderRuntimeIngestion,
	ProviderRuntimeIngestionTag,
} from "../../domain/project-services/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { createLogger } from "../../logger.js";
import { makeClaudeEventPersistEffect } from "../../persistence/effect/claude-event-persist-effect.js";
import {
	type CommitAndSignal,
	makeCommitAndSignal,
} from "../../persistence/effect/commit-and-signal.js";
import type { UnboundEventStoreEffect } from "../../persistence/effect/event-store-effect.js";
import {
	EventStoreEffectTag,
	makeEventStoreEffect,
} from "../../persistence/effect/event-store-effect.js";
import {
	type ProjectionRunnerEffect,
	ProjectionRunnerEffectTag,
} from "../../persistence/effect/projection-runner-effect.js";
import type { makeRetireReplacedProcessPrompts } from "../../persistence/effect/retire-pending-prompts.js";
import { isRecord } from "../../utils.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import { STOP_ABORT_WAIT_MS } from "../orchestration-command-contracts.js";
import type { SendToken } from "../run-ledger/run-ledger-model.js";
import type { ProviderNativeSession, TurnResult } from "../types.js";
import type {
	OwnerSend,
	ProcessRunnerDeps,
	ProcessRunnerDriver,
} from "./process-runner-types.js";
import type { RunnerRecord } from "./runner-authority.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	isLegacyRunner,
	legacyRunnerBindings,
	legacyRunnerRetainedSends,
	legacyRunnerRunPredicate,
} from "./runner-legacy-classification.js";
import {
	recoverLegacyRunnerCommands,
	replayLegacyRunnerSend,
} from "./runner-legacy-recovery.js";
import {
	currentSendToken,
	type RunnerHello,
	type RunnerSendAnswer,
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
	runnerSinkId,
	sendToken,
} from "./runner-protocol.js";
import {
	currentRunnerOutput,
	type makeRunnerReceiptStore,
} from "./runner-receipts.js";
import {
	currentPendingSendOwner,
	runnerCommandEnded,
	runningRunnerCommands,
} from "./runner-recovery.js";
import {
	discoverAllRunners,
	prepareRunnerDirectory,
	runnerDirectory,
	runnerPidMatchesRegistration,
} from "./runner-registry.js";
import type { makeRunnerRetirement } from "./runner-retirement.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import type { makeRunnerSends, SendBinding } from "./runner-sends.js";
import { makeRunnerUpgrade } from "./runner-upgrade.js";
import type { SendScope } from "./send-scope.js";
import {
	type HeldSendRef,
	retrySettlementWrite,
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
	SessionFailure,
	SessionOutput,
	SessionOutputReply,
} from "./session-runner.js";

/** The runner's log, shared with Dispatch so the component name has one owner. */
export const log = createLogger("process-session-runner");
export const CANCELLED_TURN: TurnResult = {
	status: "cancelled",
	cost: 0,
	tokens: { input: 0, output: 0 },
	durationMs: 0,
	providerStateUpdates: [],
};

interface RunnerStarterOptions {
	readonly deps: ProcessRunnerDeps;
	readonly driver: ProcessRunnerDriver;
	readonly runFork: Effect.Success<
		ReturnType<typeof FiberSet.makeRuntime<never, void, never>>
	>;
	readonly configDir: string;
	readonly lock: Semaphore.Semaphore;
	readonly sql: SqlClient.SqlClient | undefined;
	readonly projection: Option.Option<ProjectionRunnerEffect>;
	readonly receipts:
		| Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>
		| undefined;
	readonly legacyRetirePrompts:
		| Effect.Success<typeof makeRetireReplacedProcessPrompts>
		| undefined;
	readonly sends: ReturnType<typeof makeRunnerSends>;
	readonly stops: Pick<
		Effect.Success<ReturnType<typeof makeRunnerRetirement>>,
		| "adopt"
		| "adoptEntry"
		| "attach"
		| "awaitStop"
		| "closing"
		| "currentEntry"
		| "detach"
		| "grantOf"
		| "guarded"
		| "identityFor"
		| "inRecovery"
		| "observe"
		| "pidAlive"
		| "processTable"
		| "records"
		| "recover"
		| "recovering"
		| "register"
		| "release"
		| "requestStop"
		| "retirementFor"
		| "retirementForIdentity"
		| "state"
		| "stopRunner"
	>;
	readonly emit: (
		output: SessionOutput,
		sessionId?: string,
	) => Effect.Effect<SessionOutputReply, SessionFailure>;
	readonly failBoundSend: (
		sinkId: string,
		binding: SendBinding,
		entry: RunnerChild,
		failure: SessionFailure,
	) => Effect.Effect<void, SessionFailure>;
	readonly ingestionForSession: (
		sessionId: string,
	) => Effect.Effect<ProviderRuntimeIngestion | undefined>;
	readonly wakeReactor: (sessionId: string) => Effect.Effect<void>;
	/** The session's projecting write, so the arm folds a runner's start in it (D58). */
	readonly sessionCommit: (sessionId: string) => Effect.Effect<
		{
			readonly commit: Pick<CommitAndSignal, "write">;
			readonly store: Pick<UnboundEventStoreEffect, "appendBatch">;
		},
		SessionFailure
	>;
}

/**
 * Which outbox command issued each token, found by composing every token main
 * issued for the session's sends (4.11). A token is never parsed.
 */
const issuedSendTokens = (
	sql: SqlClient.SqlClient | undefined,
	sessionId: string,
	tokens: readonly SendToken[],
) =>
	Effect.gen(function* () {
		const issued = new Map<
			SendToken,
			| {
					readonly commandId: string;
					readonly attempt: number;
					readonly fallback: boolean;
					readonly runId: string | null;
			  }
			| undefined
		>(tokens.map((token) => [token, undefined]));
		if (!sql || !tokens.length) return issued;
		const rows = yield* sql<{
			command_id: string;
			attempt_count: number;
			fallback: number | null;
			run_id: string | null;
			transmissions: string;
		}>`SELECT command.command_id, command.attempt_count,
			json_extract(command.payload_json, '$.nativeResumeFallback') AS fallback,
			COALESCE(run.joined_into, run.id) AS run_id,
			(SELECT json_group_array(json_extract(dispatched.data, '$.transmission')) FROM events dispatched
				WHERE dispatched.session_id = command.session_id AND dispatched.type = 'run.dispatched' AND json_valid(dispatched.data)
				AND json_extract(dispatched.data, '$.commandId') = command.command_id) AS transmissions
			FROM provider_command_outbox command
			LEFT JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
			WHERE command.session_id = ${sessionId} AND command.effect_type = 'send_turn'`;
		for (const row of rows) {
			const transmissions: unknown = JSON.parse(row.transmissions);
			const candidates = [
				...(Array.isArray(transmissions) ? transmissions : []).flatMap((n) =>
					typeof n === "number" ? [sendToken("hold", row.command_id, n)] : [],
				),
				...Array.from({ length: row.attempt_count + 1 }, (_, n) =>
					sendToken("tx", row.command_id, n),
				),
			];
			for (const token of candidates)
				if (issued.has(token))
					issued.set(token, {
						commandId: row.command_id,
						attempt: row.attempt_count,
						fallback: row.fallback === 1,
						runId: row.run_id,
					});
		}
		return issued;
	}).pipe(
		Effect.mapError((cause) =>
			runnerFailure("resolve runner send tokens", cause),
		),
	);

export const makeRunnerStarter = (options: RunnerStarterOptions) =>
	Effect.gen(function* () {
		const {
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
		} = options;
		const clock = yield* Clock.Clock;
		const instanceScope = yield* Effect.scope;
		// The entry scope's send finalizer (6.11). A run its runner still holds
		// keeps its send until its release requeues it or Settle ends it (G6).
		// A joined steer's hold is its own run's while its owner's Run is open (CONTRACT 2021-2025).
		const closeSends = (runnerId: string) =>
			sql
				? sql<{
						id: string;
					}>`SELECT run.id FROM provider_runs run JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id WHERE run.runner_id = ${runnerId} AND run.held_transmission IS NOT NULL AND owner.status IN ('pending', 'running')`.pipe(
						Effect.flatMap((held) =>
							sends.closeRunner(
								runnerId,
								held.map(({ id }) => id),
							),
						),
						Effect.catchCause((cause) =>
							Effect.logError("Runner send close failed", cause),
						),
					)
				: sends.closeRunner(runnerId);
		const runnerLabel = `${driver.driverKind.charAt(0).toUpperCase()}${driver.driverKind.slice(1)} runner`;
		// 6.1: a serving runner's start (row 215). A draft pre-warm's session is not stored at its
		// hello, so its start waits, `unreported`, for its first send, ahead of that send's frames.
		const reportStart = (entry: RunnerChild, unreported: boolean) =>
			Effect.gen(function* () {
				if (!receipts) return;
				const started = receipts.processStarted(
					entry.runnerId,
					entry.querySeq ?? 0,
					entry.recoveringCommands === true,
					unreported,
				);
				if ((yield* started).length === 0) return;
				const { commit, store } = yield* sessionCommit(entry.sessionId);
				yield* commit.write((project) =>
					started.pipe(
						Effect.flatMap((events) =>
							events.length === 0
								? Effect.void
								: store.appendBatch(events).pipe(Effect.flatMap(project)),
						),
					),
				);
			});
		const startupTimeoutMs =
			process.env["NODE_ENV"] === "test"
				? Number(
						process.env["CONDUIT_TEST_RUNNER_STARTUP_TIMEOUT_MS"] ?? 10_000,
					)
				: 10_000;
		const attachedEntries = () =>
			[...stops.records.values()].flatMap((record) =>
				record.identity.entry && record.tag._tag !== "Retired"
					? [record.identity.entry]
					: [],
			);
		const retireRecord = (
			record: RunnerRecord<RunnerChild>,
			cause: SessionFailure,
		): Effect.Effect<void, SessionFailure> =>
			Effect.gen(function* () {
				const entry = record.identity.entry;
				const alreadyRetired = record.tag._tag === "Retired";
				// The commit closes the entry scope, which fails ready with this cause.
				if (entry) Entry.transition(entry, { _tag: "Fail", failure: cause });
				yield* stops.requestStop(
					entry
						? stops.retirementFor(entry)
						: stops.retirementForIdentity(record.identity),
				);
				if (!alreadyRetired)
					log.warn(
						`Retired surviving runner ${record.identity.runnerId}: ${cause.message}`,
					);
				if (entry) Entry.transition(entry, { _tag: "Recovered" });
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
							Entry.detach(entry, detached);
							stops.detach(entry.runnerId);
							// CONTRACT 6.11 names no detach closer; a project letting go of
							// its runner is that runner's shutdown for this daemon (gap G3).
							yield* Entry.close(entry, Cause.fail(detached));
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
				const entry = stops.currentEntry(sessionId);
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
		const turnEnds = yield* PubSub.unbounded<string>();
		const activeEntries = () =>
			[...stops.records.values()].flatMap((record) => {
				const entry = record.identity.entry;
				return entry && stops.currentEntry(entry.sessionId) === entry
					? [entry]
					: [];
			});
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
		const acknowledgeSends = (
			sessionId: string,
			entry: RunnerChild,
			connection: RunnerSocket,
		) =>
			Effect.gen(function* () {
				const pending = [...sends.pendingOn(entry)];
				const commandIds = pending.flatMap(([, commandId]) =>
					commandId ? [commandId] : [],
				);
				if (!sql || !commandIds.length) return;
				const rows = yield* sql<{
					command_id: string;
				}>`SELECT command_id FROM provider_command_outbox
				WHERE session_id = ${sessionId} AND effect_type = 'send_turn'
					AND status IN ('completed', 'failed') AND command_id IN ${sql.in(commandIds)}`;
				const settled = new Set(rows.map((row) => row.command_id));
				const tokens = pending.flatMap(([token, commandId]) =>
					commandId && settled.has(commandId) ? [token] : [],
				);
				if (
					stops.closing ||
					entry.connection !== connection ||
					connection.closed
				)
					return;
				if (tokens.length)
					yield* lock.withPermits(1)(
						Effect.sync(() => {
							Entry.touch(entry);
							connection.write({ type: "settled-commands", tokens });
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
			phase: "after-prepare" | "after-commit" | "before-activate",
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
		const retireOrphan = (
			entry: RunnerChild,
		): Effect.Effect<void, SessionFailure> =>
			Effect.gen(function* () {
				const ownsEntry = entry.lifecycle.candidate
					? tracked(entry)
					: stops.currentEntry(entry.sessionId) === entry;
				if (stops.closing || !ownsEntry) return;
				// An orphan's session is gone or already served. EndSession is not
				// role-gated, so the commit stops whatever row it reads.
				yield* stops
					.stopRunner(entry, undefined, "stop", {
						_tag: "EndSession",
						orphan: true,
					})
					// A rejected stop never reaches its post-commit closer (gap G5).
					.pipe(Effect.onError((cause) => Entry.close(entry, cause)));
			});

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
				const recoveredSendRefs = new Map<SendToken, HeldSendRef>();
				const legacySendKeys = new Map<SendToken, LegacySendKey>();
				// Hello bindings name tokens; the commands come from main's own rows.
				let recoveryBindings: readonly (NonNullable<
					RunnerHello["bindings"]
				>[number] & { readonly commandId?: string })[] = [];
				const settleRecoveredSends = (
					answers: readonly (RunnerSendAnswer & {
						readonly nativeResumeFallback?: boolean;
					})[],
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
													const token = currentSendToken(row);
													const legacy = legacySendKeys.get(token);
													const [modern] = legacy
														? []
														: yield* sql`SELECT 1 FROM provider_runs run
															WHERE run.id = ${row.run_id} AND run.session_id = ${sessionId} AND run.joined_into IS NULL
															AND NOT ${legacyRunnerRunPredicate(sql, sessionId, sql`run.id`)}`;
													const answer = answers.find(
														(answer) => answer.token === token,
													);
													if (answer?.status === "running") continue;
													const completed =
														answer?.status === "finished" ? answer : undefined;
													if (completed) {
														// Modern resume refusals continue only after their C3 release.
														// The transmission's mode, not the payload's marker: a fresh
														// fallback's rejection is terminal (4.8).
														if (
															modern &&
															completed.fresh !== true &&
															(completed.result?.nativeResumeRejected ||
																isClaudeResumeRefused(
																	completed.failure ?? completed.result?.error,
																))
														)
															continue;
														if (modern) {
															const send = recoveredSendRefs.get(
																completed.token,
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
																			completed.nativeResumeFallback ??
																			completed.fresh === true,
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
									retain: (token, commandId) =>
										sends.retain(entry, token, commandId),
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
															runId: input.runId,
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
																				token: currentSendToken(row),
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
											liveSession: nativeSession(sessionId),
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
												stops.currentEntry(sessionId) !== entry ||
												entry.connection !== connection ||
												connection.closed,
											send: (token, command) => {
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
															token,
															command,
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
										if (key) legacySendKeys.set(answer.token, key);
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
										stops.currentEntry(sessionId) !== entry ||
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
					...(entry.startTime !== undefined
						? {
								start: {
									startTime: entry.startTime,
									...(entry.startKey === undefined
										? {}
										: { startKey: entry.startKey }),
								},
							}
						: {}),
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
									undefined,
									true,
								);
								for (const row of rows) {
									const key = yield* LegacySendKey.prove(sql, row);
									if (key) legacySendKeys.set(currentSendToken(row), key);
								}
							}
							// A main-built runner's replay settles its held sends too (C 7.4). A joined
							// steer's hold is its own run's while its owner's Run is open (CONTRACT 2021-2025).
							if (sql && !identityOnly) {
								const held = yield* sql<{
									run_id: string;
									command_id: string;
									request_sequence: number;
									attempt_count: number;
									transmission: number;
								}>`SELECT run.id AS run_id, command.command_id, command.request_sequence,
									command.attempt_count, run.held_transmission AS transmission
									FROM provider_runs run JOIN provider_command_outbox command
									ON command.run_id = run.id AND command.session_id = run.session_id
									JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id
									WHERE run.session_id = ${sessionId} AND run.runner_id = ${entry.runnerId}
									AND run.held_transmission IS NOT NULL AND owner.status IN ('pending', 'running')
									AND command.effect_type = 'send_turn'`;
								for (const row of held)
									recoveredSendRefs.set(
										sendToken("hold", row.command_id, row.transmission),
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
							const bindings = isLegacyRunner(hello)
								? legacyRunnerBindings(hello)
								: (hello.bindings ?? []);
							const issued = yield* issuedSendTokens(sql, sessionId, [
								...new Set([
									...(hello.sendTokens ?? []),
									...bindings.flatMap((binding) =>
										binding.token ? [binding.token] : [],
									),
								]),
							]);
							recoveryBindings = bindings.map((binding) => {
								const command = binding.token
									? issued.get(binding.token)
									: undefined;
								return command
									? { ...binding, commandId: command.commandId }
									: binding;
							});
							if (!isLegacyRunner(hello)) {
								// The journal owns classification. A retained call needs an admission
								// even when it has not emitted an output binding yet.
								for (const answer of hello.sendAnswers ?? []) {
									const command = issued.get(answer.token);
									if (
										answer.status !== "running" ||
										!command ||
										recoveryBindings.some(
											(binding) =>
												binding.token === answer.token &&
												binding.released !== true,
										)
									)
										continue;
									recoveryBindings = [
										...recoveryBindings,
										{
											sessionId,
											commandId: command.commandId,
											token: answer.token,
											released: false,
											sinkId: runnerSinkId(
												command.commandId,
												command.attempt,
												command.fallback,
											),
										},
									];
								}
							}
							const ownsEntry = () =>
								(entry.lifecycle.candidate
									? tracked(entry)
									: stops.currentEntry(sessionId) === entry) &&
								Entry.canControl(entry.lifecycle) &&
								!stops.closing;
							Entry.connect(entry, {
								hello,
								connection,
								attachmentId: (yield* currentRunnerOutput)?.attachmentId,
								start: (pid) => {
									const seen = stops.processTable.identify([pid]).get(pid);
									return seen && "startTime" in seen ? seen : undefined;
								},
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
							// 6.1: a serving runner's live adoption reports its start before the
							// hello's acks and replays reach the ledger; a recovered one reattached.
							if (!identityOnly && !entry.lifecycle.candidate)
								yield* reportStart(entry, false);
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
								new Map(
									legacyRunnerRetainedSends(hello).map((token) => [
										token,
										issued.get(token)?.commandId,
									]),
								),
							);
							if (sql && !isLegacyRunner(hello)) {
								// From 32.5 a joined steer's held transmission is released under its own run
								// id while its owner's Run is open, and the feeder re-holds it (CONTRACT 1868-1869).
								const held = yield* sql<{
									run_id: string;
									command_id: string;
									transmission: number;
								}>`SELECT run.id AS run_id, command.command_id, run.held_transmission AS transmission FROM provider_runs run JOIN provider_command_outbox command ON command.run_id = run.id AND command.session_id = run.session_id
									JOIN provider_runs owner ON owner.id = COALESCE(run.joined_into, run.id) AND owner.session_id = run.session_id
									WHERE run.session_id = ${sessionId} AND run.runner_id = ${entry.runnerId} AND run.held_transmission IS NOT NULL AND owner.status IN ('pending', 'running') AND command.effect_type = 'send_turn'`;
								for (const transmission of held) {
									const token = sendToken(
										"hold",
										transmission.command_id,
										transmission.transmission,
									);
									const answer = hello.sendAnswers?.find(
										(answer) => answer.token === token,
									);
									// A fresh fallback's rejection is terminal (4.8), never re-released.
									if (
										answer?.status === "finished" &&
										answer.fresh !== true &&
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
									const status = yield* connection.commandStatusEffect(token);
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
										command_id: string;
										held_transmission: number | null;
									}>`SELECT outbox.request_sequence, outbox.provider_id, outbox.command_id, reservation.held_transmission, COALESCE(json_extract(outbox.payload_json, '$.inputId'), json_extract(outbox.payload_json, '$.userMessageId'), json_extract(outbox.payload_json, '$.commandId'), json_extract(outbox.payload_json, '$.turnId')) AS input_id,
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
											const token = currentSendToken(row);
											const answer = hello.sendAnswers?.find(
												(answer) => answer.token === token,
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
											if (binding.token !== token) continue;
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
																...(runId ? { runIds: [runId] } : {}),
																unrecorded: true,
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
							if (!recoveredHello || isLegacyRunner(recoveredHello)) return;
							// A send's frame id is its token.
							const held = recoveredHello.sendAnswers?.find(
								(answer) =>
									answer.status === "running" &&
									answer.token === reply.commandId,
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
					onCommandsSettled: (tokens) => {
						runFork(
							entry.outputs
								.withPermits(1)(
									Effect.gen(function* () {
										for (const token of tokens) {
											if (!sends.isPending(entry, token)) continue;
											yield* stops.guarded(
												stops.grantOf(outputAuthority),
												{ kind: "output" },
												() => sends.settled(entry, [token]),
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
							stops.currentEntry(sessionId) === entry &&
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
								start: (pid) => {
									const seen = stops.processTable.identify([pid]).get(pid);
									return seen && "startTime" in seen ? seen : undefined;
								},
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
						Entry.detach(entry);
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
					...(yield* Entry.open(instanceScope)),
					upgrade: { activity: 0, inFlight: false, failures: 0, retryAt: 0 },
					outputs: yield* Semaphore.make(1),
					socketPath: join(
						runnerDirectory(registrationRoot, configDir),
						runnerId,
					),
				} satisfies RunnerChild;
				yield* Entry.own(entry, closeSends);
				yield* stops.adoptEntry(entry, "starting");
				return entry;
			});
		const eligible = (sessionId: string, entry: RunnerChild) =>
			!stops.closing &&
			!stops.inRecovery &&
			stops.currentEntry(sessionId) === entry &&
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
						const promoted = yield* lock.withPermits(1)(
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
									successorQuerySeq: replacement.querySeq ?? 0,
								});
								committed = true;
								yield* pauseSwap("after-commit", sessionId, old, replacement);
								// Promote's memory part: R's grant live and the session routed to R
								// before any dispatch takes the lock (6.9).
								Entry.transition(replacement, { _tag: "Promote" });
								Entry.touch(replacement);
								yield* stops.adoptEntry(replacement, "live");
								yield* observeProcess(sessionId, replacement).pipe(
									Effect.catchCause((cause) =>
										Effect.logWarning(
											"Upgraded runner prompt observation deferred",
											cause,
										),
									),
								);
								return true;
							}),
						);
						if (!promoted) return false;
						// After the release (6.9): a send may reach R first, and any command
						// but a shutdown activates a Candidate host.
						yield* pauseSwap("before-activate", sessionId, old, replacement);
						replacement.connection?.write({ type: "upgrade-activate" });
						upgradeMark(sessionId, old, "switched", replacement);
						return true;
					}).pipe(
						// The promote closes old's entry scope as any stop's post-commit
						// step does, after upgrade-activate and the switched mark (6.9).
						Effect.ensuring(
							Effect.suspend(() =>
								committed
									? Entry.close(old)
									: stops.closing
										? Effect.void
										: cancel,
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
		/** Whole-manager recovery holds upgrades back through Retirement's window; owner sends recover inside it. */
		const recover = (
			sessionIds: ReadonlySet<string> | undefined,
			ownerSends: Effect.Effect<void, SessionFailure>,
		) =>
			Effect.gen(function* () {
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
							stops.processTable,
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
									? {
											startTime: row.identity.startTime,
											...(row.identity.startKey === undefined
												? {}
												: { startKey: row.identity.startKey }),
										}
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
						// Only durable serving rows restore process authority. Other hosts
						// get a Starting grant solely to verify hello and retire the host.
						const active = yield* stops
							.adopt(
								identities.filter(
									(identity) => !unregistered.has(identity.runnerId),
								),
							)
							.pipe(
								Effect.mapError((cause) =>
									runnerFailure("recover runner authority", cause),
								),
							);
						// Recover, and so queue upgrades, in the sidebar's shape: pinned, then
						// most recent activity, with settled and snoozed sessions last.
						const ranked =
							sql && registrations.length > 0
								? yield* sql<{ id: string }>`SELECT s.id FROM sessions s
										LEFT JOIN sessions r ON r.id = COALESCE(s.root_id, s.id)
										WHERE s.id IN ${sql.in(registrations.map((r) => r.sessionId))}
										ORDER BY r.pinned_at IS NULL, r.pinned_at,
											r.settled_at IS NOT NULL OR (r.snoozed_at IS NOT NULL
												AND (r.snoozed_until IS NULL OR r.snoozed_until > ${Date.now()})),
											r.updated_at DESC`.pipe(
										Effect.catch(() => Effect.succeed([])),
									)
								: [];
						const rank = new Map(ranked.map((row, index) => [row.id, index]));
						const byRank = (sessionId: string) =>
							rank.get(sessionId) ?? Number.MAX_SAFE_INTEGER;
						for (const registration of [...registrations].sort(
							(a, b) => byRank(a.sessionId) - byRank(b.sessionId),
						)) {
							const missingCursor = unregistered.has(registration.runnerId);
							if (!missingCursor && !active.has(registration.runnerId))
								continue;
							if (
								sessionIds &&
								(!sessionIds.has(registration.sessionId) ||
									(stops.currentEntry(registration.sessionId)?.runnerId ===
										registration.runnerId &&
										!Entry.isAwaitingProject(
											stops.currentEntry(registration.sessionId)?.lifecycle,
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
									stops.currentEntry(registration.sessionId)?.lifecycle,
								) &&
								recovery
							)
								yield* detachSession(registration.sessionId);
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
								Boolean(stops.currentEntry(registration.sessionId));
							const entry: RunnerChild = {
								...registration,
								recoveringCommands: !abandoned,
								ownsPendingSend,
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
								...(yield* Entry.open(instanceScope)),
							};
							yield* Entry.own(entry, closeSends);
							yield* lock.withPermits(1)(
								Effect.gen(function* () {
									if (stops.closing)
										return yield* Effect.fail(
											runnerFailure(
												"recover runner",
												"Runners are shutting down",
											),
										);
									abandoned ||= Boolean(
										stops.currentEntry(registration.sessionId),
									);
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
									: stops.currentEntry(registration.sessionId) === entry)
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
										// A rejected stop never reaches its post-commit closer (gap G5).
										Effect.catchCause((cause) =>
											Entry.close(entry, cause).pipe(
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
									stops.pidAlive(registration.pid, registration) &&
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
									runnerPidMatchesRegistration(registration, stops.processTable)
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
											if (stops.pidAlive(registration.pid, registration))
												return yield* retireSurvivor(entry, failure);
											Entry.transition(entry, { _tag: "Recovered" });
											Entry.transition(entry, { _tag: "Fail", failure });
											yield* stops.stopRunner(entry);
										}),
									);
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
									if (!stops.pidAlive(registration.pid, registration)) {
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
											stops.stopRunner(entry, undefined, "failure"),
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
									// The orphan stop's commit closes the entry scope; shutdown closes it otherwise.
									stopUnawaited(retireOrphan(entry));
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
									// Interruption is no stop reason (6.3) and reaches no
									// post-commit closer, but its waiters must settle (gap G5).
									if (Failure.isInterruptedOnly(exit.cause))
										return Entry.close(entry, exit.cause);
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
										stopUnawaited(stops.stopRunner(entry));
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
					}).pipe(Effect.tap(() => ownerSends)),
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
		const startStored = (input: OwnerSend) =>
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
				if (!isRecord(payload) || typeof payload["workspaceRoot"] !== "string")
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
				// A spawn its project's removal cut short is not sent, so its next try
				// meets the project gate (CONTRACT.md 1083-1085).
				Effect.catch((cause) =>
					deps.projectRootForSession(input.sessionId).pipe(
						Effect.flatMap((root) =>
							Effect.fail({
								...runnerFailure("start runner", cause),
								...(!root
									? { code: "not_sent", retryable: true }
									: toStoreFault(cause)._tag === "StoreUnavailable"
										? { retryable: true }
										: {}),
							}),
						),
					),
				),
			);
		return {
			start,
			createEntry,
			upgrade,
			recover,
			startStored,
			turnEnds: Effect.map(PubSub.subscribe(turnEnds), Stream.fromSubscription),
			retireSurvivor,
			reportStart,
			detachSession,
			nativeSession,
		};
	});
