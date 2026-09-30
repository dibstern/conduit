import { Schema } from "effect";

/**
 * "The read model advanced to N, and these sessions moved."
 *
 * One signal replaces three mechanisms: change notification, resume point, and
 * high-water-mark dedup. `version` is a read-model counter, not an event
 * sequence: it is bumped once per projection and only ever goes up, so a
 * replayed event — whose sequence is below the version its row already carries —
 * still stamps that row forward instead of stranding a subscriber at a version
 * that will never be exceeded. Every row a handler writes is stamped with it, so
 * a subscriber holding version V re-queries `WHERE version > V` and needs
 * nothing else to catch up.
 *
 * `sessionIds` is advisory routing, not the payload: it tells a subscriber
 * whether the advance can possibly concern it. It names the sessions that own
 * the rows the handlers actually wrote — derived from those writes' RETURNING,
 * not from the event header — so a statement that declined to write (a guarded
 * rename, an ignored INSERT) reports nothing, and a write filed under one
 * session but landing on another reports the one that moved.
 *
 * `removedSessionIds` is the same routing hint for sessions that are gone, and
 * it is a separate field because it asks for the opposite action: a subscriber
 * re-queries the first list and drops the second. Folding the two together
 * would leave a removal indistinguishable from a row the subscriber is not
 * allowed to see, and would send it to the database to find out — the "go look
 * it up" round trip the subscription exists to remove. The two are disjoint,
 * and routing is the union: a subscriber watching a session it is about to lose
 * finds it in the second list.
 */
export const ReadModelAdvanceSchema = Schema.Struct({
	version: Schema.Number,
	sessionIds: Schema.Array(Schema.String),
	removedSessionIds: Schema.Array(Schema.String),
});

export type ReadModelAdvance = typeof ReadModelAdvanceSchema.Type;
