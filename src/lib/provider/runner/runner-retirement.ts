import {
	Clock,
	Deferred,
	Effect,
	Exit,
	FiberSet,
	Option,
	Scheduler,
} from "effect";
import * as Failure from "../../effect/failure-classification.js";
import type {
	CommitAndSignal,
	CommitAndSignalFailure,
} from "../../persistence/effect/commit-and-signal.js";
import type { UnboundEventStoreEffect } from "../../persistence/effect/event-store-effect.js";
import {
	canonicalEvent,
	type EventPayloadMap,
} from "../../persistence/events.js";
import { isRecord } from "../../utils.js";
import {
	runSendCommandIdQuery,
	stopCovers,
} from "../session-run-settlement.js";
import { runnerFailure } from "./runner-protocol.js";
import {
	type makeRunnerReceiptStore,
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
import type { RunnerProcessTable } from "./runner-registry.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import {
	type SendEvidence,
	type SettlementTx,
	type StoreFault,
	sendRetryBackoff,
	settleSend,
	toStoreFault,
} from "./send-settlement.js";
import type { SessionFailure } from "./session-runner.js";

export type Hold =
	| {
			readonly _tag: "Held";
			readonly runner: string;
			readonly transmission: number;
	  }
	| { readonly _tag: "Cleaning"; readonly runner: string }
	| {
			readonly _tag: "Unserved";
			readonly predecessor: Option.Option<{
				readonly runner: string;
				readonly until: number;
			}>;
	  }
	| { readonly _tag: "Busy" }
	| { readonly _tag: "Covered" }
	| { readonly _tag: "Exhausted" }
	| { readonly _tag: "Ended" };

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
		readonly released?: (input: RunRelease) => Effect.Effect<void>;
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
							return { _tag: "Held", runner: serving.runner_id, transmission };
						}),
					{
						afterCommit: Effect.suspend(() =>
							Effect.forEach(followUps, (effect) => effect, { discard: true }),
						),
					},
				)
				.pipe(
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
							if (released) yield* options.released?.(input) ?? Effect.void;
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

export interface RunRelease {
	readonly sessionId: string;
	readonly runId: string;
	readonly runnerId: string;
	readonly commandId: string;
	readonly transmission: number;
	readonly reason: "Refused" | "NotSent" | "JournalAbsent" | "ResumeRejected";
	readonly refusalReason?: "exiting" | "retiring" | "interrupted";
}

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
	readonly recoverable?: (row: {
		readonly sessionId: string;
		readonly driverKind: string;
	}) => Effect.Effect<boolean, SessionFailure>;
	readonly committed: (
		record: RunnerRetirement,
	) => Effect.Effect<void, unknown>;
	readonly shutdown: (record: RunnerRetirement) => Effect.Effect<void, unknown>;
	readonly settle: (
		record: RunnerRetirement,
	) => Effect.Effect<boolean, unknown>;
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
								if (!(yield* options.settle(record))) return;
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
			recover: () =>
				Effect.gen(function* () {
					const recovered = yield* refreshRows();
					const retirements = yield* options.receipts?.retirements(
						recovered.rows.map((row) => row.runnerId),
					) ?? Effect.succeed({ rows: [], rejected: [] });
					for (const record of retirements.rows) {
						if (options.recoverable && !(yield* options.recoverable(record)))
							continue;
						if (get(record.runnerId)._tag !== "Running") continue;
						setStop(record.runnerId, stoppedState(record));
						watch(record.runnerId);
					}
					// Startup registers these intents and does not wait on their
					// commits; a busy store must not hold up reattachment.
					for (const row of recovered.rows) {
						if (options.recoverable && !(yield* options.recoverable(row)))
							continue;
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
