# Dual SDK Implementation Plan v3

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.
>
> **IMPORTANT:** Read the "Audit Amendments v3" section at the bottom of this file BEFORE implementing any task. Those amendments override inline task code where they conflict.

**Goal:** Refactor conduit to support both the OpenCode SDK and the Claude Agent SDK side-by-side, enabling Claude subscription account users to work through conduit via the Agent SDK while keeping OpenCode for all other providers.

**Architecture:** Four phases. Phase 1 migrates the hand-rolled client to `@opencode-ai/sdk`. Phase 2 extracts a `SessionBackend` interface from the session-centric methods. Phase 3 implements `ClaudeAgentBackend` using `@anthropic-ai/claude-agent-sdk`. Phase 4 wires model-level backend switching with BackendProxy into the relay and UI.

**Design doc:** `docs/plans/2026-03-31-dual-sdk-design.md`

**Audit history:**
- v1 → v2: 57 amendments (see "Audit Amendments v1 → v2" below)
- v2 audit: 117 findings (see "Audit Amendments v2 audit" below)
- v2 → v3: 30 amendments from re-audit (see "Audit Amendments v3" at bottom)

**Reference impl:** `~/src/personal/opencode-relay/claude-relay/lib/sdk-bridge.js` (Clay)

**Tech Stack:** TypeScript, `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, Vitest

---

## Audit Amendments (v1 → v2)

Key corrections incorporated from the 57-amendment audit:

1. **Permission return format**: `{ behavior: "allow" }` / `{ behavior: "deny", message }` — NOT `hookSpecificOutput`.
2. **AskUserQuestion**: Returns `{ behavior: "allow", updatedInput: { ...input, answers } }` — separate path from regular permissions.
3. **canUseTool signature**: 3 args — `(toolName, toolInput, options?)` where `options` has `signal?: AbortSignal`.
4. **Optional operations**: `forkSession`, `revertSession`, `unrevertSession` are optional on `SessionBackend`. Callers check before calling. Frontend hides buttons.
5. **BackendProxy pattern** (Phase 4): Components hold proxy reference. Swap updates proxy, all existing references see new backend. No component graph teardown.
6. **Message queue**: Async iterable prompt from Clay for multi-turn within a live `query()`. `pushMessage()` feeds messages into the queue.
7. **Session resume**: SDK-native `resume: cliSessionId` — never reconstruct history for same-backend turns.
8. **Cross-backend continuity**: Prepend history only on first message after backend switch.
9. **Provider-based routing**: Anthropic subscription -> Agent SDK, everything else -> OpenCode.
10. **Merged session list**: From all backends, tagged with `backendType`.
11. **Shutdown cleanup**: Reject all pending deferreds, abort active query, end message queue, close channel.
12. **No deferred timeout**: Permissions stay pending until explicitly resolved. Re-shown on reconnect.
13. **AsyncEventChannel**: Moved earlier (Task 2) — shared by both backends.

## Audit Amendments (v2 audit — 117 findings, incorporated inline)

Synthesis: `docs/plans/2026-03-31-dual-sdk-v2-audit.md`
Individual reports: `docs/plans/audits/dual-sdk-v2-task-*.md`

### Cross-Cutting Directives (apply to ALL tasks)

**D1 — Phase 1 gating:** Every task's first step MUST be "Verify Phase 1 is complete: confirm `src/lib/instance/sdk-client.ts` and `src/lib/instance/relay-types.ts` exist. Run `pnpm check`." If Phase 1 is NOT complete, substitute `OpenCodeClient`/`opencode-client.ts` throughout.

**D2 — No `any` types:** All method parameters and returns must use actual types from `types.ts`/`relay-types.ts`. No `as any` casts in production code. `as unknown as T` in test mocks is acceptable. Type `activeQuery` as `import("@anthropic-ai/claude-agent-sdk").Query | null`. Use `SDKMessage` discriminated union for translator, not `Record<string, any>`.

**D3 — Import paths:** `Logger` from `"../logger.js"` (NOT `../logging.js`). `ServiceRegistry` from `"../daemon/service-registry.js"` (NOT `../relay/service-registry.js`). Static imports only — no dynamic `await import()` (no circular deps to break).

**D4 — AsyncEventChannel is single-consumer:** Add runtime guard in `next()`: if `this.resolver` is already set, throw `Error("AsyncEventChannel supports only one concurrent consumer")`. Document constraint with JSDoc. The `ClaudeAgentBackend`'s shared channel uses a per-subscriber wrapper pattern (see Task 9 amendments) — subscriber abort breaks iteration without closing the channel.

**D5 — MessageQueue wraps AsyncEventChannel:** Task 7's `MessageQueue` is a thin wrapper, NOT a copy-paste: `class MessageQueue { private ch = new AsyncEventChannel<SDKUserMessage>(); push(msg) { this.ch.push(msg); } end() { this.ch.close(); } ... }`.

**D6 — `undefined as any` elimination:** Replace all `value: undefined as any, done: true` with `value: undefined, done: true as const` in iterators. TS 5.x `IteratorResult<T>` discriminated union accepts this.

**D7 — Concurrent queries:** `ClaudeAgentBackend` supports concurrent per-session queries via `Map<sessionId, QueryState>` (NOT single `activeQuery`/`messageQueue` fields). Each session gets its own `QueryState { query, messageQueue, abortController, streamPromise, activeSessionId }`. See Task 9/10 amendments.

**D8 — `sessionID` not `sessionId`:** The existing `Message` type uses `sessionID` (capital ID). All translator output and helper functions must use `sessionID`.

### Design Decisions (from audit Ask User questions)

| Decision | Choice | Rationale |
|---|---|---|
| Channel consumers | Single-consumer with runtime guard | Matches relay-stack's single SSE consumer pattern |
| `getSSEConsumer()` | Keep on `OpenCodeBackend` | Accept coupling for simplicity. Relay-stack already knows concrete type. |
| PTY deps naming | Rename `client` to `infraClient` | Consistency |
| System/init events | Forward to frontend | Useful for model/tool display |
| SDK user messages | Drop | Relay tracks user messages via PendingUserMessages |
| Query concurrency | Per-session concurrent queries | Via `Map<sessionId, QueryState>` |
| Auth type detection | Server-side from env/config | Stored in `ProjectRelayConfig` |
| UI capability gating | Capabilities object | Server sends `{ fork, revert }` with session_list |
| Swap drain | Accept the race | Frontend refresh makes it non-issue |
| Poller wiring scope | OpenCode backend directly | Pollers are OpenCode-specific recovery |
| Task 12 factory | Remove, defer to Task 14 | Factory conflicts with BackendProxy pattern |
| Question rejection | Return `{ behavior: "deny" }` | Match Clay. Never throw from canUseTool. |
| Startup getConfig | Direct `client.getConfig()` | Backend not fully initialized at startup |

---

## Phase 1: OpenCode SDK Migration

Phase 1 is covered by the existing plan at `docs/plans/2026-03-12-sdk-migration-plan.md` (9 tasks, audited twice, ready for execution). That plan installs `@opencode-ai/sdk`, creates a composition-based `RelayClient` with the same 45-method flat API, swaps imports across 24 files, and deletes the hand-rolled `OpenCodeClient`.

**Execute that plan first.** The remainder of this plan assumes Phase 1 is complete and `RelayClient` (from `sdk-client.ts`) is the sole client class.

---

## Phase 2: Extract SessionBackend Interface

### Method Split

The 45 `RelayClient` methods split into two groups:

**SessionBackend (session-centric, swappable per model) — 26 methods:**
`getHealth`, `listSessions`, `getSession`, `createSession`, `deleteSession`, `updateSession`, `getSessionStatuses`, `getMessages`, `getMessage`, `getMessagesPage`, `sendMessageAsync`, `abortSession`, `listPendingPermissions`, `replyPermission`, `listPendingQuestions`, `replyQuestion`, `rejectQuestion`, `listAgents`, `listProviders`, `listCommands`, `listSkills`, `forkSession`*, `revertSession`*, `unrevertSession`*, `getConfig`, `updateConfig`

\* = optional on the interface (Claude Agent SDK has no equivalent)

**InfraClient (model-agnostic, always OpenCode) — 16 methods:**
`getPath`, `getVcs`, `getCurrentProject`, `listProjects`, `listDirectory`, `getFileContent`, `getFileStatus`, `findText`, `findFiles`, `findSymbols`, `createPty`, `deletePty`, `resizePty`, `listPtys`, `getBaseUrl`, `getAuthHeaders`

**Dropped (unused by relay) — 3 methods:**
`shareSession`, `summarizeSession`, `getSessionDiff`

### Handler Impact

| Handler file | Currently uses | After split |
|---|---|---|
| `session.ts` | `getSession`, `listPendingPermissions`, `listPendingQuestions`, `forkSession`, `getMessage`, `getMessagesPage` | `sessionBackend` only |
| `prompt.ts` | `sendMessageAsync`, `abortSession`, `revertSession` | `sessionBackend` only |
| `permissions.ts` | `replyPermission`, `getConfig`, `updateConfig`, `replyQuestion`, `listPendingQuestions`, `rejectQuestion` | `sessionBackend` only |
| `model.ts` | `listProviders`, `getSession`, `updateConfig` | `sessionBackend` only |
| `agent.ts` | `listAgents` | `sessionBackend` only |
| `settings.ts` | `listCommands`, `listProjects` | both (`listCommands` -> `sessionBackend`, `listProjects` -> `infraClient`) |
| `files.ts` | `getFileContent`, `listDirectory` | `infraClient` only |
| `terminal.ts` | `createPty`, `deletePty`, `listPtys`, `resizePty` | `infraClient` only |

---

### Task 1: Define SessionBackend Interface and InfraClient Type

**Files:**
- Create: `src/lib/backend/types.ts`
- Create: `test/unit/backend/types.test.ts`

**Step 0: Verify Phase 1 status**

Check if `src/lib/instance/sdk-client.ts` exists. If Phase 1 is complete, import from `"../instance/relay-types.js"`. If not, import from `"../instance/opencode-client.js"` and substitute `OpenCodeClient` for `RelayClient` throughout.

**Step 1: Write the interface**

```typescript
// src/lib/backend/types.ts
import type {
    SessionDetail, SessionStatus, SessionCreateOptions, SessionListOptions,
    Message, PromptOptions, PermissionReplyOptions, QuestionReplyOptions,
    Agent, ProviderListResult, PtyCreateOptions, HealthResponse,
} from "../instance/opencode-client.js";

/**
 * Session-centric operations that differ between backends.
 * OpenCode: wraps RelayClient REST calls + SSEConsumer.
 * Claude Agent SDK: wraps query() + async event channel.
 *
 * forkSession / revertSession / unrevertSession are OPTIONAL — the Claude
 * Agent SDK has no equivalent. Callers must check existence before calling.
 * Frontend hides the corresponding buttons when absent.
 */
export interface SessionBackend {
    readonly type: "opencode" | "claude-agent";

    // Lifecycle
    initialize(): Promise<void>;
    shutdown(): Promise<void>;
    getHealth(): Promise<HealthResponse>;

    // Sessions
    listSessions(options?: SessionListOptions): Promise<SessionDetail[]>;
    getSession(id: string): Promise<SessionDetail>;
    createSession(options?: SessionCreateOptions): Promise<SessionDetail>;
    deleteSession(id: string): Promise<void>;
    updateSession(id: string, updates: { title?: string; archived?: boolean }): Promise<SessionDetail>;
    getSessionStatuses(): Promise<Record<string, SessionStatus>>;

    // Messages
    getMessages(sessionId: string): Promise<Message[]>;
    getMessage(sessionId: string, messageId: string): Promise<Message>;
    getMessagesPage(sessionId: string, options?: { limit?: number; before?: string }): Promise<Message[]>;
    sendMessage(sessionId: string, prompt: PromptOptions): Promise<void>;
    abortSession(id: string): Promise<void>;

    // Permissions & Questions
    listPendingPermissions(): Promise<Array<{ id: string; permission: string; [key: string]: unknown }>>;
    replyPermission(options: PermissionReplyOptions): Promise<void>;
    listPendingQuestions(): Promise<Array<{ id: string; [key: string]: unknown }>>;
    replyQuestion(options: QuestionReplyOptions): Promise<void>;
    rejectQuestion(id: string): Promise<void>;

    // Discovery
    listAgents(): Promise<Agent[]>;
    listProviders(): Promise<ProviderListResult>;
    listCommands(): Promise<Array<{ name: string; description?: string }>>;
    listSkills(): Promise<Array<{ name: string; description?: string }>>;
    getConfig(): Promise<Record<string, unknown>>;
    updateConfig(config: Record<string, unknown>): Promise<Record<string, unknown>>;

    // Session operations — OPTIONAL (not all backends support these)
    forkSession?(id: string, options: { messageID?: string; title?: string }): Promise<SessionDetail>;
    revertSession?(id: string, messageId: string): Promise<void>;
    unrevertSession?(id: string): Promise<void>;

    // Events
    subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent>;
}

/**
 * Model-agnostic infrastructure operations — always OpenCode.
 * PTY, files, search, VCS, projects.
 */
export interface InfraClient {
    // Projects
    getPath(): Promise<{ cwd: string }>;
    getVcs(): Promise<{ branch?: string; dirty?: boolean }>;
    getCurrentProject(): Promise<{ id: string; name?: string; path?: string; worktree?: string }>;
    listProjects(): Promise<Array<{ id: string; name?: string; path?: string; worktree?: string }>>;

    // Files
    listDirectory(path?: string): Promise<Array<{ name: string; type: string; size?: number }>>;
    getFileContent(path: string): Promise<{ content: string; binary?: boolean }>;
    getFileStatus(): Promise<Array<{ path: string; status: string }>>;

    // Search
    findText(pattern: string): Promise<Array<{ path: string; line: number; text: string }>>;
    findFiles(query: string): Promise<string[]>;
    findSymbols(query: string): Promise<Array<{ name: string; path: string; kind: string }>>;

    // PTY
    createPty(options?: PtyCreateOptions): Promise<{ id: string }>;
    deletePty(ptyId: string): Promise<void>;
    resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
    listPtys(): Promise<Array<{ id: string; [key: string]: unknown }>>;

    // Auth/URL for PTY upstream
    getBaseUrl(): string;
    getAuthHeaders(): Record<string, string>;
}

/**
 * Unified event type emitted by all backends.
 * Re-exported from types.ts — structurally matches OpenCodeEvent
 * so existing EventTranslator works.
 */
export type { OpenCodeEvent as BackendEvent } from "../types.js";
```

**Step 2: Write a structural test**

```typescript
// test/unit/backend/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { SessionBackend, InfraClient } from "../../../src/lib/backend/types.js";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";

describe("SessionBackend interface", () => {
    it("SessionBackend methods have compatible signatures with OpenCodeClient", () => {
        // Verify method-level assignability, not just name membership.
        // Excluded: type, initialize, shutdown, subscribeEvents (backend-only),
        // sendMessage (renamed from sendMessageAsync), and the 3 optional methods.
        type SharedMethods = Exclude<
            keyof SessionBackend,
            "type" | "initialize" | "shutdown" | "subscribeEvents" | "sendMessage"
            | "forkSession" | "revertSession" | "unrevertSession"
        >;
        // Pick the shared methods from both types and verify assignability
        expectTypeOf<Pick<OpenCodeClient, SharedMethods>>().toMatchTypeOf<Pick<SessionBackend, SharedMethods>>();
    });

    it("sendMessage is compatible with sendMessageAsync", () => {
        // SessionBackend.sendMessage maps to OpenCodeClient.sendMessageAsync
        type SendFn = OpenCodeClient["sendMessageAsync"];
        type BackendSendFn = SessionBackend["sendMessage"];
        expectTypeOf<SendFn>().toMatchTypeOf<BackendSendFn>();
    });

    it("optional operations exist on OpenCodeClient", () => {
        type OptionalMethods = "forkSession" | "revertSession" | "unrevertSession";
        expectTypeOf<Pick<OpenCodeClient, OptionalMethods>>().toMatchTypeOf<Required<Pick<SessionBackend, OptionalMethods>>>();
    });

    it("every InfraClient method exists on OpenCodeClient", () => {
        // Name-only check is sufficient — direct assignment catches type mismatches
        type InfraMethods = keyof InfraClient;
        type ClientMethods = keyof OpenCodeClient;
        expectTypeOf<InfraMethods>().toMatchTypeOf<ClientMethods>();
    });
});
```

**Step 3: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/types.test.ts
```

**Step 4: Commit**

```bash
git add src/lib/backend/types.ts test/unit/backend/types.test.ts
git commit -m "feat: define SessionBackend and InfraClient interfaces

Optional forkSession/revertSession/unrevertSession for backends
without equivalents (Claude Agent SDK)."
```

---

### Task 2: AsyncEventChannel and Deferred Utilities

Shared utilities used by both `OpenCodeBackend` (SSE -> AsyncIterable bridge) and `ClaudeAgentBackend` (query generator -> relay stream, permission bridging).

**Files:**
- Create: `src/lib/backend/async-event-channel.ts`
- Create: `test/unit/backend/async-event-channel.test.ts`
- Create: `src/lib/backend/deferred.ts`
- Create: `test/unit/backend/deferred.test.ts`

**Step 1: Write failing tests for AsyncEventChannel**

```typescript
// test/unit/backend/async-event-channel.test.ts
import { describe, it, expect } from "vitest";
import { AsyncEventChannel } from "../../../src/lib/backend/async-event-channel.js";

describe("AsyncEventChannel", () => {
    it("delivers pushed events in order", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);
        ch.push(2);
        ch.push(3);
        ch.close();

        const results: number[] = [];
        for await (const n of ch) results.push(n);
        expect(results).toEqual([1, 2, 3]);
    });

    it("blocks consumer until event is pushed", async () => {
        const ch = new AsyncEventChannel<string>();
        const iter = ch[Symbol.asyncIterator]();

        // Push after a delay
        setTimeout(() => ch.push("hello"), 10);
        const { value, done } = await iter.next();
        expect(value).toBe("hello");
        expect(done).toBe(false);

        ch.close();
    });

    it("returns done after close", async () => {
        const ch = new AsyncEventChannel<string>();
        ch.close();

        const iter = ch[Symbol.asyncIterator]();
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("unblocks waiting consumer on close", async () => {
        const ch = new AsyncEventChannel<string>();
        const iter = ch[Symbol.asyncIterator]();

        // Consumer is waiting. Close should unblock it.
        setTimeout(() => ch.close(), 10);
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("ignores push after close", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);
        ch.close();
        ch.push(2); // should be ignored

        const results: number[] = [];
        for await (const n of ch) results.push(n);
        expect(results).toEqual([1]);
    });

    it("return() closes the channel", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);

        const iter = ch[Symbol.asyncIterator]();
        const { value } = await iter.next();
        expect(value).toBe(1);

        await iter.return!();
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("throws if two consumers call next() concurrently", async () => {
        const ch = new AsyncEventChannel<number>();
        const iter = ch[Symbol.asyncIterator]();

        // First consumer blocks
        const p1 = iter.next();
        // Second consumer should throw
        expect(() => iter.next()).toThrow("AsyncEventChannel supports only one concurrent consumer");

        ch.push(1);
        ch.close();
        await p1;
    });

    it("delivers buffered items before done on close", async () => {
        const ch = new AsyncEventChannel<number>();
        ch.push(1);
        ch.push(2);
        ch.close();

        const iter = ch[Symbol.asyncIterator]();
        const r1 = await iter.next();
        expect(r1).toEqual({ value: 1, done: false });
        const r2 = await iter.next();
        expect(r2).toEqual({ value: 2, done: false });
        const r3 = await iter.next();
        expect(r3.done).toBe(true);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/async-event-channel.test.ts
```

Expected: FAIL — module doesn't exist yet.

**Step 3: Implement AsyncEventChannel**

```typescript
// src/lib/backend/async-event-channel.ts

/**
 * Push-pull async channel bridging event producers to async iterable consumers.
 *
 * Used by:
 * - OpenCodeBackend: SSEConsumer EventEmitter -> AsyncIterable<BackendEvent>
 * - ClaudeAgentBackend: query() generator -> relay event stream
 *
 * Between queries on the Claude Agent SDK, the channel is empty and the
 * consumer awaits. No errors, no disconnection. When a new query() starts,
 * events flow again.
 */
export class AsyncEventChannel<T> {
    private queue: T[] = [];
    private resolver: ((value: IteratorResult<T>) => void) | null = null;
    private closed = false;

    push(event: T): void {
        if (this.closed) return;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: event, done: false });
        } else {
            this.queue.push(event);
        }
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        if (this.resolver) {
            const resolve = this.resolver;
            this.resolver = null;
            resolve({ value: undefined, done: true as const });
        }
    }

    get isClosed(): boolean {
        return this.closed;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        const self = this;
        return {
            next(): Promise<IteratorResult<T>> {
                if (self.resolver) {
                    throw new Error("AsyncEventChannel supports only one concurrent consumer");
                }
                if (self.queue.length > 0) {
                    return Promise.resolve({ value: self.queue.shift()!, done: false as const });
                }
                if (self.closed) {
                    return Promise.resolve({ value: undefined, done: true as const });
                }
                return new Promise(resolve => { self.resolver = resolve; });
            },
            return(): Promise<IteratorResult<T>> {
                self.close();
                return Promise.resolve({ value: undefined, done: true as const });
            },
            [Symbol.asyncIterator]() { return this; },
        };
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/async-event-channel.test.ts
```

**Step 5: Write failing tests for Deferred**

```typescript
// test/unit/backend/deferred.test.ts
import { describe, it, expect } from "vitest";
import { createDeferred } from "../../../src/lib/backend/deferred.js";

describe("Deferred", () => {
    it("resolves with a value", async () => {
        const d = createDeferred<string>();
        d.resolve("hello");
        expect(await d.promise).toBe("hello");
    });

    it("rejects with a reason", async () => {
        const d = createDeferred<string>();
        d.reject(new Error("boom"));
        await expect(d.promise).rejects.toThrow("boom");
    });

    it("can be awaited before resolution", async () => {
        const d = createDeferred<number>();
        setTimeout(() => d.resolve(42), 10);
        expect(await d.promise).toBe(42);
    });
});
```

**Step 6: Implement Deferred**

```typescript
// src/lib/backend/deferred.ts

export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
}

export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
```

**Step 7: Run all tests**

```bash
pnpm vitest run test/unit/backend/async-event-channel.test.ts test/unit/backend/deferred.test.ts
```

**Step 8: Commit**

```bash
git add src/lib/backend/async-event-channel.ts test/unit/backend/async-event-channel.test.ts \
        src/lib/backend/deferred.ts test/unit/backend/deferred.test.ts
git commit -m "feat: add AsyncEventChannel and Deferred utilities for backend bridging"
```

---

### Task 3: Implement OpenCodeBackend

The first `SessionBackend` implementation. Wraps `RelayClient` for session-centric methods and owns the `SSEConsumer` for event streaming. Pure delegation — no behavior change.

**Files:**
- Create: `src/lib/backend/opencode-backend.ts`
- Create: `test/unit/backend/opencode-backend.test.ts`

**Step 0: Verify Phase 1 status**

Check if `src/lib/instance/sdk-client.ts` exists. If Phase 1 is complete, import from `"../instance/relay-types.js"`. If not, import from `"../instance/opencode-client.js"` and substitute `OpenCodeClient` for `RelayClient` throughout.

**Step 1: Write failing tests**

```typescript
// test/unit/backend/opencode-backend.test.ts
import { describe, it, expect, vi } from "vitest";
import { OpenCodeBackend } from "../../../src/lib/backend/opencode-backend.js";

function createMockRelayClient() {
    return {
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: "s1" }),
        createSession: vi.fn().mockResolvedValue({ id: "s2" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue({ id: "s1" }),
        getSessionStatuses: vi.fn().mockResolvedValue({}),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessage: vi.fn().mockResolvedValue({ id: "m1" }),
        getMessagesPage: vi.fn().mockResolvedValue([]),
        sendMessageAsync: vi.fn().mockResolvedValue(undefined),
        abortSession: vi.fn().mockResolvedValue(undefined),
        listPendingPermissions: vi.fn().mockResolvedValue([]),
        replyPermission: vi.fn().mockResolvedValue(undefined),
        listPendingQuestions: vi.fn().mockResolvedValue([]),
        replyQuestion: vi.fn().mockResolvedValue(undefined),
        rejectQuestion: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([]),
        listProviders: vi.fn().mockResolvedValue({ providers: [], defaults: {}, connected: [] }),
        listCommands: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn().mockResolvedValue({}),
        forkSession: vi.fn().mockResolvedValue({ id: "s3" }),
        revertSession: vi.fn().mockResolvedValue(undefined),
        unrevertSession: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
        getAuthHeaders: vi.fn().mockReturnValue({ Authorization: "Basic test" }),
    };
}

describe("OpenCodeBackend", () => {
    it("has type 'opencode'", () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.type).toBe("opencode");
    });

    it("delegates listSessions to RelayClient", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        await backend.listSessions({ roots: true });
        expect(client.listSessions).toHaveBeenCalledWith({ roots: true });
    });

    it("delegates sendMessage to sendMessageAsync", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        await backend.sendMessage("s1", { text: "hello" });
        expect(client.sendMessageAsync).toHaveBeenCalledWith("s1", { text: "hello" });
    });

    it("implements optional forkSession", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.forkSession).toBeDefined();
        await backend.forkSession!("s1", { title: "fork" });
        expect(client.forkSession).toHaveBeenCalledWith("s1", { title: "fork" });
    });

    it("implements optional revertSession", async () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.revertSession).toBeDefined();
        await backend.revertSession!("s1", "m1");
        expect(client.revertSession).toHaveBeenCalledWith("s1", "m1");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/opencode-backend.test.ts
```

Expected: FAIL — `OpenCodeBackend` doesn't exist yet.

**Step 3: Implement OpenCodeBackend**

```typescript
// src/lib/backend/opencode-backend.ts
import type { SessionBackend, BackendEvent } from "./types.js";
import type { OpenCodeClient } from "../instance/opencode-client.js";
import type {
    SessionCreateOptions, SessionListOptions, PromptOptions,
    PermissionReplyOptions, QuestionReplyOptions,
} from "../instance/opencode-client.js";
import { SSEConsumer } from "../relay/sse-consumer.js";
import type { ServiceRegistry } from "../daemon/service-registry.js";
import type { Logger } from "../logger.js";
import { AsyncEventChannel } from "./async-event-channel.js";

export interface OpenCodeBackendOptions {
    client: OpenCodeClient;
    sseConfig?: {
        registry: ServiceRegistry;
        baseUrl: string;
        authHeaders?: Record<string, string>;
        log?: Logger;
    };
}

/**
 * SessionBackend wrapping OpenCode's REST API + SSE event stream.
 * Every session-centric method delegates directly to OpenCodeClient.
 * SSEConsumer events are bridged to AsyncIterable via AsyncEventChannel.
 *
 * OpenCode supports all operations including the optional ones
 * (forkSession, revertSession, unrevertSession).
 */
export class OpenCodeBackend implements SessionBackend {
    readonly type = "opencode" as const;
    private readonly client: OpenCodeClient;
    private readonly sseConfig?: OpenCodeBackendOptions["sseConfig"];
    private sseConsumer?: SSEConsumer;

    constructor(options: OpenCodeBackendOptions) {
        this.client = options.client;
        this.sseConfig = options.sseConfig;
    }

    async initialize(): Promise<void> {
        if (this.sseConfig) {
            this.sseConsumer = new SSEConsumer(this.sseConfig.registry, {
                baseUrl: this.sseConfig.baseUrl,
                ...(this.sseConfig.authHeaders && { authHeaders: this.sseConfig.authHeaders }),
                ...(this.sseConfig.log && { log: this.sseConfig.log }),
            });
            await this.sseConsumer.connect();
        }
    }

    async shutdown(): Promise<void> {
        await this.sseConsumer?.disconnect();
    }

    /** Expose SSEConsumer for relay-stack wiring that still needs direct access. */
    getSSEConsumer(): SSEConsumer | undefined {
        return this.sseConsumer;
    }

    // --- Direct delegation to OpenCodeClient ---

    getHealth() { return this.client.getHealth(); }
    listSessions(options?: SessionListOptions) { return this.client.listSessions(options); }
    getSession(id: string) { return this.client.getSession(id); }
    createSession(options?: SessionCreateOptions) { return this.client.createSession(options); }
    deleteSession(id: string) { return this.client.deleteSession(id); }
    updateSession(id: string, updates: { title?: string; archived?: boolean }) { return this.client.updateSession(id, updates); }
    getSessionStatuses() { return this.client.getSessionStatuses(); }
    getMessages(sessionId: string) { return this.client.getMessages(sessionId); }
    getMessage(sessionId: string, messageId: string) { return this.client.getMessage(sessionId, messageId); }
    getMessagesPage(sessionId: string, options?: { limit?: number; before?: string }) { return this.client.getMessagesPage(sessionId, options); }
    sendMessage(sessionId: string, prompt: PromptOptions) { return this.client.sendMessageAsync(sessionId, prompt); }
    abortSession(id: string) { return this.client.abortSession(id); }
    listPendingPermissions() { return this.client.listPendingPermissions(); }
    replyPermission(options: PermissionReplyOptions) { return this.client.replyPermission(options); }
    listPendingQuestions() { return this.client.listPendingQuestions(); }
    replyQuestion(options: QuestionReplyOptions) { return this.client.replyQuestion(options); }
    rejectQuestion(id: string) { return this.client.rejectQuestion(id); }
    listAgents() { return this.client.listAgents(); }
    listProviders() { return this.client.listProviders(); }
    listCommands() { return this.client.listCommands(); }
    listSkills() { return this.client.listSkills(); }
    getConfig() { return this.client.getConfig(); }
    updateConfig(config: Record<string, unknown>) { return this.client.updateConfig(config); }

    // --- Optional operations (OpenCode supports all of these) ---

    forkSession(id: string, options: { messageID?: string; title?: string }) { return this.client.forkSession(id, options); }
    revertSession(id: string, messageId: string) { return this.client.revertSession(id, messageId); }
    unrevertSession(id: string) { return this.client.unrevertSession(id); }

    // --- Event streaming ---

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        if (!this.sseConsumer) return;

        const channel = new AsyncEventChannel<BackendEvent>();
        const handler = (event: { type: string; properties: Record<string, unknown> }) => {
            channel.push({ type: event.type, properties: event.properties });
        };
        this.sseConsumer.on("event", handler);

        signal.addEventListener("abort", () => {
            this.sseConsumer?.off("event", handler);
            channel.close();
        }, { once: true });

        yield* channel;
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/opencode-backend.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/opencode-backend.ts test/unit/backend/opencode-backend.test.ts
git commit -m "feat: implement OpenCodeBackend wrapping OpenCodeClient + SSEConsumer"
```

---

### Task 4: Split HandlerDeps into sessionBackend + infraClient

Replace the single `client: OpenCodeClient` (now `RelayClient`) field on `HandlerDeps` and `ClientInitDeps` with `sessionBackend: SessionBackend` and `infraClient: InfraClient`. Update all 8 handler files and the mock factory.

**Files:**
- Modify: `src/lib/handlers/types.ts` — split `client` field into `sessionBackend` + `infraClient`
- Modify: `src/lib/bridges/client-init.ts` — split `client` to `sessionBackend` only (no infraClient needed)
- Modify: `src/lib/handlers/session.ts` — `deps.client` → `deps.sessionBackend`
- Modify: `src/lib/handlers/prompt.ts` — `deps.client` → `deps.sessionBackend`
- Modify: `src/lib/handlers/permissions.ts` — `deps.client` → `deps.sessionBackend`
- Modify: `src/lib/handlers/model.ts` — `deps.client` → `deps.sessionBackend`
- Modify: `src/lib/handlers/agent.ts` — `deps.client` → `deps.sessionBackend`
- Modify: `src/lib/handlers/settings.ts` — both (`listCommands` → sessionBackend, `listProjects` → infraClient)
- Modify: `src/lib/handlers/files.ts` — `deps.client` → `deps.infraClient`
- Modify: `src/lib/handlers/terminal.ts` — `deps.client` → `deps.infraClient`
- Modify: `src/lib/relay/handler-deps-wiring.ts:37` — `HandlerDepsWiringDeps.client` → split
- Modify: `src/lib/relay/monitoring-wiring.ts:44,128` — `MonitoringWiringDeps.client` → `sessionBackend: Pick<SessionBackend, "getMessages">`
- Modify: `src/lib/relay/session-lifecycle-wiring.ts:24,68` — same pattern
- Modify: `src/lib/relay/relay-stack.ts:355-356` — SSE lambdas → `sessionBackend.listPendingQuestions()` / `sessionBackend.listPendingPermissions()`
- Modify: `test/helpers/mock-factories.ts` — split mock, remove phantom `switchModel`

**Step 1: Update `HandlerDeps` interface**

In `src/lib/handlers/types.ts`, replace:
```typescript
client: OpenCodeClient;
```
with:
```typescript
sessionBackend: SessionBackend;
infraClient: InfraClient;
```

Update imports from `../instance/opencode-client.js` (or post-Phase-1 `../instance/sdk-client.js`) to `../backend/types.js`.

**Step 2: Update `ClientInitDeps` interface**

In `src/lib/bridges/client-init.ts`, replace `client: OpenCodeClient` with `sessionBackend: SessionBackend`.
No `infraClient` needed — all 5 calls in `handleClientConnected` are session-backend methods:
`getSession`, `listPendingPermissions`, `listPendingQuestions`, `listAgents`, `listProviders`.

**Step 3: Update each handler file (mechanical replacements)**

Session-centric handlers:
- `deps.client.listSessions(...)` -> `deps.sessionBackend.listSessions(...)`
- `deps.client.sendMessageAsync(...)` -> `deps.sessionBackend.sendMessage(...)` (renamed)
- `deps.client.getSession(...)` -> `deps.sessionBackend.getSession(...)`
- etc.

Infra handlers:
- `deps.client.getFileContent(...)` -> `deps.infraClient.getFileContent(...)`
- `deps.client.createPty(...)` -> `deps.infraClient.createPty(...)`
- etc.

Mixed handler (`settings.ts`):
- `deps.client.listCommands()` -> `deps.sessionBackend.listCommands()`
- `deps.client.listProjects()` -> `deps.infraClient.listProjects()`

**Guarding optional operations in prompt.ts:**

For `revertSession` in `prompt.ts`, add a guard:

```typescript
// Before (v1)
await deps.client.revertSession(sessionId, messageId);

// After (v2)
if (!deps.sessionBackend.revertSession) {
    throw new Error("Revert not supported by current backend");
}
await deps.sessionBackend.revertSession(sessionId, messageId);
```

Same pattern for `forkSession` in `session.ts`.

**Step 4: Update mock factory**

Split `createMockClient()` into two functions:

```typescript
export function createMockSessionBackend(): SessionBackend {
    return {
        type: "opencode",
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn().mockResolvedValue({ id: "s1" }),
        createSession: vi.fn().mockResolvedValue({ id: "s2" }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue({ id: "s1" }),
        getSessionStatuses: vi.fn().mockResolvedValue({}),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessage: vi.fn().mockResolvedValue({ id: "m1" }),
        getMessagesPage: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        abortSession: vi.fn().mockResolvedValue(undefined),
        listPendingPermissions: vi.fn().mockResolvedValue([]),
        replyPermission: vi.fn().mockResolvedValue(undefined),
        listPendingQuestions: vi.fn().mockResolvedValue([]),
        replyQuestion: vi.fn().mockResolvedValue(undefined),
        rejectQuestion: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([]),
        listProviders: vi.fn().mockResolvedValue({ providers: [], defaults: {}, connected: [] }),
        listCommands: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn().mockResolvedValue({}),
        forkSession: vi.fn().mockResolvedValue({ id: "s3" }),
        revertSession: vi.fn().mockResolvedValue(undefined),
        unrevertSession: vi.fn().mockResolvedValue(undefined),
        subscribeEvents: vi.fn(),
    } as unknown as SessionBackend;
}

export function createMockInfraClient(): InfraClient {
    return {
        getPath: vi.fn().mockResolvedValue({ cwd: "/tmp" }),
        listDirectory: vi.fn().mockResolvedValue([]),
        getFileContent: vi.fn().mockResolvedValue({ content: "" }),
        createPty: vi.fn().mockResolvedValue({ id: "pty1" }),
        // ... all InfraClient methods ...
        getBaseUrl: vi.fn().mockReturnValue("http://localhost:4096"),
        getAuthHeaders: vi.fn().mockReturnValue({}),
    } as unknown as InfraClient;
}
```

Update `createMockHandlerDeps()` and `createMockClientInitDeps()` to use both.

> **Note:** Keep `pty-upstream.ts` narrow: it only needs `{ getAuthHeaders(): Record<string, string> }`, not the full InfraClient.

**Step 5: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

All handler tests should pass since the mock factory provides the same method stubs, just under different field names.

**Step 6: Commit (split by risk)**

Commit 1 — types + mock factory:
```bash
git add src/lib/handlers/types.ts src/lib/bridges/client-init.ts test/helpers/mock-factories.ts
git commit -m "refactor: split HandlerDeps.client into sessionBackend + infraClient"
```

Commit 2 — handler files:
```bash
git add src/lib/handlers/session.ts src/lib/handlers/prompt.ts src/lib/handlers/permissions.ts \
        src/lib/handlers/model.ts src/lib/handlers/agent.ts src/lib/handlers/settings.ts \
        src/lib/handlers/files.ts src/lib/handlers/terminal.ts src/lib/bridges/client-init.ts
git commit -m "refactor: update all handlers to use sessionBackend/infraClient

Guard optional ops (forkSession, revertSession) behind existence check."
```

---

### Task 5: Refactor Relay Stack to Use SessionBackend + InfraClient

The relay stack currently constructs a single `RelayClient` and passes it everywhere. Refactor to construct `OpenCodeBackend` (wrapping `RelayClient` + SSEConsumer) for session-centric operations, and pass `RelayClient` directly as `InfraClient`.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts:96-113,127-475` — update `RelayStack`/`ProjectRelay` interface, construct `OpenCodeBackend`, pass `sessionBackend` + `infraClient`
- Modify: `src/lib/relay/handler-deps-wiring.ts` — passes both `sessionBackend` and `infraClient` to handler deps
- Modify: `src/lib/relay/monitoring-wiring.ts:44,128` — uses `Pick<SessionBackend, "getMessages">`
- Modify: `src/lib/relay/session-lifecycle-wiring.ts:24,68` — same pattern
- Modify: `src/lib/session/session-manager.ts:26,109` — change `client` to `backend: SessionBackend`
- Modify: `src/lib/session/session-status-poller.ts:39,60` — change `Pick<OpenCodeClient, ...>` to `Pick<SessionBackend, ...>`
- Modify: `src/lib/relay/message-poller.ts:441` — change `Pick<OpenCodeClient, "getMessages">` to `Pick<SessionBackend, "getMessages">`
- Modify: `src/lib/relay/message-poller-manager.ts:27` — same
- Modify: `test/helpers/mock-factories.ts:302-323` — update `createMockProjectRelay()` to use `sessionBackend` + `infraClient`

**Step 1: Update relay-stack.ts**

At line ~145, after constructing `RelayClient`:

```typescript
const client = new RelayClient({ baseUrl: config.opencodeUrl, ... });

// Backend wraps client for session-centric operations + owns SSE
const sessionBackend = new OpenCodeBackend({
    client,
    sseConfig: {
        registry: serviceRegistry,
        baseUrl: config.opencodeUrl,
        authHeaders: client.getAuthHeaders(),
        log: loggers.sse,
    },
});

// Direct assignment — all 16 InfraClient method signatures verified compatible
const infraClient: InfraClient = client;
```

Pass `sessionBackend` to SessionManager, SessionStatusPoller, MessagePollerManager, handler deps wiring. Pass `infraClient` to handler deps wiring and PTY upstream.

Replace direct SSEConsumer construction (line ~327) with `await sessionBackend.initialize()`. Get the SSEConsumer reference via `sessionBackend.getSSEConsumer()` for sse-wiring that still needs direct access to connection health/events.

Update `ProjectRelay` interface to expose `sessionBackend: SessionBackend` and `infraClient: InfraClient` instead of (or alongside) `client: OpenCodeClient`.

> **Note:** The `client.getConfig()` call at relay startup (line ~252) stays as direct `client.getConfig()` — backend is not yet initialized at this point.

**Step 2: Update SessionManager constructor**

Change `SessionManagerOptions.client: OpenCodeClient` to `SessionManagerOptions.backend: SessionBackend`. Update internal references:
- `this.client.listSessions()` -> `this.backend.listSessions()`
- `this.client.getMessagesPage()` -> `this.backend.getMessagesPage()`
- `this.client.createSession()` -> `this.backend.createSession()`
- `this.client.deleteSession()` -> `this.backend.deleteSession()`
- `this.client.updateSession()` -> `this.backend.updateSession()` (called via `renameSession()`)
- `this.client.getMessagesPage(limit:10000)` -> `this.backend.getMessagesPage(limit:10000)` (called via `loadHistoryByCursorScan()`)

**Step 3: Update poller `Pick<>` types**

SessionStatusPoller: `Pick<SessionBackend, "getSessionStatuses" | "getSession">`
MessagePoller/Manager: `Pick<SessionBackend, "getMessages">`

These are mechanical — same method names, just different source type for the Pick.

**Step 4: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
```

**Step 5: Commit**

```bash
git commit -am "refactor: relay stack uses SessionBackend + InfraClient

SessionManager, pollers, and handlers all program against the interface.
SSEConsumer owned by OpenCodeBackend."
```

---

### Task 6: Phase 2 Final Verification

**Step 1: Run full suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 2: Verify no direct RelayClient usage in handlers**

```bash
rg "deps\.client\." src/lib/handlers/
```

Should return zero results. All handler code should use `deps.sessionBackend` or `deps.infraClient`.

**Step 3: Verify SessionBackend is the abstraction point**

```bash
rg "RelayClient" src/lib/handlers/ src/lib/session/ src/lib/relay/message-poller
```

Should return zero results in these directories — they should only reference `SessionBackend` or `InfraClient`.

**Step 4: Smoke test**

Start relay, verify sessions, messaging, PTY, file browser, permissions all work identically.

**Step 5: Commit**

```bash
git commit -m "refactor: Phase 2 complete — SessionBackend abstraction in place"
```

---

## Phase 3: Claude Agent SDK Backend

### Task 7: Install Claude Agent SDK and Create MessageQueue Utility

**Files:**
- Modify: `package.json`
- Create: `src/lib/backend/message-queue.ts`
- Create: `test/unit/backend/message-queue.test.ts`

**Step 1: Install the SDK**

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

**Step 2: Write failing tests for MessageQueue**

The MessageQueue is an async iterable that Clay uses as the `prompt` parameter to `query()`. It allows feeding messages into a live query. The SDK consumes from it; the relay pushes into it.

```typescript
// test/unit/backend/message-queue.test.ts
import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../../src/lib/backend/message-queue.js";

describe("MessageQueue", () => {
    it("yields pushed messages in order", async () => {
        const q = new MessageQueue();
        q.push({ type: "user", message: { role: "user", content: "first" } });
        q.push({ type: "user", message: { role: "user", content: "second" } });
        q.end();

        const msgs: any[] = [];
        for await (const m of q) msgs.push(m);
        expect(msgs).toHaveLength(2);
        expect(msgs[0].message.content).toBe("first");
        expect(msgs[1].message.content).toBe("second");
    });

    it("blocks consumer until message is pushed", async () => {
        const q = new MessageQueue();
        const iter = q[Symbol.asyncIterator]();

        setTimeout(() => q.push({ type: "user", message: { role: "user", content: "hello" } }), 10);
        const { value, done } = await iter.next();
        expect(value.message.content).toBe("hello");
        expect(done).toBe(false);

        q.end();
    });

    it("returns done after end()", async () => {
        const q = new MessageQueue();
        q.end();

        const iter = q[Symbol.asyncIterator]();
        const { done } = await iter.next();
        expect(done).toBe(true);
    });

    it("unblocks waiting consumer on end()", async () => {
        const q = new MessageQueue();
        const iter = q[Symbol.asyncIterator]();

        setTimeout(() => q.end(), 10);
        const { done } = await iter.next();
        expect(done).toBe(true);
    });
});
```

**Step 3: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/message-queue.test.ts
```

**Step 4: Implement MessageQueue**

MessageQueue is a thin wrapper around AsyncEventChannel per D5 directive — NOT a copy-paste of the channel internals. This eliminates `undefined as any` (D6) since AsyncEventChannel (fixed in Task 2) handles iterator termination correctly.

```typescript
// src/lib/backend/message-queue.ts
import { AsyncEventChannel } from "./async-event-channel.js";

/**
 * Async iterable message queue used as the `prompt` parameter to the
 * Claude Agent SDK's query() function. Thin wrapper around AsyncEventChannel
 * per D5 directive.
 *
 * - push(): feeds a user message into the live query
 * - end(): signals no more messages (terminates the query's input)
 */
export interface SDKUserMessage {
    type: "user";
    message: {
        role: "user";
        content: string | Array<{ type: string; [key: string]: unknown }>;
    };
}

export class MessageQueue {
    private readonly channel = new AsyncEventChannel<SDKUserMessage>();

    push(msg: SDKUserMessage): void {
        this.channel.push(msg);
    }

    end(): void {
        this.channel.close();
    }

    get isEnded(): boolean {
        return this.channel.isClosed;
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<SDKUserMessage> {
        return this.channel[Symbol.asyncIterator]();
    }
}
```

**Step 5: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/message-queue.test.ts
```

**Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml \
        src/lib/backend/message-queue.ts test/unit/backend/message-queue.test.ts
git commit -m "feat: add Claude Agent SDK and MessageQueue for multi-turn queries"
```

---

### Task 8: SDKMessage Translator

Translates Claude Agent SDK message types into `BackendEvent` matching the existing OpenCode event structure, so the downstream EventTranslator and relay caches work without modification.

**Files:**
- Create: `src/lib/backend/sdk-message-translator.ts`
- Create: `test/unit/backend/sdk-message-translator.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/backend/sdk-message-translator.test.ts
import { describe, it, expect } from "vitest";
import { translateSdkMessage } from "../../../src/lib/backend/sdk-message-translator.js";

describe("translateSdkMessage", () => {
    it("translates assistant message to message.updated with cost/tokens", () => {
        const result = translateSdkMessage({
            type: "assistant",
            uuid: "uuid-1",
            session_id: "sess-1",
            message: {
                id: "msg-1",
                role: "assistant",
                content: [{ type: "text", text: "hello" }],
                usage: { input_tokens: 100, output_tokens: 50, cost: 0.005 },
            },
        });
        expect(result).not.toBeNull();
        const event = result as any;
        expect(event.type).toBe("message.updated");
        expect(event.properties.sessionID).toBe("sess-1");
        expect(event.properties.message.cost).toBe(0.005);
        expect(event.properties.message.tokens.input).toBe(100);
    });

    it("drops user messages (relay tracks via PendingUserMessages)", () => {
        const result = translateSdkMessage({
            type: "user",
            session_id: "sess-1",
            message: { role: "user", content: "hello" },
        });
        expect(result).toBeNull();
    });

    it("translates text stream_event to message.part.delta", () => {
        const result = translateSdkMessage({
            type: "stream_event",
            session_id: "sess-1",
            uuid: "uuid-1",
            event: {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "hi" },
            },
        });
        expect(result).not.toBeNull();
        const event = result as any;
        expect(event.type).toBe("message.part.delta");
        expect(event.properties.field).toBe("text");
        expect(event.properties.delta).toBe("hi");
        expect(event.properties.partID).toBe("part-0");
    });

    it("translates tool_use start to message.part.updated", () => {
        const result = translateSdkMessage({
            type: "stream_event",
            session_id: "sess-1",
            uuid: "uuid-1",
            event: {
                type: "content_block_start",
                content_block: { type: "tool_use", id: "tu-1", name: "Bash" },
            },
        });
        expect(result).not.toBeNull();
        const event = result as any;
        expect(event.type).toBe("message.part.updated");
        expect(event.properties.part.tool).toBe("Bash");
        expect(event.properties.part.state.status).toBe("pending");
    });

    it("translates success result to BOTH session.status + message.updated", () => {
        const result = translateSdkMessage({
            type: "result",
            subtype: "success",
            session_id: "sess-1",
            result: "done",
            total_cost_usd: 0.01,
            usage: { input_tokens: 200, output_tokens: 100 },
        });
        expect(Array.isArray(result)).toBe(true);
        const events = result as any[];
        expect(events).toHaveLength(2);
        // First event: session.status with idle → produces "done"
        expect(events[0].type).toBe("session.status");
        expect(events[0].properties.status.type).toBe("idle");
        // Second event: message.updated with cost data → produces "result"
        expect(events[1].type).toBe("message.updated");
        expect(events[1].properties.message.cost).toBe(0.01);
    });

    it("translates error result to session.status + session.error", () => {
        const result = translateSdkMessage({
            type: "result",
            subtype: "error_during_execution",
            session_id: "sess-1",
            result: "failed",
            total_cost_usd: 0.005,
            usage: {},
        });
        const events = result as any[];
        expect(events.some((e: any) => e.type === "session.status")).toBe(true);
        expect(events.some((e: any) => e.type === "session.error")).toBe(true);
    });

    it("translates system init to session.status with busy", () => {
        const result = translateSdkMessage({
            type: "system",
            subtype: "init",
            session_id: "sess-1",
            tools: [],
            model: "claude-sonnet-4-20250514",
            mcp_servers: [],
        });
        expect(result).not.toBeNull();
        const event = result as any;
        expect(event.type).toBe("session.status");
        expect(event.properties.status.type).toBe("busy");
    });

    it("returns null for unknown message types", () => {
        const result = translateSdkMessage({ type: "unknown_type" });
        expect(result).toBeNull();
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/sdk-message-translator.test.ts
```

**Step 3: Implement translator**

The translator must produce BackendEvent types that match what the downstream
EventTranslator expects via its type guards. Key corrections from v1:
- User messages are DROPPED (relay tracks via PendingUserMessages, per D8/audit)
- `stream_event` with text_delta → `message.part.delta` (NOT `message.part.updated`)
- `result` → produces MULTIPLE events (array): `session.status` + `message.updated` and/or `session.error`
- `system` init → `session.status` with `{ type: "busy" }` (NOT `session.initialized`)
- Uses `sessionID` (capital ID) throughout per D8
- No `...msg` spread (no leaking raw SDK properties)
- Uses `SDKMessage` structural interface, not `Record<string, any>` per D2

```typescript
// src/lib/backend/sdk-message-translator.ts
import type { BackendEvent } from "./types.js";

/**
 * Translates Claude Agent SDK messages into BackendEvent objects matching
 * the OpenCode SSE event structure. The downstream EventTranslator validates
 * specific property shapes via type guards — we must match them exactly.
 *
 * SDK message types:
 * - assistant: complete assistant message (after tool execution)
 * - user: DROPPED (relay tracks via PendingUserMessages)
 * - stream_event: raw Anthropic API streaming delta
 * - result: query completed (success or error)
 * - system: init metadata, status changes
 */

/**
 * @returns One or more BackendEvents, or null if the message should be dropped.
 */
export function translateSdkMessage(msg: SDKMessage): BackendEvent | BackendEvent[] | null {
    switch (msg.type) {
        case "assistant":
            return translateAssistant(msg);

        case "user":
            // DROP — relay tracks user messages via PendingUserMessages
            return null;

        case "stream_event":
            return translateStreamEvent(msg);

        case "result":
            return translateResult(msg);

        case "system":
            return translateSystem(msg);

        default:
            return null;
    }
}

function translateAssistant(msg: SDKMessage & { type: "assistant" }): BackendEvent {
    const usage = msg.message?.usage;
    return {
        type: "message.updated",
        properties: {
            sessionID: msg.session_id,
            message: {
                id: msg.uuid ?? msg.message?.id,
                role: "assistant",
                cost: usage?.cost ?? 0,
                tokens: {
                    input: usage?.input_tokens ?? 0,
                    output: usage?.output_tokens ?? 0,
                    cache: {
                        read: usage?.cache_read_input_tokens ?? 0,
                        write: usage?.cache_creation_input_tokens ?? 0,
                    },
                },
                time: {
                    created: msg.message?.created_at ?? Date.now(),
                    completed: Date.now(),
                },
            },
        },
    };
}

function translateStreamEvent(msg: SDKMessage & { type: "stream_event" }): BackendEvent | null {
    const event = msg.event;
    if (!event) return null;

    // Text deltas → message.part.delta
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        return {
            type: "message.part.delta",
            properties: {
                sessionID: msg.session_id,
                messageID: msg.uuid,
                partID: `part-${event.index}`,
                field: "text",
                delta: event.delta.text,
            },
        };
    }

    // Thinking block start → register reasoning part so deltas can find it
    if (event.type === "content_block_start" && event.content_block?.type === "thinking") {
        return {
            type: "message.part.updated",
            properties: {
                messageID: msg.uuid,
                partID: `part-${event.index}`,
                part: {
                    id: `part-${event.index}`,
                    type: "reasoning",
                },
            },
        };
    }

    // Thinking deltas → message.part.delta with field "thinking"
    if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta") {
        return {
            type: "message.part.delta",
            properties: {
                sessionID: msg.session_id,
                messageID: msg.uuid,
                partID: `part-${event.index}`,
                field: "thinking",
                delta: event.delta.thinking,
            },
        };
    }

    // Tool use start → message.part.updated
    if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        return {
            type: "message.part.updated",
            properties: {
                messageID: msg.uuid,
                partID: event.content_block.id,
                part: {
                    id: event.content_block.id,
                    type: "tool",
                    callID: event.content_block.id,
                    tool: event.content_block.name,
                    state: { status: "pending" },
                    time: { start: Date.now() },
                },
            },
        };
    }

    // Tool use delta (input accumulation)
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
        return {
            type: "message.part.delta",
            properties: {
                sessionID: msg.session_id,
                messageID: msg.uuid,
                partID: `part-${event.index}`,
                field: "input",
                delta: event.delta.partial_json,
            },
        };
    }

    return null;
}

function translateResult(msg: SDKMessage & { type: "result" }): BackendEvent[] {
    const isSuccess = msg.subtype === "success";
    const isLimitReached = msg.subtype === "error_max_turns" || msg.subtype === "error_max_budget_usd";
    const isError = msg.subtype === "error_during_execution";

    const events: BackendEvent[] = [];

    // 1. session.status with idle type → produces "done" RelayMessage
    events.push({
        type: "session.status",
        properties: {
            sessionID: msg.session_id,
            status: { type: "idle" },
        },
    });

    // 2. message.updated with cost/token data → produces "result" RelayMessage
    if (isSuccess || isLimitReached) {
        events.push({
            type: "message.updated",
            properties: {
                sessionID: msg.session_id,
                message: {
                    role: "assistant",
                    cost: msg.total_cost_usd ?? 0,
                    tokens: {
                        input: msg.usage?.input_tokens ?? 0,
                        output: msg.usage?.output_tokens ?? 0,
                        cache: {
                            read: msg.usage?.cache_read_input_tokens ?? 0,
                            write: msg.usage?.cache_creation_input_tokens ?? 0,
                        },
                    },
                    time: { completed: Date.now() },
                },
            },
        });
    }

    // 3. session.error for actual errors
    if (isError) {
        events.push({
            type: "session.error",
            properties: {
                sessionID: msg.session_id,
                error: {
                    name: "QueryError",
                    data: { message: String(msg.result ?? "Query failed") },
                },
            },
        });
    }

    return events;
}

function translateSystem(msg: SDKMessage & { type: "system" }): BackendEvent | null {
    if (msg.subtype === "init") {
        // Forward init data to frontend — tools, model, MCP servers
        return {
            type: "session.status",
            properties: {
                sessionID: msg.session_id,
                status: { type: "busy" },
                tools: msg.tools,
                model: msg.model,
                mcpServers: msg.mcp_servers,
            },
        };
    }

    // Other system subtypes — extract specific fields only (no ...msg spread)
    return {
        type: "session.status",
        properties: {
            sessionID: msg.session_id,
            status: { type: "busy" },
            subtype: msg.subtype,
        },
    };
}

/**
 * SDK message type. Until the SDK exports a proper discriminated union,
 * use this structural type.
 */
interface SDKMessage {
    type: string;
    subtype?: string;
    session_id?: string;
    uuid?: string;
    message?: Record<string, any>;
    event?: Record<string, any>;
    result?: unknown;
    total_cost_usd?: number;
    usage?: Record<string, number>;
    tools?: unknown[];
    model?: string;
    mcp_servers?: unknown[];
    parent_tool_use_id?: string | null;
    [key: string]: unknown;
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/sdk-message-translator.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/sdk-message-translator.ts test/unit/backend/sdk-message-translator.test.ts
git commit -m "feat: SDKMessage to BackendEvent translator for Claude Agent SDK

Produces event types matching downstream EventTranslator type guards:
- message.part.delta (text, thinking, input deltas)
- message.part.updated (tool use start)
- message.updated (assistant cost/tokens, result summary)
- session.status (idle=done, busy=init)
- session.error (query failures)
Drops user messages (relay tracks via PendingUserMessages).
Uses sessionID (capital ID) per D8."
```

---

### Task 9: Implement ClaudeAgentBackend — Session Management

The first slice: session CRUD, discovery, and lazy session creation. No messaging yet.

**Files:**
- Create: `src/lib/backend/claude-agent-backend.ts`
- Create: `test/unit/backend/claude-agent-backend.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/backend/claude-agent-backend.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the SDK module
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    listSessions: vi.fn(),
    getSessionMessages: vi.fn(),
    getSessionInfo: vi.fn(),
    query: vi.fn(),
}));

import { ClaudeAgentBackend } from "../../../src/lib/backend/claude-agent-backend.js";
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

describe("ClaudeAgentBackend — session management", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("has type 'claude-agent'", () => {
        expect(backend.type).toBe("claude-agent");
    });

    it("listSessions delegates to SDK listSessions", async () => {
        vi.mocked(listSessions).mockResolvedValue([
            { id: "sdk-sess-1", cwd: "/tmp/project" },
        ] as any);

        const sessions = await backend.listSessions();
        expect(listSessions).toHaveBeenCalledWith({ dir: "/tmp/project", limit: 50 });
        expect(sessions).toHaveLength(1);
        expect(sessions[0].id).toBe("sdk-sess-1");
    });

    it("createSession creates a local placeholder (lazy)", async () => {
        const session = await backend.createSession();
        expect(session.id).toMatch(/^local-/);
        // No SDK call — session materializes on first message
        expect(listSessions).not.toHaveBeenCalled();
    });

    it("getMessages for a local session returns empty", async () => {
        const session = await backend.createSession();
        const msgs = await backend.getMessages(session.id);
        expect(msgs).toEqual([]);
    });

    it("getMessages for an SDK session delegates to getSessionMessages", async () => {
        vi.mocked(getSessionMessages).mockResolvedValue([
            { type: "user", message: { role: "user", content: "hi" } },
        ] as any);

        const msgs = await backend.getMessages("sdk-sess-1");
        expect(getSessionMessages).toHaveBeenCalledWith("sdk-sess-1", expect.objectContaining({ dir: "/tmp/project" }));
    });

    it("does NOT implement forkSession", () => {
        expect(backend.forkSession).toBeUndefined();
    });

    it("does NOT implement revertSession", () => {
        expect(backend.revertSession).toBeUndefined();
    });

    it("does NOT implement unrevertSession", () => {
        expect(backend.unrevertSession).toBeUndefined();
    });

    it("shutdown rejects pending deferreds", async () => {
        // Will be tested more in Task 11 (permissions)
        await expect(backend.shutdown()).resolves.toBeUndefined();
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/claude-agent-backend.test.ts
```

**Step 3: Implement ClaudeAgentBackend (session management slice)**

```typescript
// src/lib/backend/claude-agent-backend.ts
import { listSessions, getSessionMessages, getSessionInfo, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { SessionBackend, BackendEvent, SessionDetail, SessionStatus, Agent, PromptOptions } from "./types.js";
import { AsyncEventChannel } from "./async-event-channel.js";
import { MessageQueue, type SDKUserMessage } from "./message-queue.js";
import { createDeferred, type Deferred } from "./deferred.js";
import { translateSdkMessage } from "./sdk-message-translator.js";
import type { Logger } from "../logger.js";

export interface ClaudeAgentBackendOptions {
    cwd: string;
    apiKey?: string;
    model?: string;
    allowedTools?: string[];
    log?: Logger;
}

interface PermissionEntry {
    deferred: Deferred<PermissionDecision>;
    metadata: { id: string; permission: string; input: unknown; timestamp: number };
}

// Type aliases for permission/question reply options
type PermissionReplyOptions = { id: string; decision: "once" | "always" | "reject" };
type QuestionReplyOptions = { id: string; answers: string[][] };

interface QuestionEntry {
    deferred: Deferred<QuestionAnswer>;
    metadata: { id: string; toolUseId: string; input: unknown; timestamp: number };
}

interface PermissionDecision {
    decision: "allow" | "deny";
    feedback?: string;
}

interface QuestionAnswer {
    answers: string[][]; // string[][] per SDK handler format
}

interface QueryState {
    query: import("@anthropic-ai/claude-agent-sdk").Query;
    messageQueue: MessageQueue;
    abortController: AbortController;
    streamPromise: Promise<void>;
    cliSessionId: string | null;
}

interface LocalSession {
    id: string;
    title: string;
    created: number;
}

/**
 * SessionBackend wrapping the Claude Agent SDK's query() API.
 *
 * Key patterns (from Clay reference impl):
 * - MessageQueue as async iterable prompt for multi-turn within a live query
 * - Deferred promise bridge for canUseTool permission/question callbacks
 * - AsyncEventChannel bridging per-query events to continuous relay stream
 * - SDK-native resume via cliSessionId (never reconstruct history)
 * - Lazy session creation (local placeholder until first message)
 * - Per-session concurrent queries via Map<string, QueryState> (D7)
 *
 * Does NOT implement forkSession, revertSession, unrevertSession
 * (no Claude Agent SDK equivalent).
 */
export class ClaudeAgentBackend implements SessionBackend {
    readonly type = "claude-agent" as const;

    private readonly cwd: string;
    private readonly apiKey: string | undefined;
    private model: string;
    private readonly allowedTools: string[];
    private readonly log?: Logger;

    // Per-session query state (D7: concurrent queries via Map, NOT single fields)
    private readonly queries = new Map<string, QueryState>();

    // Event channel — continuous stream consumed by relay
    private readonly channel = new AsyncEventChannel<BackendEvent>();

    // Permission and question bridging
    private readonly pendingPermissions = new Map<string, PermissionEntry>();
    private readonly pendingQuestions = new Map<string, QuestionEntry>();

    // Session tracking
    private readonly localSessions = new Map<string, LocalSession>();
    private readonly sessionIdMap = new Map<string, string>(); // localId -> cliSessionId
    private readonly cliSessionIds = new Map<string, string>(); // relaySessionId -> cliSessionId

    constructor(options: ClaudeAgentBackendOptions) {
        this.cwd = options.cwd;
        this.apiKey = options.apiKey;
        this.model = options.model ?? "claude-sonnet-4-20250514";
        this.allowedTools = options.allowedTools ?? ["Read", "Glob", "Grep", "WebFetch"];
        this.log = options.log;
    }

    async initialize(): Promise<void> {
        // Validate cwd exists, API key available via env or option
        this.log?.info("ClaudeAgentBackend initialized", { cwd: this.cwd });
    }

    async shutdown(): Promise<void> {
        // 1. Abort all active queries (per-session Map)
        for (const [, state] of this.queries) {
            state.abortController.abort();
            state.messageQueue.end();
        }

        // 2. Reject all pending deferreds to unblock blocked canUseTool callbacks
        for (const [id, entry] of this.pendingPermissions) {
            entry.deferred.reject(new Error("Backend shutting down"));
            this.pendingPermissions.delete(id);
        }
        for (const [id, entry] of this.pendingQuestions) {
            entry.deferred.reject(new Error("Backend shutting down"));
            this.pendingQuestions.delete(id);
        }

        // 3. Wait for all streams to finish
        const promises = [...this.queries.values()].map(s => s.streamPromise.catch(() => {}));
        await Promise.all(promises);

        // 4. Close event channel (backend lifetime is over)
        this.channel.close();
        this.queries.clear();
    }

    async getHealth() {
        return { ok: true };
    }

    // --- Session CRUD ---

    async listSessions(options?: { limit?: number }) {
        const sdkSessions = await listSessions({ dir: this.cwd, limit: options?.limit ?? 50 });
        const sdkMapped = (sdkSessions as Record<string, unknown>[]).map((s) => this.toSessionDetail(s));

        // Include local placeholders that haven't materialized yet
        const locals = [...this.localSessions.values()].map((s) => this.localToSessionDetail(s));

        return [...locals, ...sdkMapped];
    }

    async getSession(id: string) {
        const local = this.localSessions.get(id);
        if (local) return this.localToSessionDetail(local);

        const cliId = this.cliSessionIds.get(id) ?? id;
        const info = await getSessionInfo(cliId, { dir: this.cwd });
        return this.toSessionDetail(info);
    }

    async createSession(options?: { title?: string }) {
        // Lazy — create local placeholder, real SDK session on first message
        const id = `local-${crypto.randomUUID()}`;
        const session: LocalSession = {
            id,
            title: options?.title ?? "New Session",
            created: Date.now(),
        };
        this.localSessions.set(id, session);
        return this.localToSessionDetail(session);
    }

    async deleteSession(id: string) {
        this.localSessions.delete(id);
        this.sessionIdMap.delete(id);
        this.cliSessionIds.delete(id);
        // SDK sessions are file-based JSONL — deletion would be filesystem op
        // For now, just remove from tracking
    }

    async updateSession(id: string, updates: { title?: string }) {
        const local = this.localSessions.get(id);
        if (local && updates.title) {
            local.title = updates.title;
        }
        return this.getSession(id);
    }

    async getSessionStatuses(): Promise<Record<string, SessionStatus>> {
        const statuses: Record<string, SessionStatus> = {};
        for (const [sessionId] of this.queries) {
            statuses[sessionId] = { type: "busy" };
        }
        return statuses;
    }

    // --- Messages ---

    async getMessages(sessionId: string) {
        if (this.localSessions.has(sessionId)) return [];
        const cliId = this.cliSessionIds.get(sessionId) ?? sessionId;
        const msgs = await getSessionMessages(cliId, { dir: this.cwd });
        // Filter through toMessage (returns null for non-conversation types)
        return (msgs as Record<string, unknown>[])
            .map((m) => this.toMessage(m))
            .filter((m): m is NonNullable<typeof m> => m !== null);
    }

    async getMessage(sessionId: string, messageId: string) {
        const msgs = await this.getMessages(sessionId);
        const found = msgs.find((m) => m.id === messageId);
        if (!found) throw new Error(`Message ${messageId} not found`);
        return found;
    }

    async getMessagesPage(sessionId: string, options?: { limit?: number; before?: string }) {
        // SDK doesn't have native pagination — fetch all and slice
        const all = await this.getMessages(sessionId);
        const limit = options?.limit ?? 50;
        if (options?.before) {
            const idx = all.findIndex((m) => m.id === options.before);
            if (idx > 0) return all.slice(Math.max(0, idx - limit), idx);
        }
        return all.slice(-limit);
    }

    // --- Stubs (implemented in later tasks) ---

    // Implemented in Task 10
    async sendMessage(_sessionId: string, _prompt: PromptOptions): Promise<void> {
        throw new Error("Not yet implemented — see Task 10");
    }
    async abortSession(_id: string): Promise<void> {
        throw new Error("Not yet implemented — see Task 10");
    }

    // Implemented in Task 11
    async listPendingPermissions(): Promise<Array<{ id: string; permission: string; [key: string]: unknown }>> {
        throw new Error("Not yet implemented — see Task 11");
    }
    async replyPermission(_options: PermissionReplyOptions): Promise<void> {
        throw new Error("Not yet implemented — see Task 11");
    }
    async listPendingQuestions(): Promise<Array<{ id: string; [key: string]: unknown }>> {
        throw new Error("Not yet implemented — see Task 11");
    }
    async replyQuestion(_options: QuestionReplyOptions): Promise<void> {
        throw new Error("Not yet implemented — see Task 11");
    }
    async rejectQuestion(_id: string): Promise<void> {
        throw new Error("Not yet implemented — see Task 11");
    }

    // --- Discovery ---

    async listAgents(): Promise<Agent[]> {
        // Return agents from first active query, or empty
        for (const [, state] of this.queries) {
            if (state.query) {
                return await state.query.supportedAgents() as Agent[];
            }
        }
        return [];
    }

    async listProviders() {
        // Claude Agent SDK is single-provider (Anthropic)
        return {
            providers: [{ id: "anthropic", name: "Anthropic" }],
            defaults: { provider: "anthropic", model: this.model },
            connected: ["anthropic"],
        };
    }

    async listCommands() {
        // Return commands from first active query, or empty
        for (const [, state] of this.queries) {
            if (state.query) {
                return await state.query.supportedCommands();
            }
        }
        return [];
    }

    async listSkills() {
        return []; // Skills discovery not available in Agent SDK
    }

    async getConfig() {
        return { model: this.model, provider: "anthropic" };
    }

    async updateConfig(config: Record<string, unknown>) {
        if (config.model && typeof config.model === "string") {
            this.model = config.model;
            // If we have active queries, use setModel() for live switching
            for (const [, state] of this.queries) {
                await state.query.setModel(config.model);
            }
        }
        return this.getConfig();
    }

    // forkSession, revertSession, unrevertSession — intentionally NOT implemented
    // (optional on SessionBackend interface, Claude Agent SDK has no equivalent)

    // --- Events ---

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        // Per-subscriber wrapper — breaks iteration on abort WITHOUT closing
        // the shared channel. The channel lives for the backend's lifetime.
        const iter = this.channel[Symbol.asyncIterator]();
        const aborted = new Promise<IteratorResult<BackendEvent>>(resolve => {
            signal.addEventListener("abort", () => {
                resolve({ value: undefined, done: true as const });
            }, { once: true });
        });

        while (!signal.aborted) {
            const result = await Promise.race([iter.next(), aborted]);
            if (result.done) return;
            yield result.value;
        }
    }

    // --- Helpers ---

    private toSessionDetail(sdkSession: Record<string, unknown>): SessionDetail {
        return {
            id: (sdkSession.id ?? sdkSession.session_id) as string,
            title: (sdkSession.title ?? sdkSession.name ?? "Untitled") as string,
            created: (sdkSession.created ?? sdkSession.createdAt ?? Date.now()) as number,
            updated: (sdkSession.updated ?? sdkSession.lastActivity ?? Date.now()) as number,
            backendType: "claude-agent" as const,
        };
    }

    private localToSessionDetail(local: LocalSession): SessionDetail {
        return {
            id: local.id,
            title: local.title,
            created: local.created,
            updated: local.created,
            backendType: "claude-agent" as const,
            isPlaceholder: true,
        };
    }

    private toMessage(sdkMsg: Record<string, unknown>) {
        // Only include assistant and user message types
        if (sdkMsg.type !== "assistant" && sdkMsg.type !== "user") return null;
        return {
            id: (sdkMsg as any).uuid ?? (sdkMsg as any).id ?? crypto.randomUUID(),
            role: sdkMsg.type === "assistant" ? "assistant" : "user",
            content: (sdkMsg as any).message?.content,
            sessionID: (sdkMsg as any).session_id,  // capital ID per D8
        };
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/claude-agent-backend.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts test/unit/backend/claude-agent-backend.test.ts
git commit -m "feat: ClaudeAgentBackend session management with lazy creation

No forkSession/revertSession/unrevertSession (optional on interface).
Local placeholders materialize on first message."
```

---

### Task 10: Implement ClaudeAgentBackend — Messaging + Event Streaming

The core: `sendMessage()` starts a `query()` or pushes into the message queue, pipes `SDKMessage` events through the channel, captures `cliSessionId` from the first message.

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `test/unit/backend/claude-agent-messaging.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/backend/claude-agent-messaging.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockQueryInstance = {
    [Symbol.asyncIterator]: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    setModel: vi.fn(),
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedAgents: vi.fn().mockResolvedValue([]),
    supportedCommands: vi.fn().mockResolvedValue([]),
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: vi.fn().mockReturnValue(mockQueryInstance),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue({}),
}));

import { ClaudeAgentBackend } from "../../../src/lib/backend/claude-agent-backend.js";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

describe("ClaudeAgentBackend — messaging", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("sendMessage on local session starts query without resume", async () => {
        // Make the async iterator return immediately
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            async next() { return { done: true, value: undefined }; },
        });

        const session = await backend.createSession();
        await backend.sendMessage(session.id, { text: "hello" } as any);

        expect(sdkQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: expect.any(Object), // MessageQueue
                options: expect.objectContaining({
                    cwd: "/tmp/project",
                    // resume should NOT be set for local sessions
                    includePartialMessages: true,
                }),
            }),
        );

        // Verify resume is NOT set
        const callArgs = vi.mocked(sdkQuery).mock.calls[0][0] as any;
        expect(callArgs.options.resume).toBeUndefined();
    });

    it("sendMessage on existing session uses resume", async () => {
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            async next() { return { done: true, value: undefined }; },
        });

        // Simulate a session with known cliSessionId
        await backend.sendMessage("known-cli-session-id", { text: "follow up" } as any);

        const callArgs = vi.mocked(sdkQuery).mock.calls[0][0] as any;
        expect(callArgs.options.resume).toBe("known-cli-session-id");
    });

    it("abortSession calls abort on active query", async () => {
        mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
            next: () => new Promise(() => {}), // Block forever
        });

        const session = await backend.createSession();
        // Start but don't await (it blocks)
        backend.sendMessage(session.id, { text: "hello" } as any);

        // Give it a tick to start
        await new Promise(r => setTimeout(r, 10));

        await backend.abortSession(session.id);
        // Should have aborted without error
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/claude-agent-messaging.test.ts
```

**Step 3: Add sendMessage and abortSession to ClaudeAgentBackend**

Add these methods to the class in `claude-agent-backend.ts`:

```typescript
    // --- Messaging ---

    async sendMessage(sessionId: string, prompt: PromptOptions): Promise<void> {
        if (!prompt.text && (!prompt.images || prompt.images.length === 0)) {
            throw new Error("Message must have text or images");
        }

        const existing = this.queries.get(sessionId);
        if (existing && !existing.messageQueue.isEnded) {
            // Push into existing query (multi-turn)
            this.pushMessage(existing.messageQueue, prompt.text, prompt.images);
            return;
        }

        // Start new query
        await this.startQuery(sessionId, prompt.text, prompt.images);
    }

    async abortSession(id: string): Promise<void> {
        const state = this.queries.get(id);
        if (state) {
            state.abortController.abort();
        }
    }

    /**
     * Start a new SDK query. Follows Clay's sdk-bridge.js startQuery() pattern.
     * Uses static import (D3: no dynamic imports).
     */
    private async startQuery(
        relaySessionId: string,
        text: string,
        images?: string[],
    ): Promise<void> {
        const isLocal = this.localSessions.has(relaySessionId);
        const resumeId = isLocal ? undefined : (this.cliSessionIds.get(relaySessionId) ?? relaySessionId);

        // Create message queue and push initial user message
        const messageQueue = new MessageQueue();
        messageQueue.push(this.buildUserMessage(text, images));

        // Create abort controller
        const abortController = new AbortController();

        // Emit session.status busy
        this.channel.push({
            type: "session.status",
            properties: { sessionID: relaySessionId, status: { type: "busy" } },
        });

        // Build query options (no systemPrompt — removed per audit Fix 5)
        const queryOptions: Record<string, unknown> = {
            cwd: this.cwd,
            model: this.model,
            allowedTools: this.allowedTools,
            canUseTool: this.handleCanUseTool,
            includePartialMessages: true,
            enableFileCheckpointing: true,
            settingSources: ["user", "project"],
            abortController,
        };

        if (this.apiKey) {
            queryOptions.env = { ANTHROPIC_API_KEY: this.apiKey };
        }

        // Resume existing session (SDK-native, not history reconstruction)
        if (resumeId) {
            queryOptions.resume = resumeId;
        }

        // Start the query (static import at top of file, per D3)
        let activeQuery: import("@anthropic-ai/claude-agent-sdk").Query;
        try {
            activeQuery = sdkQuery({
                prompt: messageQueue,
                options: queryOptions,
            });
        } catch (err) {
            this.channel.push({
                type: "session.status",
                properties: { sessionID: relaySessionId, status: { type: "idle" } },
            });
            throw err;
        }

        // Store QueryState in per-session Map (D7)
        const streamPromise = this.processQueryStream(relaySessionId, activeQuery, isLocal);
        this.queries.set(relaySessionId, {
            query: activeQuery,
            messageQueue,
            abortController,
            streamPromise,
            cliSessionId: resumeId ?? null,
        });
    }

    /**
     * Push a follow-up message into the live query's message queue.
     * From Clay's sdk-bridge.js pushMessage() pattern.
     */
    private pushMessage(messageQueue: MessageQueue, text: string, images?: string[]): void {
        if (messageQueue.isEnded) return;
        messageQueue.push(this.buildUserMessage(text, images));
    }

    private buildUserMessage(text: string, images?: string[]): SDKUserMessage {
        const content: Array<{ type: string; [key: string]: unknown }> = [];
        if (images?.length) {
            for (const img of images) {
                // Parse data URL: "data:image/png;base64,..."
                const [header, data] = img.split(",");
                const mediaType = header.match(/data:(.*?);/)?.[1] ?? "image/png";
                content.push({
                    type: "image",
                    source: { type: "base64", media_type: mediaType, data },
                });
            }
        }
        if (text) {
            content.push({ type: "text", text });
        }
        // Always return content as array — no ternary optimization
        return {
            type: "user",
            message: { role: "user", content },
        };
    }

    /**
     * Consume the SDK query's async generator and pipe translated events
     * to the relay channel. Follows Clay's processQueryStream() pattern.
     */
    private async processQueryStream(
        relaySessionId: string,
        activeQuery: import("@anthropic-ai/claude-agent-sdk").Query,
        isLocal: boolean,
    ): Promise<void> {
        try {
            for await (const msg of activeQuery) {
                // Capture cliSessionId on first message (lazy session materialization)
                if (msg.session_id && isLocal) {
                    const localId = relaySessionId;
                    this.cliSessionIds.set(localId, msg.session_id);
                    this.sessionIdMap.set(localId, msg.session_id);
                    this.localSessions.delete(localId);
                    // Update QueryState with cliSessionId
                    const state = this.queries.get(relaySessionId);
                    if (state) state.cliSessionId = msg.session_id;
                    isLocal = false;
                    this.log?.info("Session materialized", { localId, cliSessionId: msg.session_id });
                } else if (msg.session_id) {
                    // Update mapping for non-local sessions
                    this.cliSessionIds.set(relaySessionId, msg.session_id);
                }

                // Translate and push to channel
                const translated = translateSdkMessage(msg);
                if (translated) {
                    if (Array.isArray(translated)) {
                        for (const event of translated) {
                            this.channel.push(event);
                        }
                    } else {
                        this.channel.push(translated);
                    }
                }
            }
        } catch (err: unknown) {
            const error = err as Error;
            if (error?.name === "AbortError") {
                this.log?.info("Query aborted");
                // Push a session.error event so relay knows query was interrupted
                this.channel.push({
                    type: "session.error",
                    properties: {
                        sessionID: relaySessionId,
                        error: {
                            name: "AbortError",
                            data: { message: "Query was interrupted" },
                        },
                    },
                });
            } else {
                this.log?.error("Query stream error", { error: error?.message });
                this.channel.push({
                    type: "session.error",
                    properties: {
                        sessionID: relaySessionId,
                        error: {
                            name: "QueryError",
                            data: { message: error?.message ?? "Unknown error" },
                        },
                    },
                });
            }
        } finally {
            // Clean up query state
            this.queries.delete(relaySessionId);

            // Reject pending deferreds for this session to prevent deadlocks
            for (const [id, entry] of this.pendingPermissions) {
                entry.deferred.resolve({ decision: "deny" });
                this.pendingPermissions.delete(id);
            }
            for (const [id, entry] of this.pendingQuestions) {
                entry.deferred.resolve({ rejected: true });
                this.pendingQuestions.delete(id);
            }

            // Emit idle status
            this.channel.push({
                type: "session.status",
                properties: {
                    sessionID: relaySessionId,
                    status: { type: "idle" },
                },
            });
        }
    }
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/claude-agent-messaging.test.ts
```

**Step 5: Run full backend tests**

```bash
pnpm vitest run test/unit/backend/
```

**Step 6: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts test/unit/backend/claude-agent-messaging.test.ts
git commit -m "feat: ClaudeAgentBackend messaging with MessageQueue multi-turn

SDK-native resume via cliSessionId. pushMessage() for follow-ups
during active query. Session materializes on first SDK message."
```

---

### Task 11: Implement ClaudeAgentBackend — Permission + Question Bridging

**CRITICAL v2 CORRECTION:** The `canUseTool` callback returns `{ behavior: "allow" | "deny" }`, NOT `hookSpecificOutput`. AskUserQuestion returns `{ behavior: "allow", updatedInput: { ...input, answers } }`.

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `test/unit/backend/permission-bridge.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/backend/permission-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
    query: vi.fn(),
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionMessages: vi.fn().mockResolvedValue([]),
    getSessionInfo: vi.fn().mockResolvedValue({}),
}));

import { ClaudeAgentBackend } from "../../../src/lib/backend/claude-agent-backend.js";

describe("ClaudeAgentBackend — permission bridge", () => {
    let backend: ClaudeAgentBackend;

    beforeEach(() => {
        vi.clearAllMocks();
        backend = new ClaudeAgentBackend({ cwd: "/tmp/project" });
    });

    it("canUseTool creates a pending permission", async () => {
        // Access the private handler via the exposed test helper
        const handler = (backend as any).handleCanUseTool;
        const opts = { signal: new AbortController().signal };

        // Start the canUseTool promise (it will block)
        const promise = handler("Bash", { command: "ls" }, opts);

        // Should now have a pending permission
        const pending = await backend.listPendingPermissions();
        expect(pending).toHaveLength(1);
        expect(pending[0].permission).toBe("Bash");

        // Resolve it — OpenCode vocabulary: "once" maps to allow
        await backend.replyPermission({ id: pending[0].id, decision: "once" });

        // canUseTool should return { behavior: "allow" }
        const result = await promise;
        expect(result).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });
    });

    it("canUseTool returns deny with message", async () => {
        const handler = (backend as any).handleCanUseTool;
        const promise = handler("Write", { path: "/etc/passwd" }, {});

        const pending = await backend.listPendingPermissions();
        // OpenCode vocabulary: "reject" maps to deny
        await backend.replyPermission({ id: pending[0].id, decision: "reject" });

        const result = await promise;
        expect(result).toEqual({ behavior: "deny", message: "User denied permission" });
    });

    it("AskUserQuestion is handled separately from permissions", async () => {
        const handler = (backend as any).handleCanUseTool;
        const input = {
            question: "How should I format the output?",
            header: "Format",
            options: [{ label: "JSON", description: "Format as JSON" }],
        };
        const opts = { toolUseID: "tu-123", signal: new AbortController().signal };

        const promise = handler("AskUserQuestion", input, opts);

        // Should appear in pending questions, NOT permissions
        const perms = await backend.listPendingPermissions();
        expect(perms).toHaveLength(0);

        const questions = await backend.listPendingQuestions();
        expect(questions).toHaveLength(1);

        // Answer the question — string[][] format
        await backend.replyQuestion({
            id: questions[0].id,
            answers: [["How should I format the output?", "JSON"]],
        });

        // canUseTool returns allow with updatedInput containing answers
        const result = await promise;
        expect(result).toEqual({
            behavior: "allow",
            updatedInput: {
                ...input,
                answers: [["How should I format the output?", "JSON"]],
            },
        });
    });

    it("rejectQuestion returns deny (resolve, not reject)", async () => {
        const handler = (backend as any).handleCanUseTool;
        const promise = handler("AskUserQuestion", { question: "What?" }, { toolUseID: "tu-456" });

        const questions = await backend.listPendingQuestions();
        await backend.rejectQuestion(questions[0].id);

        const result = await promise;
        expect(result).toEqual({ behavior: "deny", message: "User rejected question" });
    });

    it("concurrent permissions are tracked independently", async () => {
        const handler = (backend as any).handleCanUseTool;

        // Start two concurrent permission requests
        const promise1 = handler("Bash", { command: "ls" }, {});
        const promise2 = handler("Write", { path: "/tmp/file" }, {});

        const pending = await backend.listPendingPermissions();
        expect(pending).toHaveLength(2);

        // Resolve them in reverse order
        await backend.replyPermission({ id: pending[1].id, decision: "once" });
        await backend.replyPermission({ id: pending[0].id, decision: "reject" });

        const result1 = await promise1;
        const result2 = await promise2;
        expect(result1.behavior).toBe("deny");
        expect(result2.behavior).toBe("allow");
    });

    it("shutdown rejects all pending deferreds", async () => {
        const handler = (backend as any).handleCanUseTool;

        // Create pending permission and question
        const permPromise = handler("Bash", { command: "rm -rf" }, {});
        const questionPromise = handler("AskUserQuestion", { question: "Sure?" }, { toolUseID: "tu-789" });

        // Shutdown
        await backend.shutdown();

        // Both should reject
        await expect(permPromise).rejects.toThrow("Backend shutting down");
        await expect(questionPromise).rejects.toThrow("Backend shutting down");
    });

    it("pending permissions survive and are re-listed on reconnect", async () => {
        const handler = (backend as any).handleCanUseTool;
        handler("Bash", { command: "echo test" }, {});

        // First list
        const pending1 = await backend.listPendingPermissions();
        expect(pending1).toHaveLength(1);

        // Second list (simulating browser reconnect)
        const pending2 = await backend.listPendingPermissions();
        expect(pending2).toHaveLength(1);
        expect(pending2[0].id).toBe(pending1[0].id);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/permission-bridge.test.ts
```

**Step 3: Add permission and question bridging to ClaudeAgentBackend**

```typescript
    // --- Permission & Question Bridging ---

    /**
     * canUseTool callback for the Claude Agent SDK.
     *
     * CRITICAL: Returns { behavior: "allow" | "deny" }, NOT hookSpecificOutput.
     * AskUserQuestion gets special handling — answers are returned via updatedInput.
     *
     * Signature: (toolName, toolInput, options?) where options has signal?: AbortSignal.
     * See design doc "Permission & Question Bridging" section.
     */
    private handleCanUseTool = async (
        toolName: string,
        toolInput: unknown,
        options?: { toolUseID?: string; signal?: AbortSignal },
    ): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }> => {
        // AskUserQuestion: route to question handling
        if (toolName === "AskUserQuestion") {
            return this.handleAskUserQuestion(toolInput, options);
        }

        // Regular permission request
        const id = crypto.randomUUID();
        const deferred = createDeferred<PermissionDecision>();

        this.pendingPermissions.set(id, {
            deferred,
            metadata: { id, permission: toolName, input: toolInput, timestamp: Date.now() },
        });

        // Notify relay of new permission request (event type: permission.asked per EventTranslator)
        this.channel.push({
            type: "permission.asked",
            properties: { id, permission: toolName, tool: { callID: options?.toolUseID } },
        });

        // Handle abort signal (tool use cancelled by SDK) — resolve with deny, never reject (Clay pattern)
        if (options?.signal) {
            options.signal.addEventListener("abort", () => {
                const entry = this.pendingPermissions.get(id);
                if (entry) {
                    // Resolve with deny, never reject
                    entry.deferred.resolve({ decision: "deny" });
                    this.pendingPermissions.delete(id);
                }
            }, { once: true });
        }

        // Block until browser responds — NO TIMEOUT (design doc: deferred stays
        // pending until explicitly resolved, re-shown on reconnect)
        const decision = await deferred.promise;

        if (decision.decision === "allow") {
            return { behavior: "allow", updatedInput: toolInput };
        }
        return { behavior: "deny", message: decision.feedback ?? "User denied permission" };
    };

    /**
     * Handle AskUserQuestion tool — separate from regular permissions.
     * Returns { behavior: "allow", updatedInput: { ...input, answers } }.
     * Uses toolUseId as key (not random UUID) per Fix 2.
     */
    private async handleAskUserQuestion(
        toolInput: unknown,
        options?: { toolUseID?: string; signal?: AbortSignal },
    ): Promise<{ behavior: "allow" | "deny"; updatedInput?: unknown; message?: string }> {
        const id = options?.toolUseID ?? crypto.randomUUID();
        const deferred = createDeferred<QuestionAnswer>();

        this.pendingQuestions.set(id, {
            deferred,
            metadata: { id, toolUseId: id, input: toolInput, timestamp: Date.now() },
        });

        // Push question event (event type: question.asked per EventTranslator)
        this.channel.push({
            type: "question.asked",
            properties: {
                id,
                questions: Array.isArray((toolInput as Record<string, unknown>).questions)
                    ? (toolInput as Record<string, unknown>).questions
                    : [toolInput],
                tool: { callID: options?.toolUseID },
            },
        });

        // Handle abort signal — resolve with deny, never reject (Clay pattern)
        if (options?.signal) {
            options.signal.addEventListener("abort", () => {
                const entry = this.pendingQuestions.get(id);
                if (entry) {
                    // Resolve with deny, never reject
                    entry.deferred.resolve({ rejected: true } as unknown as QuestionAnswer);
                    this.pendingQuestions.delete(id);
                }
            }, { once: true });
        }

        const answer = await deferred.promise;

        // Check if rejected
        if ((answer as unknown as { rejected?: boolean }).rejected) {
            return { behavior: "deny", message: "User rejected question" };
        }

        return {
            behavior: "allow",
            updatedInput: { ...(toolInput as object), answers: answer.answers },
        };
    }

    async listPendingPermissions(): Promise<Array<{ id: string; permission: string; [key: string]: unknown }>> {
        return [...this.pendingPermissions.values()].map((p) => p.metadata);
    }

    async replyPermission(options: PermissionReplyOptions): Promise<void> {
        const entry = this.pendingPermissions.get(options.id);
        if (entry) {
            // OpenCode vocabulary: "reject" = deny, "once"/"always" = allow
            const decision = options.decision === "reject" ? "deny" : "allow";
            entry.deferred.resolve({ decision, feedback: undefined });
            this.pendingPermissions.delete(options.id);
        }
    }

    async listPendingQuestions(): Promise<Array<{ id: string; [key: string]: unknown }>> {
        return [...this.pendingQuestions.values()].map((q) => q.metadata);
    }

    async replyQuestion(options: QuestionReplyOptions): Promise<void> {
        const entry = this.pendingQuestions.get(options.id);
        if (entry) {
            entry.deferred.resolve({ answers: options.answers }); // string[][]
            this.pendingQuestions.delete(options.id);
        }
    }

    async rejectQuestion(id: string): Promise<void> {
        const entry = this.pendingQuestions.get(id);
        if (entry) {
            // Resolve with deny, not reject — never throw from canUseTool (Clay pattern)
            entry.deferred.resolve({ rejected: true } as unknown as QuestionAnswer);
            this.pendingQuestions.delete(id);
        }
    }
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/permission-bridge.test.ts
```

**Step 5: Run all backend tests**

```bash
pnpm vitest run test/unit/backend/
```

**Step 6: Commit**

```bash
git add src/lib/backend/claude-agent-backend.ts test/unit/backend/permission-bridge.test.ts
git commit -m "feat: ClaudeAgentBackend permission and question bridging

canUseTool returns { behavior: 'allow'|'deny' } (v2 audit fix).
AskUserQuestion: { behavior: 'allow', updatedInput: { answers } }.
No timeout on deferreds. Rejected on shutdown. Re-shown on reconnect."
```

---

### Task 12: Phase 3 Integration and Verification

**Files:**
- Modify: `src/lib/backend/index.ts` — barrel export
- Modify: `src/lib/types.ts` — add backend config fields to `ProjectRelayConfig`
- Create: `test/integration/flows/claude-agent-backend.integration.ts`

**Step 1: Create barrel export**

```typescript
// src/lib/backend/index.ts
export type { SessionBackend, InfraClient, BackendEvent } from "./types.js";
export { OpenCodeBackend } from "./opencode-backend.js";
export { ClaudeAgentBackend } from "./claude-agent-backend.js";
export { AsyncEventChannel } from "./async-event-channel.js";
export { MessageQueue } from "./message-queue.js";
export { createDeferred } from "./deferred.js";
export type { Deferred } from "./deferred.js";
```

**Step 2: Add backend config fields to ProjectRelayConfig**

In `src/lib/types.ts`, add to `ProjectRelayConfig`:

```typescript
// Backend selection
backendType?: "opencode" | "claude-agent";
anthropicApiKey?: string;
defaultModel?: string;
allowedTools?: string[];
authType?: "api-key" | "subscription";
```

**Step 3: Write integration tests (conditional on API key)**

```typescript
// test/integration/flows/claude-agent-backend.integration.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ClaudeAgentBackend } from "../../../src/lib/backend/index.js";

const API_KEY = process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("ClaudeAgentBackend integration", () => {
    let backend: ClaudeAgentBackend;

    beforeAll(async () => {
        backend = new ClaudeAgentBackend({
            cwd: process.cwd(),
            apiKey: API_KEY,
            model: "claude-sonnet-4-20250514",
            allowedTools: ["Read", "Glob", "Grep"],
        });
        await backend.initialize();
    });

    afterAll(async () => {
        await backend.shutdown();
    });

    it("can list sessions", async () => {
        const sessions = await backend.listSessions();
        expect(Array.isArray(sessions)).toBe(true);
    });

    it("can create a local session placeholder", async () => {
        const session = await backend.createSession();
        expect(session.id).toMatch(/^local-/);
    });
});
```

**Step 4: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 5: Commit**

```bash
git commit -am "feat: Phase 3 complete — barrel export, config fields, integration tests

Integration tests conditional on ANTHROPIC_API_KEY."
```

---

## Phase 4: Model-Level Backend Switching

### Task 13: BackendProxy Pattern

Instead of swapping a field on every component when the backend changes, all components hold a reference to a `BackendProxy` that indirects through the currently active backend. Swapping updates the proxy target; existing references see the new backend immediately.

**Files:**
- Create: `src/lib/backend/backend-proxy.ts`
- Create: `test/unit/backend/backend-proxy.test.ts`

**Step 1: Write failing tests**

```typescript
// test/unit/backend/backend-proxy.test.ts
import { describe, it, expect, vi } from "vitest";
import { BackendProxy } from "../../../src/lib/backend/backend-proxy.js";
import type { SessionBackend } from "../../../src/lib/backend/types.js";

function mockBackend(type: "opencode" | "claude-agent"): SessionBackend {
    return {
        type,
        initialize: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
        getHealth: vi.fn().mockResolvedValue({ ok: true }),
        listSessions: vi.fn().mockResolvedValue([{ id: `${type}-s1` }]),
        getSession: vi.fn().mockResolvedValue({ id: `${type}-s1` }),
        createSession: vi.fn().mockResolvedValue({ id: `${type}-s2` }),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        updateSession: vi.fn().mockResolvedValue({ id: `${type}-s1` }),
        getSessionStatuses: vi.fn().mockResolvedValue({}),
        getMessages: vi.fn().mockResolvedValue([]),
        getMessage: vi.fn().mockResolvedValue({ id: "m1" }),
        getMessagesPage: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(undefined),
        abortSession: vi.fn().mockResolvedValue(undefined),
        listPendingPermissions: vi.fn().mockResolvedValue([]),
        replyPermission: vi.fn().mockResolvedValue(undefined),
        listPendingQuestions: vi.fn().mockResolvedValue([]),
        replyQuestion: vi.fn().mockResolvedValue(undefined),
        rejectQuestion: vi.fn().mockResolvedValue(undefined),
        listAgents: vi.fn().mockResolvedValue([]),
        listProviders: vi.fn().mockResolvedValue({ providers: [] }),
        listCommands: vi.fn().mockResolvedValue([]),
        listSkills: vi.fn().mockResolvedValue([]),
        getConfig: vi.fn().mockResolvedValue({}),
        updateConfig: vi.fn().mockResolvedValue({}),
        subscribeEvents: vi.fn(),
        // OpenCode backend has optional methods
        ...(type === "opencode" ? {
            forkSession: vi.fn().mockResolvedValue({ id: "fork" }),
            revertSession: vi.fn().mockResolvedValue(undefined),
            unrevertSession: vi.fn().mockResolvedValue(undefined),
        } : {}),
    } as unknown as SessionBackend;
}

describe("BackendProxy", () => {
    it("delegates to the active backend", async () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);

        await proxy.listSessions();
        expect(oc.listSessions).toHaveBeenCalled();
    });

    it("type reflects the active backend", () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);
        expect(proxy.type).toBe("opencode");
    });

    it("swap changes the active backend", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        await proxy.swap(ca);  // async now

        expect(proxy.type).toBe("claude-agent");
        await proxy.listSessions();
        expect(ca.listSessions).toHaveBeenCalled();
        expect(oc.listSessions).not.toHaveBeenCalled();
    });

    it("existing references see the new backend after swap", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        // Simulate a handler holding a reference
        const handler = { backend: proxy as SessionBackend };

        await proxy.swap(ca);

        // The handler's reference now sees the new backend
        await handler.backend.listSessions();
        expect(ca.listSessions).toHaveBeenCalled();
    });

    it("optional methods are present when active backend has them", () => {
        const oc = mockBackend("opencode");
        const proxy = new BackendProxy(oc);
        expect(proxy.forkSession).toBeDefined();
    });

    it("optional methods are absent when active backend lacks them", () => {
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(ca);
        expect(proxy.forkSession).toBeUndefined();
    });

    it("optional methods update after swap", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        expect(proxy.forkSession).toBeDefined();
        await proxy.swap(ca);
        expect(proxy.forkSession).toBeUndefined();
    });

    it("emits swap event", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        const handler = vi.fn().mockResolvedValue(undefined);  // async handler
        proxy.onSwap(handler);
        await proxy.swap(ca);

        expect(handler).toHaveBeenCalledWith(ca, oc);
    });

    it("onSwap returns unsubscribe function", async () => {
        const oc = mockBackend("opencode");
        const ca = mockBackend("claude-agent");
        const proxy = new BackendProxy(oc);

        const handler = vi.fn().mockResolvedValue(undefined);
        const unsubscribe = proxy.onSwap(handler);
        unsubscribe();
        await proxy.swap(ca);
        expect(handler).not.toHaveBeenCalled();
    });

    it("methods have correct this context through proxy", async () => {
        let capturedThis: unknown;
        const oc = mockBackend("opencode");
        (oc as any).listSessions = vi.fn(function(this: unknown) {
            capturedThis = this;
            return Promise.resolve([]);
        });
        const proxy = new BackendProxy(oc);
        
        await proxy.listSessions();
        expect(capturedThis).toBe(oc);
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run test/unit/backend/backend-proxy.test.ts
```

**Step 3: Implement BackendProxy**

```typescript
// src/lib/backend/backend-proxy.ts
import type { SessionBackend, BackendEvent } from "./types.js";

type SwapHandler = (newBackend: SessionBackend, oldBackend: SessionBackend) => Promise<void>;

/**
 * Proxy that indirects through the currently active SessionBackend.
 * All components (SessionManager, pollers, handlers) hold a reference
 * to the proxy. Swapping the active backend updates the proxy target,
 * and all existing references see the new backend immediately.
 *
 * This avoids tearing down and rebuilding the component graph on
 * backend switch (design doc Phase 4: BackendProxy pattern).
 *
 * Uses a JavaScript Proxy for transparent delegation. The proxy
 * intercepts property access and delegates to the current target.
 * The constructor returns the proxy, so `new BackendProxy(oc)` IS the proxy
 * and can be used directly as a SessionBackend (via declaration merging).
 *
 * IMPORTANT: Consumers of subscribeEvents() must re-subscribe after a backend swap.
 * Long-lived async iterables are bound at call time. The onSwap handler should
 * restart event subscription on the new backend.
 */
/**
 * BackendProxy implements SessionBackend via JS Proxy delegation.
 * Declaration merging ensures TypeScript knows the proxy has SessionBackend members.
 */
export interface BackendProxy extends SessionBackend {}

export class BackendProxy {
    private target: SessionBackend;
    private swapHandlers: SwapHandler[] = [];
    private swapping = false;
    private readonly proxy: SessionBackend;

    private static readonly OWN_METHODS = new Set(["swap", "onSwap", "getTarget"]);

    constructor(initial: SessionBackend) {
        this.target = initial;

        // Create a JS Proxy that delegates all property access to this.target
        this.proxy = new Proxy(this as unknown as SessionBackend, {
            get: (_, prop: string | symbol) => {
                // BackendProxy's own methods — detected via explicit Set
                if (typeof prop === "string" && BackendProxy.OWN_METHODS.has(prop)) {
                    return (this as any)[prop].bind(this);
                }
                // Delegate to active backend
                const value = (this.target as any)[prop];
                if (typeof value === "function") {
                    return value.bind(this.target);
                }
                return value;
            },
            has: (_, prop: string | symbol) => {
                return prop in this.target;
            },
        });

        // Return the proxy so `new BackendProxy(oc)` IS the proxy
        return this.proxy as unknown as BackendProxy;
    }

    /** Get the current underlying backend (for direct access). */
    getTarget(): SessionBackend {
        return this.target;
    }

    /** Swap the active backend. All existing proxy references see the new backend. */
    async swap(newBackend: SessionBackend): Promise<void> {
        if (this.swapping) throw new Error("Swap already in progress");
        this.swapping = true;
        try {
            const old = this.target;
            this.target = newBackend;
            for (const handler of this.swapHandlers) {
                await handler(newBackend, old);
            }
        } finally {
            this.swapping = false;
        }
    }

    /** Register a handler called on every backend swap. Returns unsubscribe function. */
    onSwap(handler: SwapHandler): () => void {
        this.swapHandlers.push(handler);
        return () => {
            const idx = this.swapHandlers.indexOf(handler);
            if (idx >= 0) this.swapHandlers.splice(idx, 1);
        };
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run test/unit/backend/backend-proxy.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/backend-proxy.ts test/unit/backend/backend-proxy.test.ts
git commit -m "feat: BackendProxy for non-disruptive backend switching

Components hold proxy reference. Swap updates target, all existing
references see new backend immediately. Emits swap event."
```

---

### Task 14: Backend Switching Logic + Provider Routing

Wire the BackendProxy into the relay stack. Implement provider-based backend routing. Handle active query abort, pending permission rejection, and `backend_switched` event on switch. Cross-backend history prepending on first message.

**Files:**
- Modify: `src/lib/shared-types.ts` — add `backend_switched` to `RelayMessage` union
- Modify: `src/lib/handlers/types.ts` — add `backendProxy` and `backendRegistry` to `HandlerDeps`
- Modify: `src/lib/relay/relay-stack.ts` — hold both backends + BackendProxy, switch on model change
- Modify: `src/lib/handlers/model.ts` — trigger backend switch based on provider detection
- Create: `src/lib/backend/backend-router.ts` — provider-based backend selection
- Create: `test/unit/backend/backend-router.test.ts`

**Step 0a: Add `backend_switched` to RelayMessage union**

In `src/lib/shared-types.ts`, add to the `RelayMessage` union:

```typescript
| { type: "backend_switched"; backendType: "opencode" | "claude-agent" }
```

**Step 0b: Add `backendProxy` and `backendRegistry` to HandlerDeps**

In `src/lib/handlers/types.ts`, add:

```typescript
import type { BackendProxy } from "../backend/backend-proxy.js";

// Add to HandlerDeps interface:
backendProxy: BackendProxy;
backendRegistry: Map<string, SessionBackend>;
```

**Step 1: Write failing tests for backend router**

```typescript
// test/unit/backend/backend-router.test.ts
import { describe, it, expect } from "vitest";
import { selectBackendType } from "../../../src/lib/backend/backend-router.js";

describe("selectBackendType", () => {
    it("returns claude-agent for anthropic subscription", () => {
        expect(selectBackendType({ provider: "anthropic", authType: "subscription" }))
            .toBe("claude-agent");
    });

    it("returns opencode for anthropic with API key", () => {
        expect(selectBackendType({ provider: "anthropic", authType: "api-key" }))
            .toBe("opencode");
    });

    it("returns opencode for non-anthropic providers", () => {
        expect(selectBackendType({ provider: "openai" })).toBe("opencode");
        expect(selectBackendType({ provider: "google" })).toBe("opencode");
        expect(selectBackendType({ provider: "ollama" })).toBe("opencode");
    });

    it("returns opencode when provider is unknown", () => {
        expect(selectBackendType({})).toBe("opencode");
    });
});
```

**Step 2: Implement backend router**

```typescript
// src/lib/backend/backend-router.ts

/**
 * Provider-based backend selection.
 * Anthropic subscription accounts -> Claude Agent SDK backend.
 * Everything else -> OpenCode backend.
 *
 * See design doc "Backend routing: Provider-based detection".
 */
export function selectBackendType(
    context: { provider?: string; authType?: string },
): "opencode" | "claude-agent" {
    if (context.provider === "anthropic" && context.authType === "subscription") {
        return "claude-agent";
    }
    return "opencode";
}
```

**Step 3: Wire BackendProxy into relay stack**

In `relay-stack.ts`, construct both backends and the proxy:

```typescript
// Construct both backends
const opencodeBackend = new OpenCodeBackend({ client, sseConfig: { ... } });

const claudeAgentBackend = new ClaudeAgentBackend({
    cwd: config.projectDir,
    apiKey: config.anthropicApiKey,
    model: config.defaultModel,
    log: loggers.session,
});

// BackendProxy starts with OpenCode as default
// Constructor returns the proxy — backendProxy IS the SessionBackend
const backendProxy = new BackendProxy(opencodeBackend);

// Pass proxy to all consumers — they hold this reference permanently
const sessionMgr = new SessionManager({ backend: backendProxy, log: loggers.session, ... });
// handler deps, pollers, etc. all receive backendProxy (which IS the proxy)
```

Register swap handler to broadcast `backend_switched`:

```typescript
backendProxy.onSwap(async (newBackend, oldBackend) => {
    // 1. Shut down old backend (aborts queries, rejects deferreds, closes channel)
    await oldBackend.shutdown();

    // 2. Initialize new backend
    await newBackend.initialize();

    // 3. Broadcast to all connected browsers
    wsHandler.broadcast({ type: "backend_switched", backendType: newBackend.type });
});
```

> **Note on backend reusability:** After `shutdown()`, a backend is NOT reusable. If the user switches back, a new instance must be constructed. Use factory functions, not pre-constructed instances:

```typescript
const backendFactories = new Map<string, () => SessionBackend>([
    ["opencode", () => new OpenCodeBackend({ client, sseConfig: { ... } })],
    ["claude-agent", () => new ClaudeAgentBackend({ cwd, apiKey, ... })],
]);
```

**Step 4: Define `maybeSwapBackend` helper**

Extract shared helper used by both `handleSwitchModel` and `handleSetDefaultModel`:

```typescript
async function maybeSwapBackend(
    backendProxy: BackendProxy,
    backendFactories: Map<string, () => SessionBackend>,
    requiredType: "opencode" | "claude-agent",
): Promise<void> {
    if (backendProxy.type === requiredType) return;
    const factory = backendFactories.get(requiredType);
    if (!factory) return;
    const newBackend = factory();
    await backendProxy.swap(newBackend);
}
```

**Step 5: Add backend switch to model handler**

In `src/lib/handlers/model.ts`, when the user selects a model:

```typescript
// After determining the new model's provider:
const requiredBackend = selectBackendType({ provider, authType });
await maybeSwapBackend(deps.backendProxy, deps.backendFactories, requiredBackend);
```

**Step 6: Add capabilities to session_list response**

In the session handler, when sending `session_list`:

```typescript
const capabilities = {
    fork: typeof deps.sessionBackend.forkSession === "function",
    revert: typeof deps.sessionBackend.revertSession === "function",
    unrevert: typeof deps.sessionBackend.unrevertSession === "function",
};
// Include in session_list message
```

**Step 7: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 8: Commit**

```bash
git commit -am "feat: provider-based backend switching via BackendProxy

Anthropic subscription -> Claude Agent SDK, all else -> OpenCode.
Factory-based construction, shutdown old backend, broadcasts backend_switched."
```

---

### Task 15: Frontend Backend Awareness

Handle `backend_switched` message. Merge session lists from all backends. Tag sessions with backend type. Hide unsupported operations.

**Files:**
- Modify: `src/lib/shared-types.ts` — add `backendType` to `SessionInfo` (if not done in Task 14)
- Modify: `src/lib/frontend/stores/ws-dispatch.ts` — handle `backend_switched` dispatch case
- Modify: `src/lib/frontend/stores/` — add backend state store (Svelte 5 `$state` pattern)
- Modify: `src/lib/frontend/components/chat/AssistantMessage.svelte` — gate fork-from-here button
- Modify: `src/lib/frontend/components/session/SessionContextMenu.svelte` — gate Fork menu item
- Modify: `src/lib/frontend/components/session/SessionList.svelte` — gate fork handler
- Modify: `src/lib/frontend/components/overlays/RewindBanner.svelte` — gate revert/rewind

**Step 1: Handle backend_switched in WebSocket message store**

When the frontend receives `backend_switched`:
1. Clear the current session list cache
2. Request a fresh session list from the server
3. Update the active backend type in the store

**Step 1a: Add `backendType` to `SessionInfo`**

In `src/lib/shared-types.ts`, add to `SessionInfo`:

```typescript
backendType?: "opencode" | "claude-agent";
```

> Note: `backend_switched` was already added to `RelayMessage` union in Task 14.

```typescript
// In handleMessage() switch in src/lib/frontend/stores/ws-dispatch.ts:
case "backend_switched":
    backendState.backendType = msg.backendType;
    // Clear stale session cache and re-request
    sessionState.rootSessions = [];
    sessionState.allSessions = [];
    wsSend({ type: "list_sessions" });
    break;
```

**Step 2: Add backend state store (Svelte 5 `$state` pattern)**

```typescript
// In discovery.svelte.ts or new backend.svelte.ts:
export const backendState = $state({
    backendType: "opencode" as "opencode" | "claude-agent",
    capabilities: { fork: true, revert: true, unrevert: true },
});
```

> Uses `wsSend()` from `ws-send.svelte.ts`, NOT raw `ws.send()`.
> Uses Svelte 5 `$state` pattern (`.svelte.ts` files), NOT Svelte 4 `writable`.

**Step 3: Tag sessions with backend type**

Sessions from the server include a `backendType` field. Display a subtle indicator (e.g., "via Claude" or "via OpenCode") on each session.

> **Server-side session merge:** Session list merging happens server-side via BackendProxy (delegates to active backend's `listSessions`). No frontend merge logic needed.

**Step 4: Hide unsupported operations (capability-gated)**

Use the capabilities object from `session_list` response. Gate each fork/revert UI touchpoint:

- `AssistantMessage.svelte` — fork-from-here button
- `SessionContextMenu.svelte` — Fork menu item
- `SessionList.svelte` — fork handler
- `RewindBanner.svelte` — revert/rewind

```svelte
<!-- Uses Svelte 5 onclick syntax, NOT on:click -->
{#if backendState.capabilities.fork}
    <button onclick={handleFork}>Fork</button>
{/if}
{#if backendState.capabilities.revert}
    <button onclick={handleRevert}>Revert</button>
{/if}
```

**Step 5: Add tests**

Test specifications:
- `backend_switched` handler updates `backendState.backendType`
- `backend_switched` handler clears session list and re-requests
- Capability-based UI gating: fork button hidden when `capabilities.fork === false`
- Capability-based UI gating: revert button hidden when `capabilities.revert === false`

**Step 6: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 7: Commit**

```bash
git commit -am "feat: frontend handles backend switching

Svelte 5 $state pattern for backend state. Capability-gated UI.
Server-side session merge via BackendProxy. wsSend for WS dispatch."
```

---

---

## Task-Specific Audit Amendments

> **For Agent:** Read these amendments BEFORE implementing each task. They override the task code where they conflict.

### Task 1 Amendments

1. **BackendEvent must be typed.** Replace `{ type: string; properties: Record<string, unknown> }` with `type BackendEvent = KnownOpenCodeEvent | BaseOpenCodeEvent` (from `src/lib/types.ts`). This preserves the discriminated union for downstream EventTranslator.
2. **`listPendingPermissions` must include `permission` field.** Change return to `Promise<Array<{ id: string; permission: string; [key: string]: unknown }>>`.
3. **Structural test must check signatures, not just names.** Use `Pick<>`-based assignability: `expectTypeOf<Pick<RelayClient, BackendMethods>>().toMatchTypeOf<Omit<SessionBackend, ...>>()`.

### Task 2 Amendments

1. **Add single-consumer runtime guard** to `next()`: `if (this.resolver) throw new Error("AsyncEventChannel supports only one concurrent consumer");`.
2. **Add test** for double-consume detection.
3. **Add test** for push-then-close interleaving (buffered items delivered before done).
4. **Replace `undefined as any`** with `undefined` + `done: true as const`.

### Task 3 Amendments

1. **Fix import paths:** `Logger` from `"../logger.js"`, `ServiceRegistry` from `"../daemon/service-registry.js"`.
2. **Use static import** for SSEConsumer. No dynamic `await import()`.
3. **Type all delegation methods** with actual interface types, not `any`.
4. **Guard multiple `subscribeEvents()` calls:** Document single-consumer constraint. If called while previous subscription is active, the previous must be aborted first.

### Tasks 4-5 Amendments

1. **Additional files to modify (Task 4/5):**
   - `src/lib/relay/handler-deps-wiring.ts:37` — change `HandlerDepsWiringDeps.client` to `sessionBackend: SessionBackend` + `infraClient: InfraClient`. Update `clientInitDeps` (line 89-91) and `handlerDeps` (line 120-122).
   - `src/lib/relay/monitoring-wiring.ts:44,128` — change `MonitoringWiringDeps.client` to `sessionBackend: Pick<SessionBackend, "getMessages">`.
   - `src/lib/relay/session-lifecycle-wiring.ts:24,68` — same pattern.
   - `src/lib/relay/pty-upstream.ts:21-23` — rename `client` to `infraClient`.
   - `src/lib/relay/relay-stack.ts:355-356` — update SSE wiring lambdas to `sessionBackend.listPendingQuestions()` / `sessionBackend.listPendingPermissions()`.
   - `src/lib/relay/relay-stack.ts:299` — update `ptyDeps` to pass `infraClient`.
   - `src/lib/relay/relay-stack.ts:96-113` — update `RelayStack` interface to expose `sessionBackend`/`infraClient`.
   - `test/helpers/mock-factories.ts:302-323` — update `createMockProjectRelay()`.
2. **`ClientInitDeps` needs only `sessionBackend`** (no `infraClient` needed — all 5 calls are session-backend methods).
3. **Replace `client as unknown as InfraClient`** with `client satisfies InfraClient` or a helper function for compile-time safety.
4. **Startup `client.getConfig()` (line 252) stays as direct `client.getConfig()`** — backend not initialized yet.
5. **SessionManager method list is incomplete.** Also update: `renameSession()` (calls `updateSession`), `loadHistoryByCursorScan()` (calls `getMessagesPage` with limit: 10000).

### Tasks 7-8 Amendments (CRITICAL — translator rewrite needed)

**Task 7:** MessageQueue wraps AsyncEventChannel per directive D5. Import `SDKUserMessage` from SDK instead of hand-rolling.

**Task 8 — Translator must produce events matching EventTranslator type guards:**

1. **`stream_event` (text deltas):** Map `content_block_delta` with `text_delta` to `message.part.delta` with `{ partID, field: "text", delta: text, messageID }`. NOT `message.part.updated`.
2. **`stream_event` (tool use):** Map `content_block_start` with `tool_use` to `message.part.updated` with proper `part` structure including `type`, `callID`, `tool`, `state`.
3. **`assistant` messages:** Must include `cost`, `tokens: { input, output, cache: { read, write } }`, `time: { created, completed }` from `message.usage`. Use `sessionID` not `sessionId`.
4. **`result` messages:** Map to BOTH: (a) `session.status` with `{ status: { type: "idle" } }` for the `done` event path, AND (b) `message.updated` with cost/token data.
5. **`system/init`:** Map to a new relay message type for frontend (tools, model, MCP servers). Forward to frontend per design decision.
6. **`user` messages:** Drop. Relay tracks via PendingUserMessages.
7. **Result subtypes:** `"success"` -> completed. `"error_max_turns"`, `"error_max_budget_usd"` -> completed (with note). `"error_during_execution"` -> error.
8. **System non-init:** Remove `...msg` spread. Extract only specific fields.
9. **Add integration test:** Pipe translator output through `createTranslator().translate()` and verify `RelayMessage` output.
10. **Use `SDKMessage` discriminated union** type, not `Record<string, any>`.

### Task 9 Amendments (MAJOR — concurrent query support)

1. **Per-session query state via `Map<string, QueryState>`:**
   ```typescript
   interface QueryState {
       query: Query;
       messageQueue: MessageQueue;
       abortController: AbortController;
       streamPromise: Promise<void>;
       cliSessionId: string | null;
   }
   private readonly queries = new Map<string, QueryState>();
   ```
2. **Add method stubs** for `sendMessage`, `abortSession`, and all 5 permission methods (throw "Not yet implemented — see Task 10/11") so the class compiles.
3. **Type `activeQuery` properly:** `import type { Query } from "@anthropic-ai/claude-agent-sdk"`.
4. **Fix `getSessionStatuses()`:** Iterate `this.queries` map, return processing status for each active query's session.
5. **Fix `getSessionInfo` call:** Add `{ dir: this.cwd }` option.
6. **Fix `getMessagesPage`:** Use SDK's native `{ limit, offset }` in `getSessionMessages`.
7. **Fix `toMessage`:** Filter to only `"assistant"` and `"user"` types. Use `sessionID` (capital ID).
8. **`subscribeEvents` must NOT close the shared channel:** Use per-subscriber wrapper that breaks iteration on abort without calling `channel.close()`. The shared channel lives for the backend's lifetime.
9. **Add `decisionReason?: string`** to `canUseTool` options type.

### Task 10 Amendments

1. **Use per-session query state.** `sendMessage` looks up or creates `QueryState` for the given session ID.
2. **Remove `buildUserMessage` ternary optimization.** Always return content as array. Match Clay pattern.
3. **Add empty-message guard:** Reject if both `text` and `images` are empty.
4. **Fix `prompt.images` conversion:** `PromptOptions.images` is `string[]` (base64 data URLs). Convert to `{ mediaType, data }` format the SDK expects. Parse data URL: `const [header, data] = img.split(","); const mediaType = header.match(/data:(.*?);/)?.[1] ?? "image/png";`.
5. **Add try/catch around `sdkQuery()` call.** On failure: clean up state, push error event, return.
6. **Remove `systemPrompt` from default options.** Let SDK use its default (Clay pattern).
7. **Clean up pending deferreds in `processQueryStream` finally block:** Reject all pending permissions/questions for this session (same as shutdown pattern).
8. **Add query lifecycle events:** Push `session.updated` with `status: "processing"` at start, `status: "idle"` on normal completion.
9. **Track which session owns each query** via `this.queries` map. `abortSession(id)` only aborts the matching session.
10. **Stub `handleCanUseTool`** in Task 10 as `canUseTool: this.handleCanUseTool ?? undefined` — conditionally included, SDK runs with default permission mode if callback absent.

### Task 11 Amendments (CRITICAL — permission format fixes)

1. **Key questions by `toolUseId`**, not random UUID. The existing handler sends `toolId` (the `toolUseID`). The backend must store and look up by this key.
2. **Handle OpenCode decision vocabulary:** `replyPermission` must map `"reject"` -> deny, `"once"/"always"` -> allow (not check `=== "deny"`).
3. **Accept handler's answer format (`string[][]`)** in `replyQuestion`, or convert at the interface boundary. Define canonical format in `SessionBackend.replyQuestion`.
4. **Never throw from `canUseTool`.** On abort signal: resolve with `{ behavior: "deny", message: "Request cancelled" }`. NOT reject. Match Clay pattern.
5. **Remove try/catch in `handleAskUserQuestion`.** Let `{ behavior: "deny" }` be returned explicitly via `rejectQuestion`, not via catch-all. Fix test to expect resolution, not rejection.
6. **Use existing event types** for permission/question notifications: match the format the existing frontend/EventTranslator expects (e.g., existing permission relay message format), or document that new handling is needed in Task 15.
7. **Add test for concurrent permissions** (SDK calls `canUseTool` in parallel for parallel tool execution).

### Task 12 Amendments (**APPLIED** — incorporated into task code blocks above)

1. ~~**Remove backend factory function.**~~ Done — Step 2 replaced with config fields.
2. ~~**Add `ProjectRelayConfig` fields.**~~ Done — Step 2 now adds `backendType`, `anthropicApiKey`, `defaultModel`, `allowedTools`, `authType`.

### Task 13 Amendments (BackendProxy) (**APPLIED** — incorporated into task code blocks above)

1. ~~**Constructor must return the proxy.**~~ Done — constructor ends with `return this.proxy as unknown as BackendProxy;`.
2. ~~**Remove dead convenience getters.**~~ Done — `get type()`, `get forkSession()`, etc. removed.
3. ~~**Use explicit Set for own method detection.**~~ Done — `OWN_METHODS = new Set(["swap", "onSwap", "getTarget"])` with `typeof prop === "string"` guard. (Changed from prototype-based per audit re-review: prototype check is fragile with Proxy target mismatch.)
4. ~~**Make `SwapHandler` async.**~~ Done — `=> Promise<void>`, `swap()` is `async`, handlers are `await`ed.
5. ~~**Document `subscribeEvents` re-subscription.**~~ Done — JSDoc added to class.
6. ~~**Add `onSwap` unsubscribe.**~~ Done — returns `() => void`.
7. ~~**Clarify proxy-as-SessionBackend pattern.**~~ Done — declaration merging + constructor returns proxy.
8. **Added:** `this`-binding test (destructured methods work through proxy).
9. **Added:** concurrent-swap guard (`this.swapping` flag).

### Task 14 Amendments (**APPLIED** — incorporated into task code blocks above)

1. ~~**Add to `HandlerDeps`.**~~ Done — Step 0b adds `backendProxy` and `backendRegistry`.
2. ~~**Add to `RelayMessage` union.**~~ Done — Step 0a adds `backend_switched`.
3. ~~**Replace `abortSession("*")`.**~~ Done — swap handler uses `oldBackend.shutdown()`.
4. ~~**Add `authType` to `ProjectRelayConfig`.**~~ Done — covered by Task 12 config fields.
5. ~~**Swap handler: shutdown before initialize.**~~ Done.
6. ~~**Extract `maybeSwapBackend()` helper.**~~ Done — Step 4 defines it.
7. **Monitoring/lifecycle wiring uses OpenCode backend directly** (not proxy) for poller seeding. Pollers are OpenCode-specific. (Note in prose, not in code block.)
8. ~~**Add `capabilities` to session_list.**~~ Done — Step 6.
9. **Added:** Backend factory pattern for reusability after shutdown.

### Task 15 Amendments (**APPLIED** — incorporated into task code blocks above)

1. ~~**Fix directory paths.**~~ Done — all paths use `src/lib/frontend/stores/`.
2. ~~**Add `backend_switched` to `RelayMessage`.**~~ Done — covered by Task 14.
3. ~~**Add `backendType` to `SessionInfo`.**~~ Done — Step 1a.
4. ~~**Add dispatch case.**~~ Done — Step 1a code block.
5. ~~**Use Svelte 5 `$state` pattern.**~~ Done — Step 2.
6. ~~**Use `wsSend()`.**~~ Done — dispatch code uses `wsSend()`.
7. ~~**Use Svelte 5 `onclick`.**~~ Done — Step 4 code block.
8. ~~**Use capabilities object.**~~ Done — Step 4 uses `backendState.capabilities.fork`.
9. ~~**Enumerate all fork/revert UI touchpoints.**~~ Done — Files list + Step 4.
10. ~~**Server-side session merge.**~~ Done — Step 3 note.
11. ~~**Add tests.**~~ Done — Step 5.

---

### Task 16: Phase 4 Final Verification

**Step 1: Full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 2: Verify BackendProxy is used everywhere**

```bash
rg "sessionBackend" src/lib/handlers/ src/lib/session/ src/lib/relay/
```

All references should be to the proxy, not direct backend instances.

**Step 3: Manual smoke test**

- Start with OpenCode backend, create sessions, send messages
- Switch to Claude model (Anthropic subscription) -> verify backend switches, session list changes
- Send message through Claude Agent SDK -> verify streaming, permissions work
- AskUserQuestion flows correctly (answers returned via updatedInput)
- Switch back to OpenCode -> verify original sessions are still there
- PTY works throughout regardless of backend
- Fork/revert buttons hidden on Claude Agent SDK sessions
- Reconnecting browser re-shows pending permissions
- Abort during Claude Agent SDK query works

**Step 4: Commit**

```bash
git commit -m "feat: Phase 4 complete — dual SDK with model-level switching

BackendProxy pattern for non-disruptive switching.
Provider-based routing (Anthropic subscription -> Agent SDK).
Merged session list. Frontend hides unsupported ops."
```

---

## Audit Amendments v3 (Re-audit Fixes)

Synthesis: `docs/plans/2026-03-31-dual-sdk-v2-reaudit.md`

These amendments **override** task code where they conflict. Apply before implementing each task.

### Cross-Cutting Directives v3

**D9 — SDK API verified.** Package is `@anthropic-ai/claude-agent-sdk` (confirmed on npm). SDK exports: `query()`, `listSessions()`, `getSessionMessages()`, `getSessionInfo()`, `renameSession()`, `tagSession()`. All planned imports are valid.

**D10 — SDK type mappings.** The SDK uses these types:
- `listSessions({ dir?, limit?, includeWorktrees? })` → returns `SDKSessionInfo[]` with `sessionId` (not `id`), `summary`, `lastModified`, `createdAt`, `cwd`
- `getSessionMessages(sessionId, { dir?, limit?, offset? })` → returns `SessionMessage[]` with `type`, `uuid`, `session_id`, `message`
- `getSessionInfo(sessionId, { dir? })` → returns `SDKSessionInfo | undefined`
- `query({ prompt, options })` → returns `Query extends AsyncGenerator<SDKMessage, void>` with extra methods
- `CanUseTool` signature: `(toolName, input, { signal, suggestions?, blockedPath?, decisionReason?, toolUseID, agentID? })` → `Promise<PermissionResult>`
- `PermissionResult`: `{ behavior: "allow", updatedInput? } | { behavior: "deny", message }`
- `SDKResultMessage.usage`: `NonNullableUsage` (has `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` — NO `cost` field)

**D11 — Auth type detection.** `authType` is determined via: (1) UI toggle on instance/project settings (primary), (2) env var `CONDUIT_AUTH_TYPE`, (3) config file field in `conduit.jsonc`, (4) auto-detection from API key characteristics. Store in `ProjectRelayConfig.authType`.

**D12 — Session list merge strategy.** Keep both backends alive (do NOT shut down on swap). Override `listSessions` at the relay-stack level to call BOTH backends and merge results, tagging each with `backendType`. The BackendProxy delegates the "active" backend for messaging, but both remain alive for session listing.

**D13 — Warmup query for discovery.** `ClaudeAgentBackend.initialize()` must start a warmup query (empty or minimal prompt) to capture agent/command/model lists from the SDK. Close the warmup query after receiving the `system/init` message. Cache the results for `listAgents()`, `listCommands()`, `supportedModels()`.

---

### Task 1 Amendment (v3)

**A1.1 — InfraClient structural test.** Replace name-only check with signature check:
```typescript
it("every InfraClient method has compatible signature on OpenCodeClient", () => {
    expectTypeOf<Pick<OpenCodeClient, keyof InfraClient>>().toMatchTypeOf<InfraClient>();
});
```

---

### Task 2 Amendment (v3)

No additional amendments.

---

### Task 3 Amendments (v3)

**A3.1 — Event listener cleanup via try/finally.** In `subscribeEvents()`, wrap `yield* channel` to ensure the SSEConsumer listener is removed on all exit paths (not just abort signal):
```typescript
async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
    if (!this.sseConsumer) return;
    const channel = new AsyncEventChannel<BackendEvent>();
    const handler = (event: OpenCodeEvent) => { channel.push(event); };
    this.sseConsumer.on("event", handler);
    signal.addEventListener("abort", () => { channel.close(); }, { once: true });
    try {
        yield* channel;
    } finally {
        this.sseConsumer.off("event", handler);
        channel.close();
    }
}
```

**A3.2 — Push event directly.** The handler should push the original event (`channel.push(event)`), NOT reconstruct a new object. Preserves discriminated union narrowing.

**A3.3 — Add `subscribeEvents` tests.** Task 3 must include tests for:
1. `subscribeEvents()` yields events from SSEConsumer
2. `subscribeEvents()` stops yielding when signal aborts
3. `subscribeEvents()` returns immediately when SSEConsumer not configured
4. Event listener is removed after generator exits

---

### Task 8 Amendments (v3) — CRITICAL

**A8.1 — Add `role: "assistant"` to translateResult.** The `message.updated` event in `translateResult()` MUST include `role: "assistant"` or the downstream EventTranslator will discard it:
```typescript
message: {
    role: "assistant",  // REQUIRED — EventTranslator checks this
    cost: msg.total_cost_usd ?? 0,
    tokens: { ... },
    time: { completed: Date.now() },
}
```

**A8.2 — Standardize all partIDs to `part-${event.index}`.** The tool_use `content_block_start` handler MUST use `part-${event.index}` as partID (NOT `event.content_block.id`). Store `content_block.id` in `callID` only:
```typescript
// Tool use start
if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    return {
        type: "message.part.updated",
        properties: {
            messageID: msg.uuid,
            partID: `part-${event.index}`,
            part: {
                id: `part-${event.index}`,
                type: "tool",
                callID: event.content_block.id,
                tool: event.content_block.name,
                state: { status: "pending" },
                time: { start: Date.now() },
            },
        },
    };
}
```

**A8.3 — Remove `session.status` idle from `translateResult`.** The `processQueryStream` finally block (Task 10) already emits `session.status` idle for ALL exit paths. Having it in both places causes duplicate `done` events. Remove the `session.status` push from `translateResult()` — only keep the `message.updated` (cost data) and `session.error` (for errors).

**A8.4 — Add `content_block_stop` translation for tool completion.** On `content_block_stop`, emit `message.part.updated` with `state: { status: "running" }` for tool_use blocks:
```typescript
if (event.type === "content_block_stop") {
    return {
        type: "message.part.updated",
        properties: {
            messageID: msg.uuid,
            partID: `part-${event.index}`,
            part: { state: { status: "running" }, time: { start: Date.now() } },
        },
    };
}
```

**A8.5 — Replace `Record<string, any>` in SDKMessage.** Use typed sub-interfaces:
```typescript
interface SDKMessage {
    type: string;
    subtype?: string;
    session_id?: string;
    uuid?: string;
    message?: {
        id?: string; role?: string; content?: unknown[];
        usage?: {
            input_tokens?: number; output_tokens?: number;
            cache_read_input_tokens?: number; cache_creation_input_tokens?: number;
        };
        created_at?: number;
    };
    event?: {
        type?: string; index?: number;
        delta?: { type?: string; text?: string; thinking?: string; partial_json?: string };
        content_block?: { type?: string; id?: string; name?: string };
    };
    result?: unknown;
    total_cost_usd?: number;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    tools?: unknown[];
    model?: string;
    mcp_servers?: unknown[];
    parent_tool_use_id?: string | null;
}
```
Remove the `[key: string]: unknown` index signature.

**A8.6 — Remove `usage.cost` from translateAssistant.** The Anthropic API `BetaMessage.usage` has no `cost` field. Use `cost: 0` for intermediate messages. The final cost comes from `translateResult` via `msg.total_cost_usd`.

**A8.7 — Add EventTranslator integration tests.** Add tests piping `translateSdkMessage()` output through `createTranslator().translate()` to verify the full BackendEvent → RelayMessage pipeline.

**A8.8 — Add `busy` handler to EventTranslator.** In `src/lib/relay/event-translator.ts`, add handling for `session.status` with `type: "busy"`:
- Emit a `status` RelayMessage with `processing: true`
- Include init metadata (tools, model, MCP servers) when present in properties
This makes `system/init` SDK events visible to the frontend.

---

### Task 9 Amendments (v3) — CRITICAL

**A9.1 — Fix `SessionDetail` shape.** The `toSessionDetail()` and `localToSessionDetail()` helpers must produce the correct nested structure:
```typescript
private toSessionDetail(sdk: SDKSessionInfo): SessionDetail {
    return {
        id: sdk.sessionId,       // SDK uses sessionId, not id
        title: sdk.summary ?? sdk.customTitle ?? "Untitled",
        time: {
            created: sdk.createdAt,
            updated: sdk.lastModified,
        },
        // No backendType on SessionDetail — tag via separate mechanism
    };
}
```
Note: `SDKSessionInfo` uses `sessionId` (not `id`), `summary` (not `title`), `lastModified` (not `updated`), `createdAt` (not `created`).

**A9.2 — Fix `subscribeEvents` multi-consumer crash.** Replace the single shared channel with a fan-out pattern. Each `subscribeEvents()` call creates its own `AsyncEventChannel`. The backend maintains a subscriber set:
```typescript
private readonly subscribers = new Set<AsyncEventChannel<BackendEvent>>();

/** Called internally when pushing events (replaces direct this.channel.push) */
private broadcastEvent(event: BackendEvent): void {
    for (const ch of this.subscribers) {
        ch.push(event);
    }
}

async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
    const ch = new AsyncEventChannel<BackendEvent>();
    this.subscribers.add(ch);
    signal.addEventListener("abort", () => {
        this.subscribers.delete(ch);
        ch.close();
    }, { once: true });
    try {
        yield* ch;
    } finally {
        this.subscribers.delete(ch);
        ch.close();
    }
}
```
Update ALL `this.channel.push(...)` calls in the class to use `this.broadcastEvent(...)`.

**A9.3 — Remove duplicate session ID map.** Remove `sessionIdMap`. Keep only `cliSessionIds` (`relaySessionId → cliSessionId`).

**A9.4 — Fix `toMessage` to produce valid `Message` shape.** The helper must return the correct structure with `parts` (not `content`), proper typing, and `sessionID`:
```typescript
private toMessage(sdkMsg: SessionMessage): Message | null {
    if (sdkMsg.type !== "assistant" && sdkMsg.type !== "user") return null;
    const raw = sdkMsg.message as { role?: string; content?: unknown[] };
    return {
        id: sdkMsg.uuid,
        role: sdkMsg.type,
        sessionID: sdkMsg.session_id,
        parts: this.contentToParts(raw?.content),
        time: { created: Date.now() },
    };
}
```

**A9.5 — Add `handleCanUseTool` stub in Task 9.** Define the arrow function as a stub that denies all tool use until Task 11 implements real handling:
```typescript
private handleCanUseTool = async (
    _toolName: string, _input: unknown, _options?: unknown
): Promise<{ behavior: "deny"; message: string }> => {
    return { behavior: "deny", message: "Permission handling not yet initialized" };
};
```

**A9.6 — Warmup query for `listAgents`/`listCommands`/`supportedModels`.** Per D13, `initialize()` should start a warmup query, capture init metadata from the `system/init` message, cache it, then close the query. Use cached data for `listAgents()`, `listCommands()`, etc.

---

### Task 10 Amendments (v3) — CRITICAL

**A10.1 — Scope deferred cleanup to current session.** The `processQueryStream` finally block must NOT reject ALL global pending permissions/questions. Add `sessionId` to each `PermissionEntry` and `QuestionEntry`, then filter:
```typescript
// In finally block — only clean up THIS session's deferreds
for (const [id, entry] of this.pendingPermissions) {
    if (entry.sessionId === relaySessionId) {
        entry.deferred.resolve({ decision: "deny" });
        this.pendingPermissions.delete(id);
    }
}
for (const [id, entry] of this.pendingQuestions) {
    if (entry.sessionId === relaySessionId) {
        entry.deferred.resolve({ rejected: true } as unknown as QuestionAnswer);
        this.pendingQuestions.delete(id);
    }
}
```

**A10.2 — Add `sessionId` field to PermissionEntry and QuestionEntry.**
```typescript
interface PermissionEntry {
    sessionId: string;  // ADD THIS
    deferred: Deferred<PermissionDecision>;
    metadata: { id: string; permission: string; input: unknown; timestamp: number };
}
interface QuestionEntry {
    sessionId: string;  // ADD THIS
    deferred: Deferred<QuestionResult>;
    metadata: { id: string; toolUseId: string; input: unknown; timestamp: number };
}
```

**A10.3 — Improve AbortError detection.** Check both `err.name` and the abort controller signal:
```typescript
} catch (err: unknown) {
    const error = err as Error;
    const isAbort = error?.name === "AbortError" ||
        this.queries.get(relaySessionId)?.abortController.signal.aborted;
    if (isAbort) {
        // ... handle abort
    } else {
        // ... handle error
    }
}
```

**A10.4 — Use `broadcastEvent` instead of `this.channel.push`.** Per A9.2, all event pushes use the fan-out pattern.

---

### Task 11 Amendments (v3)

**A11.1 — Add "always" permission caching.** Add a per-session `Set<string>` tracking always-allowed tools:
```typescript
private readonly alwaysAllowedTools = new Map<string, Set<string>>(); // sessionId -> toolNames

// In handleCanUseTool, check before creating deferred:
const sessionId = this.getActiveSessionForPermission();
const allowed = this.alwaysAllowedTools.get(sessionId);
if (allowed?.has(toolName)) {
    return { behavior: "allow", updatedInput: toolInput };
}

// In replyPermission, when decision === "always":
if (options.decision === "always") {
    // ... resolve deferred as allow ...
    const allowed = this.alwaysAllowedTools.get(sessionId) ?? new Set();
    allowed.add(toolName);
    this.alwaysAllowedTools.set(sessionId, allowed);
}
```

**A11.2 — Replace `{ rejected: true }` type hack.** Use a discriminated union for question answers:
```typescript
type QuestionResult =
    | { type: "answered"; answers: string[][] }
    | { type: "rejected" };
```
Update `Deferred<QuestionResult>` and all resolution/checking sites.

**A11.3 — Add `sessionId` to permission/question creation.** Per A10.2, when creating `PermissionEntry` or `QuestionEntry`, include the current session ID so cleanup can be scoped.

---

### Task 13 Amendments (v3)

No additional amendments. Task 13 code was already updated in the v2 amendments.

---

### Task 14 Amendments (v3) — CRITICAL

**A14.1 — Initialize before swap, shutdown after.** Change `BackendProxy.swap()` to initialize the new backend before changing the target, and shut down the old backend after:
```typescript
async swap(newBackend: SessionBackend): Promise<void> {
    if (this.swapping) throw new Error("Swap already in progress");
    this.swapping = true;
    try {
        await newBackend.initialize(); // Initialize FIRST — if this fails, old backend stays active
        const old = this.target;
        this.target = newBackend;       // Swap target AFTER successful init
        for (const handler of this.swapHandlers) {
            await handler(newBackend, old);
        }
        await old.shutdown();           // Shutdown old AFTER handlers complete
    } finally {
        this.swapping = false;
    }
}
```
Remove `initialize()` and `shutdown()` from swap handlers — they're now handled by `swap()` itself.

**A14.2 — Wire server-side event consumption restart on swap.** Add an event consumer function that subscribes to the active backend's `subscribeEvents()` and pipes events through the EventTranslator → session filter → message cache → WS broadcast pipeline. Register as a swap handler:
```typescript
// In relay-stack setup
let eventAbort = new AbortController();

async function startEventConsumer(backend: SessionBackend) {
    eventAbort.abort(); // Stop previous consumer
    eventAbort = new AbortController();
    const signal = eventAbort.signal;
    for await (const event of backend.subscribeEvents(signal)) {
        const result = translator.translate(event);
        if (result.ok) {
            for (const msg of result.messages) {
                wsHandler.broadcast(msg);
            }
        }
    }
}

// Start initial consumer
startEventConsumer(backendProxy.getTarget());

// Restart on swap
backendProxy.onSwap(async (newBackend) => {
    startEventConsumer(newBackend);
    wsHandler.broadcast({ type: "backend_switched", backendType: newBackend.type });
});
```

**A14.3 — Do NOT shut down backends on swap (D12).** Since session list merge requires both backends alive, `swap()` should NOT call `old.shutdown()`. Instead, it should call `old.deactivate()` or simply stop event consumption. Revise A14.1: remove `await old.shutdown()` — just stop the old event consumer (handled by `eventAbort.abort()` in A14.2).

**A14.4 — Session list merge.** Override `listSessions` at the relay-stack level:
```typescript
async function mergedListSessions(options?: SessionListOptions): Promise<SessionDetail[]> {
    const [ocSessions, caSessions] = await Promise.allSettled([
        opencodeBackend.listSessions(options),
        claudeAgentBackend.listSessions(options),
    ]);
    const results: SessionDetail[] = [];
    if (ocSessions.status === "fulfilled") {
        results.push(...ocSessions.value.map(s => ({ ...s, backendType: "opencode" as const })));
    }
    if (caSessions.status === "fulfilled") {
        results.push(...caSessions.value.map(s => ({ ...s, backendType: "claude-agent" as const })));
    }
    return results.sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
}
```
This is called by the session handler instead of `deps.sessionBackend.listSessions()`.

**A14.5 — Fix `backendFactories` vs `backendRegistry` mismatch.** Pass a closure on HandlerDeps:
```typescript
// In HandlerDeps:
maybeSwapBackend: (requiredType: "opencode" | "claude-agent") => Promise<void>;

// In relay-stack, when building handler deps:
maybeSwapBackend: async (requiredType) => {
    if (backendProxy.type === requiredType) return;
    const newBackend = requiredType === "opencode" ? opencodeBackend : claudeAgentBackend;
    await backendProxy.swap(newBackend);
}
```
Remove `backendRegistry` and `backendFactories` from HandlerDeps.

**A14.6 — Stop/restart pollers on swap.** Add to swap handler:
```typescript
backendProxy.onSwap(async (newBackend) => {
    if (newBackend.type === "claude-agent") {
        statusPoller.stop();
        pollerManager.stopAll();
    } else if (newBackend.type === "opencode") {
        statusPoller.start();
        // Pollers restart naturally on next session activity
    }
});
```

**A14.7 — Add `capabilities` to `session_list` RelayMessage.** Add to the `session_list` variant in shared-types.ts:
```typescript
| { type: "session_list"; sessions: SessionInfo[]; roots: boolean; search?: boolean;
    capabilities?: { fork: boolean; revert: boolean; unrevert: boolean } }
```
In the session handler, populate from the active backend:
```typescript
const capabilities = {
    fork: typeof deps.sessionBackend.forkSession === "function",
    revert: typeof deps.sessionBackend.revertSession === "function",
    unrevert: typeof deps.sessionBackend.unrevertSession === "function",
};
```

**A14.8 — Auth type detection wiring.** Add to `ProjectRelayConfig`:
```typescript
authType?: "api-key" | "subscription"; // from UI, env, config, or auto-detect
```
In the daemon's project registration, populate from:
1. Explicit UI setting (stored in daemon config per project)
2. Env var `CONDUIT_AUTH_TYPE`
3. Config file `conduit.jsonc` field `authType`
4. Auto-detection (attempt API key validation against Anthropic API)

**A14.9 — Cross-backend history prepending: defer.** Explicitly deferred to a future plan. Document as known limitation: when switching backends mid-conversation, the new backend starts fresh. Users should create a new session when switching backends.

---

### Task 15 Amendments (v3)

**A15.1 — Wire capabilities from server.** In `ws-dispatch.ts`, when handling `session_list`:
```typescript
if (msg.capabilities) {
    backendState.capabilities = msg.capabilities;
}
```

**A15.2 — Session list displays merged list.** Since session merge is server-side (A14.4), the frontend just renders whatever sessions the server sends. Tag sessions with a backend indicator.

---

### Design Decisions v3 (from Ask User questions)

| Decision | Choice | Rationale |
|---|---|---|
| SDK package name | `@anthropic-ai/claude-agent-sdk` | Confirmed on npm and official docs |
| Auth type detection | UI toggle + env + config + auto-detect | Maximum flexibility |
| System/init events | Add `busy` handler to EventTranslator | Makes init metadata available to frontend |
| `content_block_stop` | Translate now | Prevents tools stuck in "pending" |
| Session list merge | Merged from both backends | Both backends stay alive, merge server-side |
| SDK API fallback | Verified — SDK exports exist; JSONL fallback if functions change | Belt and suspenders |
| Discovery before query | Warmup query | Captures agent/command/model lists at init |
| Per-message cost | Use `result.total_cost_usd` only | Accurate; intermediate messages show 0 |
