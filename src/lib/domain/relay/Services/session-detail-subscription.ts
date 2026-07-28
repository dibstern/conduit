// ─── Session-Detail Subscription (delta source #1) ───────────────────────────
// The concrete SubscriptionSource for a session's detail view — the transcript
// of messages, streamed text, thinking, and tool activity. It fulfils the ni8.2
// ReadModelSubscription seam for the latency-sensitive, bursty tenant:
//
//   • snapshot — the projected transcript (durable; survives event eviction),
//     read with its sequence high-water mark in ONE transaction.
//   • replay   — the session's committed events strictly after a cursor, paged
//     past the store's page limit, each passed through RAW.
//   • live     — the SessionEventBus filtered by session, each event RAW.
//
// Detail is APPEND-ONLY: it emits `upsert` only, never `remove`. The client
// reducer seeds from the transcript rows and folds the raw events, applying
// set-type events (message/tool/turn lifecycle) idempotently — see the two-tier
// completeness contract in .scratch/foreman-auto/ni8-sources/ni8.3/01-spec.md.

import type { SqlError } from "@effect/sql/SqlError";
import { Chunk, Effect, Option, Stream } from "effect";
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
import type { StoredEvent } from "../../../persistence/events.js";
import { messageRowsToHistory } from "../../../persistence/session-history-adapter.js";
import type { HistoryMessage } from "../../../shared-types.js";
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

/**
 * A single detail row shared by snapshot and deltas, as the seam requires.
 * - `transcriptMessage`: a projected transcript message (snapshot rows only).
 * - `event`: a raw committed event (replay + live deltas).
 *
 * The two variants coexist because the snapshot must be the durable projected
 * transcript (it outlives raw-event eviction) while deltas must be raw events
 * (no re-query on the hot path) — and the orchestrator requires both to share
 * one `T`.
 */
export type SessionDetailItem =
	| { readonly _tag: "transcriptMessage"; readonly message: HistoryMessage }
	| { readonly _tag: "event"; readonly event: StoredEvent };

export type SessionDetailSubscriptionError =
	| ReadQueryEffectError
	| EventStoreError
	| SqlError;

// ─── Source adapter ──────────────────────────────────────────────────────────

/** Store page size for replay — matches the event store's default read limit. */
const REPLAY_PAGE_SIZE = 1000;

const eventToUpsert = (event: StoredEvent): Delta<SessionDetailItem> => ({
	_tag: "upsert",
	item: { _tag: "event", event },
	sequence: event.sequence,
});

/**
 * Replay ALL events strictly after `afterSequence`, ascending, paging past the
 * store's per-read limit. Pages until an EMPTY read — not merely a short page —
 * so an event committed while the previous page drained is still replayed from
 * the durable store. That matters because its live signal may already have been
 * dropped by the bus's sliding buffer; replay is the recovery path, so it must
 * chase the tail to the end. The final empty read terminates the stream.
 */
const replayEvents = (
	eventStore: EventStoreEffect,
	sessionId: string,
	afterSequence: number,
): Stream.Stream<Delta<SessionDetailItem>, SessionDetailSubscriptionError> =>
	Stream.paginateChunkEffect(afterSequence, (cursor) =>
		eventStore.readBySession(sessionId, cursor, REPLAY_PAGE_SIZE).pipe(
			Effect.map((events) => {
				const last = events[events.length - 1];
				const next = last ? Option.some(last.sequence) : Option.none<number>();
				return [Chunk.fromIterable(events.map(eventToUpsert)), next] as const;
			}),
		),
	);

const makeSessionDetailSource = (deps: {
	readonly sessionId: string;
	readonly readQuery: ReadQueryEffect;
	readonly eventStore: EventStoreEffect;
	readonly bus: SessionEventBus;
}): SubscriptionSource<SessionDetailItem, SessionDetailSubscriptionError> => ({
	snapshot: () =>
		deps.readQuery.getSessionDetailSnapshot(deps.sessionId).pipe(
			Effect.map(({ messages, sequence }) => ({
				rows: messageRowsToHistory(messages, {
					pageSize: messages.length,
				}).messages.map(
					(message): SessionDetailItem => ({
						_tag: "transcriptMessage",
						message,
					}),
				),
				sequence,
			})),
		),
	replay: (afterSequence) =>
		replayEvents(deps.eventStore, deps.sessionId, afterSequence),
	live: () =>
		deps.bus
			.subscribe({ sessionId: deps.sessionId })
			.pipe(Effect.map((events) => Stream.map(events, eventToUpsert))),
});

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Subscribe to a session's detail stream. Cold start emits the transcript
 * snapshot, a `synchronized` boundary, then raw event deltas; resume replays
 * missed events strictly after `resumeFromSequence`, then goes live. Lifecycle
 * is the ambient Scope: closing it releases the bus subscription.
 *
 * The event store, read-query service, and SessionEventBus are taken from
 * context so the transport (ni8.5) provides them once at the composition root.
 */
export const subscribeSessionDetail = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionDetailItem>,
	SessionDetailSubscriptionError,
	ReadQueryEffectTag | EventStoreEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const eventStore = yield* EventStoreEffectTag;
			const bus = yield* SessionEventBusTag;
			const source = makeSessionDetailSource({
				sessionId: options.sessionId,
				readQuery,
				eventStore,
				bus,
			});
			return stream(
				options.resumeFromSequence === undefined
					? { source }
					: { source, resumeFromSequence: options.resumeFromSequence },
			);
		}),
	);
