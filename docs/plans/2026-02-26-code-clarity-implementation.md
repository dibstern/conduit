# Code Clarity Refactoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decompose `relay-stack.ts` (1841 lines) into focused modules and improve type safety, error handling, logging, and documentation — with zero behavior changes.

**Architecture:** Extract `createProjectRelay()` bottom-up into 4 new modules (`session-overrides.ts`, `pty-manager.ts`, `message-handlers.ts`, `sse-wiring.ts`) plus supporting improvements (`error-response.ts`, `opencode-events.ts`). Each extraction is independently testable and committable. The existing 1518 tests serve as the regression safety net.

**Tech Stack:** TypeScript (ESM), Vitest, Biome, pnpm

**Key reference:** Design doc at `docs/plans/2026-02-26-code-clarity-design.md`

---

### Task 1: SessionOverrides — Extract mutable state from closure

**Files:**
- Create: `src/lib/session-overrides.ts`
- Create: `test/unit/session-overrides.test.ts`
- Modify: `src/lib/relay-stack.ts:255-291` (replace closure vars with class)

**Context:** Lines 255-291 of `relay-stack.ts` define `selectedAgent`, `selectedModel`, `modelUserSelected`, `processingTimer` as bare closure variables. They're scattered across 20+ handler cases. Extract to a class with clear methods.

**Step 1: Write the test**

```typescript
// test/unit/session-overrides.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionOverrides } from "../../src/lib/session-overrides.js";

describe("SessionOverrides", () => {
  let overrides: SessionOverrides;

  beforeEach(() => {
    vi.useFakeTimers();
    overrides = new SessionOverrides();
  });

  afterEach(() => {
    overrides.dispose();
    vi.useRealTimers();
  });

  it("starts with no agent or model selected", () => {
    expect(overrides.agent).toBeUndefined();
    expect(overrides.model).toBeUndefined();
    expect(overrides.modelUserSelected).toBe(false);
  });

  it("setAgent stores agent id", () => {
    overrides.setAgent("coding");
    expect(overrides.agent).toBe("coding");
  });

  it("setModel stores model and marks user-selected", () => {
    overrides.setModel({ providerID: "anthropic", modelID: "claude-4" });
    expect(overrides.model).toEqual({ providerID: "anthropic", modelID: "claude-4" });
    expect(overrides.modelUserSelected).toBe(true);
  });

  it("setModelDefault stores model without marking user-selected", () => {
    overrides.setModelDefault({ providerID: "anthropic", modelID: "claude-4" });
    expect(overrides.model).toEqual({ providerID: "anthropic", modelID: "claude-4" });
    expect(overrides.modelUserSelected).toBe(false);
  });

  it("clear resets all state", () => {
    overrides.setAgent("coding");
    overrides.setModel({ providerID: "a", modelID: "b" });
    overrides.clear();
    expect(overrides.agent).toBeUndefined();
    expect(overrides.model).toBeUndefined();
    expect(overrides.modelUserSelected).toBe(false);
  });

  it("startProcessingTimeout fires callback after timeout", () => {
    const onTimeout = vi.fn();
    overrides.startProcessingTimeout(onTimeout);
    vi.advanceTimersByTime(120_000);
    expect(onTimeout).toHaveBeenCalledOnce();
  });

  it("clearProcessingTimeout prevents callback", () => {
    const onTimeout = vi.fn();
    overrides.startProcessingTimeout(onTimeout);
    overrides.clearProcessingTimeout();
    vi.advanceTimersByTime(120_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("dispose clears timeout", () => {
    const onTimeout = vi.fn();
    overrides.startProcessingTimeout(onTimeout);
    overrides.dispose();
    vi.advanceTimersByTime(120_000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/session-overrides.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/lib/session-overrides.ts
// ─── Session Overrides ─────────────────────────────────────────────────────────
// Encapsulates mutable per-session state: selected agent, model, and the
// processing timeout failsafe. Extracted from relay-stack.ts closure variables.

export interface ModelSelection {
  providerID: string;
  modelID: string;
}

const PROCESSING_TIMEOUT_MS = 120_000; // 2 minutes

export class SessionOverrides {
  agent: string | undefined = undefined;
  model: ModelSelection | undefined = undefined;
  modelUserSelected = false;

  private processingTimer: ReturnType<typeof setTimeout> | null = null;

  setAgent(agentId: string): void {
    this.agent = agentId;
  }

  setModel(model: ModelSelection): void {
    this.model = model;
    this.modelUserSelected = true;
  }

  setModelDefault(model: ModelSelection): void {
    this.model = model;
    // Don't set modelUserSelected — auto-detected defaults are display-only
  }

  clear(): void {
    this.agent = undefined;
    this.model = undefined;
    this.modelUserSelected = false;
  }

  startProcessingTimeout(onTimeout: () => void): void {
    this.clearProcessingTimeout();
    this.processingTimer = setTimeout(() => {
      this.processingTimer = null;
      onTimeout();
    }, PROCESSING_TIMEOUT_MS);
  }

  clearProcessingTimeout(): void {
    if (this.processingTimer !== null) {
      clearTimeout(this.processingTimer);
      this.processingTimer = null;
    }
  }

  dispose(): void {
    this.clearProcessingTimeout();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/session-overrides.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Integrate into relay-stack.ts**

Replace lines 255-291 of `relay-stack.ts`:
- Remove `let selectedAgent`, `let selectedModel`, `let modelUserSelected`, `let processingTimer`, `clearProcessingTimeout()`, `startProcessingTimeout()`
- Add `import { SessionOverrides } from "./session-overrides.js";`
- Add `const overrides = new SessionOverrides();` after component construction
- Search-and-replace all references:
  - `selectedAgent` → `overrides.agent`
  - `selectedModel` → `overrides.model`
  - `modelUserSelected` → `overrides.modelUserSelected`
  - `selectedAgent = "..."` → `overrides.setAgent("...")`
  - `selectedModel = { ... }` → `overrides.setModel({ ... })` (or `setModelDefault` for auto-detect)
  - `selectedAgent = undefined; selectedModel = undefined; modelUserSelected = false;` → `overrides.clear()`
  - `startProcessingTimeout()` → `overrides.startProcessingTimeout(() => { ... })` where the callback does the broadcast
  - `clearProcessingTimeout()` → `overrides.clearProcessingTimeout()`
- In `stop()`: add `overrides.dispose()` before `closeAllPtyUpstreams()`

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All 1518+ tests pass

**Step 7: Lint**

Run: `pnpm lint:fix`

**Step 8: Commit**

```bash
git add src/lib/session-overrides.ts test/unit/session-overrides.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract SessionOverrides from relay-stack closure"
```

---

### Task 2: PtyManager — Extract PTY lifecycle management

**Files:**
- Create: `src/lib/pty-manager.ts`
- Create: `test/unit/pty-manager.test.ts`
- Modify: `src/lib/relay-stack.ts:293-464` (remove PTY code, import PtyManager)

**Context:** Lines 293-464 of `relay-stack.ts` define `PtySession`, `connectPtyUpstream`, `closePtyUpstream`, `closeAllPtyUpstreams`, `replayPtySessions`, and the scrollback buffer. The `pty_create` and `terminal_command:create` handlers (lines 1166-1319) duplicate ~60 lines of create-and-connect logic. Extract all of this into a `PtyManager` class.

**Step 1: Write the test**

```typescript
// test/unit/pty-manager.test.ts
import { describe, expect, it, vi } from "vitest";
import { PtyManager } from "../../src/lib/pty-manager.js";

// Mock broadcast/sendTo functions
function createMockBroadcast() {
  const messages: Array<{ type: string; [k: string]: unknown }> = [];
  return {
    broadcast: vi.fn((msg: Record<string, unknown>) => messages.push(msg as any)),
    sendTo: vi.fn(),
    messages,
  };
}

describe("PtyManager", () => {
  it("starts with no sessions", () => {
    const mgr = new PtyManager({ log: () => {} });
    expect(mgr.sessionCount).toBe(0);
    expect(mgr.listSessions()).toEqual([]);
  });

  it("tracks a registered session", () => {
    const mgr = new PtyManager({ log: () => {} });
    const mockUpstream = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    mgr.registerSession("pty-1", mockUpstream as any);
    expect(mgr.sessionCount).toBe(1);
    expect(mgr.hasSession("pty-1")).toBe(true);
  });

  it("closeSession removes and terminates", () => {
    const mgr = new PtyManager({ log: () => {} });
    const mockUpstream = {
      readyState: 1,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    };
    mgr.registerSession("pty-1", mockUpstream as any);
    mgr.closeSession("pty-1");
    expect(mgr.sessionCount).toBe(0);
    expect(mockUpstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
  });

  it("closeAll cleans up all sessions", () => {
    const mgr = new PtyManager({ log: () => {} });
    const mk = () => ({
      readyState: 1,
      close: vi.fn(),
      terminate: vi.fn(),
      send: vi.fn(),
      on: vi.fn(),
    });
    mgr.registerSession("pty-1", mk() as any);
    mgr.registerSession("pty-2", mk() as any);
    mgr.closeAll();
    expect(mgr.sessionCount).toBe(0);
  });

  it("sendInput forwards to upstream if open", () => {
    const mgr = new PtyManager({ log: () => {} });
    const mockUpstream = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    mgr.registerSession("pty-1", mockUpstream as any);
    mgr.sendInput("pty-1", "ls\n");
    expect(mockUpstream.send).toHaveBeenCalledWith("ls\n");
  });

  it("sendInput does nothing for unknown pty", () => {
    const mgr = new PtyManager({ log: () => {} });
    // Should not throw
    mgr.sendInput("nonexistent", "ls\n");
  });

  it("appendScrollback records and caps at limit", () => {
    const mgr = new PtyManager({ log: () => {}, scrollbackMax: 100 });
    const mockUpstream = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
      terminate: vi.fn(),
      on: vi.fn(),
    };
    mgr.registerSession("pty-1", mockUpstream as any);
    // Write 120 bytes
    mgr.appendScrollback("pty-1", "a".repeat(60));
    mgr.appendScrollback("pty-1", "b".repeat(60));
    const replay = mgr.getScrollback("pty-1");
    // Should have evicted the first chunk
    expect(replay.length).toBeLessThanOrEqual(100);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/pty-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/lib/pty-manager.ts
// ─── PTY Manager ───────────────────────────────────────────────────────────────
// Manages upstream WebSocket connections to OpenCode's PTY endpoints.
//
// Lifecycle: create → notify browser → connect upstream → buffer scrollback → close
//
// Each active PTY gets one upstream WebSocket to OpenCode's /pty/:id/connect.
// Output is buffered server-side (50 KB FIFO per terminal) and broadcast to
// ALL browser clients. New clients get scrollback replayed on connect.
// Input from any browser client is forwarded to the shared upstream WS.
// PTYs persist across browser show/hide toggles — only closed on explicit
// pty_close (tab X button) or upstream disconnect.

const DEFAULT_SCROLLBACK_MAX = 50 * 1024; // 50 KB per terminal
const WS_OPEN = 1;

interface PtyUpstream {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface PtySessionState {
  upstream: PtyUpstream;
  scrollback: string[];
  scrollbackSize: number;
  exited: boolean;
  exitCode: number | null;
}

export interface PtyManagerOptions {
  log: (...args: unknown[]) => void;
  scrollbackMax?: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, PtySessionState>();
  private readonly log: (...args: unknown[]) => void;
  private readonly scrollbackMax: number;

  constructor(options: PtyManagerOptions) {
    this.log = options.log;
    this.scrollbackMax = options.scrollbackMax ?? DEFAULT_SCROLLBACK_MAX;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  hasSession(ptyId: string): boolean {
    return this.sessions.has(ptyId);
  }

  getSession(ptyId: string): PtySessionState | undefined {
    return this.sessions.get(ptyId);
  }

  listSessions(): Array<{ id: string; status: string }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      status: s.exited ? "exited" : "running",
    }));
  }

  registerSession(ptyId: string, upstream: PtyUpstream): PtySessionState {
    const session: PtySessionState = {
      upstream,
      scrollback: [],
      scrollbackSize: 0,
      exited: false,
      exitCode: null,
    };
    this.sessions.set(ptyId, session);
    return session;
  }

  appendScrollback(ptyId: string, text: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    session.scrollback.push(text);
    session.scrollbackSize += text.length;
    while (
      session.scrollbackSize > this.scrollbackMax &&
      session.scrollback.length > 1
    ) {
      session.scrollbackSize -= session.scrollback[0].length;
      session.scrollback.shift();
    }
  }

  getScrollback(ptyId: string): string {
    const session = this.sessions.get(ptyId);
    if (!session || session.scrollback.length === 0) return "";
    return session.scrollback.join("");
  }

  markExited(ptyId: string, exitCode: number): void {
    const session = this.sessions.get(ptyId);
    if (session) {
      session.exited = true;
      session.exitCode = exitCode;
    }
  }

  sendInput(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId);
    if (session?.upstream.readyState === WS_OPEN) {
      session.upstream.send(data);
    }
  }

  closeSession(ptyId: string): void {
    const session = this.sessions.get(ptyId);
    if (!session) return;
    this.sessions.delete(ptyId);
    if (session.upstream.readyState === WS_OPEN) {
      session.upstream.close(1000, "Proxy closed");
    } else {
      session.upstream.terminate();
    }
  }

  closeAll(): void {
    for (const ptyId of [...this.sessions.keys()]) {
      this.closeSession(ptyId);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run test/unit/pty-manager.test.ts`
Expected: PASS

**Step 5: Integrate into relay-stack.ts**

- Remove lines 293-464 (`PtySession` interface, `ptySessions` Map, `connectPtyUpstream`, `closePtyUpstream`, `closeAllPtyUpstreams`, `replayPtySessions`, `PTY_SCROLLBACK_MAX`)
- Add `import { PtyManager } from "./pty-manager.js";`
- After component construction, add: `const ptyManager = new PtyManager({ log });`
- The `connectPtyUpstream` function stays in `relay-stack.ts` for now (it references `wsHandler.broadcast` for the upstream message handler), but it uses `ptyManager.registerSession()` and `ptyManager.appendScrollback()` instead of raw Map ops
- Replace all `ptySessions.get/set/has/delete/keys` with `ptyManager` methods
- Replace `closePtyUpstream()` → `ptyManager.closeSession()`
- Replace `closeAllPtyUpstreams()` → `ptyManager.closeAll()`
- Replace `replayPtySessions()` inline code with loop over `ptyManager.listSessions()` + `ptyManager.getScrollback()`
- In `stop()`: replace `closeAllPtyUpstreams()` with `ptyManager.closeAll()`

**Step 6: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 7: Lint + Commit**

```bash
pnpm lint:fix
git add src/lib/pty-manager.ts test/unit/pty-manager.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract PtyManager from relay-stack"
```

---

### Task 3: Error response builder — Centralize error formatting

**Files:**
- Create: `src/lib/error-response.ts`
- Create: `test/unit/error-response.test.ts`
- Modify: `src/lib/relay-stack.ts` (multiple locations — see below)

**Context:** The pattern `if (err instanceof OpenCodeApiError && err.responseBody) { ... }` appears at:
- Line 728-751 (message send error)
- Line 1432-1447 (top-level handler catch)
- Similar patterns for individual handler error responses

Extract a utility that builds a `RelayMessage` error from any caught error.

**Step 1: Write the test**

```typescript
// test/unit/error-response.test.ts
import { describe, expect, it } from "vitest";
import { buildErrorResponse, formatErrorDetail } from "../../src/lib/error-response.js";
import { OpenCodeApiError } from "../../src/lib/errors.js";

describe("formatErrorDetail", () => {
  it("returns message for plain Error", () => {
    const err = new Error("something broke");
    expect(formatErrorDetail(err)).toBe("something broke");
  });

  it("includes responseBody string for OpenCodeApiError", () => {
    const err = new OpenCodeApiError("API failed", {
      statusCode: 400,
      responseBody: "Bad request body",
    });
    expect(formatErrorDetail(err)).toBe("API failed — Bad request body");
  });

  it("JSON-stringifies responseBody object for OpenCodeApiError", () => {
    const err = new OpenCodeApiError("API failed", {
      statusCode: 400,
      responseBody: { detail: "invalid" },
    });
    expect(formatErrorDetail(err)).toContain("API failed");
    expect(formatErrorDetail(err)).toContain('"detail":"invalid"');
  });

  it("handles non-Error values", () => {
    expect(formatErrorDetail("string error")).toBe("string error");
    expect(formatErrorDetail(42)).toBe("Unknown error");
    expect(formatErrorDetail(null)).toBe("Unknown error");
  });
});

describe("buildErrorResponse", () => {
  it("returns RelayMessage error with code and message", () => {
    const err = new Error("oops");
    const msg = buildErrorResponse(err, "SEND_FAILED");
    expect(msg).toEqual({
      type: "error",
      code: "SEND_FAILED",
      message: "oops",
    });
  });

  it("includes prefix when provided", () => {
    const err = new Error("timeout");
    const msg = buildErrorResponse(err, "SEND_FAILED", "Failed to send message");
    expect(msg.message).toBe("Failed to send message: timeout");
  });

  it("includes API response body for OpenCodeApiError", () => {
    const err = new OpenCodeApiError("bad", {
      statusCode: 429,
      responseBody: "rate limited",
    });
    const msg = buildErrorResponse(err, "API_ERROR");
    expect(msg.message).toContain("rate limited");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/error-response.test.ts`
Expected: FAIL — module not found

**Step 3: Check OpenCodeApiError constructor**

Read `src/lib/errors.ts` to verify `OpenCodeApiError` has `responseBody`. Use exact constructor signature.

**Step 4: Write the implementation**

```typescript
// src/lib/error-response.ts
// ─── Error Response Builder ────────────────────────────────────────────────────
// Centralizes error → RelayMessage conversion. Replaces scattered
// `if (err instanceof OpenCodeApiError && err.responseBody)` patterns.

import { OpenCodeApiError } from "./errors.js";
import type { RelayMessage } from "./types.js";

/**
 * Extract a log-safe error detail string from any caught value.
 * For OpenCodeApiError, includes the response body.
 */
export function formatErrorDetail(err: unknown): string {
  if (err instanceof OpenCodeApiError && err.responseBody) {
    const body =
      typeof err.responseBody === "string"
        ? err.responseBody
        : JSON.stringify(err.responseBody);
    return `${err.message} — ${body}`;
  }
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown error";
}

/**
 * Build a `{ type: "error", code, message }` RelayMessage from a caught error.
 *
 * @param err - The caught error (any type)
 * @param code - Error code for the client (e.g. "SEND_FAILED")
 * @param prefix - Optional prefix for the message (e.g. "Failed to send message")
 */
export function buildErrorResponse(
  err: unknown,
  code: string,
  prefix?: string,
): Extract<RelayMessage, { type: "error" }> {
  const detail = formatErrorDetail(err);
  const message = prefix ? `${prefix}: ${detail}` : detail;
  return { type: "error", code, message };
}
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run test/unit/error-response.test.ts`
Expected: PASS

**Step 6: Integrate into relay-stack.ts**

Replace the inline error formatting at these locations:
- **Line 728-751** (message send catch): Replace with `buildErrorResponse(sendErr, "SEND_FAILED", "Failed to send message")`
- **Lines 1432-1447** (top-level handler catch): Replace with `const errMsg = buildErrorResponse(err, "HANDLER_ERROR"); console.error(...); wsHandler.sendTo(clientId, errMsg);`
- Use `formatErrorDetail(err)` for `console.error` calls

**Step 7: Run full test suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/error-response.ts test/unit/error-response.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract error response builder from relay-stack"
```

---

### Task 4: Extract message handlers from relay-stack switch statement

**Files:**
- Create: `src/lib/message-handlers.ts`
- Create: `test/unit/message-handlers.test.ts`
- Modify: `src/lib/relay-stack.ts:698-1432` (replace switch body with dispatch)

**Context:** This is the biggest extraction. The switch statement at lines 698-1432 has 20+ cases. Each case becomes a named async function taking `(deps, clientId, payload)`. The switch becomes a dispatch table.

**Step 1: Define the HandlerDeps interface and dispatch table type**

```typescript
// src/lib/message-handlers.ts (top section)
import type { OpenCodeClient, PromptOptions } from "./opencode-client.js";
import type { SessionManager } from "./session-manager.js";
import type { MessageCache } from "./message-cache.js";
import type { PermissionBridge } from "./permission-bridge.js";
import type { QuestionBridge } from "./question-bridge.js";
import type { WebSocketHandler } from "./ws-handler.js";
import type { SessionOverrides } from "./session-overrides.js";
import type { PtyManager } from "./pty-manager.js";
import type { ProjectRelayConfig } from "./relay-stack.js";
import type { RelayMessage } from "./types.js";
import { buildErrorResponse, formatErrorDetail } from "./error-response.js";
import { OpenCodeApiError } from "./errors.js";

export interface HandlerDeps {
  wsHandler: WebSocketHandler;
  client: OpenCodeClient;
  sessionMgr: SessionManager;
  messageCache: MessageCache;
  permissionBridge: PermissionBridge;
  questionBridge: QuestionBridge;
  overrides: SessionOverrides;
  ptyManager: PtyManager;
  config: ProjectRelayConfig;
  log: (...args: unknown[]) => void;
  /** Connect a new PTY upstream and register it. Defined in relay-stack. */
  connectPtyUpstream: (ptyId: string, cursor?: number) => Promise<void>;
}

export type MessageHandler = (
  deps: HandlerDeps,
  clientId: string,
  payload: Record<string, unknown>,
) => Promise<void>;
```

**Step 2: Write tests for the simplest handlers first**

```typescript
// test/unit/message-handlers.test.ts
import { describe, expect, it, vi } from "vitest";
import type { HandlerDeps } from "../../src/lib/message-handlers.js";
import {
  handleCancel,
  handleInputSync,
  handleNewSession,
  handleSwitchAgent,
  handleSwitchModel,
} from "../../src/lib/message-handlers.js";

function createMockDeps(overrides?: Partial<HandlerDeps>): HandlerDeps {
  return {
    wsHandler: {
      broadcast: vi.fn(),
      broadcastExcept: vi.fn(),
      sendTo: vi.fn(),
    } as any,
    client: {
      sendMessageAsync: vi.fn(),
      abortSession: vi.fn(),
      listAgents: vi.fn().mockResolvedValue([]),
      listProviders: vi.fn().mockResolvedValue({ providers: [], connected: [], defaults: {} }),
      listCommands: vi.fn().mockResolvedValue([]),
      getSession: vi.fn().mockResolvedValue({}),
      getMessages: vi.fn().mockResolvedValue([]),
      listProjects: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue([]),
      getFileContent: vi.fn().mockResolvedValue({ content: "" }),
      createPty: vi.fn(),
      deletePty: vi.fn(),
      resizePty: vi.fn(),
      listPtys: vi.fn().mockResolvedValue([]),
      replyPermission: vi.fn(),
      replyQuestion: vi.fn(),
      rejectQuestion: vi.fn(),
      revertSession: vi.fn(),
    } as any,
    sessionMgr: {
      getActiveSessionId: vi.fn().mockReturnValue("sess-1"),
      createSession: vi.fn().mockResolvedValue({ id: "new-sess" }),
      switchSession: vi.fn(),
      deleteSession: vi.fn(),
      renameSession: vi.fn(),
      listSessions: vi.fn().mockResolvedValue([]),
      searchSessions: vi.fn().mockResolvedValue([]),
      loadHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    } as any,
    messageCache: {
      recordEvent: vi.fn(),
      getEvents: vi.fn().mockReturnValue(null),
      remove: vi.fn(),
    } as any,
    permissionBridge: {
      onPermissionResponse: vi.fn(),
    } as any,
    questionBridge: {
      onAnswer: vi.fn(),
    } as any,
    overrides: {
      agent: undefined,
      model: undefined,
      modelUserSelected: false,
      setAgent: vi.fn(),
      setModel: vi.fn(),
      setModelDefault: vi.fn(),
      clear: vi.fn(),
      startProcessingTimeout: vi.fn(),
      clearProcessingTimeout: vi.fn(),
    } as any,
    ptyManager: {
      sessionCount: 0,
      hasSession: vi.fn().mockReturnValue(false),
      closeSession: vi.fn(),
      sendInput: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
    } as any,
    config: { opencodeUrl: "http://localhost:4096", projectDir: "/tmp", slug: "test" } as any,
    log: vi.fn(),
    connectPtyUpstream: vi.fn(),
    ...overrides,
  };
}

describe("handleSwitchAgent", () => {
  it("sets agent on overrides", async () => {
    const deps = createMockDeps();
    await handleSwitchAgent(deps, "c1", { agentId: "coding" });
    expect(deps.overrides.setAgent).toHaveBeenCalledWith("coding");
  });

  it("does nothing for empty agentId", async () => {
    const deps = createMockDeps();
    await handleSwitchAgent(deps, "c1", { agentId: "" });
    expect(deps.overrides.setAgent).not.toHaveBeenCalled();
  });
});

describe("handleSwitchModel", () => {
  it("sets model and broadcasts model_info", async () => {
    const deps = createMockDeps();
    await handleSwitchModel(deps, "c1", { modelId: "claude-4", providerId: "anthropic" });
    expect(deps.overrides.setModel).toHaveBeenCalledWith({
      providerID: "anthropic",
      modelID: "claude-4",
    });
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({
      type: "model_info",
      model: "claude-4",
      provider: "anthropic",
    });
  });
});

describe("handleInputSync", () => {
  it("broadcasts to all except sender", async () => {
    const deps = createMockDeps();
    await handleInputSync(deps, "c1", { text: "hello" });
    expect(deps.wsHandler.broadcastExcept).toHaveBeenCalledWith(
      { type: "input_sync", text: "hello", from: "c1" },
      "c1",
    );
  });
});

describe("handleCancel", () => {
  it("aborts session and broadcasts done", async () => {
    const deps = createMockDeps();
    await handleCancel(deps, "c1", {});
    expect(deps.client.abortSession).toHaveBeenCalledWith("sess-1");
    expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalled();
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({ type: "done", code: 1 });
  });
});

describe("handleNewSession", () => {
  it("creates session and clears overrides", async () => {
    const deps = createMockDeps();
    await handleNewSession(deps, "c1", { title: "My Session" });
    expect(deps.sessionMgr.createSession).toHaveBeenCalledWith("My Session");
    expect(deps.overrides.clear).toHaveBeenCalled();
  });
});
```

**Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/message-handlers.test.ts`
Expected: FAIL

**Step 4: Implement the handlers**

Create `src/lib/message-handlers.ts` with each switch case as a named exported async function. The function names match `handle` + PascalCase of the handler name:

- `handleMessage` — lines 702-754
- `handlePermissionResponse` — lines 757-777
- `handleAskUserResponse` — lines 780-793
- `handleQuestionReject` — lines 795-803
- `handleNewSession` — lines 806-814
- `handleSwitchSession` — lines 816-891
- `handleDeleteSession` — lines 893-901
- `handleRenameSession` — lines 903-911
- `handleListSessions` — lines 913-917
- `handleSearchSessions` — lines 919-927
- `handleLoadMoreHistory` — lines 929-945
- `handleGetAgents` — lines 948-953
- `handleSwitchAgent` — lines 955-962
- `handleGetModels` — lines 965-1013
- `handleSwitchModel` — lines 1016-1030
- `handleGetCommands` — lines 1033-1037
- `handleGetProjects` — lines 1040-1065
- `handleAddProject` — lines 1067-1104
- `handleGetFileList` — lines 1107-1120
- `handleGetFileContent` — lines 1122-1134
- `handleFileCommand` — lines 1136-1163
- `handleTerminalCommand` — lines 1166-1257
- `handlePtyCreate` — lines 1260-1320
- `handlePtyInput` — lines 1322-1332
- `handlePtyResize` — lines 1334-1349
- `handlePtyClose` — lines 1351-1359
- `handleCancel` — lines 1362-1378
- `handleRewind` — lines 1381-1391
- `handleInputSync` — lines 1394-1404
- `handleGetTodo` — lines 1407-1410

Also export a dispatch table:
```typescript
export const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  message: handleMessage,
  permission_response: handlePermissionResponse,
  // ... etc
};

export async function dispatchMessage(
  deps: HandlerDeps,
  clientId: string,
  handler: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const fn = MESSAGE_HANDLERS[handler];
  if (fn) {
    await fn(deps, clientId, payload);
  } else {
    deps.log(`   [ws] Unhandled: ${handler}`);
  }
}
```

**Dedup PTY creation:** Both `handleTerminalCommand` (action=create) and `handlePtyCreate` call:
```typescript
async function createAndConnectPty(
  deps: HandlerDeps,
  clientId: string,
): Promise<void> {
  // Shared logic from both handlers
}
```

**Step 5: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/message-handlers.test.ts`
Expected: PASS

**Step 6: Integrate into relay-stack.ts**

Replace the `wsHandler.on("message", ...)` handler (lines 698-1449) with:

```typescript
import { dispatchMessage, type HandlerDeps } from "./message-handlers.js";

// Build deps object
const handlerDeps: HandlerDeps = {
  wsHandler, client, sessionMgr, messageCache,
  permissionBridge, questionBridge, overrides, ptyManager,
  config, log, connectPtyUpstream,
};

wsHandler.on("message", async ({ clientId, handler, payload }) => {
  try {
    await dispatchMessage(handlerDeps, clientId, handler, payload);
  } catch (err) {
    const errMsg = buildErrorResponse(err, "HANDLER_ERROR");
    console.error(`   [ws] Error handling ${handler}:`, formatErrorDetail(err));
    wsHandler.sendTo(clientId, errMsg);
  }
});
```

This replaces ~750 lines with ~12 lines.

**Step 7: Run full test suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/message-handlers.ts test/unit/message-handlers.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract message handlers from relay-stack switch statement"
```

---

### Task 5: Extract SSE wiring from relay-stack

**Files:**
- Create: `src/lib/sse-wiring.ts`
- Create: `test/unit/sse-wiring.test.ts`
- Modify: `src/lib/relay-stack.ts:1434-1601` (replace SSE handler block)

**Context:** Lines 1434-1601 wire the SSE consumer events, translate them, filter by session, record to cache, broadcast, and send push notifications. Extract to a function that takes all deps.

**Step 1: Write the test**

```typescript
// test/unit/sse-wiring.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleSSEEvent } from "../../src/lib/sse-wiring.js";
import type { OpenCodeEvent } from "../../src/lib/types.js";

describe("handleSSEEvent", () => {
  function createDeps(overrides?: Record<string, unknown>) {
    return {
      translator: { translate: vi.fn() },
      wsHandler: { broadcast: vi.fn() },
      sessionMgr: { getActiveSessionId: vi.fn().mockReturnValue("active-1") },
      messageCache: { recordEvent: vi.fn() },
      permissionBridge: { onPermissionRequest: vi.fn(), onPermissionReplied: vi.fn() },
      questionBridge: { onQuestion: vi.fn() },
      overrides: { clearProcessingTimeout: vi.fn() },
      config: {} as any,
      log: vi.fn(),
      ...overrides,
    };
  }

  it("translates and broadcasts messages for active session", () => {
    const deps = createDeps();
    deps.translator.translate.mockReturnValue({ type: "delta", text: "hi" });
    deps.sessionMgr.getActiveSessionId.mockReturnValue("s1");

    const event: OpenCodeEvent = {
      type: "message.part.delta",
      properties: { sessionID: "s1", delta: "hi", partID: "p1", field: "text" },
    };

    handleSSEEvent(deps as any, event);

    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith({ type: "delta", text: "hi" });
    expect(deps.messageCache.recordEvent).toHaveBeenCalledWith("s1", { type: "delta", text: "hi" });
  });

  it("skips broadcast for non-active session but still caches", () => {
    const deps = createDeps();
    deps.translator.translate.mockReturnValue({ type: "delta", text: "hi" });
    deps.sessionMgr.getActiveSessionId.mockReturnValue("s1");

    const event: OpenCodeEvent = {
      type: "message.part.delta",
      properties: { sessionID: "s2", delta: "hi", partID: "p1", field: "text" },
    };

    handleSSEEvent(deps as any, event);

    expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
    expect(deps.messageCache.recordEvent).toHaveBeenCalledWith("s2", { type: "delta", text: "hi" });
  });

  it("clears processing timeout on done event for active session", () => {
    const deps = createDeps();
    deps.translator.translate.mockReturnValue({ type: "done", code: 0 });
    deps.sessionMgr.getActiveSessionId.mockReturnValue("s1");

    const event: OpenCodeEvent = {
      type: "session.completed",
      properties: { sessionID: "s1" },
    };

    handleSSEEvent(deps as any, event);

    expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalled();
  });

  it("handles permission.asked events", () => {
    const deps = createDeps();
    deps.translator.translate.mockReturnValue(null);

    const event: OpenCodeEvent = {
      type: "permission.asked",
      properties: { id: "perm-1", tool: "Bash" },
    };

    handleSSEEvent(deps as any, event);

    expect(deps.permissionBridge.onPermissionRequest).toHaveBeenCalledWith(event);
  });

  it("does not cache non-cacheable events", () => {
    const deps = createDeps();
    deps.translator.translate.mockReturnValue({ type: "file_changed", path: "/x", changeType: "edited" });
    deps.sessionMgr.getActiveSessionId.mockReturnValue("s1");

    const event: OpenCodeEvent = {
      type: "file.edited",
      properties: { sessionID: "s1", path: "/x" },
    };

    handleSSEEvent(deps as any, event);

    expect(deps.messageCache.recordEvent).not.toHaveBeenCalled();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/sse-wiring.test.ts`
Expected: FAIL

**Step 3: Write the implementation**

```typescript
// src/lib/sse-wiring.ts
// ─── SSE Event Wiring ──────────────────────────────────────────────────────────
// Handles the SSE → translate → filter → cache → broadcast pipeline.
//
// Data flow:
//   1. SSE event arrives from OpenCode
//   2. Bridge events (permission.asked, question.asked) are handled first
//   3. Translator converts to RelayMessage(s)
//   4. Session filter: only broadcast events for the active session
//   5. Cache: record chat-relevant events per session
//   6. Broadcast to connected browser clients
//   7. Push notifications for done/error/permission events
```

Contains `handleSSEEvent()` function plus `extractSessionId()` (moved from relay-stack) and `isCacheable()` (moved from relay-stack).

**Step 4: Run test, integrate, full suite, lint, commit**

```bash
pnpm vitest run test/unit/sse-wiring.test.ts
pnpm test && pnpm lint:fix
git add src/lib/sse-wiring.ts test/unit/sse-wiring.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract SSE wiring from relay-stack"
```

---

### Task 6: Extract client-connected handler

**Files:**
- Create: `src/lib/client-init.ts`
- Create: `test/unit/client-init.test.ts`
- Modify: `src/lib/relay-stack.ts:489-636` (replace client_connected handler)

**Context:** The `client_connected` handler (lines 489-636) sends session info, model info, agent list, provider list, and PTY replay to new clients. Extract to `handleClientConnected(deps, clientId)`.

**Step 1: Write tests for key behaviors**

Test that:
- Session with cache hit sends `session_switched` with events
- Session with cache miss sends `session_switched` with history from REST API
- Agent list is sent (filtering internal agents)
- Provider list is sent (only configured providers)
- PTY sessions are replayed

**Step 2: Implement `handleClientConnected` in `src/lib/client-init.ts`**

Move `filterAgents()` helper here too (currently at relay-stack.ts lines 106-116).

**Step 3: Integrate into relay-stack.ts**

Replace `wsHandler.on("client_connected", ...)` with:
```typescript
import { handleClientConnected } from "./client-init.js";
wsHandler.on("client_connected", ({ clientId }) => handleClientConnected(deps, clientId));
```

**Step 4: Full suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/client-init.ts test/unit/client-init.test.ts src/lib/relay-stack.ts
git commit -m "refactor: extract client-connected handler from relay-stack"
```

---

### Task 7: OpenCode event type guards

**Files:**
- Create: `src/lib/opencode-events.ts`
- Create: `test/unit/opencode-events.test.ts`
- Modify: `src/lib/event-translator.ts` (replace `as` casts with type guards)
- Modify: `src/lib/sse-wiring.ts` (use type guards for session error, permission)

**Context:** Currently `event.properties as { sessionID?: string; ... }` is scattered everywhere. Create typed event interfaces with type guards.

**Step 1: Write tests**

```typescript
// test/unit/opencode-events.test.ts
import { describe, expect, it } from "vitest";
import {
  isPartDeltaEvent,
  isPartUpdatedEvent,
  isSessionStatusEvent,
  isPermissionAskedEvent,
} from "../../src/lib/opencode-events.js";

describe("isPartDeltaEvent", () => {
  it("returns true for valid part delta", () => {
    expect(isPartDeltaEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1", messageID: "m1", partID: "p1", delta: "hi", field: "text" },
    })).toBe(true);
  });

  it("returns false for missing fields", () => {
    expect(isPartDeltaEvent({
      type: "message.part.delta",
      properties: { sessionID: "s1" },
    })).toBe(false);
  });

  it("returns false for wrong type", () => {
    expect(isPartDeltaEvent({
      type: "session.status",
      properties: { sessionID: "s1", partID: "p1", delta: "hi", field: "text" },
    })).toBe(false);
  });
});
```

**Step 2: Implement type guards in `src/lib/opencode-events.ts`**

Define interfaces extending `OpenCodeEvent` with typed `properties`, plus `is*` type guard functions for each event type used in the codebase.

**Step 3: Replace `as` casts in event-translator.ts and sse-wiring.ts**

**Step 4: Full suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/opencode-events.ts test/unit/opencode-events.test.ts src/lib/event-translator.ts src/lib/sse-wiring.ts
git commit -m "refactor: add OpenCode event type guards, replace as casts"
```

---

### Task 8: Message-cache — return result from file ops

**Files:**
- Modify: `src/lib/message-cache.ts:170-192`
- Modify: `test/unit/message-cache.test.ts` (add test for error result)

**Context:** `appendToFile` and `rewriteFile` swallow errors with console.error. Change to return `{ ok: boolean; error?: string }`.

**Step 1: Write the test**

Add to existing `test/unit/message-cache.test.ts`:
```typescript
it("appendToFile returns error for unwritable path", () => {
  // Create cache with non-existent deeply nested dir that can't be created
  const cache = new MessageCache("/nonexistent/deeply/nested/path");
  // recordEvent should not throw but the file op fails
  // Verify the cache still has the event in memory
  cache.recordEvent("s1", { type: "delta", text: "hi" });
  expect(cache.getEvents("s1")).toEqual([{ type: "delta", text: "hi" }]);
});
```

**Step 2: Modify `appendToFile` and `rewriteFile`**

Change return type to `{ ok: boolean; error?: string }`. The existing callers don't use the return value, so this is backward-compatible.

**Step 3: Full suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/message-cache.ts test/unit/message-cache.test.ts
git commit -m "refactor: message-cache file ops return result instead of swallowing"
```

---

### Task 9: Structured logging context

**Files:**
- Modify: `src/lib/message-handlers.ts` (add session/client context to logs)
- Modify: `src/lib/sse-wiring.ts` (add event context to logs)

**Context:** After the extractions, each handler is a named function. Add structured context to log calls.

**Step 1: Update message handler logs**

In each handler, replace:
```typescript
log(`   [msg] → ${text.slice(0, 80)}`);
```
with:
```typescript
log(`   [msg] client=${clientId} session=${activeId} → ${text.slice(0, 80)}`);
```

**Step 2: Update SSE event logs**

Replace:
```typescript
log(`   [sse] Event: ${event.type}`);
```
with:
```typescript
log(`   [sse] event=${event.type} session=${eventSessionId ?? "?"}`);
```

**Step 3: Full suite + lint + commit**

```bash
pnpm test && pnpm lint:fix
git add src/lib/message-handlers.ts src/lib/sse-wiring.ts
git commit -m "refactor: add structured logging context to handlers and SSE wiring"
```

---

### Task 10: Flow documentation + verify relay-stack is slim

**Files:**
- Modify: `src/lib/sse-wiring.ts` (add pipeline doc header — already done in task 5)
- Modify: `src/lib/pty-manager.ts` (add lifecycle doc header — already done in task 2)
- Modify: `src/lib/message-handlers.ts` (add session switch decision tree comment)
- Verify: `src/lib/relay-stack.ts` is ~300 lines

**Step 1: Add session switch documentation**

Add a comment block above `handleSwitchSession` in `message-handlers.ts`:
```typescript
/**
 * Switch to a different session.
 *
 * Decision tree for history delivery:
 *   1. Cache has chat content (user_message or delta)?
 *      → Send session_switched with events (client replays)
 *   2. No cache? REST API fallback
 *      → Send session_switched with history (structured messages)
 *   3. REST API fails?
 *      → Send session_switched with no data (empty session view)
 *
 * After switch: load model info from session, clear overrides.
 */
```

**Step 2: Verify relay-stack.ts line count**

Run: `wc -l src/lib/relay-stack.ts`
Expected: ~250-350 lines (was 1841)

**Step 3: Run full suite one final time**

```bash
pnpm test && pnpm check && pnpm lint
```

**Step 4: Commit**

```bash
git add src/lib/message-handlers.ts src/lib/relay-stack.ts
git commit -m "docs: add flow documentation for session switch, PTY lifecycle, SSE pipeline"
```

---

## Task Dependency Graph

```
Task 1 (SessionOverrides)  ──┐
Task 2 (PtyManager)         ──┤
Task 3 (Error Response)     ──┼── Task 4 (Message Handlers) ── Task 5 (SSE Wiring) ── Task 6 (Client Init) ── Task 9 (Logging)
                               │                                                                                    │
                               └── Task 7 (Type Guards) ────────────────────────────────────────────────────────────┘
                                                                                                                     │
Task 8 (Message Cache) ─────────────────────────────────────────────────────────────────────────── Task 10 (Docs + Verify)
```

Tasks 1, 2, 3, 7, 8 are independent and can be done in parallel.
Task 4 depends on 1, 2, 3.
Task 5 depends on 4.
Task 6 depends on 4.
Task 9 depends on 4, 5.
Task 10 depends on all.
