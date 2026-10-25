-- Drafts are operational state: delete them with the live session row, never
-- from an event projection that recovery may replay against a newer Draft.
CREATE TRIGGER IF NOT EXISTS session_draft_delete AFTER DELETE ON sessions
BEGIN
	DELETE FROM draft_attachments WHERE draft_key IN (
		SELECT draft_key FROM input_drafts
		WHERE draft_key = OLD.id OR promoted_session_id = OLD.id
	); DELETE FROM input_drafts WHERE draft_key = OLD.id OR promoted_session_id = OLD.id; END;
