import type { SqlClient } from "effect/sql";

// A declined delivery returns the input to the inbox; its reservation ended,
// but it cannot replace the work the provider is still running or pause its queue.
// A failure since the latest handoff keeps the queue paused even when a steer
// handed off before that failure subsequently completes.
export const inboxRunStatusQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
) => sql`WITH selected_run AS (SELECT run.status,
	MAX(CASE WHEN run.status IN ('interrupted', 'error') THEN run.completed_at END) OVER ()
		>= MAX(requested.requested_at) OVER () AS stopped
	FROM provider_runs requested
	JOIN provider_runs run ON run.id = COALESCE(requested.joined_into, requested.id)
		AND run.session_id = requested.session_id
	WHERE requested.session_id = ${sessionId}
		AND NOT EXISTS (SELECT 1 FROM provider_command_outbox refused
			WHERE refused.run_id = requested.id AND refused.session_id = requested.session_id
				AND refused.effect_type = 'send_turn' AND refused.status = 'failed'
				AND refused.error_code = 'steer-declined')
		ORDER BY (run.status IN ('pending', 'running')) DESC,
			requested.requested_at DESC, requested.rowid DESC LIMIT 1)
	SELECT (SELECT status FROM selected_run) AS status,
		((SELECT stopped FROM selected_run) AND NOT EXISTS (
			SELECT 1 FROM events admitted JOIN events released
				ON released.session_id = admitted.session_id
			WHERE admitted.session_id = ${sessionId} AND admitted.type = 'input.admitted'
				AND released.type = 'session.resume_cancelled'
				AND json_extract(released.metadata, '$.source') = 'inbox-reset'
				AND released.sequence > admitted.sequence
				AND admitted.sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId}
					AND type IN ('turn.interrupted', 'turn.error')), 0))
		OR EXISTS (SELECT 1 FROM events requeued
			WHERE session_id = ${sessionId} AND type = 'input.requeued'
				AND json_extract(data, '$.reason') = 'failed'
				AND sequence = (SELECT MIN(first.sequence) FROM events first
					WHERE first.session_id = ${sessionId} AND first.type = 'input.requeued'
					AND json_extract(first.data, '$.sentSequence') = json_extract(requeued.data, '$.sentSequence'))
				AND json_extract(data, '$.sentSequence') = (SELECT MAX(sent.sequence) FROM events sent
					WHERE sent.session_id = ${sessionId} AND sent.type = 'input.sent'
					AND json_extract(sent.data, '$.inputId') = json_extract(requeued.data, '$.inputId'))
				AND sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId} AND (type = 'input.sent'
						OR (type = 'session.resume_cancelled'
							AND json_extract(metadata, '$.source') = 'inbox-reset'))), 0))) AS stopped`;
