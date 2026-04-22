# Per-Session Chat State Design — Final Audit (Loop 3)

**Plan:** `docs/plans/2026-04-19-session-chat-state-per-session-design.md` (rev 2026-04-20, Loop 3)
**Date:** 2026-04-20
**Auditors:** 4 parallel `plan-task-auditor` subagents, each covering a task group.
**Per-group reports:** `docs/plans/audits/2026-04-19-session-chat-state-per-session-design-final-group-{1..4}.md`
**Prior loops:** `…-audit.md` (Loop 1), `…-reaudit.md` (Loop 2)

## Outcome: **AUDIT PASSED**

The plan is ready for execution. Three audit loops resolved 118 distinct Amend-Plan findings and 17 Ask-User questions. The Loop 3 re-audit returned essentially clean — no new Amend findings across any task group.

### Loop 3 findings

| Group | Loop 2 findings resolved | New Amend | New Ask User | New Accept |
|-------|------------------------:|----------:|-------------:|-----------:|
| Server PR + Main Task 1 | 14 / 14 | 0 | 0 | 4 |
| Main Task 2 + Task 3 | 13 / 14 (1 Partial, informational) | 0 | 0 | 4 |
| Main Task 4 | 7 / 7 | 0 | 0 | 4 |
| Main Task 5 + 6 + 7 | 7 / 8 (1 Partial) | 0 | 1 | 3 |
| **Totals** | **41 / 43 resolved, 2 Partial** | **0** | **1** | **15** |

### The single Ask-User finding (Group 4)

**`handleSessionList` search-payload guard mechanism.** The plan specifies the diff logic for detecting removed session ids and calling `clearSessionChatState` on each. It notes the need to skip the diff on "filtered/search payloads" (so filtering the list doesn't wipe all non-matching slots). But the exact mechanism — whether the guard checks a flag on the incoming message (`isFilteredPayload`), uses a separate message type, or compares lengths heuristically — is deferred with "implementation resolves against `src/lib/handlers/session.ts:242-270` structure."

This is an implementation detail that's cheap to resolve when Main Task 6 is actually written (requires a 5-minute read of `session.ts:242-270` to see the current message shape). It is not a plan-level blocker. Classified in the skill's sense as "Ask User — requires decision" but functionally it's "Confirm at implementation time."

**Recommendation:** accept this as implementation-time resolution. Main Task 6's writer confirms the shape against the source and picks the obvious discriminator. If the current server code has no way to distinguish filtered vs unfiltered payloads, Main Task 6 adds the discriminator (the Server PR doesn't need to change because this is frontend-only wiring).

### The two Partial resolutions (informational)

- **Group 2 — Q4 cross-session messageId narrative:** `advanceTurnIfNewMessage` cross-session semantics implied by the structural per-slot design but not narrated explicitly in Task 2's text. Mechanism correct; narrative light. Not a bug.
- **Group 4 — search-payload guard mechanism:** see above.

### New Accept findings (15 total)

All informational. Examples:
- `has` trap uses `key in messages` asymmetrically vs. `ACTIVITY_KEYS.has(...)` — functionally correct.
- `set()` error message wording is slightly awkward but clear.
- F2's buffer drain reuses Task 3's drain helper — implicit, not re-stated.
- `replayBuffers` → `replayBuffer` rename (plural → singular) intentional for per-session scope.

None of these require plan changes.

## Pipeline status

```
Loop 1 (initial audit)        → 72 Amend / 9 Ask User
Loop 2 (re-audit after fix)   → 46 Amend / 8 Ask User
Loop 3 (final re-audit)       →  0 Amend / 1 Ask User (implementation detail)
```

The funnel converged. No structural rework was needed — each loop surfaced narrower, more mechanical findings. The two-tier data model was validated by every auditor and never questioned across 3 loops.

## Ready for execution

Per the `subagent-plan-audit` skill's guidance, a clean audit hands off to an execution choice. The plan is large enough (two PRs, 7 frontend commits, ~20 new tests) that I'd recommend parallel-session execution over single-session subagent-driven — but offer both below.
