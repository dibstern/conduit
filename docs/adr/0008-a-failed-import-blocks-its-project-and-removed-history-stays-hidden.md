# ADR-0008: A failed import blocks its project, and removed projects' history is imported but hidden

- Status: accepted
- Date: 2026-10-17
- Context: conduit-test-82tn.6.4.2 (epic conduit-test-82tn)

## Context

With one daemon store (conduit-test-82tn.6.4.1), every project's history is
imported from `projects/<slug>/events.db` at startup. Two questions were left
open.

1. **What happens to a project whose import fails?** Its rows are not in the
   daemon store. If its relay starts anyway, new sessions land in the daemon
   store. A later retry of the import then runs into those sessions. ADR-0006
   keeps a shared session's first owner, so the source's copy is left out:
   the original messages of that session are silently dropped. The 6.4.1
   review reproduced this.
2. **What happens to a project that was removed but still has a store on
   disk?** Removal unregisters the project and keeps `projects/<slug>/`, so
   re-adding the same folder recovers the same slug (`chooseProjectSlug`).
   Importing only registered projects would leave that history behind in a
   file the daemon no longer reads.

## Decision

**A failed import makes the project unavailable until a restart retries it.**

- The importer's results are published as one fixed availability map for the
  process. A project is unavailable when its import did not commit (any
  result with an error, including a source that changed mid-copy), or
  when moving its legacy `<folder>/.conduit/events.db` failed this run. A
  legacy failure used to look like an absent store.
- An unavailable project's relay is refused at acquisition, the same way a
  missing project folder is. Nothing can write rows for it, so a retry finds
  the store exactly as the failed run left it. Ordinary relay retries are
  refused too, because the map does not change. Only a restart retries the
  import.
- The project list carries the reason (`ProjectInfo.unavailableReason`). The
  session list reports the project as unavailable instead of showing an empty,
  healthy history.

**Some outcomes do not block.**

- A failed backup rename (`backupError`): the import has committed, so the
  history is in the daemon store. The report names the failed rename.
- `source-changed` after a committed import: the import committed on an
  earlier run, and the source has changed since. That only happens when an
  older build wrote to the file again. Blocking would be permanent, because no retry can reconcile the two
  copies. The report names it, and the newer rows stay in the source file.

**Removed projects' stores are imported too, and stay hidden.**

- The importer also reads every `projects/<slug>/events.db` whose slug is not
  registered. These are retained projects. Registered projects go first, so
  when a session is owned twice the registered project keeps it.
- A retained project's rows keep its slug as `project_id`. Every reader lists
  only registered projects, so its sessions stay hidden. Re-adding the folder
  recovers the slug, and the history reappears.
- A retained directory without a readable owner record keeps its slug
  reserved, as before. Its history stays hidden until a project with that slug
  is registered.
- A retained project whose import failed is in the availability map too.
  Re-adding it gives an unavailable project until a restart imports it.

## Consequences

- A corrupt or newer-schema store takes one project offline, visibly, and
  leaves the others working. Repairing the file and restarting brings it back
  with its history intact.
- No relay ever writes over a failed import, so ADR-0006's first-owner rule
  only arbitrates between real sources.
- Retained history costs disk space in the daemon store. It is never shown
  unless the project is re-added.
- Availability is fixed for the life of the process. Once registered, a
  project is never imported mid-run.
