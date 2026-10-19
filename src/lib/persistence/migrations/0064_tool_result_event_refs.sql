ALTER TABLE message_parts ADD COLUMN result_event_seq INTEGER;
ALTER TABLE message_parts ADD COLUMN result_bytes INTEGER;

-- The migrator substitutes the policy constants from tool-wire-projection.ts.
-- Scan completed events once, retaining only the latest sequence per part.
CREATE TEMP TABLE tool_result_events AS
SELECT session_id, json_extract(data, '$.partId') AS part_id,
       MAX(sequence) AS sequence
FROM events
WHERE type = 'tool.completed'
GROUP BY session_id, json_extract(data, '$.partId');

WITH candidates AS (
    SELECT mp.id, e.sequence,
           CASE WHEN json_valid(mp.result)
                THEN CASE WHEN json_type(mp.result) = 'text'
                          THEN json_extract(mp.result, '$') ELSE mp.result END
                ELSE mp.result END AS output
    FROM tool_result_events latest
    JOIN events e ON e.sequence = latest.sequence
    JOIN message_parts mp ON mp.id = latest.part_id
    JOIN messages m ON m.id = mp.message_id AND m.session_id = latest.session_id
    WHERE mp.type = 'tool'
      AND mp.tool_name NOT IN ({{NEVER_CUT_TOOL_NAMES}})
      AND length(mp.result) > {{PREVIEW_CODE_POINTS}}
      AND CAST(e.data -> '$.result' AS BLOB) = CAST(mp.result AS BLOB)
)
UPDATE message_parts
SET result = json_quote(substr(candidates.output, 1, {{PREVIEW_CODE_POINTS}})),
    result_event_seq = candidates.sequence,
    result_bytes = length(CAST(candidates.output AS BLOB))
FROM candidates
WHERE message_parts.id = candidates.id
  AND length(candidates.output) > {{PREVIEW_CODE_POINTS}};

DROP TABLE tool_result_events;
