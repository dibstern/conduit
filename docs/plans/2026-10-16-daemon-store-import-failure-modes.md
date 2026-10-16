# Daemon store import: failure modes (conduit-test-82tn.5)

This list was written before any code, and the tests are written from it. The
decision behind it is in ADR-0006.

Every failure below has the same expected outcome unless its row says
otherwise:

- That project ends up with no daemon-store rows and no marker.
- Its source bytes are unchanged and it is not renamed.
- The other projects in the same run import exactly as they would alone.

## Source state

| # | Failure | Expected |
|---|---------|----------|
| S1 | The registered source is missing | Outcome `absent`, with no marker. A later run imports it if it appears. |
| S2 | The source is a zero-byte file, or migrated with no events | It imports trivially with a marker and zero rows, and is backed up. |
| S3 | The file is not SQLite (garbage header) | `failed`, kind `corrupt`. |
| S4 | The source is corrupt (damaged pages or truncated) | `failed`, kind `corrupt`. |
| S5 | The ledger has a migration this build does not know | `failed`, kind `newer-schema`. |
| S6 | The ledger is older than this build | The copy is migrated and imported. The manifest matches the same history written by the current build. |
| S7 | Rows have NULL ownership, or command tables have legacy folder keys | Stamped on the copy, and no NULL or foreign owners in the daemon store. |
| S8 | An unprojected tail: events beyond the projector cursors | Recovered on the copy. The imported read models include the tail. |
| S9 | A writer changes the source during normalisation or import | `source-changed`, with no marker. A rerun with the writer stopped imports it. |
| S10 | A WAL-mode source with committed frames, or reached through a symlink | Every committed event is imported (the `.4` cases are kept). |
| S11 | A hot rollback journal beside the source | `failed`, and the source is untouched. |

## Collisions

| # | Failure | Expected |
|---|---------|----------|
| C1 | A session id already in the daemon store (an OpenCode session adopted by two projects) | The later copy is left out with all its scoped rows. The rest of the project imports, and the report lists the session. |
| C2 | Every session in a source is shared (a copied store) | It imports with zero sessions, gets a marker and a backup, and the report lists every session. |
| C3 | A colliding key not explained by a shared session (duplicate event id, outbox id, binding) | `failed`, kind `collision`, rolled back. |
| C4 | A fork or subagent child whose parent was left out as shared | It imports. Its parent link points at the first owner's session. |

## Interruption

A child process runs the driver and is SIGKILLed at a named checkpoint. Then
the driver is rerun in process. For each checkpoint, the rerun must leave:

- a final daemon store manifest equal to the uninterrupted run's;
- every source backed up exactly once;
- no stale temp files.

| # | Checkpoint |
|---|------------|
| K1 | `normalised`: the copy is migrated and recovered, nothing promoted |
| K2 | `seed-marked`: the seed copy holds its marker, not yet renamed |
| K3 | `seed-promoted`: the daemon store exists, the seed source is not backed up |
| K4 | `import-copied`: inside the import transaction, before commit |
| K5 | `import-committed`: the marker is committed, the source is not backed up |
| K6 | `backup-sidecars`: the sidecars are renamed, the main file is not |

## Store and environment

| # | Failure | Expected |
|---|---------|----------|
| E1 | A statement fails mid-transaction (disk full, I/O). Simulated by a destination trigger that raises. | That project rolls back. The daemon store is logically unchanged and later projects still import. |
| E2 | Stale temp files from an earlier crash (`daemon-store-import/`, the seed temp) | Removed at the start of the driver. Never mistaken for a source or the daemon store. |
| E3 | The backup name already exists | That project's backup fails and is reported, and nothing is overwritten. The import itself stays committed. |
| E4 | The largest store fails to seed | The next largest seeds. The failed one is reported, and it is retried on the next run. |

## Retries and idempotency

| # | Failure | Expected |
|---|---------|----------|
| R1 | A rerun after full success | Every project is `skipped`. The daemon store is byte-identical and no report is written. |
| R2 | A rerun after a failure whose cause was fixed | The fixed project imports, and the healthy ones are `skipped`. |
| R3 | After a backup, an older conduit creates a fresh source at the original path | `source-changed`. It is untouched and reported. |

## Report

Each run that does anything writes a readable report, one line per project.
The E2E artifact embeds that report text, normalised (paths relative to the
config dir, timestamps masked).
