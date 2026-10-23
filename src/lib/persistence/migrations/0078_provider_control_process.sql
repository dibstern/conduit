ALTER TABLE provider_command_outbox ADD COLUMN provider_process_id TEXT;

CREATE INDEX IF NOT EXISTS idx_provider_command_outbox_process
ON provider_command_outbox(provider_process_id, request_sequence)
WHERE effect_type <> 'send_turn' AND status IN ('pending', 'running', 'retryable_failed');
