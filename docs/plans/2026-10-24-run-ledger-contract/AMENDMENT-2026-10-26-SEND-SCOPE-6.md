# Amendment 2026-10-26: the runner's journal answers what happened to a send (Q27 = A)

Approved 2026-10-26. This file wins over every other file in this folder, including
`AMENDMENT-2026-10-26-SEND-SCOPE-5.md` (SEND-SCOPE-5). It replaces SEND-SCOPE-4 S7's
"settle every `running` send from the hello" with S10 below. No user-visible behaviour
changes beyond SEND-SCOPE-5 S9.3.

## Why

Three review rounds in a row on R2 phase 1 (32.17) found material bugs in one place: after
a runner reconnects, the daemon decided from the hello whether each `running` send was
held, finished or never received. Each finding was another hello field whose meaning
differed from what recovery assumed:

| round | finding |
|---|---|
| 1 | main-built runner reports completions without an attempt and keeps historical bindings |
| 1 | main-built journal accepts the fallback only at the same attempt |
| 2 | main-built `sendCommands` lists every retained journal key, finished or not |
| 3 | main-built bindings keyed by input id when the outbox command id differs |
| 3 | current-build host lists keys inherited from its predecessor as held |

Only the runner's send journal knows whether a send is running, finished or absent. The
hello is a lossy summary of it, and S7 made the daemon reconstruct the journal from that
summary. Main never had to: it replayed the same key and the journal answered.

## S10. The journal answers; the daemon classifies nothing

### S10.1 Current-build runners

- The runner reports, for every send its journal retains, one explicit answer computed by
  the journal from its own records: `running` (a call in this process owns it),
  `finished` (attempt, fallback flag, result or failure), or `uncertain` (a retained
  record with no finished outcome and no owning call, for example one inherited from a
  predecessor host). Keys are the outbox command id and attempt, never the input id.
- A send the journal has no record of is `absent`.
- The daemon maps each answer without inference: `running` is adopted; `finished` settles
  through the existing reply settlement; `uncertain` ends as `delivery_unknown`
  (`runner_send_uncertain`, never re-sent, as main's journal does); `absent` is requeued
  (SEND-SCOPE-4 S7, compare-and-set on attempt).
- This is the runner side of the Run Ledger's `probe` effect: in SEND-SCOPE-5 S9.1 terms,
  `running` is `probe_result input_present`, `absent` is `input_absent`, `finished` is
  `effect_outcome`/`result`, `uncertain` is `effect_outcome delivery_unknown`. The ledger
  chain (32.6, 32.14) reuses this answer rather than building another.

### S10.2 Runners started by a main build

- A runner without the S10.1 capability gets main's own recovery for its sends: replay the
  same key, and main's journal returns the saved result, refuses an unfinished key as
  uncertain, or runs a send it never received. That behaviour is main's by definition,
  so it meets the "no worse than main" bar (SEND-SCOPE-5 S8).
- That path lives in one module, selected by the capability check alone, and no other
  code reads legacy hello fields. It is deleted once no main-built runner can still be
  alive (tracked on 32.13).
- The hello normalizer from the third fix round is deleted.

## Tests

Through the provider instance's and the reactor's interfaces on real SQLite:

- current build: one test per answer (`running`, `finished`, `uncertain`, `absent`),
  including a key inherited from a predecessor host and a fallback send;
- main build: the five round 1-3 cases, each against main's journal semantics, settle the
  same way main does and unblock the next send;
- every earlier R2 fix-round test that still describes current-build behaviour stays
  green; tests of the deleted normalizer are rewritten to the cases above or deleted.

## Prior art

Evidence: `~/src/personal/conduit-competitors`, revisions as in SEND-SCOPE-5.

t3code re-derives recovery state in `ProviderRuntimeRecoveryService` and has repair commits
there (725ada6eaa, 30fd973de3). paseo never replays and marks unconfirmed requests "outcome
unknown". diri keeps the first committed terminal per task. Conduit asks the component that
holds the record, as diri does, and keeps main's replay only for runners that cannot
answer.

## Decisions

Q27 = A: the journal answers per send; main-built runners get main's recovery in one
module, deleted later; the normalizer goes.
