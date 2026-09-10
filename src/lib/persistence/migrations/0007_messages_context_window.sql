-- Persist the effective context-window denominator reported for each completed
-- assistant turn so context usage can be restored accurately after reload.

ALTER TABLE messages ADD COLUMN context_window INTEGER;
