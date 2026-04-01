# Dual SDK Plan v3 — Audit Synthesis

**Plan:** `docs/plans/2026-03-31-dual-sdk-plan.md`
**Auditors dispatched:** 13 (Tasks 1, 2, 3, 4-5, 7-8, 9, 10, 11, 12, 13, 14, 15)
**Total findings:** ~160 across all tasks

---

## Systemic Finding: Amendments Never Inlined

**Every single auditor** reported the same meta-issue: the v2 audit produced ~117 amendments which were added as prose directives in the plan header (lines 40-134) and task-specific sections (lines 2993-3133), but **the actual code blocks the implementer would copy were never updated**. Every task's Step 1/Step 3 code is the pre-amendment version.

**Action: Amend Plan** — All code blocks must be rewritten to incorporate their amendments. An implementer reading only the task steps will produce broken code. This is the single highest-priority fix.

---

## Cross-Cutting Findings

### CT-1: Phase 1 Not Complete — All Imports Broken (Tasks 1, 3, 9)

Phase 1 (`sdk-client.ts`, `relay-types.ts`) is not yet executed. Every task importing from `../instance/relay-types.js` or `../instance/sdk-client.js` will fail to compile.

**Action: Amend Plan** — Per D1, all tasks must either: (a) gate on Phase 1 verification, or (b) reference `OpenCodeClient` from `opencode-client.js`.

### CT-2: Pervasive `any` Typing (Tasks 3, 9, 10, 11)

Despite D2 and repeated amendments, the code blocks still use `any` for:
- All 12 OpenCodeBackend delegation method parameters
- `activeQuery: any | null`
- `prompt: any` in sendMessage
- `queryOptions: Record<string, any>`
- `images?: any[]`
- All ClaudeAgentBackend helper methods return `as any`

**Action: Amend Plan** — Replace all `any` with actual types from `types.ts` / `opencode-client.ts`.

### CT-3: Import Path Errors (Tasks 3, 9)

- `Logger` imported from `"../logging.js"` — correct path is `"../logger.js"`
- `ServiceRegistry` imported from `"../relay/service-registry.js"` — correct path is `"../daemon/service-registry.js"`

**Action: Amend Plan** — Fix import paths in Tasks 3 and 9 code blocks.

### CT-4: `undefined as any` in Iterators (Tasks 2, 7)

D6 mandates `value: undefined, done: true as const` but code blocks still have `undefined as any` in:
- AsyncEventChannel `close()`, `next()`, `return()`
- MessageQueue `end()`, `next()`, `return()`

**Action: Amend Plan** — Update all iterator return statements.

---

## Per-Task Findings

### Task 1: Define SessionBackend Interface (6 Amend, 2 Ask User)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | Imports from non-existent `relay-types.js` — must use `opencode-client.js` types |
| 2 | Amend | `BackendEvent` still generic `{ type: string; properties: Record<string, unknown> }` — amendment says use discriminated union from `types.ts` |
| 3 | Amend | `listPendingPermissions` missing `permission` field in return type |
| 4 | Amend | Structural test checks names only, not signatures — needs `Pick<>`-based assignability |
| 5 | Amend | No `sendMessage` <-> `sendMessageAsync` mapping verification in tests |
| 6 | Amend | Missing D1 Phase 1 verification step |
| 7 | Ask | Should `subscribeEvents` return `AsyncIterable` or `AsyncIterableIterator`? |
| 8 | Ask | Should `InfraClient` structural test also use signature checking? |

### Task 2: AsyncEventChannel + Deferred (4 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | `undefined as any` not replaced in code — 3 occurrences in Step 3 |
| 2 | Amend | Single-consumer guard missing from `next()` code |
| 3 | Amend | Two required tests missing: double-consume detection, push-then-close interleaving |
| 4 | Amend | Test uses `iter.return!(undefined as any)` — unnecessary cast |

### Task 3: OpenCodeBackend (6 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | `Logger` import path wrong (`../logging.js` -> `../logger.js`) |
| 2 | Amend | `ServiceRegistry` import path wrong (`../relay/service-registry.js` -> `../daemon/service-registry.js`) |
| 3 | Amend | Dynamic `await import()` for SSEConsumer — must use static import |
| 4 | Amend | 12 delegation methods use `any` parameters |
| 5 | Amend | Missing D1 Phase 1 verification step |
| 6 | Amend | Dead `InfraClient` import (imported but never used) |

### Tasks 4-5: Handler Split + Relay Stack (7 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | `monitoring-wiring.ts:128` interior `client.getMessages()` not listed in modification targets |
| 2 | Amend | `client satisfies InfraClient` won't work — use direct assignment `const infraClient: InfraClient = client;` |
| 3 | Amend | Startup sequence constraint: backend constructed but not initialized before SessionManager |
| 4 | Amend | Mock factory has phantom `switchModel` method |
| 5 | Amend | `session-lifecycle-wiring.ts:68` and `relay-stack.ts:355-356` lambda call sites not listed |
| 6 | Amend | `pty-upstream.ts` uses narrow structural type — keep narrow, don't widen to full InfraClient |
| 7 | Amend | 147+ test references to `deps.client.xxx` need mechanical update including rename |

### Tasks 7-8: MessageQueue + Translator (12 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | `stream_event` -> `message.part.updated` is WRONG — must be `message.part.delta` |
| 2 | Amend | `result` -> `session.updated` is WRONG — explicitly skipped by EventTranslator. Must produce BOTH `session.status` + `message.updated` |
| 3 | Amend | `user` messages translated instead of dropped |
| 4 | Amend | `assistant` message lacks `cost`/`tokens`/`time` fields |
| 5 | Amend | `session.initialized` event type doesn't exist downstream |
| 6 | Amend | `Record<string, any>` instead of `SDKMessage` discriminated union |
| 7 | Amend | `...msg` spread in system non-init still present |
| 8 | Amend | Return type must change to `BackendEvent | BackendEvent[] | null` for dual-event result |
| 9 | Amend | `session.status` events need `sessionID` in properties |
| 10 | Amend | Concrete type definition needed for `system/init` relay message |
| 11 | Amend | SDK subtype strings need verification against actual SDK |
| 12 | Amend | MessageQueue still copy-paste of AsyncEventChannel — must wrap per D5 |

### Task 9: ClaudeAgentBackend Session Management (12 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | **Single `activeQuery` instead of `Map<string, QueryState>`** — D7 not applied |
| 2 | Amend | **`subscribeEvents` closes shared channel** — permanently kills events |
| 3 | Amend | `activeQuery` typed as `any` |
| 4 | Amend | Logger import path wrong |
| 5 | Amend | Missing 7 method stubs — class won't compile |
| 6 | Amend | Types imported from nonexistent `relay-types.js` |
| 7 | Amend | 10+ `as any` casts |
| 8 | Amend | `getSessionInfo` called without `{ dir: this.cwd }` |
| 9 | Amend | `toSessionDetail` uses wrong SDK field names |
| 10 | Amend | `toMessage` uses `sessionId` instead of `sessionID` |
| 11 | Amend | `toMessage` doesn't filter non-conversation types |
| 12 | Amend | `getMessagesPage` fetches all then slices instead of native pagination |

### Task 10: Messaging + Event Streaming (14 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | Single `activeQuery` instead of per-session `Map` |
| 2 | Amend | `PromptOptions.images` is `string[]` (data URLs) but code treats as `{ mediaType, data }` |
| 3 | Amend | Shared channel closure bug |
| 4 | Amend | No try/catch around `sdkQuery()` |
| 5 | Amend | No pending deferred cleanup in `finally` |
| 6 | Amend | `abortSession` ignores session ID |
| 7 | Amend | `prompt: any` parameter violates D2 |
| 8 | Amend | Dynamic `import()` violates D3 |
| 9 | Amend | `buildUserMessage` ternary still present |
| 10 | Amend | `systemPrompt` still in options |
| 11 | Amend | No empty-message guard |
| 12 | Amend | No lifecycle events |
| 13 | Amend | `handleCanUseTool` not stubbed |
| 14 | Amend | Zero test coverage of event pipeline, multi-turn, materialization |

### Task 11: Permission + Question Bridging (8 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | **Decision vocabulary mismatch**: `replyPermission` checks `=== "deny"` but handler sends `"reject"` — permissions silently auto-approved |
| 2 | Amend | **Question ID keying**: random UUID vs `toolUseId` — questions hang forever |
| 3 | Amend | **Non-existent event types**: `permission.created`/`question.created` not handled downstream |
| 4 | Amend | Answer format mismatch: `Record<string,string>` vs handler's `string[][]` |
| 5 | Amend | Abort signal should resolve with `{ behavior: "deny" }` not reject |
| 6 | Amend | `handleAskUserQuestion` try/catch converts shutdown to deny instead of explicit reject |
| 7 | Amend | Missing concurrent permissions test |
| 8 | Amend | All parameter types are `any` |

### Task 12: Phase 3 Integration (3 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | **Factory function NOT removed** — conflicts with Task 14's BackendProxy |
| 2 | Amend | `ProjectRelayConfig` fields never added — no step in task body |
| 3 | Amend | Integration test bypasses barrel, imports directly |

### Task 13: BackendProxy (9 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | Constructor doesn't return proxy — `new BackendProxy(oc)` is raw instance |
| 2 | Amend | Dead convenience getters still present |
| 3 | Amend | Hardcoded string list instead of prototype-based detection |
| 4 | Amend | `swap()` is synchronous but handlers should be async |
| 5 | Amend | No concurrent-swap guard (re-entrancy protection) |
| 6 | Amend | `subscribeEvents` re-subscription after swap not specified |
| 7 | Amend | `onSwap` returns void instead of cleanup function |
| 8 | Amend | Prototype-based detection would leak `constructor` — use explicit Set |
| 9 | Amend | Missing `this`-binding test through Proxy |

### Task 14: Backend Switching (6 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | `backend_switched` not in `RelayMessage` union type |
| 2 | Amend | `HandlerDeps` missing `backendProxy` and `backendRegistry` |
| 3 | Amend | `authType` detection unspecified and unreliable |
| 4 | Amend | **`shutdown()` makes backends non-reusable** — swapping back is broken |
| 5 | Amend | Swap-during-active-query race — proxy target updates before handlers complete |
| 6 | Amend | `maybeSwapBackend()` helper never defined |

### Task 15: Frontend (11 Amend)

| # | Action | Finding |
|---|--------|---------|
| 1 | Amend | Wrong directory paths (`src/lib/frontend/src/stores/` -> `src/lib/frontend/stores/`) |
| 2 | Amend | `backend_switched` not in `RelayMessage` union |
| 3 | Amend | `backendType` not in `SessionInfo` type |
| 4 | Amend | No dispatch case in ws-dispatch.ts |
| 5 | Amend | Svelte 4 `writable` store instead of Svelte 5 `$state` |
| 6 | Amend | Raw `ws.send()` instead of `wsSend()` |
| 7 | Amend | Svelte 4 `on:click` instead of Svelte 5 `onclick` |
| 8 | Amend | Backend type string comparison instead of capabilities object |
| 9 | Amend | Fork/revert UI touchpoints not enumerated |
| 10 | Amend | No tests for backend_switched handler |
| 11 | Amend | Capabilities field not added to session_list response |

---

## Ask User (2 findings — RESOLVED)

| # | Task | Question | Decision |
|---|------|----------|----------|
| 1 | T1 | Should `subscribeEvents` return `AsyncIterable<BackendEvent>` or `AsyncIterableIterator<BackendEvent>`? | **`AsyncIterable`** — more flexible, callers only need for-await-of |
| 2 | T1 | Should `InfraClient` structural test also use Pick-based signature checking? | **Name-only** — direct assignment `const infraClient: InfraClient = client` catches mismatches at compile time |

---

## Verdict

**~120 Amend Plan findings, 2 Ask User, ~38 Accept.**

The overwhelming majority of Amend Plan findings are the same root cause: **code blocks were never updated after the v2 audit**. The amendments exist as prose but the executable code is stale.

Handing off to plan-audit-fixer to resolve.

---

## Amendments Applied (v3 fixer pass)

All ~120 Amend Plan findings resolved by inlining amendments into code blocks. 5 parallel subagents applied fixes:

| Subagent | Tasks | Key Changes |
|----------|-------|-------------|
| A | 1-3 | Phase 1 gating, BackendEvent re-export, Pick-based tests, import paths, typed delegation |
| B | 4-5 | Complete file list, mock factory cleanup, InfraClient direct assignment, startup sequence notes |
| C | 7-8 | MessageQueue wraps AsyncEventChannel, full translator rewrite (delta/status/error events) |
| D | 9-11 | Per-session Map<QueryState>, subscribeEvents non-closure, decision vocabulary, event types |
| E | 12-15 | Factory removed, BackendProxy constructor return, async swap, frontend Svelte 5 patterns |

### Ask User Decisions Applied
1. `subscribeEvents` returns `AsyncIterable<BackendEvent>` (confirmed)
2. InfraClient uses name-only structural test (confirmed)

**Status:** Amended plan ready for re-audit.

---

## Re-Audit Pass 2 (13 auditors dispatched)

All ~120 original Amend Plan findings confirmed resolved. **12 new Amend Plan + 3 Ask User found:**

### New Amend Plan (all resolved in fix pass 2)

| # | Task | Fix Applied |
|---|------|-------------|
| 1 | T1-3 | Test files moved from `src/lib/backend/` to `test/unit/backend/` (vitest config match) |
| 2 | T3 | `RelayClient` from `sdk-client.js` → `OpenCodeClient` from `opencode-client.js` |
| 3 | T3 | Conditional spread for `exactOptionalPropertyTypes` compliance |
| 4 | T7-8 | `"tool-use"` → `"tool"` in translator (matches EventTranslator guard) |
| 5 | T7-8 | Added `role: "assistant"` to result `message.updated` |
| 6 | T7-8 | Added thinking block start (`type: "reasoning"`) before thinking deltas |
| 7 | T10 | `channel.push()` now handles `BackendEvent[]` from translator |
| 8 | T10 | processQueryStream finally block: deferred cleanup (resolve, not reject) |
| 9 | T10 | Error-path events changed from `session.updated` to `session.error` |
| 10 | T13 | Declaration merging: `export interface BackendProxy extends SessionBackend {}` |
| 11 | T13 | Removed `getProxy()`, fixed this-binding test |
| 12 | T15 | `get_sessions` → `list_sessions`, fixed store refs, component paths |

### Ask User Decisions (all resolved)

| # | Decision |
|---|----------|
| 1 | Re-send race: non-issue — JS single-threaded event loop prevents interleaving. Queue pushes into active query. |
| 2 | Error events: use `session.error` with structured `{ name, data: { message } }` format |
| 3 | `getProxy()`: removed. Declaration merging provides type narrowing instead. |

**Status:** All findings resolved. Plan is clean (audit-fix loop pass 2 complete).
