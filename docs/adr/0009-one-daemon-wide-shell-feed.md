# ADR-0009: One daemon-wide shell feed carries every project and every non-archived session

- Status: accepted
- Date: 2026-10-17
- Context: conduit-test-m379.1 (epic conduit-test-m379)

## Context

`SubscribeShell` is project-scoped. Its request names a `projectSlug`, and
resolving that slug acquires the project's relay. The sidebar's other
projects arrive another way: unary `ListDaemonSessions` reads, 30 rows a page,
refetched whenever `ServerStatus.sessionsRevision` changes. The browser keeps
the two kinds of row apart until `getFilteredSessions()` merges them, so a
session in another project changes state on the next refetch, not live.

Epic m379 retires the attached project: conduit is never "in" a project, so
there is no project to scope the feed to. With one daemon store (ADR-0006,
ADR-0008), every project's sessions are already in one database with one
store-wide change counter.

t3code (89ce030d) answers the same question with one environment-wide
`subscribeShell`. It sends one unpaged snapshot of every project and every
non-archived thread, then project and thread updates and removals on one
sequence. It replays from a cursor and falls back to a fresh snapshot. "Show
more" is client-side. The archive keeps the snapshot small.

## Decision

**One feed for the whole daemon.**

- `SubscribeShell` takes no project. Serving it never acquires a relay, so
  cold projects' sessions are listed without starting them.
- The snapshot is unpaged: every registered project and every session that is
  neither archived (ADR-0010) nor hidden. Show more and show less work over
  rows already loaded.
- Projects and sessions share one ordered stream. Order comes from the
  store-wide counter and each row's delta version. Per-project cursors are
  never merged, and event sequence never stands in for the counter.
- A resume replays from its cursor. When the cursor is no longer covered, the
  feed sends a fresh snapshot.

**Membership changes are hides, never deletes.**

- Removing a project sends its removal and a hide for each of its sessions.
  Their history stays in the store (ADR-0008). Re-adding the project sends it
  and its sessions again.
- Any change to the set of registered projects forces a fresh snapshot, even
  when no row's version changed. Zero projects is a valid snapshot.
- Archiving a session hides it from the feed; restoring it sends it again.
  Only a real session deletion is sent as a delete.

**Unavailable projects stay visible.** A project whose import is blocked
(ADR-0008) appears with its `unavailableReason` and no sessions. Healthy
projects are unaffected.

**Paged reads remain for search and the Archived view only.** The sidebar
never pages through `ListDaemonSessions` for browsing.

## Consequences

- The browser keeps one row collection. Paging other projects, merging rows
  and revision-driven refetches for browsing are deleted.
- The first payload grows with the number of non-archived sessions across all
  projects. The archive is what bounds it, so measure it against a real store
  when the feed ships.
- Search results come from paged reads and can still overlay live rows from
  the feed.
- Acceptance: a state change in project B reaches a browser viewing project A
  through this feed, with zero `ListDaemonSessions` calls
  (`test/e2e/specs/harness-cross-project-monitoring.spec.ts`).
