# Run Ledger rebuild contract (82tn.32.2, 2026-10-23)

Twelve implementation rounds and ten review rounds on 82tn.32.2 found one bug
class: late or stale evidence applied to the wrong Run, attempt, admission or
transmission. Each fix added an identity field and a per-kind staleness rule
(about 21 of them across filter, activity classifiers and inbox), five
synchronised maps held overlapping Run Input facts, and the test oracle read the
implementation's own state, so it shared its blind spots. This rebuild removes
the class by construction.

The public interface is `run-ledger-model.ts` (in this directory) plus four
functions exported from `run-ledger-decider.ts`:

```ts
initialSessionLedgerState(sessionId: string, provider: ProviderKind): SessionLedgerState
decide(state: SessionLedgerState, command: LedgerCommand, ctx: DecideContext): Decision<LedgerEvent>
evolve(state: SessionLedgerState, event: LedgerEvent): SessionLedgerState
viewLedger(state: SessionLedgerState): LedgerView
```

`SessionLedgerState` and `LedgerEvent` are opaque to callers and tests.
`state' = decision.events.reduce(evolve, state)`.

## 1. Correlation: Send Tokens and one drop rule

- Every transmission of a Run Effect is an `IssuedEffect` with a fresh
  `SendToken` from `ctx.newId()`. A retry is a new transmission with a new
  token. Deadlines are `arm_timer` sends; re-arming mints a new token.
- Every Observation and every token-bearing Settlement names the token of the
  send it answers (rules in the `Observation` doc comment).
- One correlation module owns the table of sends and the drop rule. Each send
  records what it is for (Run, attempt, input admission, interaction, probe
  target, deadline kind) and its issue order. Nothing outside the module
  reasons about attempts, admissions, run-id matching or version counters.
- Evidence kinds fall in two classes, declared in one table in the module:
  - lifecycle evidence needs a live token; otherwise it is stale: Accepted
    with no events, no effects, no terminals
  - receipt evidence (input acceptance and decline, accounting, answer
    confirmation, input and answer probe findings) needs a known token, writes
    only the Run Input or interaction record it names, and never changes or
    revives Run lifecycle state
- Retirement is the only way a token stops being live: superseded by a newer
  send of the same purpose, its attempt replaced, its Run Tombstoned, or the
  session ended or its project made inactive. Project removal and session end
  retire every send of the session, including probes and timers.
- Freshness ("is this activity newer than that result?") compares issue order
  of sends. There are no other version counters (`nativeWorkVersion`,
  `issuedVersion`, `resultVersion` go away). A native-session probe's idle
  finding clears only sends issued before the probe.
- Unknown tokens (never issued, or pruned) are stale. A token naming a send
  that cannot produce that evidence kind is Rejected.

## 2. One record per Run Input

- One canonical record per input id holds its admissions in order; each
  admission holds role, priority, location (Inbox, Run, Resolved), InputState
  and the tokens of the sends that carried it. Transmission status lives once,
  in the send table; the record references tokens.
- "Uncertain", "historical", closed-run knowledge and the derived
  `possiblySeen` become queries over the record and the send table, not stored
  maps. `inputHistory`, `inputTransmissions`, `uncertainInputIds`,
  `closedRunKnowledge` and `RunBase.inputAdmissions` disappear, and so do both
  reconcilers (`reconcileUncertainty`, `retainInputHistory`).
- One pruning rule: drop a record once none of its sends is live and every Run
  it touched is Tombstoned, unless it is still uncertain.

## 3. Provider native-policy seam

- Native policy (how to end a Run on Stop, Run now and End; what proves idle;
  how results, permanent interrupt failures and native statuses classify; any
  post-Tombstone probe) sits behind one interface with three adapters: Claude,
  Cursor, OpenCode. The decider asks the policy and never names a provider.
- The terminal classifier (canonical events to terminal evidence) belongs to
  the policy.

## 4. Oracle

- A deliberately naive reference consumes only the public command stream and
  the decider's public outputs (issued effects with tokens, `ended`,
  `viewLedger`). It keeps its own full history and recomputes expected
  visible facts from it. It never reads `SessionLedgerState`, `LedgerEvent` or
  any internal module.
- Differential fast-check traces drive the decider and the reference with the
  same commands. A fake provider picks tokens from issued effects (live,
  retired, very old, fabricated) and delivers evidence late, duplicated and
  out of order. Compare `viewLedger`, terminals and effect shapes after every
  step; tokens are matched by issue order, not by value.

## Round-10 findings the rebuild must make impossible (behavioural statements)

1. Run on attempt 2 expires; successor B queues behind the new close. A
   retained close acknowledgement from attempt 1 arrives. B must not start
   until attempt 2's close is confirmed or its deadline settles.
2. Running A, `run_now(B)` queued, then `project_inactive`. A later receipt for
   A's input must not start B; nothing starts until the project returns.
3. Question q answered with E; E gets a retryable outcome; result(error
   ActualFailure); E retried; then q's delayed confirmation of the first
   transmission arrives, then query_ended. The Run ends as error with
   ActualFailure, not completed.
4. An uncertain answer's interaction probe is scheduled for retry, then
   `project_inactive`. Firing the old retry timer must not transmit anything.
5. The settlement deadline after a result is the one armed at the result; no
   later evidence extends it except evidence the spec says extends it.

## Sources

- Spec: `spec-82tn32.md` (this directory), bead conduit-test-82tn.32.
- Failure catalogue: `docs/plans/2026-10-22-run-ledger-failure-catalogue.md`
  (116 cases; the decider-level ones are acceptance).
- Glossary: `CONTEXT.md` (Run, Run Input, Run Effect, Steer, Tombstone, Run
  Ledger, Send Token).
