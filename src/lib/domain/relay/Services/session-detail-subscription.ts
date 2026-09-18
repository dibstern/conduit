// ─── Session-Detail Subscription (delta source #1) ───────────────────────────
// The concrete SubscriptionSource for a session's detail view — the transcript
// of messages, streamed text, thinking, and tool activity.
//
// Its rows are `messages`, which carry a read-model version, so the base read
// and every live re-query are one query: `WHERE session_id = ? AND version > ?`,
// the index 0012 created for exactly this. A message part carries no version of
// its own, so a part write advances the message that owns it and the whole
// current message comes back — which is why a delta here is a projected
// transcript message and not the raw event that caused it. The transcript is
// durable, so it also outlives event eviction.
//
// Detail is APPEND-ONLY: it emits `upsert` only, never `remove`. Its rows are
// keyed by message id and an advance speaks in sessions, so a removal has no id
// to name here; the session's own disappearance is the shell's to report.
// Resume is therefore a catch-up — the version alone is enough, which is the
// case the shell cannot make.

import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Stream } from "effect";
import type { SessionDetailItemSchema } from "../../../contracts/ws-rpc.js";
import {
	type ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../persistence/effect/read-query-effect.js";
import { messageRowsToHistory } from "../../../persistence/session-history-adapter.js";
import { type Envelope, stream } from "./read-model-subscription.js";
import { SessionEventBusTag } from "./session-event-bus.js";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A single detail row shared by the base and the deltas, as the seam requires.
 * - `transcriptMessage`: a projected transcript message — what this source
 *   streams, base and delta alike.
 * - `event`: a raw committed event. Still on the wire for the browser's legacy
 *   delta arm, which conduit-test-ni8.5.20 retires; nothing produces it here.
 */
export type SessionDetailItem = typeof SessionDetailItemSchema.Type;

export type SessionDetailSubscriptionError = ReadQueryEffectError | SqlError;

// ─── Public entry point ──────────────────────────────────────────────────────

/**
 * Subscribe to a session's detail stream. Cold start emits the transcript
 * snapshot, a `synchronized` boundary, then the messages that move; resume
 * replays only the messages that moved past `resumeFromSequence`, then goes
 * live. Lifecycle is the ambient Scope: closing it releases the advance
 * subscription.
 *
 * The read-query service and SessionEventBus are taken from context so the
 * transport (ni8.5) provides them once at the composition root.
 */
export const subscribeSessionDetail = (options: {
	readonly sessionId: string;
	readonly resumeFromSequence?: number;
}): Stream.Stream<
	Envelope<SessionDetailItem>,
	SessionDetailSubscriptionError,
	ReadQueryEffectTag | SessionEventBusTag
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const readQuery = yield* ReadQueryEffectTag;
			const bus = yield* SessionEventBusTag;
			return stream<SessionDetailItem, SessionDetailSubscriptionError>({
				bus,
				source: {
					read: (range) =>
						readQuery.readSessionTranscript(options.sessionId, range).pipe(
							Effect.map(({ messages, version }) => ({
								// A whole page: `hasMore` is false, so the adapter maps
								// every row in order and index `i` is still row `i`.
								// That is what lets each item keep the version its row
								// carries instead of borrowing the read's counter.
								rows: messageRowsToHistory(messages, {
									pageSize: messages.length,
								}).messages.map((message, index) => ({
									item: {
										_tag: "transcriptMessage" as const,
										message,
									} satisfies SessionDetailItem,
									version: messages[index]?.version ?? version,
								})),
								version,
							})),
						),
					// A message is stored against the session that owns it — a subagent
					// message against the subagent session — and the projector reports
					// that owner, so naming this session is the whole routing test.
					route: (advance) => ({
						moved: advance.sessionIds.includes(options.sessionId),
						removed: [],
					}),
					resume: "catchUp",
				},
				...(options.resumeFromSequence === undefined
					? {}
					: { resumeFromSequence: options.resumeFromSequence }),
			});
		}),
	);
