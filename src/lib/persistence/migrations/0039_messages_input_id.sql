-- The browser send (input) a user message was placed for, so the client can
-- swap its temporary copy for the placed message by id rather than by text.
ALTER TABLE messages ADD COLUMN input_id TEXT;
-- Placement checks look a send up by input id before writing its message.
CREATE INDEX IF NOT EXISTS idx_messages_input_id ON messages (input_id)
	WHERE input_id IS NOT NULL;
