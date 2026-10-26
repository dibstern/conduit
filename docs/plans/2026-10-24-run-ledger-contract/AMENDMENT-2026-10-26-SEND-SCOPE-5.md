# Amendment 2026-10-26: the Run Ledger is the one owner of a send's outcome (Q24-Q26)

Approved 2026-10-26. This file wins over every other file in this folder, including
`AMENDMENT-2026-10-26-SEND-SCOPE-4.md` (SEND-SCOPE-4).

User-facing behaviour changes in one place: S9.3 (a message that never reached the agent).

## Why

After SEND-SCOPE-4, two review rounds in a row on slice R2 found material bugs. Both had
one cause: a send's outcome (`provider_command_outbox` terminal status for `send_turn`)
is decided by several writers, and each follow-up duty is attached to only some of them.

| writer | duties it ran |
|---|---|
| native projection (`settleRunCommands`) | status, receipt, payload trim; no attempt guard; also settled `pending` and `retryable_failed` rows of the run with the run's outcome |
| runner reply settlement (`settleRunnerCommandReply`) | status, receipt, provider state, draft restore (own transaction, after the outcome), steer requeue |
| hello settlement and requeue | status |
| reactor (claim, refusal, `delivery_indeterminate`) | status, failed message |
| Claude preparation | `$.nativeResumeFallback` marker that recovery read as proof the fallback ran |

There were three copies of the retry backoff, and provider state was saved twice.

Every competitor surveyed guards the status so the first writer wins, and none ties the
duties to the winning transition; each has repair commits exactly there (Prior art).

The Run Ledger (`CONTRACT.md`, glossary: Run Effect, Send Token, Run Ledger) is already
designed to be the sole owner of Run Effects and their outcomes. An interim owner would
duplicate its rules and be deleted by 32.13.

## S8. No interim owner: the ledger chain owns it

- R1 (32.16) and R2 phase 1 (32.17) land after one more review, judged against the bar
  **no worse than main**. Findings that exist only because several writers still decide
  an outcome, and that main also has, are recorded for the ledger chain, not fixed in R2.
- The Run Ledger chain (32.2.x decider, 32.3 SQLite ledger, 32.6 and 32.7 Claude send,
  run end and steering, 32.13 deletion, 32.14 crash matrix) is the single owner of every
  Run Effect's outcome, for sends and control effects alike.
- S9 is the approved design for that owner. Each ledger ticket implements its part.

## S9. Rules the ledger must implement

### S9.1 One decision, guarded by the Send Token

- Every outcome is decided by the ledger's `decide` from one piece of evidence and the
  session state; a Send Token that is no longer live changes nothing (already in
  `CONTRACT.md`). Until 32.13, the token's stored form is the outbox row's request
  sequence plus attempt; the runner's `sinkId` is its form on the wire.
- Starting an effect (today's claim: pick the next eligible row, wait behind an earlier or
  `delivery_unknown` send, apply the retry cap, bind the run, mint the next token) is part
  of the same owner. The wait-behind rule exists once.
- Evidence maps onto the existing model:

  | today's evidence | ledger input |
  |---|---|
  | native terminal | `observe` `result` |
  | runner reply | `observe` `effect_outcome` or `result` |
  | hello: runner holds it | adoption (unchanged) |
  | hello: runner never got it; `not_received` | `observe` `probe_result` `input_absent` |
  | delivery unknown | `observe` `effect_outcome` `delivery_unknown` |
  | native resume rejected | **new**: `effect_outcome` `permanent` with code `native_resume_rejected` (S9.4) |
  | daemon refusal (project inactive, admission timeout) | `settle` `project_inactive`, or `effect_outcome` `permanent` |
  | Stop | `control` `stop` / `cancel_input` |
  | runner lost | `settle` `process_lost` |

- During projection replay (`ctx.replaying`), nothing settles an outcome.

### S9.2 Duties are committed with the decision

The decision's events and effects carry every duty, and the interpreter commits them in
one SQLite transaction with the status change, in a fixed order: receipt, payload trim,
provider state (once, on success), cleared native cursor, input back to the inbox, failed
message placement, draft restore, transition record. Only notifications (wake the
reactor, drain the inbox, push the restored draft) happen after the commit, and every
consumer rescans on startup, so a lost notification costs latency only. Draft restore no
longer runs in its own transaction.

### S9.3 A message that never reached the agent (Q25 = E)

When a Run ends, or a runner reconnects, and an input's send provably never reached the
agent and the user did not press Stop, the send is re-sent automatically, up to the
retry cap. Otherwise it ends `failed` or `cancelled`, the failed message is shown once and
its text returns to the composer. A Steer whose Run is still active is re-sent as a
steer; a Steer whose Run has ended returns to the inbox as the next message, with no error
shown. Uncertain delivery (`delivery_unknown`) is never re-sent. This replaces the native
projection settling undelivered sends with the Run's outcome.

### S9.4 The native-resume fallback is a new transmission

A rejected native resume ends that transmission. The next transmission (new Send Token)
starts a fresh native session and clears the stale cursor; the `start` effect carries
which kind it is. A rejection of the fresh transmission itself is terminal and visible.
No payload marker decides the outcome.

### S9.5 Retries

- One backoff function (1 s, 2 s, 4 s, 8 s, capped at 30 s) and one retry cap of 5
  transmissions, shared by sends and control effects.
- A re-send after `input_absent` goes out immediately but counts toward the cap. Past
  the cap: failed, message shown once, text back in the composer.

### S9.6 After any failure

Every running effect has exactly one owner: an adopted send, a live call in this daemon,
or the `delivery_unknown` rule. A failed commit rolls back the status and every duty
together, and each evidence source delivers again (event store, runner cache, hello
reconnect, `recover` at startup). Legacy rows are converted once at startup: old
`$.nativeResumeFallback` markers, and `steering` inputs left behind by older builds.

## Tests

- **Event-order test.** Through the ledger's public interface on real SQLite, enumerate
  every ordering of up to six events for a session with one send and one steer: claim,
  native terminal, reply (current, old and attemptless attempt), hello (holds, completed,
  unknown), restart, Stop, refusal, runner lost, native resume rejected. Check
  invariants, not a second copy of the rules: one terminal per effect and one settlement
  per token; no running effect without an owner; an input returns to the inbox at most
  once and only if never shown; a draft is restored at most once and only if the message
  was never shown; receipts match the final status; at most 5 transmissions; a later
  send never starts before an earlier one settles. Each run writes a report artifact
  with the smallest failing sequence. List the failure modes before writing code.
- **End to end**, with the real process runner: restart mid-send, a steer that arrives
  as the Run ends, the fallback after a restart. SEND-SCOPE-4's tests and R2's fix-round
  tests stay, through the provider instance and the reactor.
- **Boundary.** After 32.13, a test fails if anything but the ledger's interpreter writes
  an effect's status.

## Prior art

Evidence: `~/src/personal/conduit-competitors`, surveyed 2026-10-26.

| competitor | revision | how a send's outcome is recorded |
|---|---|---|
| t3code | main@2026-10-25 b6c326d12f | one guarded write on run, attempt and status, with effects (`EventSink.writeIfRunCurrent`, `S/EventSink.ts:95`, `:459`; race test `FoundationPersistence.test.ts:1523`); still several outcome writers (`RunExecutionService.ts:612`, `ProviderTurnStartService.ts:316`, `Orchestrator.ts:9210`, `:10132`, `ProviderRuntimeRecoveryService.ts:351`); duties partly with callers; repairs 725ada6eaa, 801dbf6b84, a7a2230c33, 30fd973de3 |
| bb | 3a2c49a267 | legal-transition table with explicit no-op reasons, no request id; duties with callers; repairs 6f21bdeb4, 4ae86eddb, bddf68d26 |
| zeron | 255c540d65 | one driver, about eight side branches, unconditional status set; repairs 27480d99, aaeede8b, 2e151ca6 |
| diri | e280a76d3f | first committed terminal wins, a conflict returns a typed error (`tasks.rs:163`, `:213`); tasks only |
| paseo | d0fd2e5320 | central stream terminals; pending requests become "outcome unknown"; never replays |
| monocode | 26465c6209 | no owner; duties spread across the app; repair 8385b121 |
| capy | docs 2026-10-25T23:20:08Z | pending messages recalled to the composer |

Conduit takes t3code's guarded write with effects committed alongside, bb's explicit
no-op reasons, diri's first committed terminal wins, and capy's recall to the composer.
It differs on purpose: duties come from the winning transition, never from callers; the
owner is the only writer, enforced by a test; every event order is checked rather than
one hand-written race; the fallback is a new transmission, not a marker.

## Decisions

Q24 = A+J+K+L+M+N+Q (one owner for every effect outcome, commit-only, fallback as a new
transmission, duties as data in the same transaction, exhaustive event-order test).
Q25 = E (S9.3). Claim placement = B (starting is part of the owner). Q26 = C: the Run
Ledger is that owner; R1 and R2 land first (S8).
