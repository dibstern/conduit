# Claude Subagent Live Child Streaming Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude subagent child sessions appear immediately on `task_started` and stream new material into the child view while the parent turn is still running.

**Architecture:** Keep Claude SDK subagents as conduit-owned child sessions. Add an early session-ensure path for `task_started`, a snapshot-diff poller around `getSubagentMessages()`, and relay delivery that tags child events by `event.sessionId` instead of the parent sink session.

**Tech Stack:** TypeScript, Effect, `@anthropic-ai/claude-agent-sdk`, SQLite event store/projectors, WebSocket relay messages, Vitest.

---

## Task 1: Lock Live Child-Session Requirements With Failing Tests

**Files:**
- Modify: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`
- Modify: `test/unit/provider/relay-event-sink.test.ts`
- Modify: `test/unit/provider/claude/claude-subagent-materializer.test.ts`
- Modify: `test/unit/pipeline/claude-subagent-materialization.test.ts`

**Step 1: Add early child metadata test**

In `claude-provider-instance-send-turn.test.ts`, add a test whose mock SDK stream emits:

1. `message_start`
2. Task `content_block_start`
3. Task `content_block_stop`
4. `system/task_started`

Do not emit `result` until after the assertion point. Assert the parent sink receives a `tool_update`/equivalent translated event for the Task part with `metadata.childSessionId`.

Expected before implementation: no child metadata until `result`.

**Step 2: Add relay child-session tagging test**

In `relay-event-sink.test.ts`, create a sink with `sessionId: "parent"`, then push a canonical `text.delta` event whose `sessionId` is `"child"`. Assert the outbound relay message is tagged with `"child"`.

Expected before implementation: outbound message is tagged with `"parent"`.

**Step 3: Add snapshot diff test**

In `claude-subagent-materializer.test.ts`, add a cursor/diff test:

1. First snapshot has assistant text `"Auth"`.
2. Second snapshot has same assistant UUID and text `"Auth is fine"`.
3. Assert the second diff emits only `" is fine"` as a `text.delta`.

Expected before implementation: no diff API exists, or duplicate full text is emitted.

**Step 4: Add pipeline live-poll test**

In `claude-subagent-materialization.test.ts`, use a fake `getSubagentMessages()` that returns an empty transcript first, then a user/assistant transcript before parent `result`. Assert:

- child session row exists immediately after `task_started`
- parent Task metadata contains `childSessionId`
- child history receives the later transcript without waiting for final materialization

Expected before implementation: child row/transcript only appears after `result`.

**Step 5: Run RED tests**

```bash
pnpm vitest run \
  test/unit/provider/claude/claude-provider-instance-send-turn.test.ts \
  test/unit/provider/relay-event-sink.test.ts \
  test/unit/provider/claude/claude-subagent-materializer.test.ts \
  test/unit/pipeline/claude-subagent-materialization.test.ts
```

Expected: new tests fail for early creation, child-session tagging, and snapshot diffing.

**Step 6: Commit**

```bash
git add test/unit/provider/claude test/unit/provider/relay-event-sink.test.ts test/unit/pipeline/claude-subagent-materialization.test.ts
git commit -m "test(claude): lock live subagent streaming gaps"
```

---

## Task 2: Tag Relay Pushes By Canonical Event Session

**Files:**
- Modify: `src/lib/provider/relay-event-sink.ts`
- Test: `test/unit/provider/relay-event-sink.test.ts`

**Step 1: Update push tagging**

In `createRelayEventSink().push()`, keep `deps.sessionId` for permission/question ownership, but tag translated canonical-event messages with `event.sessionId`:

```ts
const m = tagWithSessionId(raw, event.sessionId || sessionId);
```

Do not change `requestPermission()` or `requestQuestion()` routing.

**Step 2: Run relay sink tests**

```bash
pnpm vitest run test/unit/provider/relay-event-sink.test.ts
```

Expected: child-session tagging test passes and existing parent-session cases remain green.

**Step 3: Commit**

```bash
git add src/lib/provider/relay-event-sink.ts test/unit/provider/relay-event-sink.test.ts
git commit -m "fix(relay): tag canonical events by event session"
```

---

## Task 3: Add Claude Subagent Session Ensure API

**Files:**
- Modify: `src/lib/persistence/effect/claude-event-persist-effect.ts`
- Test: `test/unit/provider/claude/claude-subagent-materializer.test.ts`
- Test: `test/unit/pipeline/claude-subagent-materialization.test.ts`

**Step 1: Extend persistence service**

Add:

```ts
readonly ensureClaudeSubagentSession: (input: {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly providerSessionId: string;
  readonly title: string;
}) => Effect.Effect<void, unknown>;
```

Implementation:

1. `ensureRecovered()`
2. `ensureSession(parentSessionId, "claude")`
3. Check whether `sessions.id = childSessionId` exists.
4. `ensureSession(childSessionId, "claude", { parentId, providerSessionId })`
5. Append/project one `session.created` only when the child session did not already exist.

**Step 2: Reuse from batch materialization**

Change `persistClaudeSubagent()` to call `ensureClaudeSubagentSession()` first, then append only transcript events. Avoid appending duplicate child `session.created` events on every poll/finalization.

**Step 3: Run persistence-focused tests**

```bash
pnpm vitest run \
  test/unit/provider/claude/claude-subagent-materializer.test.ts \
  test/unit/pipeline/claude-subagent-materialization.test.ts
```

Expected: session creation remains idempotent.

**Step 4: Commit**

```bash
git add src/lib/persistence/effect/claude-event-persist-effect.ts test/unit/provider/claude/claude-subagent-materializer.test.ts test/unit/pipeline/claude-subagent-materialization.test.ts
git commit -m "fix(persistence): ensure claude subagent sessions once"
```

---

## Task 4: Add Snapshot Diffing For Subagent Transcripts

**Files:**
- Modify: `src/lib/provider/claude/claude-subagent-materializer.ts`
- Test: `test/unit/provider/claude/claude-subagent-materializer.test.ts`

**Step 1: Define cursor type**

Add:

```ts
export interface ClaudeSubagentTranscriptCursor {
  readonly messageRoles: Map<string, "user" | "assistant">;
  readonly textOffsets: Map<string, number>;
  readonly toolStarts: Set<string>;
  readonly toolCompletions: Set<string>;
}
```

Use a mutable implementation internally if that keeps the diff code simple.

**Step 2: Add diff function**

Export:

```ts
export function diffSessionMessagesToEvents(input: {
  readonly childSessionId: string;
  readonly messages: readonly SessionMessage[];
  readonly cursor: ClaudeSubagentTranscriptCursor;
}): CanonicalEvent[];
```

For text blocks, key offsets by `${message.uuid}:${blockIndex}` and emit only the suffix not yet emitted. For new messages, emit `message.created` before part events.

**Step 3: Keep full import behavior**

Make the existing full materialization path use the same diff function with a fresh cursor.

**Step 4: Run materializer tests**

```bash
pnpm vitest run test/unit/provider/claude/claude-subagent-materializer.test.ts
```

Expected: duplicate snapshots do not duplicate transcript text.

**Step 5: Commit**

```bash
git add src/lib/provider/claude/claude-subagent-materializer.ts test/unit/provider/claude/claude-subagent-materializer.test.ts
git commit -m "feat(claude): diff subagent transcript snapshots"
```

---

## Task 5: Start Live Pollers On `task_started`

**Files:**
- Modify: `src/lib/provider/claude/types.ts`
- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Test: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`

**Step 1: Track parent Task message IDs**

Extend `ClaudeSessionContext.subagentTasks` values to include:

```ts
readonly parentMessageId?: string;
```

In `ClaudeEventTranslator.pushTaskMetadata()`, when a task is associated with a tool part, store the current assistant message ID as `parentMessageId`.

**Step 2: Add provider poller state**

In `ClaudeSessionContext`, add:

```ts
readonly subagentPollers?: Map<string, ClaudeSubagentLivePoller>;
```

The key should be the SDK subagent/task ID.

**Step 3: Detect task starts after translation**

In `runStreamConsumer()`, after `await translator.translate(ctx, message)`, check for `system/task_started` with `task_id` and `tool_use_id`. Call a new helper:

```ts
await this.startSubagentPollingFromTaskStarted(ctx, message, runEffect);
```

**Step 4: Ensure child session immediately**

In the helper:

1. Resolve `parentClaudeSessionId` from `ctx.resumeSessionId ?? message.session_id`.
2. Compute `childSessionId`.
3. Call `ensureClaudeSubagentSession`.
4. Leave this comment near the ensure call:

```ts
// UX alternative: delay creating the child session until the first getSubagentMessages() poll returns content.
```

**Step 5: Emit parent metadata immediately**

Push parent `tool.running` with:

```ts
metadata: {
  childSessionId,
  sdkSubagentId: message.task_id,
  providerTaskId: message.task_id,
}
```

Use the tracked `parentMessageId` when available and `message.tool_use_id` as `partId`.

**Step 6: Start polling**

Start a per-subagent poll loop:

- first poll immediately
- subsequent polls every 500ms while active
- back off to 1000ms after transient failures
- push child canonical events through `ctx.eventSink.push(event)`, relying on Task 2 tagging

**Step 7: Stop on final result**

When parent `result` arrives, final-poll all active subagents, stop their timers, then resolve the parent turn.

**Step 8: Run provider tests**

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
```

Expected: early metadata and live child polling tests pass.

**Step 9: Commit**

```bash
git add src/lib/provider/claude test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
git commit -m "feat(claude): stream live subagent child sessions"
```

---

## Task 6: Keep Final Materialization As Catch-Up

**Files:**
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify: `src/lib/provider/claude/claude-subagent-materializer.ts`
- Test: `test/unit/pipeline/claude-subagent-materialization.test.ts`

**Step 1: Preserve unmatched discovery**

After final polling active tasks, keep a final `listSubagents()` pass so SDK-discovered subagents that never mapped to a parent Task still materialize as child sessions.

**Step 2: Avoid duplicate child events**

Use either the live cursor or DB-backed existing-message filtering so final catch-up does not duplicate live-polled events.

**Step 3: Run pipeline test**

```bash
pnpm vitest run test/unit/pipeline/claude-subagent-materialization.test.ts
```

Expected: live transcript appears before result, and final materialization remains idempotent.

**Step 4: Commit**

```bash
git add src/lib/provider/claude test/unit/pipeline/claude-subagent-materialization.test.ts
git commit -m "fix(claude): keep subagent final catch-up idempotent"
```

---

## Task 7: Final Verification

**Files:**
- No code changes unless verification exposes a defect.

**Step 1: Run focused suite**

```bash
pnpm vitest run \
  test/unit/provider/claude \
  test/unit/provider/relay-event-sink.test.ts \
  test/unit/persistence/projectors/message-projector.test.ts \
  test/unit/persistence/projectors/session-projector.test.ts \
  test/unit/frontend/history-to-chat-messages.test.ts \
  test/unit/components/tool-subagent-card.test.ts \
  test/unit/pipeline/claude-subagent-materialization.test.ts
```

**Step 2: Run standard checks**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 3: Escalate only if needed**

If WebSocket replay fixtures or browser session-switch behavior change, run the narrowest relevant replay E2E command from `docs/agent-guide/testing.md`.

**Step 4: Commit fixes if needed**

```bash
git add <changed files>
git commit -m "fix(claude): harden live subagent streaming"
```
