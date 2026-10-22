# Run Ledger failure catalogue

Ticket `conduit-test-82tn.32.1`. This catalogue records reported failures and review findings, not new reproductions against this worktree. The supplied reports include fixed defects, test defects, structural findings and explicit contract exceptions. Every entry has one pending test; those placeholders prove discovery only.

The source manifest lists 67 paths: 47 review reports and one bead-note export after removing 19 byte-identical report copies. The 118 severity-labelled report mentions, three additional concrete unnumbered findings and one additional bead-note failure reduce to 116 distinct cases. A recommendation to remove FIFO echo guessing is attached to the already-reported ownership defect, rather than counted twice.

## Summary by level

| Level | Cases | Owner file |
| --- | ---: | --- |
| decider | 35 | [test/unit/provider/run-ledger-decider.test.ts](../../test/unit/provider/run-ledger-decider.test.ts) |
| ledger | 55 | [test/unit/persistence/run-ledger.test.ts](../../test/unit/persistence/run-ledger.test.ts) |
| e2e | 26 | [test/integration/daemon/run-ledger.test.ts](../../test/integration/daemon/run-ledger.test.ts) |
| Total | 116 | |

The lowest faithful level is used: pure transitions and emitted effects go to decider; durable identity, transaction ordering, imports and projection consistency go to ledger; real transport, process lifecycle, cross-build behavior and recorded wire ordering go to e2e. Pure source-contract exceptions RL-049, RL-050 and RL-107 use the decider file as unit ownership only. They are explicitly not decide/evolve cases.

## Summary by invariant

I1-I9 are catalogue labels for the nine invariants in the spec's Testing Decisions, in their original order. Counts overlap. I6 means eventual progress when admission is enabled; ordinary Stop deliberately pauses the inbox. I9 includes transactional consistency during normal commit and after rollback. Cases with a scope note may only exercise a consequence of an invariant rather than prove the invariant itself.

| Id | Spec invariant | Cases |
| --- | --- | ---: |
| I1 | Every run ends exactly once | 49 |
| I2 | Every unfinished run has a deadline | 34 |
| I3 | At most one active run per session | 24 |
| I4 | No delivery-unknown input is delivered twice | 23 |
| I5 | No answer is lost | 19 |
| I6 | The inbox always drains | 36 |
| I7 | Tombstoned runs accept no events | 20 |
| I8 | No illegal transitions on valid input | 22 |
| I9 | Ledger tables and derived views always agree after any rollback | 54 |
| None | Outside the nine lifecycle invariants | 11 |

## Summary by source

| Source bead | Distinct cases first recorded here | Cases citing this bead, including repeats |
| --- | ---: | ---: |
| conduit-test-82tn.24 | 66 | 66 |
| conduit-test-82tn.31.5 | 2 | 2 |
| conduit-test-82tn.27.1 | 2 | 2 |
| conduit-test-82tn.27.2 | 10 | 10 |
| conduit-test-82tn.27.3 | 14 | 14 |
| conduit-test-82tn.10.4 | 14 | 14 |
| conduit-test-82tn.18 | 8 | 8 |
| Total unique cases | 116 | Counts in the last column overlap |

For the four explicitly numbered lanes, severity-labelled review findings are 27.2 = 10, 27.3 = 14, 10.4 = 13, and 18 = 8. The spec introduction says eleven for 27.2, but only ten are enumerated in the supplied reports. The manifest's 82tn.24 group contains 73 severity-labelled mentions, including two from 31.5 and one from 27.1; those actual bead owners are retained below. The bead notes add the separate Stop-pause case RL-067. RL-114, RL-115 and RL-116 preserve additional concrete unnumbered findings from 24, 27.1 and 10.4 respectively.

## Model boundaries and open contracts

The full [spec](/tmp/82tn-beads/spec-run-ledger.md) defines Run states Queued, Starting, Running, Interrupting, Settling and Ended, and Run Input states Queued, Delivered, Accepted and Declined. admit, observe, control and settle own every transition and its Run Effects. Every unfinished state has a persisted deadline. Pending answer delivery must remain represented until consumed or explicitly settled; native terminal alone must not silently discard it. Ended is a Tombstone. Runner messages and effects carry run id and attempt.

Several older reports rely on separate reservations, joined runs, in-memory fences and five-attempt or 35-second bounds. The redesign removes those mechanisms. Expected outcomes below translate their behavior into one active Run per session and per-input state; they do not preserve the old data structures. Only the 30-second Stop deadline and up-to-three CAS retries are explicit new-spec numeric policies.

The first draft of the spec left three gaps, resolved by the spec amendment of 2026-10-22 (see conduit-test-82tn.32 notes). RL-032 and RL-087: a native-session fence holds a successor's start effect until the previous Run's in-flight effects on that native session resolve or a probe confirms idle; OpenCode's Stop fallback is cancel the request, issue the native abort, and hold the fence. RL-041: when Stop, Run now or a forced close ends a Run, an Accepted steer stays with it, and a Queued or Delivered but unaccepted steer returns to the front of the inbox, marked possibly seen, never re-sent automatically. RL-097, RL-099, RL-101 and RL-104: Tombstones cover lifecycle events only; late accounting is recorded against the ended Run's inputs without changing its state. Entry scope notes that still say "spec tension" refer to the draft and are answered by these rules.

RL-105 through RL-112 concern idle-policy and configuration contracts outside the redesign. RL-049, RL-050 and RL-107 are pure source-contract checks; RL-091 concerns concurrent evidence writes. RL-024, RL-046, RL-062 and RL-063 have indirect or partial mappings for fork identity, recaps, handoff metadata and query performance. Each entry states that limit. Superseded policy reports RL-036 and RL-041 remain traceable, with the new spec's behavior stated explicitly.

The e2e owner must use the existing isolated process harness, temporary HOME/config/provider directories, and recorded Claude, Cursor or OpenCode traces per ADR-0002. Each implemented case will write a repeatable JSON artifact under `test-results/run-ledger/` with its RL id, input/control/observation order, process and attempt identities, native delivery counts and invariant results. No harness, process, provider or live daemon is started by this ticket's pending tests.

## Cases

### 1. RL-001: Preserve active ownership during upgrade backfill

- Source: conduit-test-82tn.24, unnamed review Lrt7U5, sequence 01, [S52 finding 1](#s52). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A legacy send is executing.
  2. Upgrade backfills its reservation as interrupted.
  3. Admit another queued input.

- Wrong outcome reported: The inbox reports idle and foreground delivery executes beside the legacy send.
- Correct outcome under the Run Ledger model: Backfill A as Starting or Running with its exact attempt and deadline in one transaction. admit attaches new input as a Steer to that active Run; it cannot start a parallel Run.
- Invariants: I3, at most one active run per session, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 2. RL-002: Reconcile external OpenCode runs without commands after restart

- Source: conduit-test-82tn.24, unnamed review Lrt7U5, sequence 01, [S52 finding 2](#s52). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. observe an external native input and its Running Run.
  2. The daemon stops and OpenCode finishes.
  3. Restart and reconcile an already-idle native session.

- Wrong outcome reported: No outbox row selects recovery, so the Run remains busy forever.
- Correct outcome under the Run Ledger model: The persisted Running deadline selects settle independently of Run Effects or old command status. A guarded provider probe confirms the exact Run ended and the inbox drains.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: ledger, four verbs against real SQLite.

### 3. RL-003: Keep exact ownership on answer and continuation deadlines

- Source: conduit-test-82tn.24, unnamed review Lrt7U5, sequence 01, [S52 finding 3](#s52). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A accepts a permission answer or continuation.
  2. Arm a callback without A identity.
  3. The callback emits an unowned timeout failure.

- Wrong outcome reported: The session says idle while A and its accepted input remain running.
- Correct outcome under the Run Ledger model: control and admit retain run id and attempt. settle processes A's stored deadline using its state-specific meaning, never an unowned terminal or a timer for a newer Run.
- Invariants: I2, every unfinished run has a deadline, I7, tombstoned runs accept no events, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 4. RL-004: Invalidate sampled OpenCode idle when new input is accepted

- Source: conduit-test-82tn.24, unnamed review G8uCBg, sequence 02, [S47 finding 1](#s47). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Begin a provider status probe for A.
  2. observe a new accepted input before the reply.
  3. The old idle proof returns.

- Wrong outcome reported: The delayed idle closes genuinely active work.
- Correct outcome under the Run Ledger model: observe advances the active Run version. settle reloads and rejects or re-probes a stale idle proof; its transaction cannot overwrite newer Accepted Run Input state.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 5. RL-005: Probe OpenCode in the native session directory

- Source: conduit-test-82tn.24, unnamed review G8uCBg, sequence 02, [S47 finding 2](#s47). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An external native session is observed in an extra folder.
  2. Restart loses that directory fact.
  3. Probe only the main folder and receive no status.

- Wrong outcome reported: An omitted status falsely interrupts a Run that is busy in another directory.
- Correct outcome under the Run Ledger model: The OpenCode adapter probes the persisted native identity and effective directory. settle accepts provider truth only for that scope. Replay recorded directory-scoped traffic through the isolated process harness.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 6. RL-006: Settle run and command views together on owned non-stream terminals

- Source: conduit-test-82tn.24, unnamed review G8uCBg, sequence 02, [S47 finding 3](#s47). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review cDsH8b, sequence 04, [S43 finding 2](#s43)
- Interleaving:

  1. An OpenCode input is Accepted.
  2. An instance-stop confirmation or owned timeout arrives through generic ingestion.
  3. Native idle arrives after the run already ended.

- Wrong outcome reported: The Run ends while a completion waiter, outbox claim and receipt remain outstanding, blocking later input.
- Correct outcome under the Run Ledger model: settle records one Ended outcome, updates derived receipts, turns and inbox busy, and enqueues remaining effects in one SQLite transaction. Native callback ordering cannot decide those views. An ordinary Running liveness deadline needs proof before ending work.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 7. RL-007: Reconcile every accepted input belonging to the same Run

- Source: conduit-test-82tn.24, unnamed review G8uCBg, sequence 02, [S47 finding 4](#s47). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A local OpenCode input starts a Run.
  2. An external input joins its native execution.
  3. Restart and confirm idle with both inputs still open.

- Wrong outcome reported: Recovery rejects another member's message id and leaves the Run and command running.
- Correct outcome under the Run Ledger model: Both are Run Inputs on the one active Run. settle uses Run identity rather than a single current message, ending that Run and its derived views together.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I6, the inbox always drains.
- Level: ledger, four verbs against real SQLite.

### 8. RL-008: Recover an open Run despite an already-completed command

- Source: conduit-test-82tn.24, unnamed review G8uCBg, sequence 02, [S47 finding 5](#s47). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Native idle resolves an OpenCode command callback.
  2. The daemon dies before owned idle commits.
  3. Restart recovery selects only running commands.

- Wrong outcome reported: A completed command hides a still-running Run from every recovery path.
- Correct outcome under the Run Ledger model: The ledger is the only lifecycle writer, so callback completion cannot independently complete a derived receipt. Backfill inconsistent legacy rows, then settle outstanding Runs from their deadlines irrespective of command status.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 9. RL-009: Settle migrated legacy results including folded joined inputs

- Source: conduit-test-82tn.24, unnamed review jM83ei, sequence 03, [S49 finding 1](#s49). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review cDsH8b, sequence 04, [S43 finding 1](#s43)
- Interleaving:

  1. Upgrade while a legacy runner owns one or several folded inputs.
  2. The old runner returns success or joined without run ids.
  3. Recovery completes commands.

- Wrong outcome reported: Migration-authored reservations stay running after successful legacy command completion.
- Correct outcome under the Run Ledger model: The spec replaces this compatibility path: refuse old-protocol runners new work and settle their exact owned Runs with a typed compatibility reason. A two-build harness must prove every carried Run ends once and no input is resent. Legacy joined is not universal terminal evidence.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 10. RL-010: Do not let unrelated OpenCode idle complete an unaccepted input

- Source: conduit-test-82tn.24, unnamed review jM83ei, sequence 03, [S49 finding 2](#s49). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is Running.
  2. B is Delivered but has no matching native echo.
  3. A emits idle before B intake.

- Wrong outcome reported: A session-wide waiter marks B successful before B executes.
- Correct outcome under the Run Ledger model: observe correlates the terminal to A. B remains an unaccepted Run Input, never Accepted or completed by A's idle; any unresolved delivery is probed under its own effect identity.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I4, no delivery-unknown input is delivered twice.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 11. RL-011: Retain pre-intake input identity at a processing deadline

- Source: conduit-test-82tn.24, unnamed review jM83ei, sequence 03, [S49 finding 3](#s49). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Place A's user message before intake.
  2. A processing deadline fires.
  3. Settlement records only the reservation id.

- Wrong outcome reported: The reservation errors but its unowned pending turn never closes or pauses the queue.
- Correct outcome under the Run Ledger model: admit persists the Run Input and derived placement together before delivery. settle evaluates Starting's give-up deadline against that exact input and records the outcome atomically without inventing Accepted state.
- Invariants: I1, every run ends exactly once, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 12. RL-012: Settle placed unaccepted input when its runner exits

- Source: conduit-test-82tn.24, unnamed review jM83ei, sequence 03, [S49 finding 4](#s49). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. The runner places A before intake.
  2. Exit settlement ends the reservation without the input identity.
  3. Later exact-input cleanup sees an already-ended reservation.

- Wrong outcome reported: A pending turn survives its errored Run and the queue loses its failure pause.
- Correct outcome under the Run Ledger model: settle(process lost) addresses A's run id and attempt and updates every derived input view in the same transaction. Later cleanup observes the Tombstone and adds no second terminal.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 13. RL-013: Give an authorized retry a fresh execution identity

- Source: conduit-test-82tn.24, unnamed review cDsH8b, sequence 04, [S43 finding 3](#s43). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Cursor reports a retryable failure ending A.
  2. Backoff expires.
  3. Replay the same ended reservation for another native attempt.

- Wrong outcome reported: The retry executes while the Run and input still report error and inbox busy is false.
- Correct outcome under the Run Ledger model: The decider never reopens Ended. An authorized retry gets a fresh Run identity and attempt with a Starting deadline; stale observations for A remain ignored. A declined input follows its own Queued transition.
- Invariants: I2, every unfinished run has a deadline, I3, at most one active run per session, I7, tombstoned runs accept no events, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 14. RL-014: Keep OpenCode tool-step completion nonterminal

- Source: conduit-test-82tn.24, unnamed review cDsH8b, sequence 04, [S43 finding 4](#s43). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An OpenCode Run is Running.
  2. An assistant tool-call message completes.
  3. The native session continues.

- Wrong outcome reported: The command completes early and the drain admits later work as if the Run ended.
- Correct outcome under the Run Ledger model: The one classifier treats tool-step completion as an observation, leaving Running and its deadline intact. Only the owned native run boundary can End the Run.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 15. RL-015: Preserve an exact input failure before provider delivery

- Source: conduit-test-82tn.24, unnamed review cDsH8b, sequence 04, [S43 finding 5](#s43). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Queue an input.
  2. Preparation fails before an old outbox reservation exists.
  3. Place the input and emit its exact input-only error.

- Wrong outcome reported: The projector discards the error and leaves a pending turn that cannot pause the queue.
- Correct outcome under the Run Ledger model: admit gives the user message a Run Input identity before preparing effects. A permanent preparation failure records its typed reason and derived failed placement atomically, without claiming provider acceptance.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 16. RL-016: Preserve the pending Cursor input on Stop before intake

- Source: conduit-test-82tn.24, unnamed review ZddvXM, sequence 05, [S66 finding 1](#s66). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Cursor places input A.
  2. control Stop arrives before the RUNNING frame.
  3. The native interruption omits the input id.

- Wrong outcome reported: The Run is interrupted but the turn stays pending, allowing the queue to drain after Stop.
- Correct outcome under the Run Ledger model: The ledger already owns A's Run Input. control moves its Run to Interrupting and pauses the inbox; observe the interruption ends its exact derived turn while its Run Input never falsely becomes Accepted.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 17. RL-017: Require final successful OpenCode loop evidence during recovery

- Source: conduit-test-82tn.24, unnamed review ZddvXM, sequence 05, [S66 finding 2](#s66). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A tool-calls assistant step completes.
  2. A later reply fails with MessageAbortedError.
  3. Restart recovery inspects history.

- Wrong outcome reported: Recovery chooses the earlier tool step and reports successful completion.
- Correct outcome under the Run Ledger model: The shared classifier evaluates the final exact-owned reply and native session proof. settle records the actual failure reason; a completed tool step cannot prove successful Ended.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 18. RL-018: Do not manufacture success from migration-interrupted OpenCode history

- Source: conduit-test-82tn.24, unnamed review ZddvXM, sequence 05, [S66 finding 3](#s66). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Legacy migration interrupts an unowned turn while its reservation stays running.
  2. The provider is stopped with empty history.
  3. Recovery skips the interrupted turn and emits idle.

- Wrong outcome reported: The command reports success despite unresolved native outcome and interrupted transcript.
- Correct outcome under the Run Ledger model: The all-or-nothing backfill preserves exact input ownership and known outcomes. settle of unresolved stopped work uses a typed interruption or process-loss reason, never inferred success from a legacy turn state.
- Invariants: I1, every run ends exactly once, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 19. RL-019: Own Claude iterator failures before intake

- Source: conduit-test-82tn.24, unnamed review NTYy74, sequence 06, [S56 finding 1](#s56). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. admit A and deliver it to Claude.
  2. The SDK iterator fails before started.
  3. The adapter emits an error using an unset current run id.

- Wrong outcome reported: The returned error does not settle the reservation or receipt, leaving recovered sends busy indefinitely.
- Correct outcome under the Run Ledger model: Every effect and observation carries A's run id and attempt from Starting onward. observe the permanent pre-intake error ends A with its typed reason and leaves the Run Input unaccepted.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 20. RL-020: Do not turn transport timeout into proof of native cancellation

- Source: conduit-test-82tn.24, unnamed review NTYy74, sequence 06, [S56 finding 2](#s56). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review JeQLBq, sequence 07, [S50 finding 3](#s50), conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Deliver A but lose its intake acknowledgement.
  2. A receipt deadline removes the socket waiter.
  3. Native intake arrives later or an OpenCode request remains in flight.

- Wrong outcome reported: The caller gets failure while native input can still execute; retry can duplicate it. Some runner sink cleanup also stays pending.
- Correct outcome under the Run Ledger model: observe a delivery-unknown effect outcome and issue a probe, never blindly resend. Persist the Starting deadline, retain exact ownership through reconnection, and use control Stop plus confirmed close or process retirement to bound it. Recorded-trace crash cells must cover both runner and OpenCode paths.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I7, tombstoned runs accept no events.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 21. RL-021: Retain a deadline after a missed OpenCode acceptance echo

- Source: conduit-test-82tn.24, unnamed review NTYy74, sequence 06, [S56 finding 3](#s56). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. prompt_async succeeds but its live user echo is lost.
  2. Native idle arrives.
  3. Session idle clears an in-memory processing timer.

- Wrong outcome reported: The unaccepted reservation and intake poll wait forever, blocking the queue.
- Correct outcome under the Run Ledger model: A non-ended Run always retains its state-specific persisted deadline. observe uncorrelated idle does not clear it; settle probes delivery-unknown input without inventing acceptance or resubmitting it.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 22. RL-022: Keep copied fork history outside live Run membership

- Source: conduit-test-82tn.24, unnamed review NTYy74, sequence 06, [S56 finding 4](#s56). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Copy parent placement into a fork without its run lifecycle.
  2. The parent run id survives in the copied turn.
  3. Fresh fork input tries to replace that membership.

- Wrong outcome reported: The copied turn stays pending with foreign ownership and cannot be repaired by fresh acceptance.
- Correct outcome under the Run Ledger model: Backfill and derived historical views preserve session ownership. Historical fork facts do not admit live Runs, attach foreign Run Inputs, or change active Run state.
- Invariants: I3, at most one active run per session, I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 23. RL-023: Do not idle another Run's children when a steer is declined

- Source: conduit-test-82tn.24, unnamed review NTYy74, sequence 06, [S56 finding 5](#s56). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. A runs with active child sessions.
  2. Provider declines B before intake.
  3. A separate B reservation emits interruption.

- Wrong outcome reported: Session-wide child settlement marks A's active children idle.
- Correct outcome under the Run Ledger model: B is a Run Input on A, not a second Run. observe Declined returns B to Queued in the inbox and leaves A Running, its deadline and its children unchanged.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 24. RL-024: Do not copy native agent identity into a fork

- Source: conduit-test-82tn.24, unnamed review JeQLBq, sequence 07, [S50 finding 1](#s50). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Copy terminal history with provider state updates.
  2. Project the fork's copied events.
  3. Send its first prompt.

- Wrong outcome reported: The fork inherits the parent's Cursor agent id and cwd; resuming the parent is inferred from the send path, not demonstrated natively.
- Correct outcome under the Run Ledger model: Historical observations derive display history only. admit in the fork creates its own Run and provider binding; copied terminal metadata cannot change a live execution owner.
- Invariants: I3, at most one active run per session, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Indirect mapping: fork native-identity isolation is an adapter/history contract; I3/I9 describe the ownership consequence, not an explicit native-binding rule in the spec.

### 25. RL-025: Recall an unaccepted input without ending another active Run

- Source: conduit-test-82tn.24, unnamed review JeQLBq, sequence 07, [S50 finding 2](#s50). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is executing.
  2. B waits before intake.
  3. B delivery is cancelled after its receipt fails.

- Wrong outcome reported: The cancellation finalizer sends session-wide end-session, interrupting A's tools.
- Correct outcome under the Run Ledger model: observe B's Run Effect outcome cannot emit a session-wide control for A. A stays Running; a delivery-unknown B gets a probe, and only an explicit control with the active Run owner may interrupt A.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 26. RL-026: Preserve failed pre-intake history when forking

- Source: conduit-test-82tn.24, unnamed review JeQLBq, sequence 07, [S50 finding 4](#s50). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A fails before intake with an empty assistant message id.
  2. Fork copying retains its reservation and placement.
  3. The message filter drops its terminal event.

- Wrong outcome reported: The fork inherits a permanently pending reservation and stays busy.
- Correct outcome under the Run Ledger model: Historical copying must preserve the known Ended outcome without creating an active Run. The ledger backfill and derived views cannot import half a lifecycle.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 27. RL-027: Do not treat SDK handoff as Run Input acceptance

- Source: conduit-test-82tn.24, unnamed review mhYjaU, sequence 08, [S54 finding 1](#s54). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is Running.
  2. B is handed to the SDK but remains queued there.
  3. Local recall fails and synthesizes started B.
  4. A finishes before B's real start.

- Wrong outcome reported: B is joined to and prematurely settled by A; its real intake is discarded.
- Correct outcome under the Run Ledger model: admit records B as a Run Input and a steer effect on A. observe transport delivery can make it Delivered, but only native intake makes it Accepted. A terminal must not silently consume an unresolved Delivered input; probe or return it according to provider truth.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I4, no delivery-unknown input is delivered twice.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 28. RL-028: Keep delayed timeout controls from interrupting a successor

- Source: conduit-test-82tn.24, unnamed review mhYjaU, sequence 08, [S54 finding 2](#s54). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Timeout checks that A still owns the Run.
  2. A ends and B starts during asynchronous dispatch.
  3. A's session-only interrupt reaches the provider.

- Wrong outcome reported: B is interrupted while the failure event names A. The permission callback counterpart was inferred.
- Correct outcome under the Run Ledger model: settle evaluates A's deadline and emits only effects tagged with A's run id and attempt. The interpreter cannot retarget an obsolete effect to B; A's Tombstone rejects further lifecycle events.
- Invariants: I1, every run ends exactly once, I7, tombstoned runs accept no events, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 29. RL-029: Do not authorize shared OpenCode abort with stale local exclusivity

- Source: conduit-test-82tn.24, unnamed review mhYjaU, sequence 08, [S54 finding 3](#s54). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Local ownership appears exclusive.
  2. An external native input starts before the HTTP abort executes.
  3. The adapter aborts the whole native session.

- Wrong outcome reported: Automatic recall kills unrelated external work despite a local admission lock.
- Correct outcome under the Run Ledger model: A delivery-unknown input produces a probe, not an automatic session-wide abort. Replay recorded native acceptance and abort ordering through the process harness; adapter scope must faithfully implement the owned control.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I8, no illegal transitions on valid input.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 30. RL-030: Bound recall without holding later admission forever

- Source: conduit-test-82tn.24, unnamed review mhYjaU, sequence 08, [S54 finding 4](#s54). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A remains native-active and B acceptance is unknown.
  2. Recall repeatedly fails to prove or abort B.
  3. B holds session admission while C waits.

- Wrong outcome reported: B never returns and C cannot even submit.
- Correct outcome under the Run Ledger model: observe delivery-unknown leaves a persisted deadline and a probe effect. admit C durably queues its Run Input; no in-memory recall loop owns admission or the only path to settle progress.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 31. RL-031: Match OpenCode acceptance to the exact native message id

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 1](#s57). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding Q3.1](#s57)
- Interleaving:

  1. A's request fails before server receipt.
  2. An unrelated TUI user echo arrives.
  3. FIFO correlation guesses that it belongs to A.
  4. The unrelated native run goes idle.

- Wrong outcome reported: A is falsely reported Accepted and successful although it never executed.
- Correct outcome under the Run Ledger model: observe matches the Run Input's native message id. An unrelated echo cannot accept A or complete its delivery-unknown effect; external input has its own explicit ownership.
- Invariants: I3, at most one active run per session, I4, no delivery-unknown input is delivered twice, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 32. RL-032: Fence in-flight OpenCode delivery across Stop

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 2](#s57). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Hold an already-submitted OpenCode prompt.
  2. Its deadline reports delivery unknown.
  3. Stop abort acknowledges and a later input executes.
  4. Release the old request.

- Wrong outcome reported: The old input executes after Stop and after the replacement.
- Correct outcome under the Run Ledger model: control Stop must preserve delivery uncertainty until native cancellation or an equivalent provider boundary is confirmed. A Tombstone alone cannot unsend an HTTP request. The spec promises Stop but gives no OpenCode equivalent of runner kill/respawn; this adapter contract needs resolution before the recorded-trace E2E can pass.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I7, tombstoned runs accept no events.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Partial mapping: Stop and no-duplicate guarantees apply, but the spec does not define an OpenCode fence for an already-in-flight prompt_async request. See related bead conduit-test-ac96 in S67.

### 33. RL-033: Do not attach replacement input to an ended native context

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 3](#s57). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review YYDjHU, sequence 12, [S64 finding 1](#s64)
- Interleaving:

  1. A ends locally at processing or Stop retirement deadline.
  2. Its retained Claude query still holds currentRunId A.
  3. B is accepted natively on the same query.

- Wrong outcome reported: B joins ended A and inherits A's failure while it executes.
- Correct outcome under the Run Ledger model: Ended is a Tombstone. A fresh admit after A ends has a distinct active Run; the runner protocol tags B's exact identity and cannot reuse A. Stop close confirmation and the second deadline prevent a retained query from owning replacement work.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I7, tombstoned runs accept no events.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 34. RL-034: Own exact Claude native results received before intake

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 4](#s57). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is Starting.
  2. A success or error result carries its exact user_message_uuid before started.
  3. Translation runs before selecting A's pending context.

- Wrong outcome reported: The waiter disappears but the unowned terminal leaves the reservation and outbox open.
- Correct outcome under the Run Ledger model: observe resolves the exact Run Input before classification. A pre-intake terminal may End Starting with its real outcome and typed reason without fabricating Accepted state.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 35. RL-035: Keep unclaimed input queued when Stop pauses the inbox

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 5](#s57). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. C is durably pending with attempt zero.
  2. Stop returns queued handoffs.
  3. A broad open-reservation query interrupts C.

- Wrong outcome reported: C becomes failed despite never being claimed or delivered.
- Correct outcome under the Run Ledger model: control Stop pauses ordinary inbox admission and interrupts the active Run. Undelivered Queued Run Inputs remain recoverable; Run now explicitly bypasses that pause. Derived effects and receipts change in the same transaction.
- Invariants: I4, no delivery-unknown input is delivered twice, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 36. RL-036: Settle usage-limit failover with an explicit session reason

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding 6](#s57). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding 1](#s60)
- Interleaving:

  1. A runs.
  2. A rejected rate-limit frame arrives before its result.
  3. Automatic account failover ends the native session.

- Wrong outcome reported: The old literal ban on automatic native cancellation conflicts with the existing failover policy. Sources establish the code path, not a complete policy execution.
- Correct outcome under the Run Ledger model: Under the new spec, settle a session-scoped usage-limit failure with its typed reason and End every affected open Run once. Any close effect is owned. Preserve the explicit failover policy rather than encode the superseded blanket ban as a regression.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 37. RL-037: Classify terminal outcomes once instead of manufacturing events

- Source: conduit-test-82tn.24, unnamed review OuXahP, sequence 09, [S57 finding Q3.2](#s57). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Runner recovery receives a result.
  2. Two recovery paths synthesize events solely to ask separate terminal logic for status.
  3. A new result kind is added.

- Wrong outcome reported: The review identifies duplicated classification and a projector dependency, not a reproduced additional wrong terminal.
- Correct outcome under the Run Ledger model: decide and evolve share the one terminal classifier. A pure table compares provider result kinds at that interface, including Cursor delivered joined versus Claude result-bound joined.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Structural finding only: source Q3 second P3 simplification; there is no additional observed runtime failure. The spec explicitly requires a single terminal classifier.

### 38. RL-038: Resolve pending result ownership before usage-limit interception

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding 2](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is active and B remains pending.
  2. B receives a blocking_limit result.
  3. The interceptor mutates A's context before selecting B.

- Wrong outcome reported: A becomes cut off and its next output delta is dropped.
- Correct outcome under the Run Ledger model: observe resolves B's exact run id, attempt and Run Input before interpreting its limit. A scoped B failure cannot settle or suppress unrelated A; a real session-wide failure uses explicit settle authority.
- Invariants: I3, at most one active run per session, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 39. RL-039: Keep slow Stop settlement from consuming a resumed attempt

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding 3](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Stop returns unclaimed C.
  2. Native abort stalls.
  3. Resume claims C after the old five-second barrier.
  4. The old abort finally returns.

- Wrong outcome reported: Stop enumerates current owners and interrupts the fresh C attempt.
- Correct outcome under the Run Ledger model: control binds effects to the active run id and attempt. observe an obsolete Stop result cannot target a later Run; only its originally owned Interrupting Run can End or reach its deadline.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I7, tombstoned runs accept no events.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 40. RL-040: Leave unknown OpenCode assistant errors unowned

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding 4](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A is active.
  2. A delayed assistant error arrives with a native message id but unknown parent.
  3. Fallback assigns the error to the sole active Run.

- Wrong outcome reported: An unrelated old assistant prematurely ends A. Native occurrence frequency was not established.
- Correct outcome under the Run Ledger model: observe rejects or diagnoses unresolved ownership without changing A. A message-scoped error cannot become session-scoped settle merely because only one Run is active.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 41. RL-041: Apply the new Stop contract to retained pending steers

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding 5](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. B is a claimed retained Claude steer while A runs.
  2. Ordinary Stop interrupts A but deliberately preserves B.
  3. B executes without Resume.

- Wrong outcome reported: The historical E2 exception disagrees with the report's stronger Stop request; the old plan explicitly permitted it.
- Correct outcome under the Run Ledger model: The Run Ledger has one Run with B as a Run Input. control Stop pauses the ordinary inbox and closes or interrupts that Run. Unaccepted B must remain queued behind the pause or have an explicit disposition; it cannot silently start a successor. The spec does not fully state disposition of Delivered steers at Ended.
- Invariants: I3, at most one active run per session, I6, the inbox always drains, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Partial mapping: the new Stop pause promise supersedes the old E2 exception, but Delivered/Accepted steer disposition during forced close still needs an explicit transition rule.

### 42. RL-042: Derive inbox busy and pause from one ledger view

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding Q3.1](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Two inbox readers implement separate pause predicates.
  2. Run ownership or declined-steer behavior changes.
  3. Only one query is updated.

- Wrong outcome reported: The review identifies duplicate policy code with drift risk; no separate mismatch was reproduced in this report.
- Correct outcome under the Run Ledger model: The ledger writes run state and derived inbox busy in the same transaction. Both readers consume that result, including a Declined input returned to Queued without an accidental Stop pause.
- Invariants: I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Structural P3 finding from Q3: a drift opportunity rather than an additional observed failure.

### 43. RL-043: Place a continuation once per admitted attempt

- Source: conduit-test-82tn.24, unnamed review SyRa4T, sequence 10, [S60 finding Q3.2](#s60). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Prepare a continuation.
  2. Dispatch and reactor both append placement using identical event ids.
  3. Retry preparation changes membership.

- Wrong outcome reported: The review identifies duplicate placement producers; it does not reproduce another user-visible failure.
- Correct outcome under the Run Ledger model: admit owns Run Input placement and the resulting derived turn in one transaction. A retry cannot independently rewrite membership from another module.
- Invariants: I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Structural P3 finding from Q3: duplicate producers, with placement timing requiring verification.

### 44. RL-044: Do not let replayed compaction markers steal a new input

- Source: conduit-test-82tn.24, unnamed review d2lfPR, sequence 11, [S44 finding 1](#s44). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Finish summarize A.
  2. Reserve B and open its summarize bridge.
  3. Reconnect clears the parts cache.
  4. Replay A's old marker before B's real marker and idle.

- Wrong outcome reported: A's old turn moves to B, B falsely starts from A's marker, and B's real marker is unowned.
- Correct outcome under the Run Ledger model: observe deduplicates native marker ownership durably against Run Inputs. A known native message cannot consume B's Run Effect or rewrite its input identity after restart.
- Invariants: I3, at most one active run per session, I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 45. RL-045: Let Run now join an existing Stop with bounded progress

- Source: conduit-test-82tn.24, unnamed review YYDjHU, sequence 12, [S64 finding 2](#s64). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A runs.
  2. Ordinary Stop starts.
  3. Run now selects B while that Stop remains pending.
  4. The deadline uses the original replacement=false policy.

- Wrong outcome reported: A stays busy and B remains queued with no future Stop issued.
- Correct outcome under the Run Ledger model: control Run now records B's priority and bypass of pause. The existing Interrupting Run still has its persisted 30-second deadline; settle ends it once and releases B after required close handling.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 46. RL-046: Trigger OpenCode recaps from committed Run completion

- Source: conduit-test-82tn.24, unnamed review YYDjHU, sequence 12, [S64 finding 3](#s64). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An assistant message completes before native idle.
  2. The recap callback sees an unfinished turn and skips.
  3. Owned idle finally ends the Run.

- Wrong outcome reported: Automatic recap never retries although manual generation works.
- Correct outcome under the Run Ledger model: observe the owned terminal commits Ended and its derived turn before publishing completion effects. Recap consumes that committed transition exactly once, not per-message accounting completion.
- Invariants: I1, every run ends exactly once, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Indirect mapping: recap delivery is a downstream consumer obligation. I1/I9 give its committed completion source, but the spec does not itself promise automatic recaps.

### 47. RL-047: Revalidate a held recovery attempt before delivery

- Source: conduit-test-82tn.24, unnamed review Uapkm3, sequence 13, [S62 finding 1](#s62). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Recovered B is absent from an old runner journal and parks.
  2. Stop ends B at its deadline.
  3. The old runner retires.
  4. B wakes without a current running claim.

- Wrong outcome reported: The replacement still receives B after its attempt was stopped. Delivery was reproduced; the complete Stop sequence was code-derived.
- Correct outcome under the Run Ledger model: The interpreter claims a Run Effect for B's exact run id and attempt from SQLite immediately before execution. A cancelled effect or Ended Tombstone cannot fall back to inputId and send obsolete work.
- Invariants: I4, no delivery-unknown input is delivered twice, I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 48. RL-048: Bound the entire replacement warm-up attempt

- Source: conduit-test-82tn.24, unnamed review Uapkm3, sequence 13, [S62 finding 2](#s62). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An upgrade candidate completes hello.
  2. Its pre-warm call stalls during preparation or verification.
  3. A new input waits for replacement.

- Wrong outcome reported: The idle session is held indefinitely with no error or fallback. The injected hang was reproduced; a real SDK hang was not observed.
- Correct outcome under the Run Ledger model: Starting and close-confirmation work retain deadlines as data. settle a failed warm-up with a typed reason, clean up the candidate and permit a fresh executor. The process harness records candidate cleanup and next-input progress.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 49. RL-049: Keep temporary compatibility removable without rewriting surviving logic

- Source: conduit-test-82tn.24, unnamed review Uapkm3, sequence 13, [S62 finding 3](#s62). The report path is in the source register.
- Later sources: conduit-test-82tn.24, unnamed review pyr1mp, sequence 14, [S59 finding removability](#s59)
- Interleaving:

  1. Add legacy input holds inside shared conditions and renamed entry points.
  2. Attempt to remove compatibility.
  3. Deleting temporary blocks also changes surviving behavior.

- Wrong outcome reported: The promised deletion-only removal contract is not met; report S59 lists surviving test and documentation edits too.
- Correct outcome under the Run Ledger model: The spec requires deleting legacy ownership machinery. This source-contract check belongs with pure unit ownership, but no decide/evolve transition can prove deletion-only removability.
- Invariants: none; see scope note..
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Unmapped: temporary-code removal mechanics are outside the nine lifecycle invariants. Level decider means pure source-contract ownership only, not a decider behavior test.

### 50. RL-050: Keep compatibility names and interface documentation accurate

- Source: conduit-test-82tn.24, unnamed review Uapkm3, sequence 13, [S62 finding 4](#s62). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Insert InputAdmission before a ProviderInstance comment.
  2. Reuse names such as foldersPending and upgrading for broader holds.
  3. Review failure paths.

- Wrong outcome reported: Documentation attaches to the wrong interface and names misdescribe admission and cancellation states.
- Correct outcome under the Run Ledger model: Use the glossary's Run, Run Input and Run Effect vocabulary in future interfaces. There is no state-machine outcome for misplaced comments, imports or misleading legacy names.
- Invariants: none; see scope note..
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Unmapped: copy, import style and naming require source review. Level decider is pure source-contract ownership, not decide/evolve coverage.

### 51. RL-051: Settle indeterminate inputs after confirmed runner retirement

- Source: conduit-test-82tn.24, unnamed review pyr1mp, sequence 14, [S59 finding 1](#s59). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Crash after claim before delivery.
  2. The runner hello omits that command.
  3. Recovery marks it delivery unknown.
  4. Confirmed retirement evicts the process.

- Wrong outcome reported: The unknown command and reservation stay running and fence every later send.
- Correct outcome under the Run Ledger model: settle(process lost) ends the exact process-owned Run and updates its Run Inputs and derived views atomically. No unknown input is redelivered blindly; after confirmed retirement the inbox can progress.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 52. RL-052: Expose restart rejection and timeout despite cleanup

- Source: conduit-test-82tn.24, unnamed review pyr1mp, sequence 14, [S59 finding 2](#s59). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Legacy runner restart rejects or times out.
  2. End-session cleanup first marks the entry stopping.
  3. Failure reporting returns early because of that flag.

- Wrong outcome reported: Only adopted and retired logs remain; the actual restart failure is hidden.
- Correct outcome under the Run Ledger model: settle records a typed process-loss or deadline reason on the Run independently of executor cleanup flags. The isolated process harness must verify the durable reason and observable failure.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 53. RL-053: Preserve interaction support on a retried background delivery

- Source: conduit-test-82tn.24, unnamed review pyr1mp, sequence 14, [S59 finding 3](#s59). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A background delivery loses an adoption race.
  2. Retry calls runCommand without its interaction factory.
  3. The replacement asks a permission.

- Wrong outcome reported: The second provider attempt has no interaction sink and returns interaction_unsupported. Normal production reachability of this race was not established.
- Correct outcome under the Run Ledger model: A retry executes the original Run Effect identity and retains the adapter's interaction transport. observe records the permission on the owned Run; control must deliver its answer once across replacement.
- Invariants: I5, no answer is lost, I8, no illegal transitions on valid input.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Conditional finding: source-runtime reproduction is valid but normal startup orders recovery before drain, so a production trigger remains unproven.

### 54. RL-054: Do not classify legacy Cursor delivered joined as terminal

- Source: conduit-test-82tn.24, unnamed review pfY8G6, sequence 16, [S58 finding 1](#s58). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Retain a Cursor steer across upgrade.
  2. Its joined result acknowledges delivery while the original reply still streams.
  3. A generic legacy adapter converts joined to completion.

- Wrong outcome reported: The reservation, or conditionally its joined target, completes too early.
- Correct outcome under the Run Ledger model: The sole classifier distinguishes Delivered Run Input acknowledgements from native terminal observations. New-protocol compatibility refusal settles old Runs with a typed reason rather than guessing from provider-specific joined results.
- Invariants: I1, every run ends exactly once, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 55. RL-055: Preserve provider-handled retry policy in legacy errors

- Source: conduit-test-82tn.24, unnamed review pfY8G6, sequence 16, [S58 finding 2](#s58). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Legacy Cursor applies its own retry policy.
  2. It emits an error without retryHandled.
  3. Projection schedules another attempt before the returned result supplies that flag.

- Wrong outcome reported: The outbox schedules a duplicate retry after provider-handled failure.
- Correct outcome under the Run Ledger model: observe classifies the complete typed effect outcome before deciding retry effects. A provider-handled retry cannot become another start; delivery-unknown outcomes require a probe.
- Invariants: I4, no delivery-unknown input is delivered twice, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 56. RL-056: Return a declined steer without pausing the inbox

- Source: conduit-test-82tn.24, unnamed review pfY8G6, sequence 16, [S58 finding 3](#s58). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A legacy Cursor steer is declined without an error object.
  2. Fallback emits generic interrupted.
  3. Requeue interprets it as failed.

- Wrong outcome reported: The returned input pauses the queue although its target Run continues.
- Correct outcome under the Run Ledger model: observe sets that Run Input to Declined and returns it to Queued. The one active Run stays Running and routine decline adds no Stop or error pause.
- Invariants: I3, at most one active run per session, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 57. RL-057: Attach legacy output placed after hello to its exact input

- Source: conduit-test-82tn.24, unnamed review pfY8G6, sequence 16, [S58 finding 4](#s58). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Upgrade with an unplaced retained Claude steer.
  2. Hello caches a null turn id.
  3. Old runner later places the input and creates an assistant.

- Wrong outcome reported: The assistant remains parentless because the cached binding is never updated.
- Correct outcome under the Run Ledger model: Backfill retains exact Run Input identity. observe associates later placement and output with that input rather than a nullable hello-time turn snapshot; derived ownership stays consistent.
- Invariants: I3, at most one active run per session, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 58. RL-058: Defer recoverable resume failure until authorized fallback resolves

- Source: conduit-test-82tn.24, unnamed review ypkWhw, sequence 17, [S63 finding 1](#s63). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Recover a legacy Claude command.
  2. Native resume is rejected in a recoverable phase.
  3. Adapter ends the Run.
  4. Preparation executes fresh fallback with an unmapped sink.

- Wrong outcome reported: The fallback returns completed while the Run remains errored and its fallback marker was never persisted.
- Correct outcome under the Run Ledger model: observe a recoverable preparation result cannot End the Run before deciding the authorized next effect. An authorized fallback retains exact run id and attempt; the recorded-trace process harness verifies its final outcome and no duplicate start.
- Invariants: I1, every run ends exactly once, I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 59. RL-059: Keep Stop visible for a delivery-unknown retained steer

- Source: conduit-test-82tn.24, unnamed review ujISeA, sequence 18, [S61 finding 1](#s61). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. A retained Claude steer hides Stop.
  2. Its delivery becomes unknown before native intake.
  3. The frontend still classifies it as an ordinary retained steer.

- Wrong outcome reported: The frontend suppresses Stop although the unresolved delivery requires full-session recovery and keeps the inbox busy.
- Correct outcome under the Run Ledger model: The browser consumes the ledger-derived control availability for the unresolved Run. The process harness drives the browser protocol and verifies Stop becomes visible for delivery-unknown input, including after reload.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 60. RL-060: Do not let duplicate placement discard an owned failure

- Source: conduit-test-82tn.24, unnamed review ujISeA, sequence 18, [S61 finding 2](#s61). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Failure cleanup reads that A has no placement.
  2. Native placement commits before cleanup's transaction.
  3. Duplicate placement returns before processing the failure.

- Wrong outcome reported: The Run, outbox and receipt remain outstanding with no error terminal.
- Correct outcome under the Run Ledger model: admit and observe own placement and outcome in the ledger transaction. Deduplicating the Run Input placement cannot discard an otherwise legal failure transition.
- Invariants: I1, every run ends exactly once, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 61. RL-061: Check terminal ownership inside failure cleanup transaction

- Source: conduit-test-82tn.24, unnamed review n1WLLq, sequence 19, [S55 finding 2](#s55). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Failure preflight sees A open.
  2. Native completion wins before cleanup commits.
  3. Cleanup appends turn.error and runs again.

- Wrong outcome reported: A stays completed but duplicate terminal events create false error cards.
- Correct outcome under the Run Ledger model: observe reloads A under its version check and sees the Tombstone. It appends no second terminal or error projection; missing placement may only inherit the recorded outcome in the same transaction.
- Invariants: I1, every run ends exactly once, I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 62. RL-062: Retain admitted handoff data during live-command recovery

- Source: conduit-test-82tn.24, unnamed review n1WLLq, sequence 19, [S55 finding 3](#s55). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Admit a handoff with its prepared summary.
  2. Restart while the runner exposes a live resume cursor.
  3. Recovery recomputes preparation without handoff and clears the stored summary.
  4. The Run completes.

- Wrong outcome reported: The successful command has no handoff summary or delivery receipt despite delivering the original context.
- Correct outcome under the Run Ledger model: The existing Run Input and Run Effect retain the admitted payload across recovery. observe the final owned terminal updates derived handoff evidence from that original effect, never from a newly sampled preparation plan.
- Invariants: I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Indirect mapping: retaining the handoff summary follows durable input/effect identity, but the spec does not define handoff receipts or their payload retention.

### 63. RL-063: Index active ownership reads independently of command history size

- Source: conduit-test-82tn.24, unnamed review GdtD61, sequence 20, [S48 finding 1](#s48). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. Accumulate 50000 completed commands.
  2. Refresh a busy session with a pending reservation inside a shared write transaction.
  3. Select ownership without a supporting session/run index.

- Wrong outcome reported: EXPLAIN reports a full outbox scan and the measured lookup takes about 15 ms, delaying writes across projects.
- Correct outcome under the Run Ledger model: Active Run lookup uses the ledger's session ownership index and uniqueness constraint, not a scan of historical effects. Verify SQLite query plans with synthetic history as well as queue progress.
- Invariants: I6, the inbox always drains.
- Level: ledger, four verbs against real SQLite.
- Scope: Partial mapping: inbox progress is relevant, but the spec gives no latency bound or explicit indexing invariant. The reported 15 ms is evidence, not an acceptance threshold.

### 64. RL-064: Resolve durable questions when refusing an incompatible runner

- Source: conduit-test-82tn.31.5, unnamed review fUtLRc, sequence 22, [S46 finding 1](#s46). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An incompatible live runner has a pending question.
  2. Recovery cancels only in-memory interactions and evicts it.
  3. Send another input.

- Wrong outcome reported: The errored Run leaves a durable pending question that blocks subsequent sends.
- Correct outcome under the Run Ledger model: settle the refused protocol generation with a typed compatibility reason and retire its pending interactions in the same transaction as Ended. A stale question cannot outlive its Run and block the inbox.
- Invariants: I1, every run ends exactly once, I5, no answer is lost, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 65. RL-065: Quarantine a failed runner stop without disabling its project

- Source: conduit-test-82tn.31.5, unnamed review fUtLRc, sequence 22, [S46 finding 2](#s46). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Recovery refuses a live runner.
  2. Signalling fails or the PID survives bounded cleanup.
  3. recoverEffect fails relay startup.

- Wrong outcome reported: Every session in the project becomes unavailable while the reservation remains running.
- Correct outcome under the Run Ledger model: A failed kill quarantines only that executor. A live quarantined runner retains owned Runs and interactions; unrelated sessions remain usable. The process harness records liveness, quarantine, typed failure and unaffected session progress.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 66. RL-066: Detach duplicate control waiters without cancelling shared work

- Source: conduit-test-82tn.27.1, unnamed review MDwx40, sequence 23, [S53 finding 1](#s53). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. An accepted answer waits behind another effect.
  2. An identical command replay adds a waiter.
  3. Cancel only that duplicate waiter.

- Wrong outcome reported: Shared pending delivery is cancelled, the original answer is lost and its prompt stays resolved.
- Correct outcome under the Run Ledger model: control idempotently commits one answer and Run Effect. Cancelling a local observer does not mutate that durable effect; only the owning control or legitimate settle transition may cancel it.
- Invariants: I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 67. RL-067: Retain ordinary Stop pause after the pending steer finishes

- Source: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding 1](#s67). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Stop A while Bravo is a pending steer.
  2. Bravo later finishes.
  3. Newest-run-only pause selection sees Bravo completed.
  4. Charlie remains queued.

- Wrong outcome reported: Charlie drains automatically even though ordinary Stop should still pause the queue. The bead notes report this fixed separately from declined-steer handling.
- Correct outcome under the Run Ledger model: control Stop persists the inbox pause independently of which Run most recently ended. observe Bravo completion does not resume admission; only explicit Resume or Run now clears or bypasses the pause.
- Invariants: I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 68. RL-068: Persist permission-timeout rejection delivery atomically

- Source: conduit-test-82tn.27.2, round 1, [S01 finding 1](#s01). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S24](#s24).
- Interleaving:

  1. A permission deadline expires.
  2. SQLite resolves the prompt as rejected.
  3. The daemon crashes before interaction-failed reaches the surviving runner.
  4. Restart.

- Wrong outcome reported: No durable delivery exists and the recovered waiter no longer expires because its row is resolved.
- Correct outcome under the Run Ledger model: settle the interaction deadline records the rejection and enqueues its Run Effect in the same transaction. Restart claims that effect through control delivery and observe records its outcome exactly once.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 69. RL-069: Cancel inactive-project effects without blocking shared OpenCode

- Source: conduit-test-82tn.27.2, round 1, [S01 finding 2](#s01). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S24](#s24).
- Interleaving:

  1. Project A queues a control on a shared OpenCode process.
  2. Remove A before delivery.
  3. Project B submits an answer or Stop to the same process.

- Wrong outcome reported: The retained inactive queue head has no executor and blocks every later control across projects.
- Correct outcome under the Run Ledger model: settle project removal cancels its pending Run Effects with project-inactive reason. Active projects retain their ordering and can deliver answers and controls.
- Invariants: I5, no answer is lost, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 70. RL-070: Recover transiently failed permission and question answers

- Source: conduit-test-82tn.27.2, round 1, [S01 finding 3](#s01). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S24](#s24).
- Interleaving:

  1. control commits an answer and resolves its visible prompt.
  2. The provider call fails before delivery.
  3. Another browser response finds the prompt already resolved.

- Wrong outcome reported: The permanently failed control cannot drain or be answered again, leaving the provider blocked. Automatic approvals are affected too.
- Correct outcome under the Run Ledger model: A retryable Run Effect outcome retains the answer durably and schedules backoff through deadline data. observe eventual consumption finalizes it; UI resolution alone cannot discard delivery.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 71. RL-071: Keep unrelated interactions owned by a quarantined live runner

- Source: conduit-test-82tn.27.2, round 1, [S01 finding 4](#s01). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S24](#s24).
- Interleaving:

  1. A runner is quarantined but alive.
  2. An answer or backfilled effect cannot acquire its control process id.
  3. Execution treats undefined as process loss.

- Wrong outcome reported: Both the answered prompt and an unrelated live question are retired.
- Correct outcome under the Run Ledger model: A live quarantined process keeps its Run and pending interactions owned. Cancel or diagnose an undeliverable effect without settle(process lost) until death or replacement is confirmed.
- Invariants: I1, every run ends exactly once, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 72. RL-072: Classify permanent answer failures without endless retries

- Source: conduit-test-82tn.27.2, round 2, [S07 finding 1](#s07). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S30](#s30).
- Interleaving:

  1. An OpenCode answer receives permanent HTTP 400 or 404.
  2. The adapter omits a retryable property.
  3. Restart and later controls share that process queue.

- Wrong outcome reported: The answer retries forever and blocks Stop, End and other answers.
- Correct outcome under the Run Ledger model: observe classifies the typed permanent outcome explicitly, rather than treating absent metadata as retryable. The decider preserves or reconciles the pending interaction with a visible typed reason and releases unrelated effect ordering.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 73. RL-073: Preserve deferred answer reconciliation after delivery exhaustion

- Source: conduit-test-82tn.27.2, round 3, [S11 finding 1](#s11). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S34](#s34).
- Interleaving:

  1. Answer delivery repeatedly fails while OpenCode is unreachable.
  2. The final reconciliation lookup also fails.
  3. Connectivity and repeated asks return later.

- Wrong outcome reported: The failed effect is excluded forever while its prompt remains resolved and cannot be answered.
- Correct outcome under the Run Ledger model: observe failed delivery and failed reconciliation retain durable unresolved answer state and a deadline for a probe. Exhausting a delivery budget cannot erase the only recovery path or permanently block unrelated effects.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I6, the inbox always drains.
- Level: ledger, four verbs against real SQLite.

### 74. RL-074: Publish newly admitted controls only when execution ownership is durable

- Source: conduit-test-82tn.27.2, round 3, [S11 finding 2](#s11). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S34](#s34).
- Interleaving:

  1. control commits an answer for URL-only OpenCode.
  2. Post-commit publication triggers a drain.
  3. Live-control registration has not occurred yet.

- Wrong outcome reported: Recovery cancels the fresh answer with zero provider calls because it looks like unavailable recovered work.
- Correct outcome under the Run Ledger model: control records the answer and its Run Effect ownership in the same transaction before publication. A drain needs no in-memory acceptedControls registration to distinguish live delivery from recovery.
- Invariants: I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 75. RL-075: Treat OpenCode answer throttling as retryable

- Source: conduit-test-82tn.27.2, round 3, [S11 finding 3](#s11). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S34](#s34).
- Interleaving:

  1. An external OpenCode endpoint throttles an answer with HTTP 429.
  2. Reconciliation is also throttled.
  3. Error classification treats it as permanent.

- Wrong outcome reported: The answer fails on its first attempt and remains invisibly undelivered.
- Correct outcome under the Run Ledger model: observe a typed retryable throttling outcome schedules its Run Effect with backoff and a persisted deadline, retaining the answer until consumption or an explicit permanent outcome.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 76. RL-076: Respect the persisted effect budget across a crash

- Source: conduit-test-82tn.27.2, round 3, [S11 finding 4](#s11). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S34](#s34).
- Interleaving:

  1. Persist a running control at the old final delivery attempt.
  2. Crash before recording its outcome.
  3. Recovery resets it to pending and increments the counter.

- Wrong outcome reported: A sixth delivery occurs; repeated crashes bypass the five-attempt legacy cap indefinitely.
- Correct outcome under the Run Ledger model: The ledger retains attempt identity, retry budget and deadline atomically. Recovery probes a delivery-unknown effect instead of replaying it blindly. The old cap is a fixture value, not a new spec constant.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I5, no answer is lost.
- Level: ledger, four verbs against real SQLite.

### 77. RL-077: Do not exhaust a still-executing recovered answer

- Source: conduit-test-82tn.27.2, round 4, [S15 finding 1](#s15). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S38](#s38).
- Interleaving:

  1. Recovery starts its final allowed answer attempt.
  2. Delivery remains in flight.
  3. A concurrent sweep selects the same row as exhausted.
  4. The real success arrives later.

- Wrong outcome reported: The prompt reopens early and Stop overtakes the still-executing answer; the success is ignored.
- Correct outcome under the Run Ledger model: Compare-and-set effect ownership and its run version distinguish executing from exhausted delivery. A sweep cannot cancel the active claim or release its ordering before observe resolves consumption.
- Invariants: I4, no delivery-unknown input is delivered twice, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 78. RL-078: Recover Stop deadlines independently of delivery receipts

- Source: conduit-test-82tn.27.3, round 1, [S02 finding 1](#s02). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S25](#s25).
- Interleaving:

  1. A Running Claude Run acknowledges Stop.
  2. Restart before its terminal.
  3. The completed interrupt command does not recreate its scoped timer.

- Wrong outcome reported: A stays busy beyond 35 seconds with no retirement delivery.
- Correct outcome under the Run Ledger model: control persists Interrupting and its 30-second deadline. After restart settle ends it once as interrupted, tombstones it, issues close, and uses the second deadline for kill/respawn if close is unconfirmed. The isolated harness records both restart and cleanup.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 79. RL-079: Keep a delayed empty Stop away from newer foreground work

- Source: conduit-test-82tn.27.3, round 1, [S02 finding 2](#s02). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S25](#s25).
- Interleaving:

  1. An idle Stop captures no Run.
  2. Its control is delayed beyond the bound.
  3. A fresh foreground Run starts.
  4. The stale Stop reaches the runner.

- Wrong outcome reported: The stale empty control disposes the fresh query with no terminal and leaves it running durably.
- Correct outcome under the Run Ledger model: control while idle cannot create a session-wide close effect that later targets arbitrary work. Any retained effect has an exact owner and attempt; a newly admitted Run cannot inherit an idle Stop.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I7, tombstoned runs accept no events.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 80. RL-080: Cancel obsolete forced retirement before it reaches a successor

- Source: conduit-test-82tn.27.3, round 1, [S02 finding 3](#s02). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S25](#s25).
- Interleaving:

  1. Stop escalation queues End for A.
  2. A completes while End is pending.
  3. A retained steer starts B on the same runner.
  4. Process-only retirement delivers.

- Wrong outcome reported: B is interrupted by retirement intended for already-ended A.
- Correct outcome under the Run Ledger model: After A ends naturally, its queued forced-retirement effect is obsolete and cannot target B. The interpreter retains exact run id and attempt. This differs from a Stop deadline: the spec explicitly requires close and possibly kill/respawn effects after that interrupted Ended Tombstone, so Ended alone is not a blanket cancellation rule for cleanup.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I7, tombstoned runs accept no events.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 81. RL-081: Bound question-replacement interruption

- Source: conduit-test-82tn.27.3, round 1, [S02 finding 4](#s02). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S25](#s25).
- Interleaving:

  1. A has a live question.
  2. The user sends a replacement.
  3. Direct interrupt waits for an acknowledgement that never arrives.

- Wrong outcome reported: The RPC stays unresolved beyond 35 seconds, the replacement is not admitted and A stays running.
- Correct outcome under the Run Ledger model: control represents the question replacement through the same Interrupting state and deadline as Stop, while admit durably retains its replacement Run Input. The process harness proves progress through close and forced retirement.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 82. RL-082: Preserve pending intake when an empty Stop arrives late

- Source: conduit-test-82tn.27.3, round 2, [S08 finding 1](#s08). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S31](#s31).
- Interleaving:

  1. An idle Stop is delayed.
  2. A newer Run finishes but its retained steer has not reached intake.
  3. The stale Stop sees turnInFlight false.

- Wrong outcome reported: It disposes the query and errors the pending successor outside its empty cohort.
- Correct outcome under the Run Ledger model: Pending Delivered Run Inputs remain explicitly represented even when no reply is streaming. An idle Stop has no authority over that newer Run or its pending input; the decider cannot infer ownership from turnInFlight.
- Invariants: I3, at most one active run per session, I4, no delivery-unknown input is delivered twice, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 83. RL-083: Release an obsolete unacknowledged runner interrupt

- Source: conduit-test-82tn.27.3, round 2, [S08 finding 2](#s08). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S31](#s31).
- Interleaving:

  1. A Stop waits forever for interrupt acknowledgement.
  2. A finishes naturally.
  3. The deadline returns locally without settling its running control.
  4. A later permission answer queues.

- Wrong outcome reported: The obsolete control blocks every subsequent control on that process.
- Correct outcome under the Run Ledger model: observe A's terminal ends it once and cancels obsolete interrupt effects. Releasing a safely run-scoped runner effect permits later answers without adding another Run terminal. Shared OpenCode abort needs its separate scope proof.
- Invariants: I1, every run ends exactly once, I5, no answer is lost, I6, the inbox always drains.
- Level: decider, pure decide/evolve inputs and emitted effects.

### 84. RL-084: Preserve immutable legacy Stop payload on replay

- Source: conduit-test-82tn.27.3, round 2, [S08 finding 3](#s08). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S31](#s31).
- Interleaving:

  1. A predecessor build commits Stop without stop metadata.
  2. Restart with the new build.
  3. Recovery recomputes a cohort and changes the payload under the same command id.

- Wrong outcome reported: CommandFingerprintMismatch rejects the retry.
- Correct outcome under the Run Ledger model: Backfill retains the admitted control identity and payload; any new ledger metadata is recorded separately in the same transaction. An idempotent control replay cannot mutate its immutable delivery identity.
- Invariants: I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 85. RL-085: Retain undelivered forced retirement across downtime

- Source: conduit-test-82tn.27.3, round 3, [S12 finding 1](#s12). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S35](#s35).
- Interleaving:

  1. Commit A's retirement effect.
  2. Stop the daemon before delivery.
  3. Restart after the old 35-second control expiry.

- Wrong outcome reported: The retirement itself expires permanently, leaving the runner alive and its Run running.
- Correct outcome under the Run Ledger model: Deadline expiry calls settle on durable Run state rather than discarding the only required close effect. Replay the pending close and, after close-confirmation expiry, kill/respawn the executor. Recorded restart traces must prove eventual cleanup.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 86. RL-086: Recover an answer that expires before native delivery

- Source: conduit-test-82tn.27.3, round 3, [S12 finding 2](#s12). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S35](#s35).
- Interleaving:

  1. An answer remains queued across a long restart.
  2. Its delivery deadline expires before provider invocation.
  3. A defined error skips prompt reconciliation.

- Wrong outcome reported: The prompt remains resolved with zero native calls; replay times out and a fresh answer is rejected as stale.
- Correct outcome under the Run Ledger model: settle an effect deadline retains the answer and records whether delivery is known absent or unknown. A known unconsumed interaction remains answerable or retryable; a delivery-unknown answer needs a probe before reopening.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 87. RL-087: Keep shared OpenCode abort fenced through execution

- Source: conduit-test-82tn.27.3, round 4, [S16 finding 1](#s16). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S39](#s39).
- Interleaving:

  1. OpenCode HTTP abort for A remains pending.
  2. A completes naturally.
  3. The Stop fence releases and B starts.
  4. The old abort finally executes.

- Wrong outcome reported: The still-live session-wide abort cancels B.
- Correct outcome under the Run Ledger model: The adapter must finish or safely invalidate a session-wide control before permitting a successor on that native session. A run-scoped Tombstone cannot cancel an HTTP promise. The process harness replays the delayed abort and verifies B survives.
- Invariants: I1, every run ends exactly once, I3, at most one active run per session, I7, tombstoned runs accept no events.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Partial mapping: the spec requires owned effects and Stop progress but does not define the OpenCode cancellation boundary; this is distinct from an old in-flight prompt arriving after Stop.

### 88. RL-088: Probe runner answer consumption before reopening a timed-out prompt

- Source: conduit-test-82tn.27.3, round 4, [S16 finding 2](#s16). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S39](#s39).
- Interleaving:

  1. The runner consumes an answer.
  2. Its reply exceeds the control deadline.
  3. Only the socket waiter is removed.
  4. Reconciliation reopens the prompt.
  5. The late reply arrives.

- Wrong outcome reported: The consumed prompt stays pending and can accept another answer. Duplicate tool execution was not demonstrated.
- Correct outcome under the Run Ledger model: observe delivery-unknown issues a probe of the exact Run Effect instead of reopening. control a second answer cannot create another delivery until the original consumption state is resolved.
- Invariants: I4, no delivery-unknown input is delivered twice, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 89. RL-089: Expect terminal-driven release for safe runner Stop controls

- Source: conduit-test-82tn.27.3, round 4, [S16 finding 3](#s16). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S39](#s39).
- Interleaving:

  1. Claude Stop acknowledgement is delayed.
  2. The original Run completes naturally.
  3. The replacement starts after the retained barrier.
  4. The test still expects blocking.

- Wrong outcome reported: Three integration assertions fail against both old and changed production code.
- Correct outcome under the Run Ledger model: The pure transition table expects observe the owned terminal to release safely run-scoped runner controls and allow the selected input. The OpenCode session-wide abort case has a different adapter obligation. Replace these incorrect expectations rather than encode them as desired behavior.
- Invariants: I1, every run ends exactly once, I6, the inbox always drains, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Test-only finding: the observed wrong outcome is a false-red assertion, not a demonstrated production regression.

### 90. RL-090: Expect obsolete recovered Stops to skip native delivery

- Source: conduit-test-82tn.27.3, round 4, [S16 finding 4](#s16). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S39](#s39).
- Interleaving:

  1. Recovery holds Stop dispatch.
  2. The captured Run completes.
  3. Release dispatch after completion.
  4. The test waits for exactly one native Stop.

- Wrong outcome reported: Both provider fixtures time out although the completed control correctly skipped obsolete native delivery and the replacement runs.
- Correct outcome under the Run Ledger model: observe Ended cancels the obsolete Run Effect. A pure transition case expects no interrupt effect for the Tombstone and confirms the successor remains unaffected.
- Invariants: I1, every run ends exactly once, I7, tombstoned runs accept no events, I8, no illegal transitions on valid input.
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Test-only finding: change the old synchronization expectation; do not require an extra native Stop.

### 91. RL-091: Preserve every process-proof scenario under concurrent writers

- Source: conduit-test-82tn.27.3, round 4, [S16 finding 5](#s16). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S39](#s39).
- Interleaving:

  1. Two integration workers read the same proof JSON.
  2. Each appends a different scenario batch.
  3. Both write the shared file without locking.

- Wrong outcome reported: One batch disappears or another reader sees partial JSON; the synchronized reproduction retained only one of two scenarios.
- Correct outcome under the Run Ledger model: Each isolated process-harness case writes its own complete recorded-trace JSON artifact, then aggregation retains every cell. This verifies the spec's artifact requirement but is not a Run state transition.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped to the nine lifecycle invariants: concurrent artifact I/O is test infrastructure. The spec separately requires complete repeatable JSON crash-matrix evidence.

### 92. RL-092: Preserve accepted effects during temporary relay replacement

- Source: conduit-test-82tn.10.4, round 1, [S03 finding 1](#s03). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S26](#s26).
- Interleaving:

  1. SaveProject disposes a relay for folder replacement.
  2. The shared drain runs during the attachment gap.
  3. The replacement becomes available again.

- Wrong outcome reported: Accepted pending work is permanently refused as project_unavailable with attempt zero.
- Correct outcome under the Run Ledger model: Temporary attachment loss does not equal project removal. The ledger retains its Queued input and Run Effect with a deadline; a replacement executor resumes it without resubmitting any delivery-unknown work. The harness records the gap and restored progress.
- Invariants: I2, every unfinished run has a deadline, I4, no delivery-unknown input is delivered twice, I6, the inbox always drains.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 93. RL-093: Recover controls imported after initial startup

- Source: conduit-test-82tn.10.4, round 1, [S03 finding 2](#s03). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S26](#s26).
- Interleaving:

  1. The one-time daemon recovery sweep finishes.
  2. SaveProject imports an old running control.
  3. Register the project and continue draining.

- Wrong outcome reported: The imported effect never becomes claimable and blocks later shared-process controls.
- Correct outcome under the Run Ledger model: Import/backfill establishes durable Run Effect state in its transaction. settle and deadline selection include newly imported unfinished work without resetting another project's active claims.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 94. RL-094: Preserve refused unplaced user input durably

- Source: conduit-test-82tn.10.4, round 1, [S03 finding 3](#s03). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S26](#s26).
- Interleaving:

  1. A recovered send already removed its input from the inbox.
  2. Refuse it before provider intake.
  3. No foreground handler remains to restore placement.
  4. Repair the project and restart.

- Wrong outcome reported: Only an assistant error remains; the original prompt exists in neither inbox nor transcript.
- Correct outcome under the Run Ledger model: admit persists its Run Input before delivery. A permanent refusal keeps a recoverable Queued input or a visible failed user placement with its typed reason in the same transaction as effect settlement.
- Invariants: I4, no delivery-unknown input is delivered twice, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 95. RL-095: Settle claimed unaccepted work for inactive projects

- Source: conduit-test-82tn.10.4, round 2, [S05 finding 1](#s05). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S28](#s28).
- Interleaving:

  1. Crash after claiming a send before intake.
  2. Restart with its project removed or unavailable.
  3. Refusal selects only pending sends while adapter recovery cannot attach.

- Wrong outcome reported: The running claim and requested receipt stay stuck and block later commands.
- Correct outcome under the Run Ledger model: settle project inactivity handles every retained effect, including claimed delivery-unknown work, with explicit project-inactive reason. Native execution ownership must be confirmed separately before ending a potentially live Run.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 96. RL-096: Verify surviving native ownership before synthetic project refusal

- Source: conduit-test-82tn.10.4, round 3, [S09 finding 1](#s09). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S32](#s32).
- Interleaving:

  1. A runner owns input after placement but before run.started commits.
  2. Crash the daemon.
  3. Restart with the project absent and classify missing acceptance as unstarted.
  4. Re-add the project.

- Wrong outcome reported: A synthetic error is followed by the surviving runner's completion for the same run.
- Correct outcome under the Run Ledger model: A Delivered input is not proven unreceived. Recovery probes the exact run id and attempt, and either continues the surviving Run or confirms close/process loss before settle. Replay held placement acknowledgements through the harness and assert one terminal.
- Invariants: I1, every run ends exactly once, I4, no delivery-unknown input is delivered twice, I7, tombstoned runs accept no events.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.

### 97. RL-097: Retain late accounting without changing an interrupted lifecycle

- Source: conduit-test-82tn.10.4, round 4, [S13 finding 1](#s13). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S36](#s36).
- Interleaving:

  1. Stop ends A.
  2. Its successful SDK result later reports cumulative cost 1.
  3. B reports cumulative cost 2.

- Wrong outcome reported: A accounting is discarded and B absorbs both dollars instead of one each.
- Correct outcome under the Run Ledger model: Required behavior is immutable Ended lifecycle with cost and tokens attributed to their original Run Input. The spec's literal Tombstone rule ignores every later event, so it does not define how observe preserves this accounting. Do not reopen A to repair cost.
- Invariants: I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Spec tension: user story 30 requires late accounting, while the Tombstones decision ignores any later event for an Ended run. A separate accounting observation contract or a narrowed ignore rule is needed; no such API is invented here.

### 98. RL-098: Fence new claims while replacement attachment recovery selects work

- Source: conduit-test-82tn.10.4, round 5, [S17 finding 1](#s17). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S40](#s40).
- Interleaving:

  1. Relay replacement publishes its borrow.
  2. Recovery snapshots awaiting-intake work.
  3. The daemon claims a send before attachment finishes.
  4. Recovery uses its stale orphan snapshot.

- Wrong outcome reported: A live attempt is falsely failed runner_stopped before intake and its prompt can disappear.
- Correct outcome under the Run Ledger model: The ledger claims the Run Effect with attempt-specific compare-and-set ownership. Recovery re-reads and re-decides on version conflict instead of settling from a stale attachment snapshot.
- Invariants: I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 99. RL-099: Retain historical accounting after a prompt is reused

- Source: conduit-test-82tn.10.4, round 5, [S17 finding 2](#s17). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S40](#s40).
- Interleaving:

  1. A is interrupted.
  2. Retry or continuation reassigns the old turn to B.
  3. A's successful result arrives late.

- Wrong outcome reported: Validation requires current turn ownership and discards A's cost and tokens.
- Correct outcome under the Run Ledger model: Required behavior retains immutable Run Input history for A accounting while B owns the current execution. A stays Ended. As in the earlier accounting case, the spec must reconcile story 30 with the literal Tombstone rule before defining the observation path.
- Invariants: I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Spec tension: historical input identity helps attribution, but does not by itself authorize a later event for a Tombstone.

### 100. RL-100: Do not confuse a refusal lock with live execution ownership

- Source: conduit-test-82tn.10.4, round 6, [S20 finding 1](#s20). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S41](#s41).
- Interleaving:

  1. A refusal sweep holds a session lock.
  2. Project re-registration sees that lock and skips attachment recovery.
  3. The sweep sees restored registration and abandons refusal.

- Wrong outcome reported: No executor owns the still-running send and later drains never select it.
- Correct outcome under the Run Ledger model: SQLite Run Effect claims and run id/attempt establish execution ownership. A local lock cannot suppress settle or deadline recovery; versioned transactions resolve the re-registration race.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 101. RL-101: Resolve persisted parents for separately batched late accounting

- Source: conduit-test-82tn.10.4, round 6, [S20 finding 2](#s20). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S41](#s41).
- Interleaving:

  1. Retry A's prompt as B.
  2. A's late assistant header persists with parent_id but no current turn_id.
  3. Its completion arrives in another ingestion batch.

- Wrong outcome reported: Accounting is discarded and the assistant stays streaming; batching header and completion together works.
- Correct outcome under the Run Ledger model: Required behavior resolves the original Run Input from persisted native message identity independently of ingestion batch boundaries and preserves A's Ended outcome. The late-accounting Tombstone contract remains unresolved.
- Invariants: I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Spec tension: story 30 needs a permitted accounting path after Ended; the ledger must not treat missing same-batch header data as authority to reopen the Run.

### 102. RL-102: Keep execution ownership specific to each retry attempt

- Source: conduit-test-82tn.10.4, round 7, [S22 finding 1](#s22). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S42](#s42).
- Interleaving:

  1. An old background attempt is unwinding.
  2. A retry starts under the same command id.
  3. The old finalizer deletes the shared ownership entry.
  4. Recovery inspects the retry.

- Wrong outcome reported: The active retry is falsely orphaned and failed runner_stopped.
- Correct outcome under the Run Ledger model: Run Effect claims and protocol messages retain exact run id and attempt. A stale finalizer cannot clear a newer attempt's durable ownership; version conflicts reload and decide again.
- Invariants: I4, no delivery-unknown input is delivered twice, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 103. RL-103: Reconcile cancelled pending OpenCode reservations on project return

- Source: conduit-test-82tn.10.4, round 7, [S22 finding 2](#s22). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S42](#s42).
- Interleaving:

  1. Crash after OpenCode claim before intake.
  2. Remove the project and cancel its command without process-liveness support.
  3. Reattach it.

- Wrong outcome reported: Command recovery excludes cancelled rows and observed-run recovery excludes pending reservations, leaving inbox busy forever.
- Correct outcome under the Run Ledger model: Project return reconciles every unfinished ledger Run from provider truth regardless of legacy command cancellation. Its persisted deadline drives settle, with a probe for any delivery-unknown Run Input.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 104. RL-104: Honor explicit input ownership on late bare SDK results

- Source: conduit-test-82tn.10.4, round 7, [S22 finding 3](#s22). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S42](#s42).
- Interleaving:

  1. An SDK-local compact request has no own assistant.
  2. Its late result names the current prompt but reuses a previous answer message id.
  3. Foreign-header validation overrides the explicit prompt owner.

- Wrong outcome reported: The compact input loses its one-dollar cost delta and 200 input tokens.
- Correct outcome under the Run Ledger model: Required behavior attributes accounting to the explicit Run Input/native message ownership independently of an unrelated assistant header, preserving the interrupted outcome. The spec must first define accounting observations compatible with Tombstones.
- Invariants: I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Spec tension: this is a distinct explicit-owner case of story 30 versus ignoring all late Ended-run events.

### 105. RL-105: Preserve the admitted idle policy on daemon replay

- Source: conduit-test-82tn.18, round 1, [S04 finding 1](#s04). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S27](#s27).
- Interleaving:

  1. A starts with idle policy null.
  2. Save policy 1 during A.
  3. Restart and replay the same command id.

- Wrong outcome reported: Recovery resamples 1 before deduplication and the runner exits after completion without a new admission.
- Correct outcome under the Run Ledger model: Preserve the source ticket's admitted policy on replay. Run Effects retain admitted input identity, but the Run Ledger spec does not define idle-policy snapshots or their sampling boundary.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: idle retirement policy and settings layering are outside the Run Ledger lifecycle contract. Keep this isolated process-harness compatibility regression; do not add a policy field to the proposed Run union.

### 106. RL-106: Preserve retained idle policy when a legacy send omits it

- Source: conduit-test-82tn.18, round 1, [S04 finding 2](#s04). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S27](#s27).
- Interleaving:

  1. A new runner retains null policy.
  2. Roll back to an old daemon.
  3. A snapshotless send calls beginTurn(undefined).
  4. Idle sweep runs.

- Wrong outcome reported: The retained policy is erased and the three-day default silently replaces null.
- Correct outcome under the Run Ledger model: Preserve the retained policy when legacy metadata is absent, with an explicit initialization policy for incapable peers. No Run Input state transition determines that policy.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: legacy idle-policy initialization is not specified by the Run Ledger. Test through an isolated two-build process harness.

### 107. RL-107: Detect computed and injected runtime configuration reads

- Source: conduit-test-82tn.18, round 1, [S04 finding 3](#s04). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S27](#s27).
- Interleaving:

  1. Add a virtual runtime source with a computed daemon.json filename.
  2. Add another using PersistencePathTag.
  3. Run the source guard.

- Wrong outcome reported: Both prohibited config-read paths produce zero violations.
- Correct outcome under the Run Ledger model: The existing configuration guard must reject its negative source fixtures. A Run Ledger decider cannot classify arbitrary filesystem reads.
- Invariants: none; see scope note..
- Level: decider, pure decide/evolve inputs and emitted effects.
- Scope: Unmapped: config-read enforcement is outside run state. Level decider denotes a pure source-contract fixture in the unit owner file, not decide/evolve behavior.

### 108. RL-108: Preserve admitted idle policy across warm runner replacement

- Source: conduit-test-82tn.18, round 2, [S06 finding 1](#s06). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S29](#s29).
- Interleaving:

  1. A starts under null policy.
  2. Save 1 mid-run.
  3. Restart with a different build.
  4. Warm replacement restores via pre-warm only.

- Wrong outcome reported: The replacement uses current policy 1 and exits without another admitted turn.
- Correct outcome under the Run Ledger model: Carry the existing admitted idle-policy snapshot through replacement initialization. The ledger's protocol compatibility promise does not define idle-policy semantics.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: warm replacement policy is an adjacent settings compatibility contract, not a Run Ledger invariant.

### 109. RL-109: Do not seed replacement policy from a send refused before admission

- Source: conduit-test-82tn.18, round 3, [S10 finding 1](#s10). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S33](#s33).
- Interleaving:

  1. A completed with null idle policy.
  2. Save 1.
  3. A Cursor send fails auth before any send frame.
  4. Upgrade the runner.

- Wrong outcome reported: Replacement chooses the failed row's 1 even though the runner never admitted it.
- Correct outcome under the Run Ledger model: Restore policy from actual admissions and distinguish preparation refusal from Accepted Run Input. The desired idle-policy value itself remains outside the new spec.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: the ledger distinguishes delivery and acceptance but does not specify settings selection for runner retirement.

### 110. RL-110: Respect a newer legacy admission before restoring an old policy

- Source: conduit-test-82tn.18, round 3, [S10 finding 2](#s10). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S33](#s33).
- Interleaving:

  1. A modern admission stores policy 1.
  2. Roll back and admit a newer snapshotless command with policy null.
  3. Upgrade again.

- Wrong outcome reported: Snapshot filtering skips the newer legacy admission and resurrects 1.
- Correct outcome under the Run Ledger model: Treat a newer snapshotless admission as an explicit compatibility boundary rather than authority to reuse older settings. Run Input order may supply evidence; the spec defines no fallback policy.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: mixed-build settings provenance is outside the Run Ledger contract.

### 111. RL-111: Reconcile journal admission before choosing replacement idle policy

- Source: conduit-test-82tn.18, round 4, [S14 finding 1](#s14). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S37](#s37).
- Interleaving:

  1. A null-policy send reaches the runner.
  2. The daemon dies before acknowledgement persistence.
  3. The runner dies before started.
  4. Restart initializes from current policy 1 before reading hello journal evidence.

- Wrong outcome reported: The admitted null becomes 1 and prewarm can exit without a new send.
- Correct outcome under the Run Ledger model: The source ticket requires resolving admission evidence before idle-policy initialization. The redesign deletes the send journal and needs an explicit compatibility policy for this history; deadlines alone do not define it.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: the journal is scheduled for deletion, but the spec does not say how to preserve its idle-policy evidence during upgrade.

### 112. RL-112: Forward the shared config snapshot to dynamically added projects

- Source: conduit-test-82tn.18, round 4, [S14 finding 2](#s14). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S37](#s37).
- Interleaving:

  1. Start the daemon with a shared config snapshot.
  2. Corrupt its isolated daemon.json on disk.
  3. Dynamically add another project without forwarding ConfigSnapshotTag.

- Wrong outcome reported: The new relay reloads disk and project addition fails Invalid.
- Correct outcome under the Run Ledger model: Forward the already-shared snapshot as required by the original config ownership contract. Run Ledger admit/observe/control/settle do not own project configuration propagation.
- Invariants: none; see scope note..
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Unmapped: project configuration composition is independent of run lifecycle. The process harness must use a temporary config directory.

### 113. RL-113: Publish a sidebar delta when control availability changes

- Source: conduit-test-82tn.24, unnamed review n1WLLq, sequence 19, [S55 finding 1](#s55). The report path is in the source register.
- Later sources: conduit-test-82tn.24, bead notes, updated 2026-10-21, [S67 finding notes](#s67)
- Interleaving:

  1. A retained steer becomes delivery unknown.
  2. sessions.version advances but stored sidebar fields do not change.
  3. A shell subscriber requests deltas.

- Wrong outcome reported: No row is published although a fresh read says canStop=true. Correcting frontend suppression alone does not repair this missing update.
- Correct outcome under the Run Ledger model: The ledger derives and publishes control availability with its Run and inbox views in the same transaction. A subscriber cursor must receive the changed session row even when only ownership state changed.
- Invariants: I2, every unfinished run has a deadline, I6, the inbox always drains, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.

### 114. RL-114: Settle recovered failures for fallback-suffixed bindings

- Source: conduit-test-82tn.24, unnamed review pfY8G6, sequence 16, [S58 finding recovery caveat](#s58). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. Recovery retains a command with a fallback-suffixed binding.
  2. The recovered command fails.
  3. An unchanged pending comparison excludes that binding from its immediate failure callback.

- Wrong outcome reported: The immediate recovered-command failure callback is skipped. The report identifies this as a pre-existing caveat, not a newly introduced defect; it gives no complete daemon reproduction.
- Correct outcome under the Run Ledger model: observe the exact failed Run Effect or settle confirmed process loss through the ledger independently of sink-name suffixes. The recorded-trace process harness must prove the failed attempt reaches one Ended outcome and its derived receipt agrees.
- Invariants: I1, every run ends exactly once, I2, every unfinished run has a deadline, I9, ledger tables and derived views always agree after any rollback.
- Level: e2e, isolated built-daemon process harness with recorded provider traces and JSON evidence.
- Scope: Conditional evidence: concrete source-path caveat, without a complete process reproduction. It is distinct from RL-058, which ends recoverable resume rejection too early.

### 115. RL-115: Recover a targeted answer interrupted after claim

- Source: conduit-test-82tn.27.1, unnamed review MDwx40, sequence 23, [S53 finding introduction](#s53). The report path is in the source register.
- Later sources: none.
- Interleaving:

  1. control commits a targeted answer.
  2. Claim its effect.
  3. The daemon crashes before recording delivery outcome.
  4. Restart must recover the projected resolution.

- Wrong outcome reported: The report identifies a stranded-resolution gap after claim. Existing production callers did not yet reach this engine path and restart delivery was deferred to the next slice.
- Correct outcome under the Run Ledger model: control records answer and effect identity atomically. Recovery retains the persisted claim as delivery unknown, issues a probe and settles consumption or retries safely; it cannot lose the only answer behind a resolved prompt.
- Invariants: I2, every unfinished run has a deadline, I5, no answer is lost, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Conditional finding: code-inspected, unreached by the then-current production callers, and explicitly deferred in the source. Those limits do not remove the regression obligation.

### 116. RL-116: Attribute out-of-order cumulative accounting without miscounting

- Source: conduit-test-82tn.10.4, round 6, [S20 finding introduction](#s20). The report path is in the source register.
- Later sources: none.
- Identical report copies: [S41](#s41).
- Interleaving:

  1. Provider results carrying cumulative usage totals arrive out of order.
  2. Accounting attributes their deltas across inputs.

- Wrong outcome reported: The reviewer states that cumulative totals miscount identically on HEAD and the reviewed version. Exact totals, ownership sequence and probe output are omitted from the supplied report.
- Correct outcome under the Run Ledger model: Required behavior attributes cost and tokens to the correct Run Input regardless of result arrival order while preserving Ended lifecycle. A ledger fixture must first recover the missing reproduction details; no numerical expectation is invented here.
- Invariants: I7, tombstoned runs accept no events, I9, ledger tables and derived views always agree after any rollback.
- Level: ledger, four verbs against real SQLite.
- Scope: Evidence gap and spec tension: this is an explicitly reproduced inherited defect, but the supplied report omits the minimal sequence and totals. Story 30 requires correct attribution, and any late Ended-run observation still needs the Tombstone clarification recorded in RL-097.

## Source register and coverage

S01-S67 preserve manifest order. Source links refer to local evidence supplied for this ticket; these temporary reports may not survive cleanup. Findings are numbered in their report order; Q3.1 and Q3.2 identify named simplification sections. S44 finding 1 is Task B's single finding. S67 notes are cited only where they repeat evidence, with finding 1 denoting its unique Stop-pause report.

82tn.24 reports have no reliable author-assigned round number. Their sequence labels below use original report modification times to retain earliest/later ordering, not invented review-round claims. The review token and exact path identify each round unambiguously. The interleavings and observed outcomes are retained in the catalogue even when later rounds report a fix.

| Source | Bead and review round | Report path | Coverage |
| --- | --- | --- | --- |
| <a id="s01"></a>S01 | conduit-test-82tn.27.2, round 1 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review-82tn27-2.T0X6Zx/report.md` | RL-068, RL-069, RL-070, RL-071 |
| <a id="s02"></a>S02 | conduit-test-82tn.27.3, round 1 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review-82tn27-3.fFweCG/report.md` | RL-078, RL-079, RL-080, RL-081 |
| <a id="s03"></a>S03 | conduit-test-82tn.10.4, round 1 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review1-82tn10-4.kuxU3f/report.md` | RL-092, RL-093, RL-094 |
| <a id="s04"></a>S04 | conduit-test-82tn.18, round 1 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review1-82tn18.3BlgoE/report.md` | RL-105, RL-106, RL-107 |
| <a id="s05"></a>S05 | conduit-test-82tn.10.4, round 2 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review2-82tn10-4.J0NL01/report.md` | RL-095 |
| <a id="s06"></a>S06 | conduit-test-82tn.18, round 2 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review2-82tn18.w3qTlu/report.md` | RL-108 |
| <a id="s07"></a>S07 | conduit-test-82tn.27.2, round 2 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review2-82tn27-2.vCCc1K/report.md` | RL-072 |
| <a id="s08"></a>S08 | conduit-test-82tn.27.3, round 2 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review2-82tn27-3.xFeAAg/report.md` | RL-082, RL-083, RL-084 |
| <a id="s09"></a>S09 | conduit-test-82tn.10.4, round 3 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review3-82tn10-4.8DZze2/report.md` | RL-096 |
| <a id="s10"></a>S10 | conduit-test-82tn.18, round 3 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review3-82tn18.O7W8UF/report.md` | RL-109, RL-110 |
| <a id="s11"></a>S11 | conduit-test-82tn.27.2, round 3 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review3-82tn27-2.oQMaCi/report.md` | RL-073, RL-074, RL-075, RL-076 |
| <a id="s12"></a>S12 | conduit-test-82tn.27.3, round 3 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review3-82tn27-3.Tx5FNe/report.md` | RL-085, RL-086 |
| <a id="s13"></a>S13 | conduit-test-82tn.10.4, round 4 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review4-82tn10-4.WTYxfS/report.md` | RL-097 |
| <a id="s14"></a>S14 | conduit-test-82tn.18, round 4 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review4-82tn18.a4tzRS/report.md` | RL-111, RL-112 |
| <a id="s15"></a>S15 | conduit-test-82tn.27.2, round 4 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review4-82tn27-2.KdGk5a/report.md` | RL-077 |
| <a id="s16"></a>S16 | conduit-test-82tn.27.3, round 4 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review4-82tn27-3.FiV15C/report.md` | RL-087, RL-088, RL-089, RL-090, RL-091 |
| <a id="s17"></a>S17 | conduit-test-82tn.10.4, round 5 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review5-82tn10-4.eAbhmp/report.md` | RL-098, RL-099 |
| <a id="s18"></a>S18 | conduit-test-82tn.18, round 5 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review5-82tn18.8DFutX/report.md` | No additional material finding. |
| <a id="s19"></a>S19 | conduit-test-82tn.27.2, round 5 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review5-82tn27-2.s32u7p/report.md` | No additional material finding. |
| <a id="s20"></a>S20 | conduit-test-82tn.10.4, round 6 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review6-82tn10-4.nj4EmG/report.md` | RL-100, RL-101, RL-116 |
| <a id="s21"></a>S21 | conduit-test-82tn.27.3, round 6 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review6-82tn27-3.eXdW0L/report.md` | No additional material finding. |
| <a id="s22"></a>S22 | conduit-test-82tn.10.4, round 7 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review7-82tn10-4.PmSE9M/report.md` | RL-102, RL-103, RL-104 |
| <a id="s23"></a>S23 | conduit-test-82tn.27.3, round 7 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review7-82tn27-3.75IGQw/report.md` | No additional material finding. |
| <a id="s24"></a>S24 | conduit-test-82tn.27.2, round 1 | `/tmp/82tn-beads/review-82tn27-2.md` | Byte-identical copy of [S01](#s01); no additional finding. |
| <a id="s25"></a>S25 | conduit-test-82tn.27.3, round 1 | `/tmp/82tn-beads/review-82tn27-3.md` | Byte-identical copy of [S02](#s02); no additional finding. |
| <a id="s26"></a>S26 | conduit-test-82tn.10.4, round 1 | `/tmp/82tn-beads/review1-82tn10-4.md` | Byte-identical copy of [S03](#s03); no additional finding. |
| <a id="s27"></a>S27 | conduit-test-82tn.18, round 1 | `/tmp/82tn-beads/review1-82tn18.md` | Byte-identical copy of [S04](#s04); no additional finding. |
| <a id="s28"></a>S28 | conduit-test-82tn.10.4, round 2 | `/tmp/82tn-beads/review2-82tn10-4.md` | Byte-identical copy of [S05](#s05); no additional finding. |
| <a id="s29"></a>S29 | conduit-test-82tn.18, round 2 | `/tmp/82tn-beads/review2-82tn18.md` | Byte-identical copy of [S06](#s06); no additional finding. |
| <a id="s30"></a>S30 | conduit-test-82tn.27.2, round 2 | `/tmp/82tn-beads/review2-82tn27-2.md` | Byte-identical copy of [S07](#s07); no additional finding. |
| <a id="s31"></a>S31 | conduit-test-82tn.27.3, round 2 | `/tmp/82tn-beads/review2-82tn27-3.md` | Byte-identical copy of [S08](#s08); no additional finding. |
| <a id="s32"></a>S32 | conduit-test-82tn.10.4, round 3 | `/tmp/82tn-beads/review3-82tn10-4.md` | Byte-identical copy of [S09](#s09); no additional finding. |
| <a id="s33"></a>S33 | conduit-test-82tn.18, round 3 | `/tmp/82tn-beads/review3-82tn18.md` | Byte-identical copy of [S10](#s10); no additional finding. |
| <a id="s34"></a>S34 | conduit-test-82tn.27.2, round 3 | `/tmp/82tn-beads/review3-82tn27-2.md` | Byte-identical copy of [S11](#s11); no additional finding. |
| <a id="s35"></a>S35 | conduit-test-82tn.27.3, round 3 | `/tmp/82tn-beads/review3-82tn27-3.md` | Byte-identical copy of [S12](#s12); no additional finding. |
| <a id="s36"></a>S36 | conduit-test-82tn.10.4, round 4 | `/tmp/82tn-beads/review4-82tn10-4.md` | Byte-identical copy of [S13](#s13); no additional finding. |
| <a id="s37"></a>S37 | conduit-test-82tn.18, round 4 | `/tmp/82tn-beads/review4-82tn18.md` | Byte-identical copy of [S14](#s14); no additional finding. |
| <a id="s38"></a>S38 | conduit-test-82tn.27.2, round 4 | `/tmp/82tn-beads/review4-82tn27-2.md` | Byte-identical copy of [S15](#s15); no additional finding. |
| <a id="s39"></a>S39 | conduit-test-82tn.27.3, round 4 | `/tmp/82tn-beads/review4-82tn27-3.md` | Byte-identical copy of [S16](#s16); no additional finding. |
| <a id="s40"></a>S40 | conduit-test-82tn.10.4, round 5 | `/tmp/82tn-beads/review5-82tn10-4.md` | Byte-identical copy of [S17](#s17); no additional finding. |
| <a id="s41"></a>S41 | conduit-test-82tn.10.4, round 6 | `/tmp/82tn-beads/review6-82tn10-4.md` | Byte-identical copy of [S20](#s20); no additional finding. |
| <a id="s42"></a>S42 | conduit-test-82tn.10.4, round 7 | `/tmp/82tn-beads/review7-82tn10-4.md` | Byte-identical copy of [S22](#s22); no additional finding. |
| <a id="s43"></a>S43 | conduit-test-82tn.24, unnamed review cDsH8b, sequence 04 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.cDsH8b/report.md` | RL-006, RL-009, RL-013, RL-014, RL-015 |
| <a id="s44"></a>S44 | conduit-test-82tn.24, unnamed review d2lfPR, sequence 11 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.d2lfPR/report.md` | RL-044 |
| <a id="s45"></a>S45 | conduit-test-82tn.24, unnamed review DRhABF, sequence 21 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.DRhABF/report.md` | No additional material finding. |
| <a id="s46"></a>S46 | conduit-test-82tn.31.5, unnamed review fUtLRc, sequence 22 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.fUtLRc/report.md` | RL-064, RL-065 |
| <a id="s47"></a>S47 | conduit-test-82tn.24, unnamed review G8uCBg, sequence 02 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.G8uCBg/report.md` | RL-004, RL-005, RL-006, RL-007, RL-008 |
| <a id="s48"></a>S48 | conduit-test-82tn.24, unnamed review GdtD61, sequence 20 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.GdtD61/report.md` | RL-063 |
| <a id="s49"></a>S49 | conduit-test-82tn.24, unnamed review jM83ei, sequence 03 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.jM83ei/report.md` | RL-009, RL-010, RL-011, RL-012 |
| <a id="s50"></a>S50 | conduit-test-82tn.24, unnamed review JeQLBq, sequence 07 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.JeQLBq/report.md` | RL-020, RL-024, RL-025, RL-026 |
| <a id="s51"></a>S51 | conduit-test-82tn.24, unnamed review KZXhSw, sequence 15 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.KZXhSw/report.md` | No additional material finding. |
| <a id="s52"></a>S52 | conduit-test-82tn.24, unnamed review Lrt7U5, sequence 01 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.Lrt7U5/report.md` | RL-001, RL-002, RL-003 |
| <a id="s53"></a>S53 | conduit-test-82tn.27.1, unnamed review MDwx40, sequence 23 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.MDwx40/report.md` | RL-066, RL-115 |
| <a id="s54"></a>S54 | conduit-test-82tn.24, unnamed review mhYjaU, sequence 08 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.mhYjaU/report.md` | RL-027, RL-028, RL-029, RL-030 |
| <a id="s55"></a>S55 | conduit-test-82tn.24, unnamed review n1WLLq, sequence 19 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.n1WLLq/report.md` | RL-061, RL-062, RL-113 |
| <a id="s56"></a>S56 | conduit-test-82tn.24, unnamed review NTYy74, sequence 06 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.NTYy74/report.md` | RL-019, RL-020, RL-021, RL-022, RL-023 |
| <a id="s57"></a>S57 | conduit-test-82tn.24, unnamed review OuXahP, sequence 09 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.OuXahP/report.md` | RL-031, RL-032, RL-033, RL-034, RL-035, RL-036, RL-037 |
| <a id="s58"></a>S58 | conduit-test-82tn.24, unnamed review pfY8G6, sequence 16 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.pfY8G6/report.md` | RL-054, RL-055, RL-056, RL-057, RL-114 |
| <a id="s59"></a>S59 | conduit-test-82tn.24, unnamed review pyr1mp, sequence 14 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.pyr1mp/report.md` | RL-049, RL-051, RL-052, RL-053 |
| <a id="s60"></a>S60 | conduit-test-82tn.24, unnamed review SyRa4T, sequence 10 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.SyRa4T/report.md` | RL-036, RL-038, RL-039, RL-040, RL-041, RL-042, RL-043 |
| <a id="s61"></a>S61 | conduit-test-82tn.24, unnamed review ujISeA, sequence 18 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.ujISeA/report.md` | RL-059, RL-060 |
| <a id="s62"></a>S62 | conduit-test-82tn.24, unnamed review Uapkm3, sequence 13 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.Uapkm3/report.md` | RL-047, RL-048, RL-049, RL-050 |
| <a id="s63"></a>S63 | conduit-test-82tn.24, unnamed review ypkWhw, sequence 17 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.ypkWhw/report.md` | RL-058 |
| <a id="s64"></a>S64 | conduit-test-82tn.24, unnamed review YYDjHU, sequence 12 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.YYDjHU/report.md` | RL-033, RL-045, RL-046 |
| <a id="s65"></a>S65 | conduit-test-82tn.24, unnamed review uyscWH, sequence 24 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.uyscWH/report.md` | No additional material finding. |
| <a id="s66"></a>S66 | conduit-test-82tn.24, unnamed review ZddvXM, sequence 05 | `/var/folders/w8/dy5dn1nx2pl4xn0hhtlj4ybh0000gn/T/codex-review.ZddvXM/report.md` | RL-016, RL-017, RL-018 |
| <a id="s67"></a>S67 | conduit-test-82tn.24, bead notes, updated 2026-10-21 | `/tmp/82tn-beads/82tn24-bead.txt` | RL-018, RL-019, RL-020, RL-021, RL-022, RL-023, RL-061, RL-062, RL-063, RL-067, RL-113 |

Evidence limits: S44 Task A's first-submit startup failures have unknown cause; runner load is only a hypothesis. S20's unchanged browser fixture failures are not established production findings; its reproduced inherited cumulative-total defect is retained as RL-116 despite omitted numerical details. S64 mentions a reproduced inherited fork-notice failure but supplies neither its interleaving nor its wrong outcome. That mention cannot be mapped to a distinct meaningful regression or a Run Ledger invariant from the supplied evidence, and remains an explicitly unclassifiable evidence gap. S53's deferred targeted-control crash path is retained in RL-115, with reachability limits. S59's unmeasured subscription overhead is an optional optimization, not a demonstrated failure. S58's pre-existing fallback-suffixed callback caveat is retained separately as RL-114; recoverable resume rejection is RL-058. S57 Q3.1's FIFO-removal suggestion is the remedy to RL-031, not a second failure. Clear/merge-check rounds S18, S19, S21, S23, S45, S51 and S65 add no cases. Test counts and reproduction confidence are historical report claims, not fresh verification of the redesigned system.

## Pending test discovery

- `test/unit/provider/run-ledger-decider.test.ts` matches the default `unit` project and is outside `unit-sqlite` and `guards`.
- `test/unit/persistence/run-ledger.test.ts` matches `unit-sqlite` and is explicitly excluded from the ordinary `unit` project.
- `test/integration/daemon/run-ledger.test.ts` matches `vitest.integration.config.ts` beside the process-harness suites; the default unit sweep excludes it.

All three files import only Vitest. No implementation module or future harness is imported, and no configuration inclusion or exclusion is changed.
