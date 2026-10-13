-- Destructive replay boundaries: message.removed deletes messages (cascading to
-- parts), message.part.removed deletes a part, message.snapshot replaces parts,
-- message.created with role=user replaces a turn (cascading to messages/parts),
-- session.deleted cascades through sessions, turns, messages and parts. These
-- boundaries are global: ids are global and deletion can remove descendants.
-- Also split each part's interval at tool.running for that globally keyed part:
-- it reads thinking status to update child liveness. Keep each part's first
-- opener/end in every interval: empty deltas can resurrect cascaded rows
-- and assign MAX(sort_order) + 1. Include messageId because legacy part ids recur.
-- Separate REST-authoritative events: the snapshot guard can skip native events
-- while allowing a REST event to perform the first effective insertion.
-- Keep the last delta/end too: they set replay checkpoints, message completion
-- fallback times and thinking duration/status. Only interior no-op rows can go.
WITH event_fields AS (
	SELECT sequence, session_id, type,
		CASE WHEN type IN ('text.delta', 'thinking.start', 'thinking.delta', 'thinking.end', 'tool.running')
			AND json_type(data, '$.partId') = 'text' THEN json_extract(data, '$.partId') END AS part_id,
		CASE WHEN type IN ('text.delta', 'thinking.start', 'thinking.delta', 'thinking.end')
			THEN json_extract(data, '$.messageId') END AS message_id,
		CASE WHEN type IN ('text.delta', 'thinking.delta') THEN json_extract(data, '$.text') = '' END AS empty_delta,
		COALESCE(json_extract(metadata, '$.rawSource') = 'opencode.rest', 0) AS rest_source,
		type IN ('message.removed', 'message.part.removed', 'message.snapshot', 'session.deleted')
			OR (type = 'message.created' AND json_extract(data, '$.role') = 'user')
			AS destructive
	FROM events
	WHERE type IN ('text.delta', 'thinking.start', 'thinking.delta', 'thinking.end',
		'message.created', 'message.removed', 'message.part.removed', 'message.snapshot', 'session.deleted', 'tool.running')
), replay_intervals AS (
	SELECT sequence, session_id, type, part_id, message_id, empty_delta, rest_source,
		COALESCE(MAX(CASE WHEN destructive THEN sequence END) OVER (
			ORDER BY sequence ROWS UNBOUNDED PRECEDING
		), 0) AS boundary,
		COALESCE(MAX(CASE WHEN type = 'tool.running' THEN sequence END) OVER (
			PARTITION BY part_id ORDER BY sequence ROWS UNBOUNDED PRECEDING
		), 0) AS observer_boundary
	FROM event_fields
), ranked_parts AS (
	SELECT sequence, type, empty_delta,
		MIN(CASE WHEN type <> 'thinking.end' THEN sequence END) OVER part_interval AS first_opener,
		MIN(CASE WHEN type = 'thinking.end' THEN sequence END) OVER part_interval AS first_end,
		MAX(CASE WHEN type IN ('text.delta', 'thinking.delta') THEN sequence END) OVER part_interval AS last_delta,
		MAX(CASE WHEN type = 'thinking.end' THEN sequence END) OVER part_interval AS last_end
	FROM replay_intervals
	WHERE type IN ('text.delta', 'thinking.start', 'thinking.delta', 'thinking.end')
		AND part_id IS NOT NULL
	WINDOW part_interval AS (
		PARTITION BY session_id, part_id, message_id, rest_source, boundary, observer_boundary
	)
)
DELETE FROM events
WHERE sequence IN (
	SELECT sequence FROM ranked_parts
	WHERE (type IN ('text.delta', 'thinking.delta') AND empty_delta
		AND sequence > first_opener AND sequence < last_delta)
		OR (type = 'thinking.end' AND sequence > first_end AND sequence < last_end)
);
