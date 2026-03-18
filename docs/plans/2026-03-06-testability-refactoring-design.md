# Testability & Error-Prevention Refactoring

## Problem

The codebase has strong foundations (zero `any`, injectable clocks, IO/logic separation, structured error hierarchy) but accumulated several patterns that reduce testability and make it easier to introduce errors:

1. **28 unsafe `(err as Error).message` casts** in catch blocks — crash if non-Error thrown
2. **25+ redundant `as` casts** on `ChatMessage` discriminated unions in frontend stores
3. **Duplicated event pipeline** between SSE consumer and message poller
4. **God objects** in `daemon.ts` (1180 lines, 8+ concerns) and `ws.svelte.ts` (815 lines, 4 concerns)

## Approach

Five independent PRs, ordered by risk (lowest first):

| PR | Area | Risk | Impact |
|----|------|------|--------|
| 1 | Unsafe error casts → `formatErrorDetail()` | Trivial | 28 casts eliminated |
| 2 | Redundant `as` casts + type guards | Low | ~20 casts eliminated/replaced |
| 3 | Pipeline + test helper deduplication | Low | Single source of truth |
| 4 | `daemon.ts` decomposition | Medium | Isolated testability |
| 5 | `ws.svelte.ts` + `http-router.ts` decomposition | Medium | Separation of concerns |

---

## PR 1: Unsafe Error Catching

### Current state
28 instances of `(err as Error).message` across 8 files. The safe alternative `formatErrorDetail(err)` already exists in `errors.ts` and is used in 18 places.

### Changes

**Mechanical replacement** in these files:
- `daemon.ts` (6 instances)
- `daemon-ipc.ts` (7 instances)
- `handlers/instance.ts` (6 instances)
- `instance-manager.ts` (1 instance)
- `message-cache.ts` (2 instances)
- `cli-core.ts` (2 instances)
- `cli-commands.ts` (1 instance)
- `sse-backoff.ts` (3 instances)

**Special case:** `config-persistence.ts:70` casts to `NodeJS.ErrnoException` for `.code` access. Add a type guard:

```typescript
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
    return err instanceof Error && 'code' in err;
}
```

### Verification
All existing tests pass unchanged.

---

## PR 2: Frontend Store Type Safety

### 2a. Remove redundant casts (~14 instances)

After `m.type === "thinking"`, TypeScript narrows `m` to `ThinkingMessage`. The `as` casts are noise — delete them.

Before:
```typescript
if (m.type === "thinking" && !(m as ThinkingMessage).done) {
    messages[i] = { ...(m as ThinkingMessage), text: (m as ThinkingMessage).text + text };
```

After:
```typescript
if (m.type === "thinking" && !m.done) {
    messages[i] = { ...m, text: m.text + text };
```

Affected lines in `chat.svelte.ts`: 124-127, 144-146, 179-181, 267-274, 309-311, 371, 431, 457-459.

### 2b. Type-safe array search (~6 instances)

TypeScript can't narrow `messages[idx]` from a `.findIndex()` predicate. Extract a `findMessage()` helper:

```typescript
function findMessage<T extends ChatMessage['type']>(
    messages: ChatMessage[],
    type: T,
    predicate: (m: Extract<ChatMessage, { type: T }>) => boolean,
): { index: number; message: Extract<ChatMessage, { type: T }> } | undefined
```

### 2c. Unify replay with dispatch

`replayEvents()` (ws.svelte.ts:649-710) duplicates `handleMessage()` switch cases. Refactor `replayEvents()` to call `handleMessage()` with a `replaying` flag to suppress side effects (notifications, banners).

### Verification
Existing chat store unit tests. Cast removals that compile are correct by construction.

---

## PR 3: Pipeline + Test Helper Deduplication

### 3a. Event pipeline extraction

`relay-stack.ts:578-608` and `sse-wiring.ts:206-256` duplicate four operations: tool_result truncation, processing timeout management, cache recording, and per-session routing.

Extract to shared function:

```typescript
export interface EventPipelineDeps {
    toolContentStore: ToolContentStore;
    overrides: SessionOverrides;
    messageCache: MessageCache;
    wsHandler: WebSocketHandler;
}

export function processRelayEvent(
    msg: RelayMessage,
    sessionId: string | undefined,
    deps: EventPipelineDeps,
): RelayMessage
```

Both SSE handler and poller handler call this. SSE handler still does its additional permission/question/push work after.

### 3b. Test helper extraction

Move to `test/helpers/opencode-utils.ts`:
- `isOpenCodeRunning(url?)` — identical in both harnesses
- `switchModelViaWs(port, modelId, providerId)` — structurally identical, e2e wraps with env-var guard

### Verification
`pnpm test`, `pnpm test:integration`, E2E tests.

---

## PR 4: `daemon.ts` Decomposition

### Easy extractions (zero coupling)

| New Module | Lines | Content |
|---|---|---|
| `crash-counter.ts` | 36 lines | `CrashCounter` class (record, shouldGiveUp, reset, getTimestamps) |
| `pid-manager.ts` | 37 lines | PID/socket file management (write, remove, cleanupStale) |
| `signal-handlers.ts` | 29 lines | `installSignalHandlers(onShutdown)` / `removeSignalHandlers()` |
| `daemon-utils.ts` | 63 lines | Pure functions: `probeOpenCode`, `findFreePort`, `buildConfig` |

### Medium extraction

| New Module | Lines | Content |
|---|---|---|
| `project-manager.ts` | 194 lines | Projects Map, relay creation, discovery. Constructor-injected deps. |

### Result
`daemon.ts` drops from 1180 → ~820 lines, focused on lifecycle orchestration.

### Not splitting
`start()` (210 lines) — it's inherently sequential orchestration. HTTP/IPC server methods — too small (47/124 lines) and tightly lifecycle-coupled.

### Verification
Existing `daemon.test.ts`. Add unit tests for `CrashCounter`, `PidManager`.

---

## PR 5: `ws.svelte.ts` + `http-router.ts` Decomposition

### 5a. `ws.svelte.ts` (815 → ~400 lines)

| New Module | Lines | Content |
|---|---|---|
| `ws-send.svelte.ts` | ~130 lines | Rate limiter, offline queue, `wsSend()`, drain logic |
| `ws-dispatch.ts` | ~320 lines | `handleMessage()` switch + unified `replayEvents()` (from PR 2c) |

Core `ws.svelte.ts` retains: connection lifecycle, `wsState`, reconnect, re-exports.

### 5b. `http-router.ts` route table

Convert the 259-line `if` chain in `handleRequest` to a declarative route table:

```typescript
const routes: Route[] = [
    { method: "POST", path: "/auth", handler: this.handleAuth },
    { method: "GET", path: "/api/auth/status", handler: this.handleAuthStatus },
    // ...
];
```

Extract `static-files.ts` (88 lines) for `getCacheControl()`, `serveStaticFile()`, `tryServeStatic()`.

### Verification
Existing `http-router.test.ts`, `http-router.pbt.test.ts`. Public API unchanged.

---

## Dependencies Between PRs

```
PR 1 (error casts) ─────────────── independent
PR 2 (store types) ─────────────── independent
PR 3 (pipeline dedup) ──────────── independent
PR 4 (daemon decomp) ──────────── independent
PR 5 (ws/router decomp) ────────── depends on PR 2c (replay unification)
```

PRs 1-4 can land in any order. PR 5 should land after PR 2 (since PR 2c unifies replay/dispatch, and PR 5 then extracts the unified dispatch).

## Success Criteria

- Zero new `as` casts introduced
- Zero `(err as Error).message` patterns remain
- No duplicated pipeline logic between SSE and poller paths
- `daemon.ts` < 850 lines
- `ws.svelte.ts` < 450 lines
- All existing tests pass
- New unit tests for extracted modules (`CrashCounter`, `PidManager`, `findMessage`)
