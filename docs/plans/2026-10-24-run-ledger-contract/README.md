# Run Ledger contract (conduit-test-82tn.32)

`CONTRACT.md` is the single authority for the Run Ledger and the runner work around it. It
states the contract as it stands today, consolidated on 2026-10-28 from every document below.
Tickets cite `CONTRACT.md`.

The amendments, rulings and the spec stay in this folder unchanged, as history. Where any of
them differs from `CONTRACT.md`, `CONTRACT.md` wins. Each section of `CONTRACT.md` names the
source documents and sections it came from in a hidden comment, and its Appendix B maps old ids
(failure modes, invariants, S-, A-, T-, R- and C-numbers) to their new places.

The seven questions the sources did not settle (OPEN-1 to OPEN-7) were decided on 2026-10-28.
Section 13 lists them; the decisions live in the cited sections, with the reasons in Appendix A.9.

## History

The documents were moved here from a scratch directory so tickets could cite a durable path.
Before consolidation, later documents won over earlier ones in this order:

1. `AMENDMENT-2026-10-28-SEND-SETTLEMENT.md` (the run record answers every send question: `holdRun` returns every domain answer as a value and the feeder keeps no retry loop, one Send Settlement module ends a runner-held send, the reconciler retries a failed Stop commit; decided autonomously after three review rounds, T + U + V)
2. `AMENDMENT-2026-10-28-SEND-CONTINUATION.md` (a waiting send continues only through `holdRun`: the Run Ledger answers Stop coverage, the hold, committed before transmission and cleared only by evidence, answers delivery; decided autonomously after three review rounds, C + J + K)
3. `AMENDMENT-2026-10-28-RUNNER-SWAP.md` (a runner swap is prepare, one commit, promote; the database names each session's serving runner; the runner's role is one typed state; Q33 = A + E + M)
4. `AMENDMENT-2026-10-27-STOP-INTENT.md` (Stop is a durable intent carried out by one reconciler, with a typed stop state; the run record names its holder; Q30 = A with C inside, Q31 = C)
5. `AMENDMENT-2026-10-27-RUNNER-REAPER.md` (one durable owner for a stopped runner's processes: a reaper per runner, write-ahead retirement; Q28 = A + C)
6. `AMENDMENT-2026-10-26-SEND-SCOPE-6.md` (the runner's journal answers what happened to a send; Q27 = A)
7. `AMENDMENT-2026-10-26-SEND-SCOPE-5.md` (the Run Ledger is the one owner of a send's outcome; Q24-Q26)
8. `AMENDMENT-2026-10-26-SEND-SCOPE-4.md` (requeue, don't replay; Q23 = A)
9. `AMENDMENT-2026-10-25-SEND-SCOPE-3.md` (one admission path for every send; Q22 = A)
10. `AMENDMENT-2026-10-25-SEND-SCOPE-2.md` (the send handle owns its runner assignment; Q21 = A)
11. `AMENDMENT-2026-10-25-SEND-SCOPE.md` (per-send scopes, release leaves the authority; Q20 = A)
12. `AMENDMENT-2026-10-25-AUDIT-2.md` (audit round 2, typed states; Q19 = A)
13. `AMENDMENT-2026-10-25-AUDIT.md` (single owners, bottlenecks, deepening; Q17 = A)
14. `AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md` (runner authority, durable retirement, slices R1-R5)
15. `AMENDMENT-2026-10-24-BACKGROUND-WORK.md` (background work, goals, runner lifecycle)
16. `AMENDMENT-2026-10-24-FACT-BOOK.md`
17. `AMENDMENT-2026-10-23-OUTSTANDING-WORK.md`, `RULINGS-2026-10-23-D1.md`, `RULINGS-2026-10-23.md`
18. `AMENDMENT-2026-10-23.md`
19. The 2026-10-23 `CONTRACT.md` (now replaced; see git history before this consolidation), `spec-82tn32.md`

## Renamed files

The TypeScript sketches carry a `.txt` suffix so the linter and type checker skip them.
The documents still cite them by their original names:

| Cited as | File here |
|---|---|
| `run-ledger-model.ts` | `run-ledger-model.ts.txt` |
| `run-ledger-model.pre-hlk.ts` | `run-ledger-model.pre-hlk.ts.txt` |
| `run-ledger-decider.stub.ts` | `run-ledger-decider.stub.ts.txt` |

## Evidence

Paths under `/tmp/82tn-beads/` cited as evidence (probe findings, surveys, review
reports) were working notes and are not kept in the repo.
