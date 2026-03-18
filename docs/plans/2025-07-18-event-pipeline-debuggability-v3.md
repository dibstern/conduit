# Event Pipeline Debuggability v3 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Centralize processing-state authority in `SessionStatusPoller`, extract untestable closures and private state machines as pure functions, add event provenance for debugging.

**Architecture:** The status poller becomes the sole source of processing/idle transitions (absorbing `previousBusySessions` from relay-stack and receiving SSE idle hints for speed). The message poller's diff/synthesis engine is exposed as pure functions for direct testing. Event provenance tags trace every pipeline event to its origin without affecting the wire protocol.

**Tech Stack:** TypeScript, Vitest, EventEmitter

**Test command:** `pnpm test:unit`

---

## Task 1: Extract message poller pure functions

Export the diff/synthesis engine from `MessagePoller` as standalone pure functions. The class continues to call them, but tests can exercise them directly with constructed snapshots.

**Files:**
- Modify: `src/lib/relay/message-poller.ts`
- Modify: `test/unit/relay/message-poller.test.ts`

### What to do

1. **Export `PartSnapshot` and `MessageSnapshot` types.** Change `interface PartSnapshot` (line 32) and `interface MessageSnapshot` (line 52) from non-exported to `export interface`.

2. **Extract `synthesizeTextPart` as a standalone exported function.** Move the method body (lines 443-482) to a module-level exported function:

```typescript
export function synthesizeTextPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	events: RelayMessage[],
	messageId: string,
	deltaType: "delta" | "thinking_delta",
): void {
	// exact same body as the current private method
}
```

The class method becomes a one-liner delegating to the exported function.

3. **Extract `synthesizeToolPart` the same way** (lines 487-581). Needs `mapToolName` imported already (line 13).

```typescript
export function synthesizeToolPart(
	part: { id: string; type: string; [key: string]: unknown },
	snap: PartSnapshot,
	prev: PartSnapshot | null,
	events: RelayMessage[],
	messageId: string,
): void {
	// exact same body
}
```

4. **Extract `synthesizePartEvents`** (lines 405-437) — delegates to `synthesizeTextPart`/`synthesizeToolPart`.

```typescript
export function synthesizePartEvents(
	part: { id: string; type: string; [key: string]: unknown },
	prev: PartSnapshot | null,
	messageId: string,
): { events: RelayMessage[]; snapshot: PartSnapshot } {
	// exact same body, calling the exported functions
}
```

5. **Extract `diffAndSynthesize`** (lines 346-400). It needs `extractUserText` (keep as a private helper or export too — it's simple enough to inline). The extracted function takes `previousSnapshot` as a parameter and returns `{ events, newSnapshot }` instead of mutating `this.previousSnapshot`.

```typescript
export function diffAndSynthesize(
	previousSnapshot: Map<string, MessageSnapshot>,
	messages: Message[],
): { events: RelayMessage[]; newSnapshot: Map<string, MessageSnapshot> } {
	// same logic, but return newSnapshot instead of this.previousSnapshot = newSnapshot
}
```

The class method becomes:
```typescript
private doDiffAndSynthesize(sessionId: string, messages: Message[]): RelayMessage[] {
	const { events, newSnapshot } = diffAndSynthesize(this.previousSnapshot, messages);
	this.previousSnapshot = newSnapshot;
	return events;
}
```

6. **Extract `seedSnapshot`** (lines 178-253). Same pattern — takes messages, returns a `Map<string, MessageSnapshot>`.

```typescript
export function buildSeedSnapshot(messages: Message[]): Map<string, MessageSnapshot> {
	// same logic, returns the map instead of assigning to this.previousSnapshot
}
```

7. **Add new direct tests** for the extracted functions in `message-poller.test.ts`:

   - `synthesizeTextPart`: `thinking_stop` emission when `time.end` set AND `textLength > 0` AND no new text
   - `synthesizeTextPart`: thinking_stop NOT emitted when `textLength === 0` (premature stop guard)
   - `synthesizeToolPart`: tool seeded as `running` → first poll doesn't re-emit `tool_executing`
   - `diffAndSynthesize`: multi-part message growth (poll 1 sees `[textPart]`, poll 2 sees `[textPart, toolPart]`)
   - `buildSeedSnapshot`: running tool correctly marks `emittedExecuting = true`

### Verification

```bash
pnpm vitest test/unit/relay/message-poller.test.ts --run
pnpm test:unit
```

---

## Task 2: Event provenance tags

Add a `_source` field to `PipelineResult` so `applyPipelineResult` can log which path produced each event. Not sent to clients.

**Files:**
- Modify: `src/lib/relay/event-pipeline.ts`
- Modify: `src/lib/relay/sse-wiring.ts`
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `test/unit/relay/event-pipeline.test.ts`

### What to do

1. **Add `source` to `PipelineResult`:**

```typescript
export type EventSource = "sse" | "message-poller" | "status-poller" | "prompt";

export interface PipelineResult {
	msg: RelayMessage;
	fullContent: string | undefined;
	route: RouteDecision;
	cache: boolean;
	timeout: "clear" | "reset" | "none";
	source: EventSource;
}
```

2. **Add `source` parameter to `processEvent`:**

```typescript
export function processEvent(
	msg: RelayMessage,
	sessionId: string | undefined,
	viewers: string[],
	source: EventSource = "sse",
): PipelineResult {
	// ... same logic ...
	return {
		// ... same fields ...
		source,
	};
}
```

3. **Update `applyPipelineResult` logging** to include source:

Change the drop log (line 127) from:
```typescript
deps.log(`   [pipeline] ${result.route.reason} — ${result.msg.type}`);
```
To:
```typescript
deps.log(`   [pipeline] ${result.route.reason} — ${result.msg.type} (${result.source})`);
```

4. **Tag call sites:**

   - `sse-wiring.ts` line 240: `processEvent(msg, targetSessionId, viewers)` → add `"sse"` (default, no change needed)
   - `relay-stack.ts` status poller `becameIdle` handler: `processEvent({ type: "done", code: 0 }, sessionId, doneViewers, "status-poller")`
   - `relay-stack.ts` message poller `events` handler: `processEvent(msg, polledSessionId, pollerViewers, "message-poller")`

5. **Update tests:** Existing `processEvent` tests in `event-pipeline.test.ts` need to expect the `source` field in results. Add one test verifying that source is included in the result.

### Verification

```bash
pnpm vitest test/unit/relay/event-pipeline.test.ts --run
pnpm vitest test/unit/relay/sse-wiring.test.ts --run
pnpm test:unit
```

---

## Task 3: Expand `SessionStatusPoller` as processing authority

Move transition detection (`previousBusySessions` + `computeStatusTransitions`) into the status poller. Add `became_busy` and `became_idle` events. Add `notifySSEIdle` method for SSE speed hints.

**Files:**
- Modify: `src/lib/session/session-status-poller.ts`
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `test/unit/relay/status-transitions.test.ts`
- Modify or create: `test/unit/session/session-status-poller.test.ts`

### What to do

1. **Add new events to `SessionStatusPollerEvents`:**

```typescript
export interface SessionStatusPollerEvents {
	/** Emitted when any session's status has changed since the last poll */
	changed: [statuses: Record<string, SessionStatus>];
	/** Sessions that just transitioned from idle to busy */
	became_busy: [sessionIds: string[]];
	/** Sessions that just transitioned from busy to idle */
	became_idle: [sessionIds: string[]];
}
```

2. **Move `previousBusy` into the poller as private state:**

```typescript
private previousBusy = new Set<string>();
```

3. **Import and call `computeStatusTransitions` inside `poll()`.** After the existing `hasChanged` check and `this.emit("changed", current)`, add:

```typescript
// Compute busy/idle transitions
const transitions = computeStatusTransitions(this.previousBusy, current);
if (transitions.becameBusy.length > 0) {
	this.emit("became_busy", transitions.becameBusy);
}
if (transitions.becameIdle.length > 0) {
	this.emit("became_idle", transitions.becameIdle);
}
this.previousBusy = transitions.currentBusy;
```

This should run on EVERY poll (not just when `hasChanged` is true), because `previousBusy` is the poller's own tracking — a session can become busy/idle even if the status *types* didn't change from the previous perspective (e.g., message activity TTL expired).

Actually, re-check: `previousBusy` tracks which sessions were in the `current` augmented statuses as busy. If `hasChanged` is false, then `current` is identical to `previous` in terms of session presence and types. So transitions would be empty. It's safe to only compute transitions when `hasChanged` is true, which avoids unnecessary computation. But to be safe and simple, compute on every poll — it's a cheap Set comparison.

4. **Add `notifySSEIdle(sessionId)` method:**

```typescript
/**
 * Called when SSE delivers a session.status:idle event.
 * Triggers an immediate re-poll so idle transitions are detected
 * within ~10ms instead of waiting for the next 500ms cycle.
 */
notifySSEIdle(sessionId: string): void {
	this.log(`   [status-poller] SSE idle hint for session=${sessionId.slice(0, 12)} — triggering immediate poll`);
	void this.poll();
}
```

5. **Simplify relay-stack.ts.** The `statusPoller.on("changed")` handler (lines 593-671) splits into three listeners:

```typescript
// Session list broadcast (existing behavior)
statusPoller.on("changed", async (statuses) => {
	try {
		const sessions = await sessionMgr.listSessions(statuses);
		wsHandler.broadcast({ type: "session_list", sessions });
	} catch (err) {
		log(`   [status-poller] Failed to broadcast session list: ${err instanceof Error ? err.message : err}`);
	}
});

// Sessions became busy → send processing status
statusPoller.on("became_busy", (sessionIds) => {
	for (const sessionId of sessionIds) {
		wsHandler.sendToSession(sessionId, { type: "status", status: "processing" });
	}
});

// Sessions became idle → send done through pipeline
statusPoller.on("became_idle", (sessionIds) => {
	for (const sessionId of sessionIds) {
		const doneViewers = wsHandler.getClientsForSession(sessionId);
		const doneResult = processEvent(
			{ type: "done", code: 0 },
			sessionId,
			doneViewers,
			"status-poller",
		);
		applyPipelineResult(doneResult, sessionId, pipelineDeps);
	}
});
```

6. **Remove `previousBusySessions` variable** (line 591) and the entire `computeStatusTransitions` call + loop from the `changed` handler. Remove the import of `computeStatusTransitions` from relay-stack.ts.

7. **Poller decision logic stays in `changed` handler** — the `computePollerDecisions` call and its application loop remain in the `changed` handler since they depend on `statuses` and `pollerManager`. This is still event-driven from the poller's `changed` emission.

8. **Add tests** for the new events:
   - `became_busy` emitted when a session appears in augmented statuses that wasn't there before
   - `became_idle` emitted when a session disappears from augmented statuses
   - `notifySSEIdle` triggers immediate poll
   - Transition events not emitted on first poll (baseline)
   - Multiple sessions transitioning simultaneously

### Verification

```bash
pnpm vitest test/unit/session/session-status-poller.test.ts --run
pnpm test:unit
```

---

## Task 4: Remove `session.status` translation from SSE path

Stop the SSE path from translating `session.status` events into `status`/`done` relay messages. Instead, forward idle hints to the status poller.

**Files:**
- Modify: `src/lib/relay/event-translator.ts`
- Modify: `src/lib/relay/sse-wiring.ts`
- Modify: `test/unit/relay/sse-wiring.test.ts`
- Modify: `test/unit/relay/event-translator.pbt.test.ts`

### What to do

1. **In `event-translator.ts`**, modify `translateSessionStatus` (line 328) to return skip results instead of relay messages:

```typescript
export function translateSessionStatus(
	event: OpenCodeEvent,
): RelayMessage | RelayMessage[] | null {
	// session.status events are now handled by the status poller.
	// Return null so the SSE pipeline skips them.
	return null;
}
```

Alternatively, to preserve the retry error message (which SSE can deliver faster than the poller), keep only the retry path:

```typescript
export function translateSessionStatus(
	event: OpenCodeEvent,
): RelayMessage | RelayMessage[] | null {
	if (!isSessionStatusEvent(event)) return null;
	const { properties: props } = event;
	const statusType = props.status?.type;

	// busy and idle are handled by the status poller (via notifySSEIdle).
	// Retry messages are still translated here for immediate user feedback.
	if (statusType === "retry") {
		const attempt = props.status?.attempt ?? 0;
		const reason = props.status?.message ?? "Retrying";
		const nextMs = props.status?.next;
		const delayMs =
			nextMs && nextMs > Date.now() ? nextMs - Date.now() : undefined;
		const retryMsg = formatRetryMessage(reason, attempt, delayMs);
		return { type: "error", code: "RETRY", message: retryMsg };
	}

	return null;
}
```

This preserves retry error messages (which benefit from SSE speed) while removing the duplicate `processing`/`done` from the SSE path. The status poller's `changed` event already handles `retry` status type for the bounce bar (`processing` flag in session list).

2. **In `sse-wiring.ts`**, add SSE idle hint forwarding. The `SSEWiringDeps` interface needs a new optional field:

```typescript
export interface SSEWiringDeps {
	// ... existing fields ...
	/** Optional: notify status poller of SSE idle events for fast transition detection */
	statusPoller?: { notifySSEIdle(sessionId: string): void };
}
```

In `handleSSEEvent`, add handling for `session.status` events BEFORE the translate step:

```typescript
// ── SSE idle hint → status poller for fast transition detection ──────
if (event.type === "session.status") {
	const statusType = (event.properties?.status as { type?: string })?.type;
	if (statusType === "idle" && eventSessionId && deps.statusPoller) {
		deps.statusPoller.notifySSEIdle(eventSessionId);
	}
}
```

3. **In relay-stack.ts**, pass `statusPoller` to `wireSSEConsumer` deps:

```typescript
wireSSEConsumer(
	{
		// ... existing deps ...
		statusPoller,
	},
	sseConsumer,
);
```

4. **Update tests:**
   - `event-translator.pbt.test.ts`: The `session.status` property test (P7) needs updating. `busy` → `null`, `idle` → `null`, `retry` → only the error message (not `[processing, error]`).
   - `sse-wiring.test.ts`: Tests that verify `session.status` events produce `status`/`done` relay messages need updating. Add a test verifying `notifySSEIdle` is called when `session.status:idle` arrives.

### Verification

```bash
pnpm vitest test/unit/relay/event-translator.pbt.test.ts --run
pnpm vitest test/unit/relay/sse-wiring.test.ts --run
pnpm test:unit
```

---

## Task 5: Done deduplication in status poller handler

When the status poller's `became_idle` fires, check the message cache for a recent `done` event before emitting another one.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`

### What to do

In the `became_idle` listener (added in Task 3), before processing the `done` event through the pipeline, check the cache:

```typescript
statusPoller.on("became_idle", (sessionIds) => {
	for (const sessionId of sessionIds) {
		// Skip if cache already has a recent done event for this session
		const cached = messageCache.getEvents(sessionId);
		const lastEvent = cached?.[cached.length - 1];
		if (lastEvent?.type === "done") {
			log(`   [status-poller] Skipping duplicate done for session=${sessionId.slice(0, 12)} — already cached`);
			// Still clear the processing timeout
			overrides.clearProcessingTimeout(sessionId);
			continue;
		}

		const doneViewers = wsHandler.getClientsForSession(sessionId);
		const doneResult = processEvent(
			{ type: "done", code: 0 },
			sessionId,
			doneViewers,
			"status-poller",
		);
		applyPipelineResult(doneResult, sessionId, pipelineDeps);
	}
});
```

Note: We still need to call `clearProcessingTimeout` even when deduplicating, because the pipeline call is skipped. This is the one edge case where the timeout clearing must happen outside `applyPipelineResult`.

### Verification

```bash
pnpm test:unit
```

---

## Task 6: Extract `connectPtyUpstream` to `pty-upstream.ts`

Move the 99-line closure from relay-stack.ts into its own module with explicit dependencies.

**Files:**
- Create: `src/lib/relay/pty-upstream.ts`
- Modify: `src/lib/relay/relay-stack.ts`

### What to do

1. **Create `pty-upstream.ts`** with the extracted function:

```typescript
export interface PtyUpstreamDeps {
	ptyManager: {
		registerSession(ptyId: string, upstream: unknown): void;
		closeSession(ptyId: string): void;
		appendScrollback(ptyId: string, text: string): void;
		markExited(ptyId: string, exitCode: number): void;
		hasSession(ptyId: string): boolean;
	};
	wsHandler: {
		broadcast(msg: import("../types.js").RelayMessage): void;
	};
	client: {
		getAuthHeaders(): Record<string, string>;
	};
	opencodeUrl: string;
	log: (...args: unknown[]) => void;
	WebSocketClass: typeof import("ws").WebSocket;
}

export async function connectPtyUpstream(
	deps: PtyUpstreamDeps,
	ptyId: string,
	cursor: number = 0,
): Promise<void> {
	// Move entire function body from relay-stack.ts lines 210-309
	// Replace closure captures with deps.* references
}
```

2. **In relay-stack.ts**, replace the inline `connectPtyUpstream` function with:

```typescript
import { connectPtyUpstream as connectPtyUpstreamImpl, type PtyUpstreamDeps } from "./pty-upstream.js";

// ... later in createProjectRelay:
const ptyDeps: PtyUpstreamDeps = {
	ptyManager, wsHandler, client,
	opencodeUrl: config.opencodeUrl,
	log, WebSocketClass,
};

// In handlerDeps, replace connectPtyUpstream:
connectPtyUpstream: (ptyId: string, cursor?: number) =>
	connectPtyUpstreamImpl(ptyDeps, ptyId, cursor),
```

### Verification

```bash
pnpm test:unit
```

---

## Task 7: Extract translator rebuild helper

Extract the translator state rebuild logic from the `session_changed` handler in relay-stack.ts.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts`
- Modify: `src/lib/relay/event-translator.ts` (add helper near the interface)

### What to do

1. **Add exported helper to `event-translator.ts`:**

```typescript
/**
 * Rebuild translator state from REST API messages.
 * Fetches messages for the given session and populates the translator's
 * seenParts map so it knows which parts already exist (prevents duplicate
 * tool_start/thinking_start on session switch or SSE reconnection).
 */
export async function rebuildTranslatorFromHistory(
	translator: Translator,
	getMessages: (sessionId: string) => Promise<Array<{ parts?: Array<{ id: string; type: PartType; state?: { status?: ToolStatus } }> }>>,
	sessionId: string,
	log: (...args: unknown[]) => void,
): Promise<typeof undefined | Awaited<ReturnType<typeof getMessages>>> {
	try {
		const messages = await getMessages(sessionId);
		const parts = messages.map((m) => {
			const rawParts = (m as { parts?: unknown[] }).parts as
				| Array<{ id: string; type: PartType; state?: { status?: ToolStatus } }>
				| undefined;
			return rawParts != null ? { parts: rawParts } : {};
		});
		translator.rebuildStateFromHistory(parts);
		return messages;
	} catch (err) {
		log(`   [session] rebuildStateFromHistory failed for ${sessionId}: ${err instanceof Error ? err.message : err}`);
		return undefined;
	}
}
```

2. **Simplify relay-stack.ts `session_changed` handler** (lines 426-483) to use the helper:

```typescript
sessionMgr.on("session_changed", async ({ sessionId: sid }) => {
	translator.reset();
	pollerManager.stopPolling(sid);
	statusPoller.clearMessageActivity(sid);

	const existingMessages = await rebuildTranslatorFromHistory(
		translator,
		(id) => client.getMessages(id),
		sid,
		log,
	);

	if (existingMessages) {
		pollerManager.startPolling(sid, existingMessages);
	} else {
		log(`   [session] Skipping poller start for ${sid.slice(0, 12)} — no seed messages`);
	}
});
```

### Verification

```bash
pnpm test:unit
```

---

## Task 8: Message poller logging + deterministic translator tests

Two small independent changes.

**Files:**
- Modify: `src/lib/relay/message-poller.ts`
- Create or modify: `test/unit/relay/event-translator.pbt.test.ts`

### What to do

**Part A: Message poller logging**

1. At line 296 (`if (this.polling) return;`), add:
```typescript
if (this.polling) {
	this.log(`   [msg-poller] poll skipped — previous poll still running`);
	return;
}
```

2. At line 300 (`if (this.isSSEActive()) return;`), add:
```typescript
if (this.isSSEActive()) {
	this.log(`   [msg-poller] poll skipped — SSE active for session=${this.activeSessionId?.slice(0, 12)}`);
	return;
}
```

**Part B: Deterministic translator delta classification tests**

Add tests to `event-translator.pbt.test.ts` (or a new file `event-translator.delta-classification.test.ts`):

```typescript
describe("seenParts-based delta classification", () => {
	it("routes delta to thinking_delta when part is registered as reasoning", () => {
		const t = createTranslator();
		// Register a reasoning part via part.updated
		t.translate({
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "part_1",
					type: "reasoning",
					sessionID: "ses_1",
				},
			},
		});
		// Send a delta for the same part
		const result = t.translate({
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				partID: "part_1",
				field: "text",
				delta: "thinking content",
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toContainEqual(
				expect.objectContaining({ type: "thinking_delta", text: "thinking content" }),
			);
		}
	});

	it("routes delta to delta when part is registered as text", () => {
		const t = createTranslator();
		t.translate({
			type: "message.part.updated",
			properties: {
				sessionID: "ses_1",
				part: {
					id: "part_2",
					type: "text",
					sessionID: "ses_1",
				},
			},
		});
		const result = t.translate({
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				partID: "part_2",
				field: "text",
				delta: "regular content",
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toContainEqual(
				expect.objectContaining({ type: "delta", text: "regular content" }),
			);
		}
	});

	it("routes delta to delta when part is unknown (fallback)", () => {
		const t = createTranslator();
		// No prior part.updated — part is unknown
		const result = t.translate({
			type: "message.part.delta",
			properties: {
				sessionID: "ses_1",
				partID: "part_unknown",
				field: "text",
				delta: "fallback content",
			},
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages).toContainEqual(
				expect.objectContaining({ type: "delta", text: "fallback content" }),
			);
		}
	});
});
```

### Verification

```bash
pnpm vitest test/unit/relay/message-poller.test.ts --run
pnpm vitest test/unit/relay/event-translator.pbt.test.ts --run
pnpm test:unit
```

---

## Task dependency graph

```
Task 1 (poller pure functions)     — independent
Task 2 (provenance tags)           — independent
Task 3 (expand status poller)      — independent
Task 4 (remove SSE status/done)    — depends on Task 3 (needs notifySSEIdle)
Task 5 (done dedup)                — depends on Task 3 (needs became_idle event)
Task 6 (extract PTY upstream)      — independent
Task 7 (extract translator rebuild)— independent
Task 8 (logging + translator tests)— independent
```

**Parallelizable groups:**
- Group A: Tasks 1, 6, 7, 8 (zero file overlap)
- Group B: Task 2 (touches event-pipeline.ts — minor overlap with group A via relay-stack imports)
- Group C: Task 3, then 4+5 sequentially (status poller + SSE wiring)

**Recommended execution order:** Group A in parallel → Task 2 → Task 3 → Tasks 4+5 in parallel.
