# Amendment 2026-10-25: design audit round 2 (Q19 = A)

Approved 2026-10-25. A second audit of the whole contract, including
`AMENDMENT-2026-10-25-AUDIT.md` (AUDIT, A1-A12), for facts with more than one owner,
bottlenecks, deepening not yet taken, and implicit states. This file wins over every
other file in this folder. RA is `AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md`; BG is
`AMENDMENT-2026-10-24-BACKGROUND-WORK.md`; FB is `AMENDMENT-2026-10-24-FACT-BOOK.md`.

User-facing behaviour is unchanged except A16 (activity after a result always reaches
the screen) and A13 (the notice says whether the kill was escalated).

## Supersedes

- AUDIT A12 "every runner kill ... signals the process group" for escalation: refined by
  A13 (escalation signals the snapshotted members, not only the group via the leader).
- AUDIT A5 "The in-memory caches update after COMMIT": refined by A14 (after COMMIT,
  before the permit is released).
- RA "prune once the process is gone": replaced by A15.
- AUDIT A6's activity rule: refined by A16.
- BG Decision 4 and AUDIT A4 "the tracker re-reads": native reads are ordered (A17).
- AUDIT A7's open-work predicate: extended by A18. AUDIT A7's cost claim: corrected in
  "Bottlenecks".
- AUDIT A8 "Every decision writes the session's `alarmAt`": replaced by A19.
- `Observation = { token } & Evidence` in `run-ledger-model.ts`: replaced by T7.

## A13. Escalation reaches every member of the group

A TERM to the group can kill the leader first. The Stop race then ends on the leader's
exit, so KILL never reaches descendants that ignore TERM.

- At TERM, snapshot the group's members as `{pid, startTime}` (`ps -o pid,pgid,lstart`).
- At escalation, KILL every snapshotted member whose `{pid, startTime}` still matches,
  whether or not the leader is alive. A member that no longer matches is skipped.
- A pgid cannot be reused while any member of the group lives, so a group signal is safe
  while one snapshotted member still matches.
- The retirement row records which signal was sent (T3), so the notice can say "was told
  to stop" or "was force-stopped".

## A14. Ledger caches update inside the permit

Caches update after COMMIT and before the permit is released. A cache updated after the
release can be read stale by the next writer, which already holds the permit. External
effects (sends, signals, browser pushes) still run after the release.

All ledger recording goes through one private `record(tx, evidence)` path. The write seam
rejects nested entry and runs `afterCommit` outside the permit, so a verb that opens its
own transaction or records from `afterCommit` breaks A5.

## A15. Prune only settled survivors

The watcher prunes a retirement row only when the process is gone **and** its
`owned_run_ids` is empty. With the ledger, it prunes only once the loss evidence for the
runner's open work is committed. A dead row with unsettled runs stays until settlement
succeeds; that is the cost of not losing the obligation.

## A16. Activity that changes the phase is always recorded

AUDIT A6 throttles activity, but FB 11A requires OpenCode activity after a result to show
Running again. Activity is always recorded when it changes the execution's phase, or its
order relative to a result. Only repeats within the same phase are throttled.

## A17. Native reads are ordered

Transcript and native goal reads are asynchronous and carry no revision, so a slow read
can undo a newer Clear. Every native read carries an order: the transcript byte offset it
read to, or the native revision where one exists. The goal applies an observation only if
its order is newer than the last one applied.

Recovery compares the goal's condition as well as its status: `Active(A)` does not
confirm `Set(B)`.

## A18. Live or unknown tasks count as open work

AUDIT A7's open-work predicate also includes a session whose background tasks are live or
unknown (T6). Otherwise a session with only background work is never rebuilt and its
tasks vanish after restart.

## A19. Write the session row only when it changes

The per-session row (`alarmAt`, open work) is written only when its value changes. Writing
it on every decision costs one row write per activity frame.

## A20. Every liveness reader asks the ledger

Retained code reads liveness from its own copies. Each moves to `anythingMayAct`:

- the worktree cleanup sweep;
- archive and delete `hasLiveWork`;
- the session status poller's idle corrections;
- the runner record deletion that ignores `runnerGone`.

The physical-process file guard stays (CONTEXT.md: Worktree): it protects files from a
process conduit no longer owns, which the ledger cannot know.

## Other changes

- **Wake admission is origin-dependent.** Admission steers into an active user Run but
  queues behind a wake Run. The common admission interface takes the active Run's origin
  and states this rule once (32.7, 32.23).
- **Native `run_id` order is unproven.** 32.2.11 must not assume `run_id` sorts by time.
  Use the order observations arrive in, or cite evidence that it sorts.
- **Precedence lives in the README only.** Tickets point to it instead of restating it.
- **Tests cross the interface.** Retirement tests that count transaction entries assert
  rollback and restart behaviour instead. Targeted fault injection stays.

## Typed states

Each implicit state becomes a tagged union whose transitions are functions. Illegal
combinations must not compile. Persistence mirrors the union with one tag column; new
tables add a CHECK on it; existing tables (SQLite cannot add CHECK via ALTER) decode with
Schema at the store and reject unknown rows.

### T1. Grants (32.17)

Today `Grant` is a plain `{runnerId, sessionId}` compared by reference, and revoking a
stale grant builds a fresh literal.

```ts
type Grant = StartingGrant | LiveGrant | CleanupGrant; // opaque; only adopt and revoke mint
interface CleanupGrant { readonly target: CohortTarget; readonly expiresAt: number }
authorize(g: Grant, w: Write, now: number): Option<AuthorizedWrite>
```

### T2. Runner record (32.17)

Today the records map is returned mutable and mutated at about fifteen call sites;
`candidate` lives in two places; `RunnerIdentity` has eleven optional fields; `cleanup`
is independent of the tag; `observed` and `watching` are mutable booleans.

```ts
type RunnerRecord = Starting | Live | Exiting | Retired; // one variant per tag, required fields
promote(r: Starting): Live
revoke(r: Live, reason: Revocation): Exiting | Retired
```

The authority exposes read-only snapshots and verbs (`observe`, `markSignalled`,
`forget`). No caller mutates or deletes a record.

### T3. Retirement row (32.17)

Today: nullable `retired_at`, `pid` and `start_time`; `owned_run_ids` as TEXT read with
`JSON.parse(...) as readonly string[]`; `signalled` as an integer.

```ts
type Identity = { tag: "Verified"; pid: number; startTime: string }
              | { tag: "Unverifiable"; pid?: number };
type Retirement = { tag: "Watching" } | { tag: "GonePending"; owned: readonly RunId[] }
                | { tag: "Complete" };
type Signal = { tag: "None" } | { tag: "TermSent"; members: readonly Member[] }
            | { tag: "KillSent" };
```

The row is decoded with Schema at the store.

### T4. Goal (32.26, 32.27)

```ts
type Confirmed = Active | Paused | Limited | Met | Cleared;
type Pending = None | { tag: "Pending"; id: CommandId }; // references the stored payload
confirm(g: Goal, o: OrderedGoalObservation): Goal
```

Displayed phases are derived; there is no transitional-phase column.

### T5. Native commands (32.2.11)

```ts
type NativeCommand = Sent | Queued | Started | Unconfirmed | Completed | Cancelled | Failed;
```

Only the waiting variants carry a deadline. A late reply moves `Unconfirmed` to
`Completed`.

### T6. Task certainty (32.2.2, 32.22)

```ts
type Tasks = { tag: "Unknown"; label: Label }
           | { tag: "Known"; label: Label; tasks: ReadonlyMap<TaskKey, Task> };
```

An empty `Known` derives no tasks. The runner host's idle check uses the same reducer
instead of its `backgroundWork` boolean, and resets to `Unknown` when the query is
replaced.

### T7. Observation (32.2.2, 32.2.11)

```ts
type Observation = { tag: "Answer"; token: SendToken<K> } & EvidenceFor<K>
                 | { tag: "Unsolicited"; label: Label; eventId: EventId } & Evidence;
```

### T8. Send chains and Send Tokens (32.2.2)

```ts
type Transport = { tag: "Retrying"; at: number } | { tag: "Failed"; code: SendErrorCode }
               | { tag: "Issued" | "Unknown" | "Sent" };
observe<K extends EffectKind>(s: Send<K>, e: EvidenceFor<K>): Decision
```

Consumption is its own union. Transport and consumption stay separate.

### T9. Deadlines (32.2.2, 32.3)

Each deadline is tagged by its owner (Run, send, interaction, native command, Tombstone)
with a required target. `alarmAt` stays a projection of the earliest one.

### T10. LedgerView.active (32.2.2)

A union by Run tag, so `by` exists only on Interrupting and the deadline kind is tied to
the tag. `InputView.uncertain` is deleted; `InputState` already says it.

### T11. Runner host idle (32.22)

```ts
type HostIdle = { tag: "Open"; commands: ReadonlySet<CommandId> }
              | { tag: "Draining"; tokens: ReadonlySet<Token> } | { tag: "Exiting" };
```

Sets keyed by command or token replace the `turns` counter, which can go negative. The
host's task and idle caches are invalidated when the query is replaced.

### T12. Per-session ledger row (32.3)

`Quiescent | Open { alarmAt?: number }`, with an index on the earliest alarm.

### Over-engineering, not done

- One union for every host counter.
- Merging transport and consumption into one machine.
- Storing derived labels (displayed phases, "Checking tasks...") as machines.

## Bottlenecks

- **AUDIT A7's cost claim was wrong.** Startup is proportional to the history of open
  sessions, not to open work. Checkpoints are added only if measurement shows a need.

## Tickets

| Ticket | Change |
|---|---|
| 32.17 (R2) | T1, T2, T3, A13, A15 before the ledger; the Stop idle with no Run id; retirement tests through the interface |
| 32.2.2 | T6, T7, T8, T9, T10 |
| 32.2.5 | A16 |
| 32.2.11 | T5, T7, `run_id` order |
| 32.3 | A14, A18, A19, T9, T12 |
| 32.4 | A15 with the ledger |
| 32.7, 32.23 | wake admission |
| 32.22 | A20, T6, T11 |
| 32.26, 32.27 | A17, T4 |
| tickets with precedence prose | point to the README |
