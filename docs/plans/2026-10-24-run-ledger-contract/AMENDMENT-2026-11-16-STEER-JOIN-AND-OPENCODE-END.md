# Amendment 2026-11-16: a steer joins on its host's evidence, and OpenCode work outlives main's terminal (B + C + I, 2B)

Decided by the user on 2026-11-16 (bead `conduit-test-vkira`, USER DECISION notes), from lane vkira's
traces and the steer brainstorm (`brainstorm-steer/options.md`); the Claude hybrid (J6), the Codex
late-ack rule and Cursor's decline rule (J7) were decided by the coordinator the same day, closing
the vkira-bug design. This file wins over CONTRACT.md 3.8
GAP 5's terminal-first branch (876-878) and 3.9's steer join rules (984, 994-996), and closes the
three gaps `pending.ts` names for vkira (`openCodeLateTurn`, `joinedSteerOutlived`, the five
OpenCode-steer convergence traces and R1-1). Everything else in CONTRACT.md and the earlier
amendments stands; `mainGateRefusal` (1820-1821) is not decided here. Anchors are main `aa07672b`
(the run-ledger, runner and oracle files are unchanged since `02108316`).

User-visible behaviour:
- A steer the agent did not take into the running turn is not hidden inside it. The session stays
  busy while the steer still may run, and the steer runs, succeeds or fails as its own turn, where
  its failure shows, with its text back in the composer as for any failed send (3.9).
- A Claude steer appears in the transcript as soon as Claude starts reading it, but it counts as
  part of the running turn only once that turn's result lists it. A Claude Stop no longer fails a
  steer Claude says it will still run.
- A Codex steer is part of the running turn from the moment Codex echoes it into the turn under
  the steer's own id, not from the `turn/steer` reply, and never from an echo that carries no id.
- A Cursor steer is declined only when Cursor itself sends it back as a follow-up; a steer the
  runner could not send runs once, as the next turn.
- An OpenCode turn that ends in an error shows that error at once (main's code), but the session
  stays busy until OpenCode confirms it is idle, or the session or its process ends. The next
  queued message starts after that, not while OpenCode may still be running the failed prompt.
- Nothing else changes: a steer the agent takes still folds into the running turn, and Stop still
  stops the running turn.

## Why

| gap | what goes wrong on main | source |
|---|---|---|
| 1 (3.9, 984) | A steer joins the open Run at admission (decider 3127-3133) or at main's `run.requested` (2286-2295). When the provider runs it after the open Run ends (Claude missed boundary, Codex "no active turn", Cursor `revert_to_followup`), main's terminal for the open Run ends the steer's work too: the session reads quiet while the agent works, and the steer's failure has no Run. | vkira trace report; `steer-misses-boundary.jsonl`; probe ledger entries 9 and 10 (Ended Run holds B from seq 83 to 88); pending R1-1, `joinedSteerOutlived` |
| 2 (3.8 GAP 5 against 9) | For OpenCode, main's terminal (`turn.error`) folding first ends the start's work (`tx.ended ??= "main"`, decider 2435). Section 9 keeps an OpenCode start a fence member until `query_ended` and a covering probe (3089, 3101-3106), and an unconfirmed send can run late (655-662). The oracle hides an unfinished native send; the fake keeps it. | pending R1-2, R1-3, R1-4, R2-1, R2-2, `openCodeLateTurn` |

Both are one class: something other than the evidence that names a send decides that send's work
ended. Survey convergence (4 of 6 competitors with code): ownership moves only on a provider signal
that names the message.

## Data shape

No new state field and no new phase.

1. **A pending steer is a Run record.** A steer whose `run.requested` folds while another input Run
   is active is pushed to `book.runs` after it, under its reservation's runId, and launched at once
   (Launched, its steer send filed under its own runId and exec). `activeInputRun` returns the
   first non-Ended input Run, so the open Run stays the active one and the pending Run becomes active
   by itself when the open Run ends (978-983).
2. **`mainRuns`.** A pending steer's entry is `{ runId: own, open: true }`, no `steer` flag. At its
   join it becomes `{ runId: openRun, open, steer: true }`, the existing joined shape (2410-2414).
3. **`tx.mainEnded`** (decider 99, reference 90) gains a second writer: main's terminal on a
   provider whose policy has `runnerHost: false` (OpenCode), for a start or steer tx not yet ended.

## J1. A dispatched steer has its own pending Run until it joins

A steer's `run.requested` reserves its own Run (3.4) whether or not another input Run is active. If
one is, the steer's Run is pending: Launched with its steer send, behind the active Run. Admission
never joins (the admit join is removed). A steer that opens the Run, or that is admitted while only
a wake Run is active, is unchanged (3.9, 994-995).

## J2. The join is its host's `run.started`

A pending steer joins the open Run only when main folds a `run.started` whose `runId` names that
open Run and whose `requestedRunId` names the steer's run, and the open Run is not Ended. At the
join the input and its send move into the open Run (`send.runId` and `send.exec` become the open
Run's) and the emptied pending Run is removed from the book: it never started, so it has no end, no
Tombstone and no outcome.
- A join for a steer whose send is covered (2.3, 3.6) is recorded and changes nothing (509-516).
- A join for a steer whose pending Run already Ended is recorded and changes nothing.
- A join naming an open Run that already Ended starts the steer's own pending Run (its execution
  has evidence) and maps the observed runId to it. It never creates a second Run.
- No step ever undoes a join. A joined steer stays in the Run it joined; the D53 un-join
  (decider 2275-2284) goes, because nothing joins before its host's evidence.

## J3. Each host maps its strongest naming signal to that one event

| provider | the join event (in the model's history, names the steer) | runner change |
|---|---|---|
| Claude | the open Run's `result` whose `user_message_uuids` names the steer (hybrid, J6) | move the steer's `run.started` from `command_lifecycle` started (claude-runner-payload.ts 2680-2740: `currentRunId ??=` at 2695, emit at 2721) to the result (2410-2425), emitted before that result's terminal events; started only places the transcript message. |
| Codex | the `item/started` `userMessage` echo whose `clientId` is the steer's inputId (sent as `clientUserMessageId`), on its thread's executing turn while that turn is open | move `run.started` from `acceptSteer` (codex-runner-payload.ts 1253-1306, emit at 1273) to the notification loop (999-1004). The echo's `clientId` is the only key. An echo without one joins nothing, wherever it falls in the turn. The `turn/steer` reply only places the steer, and the runner keeps no turn it names. A reply that arrives after the turn settled joins nothing and must not reach a closed Run. |
| Cursor | the steer's `complete_delivered` result (cursor-runner-payload.ts 476, 821) | the unique-text delta match (477-494) no longer settles a steer as delivered; the runner declines a steer only on the SDK's `revert_to_followup`, never locally (J7). |
| OpenCode | none: steering is `queue` (provider-instance.ts 168) | none |

## J4. The open Run ends first

A pending steer the open Run's end finds unjoined is already its own Run; that end does not touch
it. 978-983 stand: its host's `run.started` (`requestedRunId` = its runId) starts it, its acceptance
places it, its decline returns it and ends its Run with main's terminal, and 3.8 ends it from its
own evidence. A second steer sent while a pending steer is the active Run is pending behind it and
joins it on its own join event (case (d), 989-991).

## J5. Terminals and coverage

- Main's terminal for a pending steer's own run ends the pending Run with main's outcome and code;
  D53 places its input (965-967). Main's terminal for the open Run ends only the sends filed under
  that Run, which after J2 are its own and its joined steers.
- A joined steer's own terminal stays the steer's alone (2410-2414, 1864-1869).
- Session-end coverage and process loss cover a pending steer's send by label like any send (2.3),
  and its pending Run ends by 2.3. Evidence for a covered send never changes Run state (509-516),
  join included.
- Stop asks the active Run only (1430-1432). A Claude Stop leaves a steer its receipt lists in
  `still_queued` pending, not failed (J6.3, case (b)).

## J6. Claude: placement at started, ownership at the result (hybrid)

1. **Placement.** At the steer's `command_lifecycle` started the runner places its transcript
   message (`placeUserMessageEffect`, 2735). That is display only: it emits no `run.started` and
   moves no ownership, and the runner's `currentRunId` is not taken from it.
2. **Ownership.** The steer joins the open Run only when that Run's `result` lists its uuid in
   `user_message_uuids`. The runner emits the join `run.started` (`runId` the open run,
   `requestedRunId` the steer's) for each listed steer before the result's terminal, so the join
   folds while the open Run is still open. A result that omits a steer leaves it pending: it is its
   own Run (J4), and its later output and result carry its own run id, never the ended run's
   (`acceptedOutputOwner`, `messageRunIds`, translator 2197, 2420-2433). This closes vkira-bug
   mode 9 by construction.
3. **Stop.** Claude's interrupt receipt's `still_queued` is read (today it is not,
   claude-runner-payload.ts 3333-3335). A steer listed there will still run: it stays pending, not
   failed, and is its own Run once the stopped Run ends (case (b), 984-986). A steer the
   interrupted result names joined the stopped Run and ends with it.

## J7. Cursor: decline only on `revert_to_followup`

A Cursor steer is declined only when the SDK's steer call answers `revert_to_followup`. Every local
decline goes:
- `declinePending` (cursor-runner-payload.ts 439-445) at the turn's end: a steer whose answer is
  still outstanding stays pending and is its own Run (J4); its later SDK answer joins, declines or
  fails it.
- The steer call's failure (`onFailure: () => false`, ~819) is the send's failure outcome (3.9:
  failed, its text back), not a decline. An answer other than `complete_delivered` or
  `revert_to_followup` is not a decline either; it leaves the steer pending.
- The guards before the SDK call (808: steering closed, cancel requested, no steer function,
  images, no sink; 318: a busy session with no steer handler) never sent the steer. They are not
  declines: the runner reports the send not reached, and main returns it to the inbox front as a
  queued message (D53, 3.9 not-reached), so it runs once, as its own turn. This removes the local
  decline that could run a steer twice (vkira-bug residual).

## E1. Main's terminal decides the Run's end

For a Run with a main run and no result, main's terminal decides the end, outcome and code at its
fold. `query_ended` first: unchanged (the Run waits, then the terminal ends it). Terminal first: the
Run ends at that fold by condition 2, because a `mainEnded` tx is not a member `nothingMayAct`
counts (decider 748). This replaces "else at `query_ended`'s fold by condition 1" (876-878).

## E2. On a provider with no runner host the terminal does not end start or steer work

At main's terminal on a provider whose policy has `runnerHost: false`, each start or steer tx of the
Run's current execution whose work has not ended gets `mainEnded` instead of `ended = "main"`. It
stays a fence member (`mayStillAct` ignores `mainEnded`), so `anythingMayAct` stays true, the next
start waits (D60, 3.5), the obligation keeps its alarm, and the send is never retried
(`retryPending` refuses a `mainEnded` tx, decider 691). D59's abort and `cancel_request` rule stands.
Runner-host providers are unchanged: their terminal ends start and steer work as main.

## E3. When a `mainEnded` OpenCode start leaves the fence

By section 9's OpenCode row (3089) and nothing else:
- a covering `native_idle` probe issued after the tx, which covers only a confirmed send
  (3101-3106);
- an unconfirmed send's own recovery probe (3.7, D20): `input_absent`, then the `native_session`
  probe it chains, whose idle marks the send not consumed (3128-3132, decided 2026-10-28);
- coverage: process loss, runner retirement or session end (2.3, 3113-3117).

`query_ended` no longer ends a `mainEnded` tx: the query merge (decider 1574-1590; reference
`queryEnded` 1498-1508, `query_ended` 1747-1754) skips it.

## E4. The decider probes

At the terminal that set `mainEnded` on any start or steer (E2), the decider issues a
`native_session` probe for the Run. At `query_ended` for a label with a `mainEnded` start or steer
and no outstanding `native_session` probe, it issues one too, so "query end, then a covering probe"
(3089) needs no timer.

## E5. Late evidence

A late result, receipt, turn start, activity or question for a `mainEnded` send is evidence for an
Ended Run (655-662, 3.8): it changes no Tombstone and starts no Run, but it is the send's own
evidence, so a result or acceptance confirms delivery and the next covering idle covers it.

## Decider changes (src/lib/provider/run-ledger/run-ledger-decider.ts)

- **admit (3117-3133):** delete the join at admission (3127-3133).
- **run_requested (2270-2350):**
  - delete the D53 un-join (2275-2284) and the GAP join (2286-2295): nothing joined at admission or
    request any more;
  - replace the noop "run.requested while another Run is active" (2297-2298) for a steer with J1's
    pending Run; a start while a Run is active stays a noop;
  - the steer flag (2312-2313) becomes `input.delivery === "steer" && activeInputRun(book) !== run`,
    and `mainRuns` carries no `steer` for a pending Run.
- **run_started (2351-2402):**
  - Ended branch (2366-2390): when the reservation names a pending Run that is not Ended, start it
    (`exec.evidence = true`, map the observed runId) instead of the noop at 2369-2372;
  - join (2393-2401): move the send with the input (J2), remove the emptied pending Run, and record
    without change for a covered send or an Ended pending Run.
- **run_terminal (2403-2440):** the 2424-2435 loop adds E2's `mainEnded` branch on
  `!nativePolicies[book.provider].capabilities.runnerHost` for a start or steer, then issues E4's
  probe through `probe(book, fact, step, run.runId, { tag: "native_session" })` (1272-1283;
  `observe` has `fact` and `step`, 2249).
- **query_ended merge (1574-1590):** skip `mainEnded` txs; E4's probe needs `step`, which
  `EvidenceRule.merge` (1480-1490) does not take: pass it, or issue from `reconcile` (1000-1030).
- **GAP 5 comments (767-770) and the D59 comment (2417-2423):** re-cite this amendment.

## Oracle changes

**reference.ts:** mirror every decider change: admit join (2888-2905) removed; `run_requested`
(2201-2265) D53 un-join (2206-2216) and GAP join (2218-2228) removed, pending Run added;
`run_started` (2267-2318) join moves the send and removes the pending Run, Ended branch starts a
pending Run; `run_terminal` (2320-2360, `mainEnded` at 2351) gains E2 and E4; `query_ended`
(1747-1754) and `queryEnded` (1498-1508) skip `mainEnded`; the GAP 5 comment at 729-737 re-cites E1.

**fake-provider.ts:**
- delete `joinedSteerRuns` (344-345), its add (1880-1887) and its D50 skip (2680): a pending steer
  is its own Run, so D50 checks it like any;
- delete `joinedSteers`' "outlived becomes main's next open Run" (262-275 and 4401-4430): a joined
  steer is in the model's history, so it cannot outlive its Run; a pending steer is already its own
  Run;
- delete the `forcedSends` pend (2324-2329): the oracle now keeps the late OpenCode turn a member,
  as the fake does;
- emit the join `run.started` (4224-4310) only at the step where the fake's native turn takes the
  steer (its ground truth: Claude's result names it, Codex echoes it, Cursor reports
  `complete_delivered`); otherwise leave it pending and, at the parent's end, run it as main's open
  Run, as the REDESIGN-9 late branch (4227-4290) already does;
- keep the OpenCode `TraceTurnError` ground truth (1888-1902) and the either-order emission
  (4339-4370), re-cited from GAP 5 to E1-E3; the terminal-first order now needs a covering idle
  probe before the next start.

**pending.ts:** unpend `openCodeLateTurn`, `joinedSteerOutlived`, the R1-1 entry and the five
OpenCode-steer convergence entries. `mainGateRefusal` stays.

**review-traces.ts:** re-seed all five OpenCode traces as OpenCode starts; none is removed. OpenCode
steering is `queue`, so a steer B into A has no join event and under J1 is its own pending Run: the
traces would no longer test A's work. Each finding is about a send of A, so each keeps its point
with A's start (`d.latest("start")`) as the subject:
- **R1-2 (148-184):** A's start reads `delivery_unknown`, then `query_ended`, then C `run_now`. Late
  permanent outcomes change nothing. No E dependence; it keeps its expectations.
- **R1-3 (185-220):** terminal first: A ends, its start `mainEnded`, the E4 probe pending. C waits
  on the fence. A late result changes no Tombstone (E5). `query_ended`, then `native_idle`
  releases; C starts.
- **R1-4 (221-259):** an unconfirmed start with a retryable outcome after the terminal: not re-sent.
  It leaves only by its recovery probe or coverage (E3). Expectations re-derived, red first.
- **R2-1 (260-301):** terminal first, then late `input_accepted`, then a retryable outcome: no retry;
  `anythingMayAct` true and the alarm stands; the idle probe covers it; C starts.
- **R2-2 (302-340):** terminal first, then process loss covers the start and ends no Run; C starts; a
  late result changes nothing.
- **R1-1 (99-147, Claude) stays:** B is its own pending Run when A's terminal folds, so the
  obligation has an alarm (126). Its `released.ended` expectation is re-derived: it names B's Run.

**Scenarios with steers:** RL-010, R3 and RL-030 (OpenCode) are re-seeded as queued sends or starts
like the review traces; RL-027 (Claude), RL-054 and RL-056 (Cursor) add the join event through a
`join` helper (a `run.started` naming the open Run and the steer's run) where they expect the steer
inside the open Run.

## Deleted or changed

- Decider: admit join, run_requested D53 un-join and GAP join, the active-Run noop for steers, the
  Ended-reservation noop (2369-2372).
- Reference: the same four.
- Fake: `joinedSteerRuns`, `joinedSteers`' outlived path, the `forcedSends` pend.
- Claude runner: `run.started` at `command_lifecycle` started and `currentRunId ??=` from a steer
  (2695, 2721); the "still_queued is not read" rule (3333-3335).
- Codex runner: `run.started` in `acceptSteer`; `ActiveTurn.openedTurnId`, a pending steer's
  reply `turnId` and the untagged-echo branch that read them. A pending steer is
  `{ input, sink, host }` keyed by its inputId, written at the send and removed at its echo or a
  failed send.
- Cursor runner: the delta match's `settleSteer(..., true)`; every local decline (`declinePending`
  439-445, the call-failure `false`, the pre-call guards at 318 and 808 as declines).
- pending.ts: seven entries (two named, six convergence keys; `mainGateRefusal` stays).

## Out of scope

- OpenCode's policy `workEnded` reading `query_ended` alone for a send main has not ended (a
  pre-existing divergence from 3089's "then a covering probe").
- Refusing steer admission on a `queue` provider.
- `mainGateRefusal` (1820-1821).

## Confirm before building

- Confirmed 2026-11-17: every app-server version conduit supports (`CODEX_MIN_VERSION` 0.160.0,
  `protocol.ts` 3) echoes `clientUserMessageId` as the `userMessage` item's `clientId`, for
  `turn/start` and for `turn/steer`, including a steer Codex holds and records at the turn's end.
  Codex `rust-v0.160.0`: `app-server/src/request_processors/turn_processor.rs` 612-618 and
  1065-1069, `core/src/session/turn_input.rs` 695-746, `core/src/hook_runtime.rs` 715-737,
  `core/src/session/mod.rs` 4963-5021, `app-server-protocol/src/protocol/v2/item.rs` 241 and 874;
  `rust-v0.159.0` has the same. Conduit sends the id on every request that carries user input
  (codex-runner-payload.ts 846, 1374), and `check-codex-app-server-schema.ts` pins the request
  and item fields. No version gate. So, by inference, an echo without `clientId` is another
  client's input on the thread or a fixture recorded without the id, never conduit's.
- Whether Codex echoes a pending steer it records to history at abort (codex `mod.rs` 789-815). If it
  does, that echo is after the turn settled and joins nothing (J2).
- Claude's interrupt receipt carries `still_queued` as the runner expects (3122 lists the
  `still_queued` follow-up as open); `stop-with-steer-pending.jsonl` is the fixture to check.
- Whether 32.5 (joined steers' own transmissions, 1864-1869) has landed; 2410-2414 assume it.
- 32.2.14's live check on OpenCode `prompt_async` running after the request ended (3121): E3 relies on
  the recovery probe for an unconfirmed start.

## Required work

Oracle first (pending.ts and review traces re-seeded red, then reference.ts, then the fake), then
the decider to differential parity, then the Claude, Codex and Cursor runners. Each unit writes its failing
test first. `impl-plan.md` in this folder carries the units.

## Failure modes this must handle

SEND-SETTLEMENT's 46 to 83 and the earlier lists still apply. Added:

84. A Claude steer misses A's tool boundary (A's result does not name it): A ends `completed`, the
    steer is its own Run, the session stays busy, and its result ends its Run. The same holds when
    the steer's started came before A's result (vkira-bug mode 9): its output after A's result
    carries its own run id.
85. A pending steer's send fails permanently while A runs: its own Run ends failed, visibly, with
    its text back; A is untouched.
86. A Claude Stop of A whose receipt lists the steer in `still_queued`: A ends `interrupted`; the
    steer is not failed; its Run goes on and runs.
87. Session end or process loss while a steer is pending: its send is covered, its Run ends by 2.3,
    and a later join, result or echo for it changes no Run state.
88. A join naming A folds after A ended: the steer's pending Run starts; no second Run, no noop.
89. A join for a steer whose pending Run already ended changes nothing.
90. Codex accepts `turn/steer` but no echo comes before `turn/completed`: the steer stays pending,
    then is its own Run, and Codex starts or declines it as main.
91. A Codex `turn/steer` reply after the turn settled joins nothing.
92. A Cursor delta whose text matches one steer does not join it; `complete_delivered` does;
    `revert_to_followup` declines it (main returns it).
93. Two steers pending behind A: the first joins A; A ends; the second becomes the active Run.
94. A steer sent while a pending steer is the active Run joins that Run only on its own join event.
95. OpenCode terminal first (`turn.error`), then `query_ended`: the Run ends at the terminal with
    main's code; the start is `mainEnded`; one `native_session` probe is issued; a confirmed start
    is covered by its idle; the next start waits for that.
96. OpenCode `query_ended` first, then the terminal: unchanged; the start's work ends at the query
    end and the terminal ends the Run.
97. OpenCode terminal first with an unconfirmed start: idle does not cover it; it is never re-sent;
    its recovery probe reads absent, then idle, and it leaves the fence not consumed.
98. OpenCode terminal first, then process loss: coverage ends the start's work; the Ended Run is
    unchanged; a late result changes nothing.
99. OpenCode terminal first, then a late turn start, activity or question for the start: the fence
    holds, the alarm stands, the Ended Run's Tombstone is unchanged.
100. OpenCode terminal first and the probe reads busy: the fence holds; the probe retries to its
     cap; `query_ended` issues a fresh probe.
101. A Claude, Codex or Cursor terminal: start and steer work ends at the terminal as before.
102. An OpenCode Stop: D59's abort and `cancel_request` rule is unchanged.
103. A Claude steer's `command_lifecycle` started folds while A runs: its message is placed in the
     transcript; no `run.started` is emitted and the steer's Run is still pending.
104. A Claude result lists two steers: both join before the result's terminal folds; none is
     un-joined by any later step.
105. A Cursor turn ends with a steer's SDK answer outstanding: the steer is not declined; it is its
     own Run; its later `complete_delivered` starts it and `revert_to_followup` declines it.
106. A Cursor steer refused before the SDK call (images, cancel requested, steering closed): it is
     reported not reached, returned to the inbox front, and runs once as its own turn, never twice.
107. A Cursor steer call fails: the steer fails, final, its text back; it is not declined.
108. A Codex `userMessage` echo without `clientId` joins no steer on any turn. That holds on the
     turn the steer's reply named, on a goal successor that has no opening echo, and when its text
     matches the steer's. The steer stays pending until its own echo (90).
109. A Codex echo whose `clientId` names a steer but whose turn is not the thread's executing turn
     (a late echo of an ended turn read during a later one) joins nothing. Codex writes a turn's
     echoes before its `turn/completed` on one ordered stream (inferred from `tasks/mod.rs`
     671-693), so this echo comes only from a reordered read; the steer stays pending and 87
     covers it.
110. A Codex echo read as both `item/started` and `item/completed` joins its steer once.

## Tests

Each failure mode is red before its production edit, at the highest seam that injects its fault:
- the oracle (scenarios through the reference and the decider, `differential.test.ts`) for 84 to
  89 and 93 to 102;
- the fake's property run (`properties.test.ts`) with every vkira pend removed;
- the runner payload units and the run-ledger integration suites with recorded fixtures for 84,
  86, 87, 103 and 104 (Claude: `steer-misses-boundary`, `stop-with-steer-pending`,
  `two-steers-one-boundary`; mode 9 as a synthetic trace in `claude-run-ownership.test.ts`), 90 and
  91 and 108 to 110 (Codex: `steer.jsonl`, `steer-race.jsonl`, `goal-chain.jsonl` with a spliced
  steer; `codex-runner-payload.test.ts`, `codex-goals.test.ts`), and 92, 105 to 107 (Cursor: `steer.jsonl`,
  `steer-shell.jsonl`, `cursor-steer.test.ts`);
- `opencode-run-ledger.test.ts` for 95 and 97 with a real OpenCode on a dynamic port;
  `opencode-steer.spec.ts` (E2E) stays green as the user-visible check.

## Prior art

Competitor manifest (2026-11-16): t3code dfeaf7b137, bb da3e60b81d, paseo 3d30aaec42, zeron
f6a9bbfc29, monocode 09d04436ba, diri ab0bfdc2fb, capy docs 2026-11-16.

| competitor | a steer is taken when | the open turn ends first |
|---|---|---|
| t3code | Claude: a frame naming its uuid; Codex/OpenCode: when saved | Claude: assumed taken on completion, cancelled on interrupt |
| bb | a provider event keyed by request id | the turn's end waits for steers; a stale steer is re-sent as a turn |
| zeron | a provider event naming its id | re-sent as its own turn, same id |
| monocode | the provider's ack | failed, queue paused |
| paseo | the adapter accepted it | the provider decides |
| diri | bytes written | not tracked |
| capy | not documented | not documented |

- **Convergence (4 of 6 with code):** a steer is taken only on a provider signal that names it.
  Nobody joins at dispatch.
- **Taken:** zeron's and bb's naming-evidence rule; t3code's Claude uuid frame.
- **Different on purpose:** no re-send and no deadline (bb's hold, zeron's re-send). 978-983
  already let the steer run as its own Run, and a re-send could run it twice when Claude still runs
  its queued copy.

Codex steer echo, surveyed 2026-11-17 (t3code dfeaf7b137, its fetch failed so stale; paseo
038a9ca00; bb 5a1f59e268):

| competitor | a Codex steer is matched to its echo by |
|---|---|
| t3code | nothing. It takes the steer when `turn/steer` succeeds and sends no `clientUserMessageId`. |
| paseo | the echo's `clientId`. An untagged echo falls to one slot holding the `turn/start` id, which paseo sends untagged. |
| bb | nothing. It binds the steer to `expectedTurnId` when `turn/steer` succeeds, and the turn's end waits for steers. |

- **Taken:** paseo's `clientId` match.
- **Different on purpose:** no positional fallback. Paseo needs one because it omits the id on
  `turn/start`; conduit sends it on every input.

## Decisions

Chosen: **B + C + I** for gap 1 and **2B** for gap 2, by the user. Representation **M** is this
lane's choice.

| option | verdict |
|---|---|
| A: join at dispatch (main) | rejected: wrong whenever the provider runs the steer separately |
| B: join at the host's start event | **chosen** |
| C: the host's event means "in the model's history" | **chosen** |
| D: hold the open Run until steers settle (bb) | rejected: needs a deadline; 978-983 already cover it |
| E: never steer | rejected: loses native steering |
| F: steer is Stop then start | rejected: loses the turn's in-progress work |
| G: every steer its own Run, ended "absorbed" | rejected: a Run end per joined steer the user never sees |
| H: re-send an unconfirmed steer at the end (zeron) | rejected: Claude may run its queued copy too |
| I: one join mapping per runner | **chosen** |
| Claude join at `command_lifecycle` started | rejected: a started steer can still run after the result that omits it (mode 9) |
| Claude hybrid: place at started, join at `user_message_uuids` | **chosen** (coordinator) |
| J: steer state machine in the decider | rejected: the decider would read raw provider evidence per host |
| K: the inbox keeps the steer until joined | rejected: a second owner of a dispatched send |
| L: every input queued until consumed | rejected: a product change beyond the gap |
| 2A: GAP 5 wins; main's terminal ends OpenCode work | rejected: hides a send OpenCode may still run (655-662) |
| 2B: section 9 wins; the start stays a fence member | **chosen** |
| M: a pending steer is a Run record behind the open Run | **chosen**: no new field; `activeInputRun` and 978-983 already do the rest |
| N: a pending steer is a send with no Run until the open Run ends | rejected: no `retryAt`, no Run to show a failure on, no alarm |
| O: a new Pending phase | rejected: every phase switch in the decider and the reference changes |
| Codex P: join by the echo's `clientId` only (2026-11-17 redesign) | **chosen**: every supported Codex tags every conduit input; position decided S4 and S8 wrongly |
| Codex Q: untagged echo falls back to the reply's turnId while open (prior user decision) | retired: unreachable on supported Codex; produced S4 and S8 |
| Codex R: classify only the `turn/start` turn's first echo as opening | rejected: still positional; goal successors and wakes each need a case |
| Codex S: version-gate the fallback | rejected: no supported version omits the tag |
| Codex T: match an untagged echo by text | rejected: text is no identity (S4) |
| Codex U: an untagged echo while steers pend fails the turn | rejected: another client on the thread sends untagged input legitimately |
