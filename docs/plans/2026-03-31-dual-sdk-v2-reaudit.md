# Audit Synthesis: Dual SDK Implementation Plan v2

**Plan:** `docs/plans/2026-03-31-dual-sdk-plan.md`  
**Auditors dispatched:** 4 (Tasks 1-3, Tasks 4-6, Tasks 7-8, Tasks 9-11, Tasks 12-16)  
**Total findings:** 70+  

---

## Critical Findings (Will Cause Bugs in Production)

### 🔴 C1 — `subscribeEvents` crashes with multiple WebSocket clients (Task 9)
**Action: Amend Plan**

`AsyncEventChannel` is single-consumer by design (has runtime guard). `ClaudeAgentBackend.subscribeEvents()` calls `this.channel[Symbol.asyncIterator]()` for each subscriber but they all share the same channel, so the second concurrent consumer triggers `throw new Error("AsyncEventChannel supports only one concurrent consumer")`.

**Fix:** Each `subscribeEvents()` call needs its own channel. Implement a fan-out pattern: the backend pushes events to a broadcast registry, and each subscriber gets its own `AsyncEventChannel` that receives copies.

---

### 🔴 C2 — `processQueryStream` finally block rejects ALL pending deferreds globally (Task 10)
**Action: Amend Plan**

Lines 2430-2437 iterate `this.pendingPermissions` and `this.pendingQuestions` — these are global maps. With D7 concurrent queries, aborting session A denies permissions belonging to session B.

**Fix:** Either (a) add `sessionId` to each `PermissionEntry`/`QuestionEntry` and filter in the finally block, or (b) store pending deferreds inside `QueryState` so they're naturally per-session.

---

### 🔴 C3 — Event pipeline not re-wired after backend swap (Tasks 13/14)
**Action: Amend Plan**

The swap handler broadcasts `backend_switched` to browsers but does NOT restart the server-side event consumption pipeline. The relay's `wireSSEConsumer` in `sse-wiring.ts` is bound at startup to the initial SSEConsumer. When swapping to Claude Agent SDK, nothing subscribes to the new backend's `subscribeEvents()` and pipes events through translate → filter → cache → WS broadcast.

**Fix:** Add an event consumer loop that is started at relay startup and restarted in the swap handler on the new backend.

---

### 🔴 C4 — Proxy target updated before `initialize()` completes — race condition (Task 14)
**Action: Amend Plan**

`BackendProxy.swap()` sets `this.target = newBackend` before handlers run. The first swap handler calls `await newBackend.initialize()`. Between target change and init completion, any incoming WebSocket message hits an uninitialized backend.

**Fix:** Initialize the new backend BEFORE swapping the target:
```typescript
await newBackend.initialize(); // Initialize FIRST
const old = this.target;
this.target = newBackend;      // Swap AFTER init
await old.shutdown();          // Shutdown old AFTER swap
```

---

### 🔴 C5 — `translateResult` missing `role: "assistant"` — cost/tokens never reach frontend (Task 8)
**Action: Amend Plan**

Plan lines 1537-1557: the `message.updated` event from `translateResult()` lacks `role: "assistant"`. The downstream `translateMessageUpdated` (event-translator.ts:434-435) checks `msg.role !== "assistant"` and returns null. Result: cost and token data from SDK queries silently dropped.

**Fix:** Add `role: "assistant"` to the message object in `translateResult()`.

---

### 🔴 C6 — PartID inconsistency: tool input deltas silently dropped (Task 8)
**Action: Amend Plan**

`content_block_start` for tool_use uses `partID: event.content_block.id` (e.g., `"toolu_abc123"`). But `input_json_delta` uses `partID: "part-${event.index}"` (e.g., `"part-0"`). EventTranslator tracks parts by partID — the delta references a partID that was never registered. Tool input JSON is silently dropped.

**Fix:** Standardize all partIDs to `part-${event.index}` format. Store `content_block.id` as `callID` only:
```typescript
partID: `part-${event.index}`,
part: { callID: event.content_block.id, ... }
```

---

### 🔴 C7 — Double `session.status` idle → duplicate `done` events (Task 8/10)
**Action: Amend Plan**

`translateResult()` emits `session.status` with `{ type: "idle" }`, AND `processQueryStream`'s finally block ALSO emits `session.status` idle. Every successful query completion produces TWO `done` events.

**Fix:** Remove `session.status` idle from `translateResult()`. The `processQueryStream` finally block is the single source of truth (handles all exit paths: success, error, abort).

---

### 🔴 C8 — `SessionDetail` shape mismatch — timestamps break (Task 9)
**Action: Amend Plan**

`toSessionDetail()` returns `{ created, updated }` at top level. But actual `SessionDetail` nests them under `time: { created, updated }`. Existing code accesses `session.time?.created`. All Claude Agent sessions will show no timestamps.

**Fix:** Return `time: { created, updated }` nested format. Also, `backendType` and `isPlaceholder` are not on `SessionDetail` — either extend the type or use a separate field.

---

## High-Priority Findings (Should Fix Before Implementation)

### 🟠 H1 — No rollback on swap failure (Task 14/16)
**Action: Amend Plan**

If `newBackend.initialize()` fails, the proxy target has been changed and the old backend has been shut down. System is permanently broken. Combined with C4 fix (initialize before swap), this is resolved — if init fails, old backend stays active.

---

### 🟠 H2 — `SDKMessage` uses `Record<string, any>` (Task 8)
**Action: Amend Plan**

Plan's `SDKMessage` interface has `message?: Record<string, any>` and `event?: Record<string, any>`, violating D2 (no `any` types). Also has `[key: string]: unknown` index signature that silently swallows type errors.

**Fix:** Replace with typed sub-interfaces for `message` and `event` fields. Remove index signature.

---

### 🟠 H3 — Missing integration test through EventTranslator (Task 8)
**Action: Amend Plan**

No test pipes `translateSdkMessage()` output through `createTranslator().translate()`. This would have caught C5 (missing `role: "assistant"`) and C6 (partID inconsistency) at test time.

**Fix:** Add integration tests verifying BackendEvent → EventTranslator → RelayMessage pipeline.

---

### 🟠 H4 — `toMessage` wrong shape and `any` casts (Task 9)
**Action: Amend Plan**

Returns `{ id, role, content, sessionID }` but `Message` type expects `{ id, role, sessionID, parts, cost, tokens, time }`. Uses `(sdkMsg as any)` casts violating D2. Any consumer using `message.parts` gets `undefined`.

**Fix:** Map SDK message content to `parts` format. Use typed interface instead of `any` casts.

---

### 🟠 H5 — `handleCanUseTool` undefined between Tasks 10-11 (Task 10)
**Action: Amend Plan**

Task 10 passes `canUseTool: this.handleCanUseTool` in query options, but `handleCanUseTool` is defined in Task 11. Between these tasks, it's `undefined`, meaning the SDK either auto-approves everything (dangerous) or uses default mode.

**Fix:** Define `handleCanUseTool` as an arrow function stub in Task 9 that returns `{ behavior: "deny", message: "Permissions not yet configured" }`.

---

### 🟠 H6 — `backendFactories` vs `backendRegistry` mismatch in HandlerDeps (Task 14)
**Action: Amend Plan**

Task 14 adds `backendRegistry: Map<string, SessionBackend>` to HandlerDeps but uses `backendFactories: Map<string, () => SessionBackend>` in relay-stack. Model handler calls `deps.backendFactories` which doesn't exist.

**Fix:** Pass `maybeSwapBackend: (requiredType: string) => Promise<void>` as a closure on HandlerDeps. Handlers shouldn't know about factories.

---

### 🟠 H7 — Pollers not stopped/restarted on backend swap (Task 14)
**Action: Amend Plan**

`SessionStatusPoller` and `MessagePollerManager` are OpenCode-specific. When swapping to Claude Agent SDK, they continue polling stale data. When swapping back, they need restarting.

**Fix:** Add poller stop/start to swap handler.

---

### 🟠 H8 — `capabilities` not added to `session_list` RelayMessage type or populated from server (Tasks 14/15)
**Action: Amend Plan**

Plan says to add capabilities to session_list response but never modifies the `RelayMessage` union's `session_list` variant to include it. Frontend defaults capabilities to `{ fork: true, revert: true }` but never receives server values.

**Fix:** Add `capabilities?: { fork: boolean; revert: boolean; unrevert: boolean }` to the `session_list` RelayMessage variant and wire the handler.

---

### 🟠 H9 — No "always" permission caching (Task 11)
**Action: Amend Plan**

When user clicks "always allow," the backend doesn't cache the decision. Every subsequent call to the same tool creates a new permission request. Clay's reference impl tracks `session.allowedTools` for this.

**Fix:** Add `Set<string>` per session tracking always-allowed tools. Check before creating deferred.

---

### 🟠 H10 — `{ rejected: true } as unknown as QuestionAnswer` type hack (Task 11)
**Action: Amend Plan**

Resolves deferred with wrong type through double cast. Fragile and violates D2.

**Fix:** Use discriminated union: `type QuestionResult = { type: "answered"; answers: string[][] } | { type: "rejected" }`.

---

### 🟠 H11 — Event listener leak in `OpenCodeBackend.subscribeEvents()` on early return (Task 3)
**Action: Amend Plan**

If the `for await...of` consuming the generator breaks without abort signal, the SSEConsumer event listener remains registered.

**Fix:** Wrap `yield* channel` in `try/finally` to ensure listener cleanup:
```typescript
try { yield* channel; } finally { this.sseConsumer?.off("event", handler); channel.close(); }
```

---

### 🟠 H12 — No test for `subscribeEvents()` in OpenCodeBackend (Task 3)
**Action: Amend Plan**

The most complex method (event channel bridging + signal cleanup) has zero test coverage.

**Fix:** Add tests for: events yielded from SSEConsumer, abort signal terminates iteration, returns immediately when SSEConsumer not configured.

---

### 🟠 H13 — InfraClient structural test checks names only, not signatures (Task 1)
**Action: Amend Plan**

The test uses `expectTypeOf<keyof InfraClient>().toMatchTypeOf<keyof OpenCodeClient>()` which only checks method name membership. Signature mismatches (different params/return types) pass silently.

**Fix:** Use `expectTypeOf<Pick<OpenCodeClient, keyof InfraClient>>().toMatchTypeOf<InfraClient>()`.

---

### 🟠 H14 — Duplicate session ID maps (Task 9)
**Action: Amend Plan**

`sessionIdMap` and `cliSessionIds` both store `localId → cliSessionId`. One should be removed to prevent desynchronization.

---

### 🟠 H15 — Cross-backend session continuity never implemented (Task 14)
**Action: Amend Plan**

Amendments state "Prepend history only on first message after backend switch" but no task implements this. No task modifies the prompt handler to detect cross-backend switches.

**Fix:** Either implement in Task 14 or explicitly defer with known-limitation documentation.

---

## Ask User (Design Decisions Required)

### 🟡 U1 — SDK package name: `@anthropic-ai/claude-agent-sdk` vs `@anthropic-ai/claude-code`
The reference implementation uses `@anthropic-ai/claude-code`. The plan and SDK reference doc say `@anthropic-ai/claude-agent-sdk`. If wrong, every import in Phase 3 breaks. Verify against npm before proceeding.

### 🟡 U2 — How does `authType` get populated?
`selectBackendType` checks `authType === "subscription"` but nothing sets this value. Options: env var, config file, UI toggle, auto-detection from API key format. Without this, Claude Agent SDK backend is unreachable.

### 🟡 U3 — `system/init` busy status silently dropped by EventTranslator
EventTranslator only handles `idle` and `retry` for `session.status` — `busy` returns null. Options: (a) drop system events for now, (b) add `busy` handler to EventTranslator, (c) bypass EventTranslator for init metadata.

### 🟡 U4 — Missing `content_block_stop` translation — tools may appear stuck
No translation for `content_block_stop`. Tools stay in "pending" state until a complete `assistant` message arrives. This may or may not be an issue depending on SDK behavior. Verify with live SDK.

### 🟡 U5 — Session list merge: single-backend proxy vs merged list from all backends
Design doc says "Merged session list from all backends." BackendProxy only delegates to one backend. These contradict. Options: (a) call both backends and merge (requires keeping both alive), (b) show only active backend's sessions (simpler, but users lose visibility of other sessions).

### 🟡 U6 — SDK API surface (`listSessions`, `getSessionInfo`, `getSessionMessages`) assumed but unverifiable
Package not installed. These functions may not exist or have different signatures. The reference impl reads JSONL files directly.

### 🟡 U7 — `listAgents`/`listCommands` empty before first query — no warmup mechanism
Frontend requests these during `handleClientConnected` before any query starts. Clay's reference impl solves with a warmup query. Plan has no warmup. Options: (a) warmup query, (b) hardcoded defaults, (c) lazy population.

### 🟡 U8 — `BetaMessage.usage.cost` may not exist
`translateAssistant` accesses `msg.message?.usage?.cost`. Anthropic API doesn't have a `cost` field on usage — cost is typically computed from tokens × pricing. Only `result.total_cost_usd` has the real cost.

---

## Accept (Informational)

| # | Task | Finding |
|---|------|---------|
| A1 | 1 | All 12 imported types exist and are exported from opencode-client.ts |
| A2 | 1 | BackendEvent re-export of OpenCodeEvent is valid |
| A3 | 1 | `sendMessage`/`sendMessageAsync` compatibility test is correct |
| A4 | 2 | Single-consumer guard has no race condition (JS event loop) |
| A5 | 2 | Deferred double-resolve safe (native Promise semantics) |
| A6 | 2 | `return()` closing channel — correct for intended pattern |
| A7 | 3 | SSEConsumer constructor signature matches plan |
| A8 | 3 | `connect()` is fire-and-forget — matches existing behavior |
| A9 | 3 | `shutdown()` could use `drain()` instead of `disconnect()` (minor) |
| A10 | 3 | Test uses `as any` — should be `as unknown as OpenCodeClient` per D2 (minor) |
| A11 | 4 | `client-init.ts` in two commits is fine (types then handlers) |
| A12 | 5 | Startup `client.getConfig()` must stay on raw client (not backend) |
| A13 | 7 | Hand-rolled `SDKUserMessage` structurally compatible — add TODO to replace |
| A14 | 7 | Push before query starts — correctly buffered by channel |
| A15 | 8 | Thinking block lifecycle correctly handled in current plan |
| A16 | 9 | No `archived`/`roots` filter — acceptable first pass |
| A17 | 9 | `getMessagesPage` O(n) slice — semantically correct, perf concern only |
| A18 | 10 | `isLocal` mutation is safe (sequential processing) |
| A19 | 11 | Permission event flows correctly through EventTranslator |
| A20 | 11 | Shutdown vs finally cleanup — safe (Promise settles once) |
| A21 | 11 | Concurrent permission test relies on Map order — spec-guaranteed |
| A22 | 12 | Barrel exports omit internal-only functions — correct |
| A23 | 12 | Hardcoded model in test — acceptable |
| A24 | 13 | Proxy edge cases (`instanceof`, `toString`) — not exercised |
| A25 | 14 | Factory captures stale config — consistent with existing pattern |
| A26 | 15 | `.ts` importing `.svelte.ts` — works in Svelte 5 |
| A27 | 16 | Manual smoke test — pragmatic without mock SDK |
| A28 | 16 | Session persistence across swaps — works via OpenCode server |

---

## Amend Plan Findings Count: 22
## Ask User Findings Count: 8
## Accept Findings Count: 28

**Verdict: Amend Plan and Ask User findings exist → handing off to plan-audit-fixer to resolve.**

---

## Amendments Applied (v3 Fixer Pass)

All 22 Amend Plan findings and 8 Ask User findings resolved. Amendments appended to plan as "Audit Amendments v3 (Re-audit Fixes)".

| Finding | Task | Amendment |
|---------|------|-----------|
| C1 (subscribeEvents crash) | 9 | A9.2: Fan-out subscriber pattern |
| C2 (global deferred cleanup) | 10 | A10.1/A10.2: Per-session scoped cleanup |
| C3 (event pipeline not re-wired) | 14 | A14.2: Event consumer restart on swap |
| C4 (init before swap race) | 14 | A14.1/A14.3: Init before swap, no shutdown (D12) |
| C5 (missing role:assistant) | 8 | A8.1: Added role field |
| C6 (partID inconsistency) | 8 | A8.2: Standardized to part-${index} |
| C7 (double idle) | 8 | A8.3: Removed from translateResult |
| C8 (SessionDetail shape) | 9 | A9.1: Nested time, correct SDK fields |
| H1-H15 | various | See plan document amendments section |
| U1-U8 | various | Resolved per user decisions, see Design Decisions v3 table |
