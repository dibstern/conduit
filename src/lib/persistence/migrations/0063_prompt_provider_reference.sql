-- Legacy rows keep their id, with no claim about the original provider process.
ALTER TABLE pending_approvals ADD COLUMN provider_process_id TEXT;
ALTER TABLE pending_approvals ADD COLUMN provider_request_id TEXT;
CREATE UNIQUE INDEX pending_approvals_provider_request
ON pending_approvals(session_id, provider_process_id, provider_request_id)
WHERE provider_process_id IS NOT NULL AND provider_request_id IS NOT NULL;
