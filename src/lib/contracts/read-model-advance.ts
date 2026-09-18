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
 * session but landing on another reports the one that moved. Removals leave no
 * row to stamp and are reported separately.
 */
export const ReadModelAdvanceSchema = Schema.Struct({
	version: Schema.Number,
	sessionIds: Schema.Array(Schema.String),
});

export type ReadModelAdvance = typeof ReadModelAdvanceSchema.Type;
