-- References are indexed per column, independently of application writers.
CREATE TABLE IF NOT EXISTS attachment_blobs (
	hash TEXT PRIMARY KEY,
	mime TEXT NOT NULL,
	size INTEGER NOT NULL,
	bytes BLOB NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_attachments (
	id TEXT PRIMARY KEY,
	draft_key TEXT NOT NULL,
	position INTEGER NOT NULL,
	name TEXT,
	hash TEXT REFERENCES attachment_blobs(hash),
	state TEXT NOT NULL CHECK (state IN ('live', 'removed', 'sent')),
	created_at INTEGER NOT NULL,
	CHECK ((state = 'live' AND hash IS NOT NULL) OR (state IN ('removed', 'sent') AND hash IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_draft_attachments_key ON draft_attachments(draft_key, position);
CREATE INDEX IF NOT EXISTS idx_draft_attachments_hash ON draft_attachments(hash) WHERE state = 'live';

CREATE TABLE IF NOT EXISTS attachment_uses (
	source_table TEXT NOT NULL,
	source_column TEXT NOT NULL,
	source_row_key TEXT NOT NULL,
	hash TEXT NOT NULL REFERENCES attachment_blobs(hash),
	PRIMARY KEY (source_table, source_column, source_row_key, hash)
);
CREATE INDEX IF NOT EXISTS idx_attachment_uses_hash ON attachment_uses(hash);

-- Internal trigger statements share a line at their terminators because the
-- migration runner splits statements at a semicolon followed by a newline.

CREATE TRIGGER IF NOT EXISTS attachment_events_data_insert AFTER INSERT ON events
WHEN instr(NEW.data, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'events', 'data', CAST(NEW.event_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.data) THEN NEW.data ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_events_data_update AFTER UPDATE OF data, event_id ON events
WHEN instr(OLD.data, '"attachmentHash"') > 0 OR instr(NEW.data, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'events'
	AND source_column = 'data' AND source_row_key = CAST(OLD.event_id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'events', 'data', CAST(NEW.event_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.data) THEN NEW.data ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_events_data_delete AFTER DELETE ON events
WHEN instr(OLD.data, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'events'
	AND source_column = 'data' AND source_row_key = CAST(OLD.event_id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_messages_rest_payload_insert AFTER INSERT ON messages
WHEN instr(NEW.rest_payload, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'messages', 'rest_payload', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.rest_payload) THEN NEW.rest_payload ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_messages_rest_payload_update AFTER UPDATE OF rest_payload, id ON messages
WHEN instr(OLD.rest_payload, '"attachmentHash"') > 0 OR instr(NEW.rest_payload, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'messages'
	AND source_column = 'rest_payload' AND source_row_key = CAST(OLD.id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'messages', 'rest_payload', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.rest_payload) THEN NEW.rest_payload ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_messages_rest_payload_delete AFTER DELETE ON messages
WHEN instr(OLD.rest_payload, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'messages'
	AND source_column = 'rest_payload' AND source_row_key = CAST(OLD.id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_metadata_insert AFTER INSERT ON message_parts
WHEN instr(NEW.metadata, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'message_parts', 'metadata', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_metadata_update AFTER UPDATE OF metadata, id ON message_parts
WHEN instr(OLD.metadata, '"attachmentHash"') > 0 OR instr(NEW.metadata, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'message_parts'
	AND source_column = 'metadata' AND source_row_key = CAST(OLD.id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'message_parts', 'metadata', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.metadata) THEN NEW.metadata ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_metadata_delete AFTER DELETE ON message_parts
WHEN instr(OLD.metadata, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'message_parts'
	AND source_column = 'metadata' AND source_row_key = CAST(OLD.id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_rest_payload_insert AFTER INSERT ON message_parts
WHEN instr(NEW.rest_payload, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'message_parts', 'rest_payload', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.rest_payload) THEN NEW.rest_payload ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_rest_payload_update AFTER UPDATE OF rest_payload, id ON message_parts
WHEN instr(OLD.rest_payload, '"attachmentHash"') > 0 OR instr(NEW.rest_payload, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'message_parts'
	AND source_column = 'rest_payload' AND source_row_key = CAST(OLD.id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'message_parts', 'rest_payload', CAST(NEW.id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.rest_payload) THEN NEW.rest_payload ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_message_parts_rest_payload_delete AFTER DELETE ON message_parts
WHEN instr(OLD.rest_payload, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'message_parts'
	AND source_column = 'rest_payload' AND source_row_key = CAST(OLD.id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_request_insert AFTER INSERT ON pending_inputs
WHEN instr(NEW.request, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'pending_inputs', 'request', CAST(NEW.input_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.request) THEN NEW.request ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_request_update AFTER UPDATE OF request, input_id ON pending_inputs
WHEN instr(OLD.request, '"attachmentHash"') > 0 OR instr(NEW.request, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'pending_inputs'
	AND source_column = 'request' AND source_row_key = CAST(OLD.input_id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'pending_inputs', 'request', CAST(NEW.input_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.request) THEN NEW.request ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_request_delete AFTER DELETE ON pending_inputs
WHEN instr(OLD.request, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'pending_inputs'
	AND source_column = 'request' AND source_row_key = CAST(OLD.input_id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_images_insert AFTER INSERT ON pending_inputs
WHEN instr(NEW.images, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'pending_inputs', 'images', CAST(NEW.input_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.images) THEN NEW.images ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_images_update AFTER UPDATE OF images, input_id ON pending_inputs
WHEN instr(OLD.images, '"attachmentHash"') > 0 OR instr(NEW.images, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'pending_inputs'
	AND source_column = 'images' AND source_row_key = CAST(OLD.input_id AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'pending_inputs', 'images', CAST(NEW.input_id AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.images) THEN NEW.images ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_pending_inputs_images_delete AFTER DELETE ON pending_inputs
WHEN instr(OLD.images, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'pending_inputs'
	AND source_column = 'images' AND source_row_key = CAST(OLD.input_id AS TEXT); END;

CREATE TRIGGER IF NOT EXISTS attachment_provider_command_outbox_payload_json_insert AFTER INSERT ON provider_command_outbox
WHEN instr(NEW.payload_json, '"attachmentHash"') > 0
BEGIN
	INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'provider_command_outbox', 'payload_json', CAST(NEW.request_sequence AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_provider_command_outbox_payload_json_update AFTER UPDATE OF payload_json, request_sequence ON provider_command_outbox
WHEN instr(OLD.payload_json, '"attachmentHash"') > 0 OR instr(NEW.payload_json, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'provider_command_outbox'
	AND source_column = 'payload_json' AND source_row_key = CAST(OLD.request_sequence AS TEXT); INSERT OR IGNORE INTO attachment_uses (source_table, source_column, source_row_key, hash)
	SELECT 'provider_command_outbox', 'payload_json', CAST(NEW.request_sequence AS TEXT), blob.hash
	FROM json_tree(CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE NULL END) ref
	JOIN attachment_blobs blob ON blob.hash = ref.value
	WHERE ref.key = 'attachmentHash' AND ref.type = 'text'; END;

CREATE TRIGGER IF NOT EXISTS attachment_provider_command_outbox_payload_json_delete AFTER DELETE ON provider_command_outbox
WHEN instr(OLD.payload_json, '"attachmentHash"') > 0
BEGIN
	DELETE FROM attachment_uses WHERE source_table = 'provider_command_outbox'
	AND source_column = 'payload_json' AND source_row_key = CAST(OLD.request_sequence AS TEXT); END;

