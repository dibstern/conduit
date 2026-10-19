# Shared-store scope failure modes

Project A's relay must leave project B's rows and runtime state alone.

| Site | Failure without project scoping |
| --- | --- |
| Outbox reactor | A claims B's pending or due retryable command, executes it, and updates B's outbox and receipt. |
| Claude runner recovery | A recovers or settles B's running Claude command. |
| Orphaned Claude permissions | A resolves B's pending permission ask as orphaned. |
| Session setup recovery | A interrupts B's running setup. |
| Auto-settle sweep | A settles B's eligible session. |
| Worktree cleanup and cold reader | A reads B's worktree launch and schedules cleanup of B's worktree. |
| `session.created` projection | A's conflicting creation event reassigns B's existing session to A. |
| Projection directory recovery | A replaces its directory index with B's sessions as well as its own. |
| Session-pick backfill | A emits picks for B's missing candidates. The store-wide `session_pick_backfill_state` singleton intentionally remains unchanged. |
| Saved model settings | A restores B's settings into A's session manager. |
| Relay startup | B's sessions inflate A's count and can become A's default session. |
| SSE passive workspaces | A subscribes to B's OpenCode workspace directory. |
| Daemon recovery/count/settle probes | B's rows cause A's recovery, running count, or cold-settle probe to report work. |
| Event append ownership | A appends events against B's session and changes B's projections. Missing session rows must still allow creation. |
| Scheduled continuations | A resumes or cancels B's due continuation. |
| Git refresh | A stamps B's session/sidebar versions after refreshing A's directories. |
| Command read-model bootstrap | A loads B's receipts and tombstones into its command state. |
| Command ownership conflicts | A reuses B's command id, overwrites B's receipt, or deletes/settles B's outbox claim. |
| Ownership-check concurrency | A reads ownership before reserving SQLite's writer lock; a concurrent writer makes A's append fail on snapshot upgrade. |
| OpenCode history invalidation | A remembers B's SSE session and marks B's history incomplete on dropped events or reconnect. |
| Background-work attention | A stamps B's session and sidebar after a transient provider event that bypasses event append. |

Projection event replay stays store-wide. Projector cursors are store-wide and
recovery advances them to the latest sequence, so a project-filtered replay would
skip B's unprojected events for good. Projectors write each event under its own
`project_id`, so A's replay projects B's tail into B's rows. Two relays recovering
one store at once could project the same tail twice; 82tn.6.3 moves the runner to
the store tier so one runner owns replay. Global worktree-use reads deliberately
retain foreign sessions to protect shared checkouts from deletion.
