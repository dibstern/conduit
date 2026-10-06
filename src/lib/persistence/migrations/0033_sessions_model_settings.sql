-- A session's model, effort variant and context window are projected from
-- session.model_changed / variant_changed / context_window_changed (ni8.55),
-- so every tab reads them off the shell row instead of a push frame.
ALTER TABLE sessions ADD COLUMN model_id TEXT;
ALTER TABLE sessions ADD COLUMN model_provider TEXT;
ALTER TABLE sessions ADD COLUMN variant TEXT;
ALTER TABLE sessions ADD COLUMN context_window TEXT;
