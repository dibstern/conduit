# Fork Resilience Refactors — Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Centralize all session-switch logic into a single, type-safe module so that no handler can construct a bare `session_switched` message, and conduit-owned fields are protected by regression tests.

**Architecture:** Extract a `session-switch.ts` module in `src/lib/session/` containing pure functions (`classifyHistorySource`, `buildSessionSwitchedMessage`) and an async orchestrator (`switchClientToSession`). Refactor `handleViewSession`, `handleNewSession`, and `handleClientConnected` to delegate to this module. Remove the `SessionManager.createSession` bare broadcast and its relay-stack augmenter. Add regression tests for conduit-owned field survival across session-list refreshes.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), Vitest, existing mock factories from `test/helpers/mock-factories.ts`.

---

## Background

Two structural issues make fork-related bugs easy to introduce:

1. **Bare `session_switched` sends bypass message loading.** `handleViewSession` is the only function that correctly loads messages (from cache or REST), sets the client-session association, syncs processing status, and seeds pollers. But 3 other call sites construct `session_switched` manually: `handleNewSession` (session.ts:228-235), `handleClientConnected` (client-init.ts:100-129), and `SessionManager.createSession` (session-manager.ts:203). Each is a potential bug vector.

2. **`session_list` replaces conduit-owned fields.** The frontend's `handleSessionList` does a full array replacement (`sessionState.allSessions = sessions`). Any conduit-owned field set by an earlier message (`session_forked`, etc.) is silently destroyed. The server-side fix (enriching via `toSessionInfoList`) is already in place, but the pattern has no regression tests and no documentation for future contributors.

## Audit Summary

### session_switched send sites (9 total, 4 bypass handleViewSession)

| # | Location | Method | Through handleViewSession? |
|---|----------|--------|---------------------------|
| A | `handlers/session.ts:150-155` | sendTo (cache hit) | YES (is handleViewSession) |
| B | `handlers/session.ts:160-169` | sendTo (REST fallback) | YES |
| C | `handlers/session.ts:175-179` | sendTo (error fallback) | YES |
| D | `handlers/session.ts:228-235` | sendTo | **NO** (handleNewSession) |
| E | `bridges/client-init.ts:102-107` | sendTo (cache hit) | **NO** (handleClientConnected) |
| F | `bridges/client-init.ts:112-121` | sendTo (REST fallback) | **NO** |
| G | `bridges/client-init.ts:124-128` | sendTo (error fallback) | **NO** |
| H | `session/session-manager.ts:203` | broadcast (via emit) | **NO** (createSession) |
| I | `relay/session-lifecycle-wiring.ts:56-74` | broadcast (augments H) | **NO** (augmenter) |

### Handlers that trigger session switches correctly (delegate to handleViewSession)

- `handleSwitchSession` (session.ts:258-263) — pure alias
- `handleDeleteSession` (session.ts:266-306) — calls handleViewSession per viewer
- `handleForkSession` (session.ts:368-440) — calls handleViewSession after fork

### Conduit-owned fields on SessionInfo

| Field | Source | Written By | Enriched By |
|-------|--------|-----------|-------------|
| `parentID` | Fork metadata (user forks) or OpenCode (subagent) | `handleForkSession:402` | `toSessionInfoList:413` |
| `forkMessageId` | Fork metadata only | `handleForkSession:403` | `toSessionInfoList:421` |
| `processing` | Status poller (derived) | N/A | `toSessionInfoList:423-427` |

### Missing test coverage

1. No test for `toSessionInfoList` fork metadata enrichment (only OpenCode-sourced `parentID` is tested)
2. No regression test for: fork → session_forked received → session_list replaces allSessions → conduit-owned fields survive
3. No test verifying `handleNewSession` sends correct session_switched payload

---

## Type Definitions

### New types in `src/lib/session/session-switch.ts`

```typescript
import type { RequestId, HistoryMessage } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

// ─── Pure data types ────────────────────────────────────────────────────────

/** Discriminated union describing where session history came from. */
export type SessionHistorySource =
  | { readonly kind: "cached-events"; readonly events: readonly RelayMessage[] }
  | {
      readonly kind: "rest-history";
      readonly history: {
        readonly messages: readonly HistoryMessage[];
        readonly hasMore: boolean;
        readonly total?: number;
      };
    }
  | { readonly kind: "empty" };

/** Options for building the session_switched message. */
export interface SessionSwitchMessageOptions {
  readonly draft?: string;
  readonly requestId?: RequestId;
}

/** Options for the switchClientToSession orchestrator. */
export interface SwitchClientOptions {
  readonly requestId?: RequestId;
  /** Skip cache/REST history lookup — send empty session_switched. Default: false. */
  readonly skipHistory?: boolean;
  /** Skip poller seeding. Default: false. */
  readonly skipPollerSeed?: boolean;
}

// ─── Dependency interface (principle of least privilege) ────────────────────

/** Narrowed deps for switchClientToSession — only what's needed, nothing more. */
export interface SessionSwitchDeps {
  readonly messageCache: { getEvents(sessionId: string): RelayMessage[] | null };
  readonly sessionMgr: {
    loadPreRenderedHistory(
      sessionId: string,
      offset?: number,
    ): Promise<{
      messages: HistoryMessage[];
      hasMore: boolean;
      total?: number;
    }>;
  };
  readonly wsHandler: {
    sendTo(clientId: string, msg: RelayMessage): void;
    setClientSession(clientId: string, sessionId: string): void;
  };
  readonly statusPoller?: { isProcessing(sessionId: string): boolean };
  readonly pollerManager?: {
    isPolling(sessionId: string): boolean;
    startPolling(sessionId: string, messages: unknown[]): void;
  };
  readonly client: { getMessages(sessionId: string): Promise<unknown[]> };
  readonly log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  readonly getInputDraft: (sessionId: string) => string | undefined;
}
```

### Functional purity contracts

| Function | Pure? | Inputs | Output | Side effects |
|----------|-------|--------|--------|-------------|
| `classifyHistorySource` | **Yes** | cached events array | `"cached-events" \| "needs-rest"` | None |
| `buildSessionSwitchedMessage` | **Yes** | sessionId, source, options | `session_switched` message | None |
| `resolveSessionHistory` | No | sessionId, deps | `SessionHistorySource` | Reads cache, may call REST API |
| `switchClientToSession` | No | deps, clientId, sessionId, options | void | Sends WS messages, sets client session, seeds poller |

---

## Task 1: Scaffold session-switch module with types

**Files:**
- Create: `src/lib/session/session-switch.ts`

**Step 1: Create the module with type definitions only**

```typescript
// src/lib/session/session-switch.ts
// ─── Session Switch — Centralized session switching ─────────────────────────
// Single entry point for all session switches. Handlers delegate here instead
// of constructing session_switched messages manually.

import type { HistoryMessage, RequestId } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

// ─── Pure data types ────────────────────────────────────────────────────────

/** Discriminated union describing where session history came from. */
export type SessionHistorySource =
	| { readonly kind: "cached-events"; readonly events: readonly RelayMessage[] }
	| {
			readonly kind: "rest-history";
			readonly history: {
				readonly messages: readonly HistoryMessage[];
				readonly hasMore: boolean;
				readonly total?: number;
			};
	  }
	| { readonly kind: "empty" };

/** Options for building the session_switched message. */
export interface SessionSwitchMessageOptions {
	readonly draft?: string;
	readonly requestId?: RequestId;
}

/** Options for the switchClientToSession orchestrator. */
export interface SwitchClientOptions {
	readonly requestId?: RequestId;
	/** Skip cache/REST history lookup — send empty session_switched. Default: false. */
	readonly skipHistory?: boolean;
	/** Skip poller seeding. Default: false. */
	readonly skipPollerSeed?: boolean;
}

// ─── Dependency interface (principle of least privilege) ────────────────────

/** Narrowed deps for switchClientToSession — only what's needed, nothing more. */
export interface SessionSwitchDeps {
	readonly messageCache: {
		getEvents(sessionId: string): RelayMessage[] | null;
	};
	readonly sessionMgr: {
		loadPreRenderedHistory(
			sessionId: string,
			offset?: number,
		): Promise<{
			messages: HistoryMessage[];
			hasMore: boolean;
			total?: number;
		}>;
	};
	readonly wsHandler: {
		sendTo(clientId: string, msg: RelayMessage): void;
		setClientSession(clientId: string, sessionId: string): void;
	};
	readonly statusPoller?: { isProcessing(sessionId: string): boolean };
	readonly pollerManager?: {
		isPolling(sessionId: string): boolean;
		startPolling(sessionId: string, messages: unknown[]): void;
	};
	readonly client: {
		getMessages(sessionId: string): Promise<unknown[]>;
	};
	readonly log: {
		info(...args: unknown[]): void;
		warn(...args: unknown[]): void;
	};
	readonly getInputDraft: (sessionId: string) => string | undefined;
}
```

**Step 2: Verify types compile**

Run: `pnpm check`
Expected: PASS (no errors — module exports types only, no consumers yet)

**Step 3: Commit**

```bash
git add src/lib/session/session-switch.ts
git commit -m "feat: scaffold session-switch module with type definitions"
```

---

## Task 2: TDD `classifyHistorySource` (pure function)

**Files:**
- Create: `test/unit/session/session-switch.test.ts`
- Modify: `src/lib/session/session-switch.ts`

**Step 1: Write the failing tests**

```typescript
// test/unit/session/session-switch.test.ts
import { describe, expect, it } from "vitest";
import { classifyHistorySource } from "../../../src/lib/session/session-switch.js";
import type { RelayMessage } from "../../../src/lib/types.js";

describe("classifyHistorySource", () => {
	it('returns "needs-rest" when events is null', () => {
		expect(classifyHistorySource(null)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is undefined', () => {
		expect(classifyHistorySource(undefined)).toBe("needs-rest");
	});

	it('returns "needs-rest" when events is empty array', () => {
		expect(classifyHistorySource([])).toBe("needs-rest");
	});

	it('returns "needs-rest" when events have no chat content (only status/done)', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("needs-rest");
	});

	it('returns "cached-events" when events contain user_message', () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events contain delta', () => {
		const events: RelayMessage[] = [
			{ type: "delta", text: "response" },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});

	it('returns "cached-events" when events have mixed content with at least one user_message', () => {
		const events: RelayMessage[] = [
			{ type: "status", status: "processing" },
			{ type: "user_message", text: "hello" },
			{ type: "done", code: 0 },
		];
		expect(classifyHistorySource(events)).toBe("cached-events");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: FAIL — `classifyHistorySource` is not exported (doesn't exist yet)

**Step 3: Write minimal implementation**

Append to `src/lib/session/session-switch.ts`:

```typescript
// ─── Pure functions ─────────────────────────────────────────────────────────

/**
 * Classify whether cached SSE events contain renderable chat content.
 * Pure function — no side effects, no I/O.
 */
export function classifyHistorySource(
	events: readonly RelayMessage[] | null | undefined,
): "cached-events" | "needs-rest" {
	if (!events || events.length === 0) return "needs-rest";
	const hasChatContent = events.some(
		(e) => e.type === "user_message" || e.type === "delta",
	);
	return hasChatContent ? "cached-events" : "needs-rest";
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch.test.ts
git commit -m "feat: add classifyHistorySource pure function with tests"
```

---

## Task 3: TDD `buildSessionSwitchedMessage` (pure function)

**Files:**
- Modify: `test/unit/session/session-switch.test.ts`
- Modify: `src/lib/session/session-switch.ts`

**Step 1: Write the failing tests**

Append to `test/unit/session/session-switch.test.ts`:

```typescript
import {
	classifyHistorySource,
	buildSessionSwitchedMessage,
	type SessionHistorySource,
} from "../../../src/lib/session/session-switch.js";
import type { RequestId } from "../../../src/lib/shared-types.js";

describe("buildSessionSwitchedMessage", () => {
	it("builds message from cached-events source", () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
		];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_1", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_1",
			events,
		});
	});

	it("builds message from rest-history source", () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const, parts: [] }],
			hasMore: true,
			total: 42,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_2", source);

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_2",
			history: { messages: history.messages, hasMore: true, total: 42 },
		});
	});

	it("omits total from history when undefined", () => {
		const history = {
			messages: [],
			hasMore: false,
		};
		const source: SessionHistorySource = { kind: "rest-history", history };
		const msg = buildSessionSwitchedMessage("ses_3", source);

		expect(msg.history).toEqual({ messages: [], hasMore: false });
		expect("total" in (msg.history ?? {})).toBe(false);
	});

	it("builds bare message from empty source", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_4", source);

		expect(msg).toEqual({ type: "session_switched", id: "ses_4" });
	});

	it("includes inputText when draft is provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_5", source, {
			draft: "work in progress",
		});

		expect(msg.inputText).toBe("work in progress");
	});

	it("omits inputText when draft is empty string", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_6", source, { draft: "" });

		expect("inputText" in msg).toBe(false);
	});

	it("omits inputText when draft is undefined", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_7", source, {});

		expect("inputText" in msg).toBe(false);
	});

	it("includes requestId when provided", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_8", source, {
			requestId: "req-abc" as RequestId,
		});

		expect(msg.requestId).toBe("req-abc");
	});

	it("omits requestId when not provided (exactOptionalPropertyTypes safe)", () => {
		const source: SessionHistorySource = { kind: "empty" };
		const msg = buildSessionSwitchedMessage("ses_9", source);

		expect("requestId" in msg).toBe(false);
	});

	it("includes both draft and requestId with cached-events", () => {
		const events: RelayMessage[] = [
			{ type: "delta", text: "hi" },
		];
		const source: SessionHistorySource = { kind: "cached-events", events };
		const msg = buildSessionSwitchedMessage("ses_10", source, {
			draft: "draft text",
			requestId: "req-xyz" as RequestId,
		});

		expect(msg).toEqual({
			type: "session_switched",
			id: "ses_10",
			events,
			inputText: "draft text",
			requestId: "req-xyz",
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: FAIL — `buildSessionSwitchedMessage` is not exported

**Step 3: Write minimal implementation**

Append to `src/lib/session/session-switch.ts`:

```typescript
/**
 * Build a session_switched message from resolved history source.
 * Pure function — no side effects, no I/O.
 *
 * @remarks Uses conditional spreads to satisfy exactOptionalPropertyTypes.
 * Never assigns `undefined` to optional properties.
 */
export function buildSessionSwitchedMessage(
	sessionId: string,
	source: SessionHistorySource,
	options?: SessionSwitchMessageOptions,
): Extract<RelayMessage, { type: "session_switched" }> {
	const optionalFields = {
		...(options?.draft ? { inputText: options.draft } : {}),
		...(options?.requestId != null ? { requestId: options.requestId } : {}),
	};

	switch (source.kind) {
		case "cached-events":
			return {
				type: "session_switched",
				id: sessionId,
				events: source.events as RelayMessage[],
				...optionalFields,
			};
		case "rest-history":
			return {
				type: "session_switched",
				id: sessionId,
				history: {
					messages: source.history.messages as HistoryMessage[],
					hasMore: source.history.hasMore,
					...(source.history.total != null
						? { total: source.history.total }
						: {}),
				},
				...optionalFields,
			};
		case "empty":
			return {
				type: "session_switched",
				id: sessionId,
				...optionalFields,
			};
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: PASS (all tests including Task 2's)

**Step 5: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch.test.ts
git commit -m "feat: add buildSessionSwitchedMessage pure function with tests"
```

---

## Task 4: TDD `resolveSessionHistory` (async, mock-tested)

**Files:**
- Modify: `test/unit/session/session-switch.test.ts`
- Modify: `src/lib/session/session-switch.ts`

**Step 1: Write the failing tests**

Append to `test/unit/session/session-switch.test.ts`:

```typescript
import { vi } from "vitest";
import {
	classifyHistorySource,
	buildSessionSwitchedMessage,
	resolveSessionHistory,
	type SessionHistorySource,
	type SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";

function createMinimalDeps(
	overrides?: Partial<Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log">>,
): Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log"> {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
		},
		log: { info: vi.fn(), warn: vi.fn() },
		...overrides,
	};
}

describe("resolveSessionHistory", () => {
	it("returns cached-events when cache has chat content", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hello" },
		];
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});

		const result = await resolveSessionHistory("ses_1", deps);

		expect(result.kind).toBe("cached-events");
		expect(result.kind === "cached-events" && result.events).toEqual(events);
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();
	});

	it("returns rest-history when cache misses", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
			total: 5,
		};
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_2", deps);

		expect(result.kind).toBe("rest-history");
		if (result.kind === "rest-history") {
			expect(result.history.messages).toEqual(history.messages);
			expect(result.history.hasMore).toBe(true);
			expect(result.history.total).toBe(5);
		}
	});

	it("returns rest-history when cache has events but no chat content", async () => {
		const events: RelayMessage[] = [{ type: "status", status: "idle" }];
		const history = { messages: [], hasMore: false };
		const deps = createMinimalDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		const result = await resolveSessionHistory("ses_3", deps);

		expect(result.kind).toBe("rest-history");
		expect(deps.sessionMgr.loadPreRenderedHistory).toHaveBeenCalledWith(
			"ses_3",
		);
	});

	it("returns empty when REST API fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("API down")),
			},
		});

		const result = await resolveSessionHistory("ses_4", deps);

		expect(result.kind).toBe("empty");
		expect(deps.log.warn).toHaveBeenCalled();
	});

	it("logs the session ID and error when REST fails", async () => {
		const deps = createMinimalDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("timeout")),
			},
		});

		await resolveSessionHistory("ses_5", deps);

		const warnCall = vi.mocked(deps.log.warn).mock.calls[0]?.[0] as string;
		expect(warnCall).toContain("ses_5");
		expect(warnCall).toContain("timeout");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: FAIL — `resolveSessionHistory` is not exported

**Step 3: Write minimal implementation**

Append to `src/lib/session/session-switch.ts`:

```typescript
/**
 * Resolve session history from cache or REST API.
 * Impure — reads from cache and may call REST.
 */
export async function resolveSessionHistory(
	sessionId: string,
	deps: Pick<SessionSwitchDeps, "messageCache" | "sessionMgr" | "log">,
): Promise<SessionHistorySource> {
	const events = deps.messageCache.getEvents(sessionId);
	const classification = classifyHistorySource(events);

	if (classification === "cached-events" && events) {
		return { kind: "cached-events", events };
	}

	try {
		const history = await deps.sessionMgr.loadPreRenderedHistory(sessionId);
		return { kind: "rest-history", history };
	} catch (err) {
		deps.log.warn(
			`Failed to load history for ${sessionId}: ${err instanceof Error ? err.message : err}`,
		);
		return { kind: "empty" };
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: PASS (all tests)

**Step 5: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch.test.ts
git commit -m "feat: add resolveSessionHistory with cache-first fallback"
```

---

## Task 5: TDD `switchClientToSession` (orchestrator)

**Files:**
- Modify: `test/unit/session/session-switch.test.ts`
- Modify: `src/lib/session/session-switch.ts`

**Step 1: Write the failing tests**

Append to `test/unit/session/session-switch.test.ts`:

```typescript
import {
	classifyHistorySource,
	buildSessionSwitchedMessage,
	resolveSessionHistory,
	switchClientToSession,
	type SessionHistorySource,
	type SessionSwitchDeps,
} from "../../../src/lib/session/session-switch.js";

function createFullDeps(
	overrides?: Partial<SessionSwitchDeps>,
): SessionSwitchDeps {
	return {
		messageCache: { getEvents: vi.fn().mockReturnValue(null) },
		sessionMgr: {
			loadPreRenderedHistory: vi.fn().mockResolvedValue({
				messages: [],
				hasMore: false,
			}),
		},
		wsHandler: {
			sendTo: vi.fn(),
			setClientSession: vi.fn(),
		},
		statusPoller: { isProcessing: vi.fn().mockReturnValue(false) },
		pollerManager: {
			isPolling: vi.fn().mockReturnValue(true),
			startPolling: vi.fn(),
		},
		client: { getMessages: vi.fn().mockResolvedValue([]) },
		log: { info: vi.fn(), warn: vi.fn() },
		getInputDraft: vi.fn().mockReturnValue(undefined),
		...overrides,
	};
}

describe("switchClientToSession", () => {
	it("does nothing when sessionId is empty", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "");

		expect(deps.wsHandler.setClientSession).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).not.toHaveBeenCalled();
	});

	it("sets client session in registry", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");

		expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith(
			"c1",
			"ses_1",
		);
	});

	it("sends session_switched with cache-hit events", async () => {
		const events: RelayMessage[] = [
			{ type: "user_message", text: "hi" },
		];
		const deps = createFullDeps({
			messageCache: { getEvents: vi.fn().mockReturnValue(events) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect((switchMsg?.[1] as { events?: unknown }).events).toEqual(events);
	});

	it("sends session_switched with REST history on cache miss", async () => {
		const history = {
			messages: [{ id: "m1", role: "user" as const }],
			hasMore: true,
		};
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi.fn().mockResolvedValue(history),
			},
		});

		await switchClientToSession(deps, "c1", "ses_2");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect((switchMsg?.[1] as { history?: unknown }).history).toEqual({
			messages: history.messages,
			hasMore: true,
		});
	});

	it("sends session_switched with empty payload when REST fails", async () => {
		const deps = createFullDeps({
			sessionMgr: {
				loadPreRenderedHistory: vi
					.fn()
					.mockRejectedValue(new Error("fail")),
			},
		});

		await switchClientToSession(deps, "c1", "ses_3");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload.id).toBe("ses_3");
		expect(payload.events).toBeUndefined();
		expect(payload.history).toBeUndefined();
	});

	it("sends status message (idle) after session_switched", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect(statusMsg).toBeDefined();
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("sends status 'processing' when session is busy", async () => {
		const deps = createFullDeps({
			statusPoller: { isProcessing: vi.fn().mockReturnValue(true) },
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("processing");
	});

	it("defaults to idle when statusPoller is undefined", async () => {
		const deps = createFullDeps({ statusPoller: undefined });
		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const statusMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "status",
		);
		expect((statusMsg?.[1] as { status: string }).status).toBe("idle");
	});

	it("includes inputText from draft", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue("my draft"),
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { inputText?: string }).inputText).toBe(
			"my draft",
		);
	});

	it("includes requestId when provided", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", {
			requestId: "req-abc" as RequestId,
		});

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect((switchMsg?.[1] as { requestId?: string }).requestId).toBe(
			"req-abc",
		);
	});

	it("skips history lookup when skipHistory is true", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1", { skipHistory: true });

		expect(deps.messageCache.getEvents).not.toHaveBeenCalled();
		expect(deps.sessionMgr.loadPreRenderedHistory).not.toHaveBeenCalled();

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, msg]) => (msg as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		const payload = switchMsg?.[1] as Record<string, unknown>;
		expect(payload.events).toBeUndefined();
		expect(payload.history).toBeUndefined();
	});

	it("seeds poller when pollerManager is not polling", async () => {
		const msgs = [{ id: "m1" }];
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
			client: { getMessages: vi.fn().mockResolvedValue(msgs) },
		});

		await switchClientToSession(deps, "c1", "ses_1");
		// Flush fire-and-forget microtask chain (resolved mock → .then → startPolling)
		await vi.waitFor(() => {
			expect(deps.pollerManager?.startPolling).toHaveBeenCalled();
		});

		expect(deps.client.getMessages).toHaveBeenCalledWith("ses_1");
		expect(deps.pollerManager?.startPolling).toHaveBeenCalledWith(
			"ses_1",
			msgs,
		);
	});

	it("skips poller seeding when skipPollerSeed is true", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
		});

		await switchClientToSession(deps, "c1", "ses_1", {
			skipPollerSeed: true,
		});
		// Give microtask queue a chance to flush — getMessages should NOT be called
		await Promise.resolve();
		await Promise.resolve();

		expect(deps.client.getMessages).not.toHaveBeenCalled();
	});

	it("skips poller seeding when pollerManager is undefined", async () => {
		const deps = createFullDeps({ pollerManager: undefined });
		// Should not throw
		await switchClientToSession(deps, "c1", "ses_1");
	});

	it("logs but does not throw when poller seeding fails", async () => {
		const deps = createFullDeps({
			pollerManager: {
				isPolling: vi.fn().mockReturnValue(false),
				startPolling: vi.fn(),
			},
			client: {
				getMessages: vi.fn().mockRejectedValue(new Error("fail")),
			},
		});

		await switchClientToSession(deps, "c1", "ses_1");
		// Flush fire-and-forget rejection chain
		await vi.waitFor(() => {
			expect(deps.log.warn).toHaveBeenCalled();
		});
	});

	// ─── Ordering and argument correctness ──────────────────────────────

	it("sends session_switched before status", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		const statusIdx = calls.findIndex(
			([, m]) => (m as { type: string }).type === "status",
		);
		expect(switchIdx).toBeGreaterThanOrEqual(0);
		expect(statusIdx).toBeGreaterThanOrEqual(0);
		expect(switchIdx).toBeLessThan(statusIdx);
	});

	it("sets client session before sending any messages", async () => {
		const callOrder: string[] = [];
		const deps = createFullDeps({
			wsHandler: {
				setClientSession: vi.fn(() => callOrder.push("setClient")),
				sendTo: vi.fn(() => callOrder.push("sendTo")),
			},
		});

		await switchClientToSession(deps, "c1", "ses_1");

		expect(callOrder[0]).toBe("setClient");
		expect(callOrder.filter((c) => c === "sendTo").length).toBeGreaterThan(0);
	});

	it("calls getInputDraft with the target sessionId", async () => {
		const deps = createFullDeps();
		await switchClientToSession(deps, "c1", "ses_42");

		expect(deps.getInputDraft).toHaveBeenCalledWith("ses_42");
	});

	it("omits inputText when getInputDraft returns empty string", async () => {
		const deps = createFullDeps({
			getInputDraft: vi.fn().mockReturnValue(""),
		});

		await switchClientToSession(deps, "c1", "ses_1");

		const calls = vi.mocked(deps.wsHandler.sendTo).mock.calls;
		const switchMsg = calls.find(
			([, m]) => (m as { type: string }).type === "session_switched",
		);
		expect(switchMsg).toBeDefined();
		expect("inputText" in (switchMsg?.[1] ?? {})).toBe(false);
	});
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: FAIL — `switchClientToSession` is not exported

**Step 3: Write minimal implementation**

Append to `src/lib/session/session-switch.ts`:

```typescript
// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Switch a client to a session: resolve history, build and send the
 * session_switched message, send processing status, and seed the poller.
 *
 * This is the SINGLE entry point for all session switches. Handlers must
 * call this instead of constructing session_switched messages manually.
 */
export async function switchClientToSession(
	deps: SessionSwitchDeps,
	clientId: string,
	sessionId: string,
	options?: SwitchClientOptions,
): Promise<void> {
	if (!sessionId) return;

	deps.wsHandler.setClientSession(clientId, sessionId);

	// Resolve history source
	const source: SessionHistorySource = options?.skipHistory
		? { kind: "empty" }
		: await resolveSessionHistory(sessionId, deps);

	// Build and send session_switched
	const draft = deps.getInputDraft(sessionId);
	const message = buildSessionSwitchedMessage(sessionId, source, {
		...(draft ? { draft } : {}),
		...(options?.requestId != null ? { requestId: options.requestId } : {}),
	});
	deps.wsHandler.sendTo(clientId, message);

	// Send processing status
	deps.wsHandler.sendTo(clientId, {
		type: "status",
		status: deps.statusPoller?.isProcessing(sessionId)
			? "processing"
			: "idle",
	});

	// Seed poller (fire-and-forget)
	if (
		!options?.skipPollerSeed &&
		deps.pollerManager &&
		!deps.pollerManager.isPolling(sessionId)
	) {
		deps.client
			.getMessages(sessionId)
			.then((msgs) => deps.pollerManager?.startPolling(sessionId, msgs))
			.catch((err) =>
				deps.log.warn(
					`Failed to seed poller for ${sessionId.slice(0, 12)}, will retry: ${err instanceof Error ? err.message : err}`,
				),
			);
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: PASS (all tests)

**Step 5: Run full verification**

Run: `pnpm check && pnpm vitest run test/unit/session/session-switch.test.ts`
Expected: PASS (types + tests)

**Step 6: Commit**

```bash
git add src/lib/session/session-switch.ts test/unit/session/session-switch.test.ts
git commit -m "feat: add switchClientToSession orchestrator with tests"
```

---

## Task 6: Add `toSessionSwitchDeps` helper and refactor `handleViewSession`

**Files:**
- Modify: `src/lib/handlers/session.ts`
- Test: `test/unit/handlers/handlers-session.test.ts` (existing tests must pass)

This task adds a helper function to centralize the `HandlerDeps` → `SessionSwitchDeps` mapping (avoiding duplicate inline construction across Tasks 6-8), then refactors `handleViewSession` to use it. This is a **pure refactor** — no new behavior, just delegation.

**Step 1: Run existing tests to confirm green baseline**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS

**Step 2: Add helper and refactor handleViewSession**

In `src/lib/handlers/session.ts`, add the import and helper, then replace the body of `handleViewSession`:

```typescript
import {
	switchClientToSession,
	type SessionSwitchDeps,
} from "../session/session-switch.js";

/**
 * Map HandlerDeps to the narrowed SessionSwitchDeps.
 * Centralizes the mapping so each handler doesn't duplicate it.
 *
 * NOTE: statusPoller and pollerManager are required on HandlerDeps
 * (made non-optional by the pipeline-resilience Plan D2 refactor).
 */
function toSessionSwitchDeps(deps: HandlerDeps): SessionSwitchDeps {
	return {
		messageCache: deps.messageCache,
		sessionMgr: deps.sessionMgr,
		wsHandler: deps.wsHandler,
		statusPoller: deps.statusPoller,
		pollerManager: deps.pollerManager,
		client: deps.client,
		log: deps.log,
		getInputDraft: getSessionInputDraft,
	};
}

export async function handleViewSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["view_session"],
	/** @internal Skip fire-and-forget metadata — caller will await sendSessionMetadata directly. */
	skipMetadata?: boolean,
): Promise<void> {
	const { sessionId: id } = payload;
	if (!id) return;

	await switchClientToSession(toSessionSwitchDeps(deps), clientId, id);

	// @perf-guard S2 — awaiting this call adds 20-100ms to session switch latency
	// Fire-and-forget: metadata is not on the critical path for session switching.
	// sendTo is safe after disconnect (silently drops messages).
	// All errors are caught and logged inside sendSessionMetadata.
	// NOTE: This is intentionally NOT awaited — the handler returns immediately
	// after sending session_switched, unblocking the ClientMessageQueue.
	// When skipMetadata is true, the caller (e.g. handleDeleteSession) will
	// await sendSessionMetadata directly to avoid duplicate metadata sends.
	if (!skipMetadata) {
		sendSessionMetadata(deps, clientId, id).catch(() => {});
	}

	deps.log.info(`client=${clientId} Viewing: ${id}`);
}
```

**Step 3: Run existing tests to verify no regression**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS (all existing tests pass without modification)

**Step 4: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/handlers/session.ts
git commit -m "refactor: handleViewSession delegates to switchClientToSession"
```

---

## Task 7: Refactor `handleNewSession` to use `switchClientToSession`

**Files:**
- Modify: `src/lib/handlers/session.ts`
- Test: `test/unit/handlers/handlers-session.test.ts` (existing tests must pass)

**Step 1: Run existing handleNewSession tests to confirm green baseline**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS

**Step 2: Refactor handleNewSession**

Replace the manual `session_switched` construction with delegation to `switchClientToSession`. Use `skipHistory: true` (new session has no messages) and `skipPollerSeed: true` (no messages to poll). Note: `requestId` uses conditional spread to satisfy `exactOptionalPropertyTypes` (the existing code has an explicit "DO NOT use `requestId ?? undefined`" comment):

```typescript
export async function handleNewSession(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["new_session"],
): Promise<void> {
	const { title, requestId } = payload;
	const session = await deps.sessionMgr.createSession(title, { silent: true });

	await switchClientToSession(toSessionSwitchDeps(deps), clientId, session.id, {
		...(requestId != null && { requestId }),
		skipHistory: true,
		skipPollerSeed: true,
	});

	// Session list broadcast — non-blocking so session_switched reaches the
	// client immediately without waiting for the listSessions() API call.
	deps.sessionMgr
		.sendDualSessionLists((msg) => deps.wsHandler.broadcast(msg))
		.catch((err) => {
			deps.log.warn(
				`Failed to broadcast session list after new_session: ${err}`,
			);
		});

	deps.log.info(`client=${clientId} Created: ${session.id}`);
}
```

**Step 3: Run existing tests**

Run: `pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS. The existing tests verify:
- `requestId` echoed in session_switched ✓ (forwarded by `switchClientToSession`)
- `requestId` omitted when not provided ✓ (conditional spread only includes `requestId` when non-null)
- session list broadcast ✓ (unchanged code)
- broadcast failure logged ✓ (unchanged code)

**Intentional behavioral change:** `switchClientToSession` now also sends a `status: "idle"` message that `handleNewSession` did not previously send. This is correct — the previous code was inconsistent with `handleViewSession` which always sends status. The frontend handles this benignly (the session IS idle). Existing tests use `.find()` to locate specific messages, not call-count checks, so they won't break.

**Step 4: Run full verification**

Run: `pnpm check && pnpm vitest run test/unit/handlers/handlers-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/handlers/session.ts test/unit/handlers/handlers-session.test.ts
git commit -m "refactor: handleNewSession delegates to switchClientToSession"
```

---

## Task 8: Refactor `handleClientConnected` to use `switchClientToSession`

**Files:**
- Modify: `src/lib/bridges/client-init.ts`
- Test: existing client-init tests (run `pnpm vitest run test/unit/bridges/`)

**Step 1: Run existing client-init tests to confirm green baseline**

Run: `pnpm vitest run test/unit/bridges/`
Expected: PASS

**Step 2: Refactor handleClientConnected**

Replace the duplicated session_switched logic (lines 92-134) with delegation to `switchClientToSession`. Since `ClientInitDeps` has a different shape than `HandlerDeps`, construct `SessionSwitchDeps` inline (no `toSessionSwitchDeps` helper — that's specific to `HandlerDeps`). Use conditional spreads for optional deps to satisfy `exactOptionalPropertyTypes`.

The `if (activeId)` block currently spans lines 92-167. After the refactoring, lines 94-134 (setClientSession, cache check, session_switched, status) are replaced by the `switchClientToSession` call. Lines 136-167 (model info try/catch) remain unchanged.

```typescript
import { switchClientToSession } from "../session/session-switch.js";

// Inside handleClientConnected, replace lines 94-134 with:
// (remove the existing setClientSession, cache check, session_switched,
//  draft lookup, and status send — switchClientToSession handles all of these)
if (activeId) {
	await switchClientToSession(
		{
			messageCache,
			sessionMgr,
			wsHandler,
			...(deps.statusPoller != null && { statusPoller: deps.statusPoller }),
			// pollerManager not available in ClientInitDeps — omit entirely
			client: client as { getMessages: (id: string) => Promise<unknown[]> },
			log: deps.log,
			getInputDraft: getSessionInputDraft,
		},
		clientId,
		activeId,
		{ skipPollerSeed: true },
	);

	// ── Lines 136-167 remain UNCHANGED from here ──
	// Send model/agent info from the active session
	try {
		const session = await client.getSession(activeId);
		if (session.modelID) {
			wsHandler.sendTo(clientId, {
				type: "model_info",
				model: session.modelID,
				provider: session.providerID ?? "",
			});
		} else {
			// Session has no model set — fall back to per-session override or default
			const fallbackModel = overrides.getModel(activeId);
			if (fallbackModel) {
				wsHandler.sendTo(clientId, {
					type: "model_info",
					model: fallbackModel.modelID,
					provider: fallbackModel.providerID,
				});
			}
		}
	} catch (err) {
		sendInitError(err, "Failed to load session info");
		const fallbackModel = overrides.getModel(activeId);
		if (fallbackModel) {
			wsHandler.sendTo(clientId, {
				type: "model_info",
				model: fallbackModel.modelID,
				provider: fallbackModel.providerID,
			});
		}
	}
}
// ── Everything after line 167 (session list, permissions, agents, etc.) is unchanged ──
```

This removes:
- `wsHandler.setClientSession(clientId, activeId)` (line 94) — `switchClientToSession` handles it
- The cache check and hasChatContent logic (lines 95-98)
- The draft lookup (line 99)
- The cache-hit session_switched send (lines 100-107)
- The REST fallback session_switched send (lines 108-121)
- The error fallback session_switched send (lines 122-129)
- The status send (lines 131-134)

**Step 3: Run existing tests**

Run: `pnpm vitest run test/unit/bridges/`
Expected: PASS (behavior is identical from the test's perspective)

**Step 4: Run full verification**

Run: `pnpm check && pnpm test:unit`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/bridges/client-init.ts
git commit -m "refactor: handleClientConnected delegates to switchClientToSession

Removes 40 lines of duplicated cache/REST/error fallback logic that was
copied from handleViewSession. Both now use the same centralized path."
```

---

## Task 9: Remove `SessionManager.createSession` bare broadcast

**Files:**
- Modify: `src/lib/session/session-manager.ts`
- Modify: `src/lib/relay/session-lifecycle-wiring.ts`
- Test: existing tests

The `createSession` non-silent path broadcasts a bare `{ type: "session_switched", id }` to ALL clients — the exact bug described in Problem 1. Currently unreachable (all callers use `silent: true`), but it's a latent vector. The broadcast augmenter in `session-lifecycle-wiring.ts` (lines 56-74, extracted from relay-stack.ts by Plan G) that intercepts this broadcast also becomes unnecessary.

**Step 1: Run existing tests to confirm green baseline**

Run: `pnpm test:unit`
Expected: PASS

**Step 2: Remove the bare session_switched broadcast from createSession**

In `src/lib/session/session-manager.ts`, change lines 202-205:

Before:
```typescript
if (!opts?.silent) {
    this.emit("broadcast", { type: "session_switched", id: session.id });
    await this.broadcastSessionList();
}
```

After:
```typescript
if (!opts?.silent) {
    await this.broadcastSessionList();
}
```

Rationale: Broadcasting `session_switched` to ALL clients is wrong — you don't want to force every browser tab to switch sessions. The session list broadcast is sufficient to notify all clients about the new session.

**Step 3: Update PBT tests that assert on non-silent createSession broadcast count**

Two property-based tests in `test/unit/session/session-manager.pbt.test.ts` assert that non-silent `createSession` emits 3 broadcasts (`session_switched` + 2x `session_list`). After removing the `session_switched` broadcast, only 2 remain.

**Test 1 — line 184 ("creates session and broadcasts switch + list"):**

Change the description and assertions:
```typescript
it("property: creates session and broadcasts list", async () => {
```

At line 200-207, replace:
```typescript
// Should broadcast session_switched, then dual session_list (roots + all)
expect(broadcasts.length).toBe(3);
// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
expect(broadcasts[0]!.type).toBe("session_switched");
// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
expect(broadcasts[1]!.type).toBe("session_list");
// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
expect(broadcasts[2]!.type).toBe("session_list");
```

With:
```typescript
// Should broadcast dual session_list (roots + all) — no session_switched
expect(broadcasts.length).toBe(2);
// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
expect(broadcasts[0]!.type).toBe("session_list");
// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
expect(broadcasts[1]!.type).toBe("session_list");
```

**Test 2 — line 685 ("createSession without opts still broadcasts as before"):**

Same change: update description, change count from 3 to 2, remove `session_switched` assertion (lines 699-706). Apply the identical replacement pattern as Test 1.

Run: `pnpm vitest run test/unit/session/session-manager.pbt.test.ts`
Expected: PASS after adjustment

**Step 4: Simplify the broadcast listener in session-lifecycle-wiring.ts**

In `src/lib/relay/session-lifecycle-wiring.ts`, simplify lines 56-74 (extracted from relay-stack.ts by Plan G):

Before:
```typescript
sessionMgr.on("broadcast", (msg) => {
    // Augment session_switched with cached events (combined protocol)
    if (msg.type === "session_switched") {
        const switchId = (msg as { id?: string }).id;
        if (switchId) {
            const events = messageCache.getEvents(switchId);
            const hasChatContent =
                events?.some(
                    (e: RelayMessage) =>
                        e.type === "user_message" || e.type === "delta",
                ) ?? false;
            if (events && hasChatContent) {
                wsHandler.broadcast({ ...msg, events });
                return;
            }
        }
    }
    wsHandler.broadcast(msg);
});
```

After:
```typescript
sessionMgr.on("broadcast", (msg) => {
    wsHandler.broadcast(msg);
});
```

The `session_switched` augmenter was only needed for the `createSession` broadcast path. With that broadcast removed, no `session_switched` messages flow through the SessionManager broadcast path.

After this simplification, `messageCache` can be removed from `SessionLifecycleWiringDeps` if it's no longer used elsewhere in the module (check before removing).

**Step 5: Run tests**

Run: `pnpm test:unit`
Expected: PASS

**Step 6: Run type check**

Run: `pnpm check`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/session/session-manager.ts src/lib/relay/session-lifecycle-wiring.ts
git commit -m "fix: remove bare session_switched broadcast from createSession

Broadcasting session_switched to ALL clients forced every tab to switch
sessions — the exact bug described in Problem 1. The session_list broadcast
is sufficient to notify clients about new sessions.

Also removes the broadcast augmenter in session-lifecycle-wiring.ts that
was only needed for this path."
```

---

## Task 10: TDD conduit-owned fields regression tests

**Files:**
- Create: `test/unit/session/conduit-owned-fields.test.ts`
- Existing: `test/unit/session/session-manager-parentid.test.ts` (reference only)

These tests close the 3 gaps identified in the audit:

1. `toSessionInfoList` fork metadata enrichment (parentID from `forkMeta`, not just OpenCode)
2. `forkMessageId` enrichment from `forkMeta`
3. Confirm that server-side enrichment means client-side full replacement is safe

**Step 1: Write the tests**

```typescript
// test/unit/session/conduit-owned-fields.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import { SessionManager } from "../../../src/lib/session/session-manager.js";

describe("conduit-owned fields survive session list refresh", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "conduit-test-"));
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	describe("toSessionInfoList fork metadata enrichment", () => {
		it("applies parentID from fork metadata when OpenCode has no parentID", async () => {
			// Simulates user-initiated fork: OpenCode doesn't set parentID,
			// but conduit's fork metadata has it.
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked Session",
						// parentID is NOT set by OpenCode for user-initiated forks
						time: { created: 1000, updated: 2000 },
					},
					{
						id: "ses_parent",
						title: "Original Session",
						time: { created: 500, updated: 1500 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			// Simulate fork metadata that was persisted by handleForkSession
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_42",
				parentID: "ses_parent",
			});

			const sessions = await mgr.listSessions();

			const forked = sessions.find((s) => s.id === "ses_forked");
			expect(forked).toBeDefined();
			expect(forked?.parentID).toBe("ses_parent");
			expect(forked?.forkMessageId).toBe("msg_42");
		});

		it("prefers OpenCode parentID over fork metadata parentID", async () => {
			// Subagent sessions have parentID set by OpenCode directly
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_sub",
						title: "Subagent Session",
						parentID: "ses_opencode_parent", // OpenCode sets this
						time: { created: 1000, updated: 2000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			// Even if fork metadata has a different parentID, OpenCode wins
			mgr.setForkEntry("ses_sub", {
				forkMessageId: "msg_99",
				parentID: "ses_conduit_parent",
			});

			const sessions = await mgr.listSessions();
			const sub = sessions.find((s) => s.id === "ses_sub");
			expect(sub?.parentID).toBe("ses_opencode_parent");
		});

		it("applies forkMessageId even when parentID comes from OpenCode", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_sub",
						title: "Subagent Session",
						parentID: "ses_parent",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_sub", {
				forkMessageId: "msg_77",
				parentID: "ses_parent",
			});

			const sessions = await mgr.listSessions();
			const sub = sessions.find((s) => s.id === "ses_sub");
			expect(sub?.forkMessageId).toBe("msg_77");
		});

		it("non-forked sessions have neither parentID nor forkMessageId", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_normal",
						title: "Normal Session",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			const sessions = await mgr.listSessions();
			const normal = sessions.find((s) => s.id === "ses_normal");

			expect(normal?.parentID).toBeUndefined();
			expect(normal?.forkMessageId).toBeUndefined();
		});
	});

	describe("server-side enrichment guarantees", () => {
		it("repeated listSessions calls always include fork metadata", async () => {
			// Simulates the scenario: fork happens, then session_list refreshes.
			// Each refresh should still include conduit-owned fields.
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_1",
				parentID: "ses_parent",
			});

			// First call
			const first = await mgr.listSessions();
			expect(first[0]?.parentID).toBe("ses_parent");
			expect(first[0]?.forkMessageId).toBe("msg_1");

			// Second call (simulates session_list refresh)
			const second = await mgr.listSessions();
			expect(second[0]?.parentID).toBe("ses_parent");
			expect(second[0]?.forkMessageId).toBe("msg_1");

			// Third call (another refresh)
			const third = await mgr.listSessions();
			expect(third[0]?.parentID).toBe("ses_parent");
			expect(third[0]?.forkMessageId).toBe("msg_1");
		});

		it("searchSessions also includes fork metadata", async () => {
			const mockClient = {
				listSessions: vi.fn().mockResolvedValue([
					{
						id: "ses_forked",
						title: "Forked Search Target",
						time: { created: 1000 },
					},
				]),
			} as unknown as OpenCodeClient;

			const mgr = new SessionManager({ client: mockClient, configDir: tmpDir });
			mgr.setForkEntry("ses_forked", {
				forkMessageId: "msg_search",
				parentID: "ses_p",
			});

			const results = await mgr.searchSessions("Search Target");
			expect(results[0]?.parentID).toBe("ses_p");
			expect(results[0]?.forkMessageId).toBe("msg_search");
		});
	});
});
```

**Step 2: Run tests**

Run: `pnpm vitest run test/unit/session/conduit-owned-fields.test.ts`
Expected: PASS — all tests should pass immediately because the server-side enrichment is already implemented. These are **regression tests** that lock in existing correct behavior.

If any test fails, it indicates a bug that needs fixing before proceeding.

**Step 3: Commit**

```bash
git add test/unit/session/conduit-owned-fields.test.ts
git commit -m "test: add regression tests for conduit-owned fields survival

Locks in the server-side enrichment pattern: toSessionInfoList always
applies parentID and forkMessageId from fork metadata, ensuring these
conduit-owned fields survive session_list refreshes.

Covers gaps identified in the fork resilience audit:
- parentID from forkMeta (user-initiated forks, not just OpenCode subagents)
- forkMessageId enrichment
- Repeated listSessions calls preserve fields
- searchSessions also preserves fields"
```

---

## Task 11: Final verification and cleanup

**Files:**
- All modified files

**Step 1: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

Expected: ALL PASS

**Step 2: Verify no remaining manual session_switched construction outside session-switch.ts**

Search for raw `session_switched` construction:

```bash
rg 'type:\s*"session_switched"' src/ --glob '!session-switch.ts'
```

Expected output should show ZERO hits in handler code. The only remaining hits should be:
- `src/lib/shared-types.ts` — the type definition
- `src/lib/frontend/` — the client-side message handler (receiving, not constructing)

If any server-side construction remains, it needs to be refactored to use `switchClientToSession`.

**Step 3: Verify no unused imports**

Run: `pnpm lint`
Expected: PASS (no unused imports after refactoring)

**Step 4: Commit any cleanup**

```bash
git add -A
git commit -m "chore: final cleanup after fork resilience refactors"
```

---

## Appendix: Call Site Disposition

After all tasks are complete, the 9 original send sites should be resolved as follows:

| # | Original Location | Disposition |
|---|------------------|-------------|
| A | `handlers/session.ts:150-155` (handleViewSession cache hit) | **Replaced** — delegates to `switchClientToSession` |
| B | `handlers/session.ts:160-169` (handleViewSession REST) | **Replaced** — delegates to `switchClientToSession` |
| C | `handlers/session.ts:175-179` (handleViewSession error) | **Replaced** — delegates to `switchClientToSession` |
| D | `handlers/session.ts:228-235` (handleNewSession) | **Replaced** — delegates to `switchClientToSession` |
| E | `bridges/client-init.ts:102-107` (client-init cache hit) | **Replaced** — delegates to `switchClientToSession` |
| F | `bridges/client-init.ts:112-121` (client-init REST) | **Replaced** — delegates to `switchClientToSession` |
| G | `bridges/client-init.ts:124-128` (client-init error) | **Replaced** — delegates to `switchClientToSession` |
| H | `session/session-manager.ts:203` (createSession broadcast) | **Removed** — bare broadcast was the root bug |
| I | `relay/session-lifecycle-wiring.ts:56-74` (broadcast augmenter) | **Removed** — dead code after H removed |

**Result:** All `session_switched` message construction flows through `buildSessionSwitchedMessage` inside `session-switch.ts`. No handler can construct a bare `session_switched` without going through the centralized module.
