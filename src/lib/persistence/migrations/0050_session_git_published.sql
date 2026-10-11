-- The git state last published for each working directory
-- (conduit-test-y7eo.16). Git is read from the folder when a row is served, so
-- a session's version covers the git it was sent with. Keeping what was last
-- published beside those versions lets a restart re-stamp only the folders
-- whose git moved, instead of every session. NULL is "published as no git", and
-- a missing row is "never published".
CREATE TABLE IF NOT EXISTS session_git_published (
	directory TEXT PRIMARY KEY,
	git TEXT
);
