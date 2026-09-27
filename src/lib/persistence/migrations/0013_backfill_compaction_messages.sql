-- Backfill compaction boundaries that were stored but never projected.
--
-- The projector the daemon actually runs did not declare session.compaction, so
-- every completed compaction was appended to the event store and then dispatched
-- to nobody. The payloads are intact, so the read model can be reconstructed
-- from them rather than by resetting the message projector cursor, which would
-- replay hundreds of thousands of unrelated events to recover a few hundred rows.
--
-- Shape must match the projector in effect/projectors-effect.ts exactly: a
-- synthetic assistant message keyed on the event sequence, holding one
-- 'compaction' part. Ordering in the transcript is by created_at, so carrying
-- the event's own timestamp is what puts the divider back where it happened.
--
-- Rows are skipped, never half-written, when the payload lacks sessionId or
-- detail, or when the session has since been deleted (messages.session_id is a
-- foreign key). NOT EXISTS makes a second run a no-op.

INSERT INTO messages (id, session_id, role, text, is_streaming, created_at, updated_at)
SELECT
	'compaction-' || e.sequence,
	json_extract(e.data, '$.sessionId'),
	'assistant',
	'',
	0,
	e.created_at,
	e.created_at
FROM events e
WHERE e.type = 'session.compaction'
	AND json_extract(e.data, '$.state') = 'completed'
	AND json_extract(e.data, '$.sessionId') IS NOT NULL
	AND json_extract(e.data, '$.detail') IS NOT NULL
	AND EXISTS (SELECT 1 FROM sessions s WHERE s.id = json_extract(e.data, '$.sessionId'))
	AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.id = 'compaction-' || e.sequence);

INSERT INTO message_parts (id, message_id, type, text, metadata, sort_order, created_at, updated_at)
SELECT
	'compaction-part-' || e.sequence,
	'compaction-' || e.sequence,
	'compaction',
	json_extract(e.data, '$.detail'),
	json_patch(
		CASE
			WHEN json_extract(e.data, '$.preTokens') IS NOT NULL
			THEN json_object('preTokens', json_extract(e.data, '$.preTokens'))
			ELSE json_object()
		END,
		CASE
			WHEN json_extract(e.data, '$.postTokens') IS NOT NULL
			THEN json_object('postTokens', json_extract(e.data, '$.postTokens'))
			ELSE json_object()
		END
	),
	0,
	e.created_at,
	e.created_at
FROM events e
WHERE e.type = 'session.compaction'
	AND json_extract(e.data, '$.state') = 'completed'
	AND json_extract(e.data, '$.detail') IS NOT NULL
	AND EXISTS (SELECT 1 FROM messages m WHERE m.id = 'compaction-' || e.sequence)
	AND NOT EXISTS (SELECT 1 FROM message_parts p WHERE p.id = 'compaction-part-' || e.sequence);
