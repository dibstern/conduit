import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { StoredEvent } from "../events.js";

/** Called by session.created while the append transaction still owns the cut. */
export const inheritForkHistory = (
	event: Extract<StoredEvent, { type: "session.created" }>,
	version: number,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sourceId = event.data.forkedFrom ?? event.data.parentId;
		const cutId = event.data.forkPointMessageId;
		const cutTimestamp = event.data.forkPointTimestamp;
		if (
			sourceId === undefined ||
			cutId === undefined ||
			cutTimestamp === undefined
		)
			return;
		const suffix = `_${event.sessionId}`;
		const retained = sql`SELECT m.* FROM messages m
			WHERE m.session_id = ${sourceId}
			AND ((m.created_at, m.id) <= (${cutTimestamp}, ${cutId})
				OR (m.id GLOB 'turn-error-[0-9]*' AND EXISTS (
					SELECT 1 FROM events error JOIN messages owner
						ON owner.id = json_extract(error.data, '$.messageId') ||
							substr(m.id, length('turn-error-' || error.sequence) + 1)
					WHERE error.sequence = CAST(substr(m.id, length('turn-error-') + 1) AS INTEGER)
					AND error.type = 'turn.error' AND error.sequence < ${event.sequence}
					AND owner.session_id = ${sourceId}
					AND (owner.created_at, owner.id) <= (${cutTimestamp}, ${cutId})
					AND NOT EXISTS (SELECT 1 FROM message_tombstones removed
						WHERE removed.session_id = ${sourceId} AND removed.message_id = owner.id))))
			AND NOT EXISTS (SELECT 1 FROM message_tombstones removed
				WHERE removed.session_id = ${sourceId} AND removed.message_id = m.id)
			AND NOT EXISTS (
				SELECT 1 FROM sessions pending JOIN messages cut
					ON cut.id = pending.pending_rewind_message_id AND cut.session_id = pending.id
				WHERE pending.id = ${sourceId}
				AND (m.created_at, m.id) >= (cut.created_at, cut.id))`;

		// Turns precede messages because messages.turn_id has a foreign key. The
		// old replay did not copy busy/idle signals: its first reply starts the
		// turn, and the fork's final idle closes any turn that was still open.
		// A bounded turn can predate its latest model. Resolve only that keyed
		// metadata, following inherited ids back through creation events.
		yield* sql`WITH RECURSIVE retained AS (${retained}), ancestors(session_id, suffix, through_sequence) AS (
			SELECT ${sourceId}, '', ${event.sequence}
			UNION ALL
			SELECT COALESCE(json_extract(created.data, '$.forkedFrom'), json_extract(created.data, '$.parentId')),
				'_' || ancestor.session_id || ancestor.suffix, created.sequence
			FROM ancestors ancestor JOIN events created INDEXED BY idx_events_session_type
				ON created.session_id = ancestor.session_id AND created.type = 'session.created'
			WHERE created.sequence < ancestor.through_sequence
			AND json_extract(created.data, '$.inheritsHistory') = 1
			AND COALESCE(json_extract(created.data, '$.forkedFrom'), json_extract(created.data, '$.parentId')) IS NOT NULL
		), answers AS (
			SELECT turn_id, MIN(created_at) AS started_at, MAX(completed_at) AS completed_at,
				SUM(cost) AS cost, SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
			FROM retained WHERE role = 'assistant' GROUP BY turn_id
		), bounded AS (
			SELECT t.*, NOT EXISTS (
				SELECT 1 FROM messages m WHERE m.session_id = ${sourceId}
				AND m.turn_id = t.id AND m.role = 'assistant'
				AND NOT EXISTS (SELECT 1 FROM retained r WHERE r.id = m.id)) AS whole
			FROM turns t WHERE t.session_id = ${sourceId}
		), resolutions AS (
			SELECT t.id AS turn_id, e.data,
				ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY e.sequence DESC) AS ordinal
			FROM ancestors ancestor JOIN events e INDEXED BY idx_events_session_type
				ON e.session_id = ancestor.session_id AND e.type = 'turn.model_resolved'
				AND e.sequence < ancestor.through_sequence
			JOIN retained m ON m.id = COALESCE(json_extract(e.data, '$.messageId'), (
				SELECT json_extract(anchor.data, '$.messageId')
				FROM events anchor INDEXED BY idx_events_session_type
				WHERE anchor.session_id = ancestor.session_id AND anchor.type = 'message.created'
				AND anchor.sequence < e.sequence
				ORDER BY anchor.sequence DESC LIMIT 1)) || ancestor.suffix
			JOIN bounded t ON t.id = CASE WHEN json_extract(e.data, '$.messageId') IS NULL
				THEN COALESCE(m.turn_id, m.id) ELSE m.turn_id END AND NOT t.whole
			WHERE json_extract(e.data, '$.messageId') IS NOT NULL OR (
				SELECT CASE WHEN state.type IN ('turn.completed', 'turn.error', 'turn.interrupted')
					OR (state.type = 'session.status' AND json_extract(state.data, '$.status') = 'idle')
					THEN 0 ELSE 1 END
				FROM events state INDEXED BY idx_events_session_seq
				WHERE state.session_id = ancestor.session_id AND state.sequence < e.sequence
				AND (state.type IN ('message.created', 'tool.started', 'turn.completed', 'turn.error', 'turn.interrupted')
					OR (state.type = 'session.status' AND json_extract(state.data, '$.status') IN ('busy', 'idle')))
				ORDER BY state.sequence DESC LIMIT 1) = 1
		)
			INSERT INTO turns
			(id, session_id, state, user_message_id, assistant_message_id,
			 cost, tokens_in, tokens_out, requested_at, started_at, completed_at,
			 requested_model, expected_model, actual_model)
			SELECT t.id || ${suffix}, ${event.sessionId},
				CASE WHEN a.turn_id IS NOT NULL AND t.whole AND t.state NOT IN ('pending', 'running')
					THEN t.state ELSE 'completed' END,
				t.user_message_id || ${suffix},
				COALESCE((SELECT m.id || ${suffix} FROM retained m WHERE m.id = t.assistant_message_id),
					(SELECT m.id || ${suffix} FROM retained m WHERE m.turn_id = t.id AND m.role = 'assistant'
						ORDER BY (SELECT MAX(previous.completed_at) FROM retained previous
							WHERE previous.turn_id = t.id AND previous.role = 'assistant'
							AND previous.completed_at <= m.created_at
							AND (previous.created_at, previous.id) < (m.created_at, m.id)) DESC,
							m.created_at, m.id LIMIT 1)),
				CASE WHEN t.whole AND a.turn_id IS NOT NULL THEN t.cost ELSE a.cost END,
				CASE WHEN t.whole AND a.turn_id IS NOT NULL THEN t.tokens_in ELSE a.tokens_in END,
				CASE WHEN t.whole AND a.turn_id IS NOT NULL THEN t.tokens_out ELSE a.tokens_out END,
				t.requested_at, a.started_at,
				CASE WHEN a.turn_id IS NULL THEN ${event.createdAt}
					WHEN t.whole AND t.state NOT IN ('pending', 'running') THEN t.completed_at
					WHEN (SELECT m.is_streaming FROM retained m WHERE m.turn_id = t.id AND m.role = 'assistant'
						ORDER BY m.created_at DESC, m.id DESC LIMIT 1) = 0 THEN a.completed_at
					ELSE ${event.createdAt} END,
				CASE WHEN a.turn_id IS NOT NULL THEN CASE WHEN t.whole THEN t.requested_model
					ELSE json_extract(resolution.data, '$.requestedModel') END END,
				CASE WHEN a.turn_id IS NOT NULL THEN CASE WHEN t.whole THEN t.expected_model
					ELSE json_extract(resolution.data, '$.expectedModel') END END,
				CASE WHEN a.turn_id IS NOT NULL THEN CASE WHEN t.whole THEN t.actual_model
					ELSE json_extract(resolution.data, '$.actualModel') END END
			FROM bounded t JOIN retained prompt ON prompt.id = t.user_message_id
			LEFT JOIN answers a ON a.turn_id = t.id
			LEFT JOIN resolutions resolution ON resolution.turn_id = t.id AND resolution.ordinal = 1
			WHERE 1
			ORDER BY prompt.created_at, prompt.id
			ON CONFLICT (id) DO NOTHING`;

		yield* sql`WITH retained AS (${retained})
			INSERT INTO messages
			(id, session_id, turn_id, role, text, cost, tokens_in, tokens_out,
			 tokens_cache_read, tokens_cache_write, is_streaming, is_inherited,
			 last_applied_seq, created_at, updated_at, context_window, version,
			 is_backfilled, rest_digest, rest_event_id, rest_payload, parent_id,
			 finish, error, input_id, steered, context_tokens, completed_at, is_human_sent)
			SELECT m.id || ${suffix}, ${event.sessionId},
				(SELECT t.id FROM turns t WHERE t.id = m.turn_id || ${suffix}
					AND (m.role != 'user' OR EXISTS (SELECT 1 FROM retained a
						WHERE a.turn_id = m.id AND a.role = 'assistant'))),
				m.role, m.text, m.cost, m.tokens_in, m.tokens_out,
				m.tokens_cache_read, m.tokens_cache_write, m.is_streaming,
				CASE WHEN m.id GLOB 'compaction-[0-9]*' OR m.id GLOB 'turn-error-[0-9]*'
					THEN m.is_inherited ELSE 1 END,
				${event.sequence}, m.created_at, m.updated_at, m.context_window, ${version},
				m.is_backfilled, m.rest_digest, m.rest_event_id, m.rest_payload,
				m.parent_id || ${suffix}, m.finish, m.error, m.input_id, 0,
				m.context_tokens, m.completed_at, 0
			FROM retained m ORDER BY m.created_at, m.id
			ON CONFLICT (id) DO NOTHING`;

		// The retained result is only the preview. Keep its pointer into the
		// Source event log so opening full tool output does not duplicate it.
		yield* sql`WITH retained AS (${retained})
			INSERT INTO message_parts
			(id, message_id, type, text, tool_name, call_id, input, result,
			 duration, status, sort_order, created_at, updated_at, metadata,
			 rest_payload, version, result_event_seq, result_bytes, surfacing_ordinal,
			 surfacing_probabilities, surfacing_set_version, surfacing_model)
			SELECT p.id || ${suffix}, p.message_id || ${suffix}, p.type, p.text,
				p.tool_name, p.call_id || ${suffix}, p.input, p.result,
				p.duration, p.status, p.sort_order, p.created_at, p.updated_at,
				p.metadata, p.rest_payload, ${version}, p.result_event_seq, p.result_bytes,
				p.surfacing_ordinal, p.surfacing_probabilities, p.surfacing_set_version,
				p.surfacing_model
			FROM message_parts p JOIN retained m ON m.id = p.message_id
			ORDER BY m.created_at, m.id, p.sort_order, p.id
			ON CONFLICT (id) DO NOTHING`;

		// Inherited prompts do not count as human sends. Attention still needs a
		// turn-end cursor so the fork starts seen and future results can advance it.
		yield* sql`WITH retained AS (${retained}), ended AS (
			SELECT t.*, prompt.input_id FROM turns t
			JOIN messages prompt ON prompt.id = t.user_message_id
			WHERE t.session_id = ${event.sessionId} AND (t.state IN ('error', 'interrupted')
				OR prompt.completed_at IS NOT NULL
				OR EXISTS (SELECT 1 FROM messages m WHERE m.session_id = ${event.sessionId}
					AND m.turn_id = t.id AND m.role = 'assistant' AND m.completed_at IS NOT NULL))
			ORDER BY t.completed_at DESC, t.requested_at DESC, t.id DESC LIMIT 1
		)
			UPDATE sessions SET status = 'idle', updated_at = ${event.createdAt},
				history_complete = 0, last_user_message_at = NULL,
				last_message_at = (SELECT MAX(created_at) FROM retained
					WHERE id NOT GLOB 'compaction-[0-9]*' AND id NOT GLOB 'turn-error-[0-9]*'),
				last_turn_end_version = (SELECT ${event.streamVersion} FROM ended),
				last_turn_end_input_id = (SELECT input_id FROM ended),
				last_turn_error_at = (SELECT completed_at FROM ended
					WHERE state = 'error' AND NOT EXISTS (
						SELECT 1 FROM retained m WHERE m.role = 'user' AND m.created_at > ended.completed_at))
			WHERE id = ${event.sessionId}`;
	});
