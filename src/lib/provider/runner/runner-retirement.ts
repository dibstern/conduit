import { dirname, join } from "node:path";
import * as SqliteNode from "@effect/sql-sqlite-node/SqliteClient";
import {
	Cause,
	Clock,
	Context,
	Data,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	Layer,
	Option,
	PubSub,
	Scheduler,
	Schema,
	type Semaphore,
} from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import type { ProviderRuntimeIngestion } from "../../domain/relay/Services/provider-runtime-ingestion-service.js";
import * as Failure from "../../effect/failure-classification.js";
import { createLogger } from "../../logger.js";
import type {
	CommitAndSignal,
	CommitAndSignalFailure,
} from "../../persistence/effect/commit-and-signal.js";
import type { UnboundEventStoreEffect } from "../../persistence/effect/event-store-effect.js";
import { PersistenceStore } from "../../persistence/effect/live.js";
import { makeEffectSqlMigrator } from "../../persistence/effect/migrations.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../persistence/events.js";
import { isRecord } from "../../utils.js";
import { isClaudeResumeRefused } from "../event-sink-errors.js";
import {
	runSendCommandIdQuery,
	settleToolChildRuns,
	stopCovers,
} from "../session-run-settlement.js";
import type {
	Held,
	Hold,
	OwnerSend,
	RunRelease,
} from "./process-runner-types.js";
import {
	type Grant,
	makeRunnerAuthority,
	type RunnerIdentity,
} from "./runner-authority.js";
import { connectRunner } from "./runner-connection.js";
import type { RunnerChild } from "./runner-entry-lifecycle.js";
import * as Entry from "./runner-entry-lifecycle.js";
import {
	journalsBeforeExecution,
	legacyRunnerRunPredicate,
} from "./runner-legacy-classification.js";
import {
	type RunnerSocket,
	runnerBuildId,
	runnerFailure,
} from "./runner-protocol.js";
import {
	makeRunnerReceiptStore,
	mergeRunnerMembers,
	type RunnerCursorIdentity,
	type RunnerMember,
	type RunnerRetirement,
	RunnerRetirementDecodeError,
	type RunnerRow,
	type RunnerSignal,
	type RunnerSignalAttempt,
	RunnerSlotError,
	type StopCommit,
	type StopReason,
	type StopTarget,
	stopRecord,
} from "./runner-receipts.js";
import {
	discoverRunners,
	type RunnerProcessTable,
	readRunnerEvidence,
	removeRunnerDiscovery,
	runnerDirectory,
	runnerPidMatchesRegistration,
	runnerProcessTable,
} from "./runner-registry.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import { readRunnerSendJournal } from "./runner-send-journal.js";
import {
	type HeldSendRef,
	retrySettlementWrite,
	type SendEvidence,
	type SettlementTx,
	type StoreFault,
	sendRetryBackoff,
	terminalTurnResult,
	toStoreFault,
} from "./send-settlement.js";
import { settleSend } from "./send-settlement-outbox.js";
import type { SessionFailure } from "./session-runner.js";

const log = createLogger("runner-retirement");

const stopWindowEnd = (record: {
	readonly retiredAt: number;
	readonly stopStartedAt?: number | null;
}) => (record.stopStartedAt ?? record.retiredAt) + 4_000;

/** Owns the hold and release writes; the generic commit seam knows no runner state. */
export const makeRunnerRunLifecycle = (
	options: Omit<SettlementTx, "project" | "stamp" | "afterCommit"> & {
		readonly commit: CommitAndSignal;
		readonly eventStore: Pick<UnboundEventStoreEffect, "appendBatch">;
		readonly wakeReactor?: Effect.Effect<void>;
		/** Retirement's current holds; the hold and the release write them. */
		readonly holds?: {
			readonly held: (
				run: {
					readonly sessionId: string;
					readonly runId: string;
					readonly commandId: string;
				},
				runner: string,
				transmission: number,
			) => () => void;
			readonly released: (input: RunRelease) => Effect.Effect<void>;
		};
	},
) => {
	const { sql, commit, eventStore } = options;
	return {
		holdRun: (input: {
			readonly sessionId: string;
			readonly runId: string;
			readonly commandId: string;
			readonly observedAt?: number;
		}): Effect.Effect<Hold, StoreFault> => {
			const followUps: Effect.Effect<void>[] = [];
			let unhold: (() => void) | undefined;
			return commit
				.write<Hold, CommitAndSignalFailure | StoreFault, never>(
					(project, stamp) =>
						Effect.gen(function* () {
							followUps.length = 0;
							const observedAt =
								input.observedAt ?? (yield* Clock.currentTimeMillis);
							const [owner] = yield* sql<{
								id: string;
								provider: string;
								status: string;
								runner_id: string | null;
							}>`SELECT owner.id, session.provider, owner.status, owner.runner_id
						FROM provider_runs requested JOIN provider_runs owner
							ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
						JOIN sessions session ON session.id = requested.session_id
						WHERE requested.id = ${input.runId} AND requested.session_id = ${input.sessionId}`;
							if (
								!owner ||
								(owner.status !== "pending" && owner.status !== "running")
							)
								return { _tag: "Ended" };
							const commandId = yield* runSendCommandIdQuery(
								sql,
								input.sessionId,
								owner.id,
							);
							if (commandId === undefined || commandId !== input.commandId)
								return { _tag: "Ended" };
							const [command] = yield* sql<{
								request_sequence: number;
								attempt_count: number;
							}>`SELECT request_sequence, attempt_count FROM provider_command_outbox
						WHERE session_id = ${input.sessionId} AND command_id = ${commandId}
							AND run_id = ${owner.id} AND effect_type = 'send_turn' AND status = 'running'
						ORDER BY request_sequence DESC LIMIT 1`;
							if (!command) return { _tag: "Ended" };
							const send = {
								sessionId: input.sessionId,
								runId: owner.id,
								commandId,
								requestSequence: command.request_sequence,
								attempt: command.attempt_count,
							};
							const tx: SettlementTx = {
								...options,
								project,
								stamp,
								afterCommit: (effect) => followUps.push(effect),
							};
							if (yield* stopCovers(sql, input.sessionId, owner.id)) {
								if (owner.runner_id === null)
									yield* settleSend(tx, { _tag: "covered", send, observedAt });
								return { _tag: "Covered" };
							}
							if (owner.runner_id !== null) return { _tag: "Busy" };
							const [count] = yield* sql<{
								n: number;
							}>`SELECT COUNT(*) AS n FROM events
						WHERE session_id = ${input.sessionId} AND type = 'run.dispatched'
							AND json_valid(data) AND json_extract(data, '$.commandId') = ${commandId}`;
							const transmission = (count?.n ?? 0) + 1;
							if (transmission > 5) {
								yield* settleSend(tx, {
									_tag: "failed",
									send,
									observedAt,
									failure: {
										operation: "holdRun",
										message: "Provider send attempts exhausted",
										code: "provider_send_attempts_exhausted",
									},
								});
								return { _tag: "Exhausted" };
							}
							const [serving] = yield* sql<{
								runner_id: string;
							}>`SELECT runner_id FROM claude_runner_cursors
						WHERE session_id = ${input.sessionId} AND retired_at IS NULL AND role = 'serving'`;
							// A steer redirects the Run on the runner it was sent to. With that
							// runner gone the Run has ended, so the steer fails and returns to
							// the inbox (CONTRACT 4.8) instead of starting a fresh turn on
							// another runner, as main fails it when the runner exits.
							const [steer] = yield* sql<{
								moved: number;
							}>`SELECT EXISTS (SELECT 1 FROM events
						WHERE session_id = ${input.sessionId} AND type = 'run.dispatched' AND json_valid(data)
							AND json_extract(data, '$.commandId') = ${commandId}
							AND json_extract(data, '$.runnerId') IS NOT ${serving?.runner_id ?? null}) AS moved
						FROM pending_inputs WHERE session_id = ${input.sessionId} AND input_id = ${commandId} AND state = 'steering'`;
							if (steer && (!serving || steer.moved === 1)) {
								yield* settleSend(tx, {
									_tag: "failed",
									send,
									observedAt,
									failure: {
										operation: "send-turn",
										message: "Runner exited",
										code: "runner_stopped",
									},
								});
								return { _tag: "Ended" };
							}
							if (!serving) {
								const [candidate] = yield* sql<{
									runner_id: string;
								}>`SELECT runner_id FROM claude_runner_cursors
							WHERE session_id = ${input.sessionId} AND retired_at IS NULL AND role = 'candidate' ORDER BY rowid LIMIT 1`;
								if (candidate)
									return { _tag: "Cleaning", runner: candidate.runner_id };
								const predecessors = yield* sql<{
									runner: string;
									retiredAt: number;
									stopStartedAt: number | null;
								}>`SELECT runner_id AS runner, retired_at AS retiredAt, stop_started_at AS stopStartedAt FROM claude_runner_cursors
							WHERE session_id = ${input.sessionId} AND retired_at IS NOT NULL
								AND stop_state NOT IN ('Gone', 'Settled') AND retirement_state = 'Watching'
							ORDER BY COALESCE(stop_started_at, retired_at) DESC, rowid`;
								const predecessor = predecessors
									.map((row) => ({
										runner: row.runner,
										until: stopWindowEnd(row),
									}))
									.find((row) => row.until > observedAt);
								return {
									_tag: "Unserved",
									predecessor: Option.fromUndefinedOr(predecessor),
								};
							}
							yield* project(
								yield* eventStore.appendBatch([
									canonicalEvent(
										"run.dispatched",
										input.sessionId,
										{
											runId: owner.id,
											runnerId: serving.runner_id,
											commandId,
											transmission,
										},
										{ provider: owner.provider, metadata: { runId: owner.id } },
									),
								]),
							);
							// Inside the commit permit: a release of this transmission commits
							// only after this one, so its delete always finds the entry. A
							// rollback after this point undoes the set below.
							unhold = options.holds?.held(
								input,
								serving.runner_id,
								transmission,
							);
							return { _tag: "Held", runner: serving.runner_id, transmission };
						}),
					{
						afterCommit: Effect.suspend(() =>
							Effect.forEach(followUps, (effect) => effect, { discard: true }),
						),
					},
				)
				.pipe(
					Effect.onError(() => Effect.sync(() => unhold?.())),
					Effect.tap(() => options.wakeReactor ?? Effect.void),
					Effect.mapError(toStoreFault),
				);
		},
		releaseRun: <A, E, R>(
			input: EventPayloadMap["run.released"] & { readonly sessionId: string },
			/** Receives the serving row this transaction read, never a cached one. */
			stop: (serving: StopTarget) => Effect.Effect<A, E, R>,
			failed?: Extract<SendEvidence, { readonly _tag: "failed" }>,
		) => {
			let released = false;
			const followUps: Effect.Effect<void>[] = [];
			return commit
				.write(
					(project, stamp) =>
						Effect.gen(function* () {
							released = false;
							followUps.length = 0;
							if (failed) {
								const { send } = failed;
								if (
									input.reason !== "NotSent" ||
									send.sessionId !== input.sessionId ||
									send.runId !== input.runId ||
									send.commandId !== input.commandId
								)
									return { released: false, stop: undefined };
								const [current] =
									yield* sql`SELECT 1 FROM provider_command_outbox command
									JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id
									JOIN sessions session ON session.id = command.session_id AND session.project_id = command.project_key
									WHERE command.request_sequence = ${send.requestSequence} AND command.attempt_count = ${send.attempt}
									AND command.session_id = ${send.sessionId} AND command.command_id = ${send.commandId}
									AND command.run_id = ${send.runId} AND command.effect_type = 'send_turn' AND command.status = 'running'
									AND command.request_sequence = (SELECT MAX(latest.request_sequence) FROM provider_command_outbox latest WHERE latest.project_key = command.project_key AND latest.command_id = command.command_id)
									AND run.status IN ('pending', 'running') AND run.joined_into IS NULL
									AND run.runner_id = ${input.runnerId} AND run.held_transmission = ${input.transmission}`;
								if (!current) return { released: false, stop: undefined };
							}
							const [held] = yield* sql<{
								runner_id: string | null;
								held_transmission: number | null;
							}>`SELECT runner_id, held_transmission FROM provider_runs
					WHERE id = ${input.runId} AND session_id = ${input.sessionId}`;
							released =
								held?.runner_id === input.runnerId &&
								held.held_transmission === input.transmission;
							const [session] = yield* sql<{
								provider: string;
							}>`SELECT provider FROM sessions WHERE id = ${input.sessionId}`;
							yield* project(
								yield* eventStore.appendBatch([
									canonicalEvent(
										"run.released",
										input.sessionId,
										{
											runId: input.runId,
											runnerId: input.runnerId,
											commandId: input.commandId,
											transmission: input.transmission,
											reason: input.reason,
										},
										{
											provider: session?.provider ?? "conduit",
											metadata: { runId: input.runId },
										},
									),
								]),
							);
							if (!released) return { released, stop: undefined };
							if (failed)
								yield* settleSend(
									{
										...options,
										project,
										stamp,
										afterCommit: (effect) => followUps.push(effect),
									},
									failed,
								);
							const [serving] = yield* sql<{
								runner_id: string;
								session_id: string;
								driver_kind: string;
								pid: number | null;
								start_time: string | null;
								reaper_pid: number | null;
								reaper_start_time: string | null;
							}>`SELECT runner_id, session_id, driver_kind, pid, start_time, reaper_pid, reaper_start_time FROM claude_runner_cursors
					WHERE runner_id = ${input.runnerId} AND session_id = ${input.sessionId} AND role = 'serving' AND retired_at IS NULL`;
							if (!serving) return { released, stop: undefined };
							return {
								released,
								stop: yield* stop({
									runnerId: serving.runner_id,
									sessionId: serving.session_id,
									driverKind: serving.driver_kind,
									identity:
										serving.pid !== null && serving.start_time !== null
											? {
													tag: "Verified",
													pid: serving.pid,
													startTime: serving.start_time,
												}
											: {
													tag: "Unverifiable",
													...(serving.pid === null ? {} : { pid: serving.pid }),
												},
									reaper:
										serving.reaper_pid !== null &&
										serving.reaper_start_time !== null
											? {
													pid: serving.reaper_pid,
													startTime: serving.reaper_start_time,
												}
											: undefined,
									members: [],
								}),
							};
						}),
					{
						afterCommit: Effect.gen(function* () {
							if (released)
								yield* options.holds?.released(input) ?? Effect.void;
							yield* Effect.forEach(followUps, (effect) => effect, {
								discard: true,
							});
						}),
					},
				)
				.pipe(
					Effect.tap(() =>
						failed ? (options.wakeReactor ?? Effect.void) : Effect.void,
					),
					Effect.mapError(toStoreFault),
				);
		},
	};
};

export type RunnerStop =
	| { readonly _tag: "Running" }
	| {
			readonly _tag: "Committing";
			readonly waiters: Deferred.Deferred<
				"Requested" | "Ignored",
				SessionFailure
			>;
	  }
	| { readonly _tag: "Requested"; readonly record: RunnerRetirement }
	| { readonly _tag: "Escalating"; readonly record: RunnerRetirement }
	| { readonly _tag: "Escalated"; readonly record: RunnerRetirement }
	| { readonly _tag: "Gone"; readonly record: RunnerRetirement }
	| { readonly _tag: "Settled"; readonly record: RunnerRetirement };

type StopAction =
	| { readonly _tag: "SendShutdown" }
	| { readonly _tag: "Signal"; readonly signal: "SIGTERM" | "SIGKILL" }
	| { readonly _tag: "Settle" | "Evict" | "Prune" | "Notice" };
type StopObservation = {
	readonly _tag: "Observe";
	readonly now: number;
	readonly processes: RunnerRetirementObservation;
	readonly retry: boolean;
	readonly notice: boolean;
};

const stoppedState = (record: RunnerRetirement): RunnerStop => ({
	_tag:
		record.retirement.tag !== "Watching"
			? "Gone"
			: // Legacy retirement was written after its Stop window. Delete with 32.13.
				record.stopState === "Requested" &&
					record.stopStartedAt === undefined &&
					record.stopReason === "Provider process stopped"
				? "Escalated"
				: (record.stopState ?? "Requested"),
	record,
});

/** The row is the fence; this decision has no process or persistence effects. */
export const decideRunnerStop = (
	state: RunnerStop,
	observation: StopObservation,
): { readonly state: RunnerStop; readonly actions: readonly StopAction[] } => {
	// Committing belongs to the reconciler's commit worker: it never sends
	// shutdown, signals, settles or prunes.
	if (
		state._tag === "Running" ||
		state._tag === "Committing" ||
		state._tag === "Settled"
	)
		return { state, actions: [] };
	const { record } = state;
	if (state._tag === "Gone")
		return {
			state: { _tag: "Settled", record: { ...record, stopState: "Settled" } },
			actions: [{ _tag: "Settle" }, { _tag: "Evict" }, { _tag: "Prune" }],
		};
	const { gone, signals } = decideRunnerKill(
		record,
		observation.processes,
		"SIGKILL",
	);
	const elapsed = observation.now - (record.stopStartedAt ?? record.retiredAt);
	const term = record.signalLog.find(
		(attempt) => attempt.signal === "SIGTERM" && attempt.at !== undefined,
	);
	const kill = record.signalLog.some((attempt) => attempt.signal === "SIGKILL");
	// The bounded Stop waiter can finish while Gone/settlement writes retry.
	// This transition uses the intent's durable timestamp even if a log failed.
	// An unverifiable process is never signalled, so its window just ends (F19).
	if (
		(state._tag === "Escalating" || gone) &&
		elapsed >= 4_000 &&
		(gone || kill || signals.length === 0) &&
		state._tag !== "Escalated"
	)
		return {
			state: {
				_tag: "Escalated",
				record: { ...record, stopState: "Escalated" },
			},
			actions: [],
		};
	if (gone)
		return {
			state: { _tag: "Gone", record: { ...record, stopState: "Gone" } },
			actions: [],
		};
	if (state._tag === "Requested")
		return {
			state: {
				_tag: "Escalating",
				record: {
					...record,
					stopState: "Escalating",
					stopStartedAt: observation.now,
				},
			},
			actions: [{ _tag: "SendShutdown" }],
		};
	if (state._tag === "Escalating") {
		const termElapsed =
			term?.at === undefined ? elapsed : observation.now - term.at;
		if (term && !kill && termElapsed >= 3_000)
			return { state, actions: [{ _tag: "Signal", signal: "SIGKILL" }] };
		if (!term)
			return { state, actions: [{ _tag: "Signal", signal: "SIGTERM" }] };
		if (!kill) return { state, actions: [] };
	}
	return {
		state,
		actions: [
			...(observation.retry
				? [{ _tag: "Signal", signal: "SIGKILL" } as const]
				: []),
			...(observation.notice ? [{ _tag: "Notice" } as const] : []),
		],
	};
};

/** One controller owns both the live Stop window and durable recovery retries. */
export const makeRunnerStopReconciler = (options: {
	readonly receipts:
		| Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>
		| undefined;
	readonly processTable: RunnerProcessTable;
	readonly holdRun?: (
		sessionId: string,
		runId: string,
		commandId: string,
	) => Effect.Effect<Hold, StoreFault>;
	readonly release?: <A>(
		input: RunRelease,
		stop?: (serving: StopTarget) => Effect.Effect<A, unknown>,
	) => Effect.Effect<
		{
			readonly released: boolean;
			readonly stop?: A | undefined;
		},
		SessionFailure
	>;
	readonly released?: (input: RunRelease) => Effect.Effect<void>;
	readonly committed: (
		record: RunnerRetirement,
	) => Effect.Effect<void, unknown>;
	readonly shutdown: (record: RunnerRetirement) => Effect.Effect<void, unknown>;
	/** Without it, Settle waits for the owner that will settle on recovery. */
	readonly settlement?: {
		readonly sql: SqlClient.SqlClient | undefined;
		readonly configDir: string;
		readonly driverKind: string;
		readonly entry: (runnerId: string) => RunnerChild | undefined;
		readonly ingestion: (
			sessionId: string,
			entry: RunnerChild | undefined,
		) => Effect.Effect<
			Pick<ProviderRuntimeIngestion, "ingestBatch"> | undefined,
			unknown
		>;
		readonly projectRoot: (
			sessionId: string,
		) => Effect.Effect<string | undefined, unknown>;
		readonly commit: (evidence: SendEvidence) => Effect.Effect<void, unknown>;
		readonly wake: (sessionId: string) => Effect.Effect<void, unknown>;
	};
	readonly evict: (record: RunnerRetirement) => Effect.Effect<void, unknown>;
	readonly prune: (record: RunnerRetirement) => Effect.Effect<void, unknown>;
	readonly notice: (
		record: RunnerRetirement,
	) => Effect.Effect<boolean, unknown>;
	readonly waitForExit?: (
		record: RunnerRetirement,
	) => Effect.Effect<void> | undefined;
}) =>
	Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const runFork = yield* FiberSet.makeRuntime<never, void, never>();
		const states = new Map<string, RunnerStop>();
		const rows = new Map<string, RunnerRow>();
		const watching = new Set<string>();
		const get = (runnerId: string): RunnerStop =>
			states.get(runnerId) ?? { _tag: "Running" };
		// Every Stop state write wakes awaitStop, so End resolves at the exit.
		let stopChanged = Deferred.makeUnsafe<void>();
		const setStop = (runnerId: string, state: RunnerStop) => {
			states.set(runnerId, state);
			const changed = stopChanged;
			stopChanged = Deferred.makeUnsafe<void>();
			Deferred.doneUnsafe(changed, Effect.void);
		};
		const serving = (sessionId: string) =>
			[...rows.values()].find(
				(row) =>
					row.sessionId === sessionId &&
					row.role === "serving" &&
					row.retiredAt === null,
			)?.runnerId;
		const knownPids = (record: RunnerRetirement) =>
			[
				record.identity.pid,
				record.reaper?.pid,
				...record.members.map((member) => member.pid),
			].filter((pid) => pid !== undefined);
		/** Fills the routing cache; no Stop decision reads it. */
		const refreshRows = () =>
			Effect.gen(function* () {
				if (!options.receipts)
					return { rows: [...rows.values()], rejected: [] };
				const recovered = yield* options.receipts.runners();
				rows.clear();
				for (const row of recovered.rows) rows.set(row.runnerId, row);
				return recovered;
			});
		const observe = (record: RunnerRetirement) =>
			decideRunnerKill(
				record,
				observeRunnerRetirement(record, options.processTable),
			).record;
		/** The durable commit; without a store the routing rows are the store. */
		const commitStop = (
			target: StopTarget,
			reason: StopReason,
			inWrite: boolean,
		): Effect.Effect<StopCommit, unknown> => {
			if (options.receipts)
				return (
					inWrite
						? options.receipts.requestStopMutation
						: options.receipts.requestStop
				)(target, reason, observe);
			return Effect.suspend(() => {
				const row = rows.get(target.runnerId);
				if (row && row.retiredAt !== null)
					return reason._tag === "Superseded" &&
						serving(target.sessionId) !== reason.successor
						? Effect.fail("A different Stop won the swap")
						: Effect.succeed<StopCommit>({
								_tag: "Requested",
								record: {
									...stopRecord(target, row.retiredAt),
									stopReason: JSON.stringify(reason),
								},
								candidates: [],
								session: [...rows.values()].filter(
									(cached) => cached.sessionId === target.sessionId,
								),
							});
				if (row?.role === "serving" && reason._tag === "CandidateAbandoned")
					return Effect.succeed<StopCommit>({ _tag: "Ignored" });
				const retiredAt = clock.currentTimeMillisUnsafe();
				const candidates =
					row?.role === "serving" && reason._tag !== "Superseded"
						? [...rows.values()]
								.filter(
									(candidate) =>
										candidate.sessionId === target.sessionId &&
										candidate.role === "candidate" &&
										candidate.retiredAt === null,
								)
								.map((candidate) =>
									observe(stopRecord({ ...candidate, members: [] }, retiredAt)),
								)
						: [];
				const retired = new Set([
					target.runnerId,
					...candidates.map((candidate) => candidate.runnerId),
				]);
				return Effect.succeed<StopCommit>({
					_tag: "Requested",
					record: {
						...observe(stopRecord(target, retiredAt)),
						stopReason: JSON.stringify(reason),
					},
					candidates,
					session: [...rows.values()]
						.filter((cached) => cached.sessionId === target.sessionId)
						.map((cached) =>
							retired.has(cached.runnerId)
								? { ...cached, retiredAt }
								: reason._tag === "Superseded" &&
										cached.runnerId === reason.successor
									? { ...cached, role: "serving" as const }
									: cached,
						),
				});
			});
		};
		// One observation per held transmission survives a failed commit for the retry.
		const pendingGoneSettlements = new Map<string, SendEvidence>();
		const settle = (retirement: RunnerRetirement) =>
			Effect.gen(function* () {
				const settlement = options.settlement;
				if (!settlement) return false;
				const { sql, configDir } = settlement;
				if (!sql) return true;
				const entry = settlement.entry(retirement.runnerId);
				const sessionIngestion = yield* settlement.ingestion(
					retirement.sessionId,
					entry,
				);
				if (!sessionIngestion) {
					// Deleting a session deletes its runs, so nothing is left to settle.
					const [session] = yield* sql<{
						id: string;
					}>`SELECT id FROM sessions WHERE id = ${retirement.sessionId}`;
					if (session) return false;
					if (options.receipts)
						yield* options.receipts.settled(retirement.runnerId);
					return true;
				}
				const commands = yield* sql<{
					request_sequence: number;
					project_key: string;
					session_id: string;
					command_id: string;
					attempt_count: number;
					provider_id: string;
					run_id: string;
					payload_json: string;
					transmission: number;
				}>`SELECT command.request_sequence, command.project_key, command.session_id, command.command_id, command.attempt_count, command.provider_id, command.run_id, command.payload_json, run.held_transmission AS transmission FROM provider_command_outbox command JOIN provider_runs run ON run.id = command.run_id AND run.session_id = command.session_id WHERE command.session_id = ${retirement.sessionId} AND command.effect_type = 'send_turn' AND run.runner_id = ${retirement.runnerId} AND run.held_transmission IS NOT NULL AND run.status IN ('pending', 'running')`;
				for (const command of commands) {
					const key = JSON.stringify([
						retirement.runnerId,
						command.run_id,
						command.request_sequence,
						command.attempt_count,
						command.transmission,
					]);
					let observed = pendingGoneSettlements.get(key);
					if (!observed) {
						const root =
							entry?.registrationRoot ??
							(yield* settlement.projectRoot(retirement.sessionId));
						const directory = entry
							? dirname(entry.socketPath)
							: root
								? runnerDirectory(root, configDir)
								: undefined;
						const evidence = readRunnerEvidence(
							configDir,
							retirement.runnerId,
							retirement.sessionId,
						);
						const [cursor] = yield* sql<{
							journals_before_execution: number | null;
						}>`SELECT journals_before_execution FROM claude_runner_cursors WHERE runner_id = ${retirement.runnerId}`;
						const journalBuild = journalsBeforeExecution(
							cursor,
							evidence?.buildId === runnerBuildId(),
						);
						const journalDirectory = evidence
							? dirname(evidence.socketPath)
							: directory;
						const decodedPayload = yield* Effect.result(
							Effect.try((): unknown => JSON.parse(command.payload_json)),
						);
						const payload =
							decodedPayload._tag === "Success"
								? decodedPayload.success
								: undefined;
						const journal = journalDirectory
							? readRunnerSendJournal({
									directory: journalDirectory,
									sessionId: retirement.sessionId,
									driverKind: settlement.driverKind,
									commandId: command.command_id,
									attempt: command.attempt_count,
									nativeResumeFallback:
										isRecord(payload) &&
										payload["nativeResumeFallback"] === true,
								})
							: { _tag: "Unreadable" as const };
						if (journalBuild && journal._tag === "Absent") {
							yield* release({
								sessionId: retirement.sessionId,
								runId: command.run_id,
								runnerId: retirement.runnerId,
								commandId: command.command_id,
								transmission: command.transmission,
								reason: "JournalAbsent",
							});
							continue;
						}
						if (
							journal._tag === "Present" &&
							journal.state.status === "finished" &&
							!(
								isRecord(payload) && payload["nativeResumeFallback"] === true
							) &&
							(journal.state.result?.nativeResumeRejected ||
								isClaudeResumeRefused(
									journal.state.failure ?? journal.state.result?.error,
								))
						) {
							yield* release({
								sessionId: retirement.sessionId,
								runId: command.run_id,
								runnerId: retirement.runnerId,
								commandId: command.command_id,
								transmission: command.transmission,
								reason: "ResumeRejected",
							});
							continue;
						}
						const send: HeldSendRef = {
							sessionId: retirement.sessionId,
							runId: command.run_id,
							commandId: command.command_id,
							requestSequence: command.request_sequence,
							attempt: command.attempt_count,
							runnerId: retirement.runnerId,
							transmission: command.transmission,
						};
						const observedAt = clock.currentTimeMillisUnsafe();
						const answer =
							journal._tag === "Present" ? journal.state : undefined;
						const finished = answer?.status === "finished" ? answer : undefined;
						// An uncertain offline journal or an intake-only result under a
						// deliberate stop retains the existing interrupted process-loss outcome.
						// Missing or unreadable evidence remains delivery unknown (7.3).
						const consumedOnly =
							answer?.status === "uncertain" ||
							finished?.result?.status === "accepted" ||
							finished?.result?.status === "joined";
						if (
							finished &&
							(finished.failure || terminalTurnResult(finished.result))
						) {
							observed = {
								_tag: "journal_finished",
								send,
								answer: finished,
								observedAt,
							};
						} else if (
							consumedOnly &&
							retirement.stopReason !== '{"_tag":"Exited"}'
						) {
							const reason: StopReason = yield* Schema.decodeUnknownEffect(
								Schema.fromJsonString(
									Schema.Union([
										Schema.Struct({
											_tag: Schema.Literals([
												"Explicit",
												"EndSession",
												"ProjectRemoved",
												"Idle",
												"CandidateAbandoned",
											]),
										}),
										Schema.Struct({
											_tag: Schema.Literal("Superseded"),
											successor: Schema.String,
										}),
									]),
								),
							)(retirement.stopReason);
							observed = { _tag: "process_lost", send, reason, observedAt };
						} else observed = { _tag: "delivery_unknown", send, observedAt };
						pendingGoneSettlements.set(key, observed);
					}
					yield* settlement.commit(observed);
					pendingGoneSettlements.delete(key);
					yield* settlement.wake(retirement.sessionId);
				}
				const owners = (sessionId: string) => sql<{
					runId: string;
				}>`SELECT DISTINCT owner.id AS runId
			FROM provider_runs requested JOIN provider_runs owner
			ON owner.id = COALESCE(requested.joined_into, requested.id) AND owner.session_id = requested.session_id
			WHERE requested.session_id = ${sessionId} AND owner.status IN ('pending', 'running')
			AND (${legacyRunnerRunPredicate(sql, sessionId, sql`owner.id`)}
				OR NOT EXISTS (SELECT 1 FROM provider_command_outbox command
					JOIN provider_runs send_run ON send_run.id = command.run_id AND send_run.session_id = command.session_id
					WHERE command.session_id = requested.session_id AND command.effect_type = 'send_turn'
					AND COALESCE(send_run.joined_into, send_run.id) = owner.id))
			AND (owner.runner_id = ${retirement.runnerId} OR (owner.runner_id IS NULL AND requested.id IN ${sql.in(retirement.ownedRunIds)}))`;
				// Removal ends launched runs process lost (3.11), as an error as on main.
				const errorCode =
					retirement.stopReason === '{"_tag":"Exited"}'
						? entry?.lifecycle.idleExiting
							? undefined
							: String(entry?.lifecycle.failure?.code ?? "provider_error")
						: retirement.stopReason === '{"_tag":"ProjectRemoved"}'
							? "runner_stopped"
							: undefined;
				// Claude's durable backstop: tool-linked child runs absent from memory.
				if (settlement.driverKind === "claude")
					yield* settleToolChildRuns(
						sql,
						retirement.sessionId,
						"Provider process stopped",
						(events) => sessionIngestion.ingestBatch(events),
					);
				// Exact cohorts in other sessions, such as subagent children, settle
				// in their own session before the receipt-carrying commit below.
				const foreignSessions = retirement.ownedRunIds.length
					? yield* sql<{
							session_id: string;
						}>`SELECT DISTINCT session_id FROM provider_runs WHERE id IN ${sql.in(retirement.ownedRunIds)} AND session_id <> ${retirement.sessionId}`
					: [];
				for (const { session_id } of foreignSessions)
					yield* sessionIngestion.ingestBatch([], {
						settleRuns: {
							sessionId: session_id,
							reason: "Provider process stopped",
							owners: owners(session_id),
							...(errorCode ? { errorCode } : {}),
						},
					});
				yield* sessionIngestion.ingestBatch([], {
					settleRuns: {
						sessionId: retirement.sessionId,
						reason: "Provider process stopped",
						owners: owners(retirement.sessionId),
						...(errorCode ? { errorCode } : {}),
					},
					...(options.receipts
						? { beforeCommit: options.receipts.settled(retirement.runnerId) }
						: {}),
				});
				return true;
			});
		const tick = (runnerId: string, retry = false, notice = false) =>
			Effect.gen(function* () {
				let retryPending = retry;
				let noticePending = notice;
				let state = get(runnerId);
				if (!("record" in state)) return;
				if (options.receipts) {
					const rows = yield* options.receipts.retirements([runnerId]);
					if (rows.rejected.length) return;
					if (rows.rows[0]) state = stoppedState(rows.rows[0]);
				}
				if (!("record" in state)) return;
				yield* options.committed(state.record);
				let unsent = false;
				for (let step = 0; step < 5; step++) {
					if (!("record" in state) || state._tag === "Settled") return;
					// Only a signal needs identity (6.6): runRunnerKill reads it after
					// its commit, and a step after a kill that sent nothing reads it so
					// a reused pid is seen gone. The window otherwise reads liveness,
					// where a live pid is unknown, never gone.
					const alive = options.processTable.alive;
					const liveness: RunnerRetirementObservation | undefined =
						alive &&
						!unsent &&
						(state._tag === "Requested" || state._tag === "Escalating")
							? {
									group: undefined,
									processes: new Map(
										knownPids(state.record).map((pid) => [
											pid,
											{ state: alive(pid) ? "unknown" : "gone" },
										]),
									),
								}
							: undefined;
					const now = clock.currentTimeMillisUnsafe();
					// Liveness names no signal target, so an Escalated it decides is
					// re-read with identity: the window never ends on it without KILL.
					const processes: RunnerRetirementObservation =
						liveness &&
						decideRunnerStop(
							{
								...state,
								record: decideRunnerKill(state.record, liveness).record,
							},
							{
								_tag: "Observe",
								now,
								processes: liveness,
								retry: retryPending,
								notice: noticePending,
							},
						).state._tag !== "Escalated"
							? liveness
							: observeRunnerRetirement(state.record, options.processTable);
					const observed: RunnerRetirement = decideRunnerKill(
						state.record,
						processes,
					).record;
					if (
						options.receipts &&
						observed.members.length > state.record.members.length
					)
						yield* options.receipts.commitRetirement(observed);
					state = { ...state, record: observed };
					const decision = decideRunnerStop(state, {
						_tag: "Observe",
						now: processes === liveness ? now : clock.currentTimeMillisUnsafe(),
						processes,
						retry: retryPending,
						notice: noticePending,
					});
					let record: RunnerRetirement = state.record;
					for (const action of decision.actions) {
						switch (action._tag) {
							case "SendShutdown":
								yield* options
									.shutdown(record)
									.pipe(
										Effect.interruptible,
										Effect.timeout("1 second"),
										Effect.ignore,
									);
								break;
							case "Signal": {
								const killed: ReturnType<typeof decideRunnerKill> =
									yield* runRunnerKill(
										record,
										options.processTable,
										options.receipts,
										action.signal,
										processes,
									);
								record = killed.record;
								unsent = killed.signals.length === 0;
								retryPending = false;
								break;
							}
							case "Settle":
								if (!(yield* settle(record))) return;
								break;
							case "Evict":
								yield* options.evict(record);
								break;
							case "Prune":
								yield* options.prune(record);
								break;
							case "Notice":
								if (!(yield* options.notice(record))) return false;
								noticePending = false;
								break;
						}
					}
					const next: RunnerStop =
						"record" in decision.state
							? {
									...decision.state,
									record: {
										...decision.state.record,
										members: record.members,
										signal: record.signal,
										signalLog: record.signalLog,
									},
								}
							: decision.state;
					if (
						"record" in next &&
						next._tag !== state._tag &&
						next._tag !== "Settled" &&
						options.receipts
					)
						yield* options.receipts.stopProgress(next.record);
					setStop(runnerId, next);
					if (
						next._tag === state._tag &&
						!decision.actions.some((action) => action._tag === "Signal")
					)
						return;
					state = next;
				}
				return true;
			});
		const safeTick = (runnerId: string, retry = false, notice = false) =>
			tick(runnerId, retry, notice).pipe(
				Effect.map((result) => result !== false),
				Effect.repeat({
					while: (complete) => !complete,
					schedule: runnerRetrySchedule,
				}),
				retryRunnerPersistence,
			);

		const watch = (runnerId: string) => {
			if (watching.has(runnerId)) return;
			watching.add(runnerId);
			runFork(
				Effect.gen(function* () {
					const startedAt = clock.currentTimeMillisUnsafe();
					let tickedAt = startedAt;
					let healthy = yield* safeTick(runnerId);
					while (
						get(runnerId)._tag === "Escalating" ||
						get(runnerId)._tag === "Requested"
					) {
						const current = get(runnerId);
						const leaderExit =
							"record" in current
								? options.waitForExit?.(current.record)
								: undefined;
						const termAt =
							"record" in current
								? current.record.signalLog.find(
										(attempt) =>
											attempt.signal === "SIGTERM" && attempt.at !== undefined,
									)?.at
								: undefined;
						const termRemaining =
							termAt !== undefined
								? termAt + 3_000 - clock.currentTimeMillisUnsafe()
								: 0;
						// Leave only after a tick that began past the durable window end,
						// so that tick decided Escalated.
						if (
							tickedAt >=
								("record" in current
									? stopWindowEnd(current.record)
									: startedAt + 4_000) &&
							termRemaining <= 0
						)
							break;
						const delay = healthy
							? leaderExit && termRemaining > 0
								? termRemaining
								: 250
							: Math.max(
									250,
									startedAt + 4_000 - clock.currentTimeMillisUnsafe(),
								);
						// With no exit event, poll the known pids as main did, so Gone
						// follows the last exit (the reaper's, 6.6) by one interval.
						const alive = options.processTable.alive;
						const pids = "record" in current ? knownPids(current.record) : [];
						const exited =
							leaderExit ??
							(alive &&
								Effect.gen(function* () {
									do yield* Effect.sleep("25 millis");
									while (pids.some(alive));
								}));
						yield* exited && healthy
							? Effect.raceFirst(exited, Effect.sleep(delay))
							: Effect.sleep(delay);
						tickedAt = clock.currentTimeMillisUnsafe();
						healthy = yield* safeTick(runnerId);
					}
					for (const offset of [10_000, 30_000, 60_000]) {
						if (get(runnerId)._tag === "Settled") return;
						yield* Effect.sleep(
							Math.max(0, startedAt + offset - clock.currentTimeMillisUnsafe()),
						);
						yield* safeTick(runnerId, true);
					}
					let noticed = false;
					while (get(runnerId)._tag !== "Settled") {
						if (yield* safeTick(runnerId, false, !noticed)) noticed = true;
						if (get(runnerId)._tag === "Settled") return;
						yield* Effect.sleep("60 seconds");
					}
				}).pipe(Effect.ensuring(Effect.sync(() => watching.delete(runnerId)))),
			);
		};
		const afterStop = (
			commit: Extract<StopCommit, { readonly _tag: "Requested" }>,
			waiters: Deferred.Deferred<"Requested" | "Ignored", SessionFailure>,
		) =>
			Effect.gen(function* () {
				const { record } = commit;
				// The committing transaction's rows replace the session's routing
				// cache before cleanup can release admission waiters.
				for (const row of rows.values())
					if (row.sessionId === record.sessionId) rows.delete(row.runnerId);
				for (const row of commit.session) rows.set(row.runnerId, row);
				setStop(record.runnerId, stoppedState(record));
				yield* options
					.committed(record)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"Runner stop fence cleanup failed; retaining intent",
								cause,
							),
						),
					);
				yield* Deferred.succeed(waiters, "Requested");
				watch(record.runnerId);
				for (const candidate of commit.candidates) {
					setStop(candidate.runnerId, stoppedState(candidate));
					watch(candidate.runnerId);
				}
			});
		/**
		 * The one owner of a Stop commit. A store fault leaves the runner
		 * Committing and re-runs the whole commit after the 4.8 backoff. Only a
		 * per-row decode or identity rejection, a refused swap or a defect fails
		 * the waiters.
		 */
		const commitWorker = (
			target: StopTarget,
			reason: StopReason,
			waiters: Deferred.Deferred<"Requested" | "Ignored", SessionFailure>,
		) =>
			Effect.gen(function* () {
				for (let attempt = 1; ; attempt++) {
					const result = yield* Effect.exit(
						commitStop(target, reason, false).pipe(
							Effect.uninterruptible,
							Effect.provideService(Scheduler.PreventSchedulerYield, true),
						),
					);
					if (Exit.isSuccess(result)) {
						if (result.value._tag === "Requested")
							return yield* afterStop(result.value, waiters);
						setStop(target.runnerId, { _tag: "Running" });
						return yield* Deferred.succeed(waiters, "Ignored");
					}
					const cause = Option.getOrUndefined(
						Failure.firstFailure(result.cause),
					);
					if (
						reason._tag === "Superseded" ||
						cause === undefined ||
						cause instanceof RunnerRetirementDecodeError ||
						cause instanceof RunnerSlotError
					) {
						setStop(target.runnerId, { _tag: "Running" });
						yield* Effect.logError(
							`Runner stop commit rejected: runnerId=${target.runnerId}`,
							result.cause,
						);
						return yield* Deferred.fail(
							waiters,
							runnerFailure("stop runner", result.cause),
						);
					}
					yield* Effect.logWarning(
						`Runner stop commit failed; retrying: runnerId=${target.runnerId} attempt=${attempt}`,
						result.cause,
					);
					yield* Effect.sleep(sendRetryBackoff(attempt));
				}
			}).pipe(Effect.onInterrupt(() => Deferred.interrupt(waiters)));
		/** Registers a Stop intent; the reconciler scope owns its commit. */
		const registerStop = (target: StopTarget, reason: StopReason) => {
			const waiters = Deferred.makeUnsafe<
				"Requested" | "Ignored",
				SessionFailure
			>();
			setStop(target.runnerId, { _tag: "Committing", waiters });
			runFork(commitWorker(target, reason, waiters));
			return waiters;
		};
		/**
		 * Registers the intent before yielding. Cancelling a caller cancels only
		 * its wait; the reconciler scope owns the commit.
		 */
		const requestStop = (
			target: StopTarget,
			reason: StopReason = { _tag: "Explicit" },
		): Effect.Effect<"Requested" | "Ignored", SessionFailure> =>
			Effect.gen(function* () {
				while (true) {
					const current = get(target.runnerId);
					if (current._tag === "Committing") {
						// After Ignored a joiner commits its own reason.
						yield* Deferred.await(current.waiters);
						continue;
					}
					if (current._tag !== "Running") {
						// A repeated swap is checked against the committed row.
						if (reason._tag === "Superseded")
							yield* commitStop(target, reason, false).pipe(
								Effect.mapError((cause) => runnerFailure("stop runner", cause)),
							);
						return "Requested";
					}
					const waiters = registerStop(target, reason);
					// The swap's caller must learn whether its promotion committed.
					return yield* reason._tag === "Superseded"
						? Effect.uninterruptible(Deferred.await(waiters))
						: Deferred.await(waiters);
				}
			});
		const release = (input: RunRelease): Effect.Effect<void, SessionFailure> =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					const persistRelease = options.release;
					if (!persistRelease)
						return yield* Effect.fail(
							runnerFailure(
								"release run",
								"Release persistence is unavailable",
							),
						);
					let current = get(input.runnerId);
					if (current._tag === "Committing") {
						yield* Deferred.await(current.waiters);
						current = get(input.runnerId);
					}
					const reason: StopReason | undefined =
						input.reason === "Refused"
							? input.refusalReason === "exiting"
								? { _tag: "Idle" }
								: input.refusalReason === "retiring"
									? { _tag: "Exited" }
									: undefined
							: undefined;
					if (!reason) {
						const committed = yield* persistRelease(input);
						if (committed.released)
							yield* options.released?.(input) ?? Effect.void;
						return;
					}
					const waiters = yield* Deferred.make<
						"Requested" | "Ignored",
						SessionFailure
					>();
					setStop(input.runnerId, { _tag: "Committing", waiters });
					const result = yield* Effect.exit(
						// releaseRun invokes this only for the serving row its own
						// transaction read, beside the matching release evidence.
						persistRelease(input, (serving) =>
							commitStop(serving, reason, true),
						),
					);
					if (Exit.isFailure(result)) {
						setStop(input.runnerId, current);
						// Joiners recheck and commit their own Stop.
						yield* Deferred.succeed(waiters, "Ignored");
						return yield* Effect.fail({
							...runnerFailure("release run", result.cause),
							cause:
								Option.getOrUndefined(Failure.firstFailure(result.cause)) ??
								result.cause,
						});
					}
					// The handle must leave the releasing runner before revocation or
					// admission waiters can trigger any retirement cleanup.
					if (result.value.released)
						yield* options.released?.(input) ?? Effect.void;
					if (result.value.released && result.value.stop?._tag === "Requested")
						yield* afterStop(result.value.stop, waiters);
					else {
						setStop(input.runnerId, current);
						yield* Deferred.succeed(waiters, "Ignored");
					}
				}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
			);
		return {
			state: get,
			serving,
			register: (
				runnerId: string,
				identity: RunnerCursorIdentity,
				role: RunnerRow["role"],
			): Effect.Effect<"Registered" | "Lost", StoreFault> =>
				Effect.gen(function* () {
					if (options.receipts) {
						const registered = yield* options.receipts.register(
							runnerId,
							identity,
							role,
						);
						if (registered === "Lost") return "Lost";
						yield* refreshRows();
						return "Registered";
					} else {
						const current = serving(identity.sessionId);
						if (
							(role === "serving" &&
								current !== undefined &&
								current !== runnerId) ||
							(role === "candidate" && current === undefined)
						)
							return "Lost";
					}
					rows.set(runnerId, {
						runnerId,
						sessionId: identity.sessionId,
						driverKind: identity.driverKind ?? "claude",
						identity:
							identity.pid !== undefined && identity.startTime !== undefined
								? {
										tag: "Verified",
										pid: identity.pid,
										startTime: identity.startTime,
									}
								: {
										tag: "Unverifiable",
										...(identity.pid === undefined
											? {}
											: { pid: identity.pid }),
									},
						reaper: identity.reaper,
						role,
						retiredAt: null,
						sequence: 0,
					});
					return "Registered";
				}).pipe(Effect.mapError(toStoreFault)),
			holdRun: (
				sessionId: string,
				runId: string,
				commandId: string,
			): Effect.Effect<Hold, StoreFault> =>
				options.holdRun
					? options.holdRun(sessionId, runId, commandId)
					: Effect.suspend(() => {
							const holder = serving(sessionId);
							return Effect.succeed<Hold>(
								holder === undefined
									? { _tag: "Unserved", predecessor: Option.none() }
									: { _tag: "Held", runner: holder, transmission: 1 },
							);
						}),
			requestStop,
			release,
			recover: (
				recoverable?: (row: {
					readonly sessionId: string;
					readonly driverKind: string;
				}) => Effect.Effect<boolean, SessionFailure>,
			) =>
				Effect.gen(function* () {
					const recovered = yield* refreshRows();
					const retirements = yield* options.receipts?.retirements(
						recovered.rows.map((row) => row.runnerId),
					) ?? Effect.succeed({ rows: [], rejected: [] });
					for (const record of retirements.rows) {
						if (recoverable && !(yield* recoverable(record))) continue;
						if (get(record.runnerId)._tag !== "Running") continue;
						setStop(record.runnerId, stoppedState(record));
						watch(record.runnerId);
					}
					// Startup registers these intents and does not wait on their
					// commits; a busy store must not hold up reattachment.
					for (const row of recovered.rows) {
						if (recoverable && !(yield* recoverable(row))) continue;
						if (row.retiredAt !== null || get(row.runnerId)._tag !== "Running")
							continue;
						if (row.role === "candidate")
							registerStop(
								{ ...row, members: [] },
								{ _tag: "CandidateAbandoned" },
							);
						else if (row.identity.pid !== undefined) {
							const observed = options.processTable.inspect(row.identity.pid);
							if (
								observed.state === "gone" ||
								observed.state === "zombie" ||
								(row.identity.tag === "Verified" &&
									observed.startTime !== undefined &&
									observed.startTime !== row.identity.startTime)
							)
								registerStop({ ...row, members: [] }, { _tag: "Exited" });
						}
					}
					return {
						rows: [...rows.values()],
						rejected: [...recovered.rejected, ...retirements.rejected],
					};
				}),
			awaitStop: (runnerId: string, target: "Escalated" | "Settled") =>
				Effect.gen(function* () {
					const observe = Effect.suspend(() => {
						const state = get(runnerId);
						return state._tag === "Committing"
							? Deferred.await(state.waiters).pipe(
									Effect.map(() => get(runnerId)),
								)
							: Effect.succeed(state);
					});
					const until = (done: (state: RunnerStop) => boolean) =>
						Effect.gen(function* () {
							while (true) {
								const changed = stopChanged;
								const state = yield* observe;
								if (done(state)) return state;
								yield* Deferred.await(changed);
							}
						});
					const wait = until(
						(state) =>
							state._tag === "Settled" ||
							(target === "Escalated" &&
								(state._tag === "Escalated" || state._tag === "Gone")),
					).pipe(Effect.asVoid);
					if (target === "Settled") return yield* wait;
					const state = yield* until(
						(state) => state._tag !== "Running" && state._tag !== "Committing",
					);
					if ("record" in state) {
						const deadline = stopWindowEnd(state.record);
						// Backoff may pass the deadline; the caller's bound must not.
						return yield* wait.pipe(
							Effect.timeoutOption(
								Math.max(0, deadline - clock.currentTimeMillisUnsafe()),
							),
							Effect.asVoid,
						);
					}
					return yield* wait;
				}),
		};
	});

type ReconcilerOptions = Parameters<typeof makeRunnerStopReconciler>[0];

/** The attachment a grant was read for; adoption moves only the latest one. */
export interface RunnerAttachment {
	readonly runnerId: string;
}

/**
 * Retirement owns process authority and every runner stop: the reconciler,
 * the grants an entry and its latest attachment write with, the End command a
 * stop keeps, and the manager's recovery and closing flags.
 */
export const makeRunnerRetirement = (
	options: Omit<
		ReconcilerOptions,
		"committed" | "waitForExit" | "settlement"
	> & {
		readonly driverKind: string;
		readonly settlement: Omit<
			NonNullable<ReconcilerOptions["settlement"]>,
			"driverKind" | "entry"
		>;
		readonly sessionCommit: (sessionId: string) => Effect.Effect<
			{
				readonly commit: Pick<CommitAndSignal, "committed">;
				readonly lifecycle: Pick<
					ReturnType<typeof makeRunnerRunLifecycle>,
					"releaseRun"
				>;
			},
			unknown
		>;
		readonly close: {
			readonly lock: Semaphore.Semaphore;
			readonly sends: Effect.Effect<void>;
			readonly release: (
				entry: RunnerChild,
				cause: Cause.Cause<SessionFailure>,
			) => Effect.Effect<void>;
			readonly detach: (entry: RunnerChild) => void;
		};
	},
) =>
	Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		const authority = yield* makeRunnerAuthority<RunnerChild>(
			options.receipts,
			(runnerId) => retirementOf(runnerId),
		);
		const grants = new WeakMap<RunnerChild | RunnerAttachment, Grant>();
		const attachments = new WeakMap<RunnerChild, RunnerAttachment>();
		const endCommands = new Map<string, string>();
		const recoveredRunnerIds = new Set<string>();
		// The transmission each held run may write, until its release commits.
		const currentHolds = new Map<
			string,
			{ readonly runner: string; readonly transmission: number }
		>();
		const releases = yield* PubSub.unbounded<RunRelease>();
		const holdKey = (
			run: Pick<OwnerSend, "sessionId" | "runId" | "commandId">,
		) => JSON.stringify([run.sessionId, run.runId, run.commandId]);
		let recovering = false;
		let closing = false;
		const retirementOf = (runnerId: string): RunnerRetirement | undefined => {
			const state = stops.state(runnerId);
			return "record" in state ? state.record : undefined;
		};
		const identityFor = (entry: RunnerChild): RunnerIdentity<RunnerChild> => {
			const retirement = retirementOf(entry.runnerId);
			return {
				runnerId: entry.runnerId,
				sessionId: entry.sessionId,
				driverKind: options.driverKind,
				pid: entry.pid ?? entry.child?.pid,
				startTime: entry.startTime,
				reaper: entry.reaper,
				members: retirement?.members ?? [],
				signalLog: retirement?.signalLog ?? [],
				registeredAt: entry.registeredAt ?? 0,
				socketPath: entry.socketPath,
				attachmentId: entry.attachmentId,
				ownedRunIds: [...(entry.ownedRunIds ?? [])],
				signalled: retirement !== undefined && retirement.signal.tag !== "None",
				signal: retirement?.signal ?? { tag: "None" },
				entry,
			};
		};
		const retirementForIdentity = (
			identity: RunnerIdentity<RunnerChild>,
		): RunnerRetirement =>
			retirementOf(identity.runnerId) ?? {
				runnerId: identity.runnerId,
				sessionId: identity.sessionId,
				driverKind: identity.driverKind,
				identity:
					identity.pid !== undefined && identity.startTime !== undefined
						? {
								tag: "Verified",
								pid: identity.pid,
								startTime: identity.startTime,
							}
						: {
								tag: "Unverifiable",
								...(identity.pid === undefined ? {} : { pid: identity.pid }),
							},
				reaper: identity.reaper,
				members: identity.members,
				signalLog: identity.signalLog,
				signal: identity.signal,
				retirement: { tag: "Watching" },
				ownedRunIds: [],
				retiredAt: clock.currentTimeMillisUnsafe(),
				stopReason: "runner retired",
			};
		const retirementFor = (entry: RunnerChild): RunnerRetirement =>
			retirementForIdentity(identityFor(entry));
		const entryOf = (runnerId: string) =>
			authority.records.get(runnerId)?.identity.entry;
		const stops: Effect.Success<ReturnType<typeof makeRunnerStopReconciler>> =
			yield* makeRunnerStopReconciler({
				...options,
				settlement: {
					...options.settlement,
					driverKind: options.driverKind,
					entry: entryOf,
				},
				waitForExit: (retirement) => {
					const child = entryOf(retirement.runnerId)?.child;
					if (!child || child.exitCode !== null || child.signalCode !== null)
						return undefined;
					return Effect.callback<void>((resume) => {
						if (child.exitCode !== null || child.signalCode !== null) {
							resume(Effect.void);
							return;
						}
						const exited = () => resume(Effect.void);
						child.once("exit", exited);
						return Effect.sync(() => {
							child.off("exit", exited);
						});
					});
				},
				committed: (retirement) =>
					Effect.gen(function* () {
						const record = authority.records.get(retirement.runnerId);
						const entry = record?.identity.entry;
						if (entry) {
							Entry.transition(entry, { _tag: "Stop" });
							authority.captureBeforeRevoke(entry.runnerId, identityFor(entry));
						}
						authority.recordRetirement(retirement);
						if (!entry)
							log.warn(
								`Retired surviving runner ${retirement.runnerId} for session ${retirement.sessionId}`,
							);
						if (record && record.tag._tag !== "Retired")
							yield* authority.revoke(record.grant, "retired", {
								ownedRunIds: record.identity.ownedRunIds,
							});
					}),
				prune: (retirement) =>
					options.prune(retirement).pipe(
						Effect.andThen(
							Effect.sync(() => {
								endCommands.delete(retirement.runnerId);
								recoveredRunnerIds.delete(retirement.runnerId);
								authority.forget(retirement.runnerId);
								// A hold ended without a release (settled, joined, deleted)
								// leaves its entry until its runner is pruned.
								for (const [key, hold] of currentHolds)
									if (hold.runner === retirement.runnerId)
										currentHolds.delete(key);
							}),
						),
					),
			});
		return {
			...stops,
			get records() {
				return authority.records;
			},
			/** The serving runner's entry, else the one still starting unbound. */
			currentEntry: (sessionId: string) => {
				const serving = stops.serving(sessionId);
				if (serving) return authority.records.get(serving)?.identity.entry;
				for (const record of authority.records.values())
					if (
						record.identity.sessionId === sessionId &&
						record.tag._tag === "Starting" &&
						record.identity.entry?.pid === undefined &&
						!record.identity.entry?.lifecycle.candidate
					)
						return record.identity.entry;
				return undefined;
			},
			pidAlive: (pid: number, startTime?: string) => {
				const current = options.processTable.inspect(pid);
				return (
					!["gone", "zombie"].includes(current.state) &&
					!(
						startTime !== undefined &&
						current.startTime !== undefined &&
						current.startTime !== startTime
					)
				);
			},
			processTable: options.processTable,
			/** Recovery restores live authority to durable serving rows only. */
			adopt: (identities: Parameters<typeof authority.adopt>[0]) =>
				authority
					.adopt(identities, "live")
					.pipe(Effect.map(({ grants: adopted }) => adopted)),
			guarded: authority.guarded,
			observe: authority.observe,
			detach: authority.detach,
			identityFor,
			retirementFor,
			retirementForIdentity,
			/** Adopts the entry and moves its grant to the entry's latest attachment. */
			adoptEntry: (entry: RunnerChild, phase: "starting" | "live") =>
				authority.adopt([identityFor(entry)], phase).pipe(
					Effect.mapError((cause) => runnerFailure("adopt runner", cause)),
					Effect.flatMap(({ grants: adopted }) => {
						const grant = adopted.get(entry.runnerId);
						const attachment = attachments.get(entry);
						for (const holder of attachment ? [entry, attachment] : [entry])
							if (grant) grants.set(holder, grant);
							else grants.delete(holder);
						return grant
							? Effect.void
							: Effect.fail(
									runnerFailure("adopt runner", "Runner authority was revoked"),
								);
					}),
				),
			/** A new attachment writes with the entry's grant until a later adoption. */
			attach: (entry: RunnerChild): RunnerAttachment => {
				const attachment = { runnerId: entry.runnerId };
				const grant = grants.get(entry);
				if (grant) grants.set(attachment, grant);
				attachments.set(entry, attachment);
				return attachment;
			},
			grantOf: (holder: RunnerChild | RunnerAttachment) => grants.get(holder),
			stopRunner: (
				entry: RunnerChild,
				exceptCommandId?: string,
				intent: "stop" | "failure" = "stop",
				reason: StopReason = {
					_tag: intent === "failure" ? "Exited" : "Explicit",
				},
			): Effect.Effect<void, SessionFailure> =>
				Effect.gen(function* () {
					if (intent === "failure")
						yield* entry.outputs.withPermits(1)(Effect.void);
					if (exceptCommandId) endCommands.set(entry.runnerId, exceptCommandId);
					const stop = yield* stops
						.requestStop(retirementFor(entry), reason)
						.pipe(
							Effect.tapError(() =>
								Effect.sync(() => {
									if (exceptCommandId) endCommands.delete(entry.runnerId);
								}),
							),
						);
					if (stop === "Requested")
						yield* stops.awaitStop(entry.runnerId, "Escalated");
				}),
			/** The End command a runner's stop keeps answering, until it is pruned. */
			endCommand: (runnerId: string) => endCommands.get(runnerId),
			recoveredRunnerIds: recoveredRunnerIds as ReadonlySet<string>,
			/** Without a store a hold is in memory only, so it is current at once. */
			holdRun: options.holdRun
				? stops.holdRun
				: (sessionId: string, runId: string, commandId: string) =>
						stops.holdRun(sessionId, runId, commandId).pipe(
							Effect.tap((hold) =>
								Effect.sync(() => {
									if (hold._tag === "Held")
										currentHolds.set(holdKey({ sessionId, runId, commandId }), {
											runner: hold.runner,
											transmission: hold.transmission,
										});
								}),
							),
						),
			/** The lifecycle's writers: the hold sets, its rollback undoes the set, a release deletes. */
			holds: {
				held: (
					run: Pick<OwnerSend, "sessionId" | "runId" | "commandId">,
					runner: string,
					transmission: number,
				) => {
					const key = holdKey(run);
					const hold = { runner, transmission };
					currentHolds.set(key, hold);
					// Identity, not transmission: a later hold may reuse an uncommitted number.
					return () => {
						if (currentHolds.get(key) === hold) currentHolds.delete(key);
					};
				},
				released: (input: RunRelease) =>
					Effect.suspend(() => {
						const key = holdKey(input);
						if (currentHolds.get(key)?.transmission === input.transmission)
							currentHolds.delete(key);
						return PubSub.publish(releases, input);
					}).pipe(Effect.asVoid),
			},
			currentHold: (
				run: Pick<OwnerSend, "sessionId" | "runId" | "commandId">,
			) => currentHolds.get(holdKey(run))?.transmission,
			/** Every committed release, for the feeder's re-enqueue only. */
			releases,
			/** Settles the send as failed; a held send is released in the same commit. */
			refuse: (input: OwnerSend, failure: SessionFailure, held?: Held) => {
				const {
					sql,
					commit: commitSettlement,
					wake: wakeReactor,
				} = options.settlement;
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
							const { lifecycle } = yield* options.sessionCommit(
								input.sessionId,
							);
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
			awaitRun: (
				input: Pick<OwnerSend, "sessionId" | "runId">,
				includeCoverage = false,
			) =>
				Effect.gen(function* () {
					const { sql } = options.settlement;
					if (!sql) return yield* Effect.never;
					let ordinal = 0;
					while (true) {
						const snapshot = yield* Effect.result(
							Effect.gen(function* () {
								const { commit } = yield* options.sessionCommit(
									input.sessionId,
								);
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
				}),
			clean: (runnerId: string) =>
				Effect.gen(function* () {
					if (!options.receipts) return;
					const { rows } = yield* options.receipts.runners();
					const row = rows.find((candidate) => candidate.runnerId === runnerId);
					if (!row) return;
					// The reconciler owns an unavailable commit; this waits for it.
					yield* stops.requestStop(
						{ ...row, members: [] },
						{ _tag: "CandidateAbandoned" },
					);
				}).pipe(Effect.mapError(toStoreFault)),
			park: (predecessor: {
				readonly runner: string;
				readonly until: number;
			}) => {
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
			recover: (
				recoverable: Parameters<typeof stops.recover>[0],
			): ReturnType<typeof stops.recover> =>
				stops.recover(recoverable).pipe(
					Effect.tap((recovered) =>
						Effect.sync(() => {
							for (const row of recovered.rows)
								recoveredRunnerIds.add(row.runnerId);
						}),
					),
				),
			/** A whole-manager recovery holds back upgrades until it exits. */
			recovering: <A, E, R>(
				sessionIds: ReadonlySet<string> | undefined,
				body: Effect.Effect<A, E, R>,
			): Effect.Effect<A, E, R> =>
				sessionIds
					? body
					: Effect.suspend(() => {
							recovering = true;
							return body;
						}).pipe(
							Effect.ensuring(
								Effect.sync(() => {
									recovering = false;
								}),
							),
						),
			get inRecovery() {
				return recovering;
			},
			get closing() {
				return closing;
			},
			shutdown: options.close.lock
				.withPermits(1)(
					Effect.gen(function* () {
						closing = true;
						const entries = [...authority.records.values()].flatMap((record) =>
							record.identity.entry && record.tag._tag !== "Retired"
								? [record.identity.entry]
								: [],
						);
						for (const entry of entries) Entry.notifyEntry(entry);
						yield* options.close.sends;
						const release = Effect.forEach(
							entries,
							(entry) =>
								options.close.release(
									entry,
									Cause.fail(
										runnerFailure("shutdown", "Runners are shutting down"),
									),
								),
							{ discard: true },
						);
						return yield* Effect.forEach(
							entries,
							(entry) => Effect.sync(() => options.close.detach(entry)),
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
				.pipe(Effect.uninterruptible),
		};
	});

type ProcessObservation = ReturnType<RunnerProcessTable["inspect"]>;
export interface RunnerRetirementObservation {
	readonly processes: ReadonlyMap<number, ProcessObservation>;
	readonly group: readonly RunnerMember[] | undefined;
}

export const observeRunnerRetirement = (
	record: RunnerRetirement,
	table: RunnerProcessTable,
	refreshGroup = true,
): RunnerRetirementObservation => {
	const group =
		!refreshGroup || record.identity.pid === undefined
			? undefined
			: table.members?.(record.identity.pid);
	const pids = [
		...new Set([
			...(record.identity.pid === undefined ? [] : [record.identity.pid]),
			...(record.reaper ? [record.reaper.pid] : []),
			...record.members.map((member) => member.pid),
			...(group ?? []).map((member) => member.pid),
		]),
	];
	const processes = new Map(
		table.inspectMany?.(pids) ?? pids.map((pid) => [pid, table.inspect(pid)]),
	);
	// Verify the pins after enumeration: the group may have been reused while
	// ps was reading it. Only this later observation can authorize membership.
	// A successful group listing is also an observation of each member's pgid.
	for (const member of group ?? []) {
		const prior = processes.get(member.pid) ?? table.inspect(member.pid);
		if (
			record.identity.pid !== undefined &&
			prior.state === "running" &&
			prior.startTime === member.startTime &&
			prior.pgid === undefined
		)
			processes.set(member.pid, { ...prior, pgid: record.identity.pid });
		else if (!processes.has(member.pid)) processes.set(member.pid, prior);
	}
	return { processes, group };
};

const memberGone = (
	member: RunnerMember,
	observation: RunnerRetirementObservation,
) => {
	const current = observation.processes.get(member.pid);
	return (
		current?.state === "gone" ||
		current?.state === "zombie" ||
		(current?.startTime !== undefined && current.startTime !== member.startTime)
	);
};

/** Membership only grows while a verified identity pins the original group. */
export const decideRunnerKill = (
	record: RunnerRetirement,
	observation: RunnerRetirementObservation,
	signal?: "SIGTERM" | "SIGKILL",
) => {
	const leader =
		record.identity.tag === "Verified" ? record.identity : undefined;
	const pins = (member: RunnerMember | undefined) => {
		if (!member || record.identity.pid === undefined) return false;
		const current = observation.processes.get(member.pid);
		return (
			current?.state === "running" &&
			current.startTime === member.startTime &&
			current.pgid === record.identity.pid
		);
	};
	const pinned = pins(leader) || pins(record.reaper);
	const members = mergeRunnerMembers(
		record.members,
		leader ? [{ pid: leader.pid, startTime: leader.startTime }] : [],
		record.reaper ? [record.reaper] : [],
		pinned ? (observation.group ?? []) : [],
	);
	const leaderTracked = members.some(
		(member) => member.pid === record.identity.pid,
	);
	const gone =
		members.every((member) => memberGone(member, observation)) &&
		(leaderTracked ||
			(record.identity.pid === undefined && members.length === 0) ||
			(record.identity.pid !== undefined &&
				["gone", "zombie"].includes(
					observation.processes.get(record.identity.pid)?.state ?? "unknown",
				)));
	const next: RunnerRetirement = { ...record, members };
	const signals: {
		readonly signal: "SIGTERM" | "SIGKILL";
		readonly target: number;
		readonly members: readonly RunnerMember[];
	}[] = [];
	if (signal && !gone) {
		if (pinned && record.identity.pid !== undefined)
			signals.push({
				signal,
				target: -record.identity.pid,
				members: observation.group ?? members,
			});
		else
			for (const member of members) {
				const current = observation.processes.get(member.pid);
				if (
					record.reaper?.pid === member.pid &&
					record.reaper.startTime === member.startTime &&
					!pins(record.reaper)
				)
					continue;
				if (
					current?.state === "running" &&
					current.startTime === member.startTime
				)
					signals.push({ signal, target: member.pid, members: [member] });
			}
	}
	return { record: next, signals, gone };
};

/** The durable snapshot is committed before delivery; delivery never owns membership. */
const runRunnerKill = (
	record: RunnerRetirement,
	table: RunnerProcessTable,
	receipts:
		| Effect.Success<ReturnType<typeof makeRunnerReceiptStore>>
		| undefined,
	signal?: "SIGTERM" | "SIGKILL",
	observation?: RunnerRetirementObservation,
): Effect.Effect<
	ReturnType<typeof decideRunnerKill>,
	import("effect/sql/SqlError").SqlError
> =>
	Effect.gen(function* () {
		const clock = yield* Clock.Clock;
		let decision = decideRunnerKill(
			record,
			observation ?? observeRunnerRetirement(record, table),
			signal,
		);
		if (receipts) yield* receipts.commitRetirement(decision.record);
		if (signal) {
			const committed = decision.record;
			decision = decideRunnerKill(
				committed,
				observeRunnerRetirement(committed, table),
				signal,
			);
			if (
				receipts &&
				decision.record.members.length > committed.members.length
			) {
				yield* receipts.commitRetirement(decision.record);
				// COMMIT may outlive either pin. Revalidate identities without another
				// membership refresh: a live pin authorizes -P, otherwise only the
				// committed members qualify. A fork after this check is the inherited
				// race in amendment failure mode 10; do not wait for forks to stop.
				decision = decideRunnerKill(
					decision.record,
					observeRunnerRetirement(decision.record, table, false),
					signal,
				);
			}
		}
		const attempts: RunnerSignalAttempt[] = [];
		for (const action of decision.signals) {
			let outcome: RunnerSignalAttempt["outcome"] = "delivered";
			const at = clock.currentTimeMillisUnsafe();
			try {
				table.signal(action.target, action.signal);
			} catch (cause) {
				outcome =
					isRecord(cause) &&
					(cause["code"] === "EPERM" || cause["code"] === "EACCES")
						? "refused"
						: "failed";
			}
			attempts.push({
				...action,
				outcome,
				...(action.signal === "SIGTERM" ? { at } : {}),
			});
		}
		const delivered = attempts.filter(
			(attempt) => attempt.outcome === "delivered",
		);
		const projection: RunnerSignal = delivered.length
			? signal === "SIGKILL"
				? {
						tag: "KillSent",
						members: decision.record.members,
						sent: mergeRunnerMembers(
							...delivered.map((attempt) => attempt.members),
						),
					}
				: { tag: "TermSent", members: decision.record.members }
			: { ...record.signal, members: decision.record.members };
		if (receipts && attempts.length) {
			// Delivery cannot roll back with SQLite. Finish this action before a
			// later Gone observation can settle and prune its row. The sole row
			// reconciler retains the attempts on its stack while retrying the log.
			yield* retryRunnerPersistence(
				Effect.suspend(() =>
					receipts.appendSignalLog(record.runnerId, attempts, projection),
				).pipe(
					Effect.tapCause((cause) =>
						Effect.logWarning("Runner signal log failed; retaining intent", {
							runnerId: record.runnerId,
							cause,
						}),
					),
				),
			);
		}
		return {
			...decision,
			record: {
				...decision.record,
				signal: projection,
				signalLog: [...record.signalLog, ...attempts],
			},
		};
	});

export class RunnerProcessError extends Data.TaggedError("RunnerProcessError")<{
	readonly message: string;
}> {}

/** Stop registered project runners for an explicit stop or project removal. */
export const stopRegisteredRunners = (
	workspaceRoot: string,
	configDir: string,
	reason: StopReason = { _tag: "Explicit" },
): Effect.Effect<void, RunnerProcessError> =>
	Effect.scoped(
		Effect.gen(function* () {
			const ambientSql = yield* Effect.serviceOption(SqlClient.SqlClient);
			const store = yield* Effect.serviceOption(PersistenceStore);
			const sql =
				Option.getOrUndefined(ambientSql) ??
				(Option.isSome(store)
					? Context.get(store.value, SqlClient.SqlClient)
					: undefined);
			// Migration 0089 owns claude_runner_cursors, so this store migrates before any read.
			if (!sql)
				return yield* makeEffectSqlMigrator().pipe(
					Effect.andThen(
						stopRegisteredRunners(workspaceRoot, configDir, reason),
					),
					Effect.provide(
						SqliteNode.layer({
							filename: join(configDir, "events.db"),
							busyTimeout: 5000,
						}).pipe(Layer.provide(Reactivity.layer)),
					),
					Effect.mapError(
						(cause) => new RunnerProcessError({ message: String(cause) }),
					),
				);
			const receipts = yield* makeRunnerReceiptStore(sql, { configDir }).pipe(
				Effect.mapError(
					(cause) => new RunnerProcessError({ message: String(cause) }),
				),
			);
			const connections = new Map<string, RunnerSocket>();
			const stops = yield* makeRunnerStopReconciler({
				receipts,
				processTable: runnerProcessTable,
				committed: () => Effect.void,
				// This connection never acknowledges output, so a runner flushing
				// output on shutdown waits for it to close, even past SIGTERM.
				// Close it when the shutdown window ends, before any signal.
				shutdown: (record) => {
					const connection = connections.get(record.runnerId);
					return connection
						? connection
								.commandEffect(`runner-stop:${record.runnerId}`, {
									type: "shutdown",
								})
								.pipe(
									Effect.asVoid,
									Effect.ensuring(Effect.sync(() => connection.destroy())),
								)
						: Effect.void;
				},
				// Project services have drained, so no settlement port: recovery
				// settles through their ingestion owner.
				evict: () => Effect.void,
				prune: () => Effect.void,
				notice: () => Effect.succeed(true),
			});
			const registrations = yield* Effect.try({
				try: () => discoverRunners(workspaceRoot, configDir),
				catch: (cause) => new RunnerProcessError({ message: String(cause) }),
			});
			const runFork = yield* FiberSet.makeRuntime<never, void, never>();
			const outcomes = yield* Effect.forEach(
				registrations,
				(registration) =>
					Effect.gen(function* () {
						let reaper: RunnerMember | undefined;
						const connection = yield* Effect.result(
							Effect.acquireRelease(
								connectRunner({
									...registration,
									driverKind: registration.driverKind ?? "claude",
									deps: { workspaceRoot, daemonConfigDir: configDir },
									runFork: (effect) =>
										runFork(effect.pipe(Effect.interruptible)),
									emit: () => Effect.never,
									onHello: (hello) =>
										Effect.sync(() => {
											reaper = hello.reaper;
										}),
									onClose: () => {},
								}),
								(connection) => Effect.sync(() => connection.destroy()),
							),
						);
						const verified =
							connection._tag === "Success" ||
							runnerPidMatchesRegistration(registration);
						if (connection._tag === "Success")
							connections.set(registration.runnerId, connection.success);
						const startTime = verified
							? (registration.startTime ??
								runnerProcessTable.inspect(registration.pid).startTime)
							: undefined;
						yield* stops.requestStop(
							{
								runnerId: registration.runnerId,
								sessionId: registration.sessionId,
								driverKind: registration.driverKind ?? "claude",
								identity:
									startTime === undefined
										? { tag: "Unverifiable", pid: registration.pid }
										: { tag: "Verified", pid: registration.pid, startTime },
								reaper,
								members: [],
							},
							reason,
						);
						yield* stops.awaitStop(registration.runnerId, "Escalated");
						// Project ingestion has drained, so Settle belongs to startup.
						// Use the reconciler's complete member/identity proof here even
						// when its next Gone observation is on the survivor cadence.
						const state = stops.state(registration.runnerId);
						if (
							"record" in state &&
							decideRunnerKill(
								state.record,
								observeRunnerRetirement(state.record, runnerProcessTable),
							).gone
						)
							removeRunnerDiscovery(registration.socketPath);
					}).pipe(Effect.exit),
				{ concurrency: 4 },
			);
			const failures = outcomes.filter(Exit.isFailure);
			if (failures.length)
				return yield* new RunnerProcessError({
					message: failures
						.map((exit) => Failure.renderCause(exit.cause))
						.join("\n"),
				});
		}),
	);
