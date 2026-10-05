// Effect-idiomatic session status reconciliation poller.
//
// Full replacement for the imperative SessionStatusPoller class.
// Uses:
// - Ref<PollerState> for all mutable state
// - PubSub for "changed" event broadcasting
// - Schedule.spaced for polling interval
// - Effect.forkScoped for background fiber lifecycle
// - HashMap for immutable-friendly maps

import {
	Context,
	Data,
	Duration,
	Effect,
	Layer,
	PubSub,
	Ref,
	Schedule,
} from "effect";

import type { SessionStatus } from "../../../instance/sdk-types.js";
import { busySessionIds } from "../../../session-busy.js";

export const DEFAULT_RECONCILIATION_INTERVAL_MS = 7_000;

const POLLER_EVENT_BUFFER_CAPACITY = 64;
const STATUS_RECONCILIATION_MAX_RETRIES = 5;

/**
 * If a session has been "busy" for longer than this with no events,
 * it is flagged as stale and forcibly transitioned to idle. Sessions blocked
 * on an open question or permission are exempt: silence there is the user's.
 */
const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Payload published on the changed PubSub. */
export interface PollerChangedEvent {
	readonly statuses: Record<string, SessionStatus>;
	readonly statusesChanged: boolean;
}

export interface PollerState {
	/** Last known source statuses — the primary read value. */
	previousStatuses: Record<string, SessionStatus>;
	/** Last known raw statuses — used for change detection. */
	previousRaw: Record<string, SessionStatus>;
	/** Whether the first poll has completed (baseline established). */
	initialized: boolean;
	/** Guard against overlapping polls. */
	polling: boolean;
}

export const PollerState = {
	empty: (): PollerState => ({
		previousStatuses: {},
		previousRaw: {},
		initialized: false,
		polling: false,
	}),
};

export class PollerStateTag extends Context.Tag("PollerState")<
	PollerStateTag,
	Ref.Ref<PollerState>
>() {}

export class PollerPubSubTag extends Context.Tag("PollerPubSub")<
	PollerPubSubTag,
	PubSub.PubSub<PollerChangedEvent>
>() {}

export const makePollerStateLive = (
	initial?: Partial<PollerState>,
): Layer.Layer<PollerStateTag> =>
	Layer.effect(
		PollerStateTag,
		Ref.make({ ...PollerState.empty(), ...initial }),
	);

export const makePollerPubSubLive = (): Layer.Layer<PollerPubSubTag> =>
	Layer.effect(
		PollerPubSubTag,
		PubSub.sliding<PollerChangedEvent>({
			capacity: POLLER_EVENT_BUFFER_CAPACITY,
		}),
	);

export class PollerError extends Data.TaggedError("PollerError")<{
	readonly cause: string;
}> {}

/** Get the most recently polled source statuses. */
export const getCurrentStatuses = Effect.gen(function* () {
	const ref = yield* PollerStateTag;
	const state = yield* Ref.get(ref);
	return { ...state.previousStatuses };
}).pipe(Effect.withSpan("statusPoller.getCurrentStatuses"));

/** Busy itself, or an ancestor of a busy session. */
export const isBusyIn = (
	statuses: Readonly<Record<string, SessionStatus>>,
	sessionId: string,
	parents: ReadonlyMap<string, string> = new Map(),
): boolean =>
	busySessionIds(
		new Map(
			Object.entries(statuses).map(([id, status]) => [
				id,
				{ status: status.type, parentID: parents.get(id) },
			]),
		),
	).has(sessionId);

/** Completion/history guard; source statuses themselves remain unaugmented. */
export const isProcessing = (
	sessionId: string,
	parents: ReadonlyMap<string, string> = new Map(),
) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);
		return isBusyIn(state.previousStatuses, sessionId, parents);
	}).pipe(Effect.withSpan("statusPoller.isProcessing"));

/** Check if any session's status type changed or sessions were added/removed. */
const hasChanged = (
	prev: Record<string, SessionStatus>,
	next: Record<string, SessionStatus>,
): boolean => {
	const prevKeys = Object.keys(prev);
	const nextKeys = Object.keys(next);
	if (prevKeys.length !== nextKeys.length) return true;
	for (const key of nextKeys) {
		const prevStatus = prev[key];
		const nextStatus = next[key];
		if (!nextStatus) continue;
		if (!prevStatus) return true;
		if (prevStatus.type !== nextStatus.type) return true;
	}
	for (const key of prevKeys) {
		if (!(key in next)) return true;
	}
	return false;
};

// Poll (full cycle)

/** Dependencies for a poll cycle. */
export interface PollDeps<E = unknown, R = never> {
	/** Read source statuses (SQLite or REST), without UI augmentation. */
	readonly getRawStatuses: () => Effect.Effect<
		Record<string, SessionStatus>,
		E,
		R
	>;
	/** Stale-busy reconciliation deps (optional). */
	readonly reconciliation?: ReconciliationDeps;
}

/**
 * Single poll cycle: fetch statuses, detect changes, publish,
 * and run reconciliation.
 */
export const poll = <E, R>(deps: PollDeps<E, R>) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const pubsub = yield* PollerPubSubTag;
		const state = yield* Ref.get(ref);

		// Guard against overlapping polls
		if (state.polling) return;
		yield* Ref.update(ref, (s) => ({ ...s, polling: true }));

		const pollBody = Effect.gen(function* () {
			const raw = yield* deps.getRawStatuses();

			const current = raw;
			const currentState = yield* Ref.get(ref);

			if (!currentState.initialized) {
				// First poll — establish baseline, no event emitted
				yield* Ref.update(ref, (s) => ({
					...s,
					previousStatuses: current,
					previousRaw: raw,
					initialized: true,
				}));

				const busySessions = Object.entries(current)
					.filter(([, s]) => s.type === "busy" || s.type === "retry")
					.map(([id, s]) => `${id.slice(0, 12)}:${s.type}`);
				if (busySessions.length > 0) {
					yield* Effect.log(`INIT busy=[${busySessions.join(", ")}]`);
				}

				// Run initial reconciliation
				if (deps.reconciliation) {
					yield* runReconciliation(deps.reconciliation).pipe(
						Effect.catchAll((e) =>
							Effect.log(`initial reconciliation failed: ${String(e)}`),
						),
					);
				}
				return;
			}

			// Compare RAW statuses for the statusesChanged flag
			const statusesChanged = hasChanged(currentState.previousRaw, raw);

			if (statusesChanged) {
				const busySessions = Object.entries(current)
					.filter(([, s]) => s.type === "busy" || s.type === "retry")
					.map(([id, s]) => `${id.slice(0, 12)}:${s.type}`);
				yield* Effect.log(
					`CHANGED busy=[${busySessions.join(", ")}] total=${Object.keys(current).length}`,
				);
			}

			// Update state
			yield* Ref.update(ref, (s) => ({
				...s,
				previousStatuses: current,
				previousRaw: raw,
			}));

			// Publish to PubSub — always notify so monitoring reducer gets periodic evaluation
			yield* PubSub.publish(pubsub, { statuses: current, statusesChanged });

			// Run reconciliation
			if (deps.reconciliation) {
				yield* runReconciliation(deps.reconciliation).pipe(
					Effect.catchAll((e) =>
						Effect.log(`reconciliation failed: ${String(e)}`),
					),
				);
			}
		});

		yield* pollBody.pipe(
			Effect.ensuring(Ref.update(ref, (s) => ({ ...s, polling: false }))),
		);
	}).pipe(
		Effect.annotateLogs("component", "status-poller"),
		Effect.withSpan("statusPoller.poll"),
	);

export interface ReconciliationDeps {
	readonly getProjectedSessions: () => Effect.Effect<
		ReadonlyArray<{
			id: string;
			status: string;
			updated_at: number;
		}>,
		unknown
	>;
	/** Sessions blocked on an open question or permission prompt. */
	readonly getSessionsAwaitingUser: () => Effect.Effect<ReadonlySet<string>>;
	readonly injectCorrectiveEvent: (
		sessionId: string,
		status: string,
	) => Effect.Effect<void, unknown>;
}

const runReconciliation = (deps: ReconciliationDeps) =>
	Effect.gen(function* () {
		// Staleness check
		yield* Effect.gen(function* () {
			const sessions = yield* deps.getProjectedSessions();
			const awaitingUser = yield* deps.getSessionsAwaitingUser();
			const now = Date.now();
			for (const session of sessions) {
				if (
					session.status === "busy" &&
					now - session.updated_at > SESSION_STALE_THRESHOLD_MS &&
					!awaitingUser.has(session.id)
				) {
					const minutesStale = ((now - session.updated_at) / 60_000).toFixed(1);
					yield* Effect.log(
						`Session ${session.id.slice(0, 12)} has been busy for ${minutesStale}min — marking stale (idle)`,
					);
					yield* deps.injectCorrectiveEvent(session.id, "idle");
				}
			}
		}).pipe(
			Effect.catchAll((e) =>
				Effect.log(`staleness check failed: ${String(e)}`),
			),
		);
	}).pipe(Effect.withSpan("statusPoller.runReconciliation"));

/**
 * Start a long-running reconciliation loop as a scoped fiber.
 *
 * - Polls at `interval` (default 7s)
 * - Retries transient failures with exponential backoff (max 5 retries)
 * - Logs a warning if all retries are exhausted
 * - Returns a Fiber handle via forkScoped for lifecycle management
 */
export const startReconciliationLoop = <E, R>(
	pollDeps: PollDeps<E, R>,
	interval: Duration.DurationInput = Duration.millis(
		DEFAULT_RECONCILIATION_INTERVAL_MS,
	),
) =>
	poll(pollDeps).pipe(
		Effect.repeat(Schedule.spaced(interval)),
		Effect.retry(
			Schedule.exponential("2 seconds").pipe(
				Schedule.intersect(Schedule.recurs(STATUS_RECONCILIATION_MAX_RETRIES)),
			),
		),
		Effect.catchAll((e) =>
			Effect.logWarning("Reconciliation loop failed after retries", e),
		),
		Effect.forkScoped,
	);

// The production status poller exposes Effect programs. Synchronous reads at
// process boundaries should use an explicit relay read model/snapshot, not a
// runtime bridge into the poller Ref.

export interface SessionStatusPollerService {
	/** Register a callback for the "changed" broadcast event (via PubSub subscription). */
	on(
		event: "changed",
		callback: (
			statuses: Record<string, SessionStatus>,
			statusesChanged: boolean,
		) => void | Promise<void>,
	): Effect.Effect<void>;
	/** Start polling. Safe to call multiple times (idempotent). */
	start(): Effect.Effect<void>;
	/** Stop polling and clear the timer. */
	stop(): Effect.Effect<void>;
	/** Cancel all work and wait for in-flight operations to settle. */
	drain(): Effect.Effect<void>;
	/** Get the most recently polled statuses. */
	getCurrentStatuses(): Effect.Effect<Record<string, SessionStatus>>;
	/** Ownership from the last SQLite status read, separate from status values. */
	getSessionProviders(): Effect.Effect<ReadonlyMap<string, string>>;
	/** Check if a specific session is currently processing (busy or retry). */
	isProcessing(sessionId: string): Effect.Effect<boolean>;
	/** Retired compatibility hook; activity is derived by the client. */
	markMessageActivity(sessionId: string): Effect.Effect<void>;
	/** Retired compatibility hook; activity is derived by the client. */
	clearMessageActivity(sessionId: string): Effect.Effect<void>;
	/** Notify that SSE delivered a session.status:idle event. */
	notifySSEIdle(sessionId: string): Effect.Effect<void>;
}
