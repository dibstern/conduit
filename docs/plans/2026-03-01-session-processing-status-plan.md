# Session Processing Status — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the sidebar pulsing dot and chat processing state work for all sessions, including those started from the OpenCode TUI or running in the background.

**Architecture:** A `SessionStatusPoller` polls `GET /session/status` every 500ms, diffs against previous state, and broadcasts updated `session_list` messages (with `processing: true`) when any session's status changes. The same poller data is used by `client-init.ts` and `handleSwitchSession` to send correct initial status.

**Tech Stack:** TypeScript, Node.js EventEmitter, Vitest (TDD)

**Design doc:** `docs/plans/2026-03-01-session-processing-status-design.md`

---

### Task 1: Add `SessionStatus` type and `getSessionStatuses()` to OpenCodeClient

**Files:**
- Modify: `src/lib/opencode-client.ts:8-18` (add type), `:199-214` (add method near other session methods)
- Test: `test/unit/session-status-poller.test.ts`

**Step 1: Add the `SessionStatus` type export to `opencode-client.ts`**

Add after the existing `SessionListOptions` interface (around line 29):

```typescript
export type SessionStatus =
	| { type: "idle" }
	| { type: "busy" }
	| { type: "retry"; attempt: number; message: string; next: number };
```

**Step 2: Add `getSessionStatuses()` method to `OpenCodeClient`**

Add after the `updateSession` method (after line 236):

```typescript
	/** Get the current status of all sessions */
	async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
		const res = await this.get("/session/status");
		if (typeof res === "object" && res !== null && !Array.isArray(res)) {
			return res as Record<string, SessionStatus>;
		}
		return {};
	}
```

**Step 3: No test for this step alone** — it will be tested via the poller in Task 2.

**Step 4: Commit**

```bash
git add src/lib/opencode-client.ts
git commit -m "feat: add SessionStatus type and getSessionStatuses() to OpenCodeClient"
```

---

### Task 2: Create `SessionStatusPoller`

**Files:**
- Create: `src/lib/session-status-poller.ts`
- Create: `test/unit/session-status-poller.test.ts`

**Step 1: Write failing tests for `SessionStatusPoller`**

Create `test/unit/session-status-poller.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SessionStatusPoller,
	type SessionStatusPollerOptions,
} from "../../src/lib/session-status-poller.js";
import type { SessionStatus } from "../../src/lib/opencode-client.js";

function createMockClient(
	statuses: Record<string, SessionStatus> = {},
) {
	return {
		getSessionStatuses: vi.fn().mockResolvedValue(statuses),
	};
}

describe("SessionStatusPoller", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits 'changed' when a session transitions from idle to busy", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll: establishes baseline
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).not.toHaveBeenCalled();

		// Session becomes busy
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		const statuses = changed.mock.calls[0][0] as Record<string, SessionStatus>;
		expect(statuses.sess_1).toEqual({ type: "busy" });

		poller.stop();
	});

	it("emits 'changed' when a session transitions from busy to idle", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll: baseline
		await vi.advanceTimersByTimeAsync(500);
		expect(changed).not.toHaveBeenCalled();

		// Session becomes idle
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("does NOT emit 'changed' when statuses are unchanged", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// First poll
		await vi.advanceTimersByTimeAsync(500);
		// Second poll, same state
		await vi.advanceTimersByTimeAsync(500);
		// Third poll, same state
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).not.toHaveBeenCalled();
		poller.stop();
	});

	it("emits 'changed' when a new session appears", async () => {
		const client = createMockClient({ sess_1: { type: "idle" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// New session appears
		client.getSessionStatuses.mockResolvedValue({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("emits 'changed' when a session disappears", async () => {
		const client = createMockClient({
			sess_1: { type: "idle" },
			sess_2: { type: "busy" },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// sess_2 disappears
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "idle" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("keeps last known state on poll failure (stale > empty)", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const log = vi.fn();
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log,
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// API fails
		client.getSessionStatuses.mockRejectedValue(new Error("network error"));
		await vi.advanceTimersByTimeAsync(500);

		// Should NOT emit changed (stale state preserved)
		expect(changed).not.toHaveBeenCalled();
		// Should still have old state
		expect(poller.getCurrentStatuses()).toEqual({ sess_1: { type: "busy" } });
		// Should have logged the error
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("poll failed"),
		);

		poller.stop();
	});

	it("getCurrentStatuses() returns current state", async () => {
		const client = createMockClient({ sess_1: { type: "busy" } });
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		poller.start();

		// Before first poll
		expect(poller.getCurrentStatuses()).toEqual({});

		// After first poll
		await vi.advanceTimersByTimeAsync(500);
		expect(poller.getCurrentStatuses()).toEqual({ sess_1: { type: "busy" } });

		poller.stop();
	});

	it("isProcessing() returns true for busy and retry sessions", async () => {
		const client = createMockClient({
			sess_1: { type: "busy" },
			sess_2: { type: "retry", attempt: 1, message: "rate limited", next: Date.now() + 5000 },
			sess_3: { type: "idle" },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		poller.start();
		await vi.advanceTimersByTimeAsync(500);

		expect(poller.isProcessing("sess_1")).toBe(true);
		expect(poller.isProcessing("sess_2")).toBe(true);
		expect(poller.isProcessing("sess_3")).toBe(false);
		expect(poller.isProcessing("nonexistent")).toBe(false);

		poller.stop();
	});

	it("stop() clears the timer and prevents further polls", async () => {
		const client = createMockClient({});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		poller.start();
		await vi.advanceTimersByTimeAsync(500);
		expect(client.getSessionStatuses).toHaveBeenCalledTimes(1);

		poller.stop();
		await vi.advanceTimersByTimeAsync(2000);
		expect(client.getSessionStatuses).toHaveBeenCalledTimes(1);
	});

	it("handles retry status type in diff detection", async () => {
		const client = createMockClient({
			sess_1: { type: "retry", attempt: 1, message: "rate limited", next: 1000 },
		});
		const poller = new SessionStatusPoller({
			client: client as unknown as SessionStatusPollerOptions["client"],
			interval: 500,
			log: vi.fn(),
		});

		const changed = vi.fn();
		poller.on("changed", changed);
		poller.start();

		// Baseline
		await vi.advanceTimersByTimeAsync(500);

		// retry → busy (still processing but status type changed)
		client.getSessionStatuses.mockResolvedValue({ sess_1: { type: "busy" } });
		await vi.advanceTimersByTimeAsync(500);

		expect(changed).toHaveBeenCalledTimes(1);
		poller.stop();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/session-status-poller.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `SessionStatusPoller`**

Create `src/lib/session-status-poller.ts`:

```typescript
// ─── Session Status Poller ───────────────────────────────────────────────────
// Polls OpenCode's GET /session/status endpoint at a fixed interval, diffs
// against previous state, and emits a "changed" event when any session's
// status transitions. Exposes getCurrentStatuses() for on-demand reads.

import { EventEmitter } from "node:events";
import type { OpenCodeClient, SessionStatus } from "./opencode-client.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SessionStatusPollerOptions {
	client: Pick<OpenCodeClient, "getSessionStatuses">;
	/** Polling interval in milliseconds (default: 500) */
	interval?: number;
	log?: (...args: unknown[]) => void;
}

export interface SessionStatusPollerEvents {
	/** Emitted when any session's status has changed since the last poll */
	changed: [statuses: Record<string, SessionStatus>];
}

// ─── Poller ──────────────────────────────────────────────────────────────────

export class SessionStatusPoller extends EventEmitter<SessionStatusPollerEvents> {
	private readonly client: Pick<OpenCodeClient, "getSessionStatuses">;
	private readonly interval: number;
	private readonly log: (...args: unknown[]) => void;
	private timer: ReturnType<typeof setInterval> | null = null;
	private previous: Record<string, SessionStatus> = {};
	private polling = false;

	constructor(options: SessionStatusPollerOptions) {
		super();
		this.client = options.client;
		this.interval = options.interval ?? 500;
		this.log = options.log ?? (() => {});
	}

	/** Start polling. Safe to call multiple times (idempotent). */
	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.poll();
		}, this.interval);
		// Don't keep the process alive just for this timer
		if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
			this.timer.unref();
		}
	}

	/** Stop polling and clear the timer. */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	/** Get the most recently polled statuses. */
	getCurrentStatuses(): Record<string, SessionStatus> {
		return { ...this.previous };
	}

	/** Check if a specific session is currently processing (busy or retry). */
	isProcessing(sessionId: string): boolean {
		const status = this.previous[sessionId];
		if (!status) return false;
		return status.type === "busy" || status.type === "retry";
	}

	// ─── Internal ──────────────────────────────────────────────────────────

	private async poll(): Promise<void> {
		// Guard against overlapping polls
		if (this.polling) return;
		this.polling = true;

		try {
			const current = await this.client.getSessionStatuses();
			const changed = this.hasChanged(this.previous, current);

			if (changed) {
				this.previous = current;
				this.emit("changed", current);
			} else if (!this.hasSameKeys(this.previous, current)) {
				// Keys changed but no status type change — still update internal state
				this.previous = current;
			}
		} catch (err) {
			// Keep last known state (stale > empty). Log and retry next tick.
			const msg = err instanceof Error ? err.message : String(err);
			this.log(`   [status-poller] poll failed: ${msg}`);
		} finally {
			this.polling = false;
		}
	}

	/** Check if any session's status type has changed, or sessions added/removed. */
	private hasChanged(
		prev: Record<string, SessionStatus>,
		next: Record<string, SessionStatus>,
	): boolean {
		const prevKeys = Object.keys(prev);
		const nextKeys = Object.keys(next);

		// Different number of sessions
		if (prevKeys.length !== nextKeys.length) return true;

		// Check each session
		for (const key of nextKeys) {
			const prevStatus = prev[key];
			const nextStatus = next[key]!;

			// New session
			if (!prevStatus) return true;

			// Status type changed
			if (prevStatus.type !== nextStatus.type) return true;
		}

		// Check for removed sessions
		for (const key of prevKeys) {
			if (!(key in next)) return true;
		}

		return false;
	}

	private hasSameKeys(
		a: Record<string, unknown>,
		b: Record<string, unknown>,
	): boolean {
		const aKeys = Object.keys(a);
		const bKeys = Object.keys(b);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every((k) => k in b);
	}
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/session-status-poller.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/lib/session-status-poller.ts test/unit/session-status-poller.test.ts
git commit -m "feat: add SessionStatusPoller with diff-based change detection"
```

---

### Task 3: Modify `SessionManager.listSessions()` to accept optional statuses

**Files:**
- Modify: `src/lib/session-manager.ts:67-78` (listSessions), `:203-213` (toSessionInfoList)
- Test: `test/unit/session-manager-processing.test.ts`

**Step 1: Write failing test**

Create `test/unit/session-manager-processing.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/lib/session-manager.js";
import type { SessionStatus } from "../../src/lib/opencode-client.js";

describe("SessionManager.listSessions — processing flag", () => {
	let mgr: SessionManager;
	const mockSessions = [
		{ id: "sess_1", title: "Session 1", time: { updated: 1000 } },
		{ id: "sess_2", title: "Session 2", time: { updated: 2000 } },
		{ id: "sess_3", title: "Session 3", time: { updated: 500 } },
	];

	beforeEach(() => {
		mgr = new SessionManager({
			client: {
				listSessions: vi.fn().mockResolvedValue(mockSessions),
			} as unknown as ConstructorParameters<typeof SessionManager>[0]["client"],
			log: vi.fn(),
		});
	});

	it("sets processing=true for busy sessions when statuses provided", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "busy" },
			sess_2: { type: "idle" },
			sess_3: { type: "idle" },
		};

		const sessions = await mgr.listSessions(statuses);

		const s1 = sessions.find((s) => s.id === "sess_1");
		const s2 = sessions.find((s) => s.id === "sess_2");
		expect(s1?.processing).toBe(true);
		expect(s2?.processing).toBeUndefined();
	});

	it("sets processing=true for retry sessions when statuses provided", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "retry", attempt: 1, message: "rate limited", next: 9999 },
			sess_2: { type: "idle" },
		};

		const sessions = await mgr.listSessions(statuses);

		const s1 = sessions.find((s) => s.id === "sess_1");
		expect(s1?.processing).toBe(true);
	});

	it("does not set processing when statuses not provided", async () => {
		const sessions = await mgr.listSessions();

		for (const s of sessions) {
			expect(s.processing).toBeUndefined();
		}
	});

	it("handles statuses with session IDs not in the session list", async () => {
		const statuses: Record<string, SessionStatus> = {
			sess_1: { type: "busy" },
			sess_unknown: { type: "busy" },
		};

		const sessions = await mgr.listSessions(statuses);

		// sess_unknown is not in the list, should not crash
		expect(sessions).toHaveLength(3);
		const s1 = sessions.find((s) => s.id === "sess_1");
		expect(s1?.processing).toBe(true);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/session-manager-processing.test.ts`
Expected: FAIL — `listSessions` does not accept arguments

**Step 3: Modify `session-manager.ts`**

In `src/lib/session-manager.ts`:

1. Add import for `SessionStatus`:

```typescript
import type {
	Message,
	OpenCodeClient,
	SessionDetail,
	SessionStatus,
} from "./opencode-client.js";
```

2. Modify `listSessions()` signature (line 67):

Replace:
```typescript
	async listSessions(): Promise<SessionInfo[]> {
		const sessions = await this.client.listSessions();
		if (this.log) {
			this.log(
				`   [session] listSessions: directory=${this.directory ?? "none"} returned=${sessions.length} ids=[${sessions
					.slice(0, 5)
					.map((s) => s.id.slice(0, 12))
					.join(",")}${sessions.length > 5 ? "..." : ""}]`,
			);
		}
		return toSessionInfoList(sessions);
	}
```

With:
```typescript
	async listSessions(statuses?: Record<string, SessionStatus>): Promise<SessionInfo[]> {
		const sessions = await this.client.listSessions();
		if (this.log) {
			this.log(
				`   [session] listSessions: directory=${this.directory ?? "none"} returned=${sessions.length} ids=[${sessions
					.slice(0, 5)
					.map((s) => s.id.slice(0, 12))
					.join(",")}${sessions.length > 5 ? "..." : ""}]`,
			);
		}
		return toSessionInfoList(sessions, statuses);
	}
```

3. Modify `toSessionInfoList()` helper (line 203):

Replace:
```typescript
function toSessionInfoList(sessions: SessionDetail[]): SessionInfo[] {
	return sessions
		.map((s) => ({
			id: s.id,
			title: s.title ?? "Untitled",
			updatedAt: s.time?.updated ?? s.time?.created ?? 0,
			messageCount: 0,
			parentID: s.parentID,
		}))
		.sort((a, b) => b.updatedAt - a.updatedAt);
}
```

With:
```typescript
function toSessionInfoList(
	sessions: SessionDetail[],
	statuses?: Record<string, SessionStatus>,
): SessionInfo[] {
	return sessions
		.map((s) => {
			const info: SessionInfo = {
				id: s.id,
				title: s.title ?? "Untitled",
				updatedAt: s.time?.updated ?? s.time?.created ?? 0,
				messageCount: 0,
				parentID: s.parentID,
			};
			if (statuses) {
				const status = statuses[s.id];
				if (status && (status.type === "busy" || status.type === "retry")) {
					info.processing = true;
				}
			}
			return info;
		})
		.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
}
```

4. Also update `searchSessions` to forward statuses (optional but consistent):

This method also calls `toSessionInfoList` — for now, leave it without statuses since search doesn't need processing state. No change needed.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/session-manager-processing.test.ts`
Expected: ALL PASS

**Step 5: Run full test suite to check for regressions**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/lib/session-manager.ts test/unit/session-manager-processing.test.ts
git commit -m "feat: SessionManager.listSessions() accepts optional statuses for processing flag"
```

---

### Task 4: Wire `SessionStatusPoller` into `relay-stack.ts`

**Files:**
- Modify: `src/lib/relay-stack.ts:19-31` (imports), `:108-484` (createProjectRelay)
- Modify: `src/lib/sse-wiring.ts:155-168` (session.updated handler — pass statuses)

**Step 1: No new test file for wiring** — this is integration glue. The unit tests for poller + session manager already cover the logic. Integration tests will verify end-to-end.

**Step 2: Wire the poller into `createProjectRelay()` in `relay-stack.ts`**

1. Add import at the top of `relay-stack.ts` (after line 29):

```typescript
import { SessionStatusPoller } from "./session-status-poller.js";
```

2. After the `overrides` creation (after line 141), create the poller:

```typescript
	// ── Session status poller (polls GET /session/status for processing indicators) ──
	const statusPoller = new SessionStatusPoller({ client, interval: 500, log });
```

3. After SSE wiring is complete (after line 420, after `await sseConsumer.connect()`), start the poller and wire its events:

```typescript
	// ── Session status poller wiring ────────────────────────────────────────
	statusPoller.on("changed", async (statuses) => {
		try {
			const sessions = await sessionMgr.listSessions(statuses);
			wsHandler.broadcast({ type: "session_list", sessions });
		} catch (err) {
			log(`   [status-poller] Failed to broadcast session list: ${err instanceof Error ? err.message : err}`);
		}
	});
	statusPoller.start();
```

4. Add the poller to the `ProjectRelay` interface (add to the interface around line 41):

```typescript
export interface ProjectRelay {
	// ... existing fields ...
	statusPoller: SessionStatusPoller;
	// ...
}
```

5. Return the poller in the object (around line 466):

```typescript
	return {
		// ... existing fields ...
		statusPoller,
		// ...
	};
```

6. Stop the poller in the `stop()` method (around line 477):

```typescript
	async stop() {
		clearInterval(timeoutTimer);
		clearInterval(rateLimitCleanupTimer);
		statusPoller.stop();
		overrides.dispose();
		ptyManager.closeAll();
		await sseConsumer.disconnect();
		wsHandler.close();
	},
```

7. Update `sse-wiring.ts` `session.updated` handler (lines 157-168) to include statuses:

The existing handler calls `sessionMgr.listSessions()` without statuses. We need the poller's current state here. However, `sse-wiring.ts` doesn't have access to the poller — and the design says "existing session.updated handler continues unchanged." 

Instead, add the poller to `SSEWiringDeps` so the session.updated handler can include processing state:

In `src/lib/sse-wiring.ts`, add to `SSEWiringDeps` interface (line 76):

```typescript
export interface SSEWiringDeps {
	// ... existing fields ...
	/** Optional: current session statuses for processing flags */
	getSessionStatuses?: () => Record<string, import("./opencode-client.js").SessionStatus>;
	// ...
}
```

Update the `session.updated` handler (lines 157-168):

Replace:
```typescript
	if (event.type === "session.updated") {
		sessionMgr
			.listSessions()
			.then((sessions) => {
				wsHandler.broadcast({ type: "session_list", sessions });
			})
```

With:
```typescript
	if (event.type === "session.updated") {
		const statuses = deps.getSessionStatuses?.();
		sessionMgr
			.listSessions(statuses)
			.then((sessions) => {
				wsHandler.broadcast({ type: "session_list", sessions });
			})
```

And in `relay-stack.ts`, update the `wireSSEConsumer` call (around line 406) to include `getSessionStatuses`:

```typescript
	wireSSEConsumer(
		{
			translator,
			sessionMgr,
			messageCache,
			permissionBridge,
			questionBridge,
			overrides,
			toolContentStore,
			wsHandler,
			pushManager: config.pushManager,
			log,
			getSessionStatuses: () => statusPoller.getCurrentStatuses(),
		},
		sseConsumer,
	);
```

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS (SSE wiring tests should still pass since `getSessionStatuses` is optional)

**Step 4: Commit**

```bash
git add src/lib/relay-stack.ts src/lib/sse-wiring.ts src/lib/session-status-poller.ts
git commit -m "feat: wire SessionStatusPoller into relay stack for live processing broadcasts"
```

---

### Task 5: Fix `client-init.ts` — correct initial status on connect

**Files:**
- Modify: `src/lib/client-init.ts:22-35` (deps interface), `:74-108` (status logic), `:139-145` (session list)
- Modify: `test/unit/client-init.test.ts`

**Step 1: Write failing tests in `test/unit/client-init.test.ts`**

Add new describe block at the end of the file:

```typescript
// ─── Processing status on connect ────────────────────────────────────────────

describe("handleClientConnected — processing status on connect", () => {
	it("sends status 'processing' when active session is busy", async () => {
		const deps = createMockDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(true),
				getCurrentStatuses: vi.fn().mockReturnValue({ "session-1": { type: "busy" } }),
			} as unknown as ClientInitDeps["statusPoller"],
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "processing",
		});
	});

	it("sends status 'idle' when active session is not busy", async () => {
		const deps = createMockDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
				getCurrentStatuses: vi.fn().mockReturnValue({}),
			} as unknown as ClientInitDeps["statusPoller"],
		});

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "idle",
		});
	});

	it("includes processing flags in initial session_list", async () => {
		const deps = createMockDeps({
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
				getCurrentStatuses: vi.fn().mockReturnValue({ s1: { type: "busy" } }),
			} as unknown as ClientInitDeps["statusPoller"],
		});

		await handleClientConnected(deps, "client-1");

		// sessionMgr.listSessions should have been called with statuses
		expect(deps.sessionMgr.listSessions).toHaveBeenCalledWith({ s1: { type: "busy" } });
	});

	it("falls back to idle when statusPoller is not provided", async () => {
		const deps = createMockDeps();
		// statusPoller is undefined by default in createMockDeps

		await handleClientConnected(deps, "client-1");

		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "status",
			status: "idle",
		});
	});
});
```

Also update `createMockDeps` to support the new `statusPoller` field. In the function around line 12, add:

```typescript
function createMockDeps(overrides?: Partial<ClientInitDeps>): ClientInitDeps {
	return {
		// ... existing fields ...
		statusPoller: undefined,
		...overrides,
	};
}
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client-init.test.ts`
Expected: FAIL — `statusPoller` not in `ClientInitDeps`

**Step 3: Modify `client-init.ts`**

1. Add `statusPoller` to `ClientInitDeps` (around line 22):

```typescript
import type { SessionStatusPoller } from "./session-status-poller.js";
```

Add to interface:
```typescript
export interface ClientInitDeps {
	// ... existing fields ...
	/** Optional poller for session processing state */
	statusPoller?: Pick<SessionStatusPoller, "isProcessing" | "getCurrentStatuses">;
}
```

2. Fix line 108 — replace hardcoded idle with actual status check:

Replace:
```typescript
		wsHandler.sendTo(clientId, { type: "status", status: "idle" });
```

With:
```typescript
		const isProcessing = deps.statusPoller?.isProcessing(activeId) ?? false;
		wsHandler.sendTo(clientId, {
			type: "status",
			status: isProcessing ? "processing" : "idle",
		});
```

3. Update session list to include processing statuses (lines 140-145):

Replace:
```typescript
	try {
		const sessions = await sessionMgr.listSessions();
		wsHandler.sendTo(clientId, { type: "session_list", sessions });
	}
```

With:
```typescript
	try {
		const statuses = deps.statusPoller?.getCurrentStatuses();
		const sessions = await sessionMgr.listSessions(statuses);
		wsHandler.sendTo(clientId, { type: "session_list", sessions });
	}
```

4. In `relay-stack.ts`, update `clientInitDeps` (around line 275) to include the poller:

```typescript
	const clientInitDeps: ClientInitDeps = {
		wsHandler,
		client,
		sessionMgr,
		messageCache,
		overrides,
		ptyManager,
		permissionBridge,
		questionBridge,
		log,
		statusPoller,
	};
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client-init.test.ts`
Expected: ALL PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 6: Commit**

```bash
git add src/lib/client-init.ts src/lib/relay-stack.ts test/unit/client-init.test.ts
git commit -m "fix: send correct processing status on client connect instead of hardcoded idle"
```

---

### Task 6: Fix `handleSwitchSession` — send status after switching

**Files:**
- Modify: `src/lib/handlers/session.ts:30-105`
- Modify: `src/lib/handlers/types.ts:14-31` (add statusPoller to HandlerDeps)
- Modify: `test/unit/handlers-session.test.ts`

**Step 1: Write failing tests**

Add to `test/unit/handlers-session.test.ts` (new describe block):

```typescript
import { handleSwitchSession } from "../../src/lib/handlers/session.js";

describe("handleSwitchSession — processing status (Bug 3)", () => {
	let deps: HandlerDeps;
	let broadcastCalls: unknown[];

	beforeEach(() => {
		broadcastCalls = [];
		deps = {
			wsHandler: {
				broadcast: (msg: unknown) => broadcastCalls.push(msg),
				broadcastExcept: vi.fn(),
				sendTo: vi.fn(),
			},
			client: {
				getSession: vi.fn().mockResolvedValue({
					id: "sess_target",
					modelID: "gpt-4",
					providerID: "openai",
				}),
			},
			sessionMgr: {
				getActiveSessionId: () => "sess_current",
				switchSession: vi.fn(),
				loadHistory: vi.fn().mockResolvedValue({
					messages: [],
					hasMore: false,
					total: 0,
				}),
			},
			messageCache: {
				getEvents: vi.fn().mockReturnValue(null),
			},
			overrides: { clear: vi.fn() },
			statusPoller: {
				isProcessing: vi.fn().mockReturnValue(false),
			},
			log: vi.fn(),
		} as unknown as HandlerDeps;
	});

	it("broadcasts status 'processing' when switched-to session is busy", async () => {
		(deps.statusPoller as { isProcessing: ReturnType<typeof vi.fn> }).isProcessing.mockReturnValue(true);

		await handleSwitchSession(deps, "client-1", { sessionId: "sess_target" });

		const statusMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>).type === "status",
		) as { type: string; status: string } | undefined;
		expect(statusMsg).toBeDefined();
		expect(statusMsg!.status).toBe("processing");
	});

	it("does NOT broadcast status when switched-to session is idle", async () => {
		await handleSwitchSession(deps, "client-1", { sessionId: "sess_target" });

		const statusMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>).type === "status",
		);
		expect(statusMsg).toBeUndefined();
	});

	it("gracefully handles missing statusPoller", async () => {
		(deps as { statusPoller?: unknown }).statusPoller = undefined;

		await handleSwitchSession(deps, "client-1", { sessionId: "sess_target" });

		// Should not crash, should not send status
		const statusMsg = broadcastCalls.find(
			(m) => (m as Record<string, unknown>).type === "status",
		);
		expect(statusMsg).toBeUndefined();
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/handlers-session.test.ts`
Expected: FAIL — `statusPoller` not on `HandlerDeps`

**Step 3: Add `statusPoller` to `HandlerDeps`**

In `src/lib/handlers/types.ts`, add:

```typescript
import type { SessionStatusPoller } from "../session-status-poller.js";
```

Add to `HandlerDeps` interface (after `log`):

```typescript
	/** Optional session status poller for processing state */
	statusPoller?: Pick<SessionStatusPoller, "isProcessing">;
```

**Step 4: Modify `handleSwitchSession` in `src/lib/handlers/session.ts`**

After the model info block (after line 103, before the final log line 104), add:

```typescript
	// Send processing status if the switched-to session is currently busy
	if (deps.statusPoller?.isProcessing(id)) {
		deps.wsHandler.broadcast({ type: "status", status: "processing" });
	}
```

**Step 5: Wire `statusPoller` into `handlerDeps` in `relay-stack.ts`**

In `relay-stack.ts`, update the `handlerDeps` object (around line 360):

```typescript
	const handlerDeps: HandlerDeps = {
		// ... existing fields ...
		statusPoller,
	};
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/handlers-session.test.ts`
Expected: ALL PASS

**Step 7: Run full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 8: Commit**

```bash
git add src/lib/handlers/types.ts src/lib/handlers/session.ts src/lib/relay-stack.ts test/unit/handlers-session.test.ts
git commit -m "fix: send processing status after session switch when target session is busy"
```

---

### Task 7: Final verification and cleanup

**Files:**
- All modified files

**Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Run the TypeScript compiler to check for type errors**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 3: Run the linter**

Run: `npx biome check src/lib/session-status-poller.ts src/lib/opencode-client.ts src/lib/session-manager.ts src/lib/client-init.ts src/lib/handlers/session.ts src/lib/handlers/types.ts src/lib/relay-stack.ts src/lib/sse-wiring.ts`
Expected: No errors (or fix any found)

**Step 4: Verify the build works**

Run: `npm run build` (if build script exists, otherwise skip)

**Step 5: Commit any lint fixes**

```bash
git add -A
git commit -m "chore: lint fixes for session processing status feature"
```

---

## Summary of all changes

| File | Change |
|------|--------|
| `src/lib/opencode-client.ts` | Add `SessionStatus` type + `getSessionStatuses()` method |
| `src/lib/session-status-poller.ts` | **NEW** — Poller class with diff detection + EventEmitter |
| `src/lib/session-manager.ts` | `listSessions(statuses?)` + `toSessionInfoList` merges processing flag |
| `src/lib/client-init.ts` | Check poller for initial status; pass statuses to session list |
| `src/lib/handlers/session.ts` | `handleSwitchSession` sends status after switching |
| `src/lib/handlers/types.ts` | Add `statusPoller?` to `HandlerDeps` |
| `src/lib/relay-stack.ts` | Create poller, wire events, pass to deps |
| `src/lib/sse-wiring.ts` | `session.updated` handler includes statuses |
| `test/unit/session-status-poller.test.ts` | **NEW** — Full poller unit tests |
| `test/unit/session-manager-processing.test.ts` | **NEW** — Processing flag tests |
| `test/unit/client-init.test.ts` | Add processing status tests |
| `test/unit/handlers-session.test.ts` | Add switch-session status tests |
