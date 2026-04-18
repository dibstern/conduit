# Pipeline Resilience Tests — Design

**Goal:** Close test coverage gaps in the Claude SDK event pipeline to catch regressions as features like rewind/fork are added, and to specify the fix for the session rejoin bug (streaming dies after navigate-away-and-back).

**Stack:** Vitest, existing test helpers (`createTestHarness`, `mock-factories`, `mock-sdk`)

---

## Root Problem

Individual pipeline layers have strong unit tests. But no test wires them end-to-end, and the seams between layers are where bugs hide (the `thinking.end` bug lived between translator and relay-event-sink). The session rejoin bug lives between the WebSocket session mapping, history replay, and live event delivery.

**Known Bug:** During an active Claude SDK turn, navigating to a different session and returning causes live streaming to stop. History from while the user was away appears correctly (SQLite persistence works), but new events from the ongoing turn no longer reach the client. The bug also affects permission approval after rejoin — approving a permission that was replayed on return doesn't resume streaming.

---

## Test Files

### 1. `test/unit/pipeline/thinking-lifecycle-pipeline.test.ts`

**Status:** Tests that PASS today — regression protection.

Wires real instances: `ClaudeEventTranslator → EventStore → MessageProjector → SQLite → ReadQueryService → historyToChatMessages`.

| # | Scenario | Assert |
|---|----------|--------|
| 1 | Happy path: full thinking stream (start→delta→end) + text + result | ThinkingMessage has `done=true`, correct text, before TextMessage |
| 2 | Reload: persist thinking lifecycle, read back from SQLite | Thinking block survives round-trip with correct text |
| 3 | Safety net: stream without thinking.end, fire handleDone | Frontend marks done=true; SQLite has partial state (documents divergence) |

**Setup:** Uses `createTestHarness()` for in-memory SQLite, `makeStored()` for events, real `MessageProjector` and `ReadQueryService` instances.

### 2. `test/unit/pipeline/claude-session-rejoin.test.ts`

**Status:** Tests that FAIL today — specification for the rejoin fix.

Tests the navigate-away-and-back flow for Claude SDK sessions.

| # | Scenario | Assert |
|---|----------|--------|
| 1 | Basic rejoin: streaming → navigate away → return | New events arrive after rejoin |
| 2 | Rejoin during thinking: active thinking.delta → away → back | Thinking block completes normally after return |
| 3 | Rejoin during tool: tool started → away → tool completes → back | Tool result in history, next turn streams |
| 4 | Rejoin with pending permission: permission asked → away → back → approve | Streaming resumes after approval post-rejoin |
| 5 | Rejoin after PROCESSING_TIMEOUT (>120s): away too long → timeout → back | Clear error state, no stuck spinner |
| 6 | Replay/live coordination: rejoin triggers history replay, live events arrive during replay | No events dropped, no duplicates |

**Setup:** Requires wiring `wsHandler` session mapping, `switchClientToSession()`, `RelayEventSink.send()`, and `ClaudeEventTranslator`. May use mock WebSocket clients or spy on `wsHandler.sendToSession`.

**Key architectural question for implementer:** Is the bug in the server (events not sent to re-mapped client), the frontend (events received but dropped during replay), or both? Tests should isolate the layer.

### 3. `test/unit/pipeline/thinking-invariants.test.ts`

**Status:** Tests that PASS today — future-proofing for rewind/fork.

Property-based invariants that any future feature must preserve.

| # | Invariant | Verified by |
|---|-----------|-------------|
| 1 | Every ThinkingMessage in rendered state has `done=true` after handleDone | Generate random thinking block states, call handleDone, check |
| 2 | Persisted thinking text matches chat state text after reload | Persist → read → convert → compare |
| 3 | Fork-split never orphans thinking from parent message | splitAtForkPoint with thinking blocks at boundaries |
| 4 | No orphaned thinking.start without thinking.end in projector | Project partial sequences, query SQLite for consistency |

---

## Dependencies

- **File 1:** No new infrastructure. Uses existing `createTestHarness`, `MessageProjector`, `ReadQueryService`, `historyToChatMessages`.
- **File 2:** May need a new test helper for simulating session switches with active Claude streaming. Could extend `RelayHarness` or build lighter mock.
- **File 3:** No new infrastructure. Uses existing chat store functions, `splitAtForkPoint`, projector.

## Execution Order

1. File 1 first (standalone, no dependencies)
2. File 3 next (standalone, no dependencies)
3. File 2 last (most complex, may reveal need for helper infrastructure, failing tests document the bug spec)
