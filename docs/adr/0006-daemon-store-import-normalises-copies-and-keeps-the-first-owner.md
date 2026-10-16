# ADR-0006: The daemon store import normalises a private copy and keeps a shared session's first owner

- Status: accepted
- Date: 2026-10-16
- Context: conduit-test-82tn.5 (epic conduit-test-82tn)

## Context

conduit-test-82tn.4 imports each project's events.db into one daemon store. It
reads the source in place, so the source must already be on this build's exact
migration ledger, have every event projected, and own its rows by slug. Real
per-project stores often meet none of these conditions:

- They were last migrated by an older build.
- A daemon that was killed between append and projection leaves an
  unprojected tail. Relay startup normally recovers it
  (`src/lib/relay/project-relay-startup.ts`).
- Rows written before project scope have NULL ownership. Command tables can
  still carry legacy folder keys. Only `stampProjectProvenance` rewrites those.

Two projects can also hold the same session id. OpenCode session ids are global
to an OpenCode server, so two projects can adopt the same session (see
`AmbiguousSession` in `session-directory.ts`). One store gives each session a
single `project_id`, so the import has to choose an owner.

## Decision

**Normalise, then import.** Each source is first copied with `VACUUM INTO`
into `<configDir>/daemon-store-import/`, opened read-only. The importer then
reads the copy's migration ledger:

- A name this build does not know means a newer schema, and the project fails.
- Otherwise the copy is opened with the production project persistence layer
  (migrations plus provenance stamping), and projection recovery runs on it.

The importer reads only the normalised copy. The seed promotes its copy as the
daemon store. An import attaches its copy and deletes it afterwards. The
original source is never written. It is renamed only after its import has
committed.

**A shared session keeps its first owner.** The session id is the unit of
ownership.

- If a session is already in the daemon store, the later project's copy of it
  is left out. That covers the session row and every row scoped to it,
  including its messages and parts. The copy stays in that project's backup,
  and the report names it.
- First means the seed (the largest store), then registration order.
- Any other key collision fails that project and rolls it back. Such
  collisions mean duplicated or corrupt data, and no rule can merge them
  safely.

**Backups.** After a project's marker commits, its source files are renamed in
place to `<name>.imported-<completed_at>`. The sidecars move first (`-wal`,
`-shm`, `-journal`) and the main file last. An existing file is never
overwritten.

On the next run, a project that has a marker is handled in this order:

1. A partial backup is finished first, before any fingerprint check.
2. If its source is still at the original path with a different fingerprint,
   the project reports `source-changed` and the source is left untouched.

**Report.** A run that changes or fails anything writes
`<configDir>/daemon-store-import-report.txt` atomically. It has one line per
project: outcome, rows imported, shared sessions left out, error kind and
message, and backup path.

## Consequences

- One path covers older schemas, unprojected tails and legacy ownership. The
  importer keeps its strict precondition: an exact ledger, cursors at the
  frontier, and no foreign owners.
- An import needs free disk space for one source copy. The seed's copy becomes
  the daemon store, so the largest store is never copied twice.
- When a shared session is left out, the later project loses any conduit-local
  state it added to that session, such as a title edit or pin made from that
  project. The provider history is the same in both copies, and the local
  state survives in the backup.
- Rejected alternatives:
  - Giving the duplicate a new id. This splits one provider session into two
    copies that diverge, and it breaks the provider binding.
  - Failing the whole project. One shared session would block that project's
    history permanently.
  - Choosing the richest copy. This needs global planning, or moving rows
    between projects after commit, for little benefit, since both copies
    mirror the same provider history.
- A failed project keeps no marker and its source stays untouched, so the next
  run retries it. Healthy projects are never blocked.
