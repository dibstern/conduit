// Relay startup runs these reads synchronously before the first session can
// open. They live here as text so tests can check their query plans.

/** Claude AskUserQuestion tools still waiting for an answer. */
export const pendingClaudeQuestionToolsQuery = `
	SELECT mp.id, mp.call_id, mp.message_id, mp.input, mp.created_at, m.session_id,
		pa.id AS prompt_id, pa.provider_process_id, pa.provider_request_id
	-- CROSS JOIN pins the join order: start from the few open questions in
	-- idx_message_parts_open_questions, never from every Claude message's parts.
	FROM message_parts mp
	CROSS JOIN messages m ON m.id = mp.message_id
	CROSS JOIN sessions s ON s.id = m.session_id
	LEFT JOIN pending_approvals pa ON pa.rowid = (
		SELECT candidate.rowid FROM pending_approvals candidate
		WHERE candidate.session_id = m.session_id AND candidate.type = 'question'
			AND (json_extract(candidate.details, '$.toolUseId') = COALESCE(mp.call_id, mp.id)
				OR (candidate.provider_process_id IS NULL AND candidate.id = COALESCE(mp.call_id, mp.id)))
		ORDER BY candidate.created_at DESC, candidate.rowid DESC LIMIT 1
	)
	WHERE s.provider = 'claude'
		AND (pa.id IS NULL OR pa.status = 'pending')
		AND mp.type = 'tool'
		AND mp.tool_name = 'AskUserQuestion'
		AND mp.status IN ('started', 'running', 'pending')
		-- A later user message means the conversation moved on (e.g. after a
		-- crash), so the question is abandoned rather than still pending.
		AND NOT EXISTS (
			SELECT 1 FROM messages later
			WHERE later.session_id = m.session_id
				AND later.role = 'user'
				AND later.created_at > m.created_at
		)`;
