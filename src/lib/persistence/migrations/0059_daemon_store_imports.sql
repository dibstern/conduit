CREATE TABLE daemon_store_imports (
    project_id TEXT PRIMARY KEY NOT NULL,
    method TEXT NOT NULL CHECK (method IN ('seeded', 'imported')),
    source_path TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    event_offset INTEGER NOT NULL CHECK (event_offset >= 0),
    outbox_offset INTEGER NOT NULL CHECK (outbox_offset >= 0),
    version_offset INTEGER NOT NULL CHECK (version_offset >= 0),
    rowid_offsets TEXT NOT NULL,
    completed_at INTEGER NOT NULL
);
