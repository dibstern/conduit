ALTER TABLE sessions ADD COLUMN project_id TEXT;
ALTER TABLE session_sidebar ADD COLUMN project_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_session_sidebar_project_version ON session_sidebar(project_id, version);
CREATE INDEX IF NOT EXISTS idx_session_sidebar_project_activity ON session_sidebar(project_id, last_activity DESC, session_id DESC);
