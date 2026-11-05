import type { SqlClient } from "effect/sql";

// A declined delivery returns the input to the inbox; its reservation ended,
// but it cannot replace the work the provider is still running or pause its queue.
// A failure since the latest handoff keeps the queue paused even when a steer
// handed off before that failure subsequently completes.
// CONTRACT 3.9: only an ordinary Stop pauses, and the inbox drains once the
// active Run ends. So a plain End (stop null: reload, switch, cleanup) since
// the latest handoff clears the pause only when that End's own turn ended
// interrupted after it, and nothing else since the handoff failed or stopped
// (turn.error, interrupt.requested, an End with a stop). Every other stop or
// failure keeps main's pause, the "no worse than main" bar of CONTRACT 7.4.
// A run whose runner was lost ends at that loss, as its Run does on the ledger (6.5),
// before main's Gone settlement writes its error: the session shows idle there, so a
// send then is handed off, and the late error holds nothing sent after the loss
// (82tn.32.48; gap: 3.9 keeps `busy` and the pause main's, 923-925).
export const inboxRunStatusQuery = (
	sql: SqlClient.SqlClient,
	sessionId: string,
) => sql`WITH lost AS (SELECT json_extract(data, '$.runnerId') AS runner_id,
		MIN(json_extract(data, '$.retiredAt')) AS at FROM events
		WHERE session_id = ${sessionId} AND type = 'evidence.process_lost' GROUP BY 1),
	selected_run AS (SELECT CASE WHEN run.status IN ('pending', 'running') AND lost.at IS NOT NULL
			THEN 'error' ELSE run.status END AS run_status,
	MAX(CASE WHEN run.status IN ('interrupted', 'error')
			THEN MIN(run.completed_at, COALESCE(lost.at, run.completed_at))
		WHEN run.status IN ('pending', 'running') THEN lost.at END) OVER ()
		>= MAX(requested.requested_at) OVER () AS stopped
	FROM provider_runs requested
	JOIN provider_runs run ON run.id = COALESCE(requested.joined_into, requested.id)
		AND run.session_id = requested.session_id
	LEFT JOIN lost ON lost.runner_id = run.runner_id
	WHERE requested.session_id = ${sessionId}
		AND NOT EXISTS (SELECT 1 FROM provider_command_outbox refused
			WHERE refused.run_id = requested.id AND refused.session_id = requested.session_id
				AND refused.effect_type = 'send_turn' AND refused.status = 'failed'
				AND refused.error_code = 'steer-declined')
		ORDER BY (run_status IN ('pending', 'running')) DESC,
			requested.requested_at DESC, requested.rowid DESC LIMIT 1)
	SELECT (SELECT run_status FROM selected_run) AS status,
		((SELECT stopped FROM selected_run) AND NOT (
			EXISTS (SELECT 1 FROM events ended JOIN events interrupted
				ON interrupted.session_id = ended.session_id
				WHERE ended.session_id = ${sessionId} AND ended.type = 'session.end_requested'
					AND json_extract(ended.data, '$.stop') IS NULL
					AND interrupted.type = 'turn.interrupted'
					AND interrupted.sequence > ended.sequence
					AND ended.sequence > COALESCE((SELECT MAX(sequence) FROM events
						WHERE session_id = ${sessionId} AND type = 'input.sent'), 0))
			AND NOT EXISTS (SELECT 1 FROM events stop WHERE stop.session_id = ${sessionId}
				AND (stop.type IN ('interrupt.requested', 'turn.error')
					OR (stop.type = 'session.end_requested'
						AND json_extract(stop.data, '$.stop') IS NOT NULL))
				AND stop.sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId} AND type = 'input.sent'), 0))
		) AND NOT EXISTS (
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
							AND json_extract(metadata, '$.source') = 'inbox-reset'))), 0)))
		AND NOT EXISTS (SELECT 1 FROM pending_inputs pending JOIN events requested
			ON requested.session_id = pending.session_id
			AND json_extract(requested.data, '$.inputId') = pending.input_id
			WHERE pending.session_id = ${sessionId} AND pending.state = 'queued'
				AND requested.type = 'input.interrupt_requested') AS stopped`;
