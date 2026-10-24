# Run Ledger amendment: one owner for outstanding work (82tn.32.2, 2026-10-23)

Supplements AMENDMENT-2026-10-23.md, RULINGS-2026-10-23.md and
RULINGS-2026-10-23-D1.md. Where this file and those (or CONTRACT.md,
spec-82tn32.md) disagree, this file wins. The user approved this design on
2026-10-23 (Q7 = B + J with C folded in; riders on K and L; design sections
1-4 approved as presented). Architecture report:
$TMPDIR/architecture-review-20261023-ownership.html.

## Why

Step 2 as built had five holders of one answer ("may native work still act,
so must the next start wait?"): a stored `nativeFence` token list written in
four modules, per-send facts plus `live`, admission-wide `Admission.state`,
fourteen `run.tag === "Ended"` guards in seven modules that drop evidence, and
cleanup/kill obligations. All ten findings of review rounds 1-5 sat on seams
between these holders. Cause: HL-K built the fence (step 2) before the
Outstanding Work module (step 3), so step 2 kept a second copy of state that
step 3 replaces.

## Decision 1. HL-K steps 2 and 3 merge

Steps 2 and 3 land as one commit, together with the D1 ledger change
(RULINGS-2026-10-23-D1.md D1-1 to D1-5). Step 2's rules (adapter-declared Run
end; a fence separate from Run outcome) and step 3's rules (three per-send
facts; Dispatching and Delivered/unknown) are unchanged. Steps 4 and 5, 9B and
10B follow as before.

## Decision 2. The Outstanding Work module

It owns every send and an accumulate-only fact set per send: order, purpose,
Run, admission, native session, obligation deadlines (step 1), and facts.
Session-wide facts (process lost, runner released, session ended, project
inactive) are stored once with an order number and cover every send issued
before it.

Its interface is the only way the rest of the decider asks about sends:

- `record(fact)`: adds a fact; never removes one.
- `mayStillAct(key)`: true from issue until a fact proves the work ended
  (native completion, a satisfied probe, a covering process loss or runner
  release, or a refusal on that send with no acceptance fact on that send).
- `hasAuthority(key)`: lifecycle evidence for this work may change Run state.
  Replaces every `Ended` guard.
- `receiptAddress(token)`: the record a receipt may update.
- `fenceHolds(nativeSession)`: some work the native policy says fences has
  `mayStillAct`.
- `inputOutcome(admission)`: a fold over that admission's sends. Accepted if
  any send was accepted; refused only when every send ended without
  acceptance.

Deleted: `nativeFence` and every hand-written release of it, stored
`Admission.state`, the send-proof module, the separate correlation and
transmission tables, fence and admission writes outside the module, the
`quarantine` effect, `runner_quarantined`.

Unchanged: the public model (except D1's removal of `quarantine`),
`decide`/`evolve`/`viewLedger`, the Run state machine, step 1's single alarm.

Riders:

- K: work is addressed by an opaque key, so step 4 can switch the key from
  send to execution inside the module without changing callers.
- L: `NativePolicy` (already one adapter per provider) feeds `mayStillAct`
  and `fenceHolds`; nothing outside the module reads `policy.fences` to manage
  a fence.

## Decision 3. Data flow

Every decision runs in three phases: record facts; recompute views from the
whole set; Run lifecycle and dispatch act only on views.

- Dispatch creates the send with its order and an `issued` fact.
- `effect_outcome`: succeeded -> `transport_succeeded`; delivery unknown ->
  `delivery_unknown`; retryable -> `retryable{at}`; permanent ->
  `transport_failed{code}`.
- Lifecycle evidence always records its fact (`accepted`, `observed`,
  `native_completed`); it changes Run state only when `hasAuthority` holds.
- Receipts update only the record `receiptAddress(token)` names.
- Probe results record `probe_satisfied` on sends issued before the probe,
  only where the native policy can prove that work can no longer execute.
- Session-wide settlements: process lost and runner released end covered
  work; session ended removes authority without blocking fresh authorized
  admission (G6); project inactive retires everything.
- Alarms record expiry on the obligation that owns the deadline.

Precedence, in the view functions only: native completion or a covering
release beats acceptance; acceptance beats a transport failure;
`delivery_unknown` with no later proof keeps work outstanding until a probe
settles it.

## Decision 4. Edge cases

- A refused sibling never releases the fence or retires an interrupt while
  other work of the same admission may still act (R5).
- A retryable outcome with no acceptance ends that send's work. A sibling's
  unsettled `delivery_unknown` blocks automatic resend until a probe settles
  it.
- Any `kill_and_respawn` outcome records `runner_released`: covered work ends,
  the fence releases with no probe, the Run ends Interrupted, forced. Later
  evidence from the detached runner is recorded but can neither reopen the
  fence nor change Run state.
- Claude process loss: same mechanism; the Run settles as process lost.
- OpenCode: Run end is `query_ended`; a failed interrupt keeps its work
  outstanding until a probe proves idle; it fences only after delivery is
  confirmed.
- The fence deadline moves onto the outstanding send's cleanup obligation;
  expiry behaves as today (probe where allowed, else `fence_unconfirmed`).
- Evidence for never-issued or retired tokens: Accepted, no events, a
  diagnostic. No throws, no new error types.
- Facts are kept for the session's life (step 5).

## Decision 5. Testing

- fast-check model-based testing (`fc.commands`, `fc.modelRun`) through the
  public interface only, per provider (Claude, Codex, Cursor, OpenCode), over
  the full public alphabet: user commands, every native evidence kind
  including all `effect_outcome` results and `kill_and_respawn` outcomes,
  settlements, and `alarm_fired` at arbitrary times. Evidence targets issued
  tokens, stale and never-issued tokens, and evidence after execution end.
- A fake provider is ground truth for three invariants: I1 no start while the
  fake holds accepted, unended work on that native session; I2 evidence the
  fake could deliver in either order yields the same view; I3 at most one
  terminal per Run, Tombstones immutable.
- Each step is diffed against the naive oracle (effects, `alarmAt`,
  `viewLedger`). The oracle's D1 update is written by an author who reads only
  the contract docs. The `pendingCases` ratchet stands.
- Coverage gate: the run fails if any evidence kind or named interleaving
  class has zero hits (start refusal with an accepted sibling, process loss
  mid-run, runner release, evidence spanning execution end).
- R1-R5 findings and the existing six seeded cases become fixed traces. The R5
  trace is red on the pre-redesign tree before implementation starts. Every
  shrunk failure is checked in the same way.
- Artifact: a JSON report of seeds, trace counts per evidence kind and class,
  and shrunk failures; CI runs a fixed seed set, an env var enables long runs.

## Prior art (manifest 2026-10-23)

t3code c58d558e10, bb 1e80ca7b44, paseo f3b0199c13, zeron dd0c36fa3e, diri
e280a76d3f, monocode 74b8139c41, capy docs fetched 2026-10-23T11:57:59Z.
Evidence: /tmp/82tn-beads/art-ows/*.md.

| Competitor | Owners of in-flight state | Churn | Tests |
| --- | --- | --- | --- |
| t3code | 21 modules; attempt/generation fences | 27 / 139 / 31 commits | scenarios |
| bb | 36 groups; converging on one runtime owner | 66 (39 since Sep 1) | scenarios |
| paseo | 18; OpenCode owned-stop replaced a flag bag | 241 on agent-manager.ts | scenarios |
| zeron | 17; accepted-but-unconfirmed ledger | repeated race fixes | scenarios |
| diri | 18; reserve-before-effect journal | 43 | scenarios |
| monocode | 21 + 4 | repeated fixes | scenarios |

Convergence conduit follows: "turn ended" is separate from "native session
reusable". Conduit departs on purpose: readiness is derived from one fact set
rather than stored in several owners, and order independence is tested by
model-based traces. No competitor does either.
