# Run Ledger contract amendment (82tn.32.2, 2026-10-23)

Amends `CONTRACT.md` and `spec-82tn32.md` in this directory. Where this file
and those disagree, this file wins. The user approved these decisions on
2026-10-23 (answers 1D 2C 3B 4B 5C 6C 7B 8C 9B 10B, design HL-K). The
diagnostic evidence behind each question is `art-rl-triage/report.md`
(sections G1-G8 and "The decider author's three interpretations").

The public interface is unchanged: `run-ledger-model.ts` plus
`initialSessionLedgerState`, `decide`, `evolve`, `viewLedger`. State and
events stay opaque. Model types may change where a step below says so.

## Why

Q1, Q4, Q7 and Q8 were symptoms of one fact having two owners (a deadline
lived both in its obligation and in a timer send; "live" meant three things at
once). HL-K gives each fact one owner. Q3, Q5, Q6, Q9 and Q10 are real rules,
fixed below.

## HL-K: five steps, implemented in this order

Each step lands as its own commit with the oracle and the differential green.

### Step 1. Each obligation owns its deadline; one projected alarm (Q1=1D, Q4=4B)

- Deadlines are data on the obligation they bound (close confirmation,
  settlement after a result, probe retry, interaction probe retry). They are
  not sends and carry no Send Token. `arm_timer` sends go away.
- An Accepted decision carries `alarmAt?: number`: the earliest open deadline
  in the state after the decision's events, or absent when none is open. The
  interpreter keeps one timer and resets it to `alarmAt` after every Accepted
  decision (absent cancels it). A Rejected decision leaves the timer alone.
- The timer reports `{ kind: "alarm_fired" }` (a Settlement with no token).
  The decider fires every deadline with `at <= ctx.now`, in deadline order. A
  late or spurious fire finds nothing due and is Accepted with no events, so
  alarms need no token and no staleness rule.
- Model changes for this step: remove the `arm_timer` Run Effect and the
  `timer_fired` Settlement; add `alarm_fired`; add `alarmAt` to the Accepted
  arm of `Decision`; `LedgerView.live` no longer contains timers. Update the
  model's doc comments to match.
- Finishing an obligation removes its deadline. Nothing else cancels, extends
  or re-arms a deadline unless the spec names that evidence as extending it.
- Native idle proves only work issued before the probe, and only when the
  provider's native policy can prove covered commands can no longer execute.
  Idle never leaves a cleanup deadline behind (G4).
- CONTRACT.md section 1 "Deadlines are `arm_timer` sends; re-arming mints a
  new token" and section 4 effect-shape comparison of timers are replaced by
  this step. The spec's original "deadlines as data" stands.

### Step 2. Run end is adapter-declared; native-session fence is separate (Q2=2C)

- The native policy declares what ends a Run: the result for Claude, Codex
  and Cursor; the owned execution's end for OpenCode.
- A separate native-session fence holds the next start until the native
  session can accept it (Claude runs one SDK query per session). The fence
  never decides the Run's outcome; Run end never releases the fence by itself
  unless the policy says the two coincide.
- A result is outcome evidence and, for adapters that declare it so, Run end.
  It is never "closure" on one path and "outcome" on another (G2).

### Step 3. Outstanding Work module (Q7=7B, and the correlation half of Q3)

- One module merges the correlation table and the transmission table. It
  replaces the universal "live" bit with three separate facts per send:
  - outstanding work: the provider may still act on it
  - execution authority: lifecycle evidence for it may change Run state
  - receipt address: receipt evidence for it may update the record it names
- Ending a provider session removes execution authority for its sends; it does
  not disable fresh authorized admission (G6). Project inactive and session end
  still retire everything.
- Input delivery (Q3=3B): Queued -> Dispatching -> Delivered/sent, or
  Delivered/unknown when transmission outcome is unknown. Delivered/unknown
  blocks automatic resend until a probe settles it. Neither state implies
  Accepted.

### Step 4. ExecutionId per start attempt (Q6=6C, Q5=5C)

- Every start attempt gets an ExecutionId. The interpreter hands the adapter a
  reporter bound to it; lifecycle evidence carries the ExecutionId, not a send
  token. Steers keep the current ExecutionId. Send Tokens remain for receipts.
- Native id (6C): immutable once known. Evidence that contradicts it is
  rejected with a diagnostic and no state change. A missing native id is
  filled from evidence. Where a provider accepts a client-chosen id, the
  ledger pre-assigns it.
- Outcome fold (5C), within one native execution: failure beats success;
  specific beats generic; the first specific code is kept; completion beats an
  interrupt fallback. Only a new execution resets the fold. The fold is
  order-independent. A Tombstone is immutable.

### Step 5. No in-session pruning (Q8=8C)

- Run Input records, interaction records and send history are kept for the
  session's life. They are reclaimed when the session is archived, not by an
  in-session pruning rule. CONTRACT.md section 2 "One pruning rule" is
  withdrawn. Tokens unknown because they were never issued stay stale.

## Rules not tied to one step

- Project inactive and resume (Q9=9B): `project_active` settles the inactive
  gate. Resume clears only an ordinary pause, never the project gate. When the
  project returns, reconciliation probes run before any dispatch. Retired
  tokens are never revived.
- Answer refusal (Q10=10B): the interaction stays Pending with `lastRefusal`
  naming the exact answer attempt and refusal code. The submitted answer is
  preserved. If consumption of an earlier transmission is ambiguous, it is
  reconciled before a retransmit with a fresh id.

## Oracle

The naive reference is updated to this amendment before or alongside step 1,
by an author who reads only this amendment, CONTRACT.md, the spec, the failure
catalogue and the public model. It still never reads `SessionLedgerState`,
`LedgerEvent` or any internal module. Effect-shape comparison covers the
single projected alarm (`alarmAt` compared exactly after every step). The
fake provider's scheduler fires `alarm_fired` both at `alarmAt` and at
arbitrary other times, including before it and long after.
