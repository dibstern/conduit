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
	type RunnerRow,
	type RunnerSignal,
	type RunnerSignalAttempt,
	type StopReason,
} from "./runner-receipts.js";
import type { RunnerProcessTable } from "./runner-registry.js";
import { retryRunnerPersistence, runnerRetrySchedule } from "./runner-retry.js";
import {
	type SendEvidence,
	type SettlementTx,
	type StoreFault,
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
			stop: Effect.Effect<A, E, R>,
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
							const [serving] = yield* sql`SELECT 1 FROM claude_runner_cursors
					WHERE runner_id = ${input.runnerId} AND session_id = ${input.sessionId} AND role = 'serving' AND retired_at IS NULL`;
							return { released, stop: serving ? yield* stop : undefined };
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
			readonly waiters: Deferred.Deferred<void, SessionFailure>;
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
	| { readonly _tag: "Commit"; readonly record: RunnerRetirement }
	| { readonly _tag: "SendShutdown" }
	| { readonly _tag: "Signal"; readonly signal: "SIGTERM" | "SIGKILL" }
	| { readonly _tag: "Settle" | "Evict" | "Prune" | "Notice" };
type StopObservation =
	| {
			readonly _tag: "Request";
			readonly record: RunnerRetirement;
			readonly waiters: Deferred.Deferred<void, SessionFailure>;
	  }
	| { readonly _tag: "Committed"; readonly record: RunnerRetirement }
	| { readonly _tag: "CommitFailed" }
	| {
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
	if (observation._tag === "Request")
		return state._tag === "Running"
			? {
					state: { _tag: "Committing", waiters: observation.waiters },
					actions: [{ _tag: "Commit", record: observation.record }],
				}
			: { state, actions: [] };
	if (observation._tag === "Committed")
		return { state: stoppedState(observation.record), actions: [] };
	if (observation._tag === "CommitFailed")
		return { state: { _tag: "Running" }, actions: [] };
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
	const gone = decideRunnerKill(record, observation.processes).gone;
	const elapsed = observation.now - (record.stopStartedAt ?? record.retiredAt);
	const term = record.signalLog.find(
		(attempt) => attempt.signal === "SIGTERM" && attempt.at !== undefined,
	);
	const kill = record.signalLog.some((attempt) => attempt.signal === "SIGKILL");
	// The bounded Stop waiter can finish while Gone/settlement writes retry.
	// This transition uses the intent's durable timestamp even if a log failed.
	if (
		(state._tag === "Escalating" || gone) &&
		elapsed >= 4_000 &&
		(gone || kill) &&
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
		stop?: Effect.Effect<A, unknown>,
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
		const serving = (sessionId: string) =>
			[...rows.values()].find(
				(row) =>
					row.sessionId === sessionId &&
					row.role === "serving" &&
					row.retiredAt === null,
			)?.runnerId;
		const refreshRows = () =>
			Effect.gen(function* () {
				if (!options.receipts)
					return { rows: [...rows.values()], rejected: [] };
				const recovered = yield* options.receipts.runners();
				rows.clear();
				for (const row of recovered.rows) rows.set(row.runnerId, row);
				return recovered;
			});
		const retirementForRow = (row: RunnerRow): RunnerRetirement => ({
			runnerId: row.runnerId,
			sessionId: row.sessionId,
			driverKind: row.driverKind,
			identity: row.identity,
			reaper: row.reaper,
			members: [],
			signalLog: [],
			signal: { tag: "None" },
			retirement: { tag: "Watching" },
			ownedRunIds: [],
			retiredAt: clock.currentTimeMillisUnsafe(),
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
				for (let step = 0; step < 5; step++) {
					if (!("record" in state) || state._tag === "Settled") return;
					const processes = observeRunnerRetirement(
						state.record,
						options.processTable,
					);
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
						now: clock.currentTimeMillisUnsafe(),
						processes,
						retry: retryPending,
						notice: noticePending,
					});
					let record: RunnerRetirement = state.record;
					for (const action of decision.actions) {
						switch (action._tag) {
							case "Commit":
								break;
							case "SendShutdown":
								yield* options
									.shutdown(record)
									.pipe(
										Effect.interruptible,
										Effect.timeout("1 second"),
										Effect.ignore,
									);
								break;
							case "Signal":
								record = (yield* runRunnerKill(
									record,
									options.processTable,
									options.receipts,
									action.signal,
									processes,
								)).record;
								retryPending = false;
								break;
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
					states.set(runnerId, next);
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
						if (
							clock.currentTimeMillisUnsafe() - startedAt > 4_000 &&
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
						yield* leaderExit && healthy
							? Effect.raceFirst(leaderExit, Effect.sleep(delay))
							: Effect.sleep(delay);
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
		const prepareStop = (record: RunnerRetirement, reason: StopReason) =>
			Effect.gen(function* () {
				const registered = options.receipts
					? yield* options.receipts.runners()
					: { rows: [...rows.values()], rejected: [] };
				const rejected = registered.rejected.find(
					(error) => error.runnerId === record.runnerId,
				);
				if (rejected) return yield* Effect.fail(rejected);
				const candidates =
					reason._tag !== "Superseded" &&
					registered.rows.some(
						(row) =>
							row.runnerId === record.runnerId &&
							row.role === "serving" &&
							row.retiredAt === null,
					)
						? registered.rows
								.filter(
									(row) =>
										row.sessionId === record.sessionId &&
										row.role === "candidate" &&
										row.retiredAt === null,
								)
								.map((row) => {
									const candidate = retirementForRow(row);
									return decideRunnerKill(
										candidate,
										observeRunnerRetirement(candidate, options.processTable),
									).record;
								})
						: [];
				return { candidates, registered: registered.rows };
			});
		const afterStop = (
			record: RunnerRetirement,
			reason: StopReason,
			snapshot: {
				readonly candidates: readonly RunnerRetirement[];
				readonly registered: readonly RunnerRow[];
			},
			waiters: Deferred.Deferred<void, SessionFailure>,
		) =>
			Effect.gen(function* () {
				const committed = record;
				// Update the route cache before cleanup can release admission waiters.
				// A failed refresh cannot undo the already committed transaction.
				for (const retired of [committed, ...snapshot.candidates]) {
					const row =
						rows.get(retired.runnerId) ??
						snapshot.registered.find(
							(row) => row.runnerId === retired.runnerId,
						);
					if (row)
						rows.set(retired.runnerId, {
							...row,
							retiredAt: retired.retiredAt,
						});
				}
				if (reason._tag === "Superseded") {
					const successor =
						rows.get(reason.successor) ??
						snapshot.registered.find(
							(row) => row.runnerId === reason.successor,
						);
					if (successor)
						rows.set(successor.runnerId, { ...successor, role: "serving" });
				}
				states.set(
					record.runnerId,
					decideRunnerStop(get(record.runnerId), {
						_tag: "Committed",
						record: committed,
					}).state,
				);
				yield* options
					.committed(committed)
					.pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning(
								"Runner stop fence cleanup failed; retaining intent",
								cause,
							),
						),
					);
				yield* Deferred.succeed(waiters, undefined);
				watch(record.runnerId);
				for (const candidate of snapshot.candidates) {
					states.set(candidate.runnerId, stoppedState(candidate));
					watch(candidate.runnerId);
				}
			});
		const requestStop = (
			record: RunnerRetirement,
			reason: StopReason = { _tag: "Explicit" },
		): Effect.Effect<void, SessionFailure> =>
			Effect.uninterruptible(
				Effect.gen(function* () {
					let current = get(record.runnerId);
					if (current._tag === "Committing") {
						yield* Deferred.await(current.waiters);
						current = get(record.runnerId);
					}
					if (current._tag !== "Running") {
						if (
							reason._tag === "Superseded" &&
							(yield* refreshRows().pipe(
								Effect.mapError((cause) =>
									runnerFailure("read serving runner", cause),
								),
							)).rows.find(
								(row) =>
									row.sessionId === record.sessionId &&
									row.role === "serving" &&
									row.retiredAt === null,
							)?.runnerId !== reason.successor
						)
							return yield* Effect.fail(
								runnerFailure("stop runner", "A different Stop won the swap"),
							);
						return;
					}
					const waiters = yield* Deferred.make<void, SessionFailure>();
					const decision = decideRunnerStop(current, {
						_tag: "Request",
						record,
						waiters,
					});
					states.set(record.runnerId, decision.state);
					const observed = decideRunnerKill(
						record,
						observeRunnerRetirement(record, options.processTable),
					).record;
					const result = yield* Effect.exit(
						Effect.gen(function* () {
							const { candidates, registered } = yield* prepareStop(
								record,
								reason,
							);
							const committed = options.receipts
								? yield* options.receipts.requestStop(
										observed,
										reason,
										candidates,
									)
								: { ...observed, stopReason: JSON.stringify(reason) };
							return { committed, candidates, registered };
						}),
					);
					if (Exit.isFailure(result)) {
						states.set(
							record.runnerId,
							decideRunnerStop(decision.state, { _tag: "CommitFailed" }).state,
						);
						// The store fault stays classifiable by toStoreFault for its callers.
						const failure = {
							...runnerFailure("stop runner", result.cause),
							cause: Option.getOrUndefined(Failure.firstFailure(result.cause)),
						};
						yield* Deferred.fail(waiters, failure);
						return yield* Effect.fail(failure);
					}
					yield* afterStop(
						result.value.committed,
						reason,
						result.value,
						waiters,
					);
				}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
			);
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
					const waiters = yield* Deferred.make<void, SessionFailure>();
					states.set(input.runnerId, { _tag: "Committing", waiters });
					const result = yield* Effect.exit(
						persistRelease(
							input,
							Effect.gen(function* () {
								// releaseRun invokes this only for its SQL serving row, in
								// the same transaction as the matching release evidence.
								const registered = yield* refreshRows();
								const rejected = registered.rejected.find(
									(error) => error.runnerId === input.runnerId,
								);
								if (rejected) return yield* Effect.fail(rejected);
								const row = registered.rows.find(
									(row) =>
										row.runnerId === input.runnerId &&
										row.sessionId === input.sessionId,
								);
								if (!row)
									return yield* Effect.fail(
										runnerFailure(
											"release run",
											"Serving runner row is missing",
										),
									);
								const record = retirementForRow(row);
								const snapshot = yield* prepareStop(record, reason);
								const observed = decideRunnerKill(
									record,
									observeRunnerRetirement(record, options.processTable),
								).record;
								const committed = options.receipts
									? yield* options.receipts.requestStopMutation(
											observed,
											reason,
											snapshot.candidates,
										)
									: { ...observed, stopReason: JSON.stringify(reason) };
								return { record: committed, snapshot };
							}),
						),
					);
					if (Exit.isFailure(result)) {
						states.set(input.runnerId, current);
						const failure = {
							...runnerFailure("release run", result.cause),
							cause:
								Option.getOrUndefined(Failure.firstFailure(result.cause)) ??
								result.cause,
						};
						yield* Deferred.fail(waiters, failure);
						return yield* Effect.fail(failure);
					}
					// The handle must leave the releasing runner before revocation or
					// admission waiters can trigger any retirement cleanup.
					if (result.value.released)
						yield* options.released?.(input) ?? Effect.void;
					if (result.value.released && result.value.stop)
						yield* afterStop(
							result.value.stop.record,
							reason,
							result.value.stop.snapshot,
							waiters,
						);
					else {
						states.set(input.runnerId, current);
						yield* Deferred.succeed(waiters, undefined);
					}
				}).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
			);
		return {
			state: get,
			serving,
			servingEffect: (sessionId: string) =>
				refreshRows().pipe(Effect.map(() => serving(sessionId))),
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
						states.set(record.runnerId, stoppedState(record));
						watch(record.runnerId);
					}
					for (const row of recovered.rows) {
						if (options.recoverable && !(yield* options.recoverable(row)))
							continue;
						if (row.retiredAt !== null) continue;
						if (row.role === "candidate")
							yield* requestStop(retirementForRow(row), {
								_tag: "CandidateAbandoned",
							});
						else if (row.identity.pid !== undefined) {
							const observed = options.processTable.inspect(row.identity.pid);
							if (
								observed.state === "gone" ||
								observed.state === "zombie" ||
								(row.identity.tag === "Verified" &&
									observed.startTime !== undefined &&
									observed.startTime !== row.identity.startTime)
							)
								yield* requestStop(retirementForRow(row), { _tag: "Exited" });
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
					const wait = observe.pipe(
						Effect.repeat({
							while: (state) =>
								state._tag !== "Settled" &&
								(target !== "Escalated" ||
									(state._tag !== "Escalated" && state._tag !== "Gone")),
							schedule: runnerRetrySchedule,
						}),
						Effect.asVoid,
					);
					if (target === "Settled") return yield* wait;
					const state = yield* observe.pipe(
						Effect.repeat({
							while: (state) =>
								state._tag === "Running" || state._tag === "Committing",
							schedule: runnerRetrySchedule,
						}),
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
