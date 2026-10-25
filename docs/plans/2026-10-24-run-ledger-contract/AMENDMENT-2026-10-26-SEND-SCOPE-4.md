# Amendment 2026-10-26: requeue, don't replay (Q23 = A)

Approved 2026-10-26. This file wins over every other file in this folder, including
`AMENDMENT-2026-10-25-SEND-SCOPE-3.md` (SEND-SCOPE-3), whose `Recovered` origin it removes.

User-facing behaviour is unchanged.

## Why

Six review rounds in a row, across SEND-SCOPE-2 and SEND-SCOPE-3, found material bugs, all
in runner-level replay of recovered sends. Two things decided a recovered send's fate: the
durable outbox row and the in-memory recovery snapshot (handle, binding, `isEnded` read).
Every finding was a race between them: a send that ended between the read and the
admission, a cached runner reply that left a handle dispatched, a failed read that
abandoned the row as `running`.

The fix removes the second decision-maker. The outbox row alone decides, and a send the
runner never received goes back through the one path every other send takes.

## S7. Requeue, don't replay

- **Recovery runs nothing.** When a runner reconnects, recovery reads its hello and, in one
  transaction, settles each `running` `send_turn` row of that session:

  | the row | what recovery does |
  |---|---|
  | in `hello.sendCommands` (the runner holds it) | adoption, unchanged |
  | in `hello.completedCommands` | settles it from the reported result or failure, as a live `command-reply` would; nothing is dispatched |
  | `error_code = 'delivery_indeterminate'` | unchanged; never resent |
  | anything else (the runner never received it) | moves it to `retryable_failed` with `next_attempt_at = now`, keeping its run and `request_sequence`; writes no user-visible event |

- **The reactor re-sends it as an ordinary send.** The requeued row is a `Fresh` send through
  the one admission. Its attempt increments, so its `sinkId` is new, which S6 already treats
  as a new send. Later sends of the session stay behind it, because the reactor already
  blocks on an earlier `retryable_failed` row. Claude re-prepares from stored state, as the
  replay did, so native resume is unchanged.
- **`SendOrigin` is `Fresh | Adopted`.** The `Recovered` origin, the replay callbacks, the
  per-driver recovery replays and the `Recovered` refusal branch are deleted. The reactor's
  refusal path already records the failed message and restores the draft on
  `send_admission_timeout`.
- **A live owner wins.** If a reactor call in this daemon still owns the row (the daemon did
  not restart), recovery leaves the row to it, and that call's own failure path decides
  whether it retries.

Unchanged: adoption, the abandoned-runner path, `project_inactive` rows, S1 to S5, and S6
apart from the removed origin.

## Tests

Through the provider instance's and the reactor's interfaces:

- after a daemon restart, a pending send the living runner never received runs once,
  through the reactor, in the same run, with one terminal and the user message shown once;
- a send the runner finished while the daemon was down is settled from the hello and is
  not run again (the runner receives it once);
- a send the runner still holds is adopted as before;
- a `delivery_indeterminate` send is not resent;
- a requeued send refused at the admission timeout shows the failed message once and
  restores the draft once;
- a send queued after a requeued one does not overtake it.

## Prior art

t3code offers redelivered work back into the request queue as new work
(`apps/server/src/orchestration-v2/Orchestrator.ts`, `continuationRequests.offer` near line
1220) and never replays below the orchestrator. Evidence: t3code main@2026-10-24,
24c80f34a1. Conduit's reactor already reopens control commands only once the runner proves
it never received them (`getControlCommandStatusEffect`, `not_received`); S7 applies the
same rule to sends.
