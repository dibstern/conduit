# Run Ledger contract (conduit-test-82tn.32)

The design contract for the Run Ledger and its amendments, moved here from a scratch
directory so tickets can cite a durable path. The documents are copied unchanged.

## Precedence

Later documents win over earlier ones:

1. `AMENDMENT-2026-10-26-SEND-SCOPE-5.md` (the Run Ledger is the one owner of a send's outcome; Q24-Q26)
2. `AMENDMENT-2026-10-26-SEND-SCOPE-4.md` (requeue, don't replay; Q23 = A)
3. `AMENDMENT-2026-10-25-SEND-SCOPE-3.md` (one admission path for every send; Q22 = A)
4. `AMENDMENT-2026-10-25-SEND-SCOPE-2.md` (the send handle owns its runner assignment; Q21 = A)
5. `AMENDMENT-2026-10-25-SEND-SCOPE.md` (per-send scopes, release leaves the authority; Q20 = A)
6. `AMENDMENT-2026-10-25-AUDIT-2.md` (audit round 2, typed states; Q19 = A)
7. `AMENDMENT-2026-10-25-AUDIT.md` (single owners, bottlenecks, deepening; Q17 = A)
8. `AMENDMENT-2026-10-25-RUNNER-AUTHORITY.md` (runner authority, durable retirement, slices R1-R5)
9. `AMENDMENT-2026-10-24-BACKGROUND-WORK.md` (background work, goals, runner lifecycle)
10. `AMENDMENT-2026-10-24-FACT-BOOK.md`
11. `AMENDMENT-2026-10-23-OUTSTANDING-WORK.md`, `RULINGS-2026-10-23-D1.md`, `RULINGS-2026-10-23.md`
12. `AMENDMENT-2026-10-23.md`
13. `CONTRACT.md`, `spec-82tn32.md`

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
