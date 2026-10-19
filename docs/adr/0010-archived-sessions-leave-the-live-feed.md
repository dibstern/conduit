# ADR-0010: Archived sessions leave the live feed; settled sessions archive themselves after 30 idle days

- Status: accepted
- Date: 2026-10-17
- Context: epic conduit-test-m379

## Context

ADR-0009's feed sends every non-archived session unpaged, so something has to
keep that set small. Conduit has a Settled state, with `session.settled` and
`session.unsettled` events, a manual settle action and an automatic settle
rule. It has no archive: a settled session stays in the sidebar forever.

t3code (89ce030d) archives manually only; its auto-settle is a separate state.
Archived threads are listed on a lazily loaded, unpaged Settings → Archive page.
They are left out of search, and sending to one is rejected.

## Decision

**Archived is its own state, separate from Settled.**

- Any session can be archived by hand.
- A Settled session is archived automatically once it has had no activity for
  N days. N is a setting and defaults to 30. Active and snoozed sessions are
  never archived automatically.
- Archiving and restoring are canonical session events (ADR-0004), like
  settling.
- Sending a message to an archived session restores it, and the existing
  settle rules then return it to Active. t3code rejects such sends instead.

**Archived sessions are hidden unless asked for.**

- They are not in the live feed (ADR-0009) or the default sidebar views.
- Settings → Archived lists them for every project, newest archived first,
  grouped by project and paged. Each row can be unarchived or deleted. This
  follows t3code's Settings → Archive page, except that t3code loads every
  archived thread at once.
- Search leaves archived sessions out. An "Include archived" switch beside
  the search adds them, marked as archived, and resets when the search is
  cleared. With the switch off the server does not search them at all, so
  there is no count of hidden archived matches.

## Consequences

- The live snapshot holds active, snoozed and recently settled sessions, so
  its size follows recent work rather than all history.
- Auto-archive needs a daemon-side sweep. It must be idempotent, record why
  the session was archived (manual or automatic), and never race a send that
  restores the session.
- Subagent children follow their root. Archive state lives on the top-level
  session, and archiving it hides the whole family. So the sweep treats any
  descendant's recent activity, running turn, open approval or queued input as
  activity on the root.
