// ─── Shell Subscription (delta source #2) ────────────────────────────────────
// The concrete SubscriptionSource for the shell — the sidebar session list
// (whole `sessions` projection rows: title, provider, status, recency). It
// fulfils the ni8.2 ReadModelSubscription seam for the low-rate, coalesced
// tenant:
//
//   • snapshot — every session row, recency-ordered, with the session
//     projector's cursor as the sequence high-water mark, read in ONE
//     transaction (replaces the legacy full-refetch session_list broadcast).
//   • replay   — the durable log strictly after a cursor, paged past the
//     store's read limit, folded to ONE current-row delta per touched session.
//   • live     — the SessionEventBus (all sessions) filtered to the event
//     types that mutate the sessions projection, coalesced per session in a
//     50ms window, each flush re-querying the affected row.
//
// The shell CAN emit `remove`: a signalled session whose row is absent at
// re-query time has left the list (`session.deleted` tombstone, eviction).
// Coalescing lives ENTIRELY here — the orchestrator has zero coalesce logic.
//
// Re-query is sound because every producer choke point (ingestion, the persist
// path's commitAndSignal) projects BEFORE it publishes: at signal time the row
// already reflects the signalling event, so tagging a delta with the session's
// max signalled sequence never claims more than the row's true content.

import type { SqlError } from "@effect/sql/SqlError";
import { Chunk, Duration, Effect, Stream } from "effect";
import {
	type EventStoreEffect,
	EventStoreEffectTag,
	type EventStoreError,
} from "../../../persistence/effect/event-store-effect.js";
import {
	type ReadQueryEffect,
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import type {
	CanonicalEventType,
	StoredEvent,
} from "../../../persistence/events.js";
import { SessionProjector } from "../../../persistence/projectors/session-projector.js";
import type { SessionRow } from "../../../persistence/read-model-types.js";
import {
	type Delta,
	type Envelope,
	type SubscriptionSource,
	stream,
} from "./read-model-subscription.js";
import {
	type SessionEventBus,
	SessionEventBusTag,
} from "./session-event-bus.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ShellSubscriptionError =
	| ReadQueryEffectError
	| EventStoreError
	| SqlError;

/**
 * Per-session coalesce window: a burst of change signals for one session
 * within this window collapses to a single row re-query and a single upsert.
 * (t3code prior art: SHELL_COALESCE_WINDOW.)
 */
export const SHELL_COALESCE_WINDOW = Duration.millis(50);

/**
 * Single source of truth for "which events can change a shell row": exactly
 * the event types the session projector declares as handled. Anything else on
 * the bus (per-token message/part traffic) cannot change the sessions table
 * and must not trigger re-queries.
 */
const SHELL_RELEVANT_TYPES: ReadonlySet<CanonicalEventType> = new Set(
	new SessionProjector().handles,
);

/** Store page size for replay — matches the event store's default read limit. */
const REPLAY_PAGE_SIZE = 1000;

// The 50ms duration is the operative window bound; the count bound exists only
// because groupedWithin requires one.
const WINDOW_COUNT_BOUND = Number.MAX_SAFE_INTEGER;

// ─── Coalesce fold ───────────────────────────────────────────────────────────

/** Fold events to each touched session's highest signalled sequence. */
const foldMaxSequenceBySession = (
	events: Iterable<StoredEvent>,
	into: Map<string, number> = new Map(),
): Map<string, number> => {
	const mark = (sessionId: string, sequence: number) => {
		const previous = into.get(sessionId);
		if (previous === undefined || sequence > previous) {
			into.set(sessionId, sequence);
		}
	};
	for (const event of events) {
		if (!SHELL_RELEVANT_TYPES.has(event.type)) continue;
		mark(event.sessionId, event.sequence);
		// A parent tombstone also nulls each child's `parent_id` via the projector
		// cascade, so those rows changed too. The ids ride IN the payload (stamped
		// pre-cascade by deleteSession) because replay folds stored payloads —
		// post-cascade the children can no longer be found by parent. Defensive:
		// historical tombstones without the field behave exactly as before.
		if (event.type === "session.deleted") {
			const childIds = event.data.childSessionIds;
			if (Array.isArray(childIds)) {
				for (const childId of childIds) mark(childId, event.sequence);
			}
		}
	}
	return into;
};

/**
 * Re-query each touched session's CURRENT row, emitting one whole-row upsert
 * per session — or a `remove` when the row is absent (the session left the
 * list) — ascending by sequence tag (t3code: re-sorted ascending).
 */
const toCurrentRowDeltas = (
	readQuery: ReadQueryEffect,
	maxSequenceBySession: ReadonlyMap<string, number>,
): Effect.Effect<readonly Delta<SessionRow>[], ShellSubscriptionError> =>
	Effect.gen(function* () {
		const ordered = [...maxSequenceBySession.entries()].sort(
			(a, b) => a[1] - b[1],
		);
		const deltas: Delta<SessionRow>[] = [];
		for (const [sessionId, sequence] of ordered) {
			const row = yield* readQuery.getSession(sessionId);
			deltas.push(
				row === undefined
					? { _tag: "remove", id: sessionId, sequence }
					: { _tag: "upsert", item: row, sequence },
			);
		}
		return deltas;
	});

// ─── Replay ──────────────────────────────────────────────────────────────────

/**
 * Fold the durable log strictly after `afterSequence` into one current-row
 * delta per touched session, ascending. Pages until an EMPTY read — not merely
 * a short page — so an event committed while the previous page drained (whose
 * live signal the sliding bus may already have dropped) is still folded in.
 * A coalesced replay is complete for this source: upserts carry whole current
 * rows, so intermediate states are subsumed and resume is O(touched sessions).
 */
const replayDeltas = (
	deps: {
		readonly readQuery: ReadQueryEffect;
		readonly eventStore: EventStoreEffect;
	},
	afterSequence: number,
): Stream.Stream<Delta<SessionRow>, ShellSubscriptionError> =>
	Stream.fromIterableEffect(
		Effect.gen(function* () {
			const touched = new Map<string, number>();
			let cursor = afterSequence;
			while (true) {
				const page = yield* deps.eventStore.readFromSequence(
					cursor,
					REPLAY_PAGE_SIZE,
				);
				const last = page[page.length - 1];
				if (last === undefined) break;
				foldMaxSequenceBySession(page, touched);
				cursor = last.sequence;
			}
			return yield* toCurrentRowDeltas(deps.readQuery, touched);
		}),
	);

// ─── Source adapter ──────────────────────────────────────────────────────────

export const makeShellSource = (deps: {
	readonly readQuery: ReadQueryEffect;
	readonly eventStore: EventStoreEffect;
	readonly bus: SessionEventBus;
}): SubscriptionSource<SessionRow, ShellSubscriptionError> => ({
	snapshot: () => deps.readQuery.getSessionListSnapshot(),
	replay: (afterSequence) => replayDeltas(deps, afterSequence),
	// One shared 50ms window over the type-filtered bus stream, then per-session
	// aggregation inside each flushed window. Not per-session anchored timers
	// (same observable outcome, more machinery) and not debounce (starves under
	// continuous activity). Idle windows emit nothing.
	live: () =>
		deps.bus.subscribe().pipe(
			Effect.map((events) =>
				events.pipe(
					Stream.filter((event) => SHELL_RELEVANT_TYPES.has(event.type)),
					Stream.groupedWithin(WINDOW_COUNT_BOUND, SHELL_COALESCE_WINDOW),
					Stream.filter(Chunk.isNonEmpty),
					Stream.mapConcatEffect((window) =>
						toCurrentRowDeltas(
							deps.readQuery,
							foldMaxSequenceBySession(window),
						),
					),
				),
			),
		),
});

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Subscribe to the shell (session-list) stream. Cold start emits the full
 * recency-ordered snapshot, a `synchronized` boundary, then coalesced
 * whole-row upserts (or removes); resume emits one current-row delta per
 * session touched strictly after `resumeFromSequence`, then goes live.
 * Lifecycle is the ambient Scope: closing it releases the bus subscription
 * and the coalescing pipeline.
 *
 * The event store, read-query service, and SessionEventBus are taken from
 * context so the transport (ni8.5) provides them once at the composition root.
 */
export const subscribeShell = (
	options: { readonly resumeFromSequence?: number } = {},
): Stream.Stream<
	Envelope<SessionRow>,
	ShellSubscriptionError,
	ReadQueryEffectTag | EventStoreEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const eventStore = yield* EventStoreEffectTag;
			const bus = yield* SessionEventBusTag;
			const source = makeShellSource({ readQuery, eventStore, bus });
			return stream(
				options.resumeFromSequence === undefined
					? { source }
					: { source, resumeFromSequence: options.resumeFromSequence },
			);
		}),
	);
