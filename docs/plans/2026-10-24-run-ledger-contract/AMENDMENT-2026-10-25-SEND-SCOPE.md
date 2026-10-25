# Amendment 2026-10-25: send scopes (Q20 = A)

Approved 2026-10-25. This file wins over every other file in this folder. RA is
`AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md`; AUDIT is `AMENDMENT-2026-10-25-AUDIT.md`;
AUDIT-2 is `AMENDMENT-2026-10-25-AUDIT-2.md`.

User-facing behaviour is unchanged.

## Why

R2 phase 1 (32.17) had three review rounds in a row with material findings. Six of the
seven findings were the same bug: the daemon's own per-send resources were never freed at a
lifecycle edge (promote, exit and forget, evict during a send, cancel before the sink is
bound, failure before hello). Two causes:

- RA made `release` a guarded write, so freeing daemon resources needed the runner's grant
  to allow it. Grants change or disappear at every edge, and a refused release is a leak.
- One send's resources had about five owners (sink binding, account demand, pending-send
  entry, `turn.pending`, the provider instance's sink and abort fiber), with no single
  closer that runs exactly once.

Safety (a stale runner cannot write) and cleanup (the daemon frees what it allocated) are
separate concerns. The authority keeps safety. A send scope owns cleanup.

## Supersedes

- RA section 3: the `release` write kind and the policy table's release column.
- RA section 5 step 2 "Release admission and sinks in parallel under the cleanup grant".
- AUDIT A1, last bullet: the cleanup grant no longer bounds sink releases. It still bounds
  in-memory prompt waiters and admission that is not per send.
- AUDIT-2 T1: `Write` has no release kind, so `authorize` never sees one.

## S1. One scope per send

Every send the daemon admits gets one `Scope`, forked from the owning provider instance's
scope (`Scope.fork(parent, "sequential")`). The daemon owns it; no runner holds it.

- **Held:** the sink binding, the account demand, the pending-send entry (with the
  `turn.pending` flag, which is the same fact), and the provider instance's sink and abort
  fiber. Each is registered as a finalizer when it is allocated, in the same step.
- **Closed exactly once, on any ending:** the turn completes, the user cancels (before or
  after the sink is bound), the send fails (including a runner that fails before hello),
  the session is evicted mid-send, the runner exits, is superseded or is retired, or the
  provider instance shuts down (closing the parent closes every child).
- **Close is unconditional.** It is never guarded by a grant and cannot be refused. Close
  is idempotent, so two endings racing is harmless.
- **Close is bounded.** A finalizer that hangs (for example, interrupting the abort fiber)
  is cut off after a timeout and logged; the other finalizers still run.
- **Close writes nothing to session history.** The user still sees each send's outcome
  exactly once, through the existing guarded output and evidence paths.

## S2. A runner may only ask to close its own sends

A `release-sink` frame is a request, not a write. The daemon honours it only when the
frame's `runnerId` is the runner incarnation the send was dispatched to (runnerIds are
minted fresh per incarnation). A frame naming another runner's send closes nothing and is
logged once. Grant state does not matter: a superseded or retired runner may still finish
its own sends, and a runner can never close someone else's.

## S3. Authority changes

```ts
type Write =
  | { readonly kind: "output" }   // session history and live state
  | { readonly kind: "cleanup" }  // session-ended, cohort settlement
  | { readonly kind: "evidence" }; // Run Ledger facts; the ledger judges
```

| Grant state | output | cleanup | evidence |
|---|---|---|---|
| starting | no | no | yes |
| live | yes | yes | yes |
| superseded | no | no | yes |
| exited / retired | no | no | yes |
| cleanup grant, before its deadline | no | yes, its cohort | yes |

RA section 5 step 2 becomes: **close the runner's send scopes** (every send dispatched to
that runner), in parallel with releasing admission under the cleanup grant. Steps 1, 3
and 4 are unchanged.

## S4. Tests

Through the provider instance's interface, one test per ending in S1: every held resource
is released exactly once, and the user sees the send's outcome exactly once. Plus: a
`release-sink` frame from another runner closes nothing. Tests that asserted a release
being refused by grant state are deleted with the release kind.

## Prior art

t3code forks one scope per provider session from a parallel parent scope
(`apps/server/src/orchestration-v2/ProviderSessionManager.ts:2015, 2103`), registers
resources as finalizers, and closes the scope with a timeout in case a finalizer wedges
(`closeScopeWithin`, `:925-935`). Stale callbacks are blocked separately by generation
checks (`:1070-1129`) that never gate cleanup. Conduit scopes per send rather than per
session because a session's sends end independently; the split between safety and cleanup
is the same. Evidence: t3code main@2026-10-24, 24c80f34a1.
