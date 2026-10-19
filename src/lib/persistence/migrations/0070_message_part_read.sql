CREATE TABLE IF NOT EXISTS message_part_read_state (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL,
  PRIMARY KEY (session_id, part_id)
);
