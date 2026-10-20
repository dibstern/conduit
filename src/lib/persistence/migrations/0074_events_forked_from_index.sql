CREATE INDEX IF NOT EXISTS idx_events_lineage_forked_from
ON events (project_id, json_extract(data, '$.forkedFrom'))
WHERE type = 'session.created' AND json_valid(data);
