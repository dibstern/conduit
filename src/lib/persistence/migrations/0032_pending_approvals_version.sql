-- The approvals subscription (ni8.9) asks "which approvals moved in this
-- read-model window?", so each row carries the version it last moved at, and
-- the card fields the asked event carries beyond tool name and input.
ALTER TABLE pending_approvals ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pending_approvals ADD COLUMN details TEXT;
CREATE INDEX IF NOT EXISTS idx_pending_approvals_version ON pending_approvals(version);
