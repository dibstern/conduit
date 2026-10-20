-- Historical checks keep unknown metadata rather than inferring it from
-- today's model or turn history.
ALTER TABLE session_goal_checks ADD COLUMN turn_index INTEGER;
ALTER TABLE session_goal_checks ADD COLUMN judge_model TEXT;
