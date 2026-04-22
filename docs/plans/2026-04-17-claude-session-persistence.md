# Claude Session Message Persistence Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Persist Claude SDK session events to SQLite so message history survives session switching.

**Architecture:** Add optional persistence deps to `RelayEventSink` so its `push()` method writes events to `EventStore` + `ProjectionRunner` before sending to WebSocket. Thread persistence from `relay-stack.ts` → `handler-deps-wiring.ts` → `HandlerDeps` → `prompt.ts` → `createRelayEventSink()`. No changes to `ClaudeAdapter`, `DualWriteHook`, or `session-switch.ts` — once rows exist in SQLite, the existing history resolution path works.

**Tech Stack:** TypeScript (ESM), Vitest, SQLite (better-sqlite3), Biome

---

### Task 1: Add persistence support to RelayEventSink

**Files:**
- Modify: `src/lib/provider/relay-event-sink.ts:24-31` (deps interface)
- Modify: `src/lib/provider/relay-event-sink.ts:57-69` (push method)
- Test: `test/unit/provider/relay-event-sink.test.ts`

**Step 1: Write the failing tests**

Add a new `describe` block at the end of `test/unit/provider/relay-event-sink.test.ts`:

```typescript
describe("createRelayEventSink — persistence", () => {
	it("persists events to eventStore and projects them when persist deps provided", async () => {
		const send = vi.fn();
		const appendResult = {
			eventId: "evt_1",
			sessionId: "ses-1",
			type: "text.delta" as const,
			data: { messageId: "msg_1", partId: "part_1", text: "Hello" },
			metadata: {},
			provider: "claude",
			createdAt: Date.now(),
			sequence: 1,
			streamVersion: 1,
		};
		const eventStore = { append: vi.fn(() => appendResult) };
		const projectionRunner = { projectEvent: vi.fn() };
		const ensureSession = vi.fn();

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: { eventStore, projectionRunner, ensureSession },
		});

		const event = makeEvent("text.delta", {
			messageId: "msg_1",
			partId: "part_1",
			text: "Hello",
		});
		await sink.push(event);

		// Persistence called
		expect(ensureSession).toHaveBeenCalledWith("ses-1");
		expect(eventStore.append).toHaveBeenCalledWith(event);
		expect(projectionRunner.projectEvent).toHaveBeenCalledWith(appendResult);
		// WebSocket still works
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("still sends to WebSocket when persist is not provided", async () => {
		const send = vi.fn();
		const sink = createRelayEventSink({ sessionId: "ses-1", send });

		await sink.push(
			makeEvent("text.delta", {
				messageId: "msg_1",
				partId: "part_1",
				text: "Hello",
			}),
		);

		expect(send).toHaveBeenCalledWith({
			type: "delta",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("continues sending to WebSocket even if projection throws", async () => {
		const send = vi.fn();
		const appendResult = {
			eventId: "evt_1",
			sessionId: "ses-1",
			type: "text.delta" as const,
			data: { messageId: "msg_1", partId: "part_1", text: "Hello" },
			metadata: {},
			provider: "claude",
			createdAt: Date.now(),
			sequence: 1,
			streamVersion: 1,
		};
		const eventStore = { append: vi.fn(() => appendResult) };
		const projectionRunner = {
			projectEvent: vi.fn(() => {
				throw new Error("projection boom");
			}),
		};
		const ensureSession = vi.fn();

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: { eventStore, projectionRunner, ensureSession },
		});

		await sink.push(
			makeEvent("text.delta", {
				messageId: "msg_1",
				partId: "part_1",
				text: "Hello",
			}),
		);

		// WebSocket still works despite projection failure
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			text: "Hello",
			messageId: "msg_1",
		});
	});

	it("continues sending to WebSocket even if eventStore.append throws", async () => {
		const send = vi.fn();
		const eventStore = {
			append: vi.fn(() => {
				throw new Error("disk full");
			}),
		};
		const projectionRunner = { projectEvent: vi.fn() };
		const ensureSession = vi.fn();

		const sink = createRelayEventSink({
			sessionId: "ses-1",
			send,
			persist: { eventStore, projectionRunner, ensureSession },
		});

		await sink.push(
			makeEvent("text.delta", {
				messageId: "msg_1",
				partId: "part_1",
				text: "Hello",
			}),
		);

		// WebSocket still works despite append failure
		expect(send).toHaveBeenCalledWith({
			type: "delta",
			text: "Hello",
			messageId: "msg_1",
		});
		// Projection never reached
		expect(projectionRunner.projectEvent).not.toHaveBeenCalled();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/relay-event-sink.test.ts`
Expected: FAIL — `persist` property does not exist on `RelayEventSinkDeps`

**Step 3: Add persist deps to RelayEventSinkDeps interface**

In `src/lib/provider/relay-event-sink.ts`, add imports and modify the interface.

Add after line 9 (`import type { CanonicalEvent } from "../persistence/events.js";`):

```typescript
import type { StoredEvent } from "../persistence/events.js";
```

Replace the `RelayEventSinkDeps` interface (lines 24-31) with:

```typescript
export interface RelayEventSinkPersist {
	readonly eventStore: { append(event: CanonicalEvent): StoredEvent };
	readonly projectionRunner: { projectEvent(event: StoredEvent): void };
	readonly ensureSession: (sessionId: string) => void;
}

export interface RelayEventSinkDeps {
	readonly sessionId: string;
	readonly send: (msg: RelayMessage) => void;
	/** Optional: clear processing timeout when the turn finishes (done/error). */
	readonly clearTimeout?: () => void;
	/** Optional: reset processing timeout on any activity. */
	readonly resetTimeout?: () => void;
	/** Optional: persist events to SQLite for session history survival. */
	readonly persist?: RelayEventSinkPersist;
}
```

**Step 4: Update the factory function and push method**

In `createRelayEventSink`, destructure `persist` from deps (line 43):

Replace line 43:
```typescript
	const { sessionId, send, clearTimeout, resetTimeout } = deps;
```
With:
```typescript
	const { sessionId, send, clearTimeout, resetTimeout, persist } = deps;
```

Replace the `push` method body (lines 57-69) with:

```typescript
		async push(event: CanonicalEvent): Promise<void> {
			reset();
			// Persist to SQLite when available (before WS send for durability)
			if (persist) {
				try {
					persist.ensureSession(sessionId);
					const stored = persist.eventStore.append(event);
					persist.projectionRunner.projectEvent(stored);
				} catch {
					// Non-fatal — same pattern as dual-write-hook.ts:149.
					// Covers: disk full, DB locked, projection recovery guard, etc.
				}
			}
			const msg = translateCanonicalEvent(event);
			if (msg) {
				for (const m of msg) {
					send(m);
					// Done is always terminal; errors are terminal except RETRY,
					// which is a non-terminal progress signal during API retries.
					const isTerminal =
						m.type === "done" || (m.type === "error" && m.code !== "RETRY");
					if (isTerminal) finish();
				}
			}
		},
```

**Step 5: Run tests to verify they pass**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/relay-event-sink.test.ts`
Expected: ALL PASS (existing tests unchanged + 3 new tests pass)

**Step 6: Type-check**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 7: Commit**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add src/lib/provider/relay-event-sink.ts test/unit/provider/relay-event-sink.test.ts
git commit -m "feat: add optional persistence to RelayEventSink push()"
```

---

### Task 2: Add persistence to HandlerDeps and wire through handler-deps-wiring

**Files:**
- Modify: `src/lib/handlers/types.ts:58-102` (HandlerDeps interface)
- Modify: `src/lib/relay/handler-deps-wiring.ts:34-52` (HandlerDepsWiringDeps interface)
- Modify: `src/lib/relay/handler-deps-wiring.ts:64-83` (wireHandlerDeps destructure)
- Modify: `src/lib/relay/handler-deps-wiring.ts:124-173` (handlerDeps object)

**Step 1: Add persistence to HandlerDeps**

In `src/lib/handlers/types.ts`, add import after line 9 (`import type { ReadQueryService } from "../persistence/read-query-service.js";`):

```typescript
import type { RelayEventSinkPersist } from "../provider/relay-event-sink.js";
```

Add after line 101 (`orchestrationEngine?: OrchestrationEngine;`), before the closing `}`:

```typescript
	/**
	 * Claude event persistence deps (optional — only when SQLite is configured).
	 * Passed to RelayEventSink so Claude SDK events survive session switches.
	 */
	claudeEventPersist?: RelayEventSinkPersist;
```

**Step 2: Add persistence to HandlerDepsWiringDeps**

In `src/lib/relay/handler-deps-wiring.ts`, add import after line 18 (`import type { OrchestrationLayer } from "../provider/orchestration-wiring.js";`):

```typescript
import type { RelayEventSinkPersist } from "../provider/relay-event-sink.js";
```

Add after line 51 (`orchestrationLayer?: OrchestrationLayer;`), before the closing `}`:

```typescript
	/** Claude event persistence deps (optional — only when persistence configured). */
	claudeEventPersist?: RelayEventSinkPersist;
```

**Step 3: Wire persistence through in wireHandlerDeps**

In the destructure block (line 82, after `orchestrationLayer,`), add:

```typescript
		claudeEventPersist,
```

In the `handlerDeps` object (after line 172 — the closing `}),` of the orchestrationLayer spread), add:

```typescript
		...(claudeEventPersist != null && { claudeEventPersist }),
```

**Step 4: Type-check**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add src/lib/handlers/types.ts src/lib/relay/handler-deps-wiring.ts
git commit -m "feat: thread claudeEventPersist through HandlerDeps"
```

---

### Task 3: Wire persistence from relay-stack into handler-deps-wiring

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:347-362` (wireHandlerDeps call)

**Step 1: Add SessionSeeder import and create persist deps**

In `relay-stack.ts`, add import. Find the existing import block (around lines 20-21):

```typescript
import { DualWriteHook } from "../persistence/dual-write-hook.js";
```

Add after it:

```typescript
import { SessionSeeder } from "../persistence/session-seeder.js";
```

**Step 2: Call projectionRunner.recover() at startup**

`ProjectionRunner.projectEvent()` has a lifecycle guard: it throws if `recover()` was never called. Currently `recover()` is never called in production (only in tests), so ALL projections silently fail — both DualWriteHook (OpenCode SSE) and our new RelayEventSink path. The `messages` table is never populated, making SQLite history always empty.

Before the dual-write hook creation (around line 372, `if (config.persistence) {`), add:

```typescript
	// ── Run projector recovery (required before projectEvent works) ──────
	// ProjectionRunner guards projectEvent() behind a recovery check.
	// Without this call, all projections silently fail (caught by try/catch
	// in DualWriteHook and RelayEventSink) and the messages table stays empty.
	if (config.persistence) {
		config.persistence.projectionRunner.recover();
	}
```

**Step 3: Create claudeEventPersist object before wireHandlerDeps call**

Before the `wireHandlerDeps` call (line 347), add:

```typescript
	// ── Claude event persistence (reuses existing persistence layer) ──────
	const claudeEventPersist = config.persistence
		? (() => {
				const seeder = new SessionSeeder(config.persistence.db);
				return {
					eventStore: config.persistence.eventStore,
					projectionRunner: config.persistence.projectionRunner,
					ensureSession: (sid: string) => seeder.ensureSession(sid, "claude"),
				};
			})()
		: undefined;
```

**Step 4: Pass claudeEventPersist to wireHandlerDeps**

In the `wireHandlerDeps({...})` call, after line 362 (`orchestrationLayer: orchestration,`), add:

```typescript
		...(claudeEventPersist != null && { claudeEventPersist }),
```

**Step 5: Type-check**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 6: Commit**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add src/lib/relay/relay-stack.ts
git commit -m "feat: wire Claude event persistence and projector recovery from relay-stack"
```

---

### Task 4: Pass persistence to createRelayEventSink in prompt handler

**Files:**
- Modify: `src/lib/handlers/prompt.ts:120-128` (createRelayEventSink call)

**Step 1: Pass persist deps to createRelayEventSink**

Replace lines 120-128 in `src/lib/handlers/prompt.ts`:

```typescript
		const eventSink =
			providerId === "claude"
				? createRelayEventSink({
						sessionId: activeId,
						send: (msg) => deps.wsHandler.sendToSession(activeId, msg),
						clearTimeout: () => deps.overrides.clearProcessingTimeout(activeId),
						resetTimeout: () => deps.overrides.resetProcessingTimeout(activeId),
					})
				: NOOP_EVENT_SINK;
```

With:

```typescript
		const eventSink =
			providerId === "claude"
				? createRelayEventSink({
						sessionId: activeId,
						send: (msg) => deps.wsHandler.sendToSession(activeId, msg),
						clearTimeout: () => deps.overrides.clearProcessingTimeout(activeId),
						resetTimeout: () => deps.overrides.resetProcessingTimeout(activeId),
						...(deps.claudeEventPersist != null
							? { persist: deps.claudeEventPersist }
							: {}),
					})
				: NOOP_EVENT_SINK;
```

**Step 2: Type-check**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 3: Commit**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add src/lib/handlers/prompt.ts
git commit -m "feat: pass persistence to RelayEventSink for Claude sessions"
```

---

### Task 5: Integration test — full persistence chain with real SQLite

**Files:**
- Create: `test/unit/provider/relay-event-sink-persistence.test.ts`

**Step 1: Write the integration test**

Create `test/unit/provider/relay-event-sink-persistence.test.ts`:

```typescript
// Integration test: RelayEventSink → real EventStore + ProjectionRunner → SQLite → session history
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionSeeder } from "../../../src/lib/persistence/session-seeder.js";
import { resolveSessionHistoryFromSqlite } from "../../../src/lib/session/session-switch.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import {
	makeMessageCreatedEvent,
	makeTextDelta,
} from "../../helpers/persistence-factories.js";

describe("RelayEventSink persistence integration", () => {
	let layer: PersistenceLayer;

	afterEach(() => {
		layer?.close();
	});

	it("persisted Claude events are retrievable via resolveSessionHistoryFromSqlite", async () => {
		layer = PersistenceLayer.memory();
		layer.projectionRunner.recover();

		const seeder = new SessionSeeder(layer.db);
		const send = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "s1",
			send,
			persist: {
				eventStore: layer.eventStore,
				projectionRunner: layer.projectionRunner,
				ensureSession: (sid) => seeder.ensureSession(sid, "claude"),
			},
		});

		// Push a message.created + text.delta (simulates Claude assistant turn)
		await sink.push(
			makeMessageCreatedEvent("s1", "m1", {
				role: "assistant",
			}),
		);
		await sink.push(makeTextDelta("s1", "m1", "Hello from Claude"));

		// Verify session history is now available from SQLite
		const readQuery = new ReadQueryService(layer.db);
		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			expect(source.history.messages.length).toBeGreaterThanOrEqual(1);
			// The assistant message should have text content
			const assistantMsg = source.history.messages.find(
				(m) => m.role === "assistant",
			);
			expect(assistantMsg).toBeDefined();
		}

		// Verify WebSocket send was also called
		expect(send).toHaveBeenCalled();
	});

	it("session row is created with provider 'claude'", async () => {
		layer = PersistenceLayer.memory();
		layer.projectionRunner.recover();

		const seeder = new SessionSeeder(layer.db);
		const send = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "s-claude",
			send,
			persist: {
				eventStore: layer.eventStore,
				projectionRunner: layer.projectionRunner,
				ensureSession: (sid) => seeder.ensureSession(sid, "claude"),
			},
		});

		await sink.push(
			makeMessageCreatedEvent("s-claude", "m1", { role: "assistant" }),
		);

		// Verify session row exists with correct provider
		const row = layer.db.queryOne<{ provider: string }>(
			"SELECT provider FROM sessions WHERE id = ?",
			["s-claude"],
		);
		expect(row?.provider).toBe("claude");
	});
});
```

**Step 2: Run test to verify it passes**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm vitest run test/unit/provider/relay-event-sink-persistence.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add test/unit/provider/relay-event-sink-persistence.test.ts
git commit -m "test: integration test for Claude event persistence chain"
```

---

### Task 6: Full verification pass

**Step 1: Run all tests**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm test`
Expected: ALL PASS — no regressions

**Step 2: Type-check**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm check`
Expected: PASS

**Step 3: Lint**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm lint`
Expected: PASS (or only pre-existing warnings)

**Step 4: Fix any lint issues**

Run: `cd /Users/dstern/src/personal/opencode-relay/conduit && pnpm lint:fix`

**Step 5: Final commit if lint:fix changed anything**

```bash
cd /Users/dstern/src/personal/opencode-relay/conduit
git add -A
git commit -m "style: auto-fix lint/format issues"
```
