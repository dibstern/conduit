CREATE INDEX IF NOT EXISTS idx_sessions_settled_shelf
ON sessions(project_id, parent_id, title)
WHERE settled_at IS NOT NULL AND pinned_at IS NULL;
