# Follow-Up Message Queue

Send follow-up messages while Claude is processing, on both desktop and mobile, without stopping the session.

## Problem

The send button is replaced by a stop button during processing. The textarea's `sendMessage()` early-returns when `isProcessing` is true. Users must wait for completion or abort before sending another message.

## Approach

Client-side FIFO queue with auto-drain. No server changes. The queue lives in the frontend chat store, mirrored to localStorage for crash recovery.

### Why client-side, not server-side or API passthrough

- **Server-side queue** contradicts the relay's stateless architecture and adds failure modes (server restart loses queue).
- **API passthrough** (removing the `isProcessing` guard and relying on OpenCode's internal queuing) has subtle behavior: queued messages are written to the DB but may not get their own LLM turn. The relay would be coupling to undocumented internal behavior.
- **Client-side queue** gives full control over timing, clean UX, and respects the stateless relay design.

## Input Area UI

### Idle state (unchanged)

`[textarea] [Send●]` — solid near-black circle (`bg-accent text-white`), arrow-up icon.

### Processing state (new)

`[textarea] [Send●] [Stop○]`

- **Send** (queue follow-up): Solid near-black circle, arrow-up icon. Same styling as idle. Enabled when textarea has content, disabled (`opacity-25`) when empty. Queues the message.
- **Stop**: Ghost/outline circle — `bg-transparent border border-border text-text-muted`, square icon. Hover: `bg-black/[0.04] text-text`. Follows the existing ghost button pattern (attach button, header icons).

Visual hierarchy: Send is primary (filled), Stop is secondary (ghost). Queuing a follow-up is the expected action; stopping is the escape hatch. Both monochrome — no color accents.

On mobile, both are `w-9 h-9` circles side by side.

## Queued Messages Display

Queued messages appear as pending user bubbles in the chat:

- Same layout as regular user bubbles (`bg-user-bubble`, right-aligned)
- Reduced opacity (`opacity-50`) with dashed border (`border border-dashed border-border`)
- X button to cancel individual messages (always visible on mobile, hover on desktop)
- `"queued"` label in `text-text-muted text-xs` below the bubble
- Appear at the bottom of the message list, after the streaming assistant response

When a queued message is sent (auto-drain), its bubble transitions to normal user bubble style (opacity 1, no dashed border).

## Queue Behavior

### Sending a follow-up while processing

1. User types and hits Enter or clicks Send
2. Message added to `queuedMessages` map in chat store, keyed by session ID
3. Pending bubble appears in chat
4. Textarea clears for the next message
5. User can queue as many as they want (FIFO)

### Auto-drain on completion

1. `done` event arrives → `processing = false`
2. Check `queuedMessages.get(activeSessionId)`
3. If queue has items: dequeue first, send via `wsSend({ type: "message", text })`, bubble transitions to normal style
4. Processing resumes, repeat until queue is empty
5. If queue is empty: normal idle state

### Interrupt and send

1. User queues a follow-up
2. User clicks Stop → aborts current response
3. `done` (code: 1) arrives → auto-drain kicks in
4. Queued message sends immediately after abort

### Cancelling queued messages

Click X on a pending bubble to remove it. If all cancelled, nothing happens on next `done`.

## Queue Persistence

### Per-session storage

`queuedMessages` is a `Map<sessionId, QueuedMessage[]>`. Switching sessions preserves the queue for the old session. Switching back restores it.

### localStorage persistence

- Mirrored to `localStorage` key `opencode-relay:queued-messages` on every mutation
- Hydrated on page load, filtered to entries less than 1 week old
- Each entry: `{ id: string, sessionId: string, text: string, createdAt: number }`
- Crash recovery, not real-time cross-tab sync

### Session switch behavior

- Switching away: queue preserved in memory and localStorage
- Switching to a session with queued messages + idle state: immediate drain
- Switching to a session with queued messages + busy state: queue displays, drains on `done`

## Data Flow

```
User hits Enter while processing
  → chat store: queuedMessages.get(sessionId).push(msg)
  → localStorage: sync
  → UI: pending bubble rendered

done event arrives
  → check queuedMessages.get(activeSessionId)
  → dequeue first → sendMessage(text) → pending bubble → normal bubble
  → localStorage: sync

User clicks X on pending bubble
  → chat store: remove by id
  → localStorage: sync

Switch to session with queue + idle
  → trigger immediate drain

Page load
  → hydrate from localStorage (filter >1 week)
  → populate queuedMessages map
```

## Components Touched

| Component | Change |
|-----------|--------|
| `chat.svelte.ts` | Add `queuedMessages` map, drain logic, localStorage sync |
| `ws.svelte.ts` | `handleDone()` triggers drain check |
| `InputArea.svelte` | Show Send + Stop during processing, route Send to queue |
| `MessageList.svelte` | Render pending bubbles from queue |
| `QueuedMessage.svelte` (new) | Pending bubble with dashed border, X button, "queued" label |

No server-side changes.

## Testing

### Unit tests (chat store)

- Queue add/remove/drain operations
- Per-session isolation
- Auto-drain on `done` dequeues first message and triggers send
- Queue preserves across session switch, restores on switch-back
- Drain on switch-to-idle-session
- localStorage mirror: mutations sync, hydration restores, 1-week expiry
- Empty queue on `done` → no action
- Drain respects rate limiting

### Component tests (InputArea)

- Both Send and Stop visible during processing
- Send disabled when textarea empty during processing
- Send queues message during processing
- Send sends directly when not processing (unchanged)
- Stop sends cancel (unchanged)
- Enter key queues during processing

### Component tests (QueuedMessage)

- Renders with dimmed/dashed styling
- X button removes from queue
- "queued" label visible

### Integration/E2E tests

- Send → queue follow-up while streaming → first finishes → follow-up auto-sends → second streams
- Queue multiple → all drain in FIFO order
- Cancel queued message → removed, others drain
- Stop + auto-drain: stop current, queued sends immediately
