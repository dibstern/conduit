# Notification State Unification

Date: 2026-03-26

## Problem

Three bugs in the notification system share two structural root causes:

1. **Subagent completion triggers in-app toasts** — The `getSessionParentMap()` cache can be stale when a fast subagent completes before the parent map is rebuilt from `listSessions()`. This causes `isSubagent` to be false, so `notification_event` with `eventType: "done"` is broadcast, and the frontend shows a "Task Complete" toast.

2. **Stale question notifications persist after answering** — When a question is answered through the browser handler (`permissions.ts`), `ask_user_resolved` is broadcast as a plain message. This cleans up `pendingQuestions` on all clients but NOT `remoteQuestionSessions` (the Set driving the AttentionBanner). The `notification_event` with `ask_user_resolved` — the only path that calls `removeRemoteQuestion()` — never fires because OpenCode has no `question.resolved` SSE event.

3. **Cross-session banners persist after responding and switching** — Same root cause as #2. The `remoteQuestionSessions` Set accumulates stale session IDs permanently until disconnect or project switch.

## Structural Weaknesses

- Two disjoint representations of question state (`pendingQuestions[]` by toolId vs `remoteQuestionSessions` by sessionId) with no reconciliation.
- `ask_user_resolved` messages don't carry `sessionId`, so handlers can't clean up session-keyed state.
- Subagent detection depends on a mutable async cache with race conditions.
- State mutations are split between `permissions.svelte.ts` and `ws-dispatch.ts`.

## Design

### Frontend: Unified Notification State

Consolidate all notification state transitions into `permissions.svelte.ts`:

1. **Add `sessionId` to `QuestionRequest`** so we know which session to clean up on resolution.

2. **`handleAskUserResolved(msg)` cleans up both collections** — removes from `pendingQuestions` AND `remoteQuestionSessions`.

3. **New `handleNotificationEvent(msg)`** — single entry point for `notification_event` state effects. Replaces scattered `addRemoteQuestion`/`removeRemoteQuestion` calls in `ws-dispatch.ts`.

4. **New `onSessionSwitch(previousSessionId, newSessionId)`** — consolidates `clearSessionLocal` + `removeRemoteQuestion` into a single method.

5. **`ws-dispatch.ts` becomes a thin router** — delegates all state changes to `permissions.svelte.ts`, handles only non-state side effects (triggerNotifications, showToast).

### Server: Subagent Detection Race Fix

1. **Add `addToParentMap(childId, parentId)` to `SessionManager`** — synchronous eager update.

2. **Eagerly update parent map in SSE handler** on `session.updated` events — extract `info.id` and `info.parentID` and update the map before the async `listSessions()` call.

### Wire format: `ask_user_resolved` gets `sessionId`

1. **Update `shared-types.ts`** — add optional `sessionId` to `ask_user_resolved`.
2. **Update `handlers/permissions.ts`** — include `sessionId` in broadcast.

## Files Changed

| File | Change |
|------|--------|
| `permissions.svelte.ts` | Unify state management, new methods |
| `ws-dispatch.ts` | Thin router, delegate state to store |
| `shared-types.ts` | Add `sessionId` to `ask_user_resolved` |
| `handlers/permissions.ts` | Include `sessionId` in broadcast |
| `session-manager.ts` | New `addToParentMap()` |
| `sse-wiring.ts` | Eager parent map update |
| Frontend types | Add `sessionId` to `QuestionRequest` |
| Tests | Update + add for new methods |
