-- A random name for this store, minted once.
--
-- A browser keeps a resume point across page loads, and a resume point is
-- only meaningful against the store that issued it. Comparing names lets the
-- server refuse a point from a different store (a reset or a fresh install)
-- and send a fresh snapshot instead. A store restored from a backup keeps its
-- name; the resume checksum catches what it lost.
--
-- Idempotent on purpose: the migration may be renumbered when branches merge.
CREATE TABLE IF NOT EXISTS store_identity (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	value TEXT NOT NULL
);

INSERT INTO store_identity (id, value)
SELECT 1, lower(hex(randomblob(16)))
WHERE NOT EXISTS (SELECT 1 FROM store_identity);
