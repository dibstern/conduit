// ─── SessionStatusPoller — Effect-native ────────────────────────────────────
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
	Cause,
	Context,
	Data,
	Duration,
	Effect,
	HashMap,
	Layer,
	PubSub,
	Ref,
	Schedule,
} from "effect";

import type { SessionStatus } from "../instance/sdk-types.js";
import { computeAugmentedStatuses } from "../session/status-augmentation.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_RECONCILIATION_INTERVAL_MS = 7_000;

const STATUS_CORRECTION_CONCURRENCY = 8;

/**
 * How long a message-activity busy flag stays valid after the last
 * markMessageActivity() call. 10s = ~13 polls at 750ms.
 */
const MESSAGE_ACTIVITY_TTL_MS = 10_000;

/**
 * If a session has been "busy" for longer than this with no events,
 * it is flagged as stale and forcibly transitioned to idle.
 */
const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

// ─── Domain types ──────────────────────────────────────────────────────────

/** Status correction needed: DB and API disagree. */
export interface StatusCorrection {
	sessionId: string;
	expected: string;
	actual: string;
}

/** Payload published on the changed PubSub. */
export interface PollerChangedEvent {
	readonly statuses: Record<string, SessionStatus>;
	readonly statusesChanged: boolean;
}

/** Session status info for reconciliation (flat id+status). */
export interface SessionStatusInfo {
	id: string;
	status: string;
}

// ─── PollerState ────────────────────────────────────────────────────────────

export interface PollerState {
	/** Last known statuses (augmented) — the primary read value. */
	previousStatuses: Record<string, SessionStatus>;
	/** Last known raw statuses — used for change detection. */
	previousRaw: Record<string, SessionStatus>;
	/** Message activity timestamps per session. */
	activityTimestamps: HashMap.HashMap<string, number>;
	/** Child-to-parent cache for subagent propagation. */
	childToParentCache: HashMap.HashMap<string, string | undefined>;
	/** Sessions that SSE has confirmed as idle. */
	sseIdleSessions: ReadonlySet<string>;
	/** Whether the first poll has completed (baseline established). */
	initialized: boolean;
	/** Guard against overlapping polls. */
	polling: boolean;
}

export const PollerState = {
	empty: (): PollerState => ({
		previousStatuses: {},
		previousRaw: {},
		activityTimestamps: HashMap.empty(),
		childToParentCache: HashMap.empty(),
		sseIdleSessions: new Set(),
		initialized: false,
		polling: false,
	}),
};

// ─── Context Tags ─────────────────────────────────────────────────────────

export class PollerStateTag extends Context.Tag("PollerState")<
	PollerStateTag,
	Ref.Ref<PollerState>
>() {}

export class PollerPubSubTag extends Context.Tag("PollerPubSub")<
	PollerPubSubTag,
	PubSub.PubSub<PollerChangedEvent>
>() {}

// ─── Layer factories ──────────────────────────────────────────────────────

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
		PubSub.sliding<PollerChangedEvent>({ capacity: 64 }),
	);

// ─── Errors ───────────────────────────────────────────────────────────────

export class PollerError extends Data.TaggedError("PollerError")<{
	readonly cause: string;
}> {}

// ─── Status reading operations ──────────────────────────────────────────

/** Get the most recently polled (augmented) statuses. */
export const getCurrentStatuses = Effect.gen(function* () {
	const ref = yield* PollerStateTag;
	const state = yield* Ref.get(ref);
	return { ...state.previousStatuses };
}).pipe(Effect.withSpan("statusPoller.getCurrentStatuses"));

/** Check if a specific session is currently processing (busy or retry). */
export const isProcessing = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);
		const status = state.previousStatuses[sessionId];
		if (!status) return false;
		return status.type === "busy" || status.type === "retry";
	}).pipe(Effect.withSpan("statusPoller.isProcessing"));

// ─── Message activity operations ────────────────────────────────────────

/** Mark a session as busy due to message-poller activity. */
export const markMessageActivity = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);

		// If SSE has confirmed this session is idle, ignore stale activity
		if (state.sseIdleSessions.has(sessionId)) return;

		const isNew = !HashMap.has(state.activityTimestamps, sessionId);
		yield* Ref.update(ref, (s) => ({
			...s,
			activityTimestamps: HashMap.set(
				s.activityTimestamps,
				sessionId,
				Date.now(),
			),
		}));

		if (isNew) {
			yield* Effect.log(
				`message-activity BUSY session=${sessionId.slice(0, 12)}`,
			);
		}
	}).pipe(
		Effect.annotateLogs("component", "status-poller"),
		Effect.withSpan("statusPoller.markMessageActivity"),
	);

/** Clear the message-activity busy flag for a session. */
export const clearMessageActivity = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);
		if (HashMap.has(state.activityTimestamps, sessionId)) {
			yield* Ref.update(ref, (s) => ({
				...s,
				activityTimestamps: HashMap.remove(s.activityTimestamps, sessionId),
			}));
			yield* Effect.log(
				`message-activity CLEARED session=${sessionId.slice(0, 12)}`,
			);
		}
	}).pipe(
		Effect.annotateLogs("component", "status-poller"),
		Effect.withSpan("statusPoller.clearMessageActivity"),
	);

/** Notify that SSE delivered a session.status:idle event. */
export const notifySSEIdle = (sessionId: string) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		yield* Ref.update(ref, (s) => ({
			...s,
			sseIdleSessions: new Set([...s.sseIdleSessions, sessionId]),
			// Clear message activity for this session
			activityTimestamps: HashMap.remove(s.activityTimestamps, sessionId),
		}));
		yield* Effect.log(
			`SSE idle hint for session=${sessionId.slice(0, 12)} — cleared activity`,
		);
	}).pipe(
		Effect.annotateLogs("component", "status-poller"),
		Effect.withSpan("statusPoller.notifySSEIdle"),
	);

// ─── Status diff ────────────────────────────────────────────────────────

/**
 * Compute corrections needed: DB statuses that disagree with API statuses.
 * The API is treated as the source of truth.
 */
export const diffStatuses = (
	_previous: HashMap.HashMap<string, string>,
	dbStatuses: SessionStatusInfo[],
	apiStatuses: SessionStatusInfo[],
): StatusCorrection[] => {
	const apiMap = HashMap.fromIterable(
		apiStatuses.map((s) => [s.id, s.status] as const),
	);
	const corrections: StatusCorrection[] = [];
	for (const dbSession of dbStatuses) {
		const apiStatus = HashMap.get(apiMap, dbSession.id);
		if (apiStatus._tag === "Some" && apiStatus.value !== dbSession.status) {
			corrections.push({
				sessionId: dbSession.id,
				expected: apiStatus.value,
				actual: dbSession.status,
			});
		}
	}
	return corrections;
};

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

// ─── Reconcile ─────────────────────────────────────────────────────────────

/**
 * Single reconciliation pass: fetch DB + API statuses, diff, apply corrections,
 * then update the Ref with the latest API statuses.
 */
export const reconcile = (
	db: { getSessionStatuses: () => Effect.Effect<SessionStatusInfo[]> },
	api: { getSessionStatuses: () => Effect.Effect<SessionStatusInfo[]> },
	applyCorrection: (c: StatusCorrection) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);

		const dbSessions = yield* db.getSessionStatuses();
		const apiSessions = yield* api
			.getSessionStatuses()
			.pipe(Effect.retry(Schedule.once));

		const prevMap = HashMap.fromIterable(
			Object.entries(state.previousStatuses).map(
				([id, s]) => [id, s.type] as const,
			),
		);

		const corrections = diffStatuses(prevMap, dbSessions, apiSessions);

		yield* Effect.forEach(corrections, applyCorrection, {
			concurrency: STATUS_CORRECTION_CONCURRENCY,
			discard: true,
		});
	}).pipe(Effect.withSpan("statusPoller.reconcile"));

// ─── Poll (full cycle) ─────────────────────────────────────────────────────

/** Dependencies for a poll cycle. */
export interface PollDeps {
	/** Read raw statuses (SQLite or REST). */
	readonly getRawStatuses: () => Effect.Effect<
		Record<string, SessionStatus>,
		// biome-ignore lint/suspicious/noExplicitAny: callers provide various error types; poll() handles all errors internally
		any
	>;
	/** Session parent map for subagent propagation. */
	readonly getSessionParentMap: () => Map<string, string>;
	/** Resolve unknown parent for a busy session. */
	readonly resolveParent: (sessionId: string) => Effect.Effect<
		string | undefined,
		// biome-ignore lint/suspicious/noExplicitAny: callers provide various error types; handled internally
		any
	>;
	/** REST reconciliation deps (optional). */
	readonly reconciliation?: ReconciliationDeps;
}

/**
 * Single poll cycle: fetch statuses, augment, detect changes, publish,
 * and run reconciliation.
 */
export const poll = (deps: PollDeps) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const pubsub = yield* PollerPubSubTag;
		const state = yield* Ref.get(ref);

		// Guard against overlapping polls
		if (state.polling) return;
		yield* Ref.update(ref, (s) => ({ ...s, polling: true }));

		const pollBody = Effect.gen(function* () {
			const raw = yield* deps.getRawStatuses();

			// Resolve unknown parents for busy sessions
			const parentMap = deps.getSessionParentMap();
			const busyIds = Object.entries(raw)
				.filter(([, s]) => s.type === "busy" || s.type === "retry")
				.map(([id]) => id);

			const freshState = yield* Ref.get(ref);
			let updatedCache = freshState.childToParentCache;

			for (const busyId of busyIds) {
				if (parentMap.has(busyId) || HashMap.has(updatedCache, busyId))
					continue;
				const parentId = yield* deps
					.resolveParent(busyId)
					.pipe(Effect.catchAll(() => Effect.succeed(undefined)));
				updatedCache = HashMap.set(updatedCache, busyId, parentId);
				if (parentId) {
					yield* Effect.log(
						`discovered child→parent: ${busyId.slice(0, 12)}→${parentId.slice(0, 12)}`,
					);
				}
			}

			if (updatedCache !== freshState.childToParentCache) {
				yield* Ref.update(ref, (s) => ({
					...s,
					childToParentCache: updatedCache,
				}));
			}

			// Augment statuses
			const stateForAugment = yield* Ref.get(ref);
			const childToParentResolved = new Map<string, string | undefined>();
			for (const [k, v] of HashMap.toEntries(
				stateForAugment.childToParentCache,
			)) {
				childToParentResolved.set(k, v);
			}

			const activityTimestamps = new Map<string, number>();
			for (const [k, v] of HashMap.toEntries(
				stateForAugment.activityTimestamps,
			)) {
				activityTimestamps.set(k, v);
			}

			const result = computeAugmentedStatuses({
				raw,
				parentMap,
				childToParentResolved,
				messageActivityTimestamps: activityTimestamps,
				sseIdleSessions: stateForAugment.sseIdleSessions,
				now: Date.now(),
				messageActivityTtlMs: MESSAGE_ACTIVITY_TTL_MS,
			});

			const current = result.augmented;

			// Apply side effects from augmentation
			let updatedActivityTimestamps = stateForAugment.activityTimestamps;
			for (const sessionId of result.expiredActivitySessions) {
				updatedActivityTimestamps = HashMap.remove(
					updatedActivityTimestamps,
					sessionId,
				);
				yield* Effect.log(
					`message-activity EXPIRED session=${sessionId.slice(0, 12)}`,
				);
			}

			const updatedSseIdle = new Set(stateForAugment.sseIdleSessions);
			for (const sessionId of result.sseIdleToRemove) {
				updatedSseIdle.delete(sessionId);
			}

			if (!stateForAugment.initialized) {
				// First poll — establish baseline, no event emitted
				yield* Ref.update(ref, (s) => ({
					...s,
					previousStatuses: current,
					previousRaw: raw,
					initialized: true,
					activityTimestamps: updatedActivityTimestamps,
					sseIdleSessions: updatedSseIdle,
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
			const statusesChanged = hasChanged(stateForAugment.previousRaw, raw);

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
				activityTimestamps: updatedActivityTimestamps,
				sseIdleSessions: updatedSseIdle,
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

// ─── Reconciliation helpers ────────────────────────────────────────────────

export interface ReconciliationDeps {
	readonly getRestStatuses: () => Effect.Effect<
		Record<string, SessionStatus>,
		// biome-ignore lint/suspicious/noExplicitAny: callers provide various error types; handled internally
		any
	>;
	readonly getProjectedSessions: () => Array<{
		id: string;
		status: string;
		updated_at: number;
	}>;
	readonly injectCorrectiveEvent: (
		sessionId: string,
		status: string,
	) => Effect.Effect<void>;
}

const runReconciliation = (deps: ReconciliationDeps) =>
	Effect.gen(function* () {
		// REST reconciliation
		yield* Effect.gen(function* () {
			const restStatuses = yield* deps.getRestStatuses();
			const sessions = deps.getProjectedSessions();
			const projectedMap = new Map<string, string>();
			for (const session of sessions) {
				projectedMap.set(session.id, session.status);
			}
			for (const [sessionId, restStatus] of Object.entries(restStatuses)) {
				const projectedStatus = projectedMap.get(sessionId);
				if (!projectedStatus) continue;
				if (restStatus.type !== projectedStatus) {
					yield* Effect.log(
						`reconciliation: status mismatch for session=${sessionId.slice(0, 12)}: REST=${restStatus.type} projected=${projectedStatus} — injecting corrective event`,
					);
					yield* deps.injectCorrectiveEvent(sessionId, restStatus.type);
				}
			}
		}).pipe(
			Effect.catchAll((e) =>
				Effect.log(`reconciliation check failed: ${String(e)}`),
			),
		);

		// Staleness check
		yield* Effect.gen(function* () {
			const sessions = deps.getProjectedSessions();
			const now = Date.now();
			for (const session of sessions) {
				if (
					session.status === "busy" &&
					now - session.updated_at > SESSION_STALE_THRESHOLD_MS
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

/** One-shot reconciliation for SSE reconnect. */
export const reconcileNow = (deps: ReconciliationDeps) =>
	runReconciliation(deps).pipe(
		Effect.catchAll((e) => Effect.log(`reconcileNow failed: ${String(e)}`)),
		Effect.annotateLogs("component", "status-poller"),
		Effect.withSpan("statusPoller.reconcileNow"),
	);

// ─── Reconciliation loop ──────────────────────────────────────────────────

/**
 * Start a long-running reconciliation loop as a scoped fiber.
 *
 * - Polls at `interval` (default 7s)
 * - Retries transient failures with exponential backoff (max 5 retries)
 * - Logs a warning if all retries are exhausted
 * - Returns a Fiber handle via forkScoped for lifecycle management
 */
export const startReconciliationLoop = (
	pollDeps: PollDeps,
	interval: Duration.DurationInput = Duration.millis(
		DEFAULT_RECONCILIATION_INTERVAL_MS,
	),
) =>
	poll(pollDeps).pipe(
		Effect.repeat(Schedule.spaced(interval)),
		Effect.retry(
			Schedule.exponential("2 seconds").pipe(
				Schedule.intersect(Schedule.recurs(5)),
			),
		),
		Effect.catchAll((e) =>
			Effect.logWarning("Reconciliation loop failed after retries", e),
		),
		Effect.forkScoped,
	);

// ─── Imperative facade ──────────────────────────────────────────────────────
// Thin wrapper that provides the old class API for wiring code that hasn't
// been fully converted to Effect. The facade delegates to the Effect functions
// above, running them via Effect.runSync/runPromise with a pre-built runtime.

export interface SessionStatusPollerService {
	/** Register a callback for the "changed" broadcast event (via PubSub subscription). */
	on(
		event: "changed",
		callback: (
			statuses: Record<string, SessionStatus>,
			statusesChanged: boolean,
		) => void | Promise<void>,
	): void;
	/** Start polling. Safe to call multiple times (idempotent). */
	start(): void;
	/** Stop polling and clear the timer. */
	stop(): void;
	/** Cancel all work and wait for in-flight operations to settle. */
	drain(): Promise<void>;
	/** Get the most recently polled statuses. */
	getCurrentStatuses(): Record<string, SessionStatus>;
	/** Check if a specific session is currently processing (busy or retry). */
	isProcessing(sessionId: string): boolean;
	/** Mark a session as busy due to message-poller activity. */
	markMessageActivity(sessionId: string): void;
	/** Clear the message-activity busy flag for a session. */
	clearMessageActivity(sessionId: string): void;
	/** Notify that SSE delivered a session.status:idle event. */
	notifySSEIdle(sessionId: string): void;
	/** One-shot reconciliation on SSE reconnect. */
	reconcileNow(): Promise<void>;
}

export interface StatusPollerRuntime {
	// biome-ignore lint/suspicious/noExplicitAny: status-poller facade runs effects with several context shapes
	runSync: <A, E>(effect: Effect.Effect<A, E, any>) => A;
	// biome-ignore lint/suspicious/noExplicitAny: status-poller facade runs effects with several context shapes
	runPromise: <A, E>(effect: Effect.Effect<A, E, any>) => Promise<A>;
}

export interface DeferredStatusPollerRuntime extends StatusPollerRuntime {
	attach(runtime: StatusPollerRuntime): void;
	isAttached(): boolean;
	onAttached(callback: () => void): void;
}

export class StatusPollerRuntimeNotAttachedError extends Error {
	constructor() {
		super("SessionStatusPoller runtime is not attached");
		this.name = "StatusPollerRuntimeNotAttachedError";
	}
}

const isDeferredRuntime = (
	runtime: StatusPollerRuntime,
): runtime is DeferredStatusPollerRuntime =>
	"attach" in runtime && "onAttached" in runtime && "isAttached" in runtime;

export function makeDeferredStatusPollerRuntime(): DeferredStatusPollerRuntime {
	let attachedRuntime: StatusPollerRuntime | null = null;
	const attachCallbacks: Array<() => void> = [];

	const getRuntime = () => {
		if (attachedRuntime === null) {
			throw new StatusPollerRuntimeNotAttachedError();
		}
		return attachedRuntime;
	};

	return {
		runSync: <A, E>(
			// biome-ignore lint/suspicious/noExplicitAny: runtime provides the service context after attach
			effect: Effect.Effect<A, E, any>,
		): A => getRuntime().runSync(effect),
		runPromise: <A, E>(
			// biome-ignore lint/suspicious/noExplicitAny: runtime provides the service context after attach
			effect: Effect.Effect<A, E, any>,
		): Promise<A> => {
			if (attachedRuntime === null) {
				return Promise.reject(new StatusPollerRuntimeNotAttachedError());
			}
			return attachedRuntime.runPromise(effect);
		},
		attach(runtime: StatusPollerRuntime): void {
			if (attachedRuntime !== null) {
				throw new Error("SessionStatusPoller runtime is already attached");
			}
			attachedRuntime = runtime;
			const callbacks = attachCallbacks.splice(0);
			let firstError: unknown;
			for (const callback of callbacks) {
				try {
					callback();
				} catch (error) {
					firstError ??= error;
				}
			}
			if (firstError) throw firstError;
		},
		isAttached: () => attachedRuntime !== null,
		onAttached(callback: () => void): void {
			if (attachedRuntime !== null) {
				callback();
				return;
			}
			attachCallbacks.push(callback);
		},
	};
}

/**
 * Create an imperative facade around the Effect-native poller.
 *
 * This bridges the gap: wiring code (relay-stack.ts, monitoring-wiring.ts)
 * uses the familiar class-like API, but all state lives in the Effect Ref
 * and events flow through PubSub.
 */
export function createStatusPollerService(config: {
	pollDeps: PollDeps;
	reconciliationDeps?: ReconciliationDeps;
	interval?: number;
	runtime: StatusPollerRuntime;
	onSubscriptionFailure?: (error: unknown) => void;
}): SessionStatusPollerService {
	const { pollDeps, reconciliationDeps, runtime } = config;
	const intervalMs = config.interval ?? DEFAULT_RECONCILIATION_INTERVAL_MS;
	let timer: ReturnType<typeof setInterval> | null = null;
	let startRequested = false;
	const pendingPromises = new Set<Promise<unknown>>();

	const trackPromise = <T>(promise: Promise<T>): Promise<T> => {
		pendingPromises.add(promise);
		promise.finally(() => pendingPromises.delete(promise)).catch(() => {});
		return promise;
	};

	const doPoll = () => {
		return runtime.runPromise(poll(pollDeps));
	};

	const whenRuntimeAttached = (callback: () => void): void => {
		if (isDeferredRuntime(runtime)) {
			runtime.onAttached(callback);
			return;
		}
		callback();
	};

	const startTimer = () => {
		if (!startRequested || timer) return;
		void trackPromise(doPoll());
		timer = setInterval(() => {
			void trackPromise(doPoll());
		}, intervalMs);
	};

	const reportSubscriptionFailure = (cause: Cause.Cause<unknown>) =>
		Cause.isInterruptedOnly(cause)
			? Effect.interrupt
			: Effect.sync(() => {
					try {
						config.onSubscriptionFailure?.(Cause.squash(cause));
					} catch {
						// The subscription is a lifecycle task; reporting failures must not
						// create another unhandled failure path.
					}
				});

	return {
		on(
			_event: "changed",
			callback: (
				statuses: Record<string, SessionStatus>,
				statusesChanged: boolean,
			) => void | Promise<void>,
		) {
			// Subscribe to the PubSub and forward to callback.
			// We run a background fiber that reads from the subscription.
			whenRuntimeAttached(() => {
				const subscription = Effect.gen(function* () {
					const pubsub = yield* PollerPubSubTag;
					// Use PubSub.subscribe to get a Dequeue, then read in a loop
					return yield* Effect.scoped(
						Effect.gen(function* () {
							const subscription = yield* PubSub.subscribe(pubsub);
							// Read loop in background
							yield* Effect.forever(
								Effect.gen(function* () {
									const event = yield* subscription.take;
									yield* Effect.try(() => {
										const result = callback(
											event.statuses,
											event.statusesChanged,
										);
										return result;
									}).pipe(
										Effect.flatMap((result) =>
											result instanceof Promise
												? Effect.tryPromise(() => result).pipe(
														Effect.catchAll(() => Effect.void),
													)
												: Effect.void,
										),
										Effect.catchAll(() => Effect.void),
									);
								}),
							);
						}),
					);
				}).pipe(Effect.catchAllCause(reportSubscriptionFailure));
				const fiber = runtime.runPromise(subscription);
				// The promise never resolves (infinite loop) — that's intentional.
				// It will be interrupted when the runtime is disposed.
				fiber.catch(() => {});
			});
		},

		start() {
			if (startRequested) return;
			startRequested = true;
			whenRuntimeAttached(startTimer);
		},

		stop() {
			startRequested = false;
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},

		async drain() {
			this.stop();
			await Promise.allSettled([...pendingPromises]);
			pendingPromises.clear();
		},

		getCurrentStatuses(): Record<string, SessionStatus> {
			return runtime.runSync(getCurrentStatuses);
		},

		isProcessing(sessionId: string): boolean {
			return runtime.runSync(isProcessing(sessionId));
		},

		markMessageActivity(sessionId: string): void {
			runtime.runSync(markMessageActivity(sessionId));
			// Trigger immediate re-poll so spinner shows up right away
			void trackPromise(doPoll());
		},

		clearMessageActivity(sessionId: string): void {
			runtime.runSync(clearMessageActivity(sessionId));
		},

		notifySSEIdle(sessionId: string): void {
			runtime.runSync(notifySSEIdle(sessionId));
			// Trigger immediate re-poll
			void trackPromise(doPoll());
		},

		async reconcileNow(): Promise<void> {
			if (!reconciliationDeps) return;
			await runtime.runPromise(reconcileNow(reconciliationDeps));
		},
	};
}
