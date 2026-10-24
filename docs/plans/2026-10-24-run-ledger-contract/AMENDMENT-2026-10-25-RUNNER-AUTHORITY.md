# Amendment 2026-10-25: Runner authority (Q15 = B, Q16 = A)

Approved 2026-10-25. Replaces the durable half and the write checkpoint of "Runner
lifecycle" in `AMENDMENT-2026-10-24-BACKGROUND-WORK.md` with one module that owns who
may write for a runner process, and one durable owner of retirement.

**Why.** The previous design kept five stores of runner authority: the in-memory tag, a
`.retired` file, the receipt cursor row, a planned `runner_generations` table and the
ledger's generation evidence. Each had a slightly different answer, and review kept
finding gaps between them. The `.retired` file existed only so retirement didn't have to
wait for SQL. That wait was never needed: every writer already queues on the same commit
permit, so a revocation that is synchronous in memory and rides the next commit is
neither slower nor weaker than a file.

## Supersedes

In `AMENDMENT-2026-10-24-BACKGROUND-WORK.md`, "Runner lifecycle":

- **Section 1 (Identity):** replaced by section 2 below.
- **Section 2 (Runner record):** kept, except the "Daemon restart" transition (section 4
  below) and the table, whose rights move to the policy table in section 3.
- **Section 3 (Write checkpoint):** replaced by section 3 below. `authorize`, the three
  authority kinds and the SQL predicate are gone.
- **Section 4 (Retirement):** steps 2 and 3 and the 11A hold are replaced by section 5.
- **Section 5 (Survivors):** kept, with "marker" read as `retired_at` (section 6).
- **Section 6 (The durable half):** replaced entirely by section 4.
- **Section 7 (Slices):** replaced by section 9.

In `AMENDMENT-2026-10-24-FACT-BOOK.md` section 2, "each kill or process loss bumps
[the process generation]" is replaced by section 7 below. The ledger never mints or bumps
generations.

## 1. Ownership: one owner per fact

| Fact | Single owner | Cached by |
|---|---|---|
| Runner identity (`runnerId`) | daemon, minted per spawn | the runner record |
| Which query inside a host is current (`querySeq`, the query object) | runner host | nothing in the daemon |
| Who may write for a runner (tag) | `RunnerAuthority` in memory | nothing: lifecycle code reads it, never copies it |
| Runner retired, across restarts | SQL: `retired_at` on the runner's `claude_runner_cursors` row | the tag, which leads SQL (invariant I2) |
| Survivor identity and owned runs | the same row | the survivor watcher |
| Replay cursor and attachment | the same row | none |
| Registration (socket, pid, role) | runner host's `.json` | discovery |
| Run staleness, Send Token, coverage | Run Ledger | none |
| Duplicate sends at the host | host send journal, keyed by Send Token | none |
| Survivor notice sent | the deterministic notice event id | none |

Each layer owns one identity: the daemon owns `runnerId`, the host owns `querySeq` and
its current query, the ledger owns the Send Token.

## 2. Identity

- **Generation = `runnerId`.** The daemon mints it per spawn (it already does) and passes
  it to the host on the command line. A surviving host keeps it across a daemon restart;
  only `attachmentId` rotates.
- **Query replacement inside one host is fenced by the host.** Rebind, agent change,
  rewind, fresh native id, stop-after-foreground dispose, discarded prewarm and
  native-resume fallback all replace the SDK query while `runnerId` is unchanged, and the
  old query closes asynchronously, so old and new overlap. `runnerId` alone can't tell
  their frames apart. The host owns this: each query's output callbacks capture the query
  object when it is created, and a frame from a query that is no longer current is
  dropped at capture (by object identity, as t3code does). Frames travel in order over
  one socket, so anything the old query emitted before replacement arrives before
  anything from the new one.
- **Evidence passes the host fence.** Acceptance and terminal facts from a replaced query
  still go to the daemon, so late acceptance reaches the ledger (Fact Book invariant I1).
- **Evidence label `runnerId:querySeq`.** The host keeps a counter, `querySeq`, bumped on
  each query replacement, and stamps it on every frame. Only the ledger reads it, as an
  opaque label. The hello carries the current `querySeq`. A host from an older build has
  no counter; its frames are labelled `runnerId` alone and it has no in-host fence, which
  is today's behaviour. 32.5's old-runner rule refuses such hosts new work.
- Logs carry `runnerId` and, where present, `querySeq`.

## 3. RunnerAuthority

One module, three entry points. It holds the records map's tags.

```ts
interface Grant { readonly runnerId: string; readonly sessionId: string } // opaque capability
type Write =
  | { readonly kind: "output" }                       // session history and live state
  | { readonly kind: "release"; readonly sink: Grant } // release a sink bound to that grant
  | { readonly kind: "cleanup" }                       // session-ended, cohort settlement
  | { readonly kind: "evidence" };                     // Run Ledger facts; the ledger judges
type Revocation = "superseded" | "exited" | "retired";

interface RunnerAuthority {
  /** Discovery, spawn, hello, promotion. The only door to a Grant. */
  readonly adopt: (runners: readonly RunnerIdentity[], phase: "starting" | "live") =>
    Effect.Effect<{ grants: ReadonlyMap<string, Grant>; survivors: readonly Survivor[] },
                  AuthorityUnavailable>;
  /** Synchronous: no I/O on the caller's path, cannot fail. Returns the cleanup grant. */
  readonly revoke: (grant: Grant, reason: Revocation,
                    cohort?: { readonly ownedRunIds: readonly string[] }) => Effect.Effect<Grant>;
  /** Every runner-derived write (slice R2). Durable ops are rechecked at commit. */
  readonly guarded: <A, E, R>(grant: Grant, write: Write,
                              op: Effect.Effect<A, E, R> | (() => A)) =>
    Effect.Effect<Option.Option<A>, E, R>;
}
```

**Invariants**

- **I1:** `revoke` flips the tag synchronously. A guarded write whose final commit hook
  runs after that returns `None`.
- **I2:** No commit through the write seam lands after `revoke` without the tombstone:
  the seam's final hook flushes pending tombstones into the same transaction.
- **I3:** At most one live grant per session. Adopting a newer runner as live revokes the
  previous one as `superseded` in the same synchronous step.
- **I4:** A revoked grant never revives. `adopt` refuses any runner whose row has
  `retired_at` set and returns it as a survivor.
- **I5:** The cleanup grant expires at a shared deadline of about **3 s**. It carries the
  cohort captured at `revoke`. A grant revoked while Starting has an empty cohort, so its
  cleanup writes are refused (a cancelled warm candidate emits nothing).
- **I6:** `evidence` passes at any generation, even after retirement.
- **I7:** Memory thunks run immediately after the check, with no yield in between.

**Policy** (behind the seam; replaces `withEntryOutput` and its call-site exceptions):

| Grant state | output | release | cleanup | evidence |
|---|---|---|---|---|
| starting | no | no | no | yes |
| live | yes | yes | yes | yes |
| superseded | no | its own sinks | no | yes |
| exited / retired | no | no | no | yes |
| cleanup grant, before its deadline | no | sinks of its runner | yes, its cohort | yes |

Warmup replies are protocol replies, not writes, and are not checked.

**Errors.** `guarded` never fails for staleness: it returns `None` and logs once per
(runnerId, kind); the op's own `E` passes through. `revoke` cannot fail; a failed
tombstone flush is logged and retried. `adopt` fails with `AuthorityUnavailable` only
when the retired rows can't be read; recovery defers and nothing is adopted.

**Guard test (R2).** Runner-derived writes may not open `sql.withTransaction` directly;
they go through the write seam. A runner-derived write that reaches the seam without a
grant is a defect, not an unchecked daemon write. Prove the test red with a planted
bypass.

## 4. Durable retirement

- `claude_runner_cursors` gains `retired_at` (set-only) plus `pid`, `start_time` and
  `owned_run_ids` for survivor identity. Existing rows start not retired.
- Retirement sets `retired_at` and clears `attachment_id` in one statement. Attach adds
  `WHERE retired_at IS NULL`, so reconnect never revives a retired runner.
- **Tombstone flush.** `revoke` queues the tombstone per SQL client and forks one
  standalone write. The write seam's final hook also flushes any pending tombstone into
  whichever transaction commits next. Whichever runs first wins; both are idempotent.
- **Restart.** Discovery adopts every registration through `adopt`: a row with
  `retired_at` is a survivor, never adopted; a retired row with no registration is still
  a survivor until its process is confirmed gone. A retired runner's spooled output is
  dropped before replay.
- Rows with `retired_at` are pruned only with the cursor row, after the process is
  confirmed gone.
- **Deleted:** the `.retired` marker and everything around it (the retired branch of
  registration, the discovery override, `role: "retired"`, the `.retired` suffix in
  removal), `runner_generations`, the pre-commit SQL predicate, and `legacy:<runnerId>`.

## 5. Retirement transition (replaces section 4 of Runner lifecycle)

1. `revoke(grant, "retired", cohort)`: tag Retired, tombstone queued, standalone flush
   forked. Synchronous; nothing on the caller's path waits for SQL.
2. Release admission and sinks in parallel under the cleanup grant.
3. Settle owned runs and process-specific prompts and controls, detached, under the
   cleanup grant; the grant expires at the deadline.
4. Schedule the survivor watcher and notice, whatever happened in steps 2-3.

Recovery runs the same path. **There is no hold:** the 11A "Couldn't retire the old runner
safely" state, its Retry and the refusal of sends are deleted, because no step can fail
in a way that leaves the old runner able to write.

## 6. Survivors

Section 5 of Runner lifecycle stands, read with these changes: "marker" means
`retired_at`; "record and marker removed" means the record leaves the map and the row is
pruned once the process is confirmed gone; at restart a retired row restarts the
schedule; two live registrations for one session means the newer is adopted and the
older revoked as retired.

## 7. Run Ledger generations (replaces Fact Book section 2's "bumps")

The ledger never mints or bumps generations. It records `process_started` and
`process_lost` evidence and query-ended evidence, each naming the host's label
(`runnerId:querySeq`, or `runnerId` for an older host). A kill or process loss covers the
sends of every label of that `runnerId`; a query ending covers the sends of its label.
`hasAuthority`'s "its generation is not covered" reads that coverage unchanged.

## 8. Other ownership changes

- **32.5 runner protocol:** commands carry the Send Token and events name it. No run id,
  no attempt, no "highest attempt seen"; a repeated start is deduplicated by token. The
  same protocol bump adds `querySeq` on frames and hello (section 2).
- **32.13 send journal:** stays, as the host's duplicate check keyed by Send Token. It is
  not a second owner of delivery: the ledger owns it, the journal only refuses a repeat.
  The session inbox becomes a read view of the ledger: the ledger owns inbox order and
  pause.
- **32.26 and 32.27 goal tracker:** stores the confirmed provider status and the pending
  action id only. Pausing, Clearing and Resuming are derived from the pending action;
  "returns to the previous phase" is deleted, because a failed action simply leaves the
  confirmed status showing.

## 9. Slices (replaces section 7)

- **R1 Runner record and authority** (32.16): records map and tags held by
  `RunnerAuthority`; `adopt` and `revoke`; the retirement transition of section 5;
  `retired_at` and the tombstone flush (formerly R3's durable half); survivors; deletion
  of the `.retired` marker, the 11A hold and `runner_quarantined`. The f4 stopgap's write
  fences stay until R2; its marker-related fences go now.
- **R2 Guarded writes** (32.17): `guarded`, the policy table, the guard test, and
  deletion of `withEntryOutput`, `currentCommitGuard`, the receipt `isCurrent` callback,
  ingestion's receipt `beforeCommit` and the remaining f4 fences. Blocked by R1.
  **R1 and R2 merge to main together**, so main never carries the stopgap (13A).
- **R3:** folded into R1. Closed.
- **R4 In-host query fence** (32.19): section 2's host fence and `querySeq` on frames and
  hello. One protocol bump shared with 32.5. Blocked by R2.
- **R5:** not needed; there is no legacy generation. Closed.

Background-work tickets depend on R1 and R2. Those that read generations (stale confirm,
a generation change mid-interrupt) depend on R4 for the `querySeq` label.

## 10. Residual risks

1. **Crash between revoke and the flush.** If the daemon dies after `revoke` and before
   either flush commits, and the process survived SIGKILL with no newer registration, it
   can be re-adopted at restart. The window is about one permit wait. The previous
   design's rename wasn't fsynced either.
2. **Grants travel on fiber context.** A fork with an empty context loses the grant. The
   guard test's "runner write without a grant is a defect" catches it.
3. **A failing tombstone insert fails closed for every seam write**, daemon-wide. Only
   disk-level errors cause that, and those already fail every write.
4. **SQLite's 5 s busy wait is synchronous** and blocks the event loop. No design here
   bounds it. Follow-up outside 32: a time budget on transactions held by the write seam.

## Prior art (manifest 2026-10-24)

- **Closest: bb**, which keeps a process instance and a session serial on one record and
  checks both on write. Conduit's grant is that record, with `retired_at` making it
  survive a restart.
- **t3code, bb and paseo** fence by in-memory object identity. Conduit does the same for
  query replacement inside the host.
- **diri** is the only other design where the process survives a daemon restart; its
  incarnation lives in a holder state file. Conduit keeps that fact in the SQL row
  instead, so there is one durable store.
- **monocode and diri's hooks** have known fencing gaps; conduit's guard test closes the
  equivalent gap.
- **No competitor** has a durable retirement marker, a hold on retirement failure, or a
  second durable store for authority. Conduit drops all three.
