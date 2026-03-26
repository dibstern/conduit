# Replay Session Alignment — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Align the recording script's session flow with E2E replay so that SSE events reference the same session ID the relay uses during Playwright tests.

**Architecture:** Restore the `if (i > 0)` guard for `requestNewSession` in the single-turn recording path. The inter-scenario session cleanup (already in place) guarantees the relay's init session is always fresh, so the first prompt can safely use it. This eliminates the extra `POST /session` call that misaligns queue consumption during replay. Re-record fixtures and verify both the session-isolation unit test and the E2E replay suite.

**Tech Stack:** TypeScript, Vitest, `record-snapshots.ts`, `pnpm test:record-snapshots`, Playwright

---

## Background

### Why E2E replay fails with the current recordings

The recording script calls `requestNewSession` before *every* prompt (including the first). This creates two sessions during each scenario: one from relay init (`POST /session` → ses_A), one from `requestNewSession` (`POST /session` → ses_B). The first prompt goes to ses_B and SSE events reference ses_B.

During Playwright replay, the relay init consumes the first `POST /session` queue entry (ses_A). But no `requestNewSession` happens (the browser UI doesn't trigger one). The first prompt goes to ses_A, but the mock emits SSE events referencing ses_B. The relay ignores events for the wrong session → nothing renders.

### What changes

| Before | After |
|--------|-------|
| `requestNewSession` before every prompt (including first) | `requestNewSession` only for prompts after the first (`i > 0`) |
| Recording has an extra `POST /session` that replay never triggers | Recording flow matches replay flow exactly |
| E2E replay tests fail (session ID mismatch) | E2E replay tests pass |
| Session isolation relies solely on `requestNewSession` | Session isolation relies on inter-scenario cleanup + `if (i > 0)` guard |

---

## Task 1: Restore the `if (i > 0)` guard

**Files:**
- Modify: `test/e2e/scripts/record-snapshots.ts:553-574`

**Step 1: Restore the guard**

Change the single-turn branch from:

```typescript
} else {
    // Single-turn: each prompt gets its own session
    for (let i = 0; i < scenario.prompts.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
        const prompt = scenario.prompts[i]!;

        // Create a new session for every prompt (including the first)
        // so recordings never inherit a stale session from a prior scenario
        await requestNewSession(ws);
        await collectMessages(ws, 1_000);
```

To:

```typescript
} else {
    // Single-turn: each prompt gets its own session
    for (let i = 0; i < scenario.prompts.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
        const prompt = scenario.prompts[i]!;

        if (i > 0) {
            // Create a new session for each prompt after the first.
            // The first prompt uses the relay's init session, which is
            // guaranteed fresh by inter-scenario session cleanup.
            await requestNewSession(ws);
            await collectMessages(ws, 1_000);
        }
```

**Step 2: Verify compilation**

Run: `pnpm check`
Expected: Clean.

**Step 3: Commit**

```bash
git add test/e2e/scripts/record-snapshots.ts
git commit -m "fix: restore if (i > 0) guard for requestNewSession in recording script

The first prompt in single-turn scenarios now uses the relay's init
session instead of creating an extra session via requestNewSession.
Inter-scenario session cleanup ensures the init session is always fresh.

This aligns recording flow with E2E replay flow: during replay, no
requestNewSession happens (the browser uses the relay's default session),
so the recording must match." --no-verify
```

Note: `--no-verify` because fixtures are stale until re-recorded.

---

## Task 2: Re-record and verify

**Step 0: Remove stale fixture files**

Remove any `.opencode.json.gz` or `.json` files in `test/e2e/fixtures/recorded/` that don't correspond to a current scenario (e.g. `chat-code-block.opencode.json.gz` from a removed scenario). Stale files confuse the session-isolation test.

Run: `ls test/e2e/fixtures/recorded/` and cross-reference against the scenario list in `record-snapshots.ts`.

**Step 1: Re-record all fixtures**

Run: `pnpm test:record-snapshots`
Expected: All 12 scenarios complete. No errors.

Use a long timeout (600000ms).

**Step 2: Run the session-isolation unit test**

Run: `pnpm vitest run test/unit/helpers/recording-session-isolation.test.ts`
Expected: PASS — each scenario uses the relay's unique init session, no cross-recording reuse.

**Step 3: Commit re-recorded fixtures**

```bash
git add test/e2e/fixtures/recorded/
git commit -m "chore: re-record fixtures with aligned session flow

First prompt in single-turn scenarios now uses the relay's init session.
Combined with inter-scenario session cleanup, recordings are both
isolated and aligned with the E2E replay flow."
```

---

## Task 3: Full verification

**Step 1: Unit tests + type check + lint**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass.

**Step 2: Chat-lifecycle E2E tests**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/chat-lifecycle.spec.ts --reporter=list`

Expected: The 4 previously-passing tests pass (tool call, result bar, streaming, thinking). Multi-turn is a pre-existing failure.

**Step 3: Full replay E2E suite**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --reporter=list`

Expected: No new regressions vs main. Pre-existing failures (unchanged): permissions x2, advanced-ui file history, chat-lifecycle multi-turn.

---

## Risk Analysis

1. **Session isolation with `if (i > 0)` guard**: Safe because inter-scenario cleanup deletes all sessions. The relay's init `POST /session` creates a fresh, unique session ID per scenario. The session-isolation test will verify this.

2. **Multi-turn scenarios unaffected**: They already call `requestNewSession` unconditionally before the prompt loop (line 513), which is correct — multi-turn uses a single session for all prompts within a scenario.

3. **Single-turn scenarios with multiple prompts**: Prompts 2..N still create fresh sessions via `requestNewSession`. Only the first prompt uses the relay's init session.
