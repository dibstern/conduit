# Dual SDK Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Refactor conduit to support both the OpenCode SDK and the Claude Agent SDK side-by-side, enabling Claude subscription account users to work through conduit via the Agent SDK while keeping OpenCode for all other providers.

**Architecture:** Four phases. Phase 1 migrates the hand-rolled client to `@opencode-ai/sdk`. Phase 2 extracts a `SessionBackend` interface from the session-centric methods. Phase 3 implements `ClaudeAgentBackend` using `@anthropic-ai/claude-agent-sdk`. Phase 4 wires model-level backend switching into the relay and UI.

**Design doc:** `docs/plans/2026-03-31-dual-sdk-design.md`

**Tech Stack:** TypeScript, `@opencode-ai/sdk`, `@anthropic-ai/claude-agent-sdk`, Vitest

---

## Phase 1: OpenCode SDK Migration

Phase 1 is covered by the existing plan at `docs/plans/2026-03-12-sdk-migration-plan.md` (9 tasks, audited twice, ready for execution). That plan installs `@opencode-ai/sdk`, creates a composition-based `RelayClient` with the same 45-method flat API, swaps imports across 24 files, and deletes the hand-rolled `OpenCodeClient`.

**Execute that plan first.** The remainder of this plan assumes Phase 1 is complete and `RelayClient` (from `sdk-client.ts`) is the sole client class.

---

## Phase 2: Extract SessionBackend Interface

### Method Split

The 45 `RelayClient` methods split into two groups:

**SessionBackend (session-centric, will be swappable per model) — 26 methods:**
`getHealth`, `listSessions`, `getSession`, `createSession`, `deleteSession`, `updateSession`, `getSessionStatuses`, `getMessages`, `getMessage`, `getMessagesPage`, `sendMessageAsync`, `abortSession`, `listPendingPermissions`, `replyPermission`, `listPendingQuestions`, `replyQuestion`, `rejectQuestion`, `listAgents`, `listProviders`, `listCommands`, `listSkills`, `forkSession`, `revertSession`, `unrevertSession`, `getConfig`, `updateConfig`

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
| `settings.ts` | `listCommands`, `listProjects` | both (`listCommands` → `sessionBackend`, `listProjects` → `infraClient`) |
| `files.ts` | `getFileContent`, `listDirectory` | `infraClient` only |
| `terminal.ts` | `createPty`, `deletePty`, `listPtys`, `resizePty` | `infraClient` only |

---

### Task 1: Define SessionBackend Interface and InfraClient Type

**Files:**
- Create: `src/lib/backend/types.ts`
- Create: `src/lib/backend/types.test.ts`

**Step 1: Write the interface**

```typescript
// src/lib/backend/types.ts
import type {
    SessionDetail, SessionStatus, SessionCreateOptions, SessionListOptions,
    Message, PromptOptions, PermissionReplyOptions, QuestionReplyOptions,
    Agent, ProviderListResult, PtyCreateOptions, HealthResponse,
} from "../instance/relay-types.js";

/**
 * Session-centric operations that differ between backends.
 * OpenCode: wraps RelayClient REST calls + SSEConsumer.
 * Claude Agent SDK: wraps query() + async event channel.
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
    listPendingPermissions(): Promise<Array<{ id: string; [key: string]: unknown }>>;
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

    // Session operations
    forkSession(id: string, options: { messageID?: string; title?: string }): Promise<SessionDetail>;
    revertSession(id: string, messageId: string): Promise<void>;
    unrevertSession(id: string): Promise<void>;

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

    // Auth/URL for SSE/PTY upstream
    getBaseUrl(): string;
    getAuthHeaders(): Record<string, string>;
}

/**
 * Unified event type emitted by all backends.
 * Maps to the existing OpenCodeEvent discriminated union.
 */
export interface BackendEvent {
    type: string;
    properties: Record<string, unknown>;
}
```

**Step 2: Write a structural test**

```typescript
// src/lib/backend/types.test.ts
import { describe, it, expectTypeOf } from "vitest";
import type { SessionBackend, InfraClient } from "./types.js";
import type { RelayClient } from "../instance/sdk-client.js";

describe("SessionBackend interface", () => {
    it("every SessionBackend method exists on RelayClient", () => {
        // This test verifies the interface is a valid subset of RelayClient.
        // sendMessage maps to sendMessageAsync on RelayClient — the one rename.
        type BackendMethods = Exclude<keyof SessionBackend, "type" | "initialize" | "shutdown" | "subscribeEvents" | "sendMessage">;
        type ClientMethods = keyof RelayClient;
        expectTypeOf<BackendMethods>().toMatchTypeOf<ClientMethods>();
    });

    it("every InfraClient method exists on RelayClient", () => {
        type InfraMethods = keyof InfraClient;
        type ClientMethods = keyof RelayClient;
        expectTypeOf<InfraMethods>().toMatchTypeOf<ClientMethods>();
    });
});
```

**Step 3: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/types.test.ts
```

**Step 4: Commit**

```bash
git add src/lib/backend/types.ts src/lib/backend/types.test.ts
git commit -m "feat: define SessionBackend and InfraClient interfaces"
```

---

### Task 2: Implement OpenCodeBackend

The first `SessionBackend` implementation. Wraps `RelayClient` for session-centric methods and delegates to `SSEConsumer` for event streaming. Pure delegation — no behavior change.

**Files:**
- Create: `src/lib/backend/opencode-backend.ts`
- Create: `src/lib/backend/opencode-backend.test.ts`

**Step 1: Write failing tests**

Test that `OpenCodeBackend` implements `SessionBackend` and delegates each method call to the underlying `RelayClient`. Use a mock `RelayClient` and verify calls pass through.

```typescript
// src/lib/backend/opencode-backend.test.ts
import { describe, it, expect, vi } from "vitest";
import { OpenCodeBackend } from "./opencode-backend.js";

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
    };
}

describe("OpenCodeBackend", () => {
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

    it("has type 'opencode'", () => {
        const client = createMockRelayClient();
        const backend = new OpenCodeBackend({ client: client as any });
        expect(backend.type).toBe("opencode");
    });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/lib/backend/opencode-backend.test.ts
```

Expected: FAIL — `OpenCodeBackend` doesn't exist yet.

**Step 3: Implement OpenCodeBackend**

```typescript
// src/lib/backend/opencode-backend.ts
import type { SessionBackend, BackendEvent } from "./types.js";
import type { RelayClient } from "../instance/sdk-client.js";

export interface OpenCodeBackendOptions {
    client: RelayClient;
}

export class OpenCodeBackend implements SessionBackend {
    readonly type = "opencode" as const;
    private readonly client: RelayClient;

    constructor(options: OpenCodeBackendOptions) {
        this.client = options.client;
    }

    async initialize(): Promise<void> { /* no-op — RelayClient is ready at construction */ }
    async shutdown(): Promise<void> { /* no-op */ }

    // Every method delegates directly to this.client.
    // sendMessage maps to sendMessageAsync (the one rename).
    getHealth() { return this.client.getHealth(); }
    listSessions(options?) { return this.client.listSessions(options); }
    getSession(id: string) { return this.client.getSession(id); }
    createSession(options?) { return this.client.createSession(options); }
    deleteSession(id: string) { return this.client.deleteSession(id); }
    updateSession(id: string, updates) { return this.client.updateSession(id, updates); }
    getSessionStatuses() { return this.client.getSessionStatuses(); }
    getMessages(sessionId: string) { return this.client.getMessages(sessionId); }
    getMessage(sessionId: string, messageId: string) { return this.client.getMessage(sessionId, messageId); }
    getMessagesPage(sessionId: string, options?) { return this.client.getMessagesPage(sessionId, options); }
    sendMessage(sessionId: string, prompt) { return this.client.sendMessageAsync(sessionId, prompt); }
    abortSession(id: string) { return this.client.abortSession(id); }
    listPendingPermissions() { return this.client.listPendingPermissions(); }
    replyPermission(options) { return this.client.replyPermission(options); }
    listPendingQuestions() { return this.client.listPendingQuestions(); }
    replyQuestion(options) { return this.client.replyQuestion(options); }
    rejectQuestion(id: string) { return this.client.rejectQuestion(id); }
    listAgents() { return this.client.listAgents(); }
    listProviders() { return this.client.listProviders(); }
    listCommands() { return this.client.listCommands(); }
    listSkills() { return this.client.listSkills(); }
    getConfig() { return this.client.getConfig(); }
    updateConfig(config) { return this.client.updateConfig(config); }
    forkSession(id: string, options) { return this.client.forkSession(id, options); }
    revertSession(id: string, messageId: string) { return this.client.revertSession(id, messageId); }
    unrevertSession(id: string) { return this.client.unrevertSession(id); }

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        // Phase 2 does NOT move SSE wiring yet — that happens when relay-stack
        // is refactored. For now this is a placeholder. The relay-stack continues
        // to use SSEConsumer directly until Task 4 wires it through.
        throw new Error("Use SSEConsumer directly until relay-stack refactor");
    }
}
```

**Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/lib/backend/opencode-backend.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/backend/opencode-backend.ts src/lib/backend/opencode-backend.test.ts
git commit -m "feat: implement OpenCodeBackend wrapping RelayClient"
```

---

### Task 3: Split HandlerDeps into sessionBackend + infraClient

Replace the single `client: OpenCodeClient` (now `RelayClient`) field on `HandlerDeps` and `ClientInitDeps` with `sessionBackend: SessionBackend` and `infraClient: InfraClient`. Update all 8 handler files and the mock factory.

**Files:**
- Modify: `src/lib/handlers/types.ts:71` — split `client` field
- Modify: `src/lib/handlers/session.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/prompt.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/permissions.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/model.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/agent.ts` — use `deps.sessionBackend`
- Modify: `src/lib/handlers/settings.ts` — use both (`listCommands` → `sessionBackend`, `listProjects` → `infraClient`)
- Modify: `src/lib/handlers/files.ts` — use `deps.infraClient`
- Modify: `src/lib/handlers/terminal.ts` — use `deps.infraClient`
- Modify: `src/lib/bridges/client-init.ts:31` — split `client` field on `ClientInitDeps`
- Modify: `test/helpers/mock-factories.ts` — split `createMockClient()` into `createMockSessionBackend()` + `createMockInfraClient()`

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

Update the imports at the top of the file accordingly.

**Step 2: Update `ClientInitDeps` interface**

In `src/lib/bridges/client-init.ts`, same split. Update `handleClientConnected` to use `deps.sessionBackend` for its calls to `getSession`, `listPendingPermissions`, `listPendingQuestions`, `listAgents`, `listProviders`.

**Step 3: Update each handler file**

Mechanical replacements:
- `deps.client.listSessions(...)` → `deps.sessionBackend.listSessions(...)`
- `deps.client.sendMessageAsync(...)` → `deps.sessionBackend.sendMessage(...)`
- `deps.client.getFileContent(...)` → `deps.infraClient.getFileContent(...)`
- etc.

The only method rename is `sendMessageAsync` → `sendMessage` (the interface uses the cleaner name).

**Step 4: Update mock factory**

Split `createMockClient()` into two functions: `createMockSessionBackend()` returning `SessionBackend` stubs, `createMockInfraClient()` returning `InfraClient` stubs. Update `createMockHandlerDeps()` (or equivalent) to use both.

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
git add src/lib/handlers/session.ts src/lib/handlers/prompt.ts src/lib/handlers/permissions.ts src/lib/handlers/model.ts src/lib/handlers/agent.ts src/lib/handlers/settings.ts src/lib/handlers/files.ts src/lib/handlers/terminal.ts src/lib/bridges/client-init.ts
git commit -m "refactor: update all handlers to use sessionBackend/infraClient"
```

---

### Task 4: Refactor Relay Stack to Use SessionBackend + InfraClient

The relay stack currently constructs a single `RelayClient` and passes it everywhere. Refactor it to construct an `OpenCodeBackend` (wrapping the `RelayClient`) for session-centric operations, and pass the `RelayClient` directly as the `InfraClient` for PTY/files/search.

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — construct `OpenCodeBackend`, pass `sessionBackend` + `infraClient` to handler deps wiring
- Modify: `src/lib/relay/handler-deps-wiring.ts` — accept `sessionBackend` + `infraClient`
- Modify: `src/lib/session/session-manager.ts` — change `client` option to `sessionBackend: SessionBackend`
- Modify: `src/lib/session/session-status-poller.ts` — change `Pick<OpenCodeClient, ...>` to `Pick<SessionBackend, ...>`
- Modify: `src/lib/relay/message-poller.ts` — change `Pick<OpenCodeClient, ...>` to `Pick<SessionBackend, ...>`
- Modify: `src/lib/relay/message-poller-manager.ts` — same
- Modify: `src/lib/relay/session-lifecycle-wiring.ts` — use `SessionBackend`
- Modify: `src/lib/relay/monitoring-wiring.ts` — use `SessionBackend`

**Step 1: Update relay-stack.ts**

At line ~145, after constructing `RelayClient`:

```typescript
const client = new RelayClient({ baseUrl: config.opencodeUrl, ... });
const sessionBackend = new OpenCodeBackend({ client });
// client also serves as infraClient (implements InfraClient)
```

Pass `sessionBackend` to SessionManager, SessionStatusPoller, MessagePollerManager, and handler deps wiring. Pass `client` (as `infraClient`) to handler deps wiring and PTY upstream.

SSEConsumer continues to use `client.getAuthHeaders()` and `config.opencodeUrl` directly — unchanged.

**Step 2: Update SessionManager constructor**

Change `SessionManagerOptions.client: OpenCodeClient` to `SessionManagerOptions.backend: SessionBackend`. Update all internal references from `this.client.listSessions()` to `this.backend.listSessions()`, etc.

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
git commit -m "refactor: relay stack uses SessionBackend + InfraClient"
```

---

### Task 5: Wire SSE Events Through OpenCodeBackend

Move the SSE event subscription into `OpenCodeBackend.subscribeEvents()` so the relay can consume events through the `SessionBackend` interface. The SSEConsumer itself stays unchanged — it just gets owned by the backend instead of the relay stack directly.

**Files:**
- Modify: `src/lib/backend/opencode-backend.ts` — accept SSEConsumer config, implement `subscribeEvents()`
- Modify: `src/lib/relay/relay-stack.ts` — stop constructing SSEConsumer directly, let backend handle it
- Modify: `src/lib/relay/sse-wiring.ts` — consume events from `backend.subscribeEvents()` instead of SSEConsumer directly

**Step 1: Extend OpenCodeBackend to own the SSEConsumer**

```typescript
export interface OpenCodeBackendOptions {
    client: RelayClient;
    sseConfig?: {
        baseUrl: string;
        authHeaders?: Record<string, string>;
        log?: Logger;
    };
}

export class OpenCodeBackend implements SessionBackend {
    private sseConsumer?: SSEConsumer;

    async initialize() {
        if (this.sseConfig) {
            this.sseConsumer = new SSEConsumer(serviceRegistry, this.sseConfig);
            this.sseConsumer.start();
        }
    }

    async shutdown() {
        this.sseConsumer?.stop();
    }

    async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
        if (!this.sseConsumer) return;
        // Bridge SSEConsumer's EventEmitter to AsyncIterable
        const channel = new AsyncEventChannel<BackendEvent>();
        const handler = (event: OpenCodeEvent) => {
            channel.push({ type: event.type, properties: event.properties });
        };
        this.sseConsumer.on("event", handler);
        signal.addEventListener("abort", () => {
            this.sseConsumer?.off("event", handler);
            channel.close();
        });
        yield* channel;
    }
}
```

**Step 2: Create AsyncEventChannel utility**

```typescript
// src/lib/backend/async-event-channel.ts
export class AsyncEventChannel<T> {
    private queue: T[] = [];
    private resolver: ((value: IteratorResult<T>) => void) | null = null;
    private closed = false;

    push(event: T) {
        if (this.closed) return;
        if (this.resolver) {
            this.resolver({ value: event, done: false });
            this.resolver = null;
        } else {
            this.queue.push(event);
        }
    }

    close() {
        this.closed = true;
        if (this.resolver) {
            this.resolver({ value: undefined as any, done: true });
            this.resolver = null;
        }
    }

    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
        return {
            next: () => {
                if (this.queue.length > 0) {
                    return Promise.resolve({ value: this.queue.shift()!, done: false as const });
                }
                if (this.closed) {
                    return Promise.resolve({ value: undefined as any, done: true as const });
                }
                return new Promise(resolve => { this.resolver = resolve; });
            },
            return: () => {
                this.close();
                return Promise.resolve({ value: undefined as any, done: true as const });
            },
            [Symbol.asyncIterator]() { return this; },
        };
    }
}
```

**Step 3: Write tests for AsyncEventChannel**

Test: push/pull ordering, close behavior, backpressure when consumer is slow, signal abort.

**Step 4: Update relay-stack and sse-wiring**

The relay stack stops constructing SSEConsumer. Instead, it passes SSE config to `OpenCodeBackend`, calls `backend.initialize()`, and sse-wiring consumes from `backend.subscribeEvents(signal)`.

**Step 5: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
```

**Step 6: Commit**

```bash
git commit -m "refactor: SSE events flow through OpenCodeBackend.subscribeEvents()"
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

**Step 2: Verify no direct OpenCodeClient/RelayClient usage in handlers**

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

### Task 7: Install Claude Agent SDK and Explore

**Files:**
- Modify: `package.json`

**Step 1: Install the SDK**

```bash
pnpm add @anthropic-ai/claude-agent-sdk
```

**Step 2: Explore SDK exports**

Write a temporary exploration script (not committed) to document:

1. `query()` function signature and options
2. `SDKMessage` discriminated union types and their fields
3. `listSessions()`, `getSessionMessages()`, `getSessionInfo()` — session management functions
4. `canUseTool` callback signature and return type
5. `Query` object methods: `interrupt()`, `supportedModels()`, `supportedAgents()`, `supportedCommands()`, `close()`
6. Permission mode options
7. Built-in tool names for `allowedTools`
8. How `cwd` and `resume` options work

**Step 3: Write findings to `docs/plans/claude-agent-sdk-exploration.md`**

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @anthropic-ai/claude-agent-sdk"
```

---

### Task 8: Implement ClaudeAgentBackend — Session Management

The first slice of `ClaudeAgentBackend`: session CRUD and discovery. No messaging yet.

**Files:**
- Create: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/claude-agent-backend.test.ts`

**Step 1: Write failing tests**

Test `listSessions`, `createSession`, `getSession`, `deleteSession` using the Claude Agent SDK's `listSessions()` and `getSessionMessages()` functions. Mock the SDK imports.

**Step 2: Implement session management**

```typescript
import { listSessions, getSessionMessages, getSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { SessionBackend, BackendEvent } from "./types.js";
import { AsyncEventChannel } from "./async-event-channel.js";

export interface ClaudeAgentBackendOptions {
    cwd: string;
    apiKey?: string;  // ANTHROPIC_API_KEY
    model?: string;
    allowedTools?: string[];
}

export class ClaudeAgentBackend implements SessionBackend {
    readonly type = "claude-agent" as const;
    private readonly cwd: string;
    private readonly apiKey: string | undefined;
    private readonly model: string;
    private readonly allowedTools: string[];
    private activeQuery: any | null = null;
    private readonly channel = new AsyncEventChannel<BackendEvent>();
    private readonly pendingPermissions = new Map<string, { resolve: (v: string) => void; metadata: any }>();
    private readonly pendingQuestions = new Map<string, { resolve: (v: any) => void; metadata: any }>();

    // Session placeholders for lazy creation
    private readonly localSessions = new Map<string, { id: string; title: string; created: number }>();

    constructor(options: ClaudeAgentBackendOptions) {
        this.cwd = options.cwd;
        this.apiKey = options.apiKey;
        this.model = options.model ?? "claude-sonnet-4-20250514";
        this.allowedTools = options.allowedTools ?? ["Read", "Glob", "Grep"];
    }

    async initialize() { /* validate cwd exists, API key available */ }
    async shutdown() { this.activeQuery?.close(); this.channel.close(); }
    async getHealth() { return { ok: true }; }

    async listSessions() {
        const sdkSessions = await listSessions({ dir: this.cwd, limit: 50 });
        return sdkSessions.map(s => this.toSessionDetail(s));
    }

    async createSession() {
        // Lazy — create local placeholder, real SDK session on first message
        const id = `local-${crypto.randomUUID()}`;
        const session = { id, title: "New Session", created: Date.now() };
        this.localSessions.set(id, session);
        return this.toSessionDetail(session);
    }

    // ... remaining session methods
}
```

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat: ClaudeAgentBackend session management"
```

---

### Task 9: Implement ClaudeAgentBackend — Messaging + Event Streaming

The core: `sendMessage()` starts a `query()`, pipes `SDKMessage` events through the channel, implements the `subscribeEvents()` async iterable.

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/sdk-message-translator.ts` — SDKMessage → BackendEvent translation
- Create: `src/lib/backend/sdk-message-translator.test.ts`

**Step 1: Write failing tests for the translator**

Test each `SDKMessage` type maps to the correct `BackendEvent`.

**Step 2: Implement translator**

```typescript
// src/lib/backend/sdk-message-translator.ts
import type { BackendEvent } from "./types.js";

export function translateSdkMessage(msg: any): BackendEvent | null {
    switch (msg.type) {
        case "assistant":
            return { type: "message.updated", properties: { sessionID: msg.session_id, message: msg.message } };
        case "user":
            return { type: "message.updated", properties: { sessionID: msg.session_id, message: msg.message } };
        case "stream_event":
            return { type: "message.part.updated", properties: { event: msg.event } };
        case "result":
            return { type: "session.updated", properties: { sessionID: msg.session_id, result: msg } };
        case "system":
            return { type: "session.initialized", properties: { sessionID: msg.session_id, ...msg } };
        default:
            return null; // Unknown message types ignored
    }
}
```

**Step 3: Implement sendMessage + subscribeEvents**

```typescript
async sendMessage(sessionId: string, prompt: PromptOptions) {
    if (this.activeQuery) throw new Error("Session is busy");

    const isLocal = this.localSessions.has(sessionId);
    const resumeId = isLocal ? undefined : sessionId;

    this.activeQuery = query({
        prompt: prompt.text ?? "",
        options: {
            model: this.model,
            cwd: this.cwd,
            resume: resumeId,
            allowedTools: this.allowedTools,
            canUseTool: this.handleCanUseTool,
            includePartialMessages: true,
            systemPrompt: { type: "preset", preset: "claude_code" },
            settingSources: ["user", "project"],
            env: this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : undefined,
        },
    });

    // Pipe messages to channel in background
    (async () => {
        try {
            for await (const msg of this.activeQuery!) {
                const event = translateSdkMessage(msg);
                if (event) this.channel.push(event);

                // Capture real session ID on first message
                if (isLocal && msg.session_id) {
                    this.localSessions.delete(sessionId);
                    // Map local ID → real ID
                }
            }
        } finally {
            this.activeQuery = null;
        }
    })();
}

async abortSession() {
    if (this.activeQuery) {
        await this.activeQuery.interrupt();
    }
}

async *subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent> {
    signal.addEventListener("abort", () => this.channel.close());
    yield* this.channel;
}
```

**Step 4: Run tests**

**Step 5: Commit**

```bash
git commit -m "feat: ClaudeAgentBackend messaging and event streaming"
```

---

### Task 10: Implement ClaudeAgentBackend — Permission + Question Bridging

**Files:**
- Modify: `src/lib/backend/claude-agent-backend.ts`
- Create: `src/lib/backend/deferred.ts` — utility
- Create: `src/lib/backend/permission-bridge-agent.test.ts`

**Step 1: Write failing tests**

Test that `canUseTool` callback creates a pending permission, `listPendingPermissions()` returns it, `replyPermission()` resolves it, and the `canUseTool` callback returns the decision.

**Step 2: Implement deferred utility**

```typescript
// src/lib/backend/deferred.ts
export interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: any) => void;
}

export function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
```

**Step 3: Implement `canUseTool` bridging**

```typescript
private handleCanUseTool = async (toolName: string, toolInput: unknown) => {
    const id = crypto.randomUUID();
    const deferred = createDeferred<string>();
    this.pendingPermissions.set(id, {
        resolve: deferred.resolve,
        metadata: { id, tool: toolName, input: toolInput, timestamp: Date.now() },
    });

    this.channel.push({
        type: "permission.created",
        properties: { id, tool: toolName, input: toolInput },
    });

    const decision = await deferred.promise;
    this.pendingPermissions.delete(id);
    return { hookSpecificOutput: { permissionDecision: decision } };
};

async listPendingPermissions() {
    return [...this.pendingPermissions.values()].map(p => p.metadata);
}

async replyPermission(options: { id: string; decision: string }) {
    const entry = this.pendingPermissions.get(options.id);
    if (entry) entry.resolve(options.decision);
}
```

Same pattern for questions using `AskUserQuestion` tool detection in `canUseTool`.

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat: ClaudeAgentBackend permission and question bridging"
```

---

### Task 11: Phase 3 Integration and Verification

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — add ability to construct `ClaudeAgentBackend` based on config
- Create: `test/integration/flows/claude-agent-backend.integration.ts`

**Step 1: Add backend factory to relay stack**

```typescript
function createSessionBackend(config: ProjectRelayConfig, client: RelayClient): SessionBackend {
    if (config.backendType === "claude-agent") {
        return new ClaudeAgentBackend({
            cwd: config.projectDir,
            apiKey: config.anthropicApiKey,
            model: config.defaultModel,
        });
    }
    return new OpenCodeBackend({ client, sseConfig: { ... } });
}
```

**Step 2: Write integration tests**

Test the `ClaudeAgentBackend` against the real Agent SDK (requires `ANTHROPIC_API_KEY`). Mark as conditional — skip if no key.

**Step 3: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 4: Commit**

```bash
git commit -m "feat: Phase 3 complete — ClaudeAgentBackend wired into relay stack"
```

---

## Phase 4: Model-Level Switching

### Task 12: Backend Switching in Relay Stack

**Files:**
- Modify: `src/lib/relay/relay-stack.ts` — hold both backends, switch active one
- Modify: `src/lib/handlers/model.ts` — trigger backend switch on model change

**Step 1: Add dual-backend support to relay stack**

The relay stack holds a `Map<string, SessionBackend>` — one per backend type. The `activeBackend` property points to whichever is currently in use. When the model handler detects a switch to a Claude model, it swaps `activeBackend`.

**Step 2: Handle session list switching**

Sessions are backend-specific. When the backend switches, the frontend needs to reload the session list. Broadcast a `backend_switched` event that tells the frontend to refresh.

**Step 3: Commit**

```bash
git commit -m "feat: model-level backend switching between OpenCode and Claude Agent SDK"
```

---

### Task 13: Frontend Backend Awareness

**Files:**
- Modify: `src/lib/frontend/stores/` — handle `backend_switched` message, refresh session list
- Modify: `src/lib/frontend/components/` — show current backend indicator (optional)

**Step 1: Handle backend_switched message in stores**

When the frontend receives `backend_switched`, clear the current session list and re-fetch from the new backend.

**Step 2: Commit**

```bash
git commit -m "feat: frontend handles backend switching"
```

---

### Task 14: Phase 4 Final Verification

**Step 1: Full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

**Step 2: Manual smoke test**

- Start with OpenCode backend, create sessions, send messages
- Switch to Claude model → verify backend switches, session list changes
- Send message through Claude Agent SDK → verify streaming, permissions work
- Switch back to OpenCode → verify original sessions are still there
- PTY works throughout regardless of backend

**Step 3: Commit**

```bash
git commit -m "feat: Phase 4 complete — dual SDK with model-level switching"
```
