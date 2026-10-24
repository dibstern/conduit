# Run Ledger amendment: Fact Book, every summary derived (82tn.32.2, 2026-10-24)

Supplements AMENDMENT-2026-10-23.md, RULINGS-2026-10-23.md,
RULINGS-2026-10-23-D1.md and AMENDMENT-2026-10-23-OUTSTANDING-WORK.md. Where
this file and those (or CONTRACT.md, spec-82tn32.md) disagree, this file wins.
The user approved this design on 2026-10-24 (Q8 = A whole ledger; Q9 = A + I +
J; design sections 1-5 approved; rulings 10A, 11A, 12A).

## Why

The Outstanding Work design removed the stored fence and the stored admission
outcome, but the ledger still stored other copies of evidence, each written by
hand: Run states mirroring send facts (`Settling.resultOrder`,
`Interrupting`, `terminal`, `activityOrder`), answer `delivery`, admission
`absenceProofs`, location and the two-sided admission/send link, hand-closed
send deadlines, and session flags (`inactive`, `current`). `hasAuthority` was
undefined (circular if it read Run state). Session-wide coverage used order
numbers as a stand-in for "sent to that process". Four independent redesigns
and a seven-competitor survey (manifest below) converged on one rule: store
only evidence and conduit's own decisions, each once; every summary is a view.

## What stays from AMENDMENT-2026-10-23-OUTSTANDING-WORK.md

Decision 1's scope (steps 2 and 3 together with the D1 ledger change); Q8A
replaces its single implementation ticket with a sequence of tickets.
Decision 4's edge cases, Decision 5's testing (amended below), and the
precedence rules. Rider L stands as section 1's policy seam. Rider K is
superseded: executions are stored directly (section 2), so there is no
opaque key to switch later. Its module interface survives inside the
module: `record` is the only writer; `mayStillAct`, `hasAuthority`,
`receiptAddress`, `fenceHolds` and `inputOutcome` are views calculated by
`read`. Its "session-wide facts cover every send issued before" is replaced
by generation coverage (section 2).

## 1. Architecture

- One deep module. The public interface is unchanged
  (`initialSessionLedgerState`, `decide`, `evolve`, `viewLedger`, model
  types) and is the only seam callers and tests cross.
- Three private parts:
  - `record(state, entry)`: the only writer. An entry is evidence or a
    conduit decision. Evidence merges by join (order-free, duplicate-safe).
    Decisions are ordered and validated; an illegal decision (such as a
    second terminal for a Run) is a typed rejection, never a throw.
  - `read(state)`: every summary (Run phase, input outcome and location,
    inbox order, answer delivery, fence, deadlines, `alarmAt`, view).
  - `reconcile(situation, ctx)`: the next decision or none. Reads only
    `read`'s output, never the triggering command. Runs to a fixpoint with a
    hard step bound (64) that returns Rejected.
- `LedgerEvent` is one entry; `evolve` is `record`. Whole-state snapshot
  events are removed (needed for 82tn.32.3 persistence).
- An evidence table keyed by every `Evidence["kind"]` (mapped type; a missing
  kind is a compile error) declares class (lifecycle or receipt), which
  effects may produce it, and its merge. It replaces the `accepts` switch and
  `evidenceClasses`.
- Lookup indexes are declared caches written only by `record`. Drift
  between a cache and a full rebuild is caught through the public interface
  by invariant I4 (section 5), not by a test that reaches inside.
- Provider policy is the one real seam, split into intake (provider event to
  evidence; called by the interpreter, never by `decide`) and decision rules
  (plain data and pure predicates: what ends a Run, what fences, what an
  idle probe proves, when work has ended, the stop sequence). Adapters:
  Claude, Cursor, OpenCode.
  The table is keyed by `ProviderKind`; Codex is future work (no adapter
  exists), forced by the compiler when added.
- Replaced: correlation, transmissions, send-proof, input-records, answers,
  lifecycle, deadlines, queue, dispatch, internal. Kept: model, policy
  (reshaped), outcome fold (as a join), the `decide` facade.

## 2. Stored state

Only evidence and decisions, each once:

- Session: id, provider, an entry counter, stop/end/resume decisions,
  project inactive/active and session-ended evidence. Paused and project
  gate are derived. Resume clears only an ordinary pause (9B).
- Send (issue decision): effect, entry number, time, the Run, admission or
  interaction it serves, the execution and process generation it went to,
  an optional deadline. Probes also store the sends they cover, captured at
  issue. Evidence: a transport chain, a consumption chain, probe finding,
  accounting, native message id (first write wins; a contradiction is
  rejected, 6C).
- Execution (launch decision): Run and generation. Evidence: started, latest
  activity, results keyed by the send they answer, query ended.
- Run (decisions only): Queued -> Launched -> Interrupting -> Ended. Queued
  stores the timeout budget at reservation, because timeouts arrive with
  each call and can change between calls. Launched names its execution;
  Ended carries the outcome taken from the fold (section 3).
- Admission: input, priority, cancelled. Interaction: request evidence,
  answer decision (first wins; user or timeout), resolved evidence.

Process generation: each kill or process loss bumps it. Process loss and
runner release cover exactly the sends of that generation.

`hasAuthority(execution)`: the execution is its Run's current one, the Run
is not Ended, its generation is not covered, the project is active, and its
native session has not ended. This is the single read of Ended (a decision,
not a copy of evidence) and replaces the fourteen guards.

Deleted: `nativeFence`, stored admission state, `absenceProofs`, both sides
of the admission/send link, `Send.live` and its deadlines, `terminal`,
`activityOrder`, `resultOrder`, `current`, `inactive`, answer `delivery`,
both prune functions.

Model changes: `LedgerView.live` means "work that may still act", in issue
order (the oracle follows). Add `project_active` settlement, input
`Dispatching`, `InteractionView.lastRefusal`, a diagnostic on Accepted.
Remove `quarantine` (D1-1).

## 3. State machines and data flow

`decide`: map the command to one entry and record it; run `reconcile` to a
fixpoint; return the entries, effects, Tombstones and `alarmAt`. A duplicate,
or evidence that changes no join, is Accepted with no events.

Send chains (join = max):

- Transport: Issued < Retrying{earliest at} < Failed{lowest code} < Unknown
  < Sent. A success always beats a failure (as send-proof does today).
- Consumption: None < NotConsumed{declined | absent} < Observed < Accepted.
  Acceptance is proof, so it beats an earlier "absent".

Work ended is derived: the execution's evidence under the policy's work-ended
rule, a covering idle probe the policy trusts, or coverage of its generation.

`mayStillAct`:

| Consumption | Issued, Unknown, Sent | Retrying, Failed |
| --- | --- | --- |
| work ended | no | no |
| Accepted, Observed | yes | yes |
| NotConsumed | no | no |
| None | yes | no |

Run machine, moved only by `reconcile`: reserve -> Queued (only with no
active Run); launch -> Launched (a new execution: the only fold reset);
interrupt -> Interrupting (policy stop sequence); tombstone -> Ended
(absorbing; outcome from the fold at that moment). Labels are derived:
Launched with no evidence shows as Starting, with activity as Running;
Settling means an OpenCode-style policy has a result with no later
activity.

`reconcile` rule order: expired deadlines; end conditions (with authority);
interrupts; answers, retries and probes; steers; advance (start the next Run
if the fence is clear). A probe is sent only when a deadline calls for one,
never on every decision.

Deadlines are derived: each Run phase (Queued, Starting, Running,
Interrupting, Settling) from its stored time and budget (Settling fixed at
the result); each send's cleanup or retry while it may
still act; permission timeouts. `alarmAt` is the minimum. A deadline is due
only when an alarm recorded after it opened reaches its time (latest alarm
time seen, so a clock going backwards cannot fire early or twice).

Rulings:

- 10A. The 5C fold keeps the specific code with the lowest send number, then
  the lowest code: "first" means first in issue order, independent of
  arrival order.
- 11A. On OpenCode, activity after a result (from a steer) shows as Running
  again and keeps the fold. Only a new execution resets it (5C literal); an earlier
  error stays the outcome even if a later steer completes.
- 12A. Evidence after a Run ends is recorded only when it changes a join
  (accounting, an acceptance that holds the fence). Contract text becomes
  "no effects, no change to the Run". Duplicates produce no events. A
  frozen execution's fold does not change.

## 4. Edge cases and errors

- Unknown or never-issued token: Accepted, no events, diagnostic.
- Wrong evidence kind for the send, or a contradicting native id: Rejected,
  diagnostic, no state change.
- A `reconcile` bug (illegal decision or more than 64 steps): Rejected with
  a diagnostic; the model-based traces catch these. The catch-all try/catch
  is removed.
- R5: an input is refused only when every send ended with no acceptance; the
  fence and interrupt hold while any sibling may still act.
- Late acceptance after a refused Tombstone: recorded; the send may act
  again; the fence holds; the Tombstone is unchanged; cleanup deadline is
  Tombstone time plus the settle budget; expiry closes (Claude) or probes
  (OpenCode).
- Result after process loss: nothing changes (12A); accounting is recorded.
- Any kill outcome (D1): release; generation bumps; work ends; fence releases
  with no probe; Run ends Interrupted, forced. Later evidence from the old
  runner cannot reopen anything.
- Claude process loss: same coverage; Run ends process_lost.
- Unknown delivery blocks automatic resend until a probe settles it; neither
  unknown nor sent implies Accepted.
- OpenCode: Run end is query ended; a failed interrupt keeps its work open
  until a probe proves idle; idle covers only confirmed-delivery sends.
- Answer refused (10B): Pending with `lastRefusal`, answer kept; an ambiguous
  earlier transmission is settled before a retransmit with a fresh id.
- Session ended: removes authority over that native session's work; fresh
  admission opens a new native session (G6).
- Project inactive: retires everything; project active reopens it with
  reconciliation probes before any dispatch; retired tokens never revive.
  Resume never clears this gate (9B).
- Clock going backwards: due-ness uses the latest alarm time seen, so skew
  cannot fire a deadline early or twice.
- No pruning (step 5). `read` uses the caches: cost per decision is
  proportional to live work; rebuild on load is proportional to history,
  once.

## 5. Testing

Through the public interface only.

- fast-check model-based traces per provider (Claude, Cursor, OpenCode) over
  the full public alphabet: user commands, every evidence kind including
  every send and kill outcome, settlements, and alarms at arbitrary times.
  Evidence targets live, stale and never-issued tokens and arrives after
  Runs end.
- Fake provider as ground truth:
  - I1: no start while the fake holds accepted, unended work on that native
    session.
  - I2 (restated): evidence the fake could deliver in either order yields
    the same send, admission, fence and accounting views once both have
    arrived. A Tombstone decided between them may differ in outcome.
  - I3: at most one terminal per Run; Tombstones immutable.
  - I4 (new): replaying a decision's entries through `evolve` from the
    initial state gives the same view as the live state (covers cache
    drift without exposing the caches, and proves the entries are real
    facts that 82tn.32.3 can persist).
- Oracle differential (effects, `alarmAt`, view) every step. The oracle is
  updated by a separate author who reads only the contract docs and the
  public model. The update covers this file, D1 and rulings 10A to 12A,
  including the new meaning of `live`. The `pendingCases` ratchet stands.
- Coverage gate: every evidence kind and these races have hits: start
  refused with an accepted sibling, process loss mid-Run, runner release,
  late acceptance after a Tombstone, unknown delivery settled by a probe,
  evidence on both sides of a Tombstone.
- Fixed traces: R1-R5 and the six seeded cases; R5 red on the pre-redesign
  tree before implementation; every shrunk failure added.
- Artifact: JSON of seeds, hit counts per kind and race, shrunk failures.
  CI runs a fixed seed set; an environment variable enables long runs.

## Prior art (manifest 2026-10-24)

t3code eb1510d249, bb 1e80ca7b44, paseo fed19f3d29, zeron dd0c36fa3e, diri
e280a76d3f, monocode 26465c6209, capy docs fetched 2026-10-23T13:04:04Z.
Evidence: /tmp/82tn-beads/art-ows2/*.md. Design-it-twice reports: four
agents briefed by /tmp/82tn-beads/dit-brief.md.

| Competitor | Stored copies | State machine | Late-evidence identity |
| --- | --- | --- | --- |
| t3code | many, hand-written | typed statuses, no per-send machine | attempt, native turn, process generation |
| bb | immutable request/acceptance records plus mutable summaries | explicit transition tables | process instance, session serial |
| paseo, zeron | handler-written summaries; zeron separates delivery from consumption | typed stopping states; per-adapter machines | revision-checked / epoch-gated probes, version-fenced receipts |
| diri, monocode, capy | summaries plus audit trail; derived delivery badges | task lifecycle; reducer over flags; run vs turn | message and command ids; pid-fenced exits |

Shared trap: most competitors treat acceptance, or the message appearing in
the transcript, as proof of delivery. Conduit's separate transport,
consumption and work-ended facts avoid it.

Conduit takes process generations (t3code, bb), turn end separate from
session reusable (t3code, capy), an explicit Run transition table (bb),
probes that record what they cover (paseo, zeron), and transport separate
from consumption (zeron, diri). It departs on purpose: no stored summaries
(every competitor stores copies and its churn sits there), and model-based
traces added on top of hand-written scenarios. Every competitor uses only
hand-written scenarios (bb and diri surveys searched for property, fuzz and
model-checking tools and found none). Their reasons are real: scenarios are
readable, need no reference model, and can run against real providers. Most
of them also cannot test this way, because their run state is spread across
effectful handlers with no pure step function to drive. Conduit keeps
hand-written scenarios as the fixed traces and keeps real-provider E2E for
provider behaviour; the model-based traces cover the order-of-arrival races
that hand-written scenarios kept missing (every 32.2 review finding was one).
