-- Avoid scanning stamped events during project provenance checks and updates.
CREATE INDEX IF NOT EXISTS idx_events_unstamped ON events (sequence) WHERE project_id IS NULL OR project_id = '';
