ALTER TABLE session_git_published ADD COLUMN workspace_missing TEXT;
ALTER TABLE session_git_published ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
