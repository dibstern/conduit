# Sidebar Session Indicators & Notification Refinements

Date: 2026-03-26

## Changes

### 1. Frontend Subagent Done Suppression

Suppress all frontend notification channels for subagent done events:

In `ws-dispatch.ts` `notification_event` handler, before `triggerNotifications()` and `showToast()`:
```typescript
const isSubagentEvent = msg.sessionId && findSession(msg.sessionId)?.parentID;
```
If `isSubagentEvent && msg.eventType === "done"`: skip `triggerNotifications()` and `showToast()`.

Push notifications are already suppressed server-side by `notification-policy.ts`.

### 2. Multi-Question Ref-Counting

Change `remoteQuestionSessions: Set<string>` to `remoteQuestionCounts: Map<string, number>`.

- `addRemoteQuestion(sessionId)`: increment (or set to 1)
- `removeRemoteQuestion(sessionId)`: decrement, delete at 0
- `getRemoteQuestionSessions()`: return session IDs where count > 0
- `getRemoteQuestionCount(sessionId)`: return count for AttentionBanner

### 3. Done-Not-Viewed Tracking

New state: `doneNotViewedSessions: Set<string>` in permissions store.

- Add: `handleNotificationEvent` with `eventType === "done"` and `sessionId` present
- Remove: `onSessionSwitch` clears target session
- Clear: on disconnect/project switch

### 4. Sidebar Indicator Dots

`SessionItem.svelte` shows one of:

| State | Dot Style |
|-------|-----------|
| Processing | Pulsing pink `bg-brand-a animate-pulse-dot` (existing) |
| Needs attention | Solid cyan `bg-brand-b` |
| Done, not viewed | Ring cyan `border-[1.5px] border-brand-b` |
| Idle / viewed | No dot |

New getter: `getSessionIndicator(sessionId): "attention" | "done-unviewed" | null`
- "attention": session in `remoteQuestionCounts` (count > 0) or `remotePermissions`
- "done-unviewed": session in `doneNotViewedSessions`

Dot clears immediately on navigate (via `onSessionSwitch`).
