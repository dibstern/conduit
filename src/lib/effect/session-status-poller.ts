// ─── SessionStatusPoller — Schedule + Ref ──────────────────────────────────
// Effect-idiomatic session status reconciliation poller.
//
// Uses a single atomic Ref<PollerState> for all mutable state, with:
// - HashMap for immutable-friendly maps
// - Schedule.spaced for polling interval
// - Effect.retry with exponential backoff for transient failures
// - Effect.forkScoped for background fiber lifecycle

import {
	Context,
	Duration,
	Effect,
	HashMap,
	Layer,
	Ref,
	Schedule,
} from "effect";

// ─── Domain types ──────────────────────────────────────────────────────────

export interface SessionStatus {
	id: string;
	status: string;
}

export interface PollerState {
	previousStatuses: HashMap.HashMap<string, string>;
	activityTimestamps: HashMap.HashMap<string, number>;
	childToParentCache: HashMap.HashMap<string, string>;
	idleSessionTracking: HashMap.HashMap<string, number>;
}

export const PollerState = {
	empty: (): PollerState => ({
		previousStatuses: HashMap.empty(),
		activityTimestamps: HashMap.empty(),
		childToParentCache: HashMap.empty(),
		idleSessionTracking: HashMap.empty(),
	}),
};

// ─── Context Tag ───────────────────────────────────────────────────────────

export class PollerStateTag extends Context.Tag("PollerState")<
	PollerStateTag,
	Ref.Ref<PollerState>
>() {}

// ─── Layer factory ─────────────────────────────────────────────────────────

export const makePollerStateLive = (
	initial?: Partial<PollerState>,
): Layer.Layer<PollerStateTag> =>
	Layer.effect(
		PollerStateTag,
		Ref.make({ ...PollerState.empty(), ...initial }),
	);

// ─── Status correction ────────────────────────────────────────────────────

export interface StatusCorrection {
	sessionId: string;
	expected: string;
	actual: string;
}

/**
 * Compute corrections needed: DB statuses that disagree with API statuses.
 * The API is treated as the source of truth.
 */
export const diffStatuses = (
	_previous: HashMap.HashMap<string, string>,
	dbStatuses: SessionStatus[],
	apiStatuses: SessionStatus[],
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

// ─── Reconcile ─────────────────────────────────────────────────────────────

/**
 * Single reconciliation pass: fetch DB + API statuses, diff, apply corrections,
 * then update the Ref with the latest API statuses.
 */
export const reconcile = (
	db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
	api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
	applyCorrection: (c: StatusCorrection) => Effect.Effect<void>,
) =>
	Effect.gen(function* () {
		const ref = yield* PollerStateTag;
		const state = yield* Ref.get(ref);

		const dbSessions = yield* db.getSessionStatuses();
		const apiSessions = yield* api
			.getSessionStatuses()
			.pipe(Effect.retry(Schedule.once));

		const corrections = diffStatuses(
			state.previousStatuses,
			dbSessions,
			apiSessions,
		);

		yield* Effect.forEach(corrections, applyCorrection, {
			concurrency: "unbounded",
			discard: true,
		});

		const newStatuses = HashMap.fromIterable(
			apiSessions.map((s) => [s.id, s.status] as const),
		);
		yield* Ref.update(ref, (s) => ({ ...s, previousStatuses: newStatuses }));
	}).pipe(Effect.withSpan("statusPoller.reconcile"));

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
	db: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
	api: { getSessionStatuses: () => Effect.Effect<SessionStatus[]> },
	applyCorrection: (c: StatusCorrection) => Effect.Effect<void>,
	interval: Duration.DurationInput = Duration.seconds(7),
) =>
	reconcile(db, api, applyCorrection).pipe(
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
