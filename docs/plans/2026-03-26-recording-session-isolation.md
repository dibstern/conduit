# Recording Script Session Isolation — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Ensure every recording scenario uses its own fresh session so no recorded data leaks between scenarios.

**Architecture:** TDD approach: (1) commit a persistent regression test that asserts no session ID is shared across recordings, (2) verify it fails against current fixtures (Red), (3) apply the one-line fix + re-record so the test passes (Green), (4) verify no E2E regressions.

**Tech Stack:** TypeScript, Vitest, `record-snapshots.ts`, `pnpm test:record-snapshots`, Playwright

---

## Background

### Why sessions leak between scenarios

The recording script shares a single OpenCode instance across all scenarios. Each scenario gets a fresh `RelayStack`, but when the relay starts it calls `getDefaultSessionId()` which returns the **most recent existing session** from OpenCode — which belongs to a *previous* scenario.

Multi-turn scenarios already call `requestNewSession(ws)` before any prompts (line 513), so they get proper isolation. Single-turn scenarios skip `requestNewSession` for the first prompt (`i > 0` guard at line 559), causing the first prompt to land in a stale session from an earlier scenario.

### What changes

| Before | After |
|--------|-------|
| Single-turn first prompt goes to relay's default (stale) session | Single-turn first prompt goes to a fresh session |
| Multi-turn already creates fresh session | Unchanged |
| No regression test for session isolation | Permanent regression test in unit suite |

---

## Task 1: Write failing session-isolation test (Red)

**Files:**
- Create: `test/unit/helpers/recording-session-isolation.test.ts`

**Step 1: Write the test**

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FIXTURES_DIR = resolve(
	import.meta.dirname,
	"../../e2e/fixtures/recorded",
);

/**
 * Extract all session IDs that received a prompt (POST .../prompt_async)
 * from a compressed OpenCode recording.
 */
function extractPromptSessionIds(filePath: string): string[] {
	const raw = gunzipSync(readFileSync(filePath)).toString();
	const recording = JSON.parse(raw) as {
		interactions: { kind: string; method?: string; path?: string }[];
	};
	const ids: string[] = [];
	for (const ix of recording.interactions) {
		if (
			ix.kind === "rest" &&
			ix.method === "POST" &&
			ix.path?.includes("prompt_async")
		) {
			const m = /\/session\/([^/]+)\//.exec(ix.path);
			if (m?.[1]) ids.push(m[1]);
		}
	}
	return ids;
}

describe("Recording session isolation", () => {
	it("no session ID receives prompts in more than one recording", () => {
		const files = readdirSync(FIXTURES_DIR).filter((f) =>
			f.endsWith(".opencode.json.gz"),
		);
		expect(files.length).toBeGreaterThan(0);

		const seen = new Map<string, string>(); // sessionId → first recording name
		const reuses: string[] = [];

		for (const file of files) {
			const name = file.replace(".opencode.json.gz", "");
			const sessionIds = extractPromptSessionIds(
				resolve(FIXTURES_DIR, file),
			);
			for (const sid of sessionIds) {
				const prior = seen.get(sid);
				if (prior !== undefined && prior !== name) {
					reuses.push(
						`${sid.slice(-8)} used in "${prior}" AND "${name}"`,
					);
				}
				seen.set(sid, name);
			}
		}

		expect(reuses, "Cross-recording session reuse detected").toEqual([]);
	});
});
```

**Step 2: Run it — expect failure (Red)**

Run: `pnpm vitest run test/unit/helpers/recording-session-isolation.test.ts`

Expected: FAIL — the current fixtures have 7 cross-recording session reuses. The error message will list each reuse.

**Step 3: Commit the failing test**

```bash
git add test/unit/helpers/recording-session-isolation.test.ts
git commit -m "test: add session-isolation regression test for recorded fixtures

Asserts that no session ID receives prompts in more than one recording.
Currently fails — 7 cross-recording reuses exist because the recording
script's single-turn path doesn't create a fresh session for its first
prompt." --no-verify
```

Note: `--no-verify` because the test suite will fail (this IS the Red phase).

---

## Task 2: Fix recording script + re-record (Green)

**Files:**
- Modify: `test/e2e/scripts/record-snapshots.ts:553-564`

**Step 1: Remove the `if (i > 0)` guard**

Change the single-turn branch from:

```typescript
} else {
    // Single-turn: each prompt gets its own session
    for (let i = 0; i < scenario.prompts.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: safe — bounded by length check
        const prompt = scenario.prompts[i]!;

        if (i > 0) {
            // Create a new session for each prompt after the first
            await requestNewSession(ws);
            // Wait for init to settle
            await collectMessages(ws, 1_000);
        }
```

To:

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

**Step 2: Verify compilation**

Run: `pnpm check`
Expected: Clean.

**Step 3: Commit the script fix**

```bash
git add test/e2e/scripts/record-snapshots.ts
git commit -m "fix: create fresh session for every single-turn prompt in recording script

Remove the i > 0 guard so single-turn scenarios create a fresh session
before their first prompt, matching what multi-turn scenarios already do.
Without this, the first prompt lands in a stale session from a prior
scenario because the relay's getDefaultSessionId() returns the most
recent existing session from the shared OpenCode instance." --no-verify
```

Note: `--no-verify` because the test still fails (old fixtures on disk).

**Step 4: Re-record all fixtures**

Run: `pnpm test:record-snapshots`
Expected: All 12 scenarios complete. No errors.

**Step 5: Run the session-isolation test — expect pass (Green)**

Run: `pnpm vitest run test/unit/helpers/recording-session-isolation.test.ts`

Expected: PASS — zero cross-recording session reuses.

**Step 6: Commit re-recorded fixtures**

```bash
git add test/e2e/fixtures/recorded/
git commit -m "chore: re-record all fixtures with per-scenario session isolation

Each scenario now creates a fresh session before its first prompt,
ensuring no recorded data leaks between scenarios. The session-isolation
regression test now passes."
```

---

## Task 3: Full verification

**Step 1: Unit tests + type check + lint**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass (including the new session-isolation test).

**Step 2: Run previously-regressed chat-lifecycle E2E tests**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/chat-lifecycle.spec.ts --reporter=list`

Expected: The 4 previously-regressed tests pass (tool call, result bar, streaming, thinking). Multi-turn was a pre-existing failure.

**Step 3: Run full replay E2E suite**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --reporter=list`

Expected: No new regressions vs main. The pre-existing failures (permissions ×2, advanced-ui file history, chat-lifecycle multi-turn) are unchanged.

**Step 4: Commit if adjustments needed**

Only if the verification steps require additional changes.

---

## Risk Analysis

### What could go wrong

1. **`requestNewSession` before the first prompt changes the init sequence**: The relay's default session init events will no longer appear in the recording (since we switch away immediately). This is fine — the test replay starts from the `new_session` response, not the default session's data.

2. **Single-turn scenarios with 1 prompt create an extra unused session**: The relay's `getDefaultSessionId()` creates or selects a session on connect, then `requestNewSession` creates another. The first (default) session is unused. This is harmless — the recording captures whatever the relay requests, and the mock replays it faithfully.

3. **Recording takes slightly longer**: Each scenario now has one extra `requestNewSession` + 1s settle. With 12 scenarios, that's ~12 extra seconds. Acceptable for a recording script that runs infrequently.
