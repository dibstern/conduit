# Claude Subagent Live Child Streaming Design

## Goal

Make a Claude subagent child session appear as soon as Claude reports `task_started`, then keep that child session's transcript live while the parent turn is still running.

## Current Shape

The current materialization flow is snapshot-only. `ClaudeProviderInstance.runStreamConsumer()` translates the parent Claude SDK stream live, but only calls `materializeSubagentsAfterResult()` after the parent SDK emits `message.type === "result"`. The materializer then calls `listSubagents()` and `getSubagentMessages()` and imports the child transcript as a batch.

That is durable, but it means a Task card cannot navigate to a useful live child view during execution.

## Chosen Approach

Create child sessions immediately on `task_started`, then poll Claude's subagent snapshot APIs while the task is active.

When a task starts:

1. Compute the deterministic `claude-subagent-*` child session ID from `{ parentConduitSessionId, parentClaudeSessionId, sdkSubagentId }`.
2. Ensure the child session exists in SQLite with `parent_id` and `provider_sid`.
3. Emit parent `tool.running` metadata containing `childSessionId`, so the Task card can navigate immediately.
4. Start a per-task poller that calls `getSubagentMessages(parentClaudeSessionId, sdkSubagentId, { dir })`.

The UX is intentionally immediate. If this feels noisy, the implementation should leave a comment at the early creation point noting the alternative: delay child-session creation until the first `getSubagentMessages()` poll returns content.

## Data Flow

The poller treats `getSubagentMessages()` as a snapshot source, not a stream. It keeps an in-memory cursor per child session:

- seen message UUIDs
- emitted text length by `{ messageUuid, blockIndex }`
- seen tool starts/completions by tool-use ID

Each poll converts only new material into canonical child-session events. Those events are persisted and pushed to WebSocket clients tagged with the child session ID.

The parent turn still owns finalization. When the parent emits `result`, conduit runs one final poll for each active subagent, stops the pollers, and then may run the existing final materialization/discovery path for unmatched subagents.

## Relay Delivery Requirement

The current `createRelayEventSink()` tags translated messages with the sink's fixed `sessionId`. That works for parent events but is wrong for child events pushed from a parent provider instance. Live child streaming needs relay delivery tagged from `event.sessionId`, with the fixed sink session retained for permission/question request ownership.

## Persistence Requirement

The event store has a foreign key from `events.session_id` to `sessions.id`, so the child session row must exist before child transcript events are appended. Add an explicit persistence operation for ensuring a Claude subagent session once, rather than appending duplicate `session.created` events on every poll.

## Error Handling

Polling failures should not fail the parent turn. Transient errors back off and retry. Final poll failures are logged and do not block parent turn completion. If a child session was created but polling never returns content, the empty child session remains navigable for now.

## Testing

Primary tests should prove behavior without a real Claude install:

- `task_started` creates a child session and parent metadata before parent `result`.
- relay sink pushes child events using `event.sessionId`.
- repeated snapshots emit only new child transcript deltas.
- final poll stops active pollers and preserves the post-result catch-up behavior.
- frontend Task card can navigate from `metadata.childSessionId`.
