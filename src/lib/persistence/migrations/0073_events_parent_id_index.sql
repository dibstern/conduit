CREATE INDEX IF NOT EXISTS idx_events_lineage_parent
ON events (project_id, json_extract(data, '$.parentId'))
WHERE type IN ('session.created', 'session.forked') AND json_valid(data);
