# Audit Synthesis: Effect.ts Migration Follow-Up Plan

**Plan:** `docs/plans/2026-04-24-effect-ts-migration-followup.md`
**Auditors dispatched:** 14 (Tasks 1-14)
**Date:** 2026-04-24

---

## Amend Plan (11)

### Task 2 — F1: Existing comment conflicts with new comment
**Category:** Implicit Assumptions
File `src/lib/frontend/transport/runtime.ts` already has a comment on lines 20-21 explaining `TransportLayer = Layer.empty` referencing "Task 7.2" from a prior plan. Plan says "add comment after" but doesn't mention the existing comment — result would be two overlapping comment blocks.
**Fix:** Amend Step 1 to say "Replace the existing comment on lines 20-21 with the new three-line comment" (existing references stale task number).

### Task 4 — F1: 5xx behavioral change breaks SDK callers
**Category:** Incorrect Code / Fragile Code
Old `createRetryFetch` resolves with the 5xx Response (caller checks `response.ok`). New `fetchWithRetry` via Effect rejects with `OpenCodeConnectionError` on 5xx after retry exhaustion. SDK internals that check `response.status >= 500` will never see the Response — they get a rejection instead.
**Fix:** Amend Task 3's `fetchWithRetry` to NOT fail on 5xx after retries exhausted — return the Response so callers can inspect status. Only fail on network errors and timeouts. Alternatively, add a `failOn5xx: boolean` option (default false for SDK compat).

### Task 5 — F1: `cause` field in Schema fields conflicts with plan note
**Category:** Incorrect Code
Plan Step 3 code includes `cause: Schema.optionalWith(Schema.Unknown, { default: () => undefined })` in `RelayErrorFields`. But the plan's own note at line 746 says "The `cause` field should NOT be in the Schema fields." The code contradicts the note. Having `cause` in Schema fields means it gets Schema-validated AND passed to `Error` constructor — double-handling.
**Fix:** Remove `cause` from `RelayErrorFields`. Pass cause via constructor's `{ cause }` option inherited from Error base class, not as a Schema-validated field.

### Task 5 — F2: Plan shows two conflicting patterns (mixin + inline)
**Category:** Incorrect Code
Plan defines a `relayErrorMethods()` mixin function (lines 583-617) but then each error class has ALL methods inlined (lines 625-710). The mixin is dead code in the plan.
**Fix:** Pick one pattern. Recommend inline methods (simpler, no indirection). Delete the `relayErrorMethods` function from the plan.

### Task 5 — F3: `fromCaught` loses original code information
**Category:** Fragile Code
Old `fromCaught(err, "INIT_FAILED")` preserved the code string. New version maps to error class via `CODE_TO_CLASS` lookup — but `.code` now returns `_tag` (e.g., `"OpenCodeConnectionError"` not `"INIT_FAILED"`). The original code string is lost entirely. Callers that log or display the code will see different values.
**Fix:** Add `originalCode` field to `RelayErrorFields` schema. Populate it from `fromCaught`'s `code` parameter. Keep `.code` as `_tag` for Effect compat, but preserve the original for debugging/logging.

### Task 6 — F1: Message format change loses `[CODE]` prefix
**Category:** Implicit Assumptions
Current `PersistenceError` constructor does `super(\`[${props.code}] ${props.message}\`)` — prepending code to message. Plan's `Schema.TaggedError` version stores raw message without prefix. Log output changes from `[APPEND_FAILED] disk full` to just `disk full`.
**Fix:** Either (a) add a getter `get message() { return \`[${this.code}] ${super.message}\`; }` or (b) document this as intentional behavioral change and update any log parsers/alerts that match on `[CODE]` prefix pattern.

### Task 10 — F1: `PubSub.unsafeOffer` may not exist in Effect 3.x
**Category:** Incorrect Code
Plan relies on `PubSub.unsafeOffer` for synchronous emit replacement. This API may not exist in Effect 3.21.2. The standard `PubSub.publish()` returns an `Effect` (async). If `unsafeOffer` doesn't exist, ALL 40+ emit sites need a different pattern.
**Fix:** Verify `PubSub.unsafeOffer` exists in Effect 3.21.2. If not, alternative approaches: (a) use `Effect.runSync(PubSub.publish(...))` if publish is synchronous under bounded PubSub, (b) use `Queue` instead of `PubSub` for synchronous offer, or (c) keep a thin EventEmitter wrapper that publishes to PubSub asynchronously. Amend Task 10 with the verified API.

### Task 12 — F1: Double-provides DaemonLive layer
**Category:** Incorrect Code
Plan Step 3 code shows `Effect.provide(startupEffects, makeDaemonLive(options))` then later `Effect.provide(makeDaemonLive(options))` again on the outer pipe. This constructs DaemonLive twice (Layer memoization only works within a single `Layer.provide` call, not across separate `Effect.provide` calls).
**Fix:** Provide `makeDaemonLive(options)` once. Move `startupEffects` inside the main `Effect.gen` block so it shares the same provided context.

### Task 13 — F1: SessionOverrides and RelayTimers may not be migrated
**Category:** Missing Wiring
Plan says to verify ALL `implements Drainable` services are migrated before deleting ServiceRegistry. Tasks 9-10 cover 11 services but the plan itself flags `SessionOverrides` and `RelayTimers` as potentially unmigrated. If these still implement Drainable and register with ServiceRegistry, deleting ServiceRegistry breaks their lifecycle.
**Fix:** Add a pre-check step to Task 13: `grep -rn "implements Drainable" src/` and ensure every match is covered by Tasks 9-10. If SessionOverrides/RelayTimers are not covered, either (a) add them to Task 9/10 or (b) add a Task 13a to migrate them before deletion.

### Task 14 — F1: Test file imports deleted `createSdkClient`
**Category:** Missing Wiring
`test/unit/instance/sdk-factory.test.ts` imports and uses `createSdkClient` in all 4 test cases. Deleting the export breaks this file. Plan doesn't mention it.
**Fix:** Add step to Task 14: delete `test/unit/instance/sdk-factory.test.ts` (coverage subsumed by `test/unit/effect/sdk-factory.test.ts` from Task 4).

### Task 14 — F2: Task 4's compat test imports deleted function
**Category:** Missing Wiring
Task 4 creates `test/unit/effect/sdk-factory.test.ts` with a compat test: `it("legacy createSdkClient still works for daemon compat", ...)`. This dynamically imports `createSdkClient` and will fail after Task 14 deletes it.
**Fix:** Add step to Task 14: remove the compat test case from `test/unit/effect/sdk-factory.test.ts`.

---

## Ask User (2)

### Task 10 — Q1: Sync-to-async behavioral change scope
**Category:** State Issues
EventEmitter `.emit()` is synchronous — handlers run inline before emit returns. PubSub is async — publish returns an Effect. Plan acknowledges this concern but doesn't enumerate which of the 40+ emit sites depend on synchronous handler completion. Sites where callers read state immediately after emit (assuming handler already fired) will silently break.
**Question:** Should Task 10 be split into (a) services where sync delivery is NOT required (fire-and-forget events like status updates) and (b) services where sync delivery IS required (lifecycle events where post-emit code depends on handler state)? Or should we keep EventEmitter for sync-critical paths and only migrate fire-and-forget events to PubSub?

### Task 14 — Q1: Task 12/14 dependency on `discoverProjects` internals
**Category:** Implicit Assumptions
Task 12 sketches `yield* discoverProjects(options)` in `startupEffects` but doesn't specify whether it rewrites `discoverProjects` internals (which contain the `createSdkClient` call). If Task 12 fully rewrites it, Task 14's Step 1 is redundant. If Task 12 only extracts the signature, Task 14 is the right place but needs more prescriptive replacement code.
**Question:** Does Task 12 rewrite `discoverProjects` internals (replacing `createSdkClient` import), or does Task 12 only wrap the existing function and leave internals for Task 14?

---

## Accept (6)

### Task 1 — Line numbers may drift
Plan references specific line numbers (160-231, etc.) that may shift if prior edits happen. Acceptable — implementer should use symbol search, not line numbers.

### Task 2 — "message dispatch is sync" is imprecise
Comment could confuse readers since `Stream.async` is used. Minor — means "no async service dependencies," not that the stream itself is synchronous.

### Task 3 — Timing-based backoff test is weak
The test uses `Date.now()` elapsed time to verify backoff. Flaky on slow CI. Acceptable — better than no test, and the main assertion is on delay ordering, not exact timing.

### Task 8 — Signal handlers are process-global
Multiple test suites running in parallel could interfere with signal handler counts. Acceptable — Vitest runs tests serially by default within a file, and the Layer's finalizer cleans up.

### Task 9 — Bridge drain calls are temporary
Manual drain calls in daemon.ts `stop()` are a temporary bridge until Task 12 wires Layers. Acceptable — explicit cleanup comment in plan.

### Task 12 — Startup effects functions need creation
`probeSmartDefault`, `autoStartDefaultInstance`, `prefetchSessionCounts`, `discoverProjects` are shown as Effect functions but don't exist yet. Acceptable — Task 12 is expected to create them as part of the daemon refactor.

---

## Summary

| Action | Count |
|--------|-------|
| **Amend Plan** | 11 |
| **Ask User** | 2 |
| **Accept** | 6 |
| **Total** | 19 |

**Highest-risk tasks:** Task 5 (error wire format change), Task 10 (EventEmitter→PubSub sync/async), Task 12 (daemon rewrite).

**Handing off to plan-audit-fixer to resolve Amend Plan and Ask User findings.**

---

## Amendments Applied

| Finding | Task | Amendment |
|---------|------|-----------|
| Task 2 F1: existing comment conflict | Task 2 | Changed Step 1 from "add comment after" to "replace existing comment on lines 20-21" |
| Task 4 F1: 5xx behavioral change | Task 3 | Added `Effect.catchTag` after retry exhaustion to return last 5xx Response instead of rejecting |
| Task 5 F1: cause in Schema fields | Task 5 | Removed `cause` from RelayErrorFields, added comment to pass via constructor option |
| Task 5 F2: mixin + inline conflict | Task 5 | Deleted `relayErrorMethods` mixin function, kept inline methods on each class |
| Task 5 F3: fromCaught loses code | Task 5 | Added `originalCode` to context in `fromCaught`, documented in Step 4 |
| Task 6 F1: message format change | Task 6 | Added "Behavioral note" documenting intentional `[CODE]` prefix removal |
| Task 10 F1: PubSub.unsafeOffer + Q1 | Task 10 | Rewrote pattern: direct calls for sync-critical, PubSub.publish for broadcast. Added Step 0 classification. Removed unsafeOffer references. |
| Task 12 F1: double-provides | Task 12 | Rewrote Step 3 to provide DaemonLive once, run startup effects inside same context |
| Task 13 F1: unmigrated Drainables | Task 13 | Made Step 3 a BLOCKING pre-check — must grep and resolve before proceeding |
| Task 14 F1: test imports deleted fn | Task 14 | Added Step 3: delete test/unit/instance/sdk-factory.test.ts |
| Task 14 F2: compat test case | Task 14 | Added to Step 3: remove compat test case from effect/sdk-factory.test.ts |
| Task 14 Q1: Task 12 rewrites internals | Task 14 | Changed Step 1 from "replace" to "verify" — Task 12 fully rewrites discoverProjects |

**User decisions:**
- Task 10: Use Option 3 — direct function calls for sync-critical emit paths, PubSub for broadcast
- Task 14: Task 12 fully rewrites `discoverProjects` internals using Effect

---

## Re-Audit (Round 2)

Re-audited 7 amended tasks (2, 3, 5, 10, 12, 13, 14).

**Clean:** Tasks 2, 3 (Accept), 12, 14
**New Amend Plan findings (3):**

| Finding | Task | Amendment Applied |
|---------|------|-------------------|
| Task 5: Removing `cause` from RelayErrorFields breaks cause propagation (Schema validation strips unlisted fields) | Task 5 | Reverted: kept `cause` in RelayErrorFields with `Schema.optionalWith(Schema.Unknown)`. Updated `fromCaught` to pass cause in props, not second arg. |
| Task 13/9: SessionOverrides implements Drainable but not in Task 9 migration list | Task 9 | Added SessionOverrides to Task 9 files, Tags, constructor changes |
| Task 13/9: RelayTimers implements Drainable but no src/ instantiation sites | Task 9 | Added note: check if dormant, remove `implements Drainable` if unused |
