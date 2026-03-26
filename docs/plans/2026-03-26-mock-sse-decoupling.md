# Mock SSE/REST Decoupling Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Decouple SSE event delivery from REST queue consumption in MockOpenCodeServer so that E2E tests reliably receive all SSE events regardless of the relay's REST polling pattern.

**Architecture:** Replace the current "SSE batch attached to REST entry" model with a prompt-segmented SSE timeline. REST queues serve responses only. SSE events are collected into segments delimited by `prompt_async` boundaries and emitted independently when each prompt fires. This restores the original design intent documented in `docs/plans/2026-03-12-mock-opencode-server-design.md` (lines 108, 123).

**Tech Stack:** TypeScript, Node.js `http.createServer`, Vitest, Playwright

---

## Background

### Root cause (investigated and confirmed via E2E trace analysis)

The `MockOpenCodeServer.buildQueues()` method attaches SSE events to the REST entry that precedes them in the recording timeline. SSE events only emit when their associated REST entry is consumed by the relay. After `prompt_async`, the relay's monitoring reducer may enter `busy-sse-covered` state (because early SSE events DO flow via status poll consumption), which suppresses REST message polling. But remaining SSE events -- including `permission.asked`, `message.part.delta`, and `session.idle` -- are attached to `GET /session/:id/message` REST entries that the relay will never consume.

This creates a vicious cycle: some SSE events flow -> relay suppresses REST polling -> remaining SSE events (on unconsumed REST entries) never fire -> incomplete SSE coverage.

### Affected tests (6 failures, all same root cause)

| Spec | Test | Recording | Symptom |
|------|------|-----------|---------|
| permissions.spec.ts | "permission card appears when agent uses a tool" | advanced-diff | `perm.waitForCard()` timeout -- `permission.asked` SSE never delivered |
| permissions.spec.ts | "permission card structure has expected elements" | advanced-diff | Same |
| advanced-ui.spec.ts | "diff toggle buttons appear on tool blocks with diffs" | advanced-diff | `perm.waitForCard()` timeout (test depends on permission flow) |
| advanced-ui.spec.ts | "clicking split toggle switches diff view" | advanced-diff | Same |
| advanced-ui.spec.ts | "file history panel structure is correct when present" | advanced-diff | Same |
| chat-lifecycle.spec.ts | "multi-turn conversation renders correctly" | chat-multi-turn | `assistantMessages` never appears -- `message.part.delta` SSE never delivered |

### Why the fix belongs in the mock

The relay's behavior is correct -- it suppresses unnecessary REST polling when SSE events are flowing. The bug is that the mock couples SSE delivery to REST consumption, which doesn't match real OpenCode. Real OpenCode pushes SSE events independently of REST polling.

### Design decision: Full decoupling (Option A)

Pre-prompt SSE coupling was evaluated but rejected: it adds fragility to init-time behavior if the relay's REST sequence changes. Full decoupling is simpler, more durable, and aligns with the original design doc's intent. The only synchronization point is `prompt_async`, which is a fundamental protocol boundary.

---

## Task 1: Add SSE segment data structures and refactor buildQueues

> **Note:** Task 1 and Task 2 form a single atomic change. Do NOT commit after Task 1 —
> removing `sseBatch` from `QueuedRestResponse` breaks compilation until Task 2 updates
> all remaining references. The commit happens at the end of Task 2.

**Files:**
- Modify: `test/helpers/mock-opencode-server.ts:20-32` (types)
- Modify: `test/helpers/mock-opencode-server.ts:69-117` (class fields)
- Modify: `test/helpers/mock-opencode-server.ts:309-421` (buildQueues)

**Step 1: Write the failing unit test**

Add a new test to `test/unit/helpers/mock-opencode-server.test.ts` that verifies SSE events are emitted based on prompt boundaries, NOT REST consumption:

```typescript
it("emits post-prompt SSE events independently of REST consumption", async () => {
	// Connect SSE
	const controller = new AbortController();
	const sseRes = await fetch(`${mock.url}/event`, {
		signal: controller.signal,
		headers: { Accept: "text/event-stream" },
	});

	const events: Array<{ type: string }> = [];
	const collecting = collectSseEvents(sseRes.body?.getReader(), events);

	await new Promise((r) => setTimeout(r, 50));

	// Fire prompt_async — should trigger SSE emission WITHOUT consuming
	// any other REST entries (like GET /session/status or GET /session/:id/message)
	await fetch(`${mock.url}/session/ses_1/prompt_async`, {
		method: "POST",
		body: "{}",
	});

	// Wait for SSE events to arrive
	await new Promise((r) => setTimeout(r, 200));
	controller.abort();
	await collecting;

	// Should have server.connected + all 5 post-prompt SSE events
	// (the FIXTURE has 5 SSE events after prompt_async — 3 before
	// the permission reply REST entry + 2 after it — all in segment 1
	// since permission reply is NOT a prompt boundary)
	const batchEvents = events.filter((e) => e.type !== "server.connected");
	expect(batchEvents.length).toBe(5);
	expect(batchEvents[0]).toMatchObject({ type: "session.status" });   // busy
	expect(batchEvents[1]).toMatchObject({ type: "message.part.delta" }); // hello
	expect(batchEvents[2]).toMatchObject({ type: "session.status" });   // idle
	expect(batchEvents[3]).toMatchObject({ type: "message.part.delta" }); // world
	expect(batchEvents[4]).toMatchObject({ type: "session.status" });   // idle
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: FAIL — under current implementation, SSE events only emit when REST entries are consumed.

**Step 3: Modify types and class fields**

Remove `sseBatch` from `QueuedRestResponse` and add the SSE segment model:

In `test/helpers/mock-opencode-server.ts`, change the `QueuedRestResponse` interface:

```typescript
/** A queued REST response (SSE delivery is decoupled — see sseSegments). */
interface QueuedRestResponse {
	status: number;
	responseBody: unknown;
}
```

Add new fields to the `MockOpenCodeServer` class (after line 117):

```typescript
/**
 * SSE events organized by prompt_async boundaries.
 * Index 0: pre-prompt events (emitted when first prompt fires).
 * Index N (N>=1): events between prompt N and prompt N+1
 *                 (emitted when prompt N fires).
 */
private sseSegments: SseEvent[][] = [[]];

/** Number of prompt_async calls consumed so far. */
private promptsFired = 0;
```

Remove these fields (they are replaced by the segment model):
- `promptFired` (line 114) → replaced by `promptsFired` counter
- `pendingSseBatches` (line 117) → replaced by `sseSegments[0]`

**Step 4: Refactor buildQueues to separate SSE from REST**

Replace the current `buildQueues()` (lines 309-421) with a version that builds REST queues and SSE segments independently:

```typescript
private buildQueues(): void {
	const { interactions } = this.recording;

	// ── SSE segment building ─────────────────────────────────
	// Segment 0 = pre-prompt events. Segment N = events after prompt N.
	this.sseSegments = [[]];
	let currentSegment = 0;

	// ── REST queue building ──────────────────────────────────
	for (const ix of interactions) {
		if (ix.kind === "rest") {
			// Detect prompt_async boundary — start new SSE segment
			if (ix.method === "POST" && ix.path.includes("/prompt_async")) {
				currentSegment++;
				this.sseSegments[currentSegment] = [];
			}

			const queued: QueuedRestResponse = {
				status: ix.status,
				responseBody: ix.responseBody,
			};

			const ek = exactKey(ix.method, ix.path);
			const nk = normalizedKey(ix.method, ix.path);

			this.pushQueue(this.exactQueues, ek, queued);
			if (nk !== ek) {
				this.pushQueue(this.normalizedQueues, nk, { ...queued });
			}
		} else if (ix.kind === "sse") {
			// All SSE events go into the current segment
			this.sseSegments[currentSegment].push({
				type: ix.type,
				properties: ix.properties,
				delayMs: ix.delayMs,
			});
		} else {
			// PTY interactions
			this.pushPty(ix);
		}
	}

	// Inject fallback responses for essential init endpoints
	this.ensureFallback("GET /path", 200, {
		home: "/tmp",
		state: "/tmp/.local/state/opencode",
		config: "/tmp/config/opencode",
		worktree: process.cwd(),
		directory: process.cwd(),
	});

	this.ensureFallback("GET /command", 200, [
		{ name: "help", description: "Show available commands" },
		{ name: "compact", description: "Compact conversation history" },
	]);
	this.ensureFallback("GET /file", 200, [
		{ name: "package.json", type: "file" },
		{ name: "src", type: "directory" },
		{ name: "test", type: "directory" },
	]);

	this.promoteTargetSession();

	const msgNormKey = "GET /session/:param/message";
	this.normalizedQueues.set(msgNormKey, [
		{ status: 200, responseBody: [] },
	]);
}
```

**Step 5: Verify compilation fails (expected)**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: Compilation errors from `sseBatch` references in `handleRequest`, `setExactResponse`,
`ensureFallback`, and `statusOverride`. This confirms Task 2 is needed to complete the refactor.
Do NOT commit yet — proceed directly to Task 2.

---

## Task 2: Add prompt-triggered SSE emission and update handleRequest

**Files:**
- Modify: `test/helpers/mock-opencode-server.ts:520-838` (handleRequest)
- Modify: `test/helpers/mock-opencode-server.ts:180-207` (reset, flushPendingSse)
- Modify: `test/helpers/mock-opencode-server.ts:886-916` (emitSseBatch)

**Step 1: Write a failing test for multi-prompt SSE segmentation**

Add to `test/unit/helpers/mock-opencode-server.test.ts`:

```typescript
it("segments SSE events by prompt boundary for multi-turn", async () => {
	// Use a multi-turn fixture
	const multiFixture: OpenCodeRecording = {
		name: "multi-turn",
		recordedAt: new Date().toISOString(),
		opencodeVersion: "1.2.6",
		interactions: [
			// Pre-prompt REST
			{ kind: "rest", method: "GET", path: "/path", status: 200, responseBody: { cwd: "/tmp" } },
			{ kind: "rest", method: "GET", path: "/session", status: 200, responseBody: [{ id: "ses_1" }] },
			// Pre-prompt SSE
			{ kind: "sse", type: "session.created", properties: {}, delayMs: 0 },
			// Prompt 1
			{ kind: "rest", method: "POST", path: "/session/ses_1/prompt_async", status: 200, responseBody: {} },
			// Turn 1 SSE
			{ kind: "sse", type: "message.part.delta", properties: { delta: "turn1" }, delayMs: 0 },
			{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
			// Prompt 2
			{ kind: "rest", method: "POST", path: "/session/ses_1/prompt_async", status: 200, responseBody: {} },
			// Turn 2 SSE
			{ kind: "sse", type: "message.part.delta", properties: { delta: "turn2" }, delayMs: 0 },
			{ kind: "sse", type: "session.idle", properties: {}, delayMs: 0 },
		],
	};

	const multiMock = new MockOpenCodeServer(multiFixture);
	await multiMock.start();

	try {
		// Connect SSE
		const controller = new AbortController();
		const sseRes = await fetch(`${multiMock.url}/event`, {
			signal: controller.signal,
			headers: { Accept: "text/event-stream" },
		});
		const events: Array<{ type: string; properties?: Record<string, unknown> }> = [];
		const collecting = collectSseEvents(sseRes.body?.getReader(), events);
		await new Promise((r) => setTimeout(r, 50));

		// Fire prompt 1 — should emit pre-prompt + turn 1 SSE
		await fetch(`${multiMock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});
		await new Promise((r) => setTimeout(r, 100));

		const afterPrompt1 = events.filter((e) => e.type !== "server.connected");
		expect(afterPrompt1).toHaveLength(3); // session.created + delta(turn1) + idle
		expect(afterPrompt1[0]).toMatchObject({ type: "session.created" });
		expect(afterPrompt1[1]).toMatchObject({ type: "message.part.delta" });
		expect(afterPrompt1[2]).toMatchObject({ type: "session.idle" });

		// Fire prompt 2 — should emit turn 2 SSE only
		await fetch(`${multiMock.url}/session/ses_1/prompt_async`, {
			method: "POST",
			body: "{}",
		});
		await new Promise((r) => setTimeout(r, 100));
		controller.abort();
		await collecting;

		const allBatch = events.filter((e) => e.type !== "server.connected");
		expect(allBatch).toHaveLength(5); // 3 from prompt 1 + 2 from prompt 2
		expect(allBatch[3]).toMatchObject({ type: "message.part.delta" });
		expect(allBatch[4]).toMatchObject({ type: "session.idle" });
	} finally {
		await multiMock.stop();
	}
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: FAIL (SSE events not emitted by prompt boundary).

**Step 3: Add `emitEvents` method**

Add a new method to `MockOpenCodeServer` that emits a list of SSE events to connected clients with capped delays. This replaces both the old `emitSseBatch` and provides segment emission:

```typescript
/**
 * Emit a list of SSE events to all connected clients.
 * Sets statusOverride if the list contains session.idle.
 */
private emitEvents(events: SseEvent[]): void {
	if (events.length === 0) return;

	// Check for session.idle — set statusOverride so GET /session/status
	// returns idle regardless of queue state.
	const hasIdle = events.some((e) => e.type === "session.idle");
	if (hasIdle) {
		this.statusOverride = { status: 200, responseBody: {} };
	}

	void (async () => {
		for (const event of events) {
			const delay = Math.min(event.delayMs, 5);
			if (delay > 0) {
				await new Promise<void>((r) => setTimeout(r, delay));
			}

			const payload = JSON.stringify({
				type: event.type,
				properties: event.properties,
			});
			const frame = `data: ${payload}\n\n`;

			for (const client of this.sseClients) {
				if (!client.writableEnded) {
					client.write(frame);
				}
			}
		}
	})();
}
```

**Step 4: Update handleRequest to emit segments on prompt_async**

In `handleRequest`, find the `prompt_async` detection block (currently lines 805-817) and replace it with segment-based emission. **Important:** concatenate segments into a single array before emitting to avoid interleaving between concurrent async IIFEs:

```typescript
// Detect prompt_async — emit the next SSE segment(s).
// First prompt: emit segment 0 (pre-prompt) + segment 1 (first turn).
// Subsequent prompts: emit segment N+1.
if (method === "POST" && path.includes("/prompt_async")) {
	this.promptsFired++;
	this.statusOverride = undefined;
	if (this.promptsFired === 1) {
		// First prompt: concatenate pre-prompt + first turn into single emission
		// to guarantee ordering (two separate emitEvents calls would interleave).
		const combined = [
			...(this.sseSegments[0] ?? []),
			...(this.sseSegments[1] ?? []),
		];
		this.emitEvents(combined);
	} else {
		// Subsequent prompts: emit this turn's segment
		const segment = this.sseSegments[this.promptsFired] ?? [];
		this.emitEvents(segment);
	}
}
```

**Step 5: Remove all sseBatch and promptFired references**

Remove every remaining reference to the old coupled model. These are the exact sites:

In `handleRequest`:
- Remove `if (entry.sseBatch.length > 0)` block after POST /session (~line 638-644). This block also references `this.promptFired` — remove entirely.
- Remove `if (entry.sseBatch.length > 0)` block after GET /session (~line 701-708). Also references `this.promptFired` — remove entirely.
- Remove `if (entry.sseBatch.length > 0)` block at end of generic handler (~line 832-838). Also references `this.promptFired` — remove entirely.

In `setExactResponse` (line 221):
- Change `{ status, responseBody, sseBatch: [] }` to `{ status, responseBody }`.

In `ensureFallback` (line 444):
- Change `{ status, responseBody, sseBatch: [] }` to `{ status, responseBody }`.

Remove the old `emitSseBatch` method entirely (lines 886-916) — replaced by `emitEvents`.

**Step 6: Update pushQueue and related helpers**

The `pushQueue` method signature and `QueuedRestResponse` no longer include `sseBatch`. Verify no remaining references exist. The `pushQueue` method itself doesn't need changes (it's generic), but callers in buildQueues already omit `sseBatch` from Task 1.

**Step 7: Update reset() and flushPendingSse()**

Replace `reset()` to use the new fields:

```typescript
reset(): void {
	this.cleanupSseClients();
	this.exactQueues.clear();
	this.normalizedQueues.clear();
	this.ptyQueues.clear();
	this.sseSegments = [[]];
	this.statusOverride = undefined;
	this.promptsFired = 0;
	this.ptyCounter = 0;
	this.dynamicPtyIds.clear();
	this.injectedSessions.clear();
	this.deletedSessionIds.clear();
	this.renamedSessions.clear();
	this.sessionCounter = 0;
	this.buildQueues();
}
```

Replace `flushPendingSse()`:

```typescript
/**
 * Force-flush all remaining SSE segments without requiring a prompt.
 * Concatenates all segments into one emission to preserve ordering.
 * Use in tests that need SSE events without sending a prompt_async.
 */
flushPendingSse(): void {
	const allEvents = this.sseSegments.flat();
	this.emitEvents(allEvents);
	this.promptsFired = this.sseSegments.length;
}
```

Update `resetQueues()` to reset segment state. Always reset `promptsFired` to 0
because it's a counter that indexes into `sseSegments` — preserving a stale
counter value after `buildQueues()` rebuilds segments would cause the next
prompt to index into a nonexistent segment. Preserve `statusOverride` so
background pollers see correct idle/busy state between tests:

```typescript
/**
 * Reset response queues without disconnecting SSE clients.
 * For multi-test reuse within a shared relay.
 *
 * Preserves `statusOverride` so that background status pollers
 * continue to see the correct idle/busy state between tests.
 * The override is cleared naturally when the next prompt_async fires.
 *
 * Always resets `promptsFired` to 0 because buildQueues rebuilds
 * sseSegments from scratch — the counter must restart to match.
 */
resetQueues(): void {
	this.exactQueues.clear();
	this.normalizedQueues.clear();
	this.ptyQueues.clear();
	this.promptsFired = 0;
	// Preserve statusOverride — cleared when next prompt_async fires
	this.ptyCounter = 0;
	this.dynamicPtyIds.clear();
	this.injectedSessions.clear();
	this.deletedSessionIds.clear();
	this.renamedSessions.clear();
	this.sessionCounter = 0;
	this.buildQueues();
}
```

**Step 8: Update statusOverride type**

`statusOverride` previously used `QueuedRestResponse` (which had `sseBatch`). Update its type to match the simplified interface:

```typescript
private statusOverride: { status: number; responseBody: unknown } | undefined;
```

**Step 9: Update injectSSEEvents (emitSseBatch is removed)**

The old `emitSseBatch` method is removed in Step 5 (replaced by `emitEvents`). `injectSSEEvents` previously called `emitSseBatch` — update it to use `emitEvents` instead:

```typescript
public injectSSEEvents(
	events: Array<{ type: string; properties: Record<string, unknown> }>,
): void {
	const batch: SseEvent[] = events.map((e) => ({
		type: e.type,
		properties: e.properties,
		delayMs: 0,
	}));
	this.emitEvents(batch);
}
```

`emitTestEvent` remains unchanged — it writes directly to SSE clients without going through `emitEvents`.

**Step 10: Run tests to verify new tests pass**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: PASS for the two new tests. Existing tests may need updates (Task 3).
Do NOT commit yet — proceed to Task 3 to update existing tests first.

---

## Task 3: Update existing mock server unit tests

**Files:**
- Modify: `test/unit/helpers/mock-opencode-server.test.ts`

**Step 1: Update "streams SSE events after prompt_async" test**

The existing test (line 226) manually drains all REST entries before calling `prompt_async`. Under the new model, REST draining is no longer necessary for SSE emission. Update the test to verify SSE works without REST draining:

```typescript
it("streams SSE events after prompt_async", async () => {
	// Connect SSE — no need to drain REST first
	const controller = new AbortController();
	const sseRes = await fetch(`${mock.url}/event`, {
		signal: controller.signal,
		headers: { Accept: "text/event-stream" },
	});
	expect(sseRes.status).toBe(200);

	const events: Array<{ type: string }> = [];
	const collecting = collectSseEvents(sseRes.body?.getReader(), events);

	// Wait for server.connected
	await new Promise((r) => setTimeout(r, 50));
	expect(events.some((e) => e.type === "server.connected")).toBe(true);

	// Trigger prompt_async — SSE should fire immediately
	await fetch(`${mock.url}/session/ses_1/prompt_async`, {
		method: "POST",
		body: "{}",
	});

	// Wait for SSE events to arrive
	await new Promise((r) => setTimeout(r, 200));
	controller.abort();
	await collecting;

	// All 5 post-prompt SSE events in segment 1 (3 before permission reply + 2 after)
	const batchEvents = events.filter((e) => e.type !== "server.connected");
	expect(batchEvents.length).toBe(5);
	expect(batchEvents[0]).toMatchObject({ type: "session.status" });   // busy
	expect(batchEvents[1]).toMatchObject({ type: "message.part.delta" }); // hello
	expect(batchEvents[2]).toMatchObject({ type: "session.status" });   // idle
	expect(batchEvents[3]).toMatchObject({ type: "message.part.delta" }); // world
	expect(batchEvents[4]).toMatchObject({ type: "session.status" });   // idle
});
```

**Step 2: Update "triggers SSE batch after permission reply" test**

The fixture has SSE events after the `POST /permission/:id/reply` REST entry. Under the new model, these SSE events are in the same segment as the post-prompt events (segment 1, since there's only one `prompt_async` in the fixture). They emit when the prompt fires, not when the permission reply is consumed.

Update the test to verify that ALL post-prompt SSE events (both the prompt batch and the permission-adjacent batch) emit together when `prompt_async` fires:

```typescript
it("emits all post-prompt SSE events when prompt fires (including permission-adjacent)", async () => {
	const controller = new AbortController();
	const sseRes = await fetch(`${mock.url}/event`, {
		signal: controller.signal,
		headers: { Accept: "text/event-stream" },
	});

	const events: Array<{ type: string }> = [];
	const collecting = collectSseEvents(sseRes.body?.getReader(), events);

	await new Promise((r) => setTimeout(r, 50));

	// Fire prompt — should emit ALL post-prompt SSE events in one go
	await fetch(`${mock.url}/session/ses_1/prompt_async`, {
		method: "POST",
		body: "{}",
	});
	await new Promise((r) => setTimeout(r, 200));
	controller.abort();
	await collecting;

	// All 5 post-prompt SSE events should have arrived (3 from first batch + 2 after permission reply)
	const allBatchEvents = events.filter((e) => e.type !== "server.connected");
	expect(allBatchEvents.length).toBe(5);
	expect(allBatchEvents[0]).toMatchObject({ type: "session.status" });   // busy
	expect(allBatchEvents[1]).toMatchObject({ type: "message.part.delta" }); // hello
	expect(allBatchEvents[2]).toMatchObject({ type: "session.status" });   // idle
	expect(allBatchEvents[3]).toMatchObject({ type: "message.part.delta" }); // world
	expect(allBatchEvents[4]).toMatchObject({ type: "session.status" });   // idle
});
```

**Step 3: Add flushPendingSse() unit test**

`flushPendingSse()` is a public method used by tests. Add coverage for the new segment model:

```typescript
it("flushPendingSse emits all segments without requiring prompt_async", async () => {
	const controller = new AbortController();
	const sseRes = await fetch(`${mock.url}/event`, {
		signal: controller.signal,
		headers: { Accept: "text/event-stream" },
	});
	const events: Array<{ type: string }> = [];
	const collecting = collectSseEvents(sseRes.body?.getReader(), events);
	await new Promise((r) => setTimeout(r, 50));

	// Flush all segments without calling prompt_async
	mock.flushPendingSse();
	await new Promise((r) => setTimeout(r, 200));
	controller.abort();
	await collecting;

	// All 5 post-prompt SSE events should arrive (segment 0 is empty, segment 1 has 5)
	const batchEvents = events.filter((e) => e.type !== "server.connected");
	expect(batchEvents.length).toBe(5);
});
```

**Step 4: Run all mock server unit tests**

Run: `pnpm vitest run test/unit/helpers/mock-opencode-server.test.ts`
Expected: All tests PASS.

**Step 5: Commit Tasks 1-3**

This is the first commit — it includes Task 1 (data structures), Task 2 (emission logic),
and Task 3 (test updates) as one atomic green commit:

```bash
git add test/helpers/mock-opencode-server.ts test/unit/helpers/mock-opencode-server.test.ts
git commit -m "refactor: decouple SSE from REST in MockOpenCodeServer

Replace the sseBatch-on-REST-entry model with a prompt-segmented SSE
timeline. SSE events are collected into segments delimited by prompt_async
boundaries and emitted independently when each prompt fires, regardless
of which REST endpoints the relay consumes.

This fixes a vicious cycle where the relay's SSE-covered state suppressed
REST polling that the mock depended on for SSE delivery."
```

---

## Task 4: Run full verification suite

**Files:** None (verification only)

**Step 1: Run unit tests**

Run: `pnpm test:unit`
Expected: All 3736+ tests pass. No other code references `sseBatch` on `QueuedRestResponse`.

**Step 2: Run type checking and lint**

Run: `pnpm check && pnpm lint`
Expected: Clean.

**Step 3: Run the 6 previously-failing E2E tests**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/permissions.spec.ts test/e2e/specs/advanced-ui.spec.ts test/e2e/specs/chat-lifecycle.spec.ts --reporter=list`

Expected results:
- permissions.spec.ts: 2/2 pass (was 0/2)
- advanced-ui.spec.ts: Split Diff (2) + File History (1) pass; Mermaid still skipped; Rewind/Paste/Plan skip or pass based on fixtures
- chat-lifecycle.spec.ts: 5/5 pass including multi-turn (was 4/5)

**Step 4: Run full replay E2E suite**

Run: `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts --reporter=list`
Expected: All non-skipped tests pass. No regressions in smoke, chat, sessions, sidebar, ui-features, debug-panel, unified-rendering, terminal, notification, fork-session.

**Step 5: Commit if any adjustments were needed**

```bash
git add -A
git commit -m "fix: resolve 6 E2E test failures caused by SSE/REST coupling

Decoupled SSE event delivery from REST queue consumption in
MockOpenCodeServer. SSE events now emit from a prompt-segmented timeline
independent of which REST endpoints the relay consumes.

Fixes: permissions.spec.ts (2 tests), advanced-ui.spec.ts (3 tests),
chat-lifecycle.spec.ts multi-turn (1 test)."
```

---

## Risk Analysis

### What could go wrong

1. **Timing sensitivity**: SSE events arriving too fast could overwhelm the relay's event pipeline. Mitigation: the 5ms delay cap in `emitSegment` provides natural pacing.

2. **statusOverride race**: Setting `statusOverride` from `session.idle` in the segment might happen before the relay has processed the busy status. Mitigation: the relay's status poller runs every 500ms; the 5ms-capped SSE delays mean idle fires well within one poll cycle, same as production.

3. **Recordings with no prompt_async**: Some recordings (smoke, sessions) may not have prompt_async. All their SSE events go to segment 0 (pre-prompt) and never emit unless `flushPendingSse()` is called. Verify these tests don't depend on SSE events — they likely don't, since they test init-state UI.

4. **SSE events between prompts that depend on REST state**: In the `advanced-diff` recording, `permission.replied` SSE events appear after `POST /permission/:id/reply` REST entries. Under the new model, these SSE events emit with their prompt segment (before the relay even sends the permission reply). This is fine — `permission.replied` is informational, and the relay handles it idempotently in `permissionBridge.onPermissionReplied()`.

### What stays unchanged

- REST queue behavior (dequeue, sticky fallback, exact/normalized matching)
- Stateful session endpoints (POST/DELETE/PATCH/GET /session, search)
- PTY WebSocket handling
- `injectSSEEvents()` and `emitTestEvent()` bypass methods
- SSE endpoint (`GET /event`) and client tracking
- Recording format and loader
