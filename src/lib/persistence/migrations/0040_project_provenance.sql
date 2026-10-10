ALTER TABLE events ADD COLUMN project_id TEXT;
ALTER TABLE command_receipts ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_sessions ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_turns ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_interactions ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_tombstones ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_outbox ADD COLUMN project_id TEXT;
ALTER TABLE provider_command_meta ADD COLUMN project_id TEXT;
