# Claude Subagent Materialization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Claude SDK subagent output visible as real conduit child sessions, with stable parent Task-card navigation and type-checked Claude-to-canonical field extraction.

**Architecture:** Keep the parent Claude turn flowing through `ClaudeProviderInstance` and `ClaudeEventTranslator`, but materialize Claude SDK subagent transcripts into conduit-owned SQLite sessions after Claude exposes them through `listSubagents()` and `getSubagentMessages()`. Parent Task tool parts get persisted metadata pointing at the materialized child session, so the existing subagent UI can navigate to a child session window instead of trying to inline a transcript in the parent tool card.

**Tech Stack:** TypeScript, Effect, `@anthropic-ai/claude-agent-sdk`, SQLite event store/projectors, Svelte 5, Vitest.

---

## Design Decisions

- Claude subagent output is represented as child sessions in conduit's event store, not inline parent-card output.
- Child session IDs are deterministic conduit IDs derived from `{ parentConduitSessionId, parentClaudeSessionId, sdkSubagentId }`, for example `claude-subagent-${sha256(...).slice(0, 24)}`.
- The parent Task tool stores `metadata.childSessionId` and `metadata.sdkSubagentId`; the UI should navigate using that metadata before falling back to old result-text parsing.
- Claude SDK transcript APIs are accessed through a narrow adapter seam so tests never need the real local Claude config.
- New schema and projector fields are optional and backwards-compatible.
- Do not assume `task_id === sdkSubagentId` until a test/fixture proves it. The materializer should first support direct match, then keep unmatched discovered subagents visible as child sessions without wiring them to a parent tool card.

---

## Task 1: Lock the Current Gaps With Failing Tests

**Files:**
- Modify: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`
- Modify: `test/unit/provider/claude/claude-event-translator.test.ts`
- Modify: `test/unit/frontend/history-to-chat-messages.test.ts`
- Modify: `test/unit/frontend/tool-subagent-card.test.ts` or create a colocated component test if no file exists

**Step 1: Add a sink-routing regression test**

In `claude-provider-instance-send-turn.test.ts`, add a test that sends two turns on one Claude query. Emit a visible SDK event, such as `stream_event/message_start + text_delta`, during turn 2 and assert it is pushed to `sinkB`, not `sinkA`.

Expected failure before implementation: `sinkB.push` has no translated turn-2 events.

**Step 2: Add a canonical Task input UI test**

In the frontend subagent card test, render a Task tool with:

```ts
input: {
  tool: "Task",
  description: "Audit Claude provider",
  prompt: "Find SDK mapping gaps",
  subagentType: "explore",
}
```

Assert the card title uses `explore Agent`.

Expected failure before implementation: it renders `general Agent` because the component reads `subagent_type`.

**Step 3: Add a persisted metadata round-trip test**

In `history-to-chat-messages.test.ts`, construct a history tool part whose `state.metadata` contains `{ childSessionId: "claude-subagent-abc" }`. Assert the resulting `ToolMessage.metadata.childSessionId` is present.

If this already passes for manually supplied history, keep it as a guard and add the projector persistence test in Task 3.

**Step 4: Add a task metadata translator test**

In `claude-event-translator.test.ts`, assert `task_started` / `task_progress` metadata uses canonical names:

```ts
expect(metadata).toMatchObject({
  providerTaskId: "task-1",
  subagentType: "explore",
})
expect(metadata).not.toHaveProperty("subagent_type")
```

**Step 5: Run focused tests**

Run:

```bash
pnpm vitest run \
  test/unit/provider/claude/claude-provider-instance-send-turn.test.ts \
  test/unit/provider/claude/claude-event-translator.test.ts \
  test/unit/frontend/history-to-chat-messages.test.ts
```

Expected: new tests fail for the current gaps.

---

## Task 2: Fix Live Claude Event Sink Routing

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Test: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`

**Step 1: Change translator sink access**

Replace the fixed sink stored in `ClaudeEventTranslatorDeps` with a sink resolver:

```ts
export interface ClaudeEventTranslatorDeps {
  readonly getSink: (ctx: ClaudeSessionContext) => EventSink | undefined;
  readonly runEffect: (effect: Effect.Effect<void, unknown>) => Promise<void>;
}
```

Update the private `push()` helper to accept `ctx`:

```ts
private async push(ctx: ClaudeSessionContext, event: CanonicalEvent): Promise<void> {
  const sink = this.deps.getSink(ctx);
  if (!sink) return;
  await this.deps.runEffect(sink.push(event));
}
```

Then update translator call sites from `this.push(event)` to `this.push(ctx, event)`.

**Step 2: Construct translator with current context sink**

In `ClaudeProviderInstance.runStreamConsumer` construction:

```ts
const translator = new ClaudeEventTranslator({
  getSink: (ctx) => ctx.eventSink,
  runEffect: makeRuntimeEffectRunner(runtime),
});
```

**Step 3: Run the focused sink test**

Run:

```bash
pnpm vitest run test/unit/provider/claude/claude-provider-instance-send-turn.test.ts -t "latest sink"
```

Expected: second-turn translated events go to `sinkB`.

**Step 4: Commit**

```bash
git add src/lib/provider/claude/claude-event-translator.ts src/lib/provider/claude/claude-provider-instance.ts test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
git commit -m "fix(claude): route events through latest sink"
```

---

## Task 3: Persist Tool Metadata for Parent Task Cards

**Files:**
- Modify: `src/lib/persistence/migrations/0001_current_event_store.sql`
- Modify: `src/lib/persistence/read-model-types.ts`
- Modify: `src/lib/persistence/projectors/message-projector.ts`
- Modify: `src/lib/persistence/effect/projectors-effect.ts`
- Modify: `src/lib/persistence/session-history-adapter.ts`
- Test: `test/unit/persistence/projectors/message-projector.test.ts`
- Test: `test/unit/persistence/projectors-effect.test.ts`
- Test: `test/unit/persistence/session-history-adapter.test.ts`

**Step 1: Add failing projector tests**

Add a test where:

1. `tool.started` creates a Task part.
2. `tool.running` arrives with metadata:

```ts
{
  childSessionId: "claude-subagent-abc",
  sdkSubagentId: "agent-abc",
  providerTaskId: "task-1",
}
```

Assert `message_parts.metadata` stores that JSON.

Expected failure: no metadata column exists and `tool.running` only updates `status`.

**Step 2: Add metadata column**

In `0001_current_event_store.sql`, add:

```sql
metadata    TEXT,
```

to `message_parts`.

If this repo has incremental migrations beyond the consolidated current schema in another branch, add the equivalent migration there too. In the current checkout, `0001_current_event_store.sql` is the source to update.

**Step 3: Update row types**

Add to `MessagePartRow`:

```ts
metadata: string | null;
```

**Step 4: Update projectors**

In both message projector implementations, change `tool.running` handling to merge metadata when present:

```sql
UPDATE message_parts
SET status = 'running',
    metadata = CASE
      WHEN ? IS NULL THEN metadata
      WHEN metadata IS NULL THEN ?
      ELSE json_patch(metadata, ?)
    END,
    updated_at = ?
WHERE id = ?
```

Use `encodeJson(event.data.metadata)` once in TypeScript and pass it for each metadata placeholder. If SQLite JSON1 availability is uncertain in tests, do the merge in TypeScript by reading the current row first; prefer the current repo's SQLite capabilities over speculative SQL.

**Step 5: Add history adapter support**

In `session-history-adapter.ts`, when `row.metadata != null`, parse it and set:

```ts
stateObj["metadata"] = parsedMetadata;
```

**Step 6: Run focused persistence tests**

Run:

```bash
pnpm vitest run \
  test/unit/persistence/projectors/message-projector.test.ts \
  test/unit/persistence/projectors-effect.test.ts \
  test/unit/persistence/session-history-adapter.test.ts
```

Expected: metadata persists through projection and history conversion.

**Step 7: Commit**

```bash
git add src/lib/persistence test/unit/persistence
git commit -m "feat(persistence): persist tool metadata"
```

---

## Task 4: Add Parent-Aware Session Creation Events

**Files:**
- Modify: `src/lib/persistence/events.ts`
- Modify: `src/lib/persistence/projectors/session-projector.ts`
- Modify: `src/lib/persistence/effect/projectors-effect.ts`
- Modify: `src/lib/persistence/session-seeder.ts`
- Modify: `src/lib/persistence/effect/session-seeder-effect.ts`
- Test: `test/unit/schema/canonical-events.test.ts`
- Test: `test/unit/persistence/projectors/session-projector.test.ts`
- Test: `test/unit/persistence/projectors-effect.test.ts`

**Step 1: Add failing schema/projector tests**

Add a `session.created` event with:

```ts
{
  sessionId: "claude-subagent-abc",
  title: "Explore Agent",
  provider: "claude",
  parentId: "parent-session",
}
```

Assert the schema decodes it and the `sessions.parent_id` column is set.

Expected failure: `parentId` is not in `SessionCreatedPayload`.

**Step 2: Extend canonical payload**

In `SessionCreatedPayload`, add:

```ts
readonly parentId?: string;
readonly providerSessionId?: string;
```

Update `SessionCreatedPayloadSchema` with optional fields.

**Step 3: Update session projectors**

For `session.created`, include `provider_sid` and `parent_id` in the insert/update while preserving existing values when omitted.

The important behavior:

- if `parentId` is present, write it.
- if `parentId` is absent, do not erase an existing `parent_id`.
- if `providerSessionId` is present, write it.
- if `providerSessionId` is absent, do not erase an existing `provider_sid`.

**Step 4: Update seeders carefully**

Do not force all `ensureSession()` callers to provide parent info. Add an optional parameter:

```ts
ensureSession(sessionId: string, provider: string, opts?: {
  parentId?: string;
  providerSessionId?: string;
}): boolean
```

Mirror the same shape in the Effect seeder.

**Step 5: Run focused tests**

Run:

```bash
pnpm vitest run \
  test/unit/schema/canonical-events.test.ts \
  test/unit/persistence/projectors/session-projector.test.ts \
  test/unit/persistence/projectors-effect.test.ts
```

Expected: parent metadata survives replay and repeated session.created events.

**Step 6: Commit**

```bash
git add src/lib/persistence test/unit/schema test/unit/persistence
git commit -m "feat(sessions): allow provider child sessions"
```

---

## Task 5: Implement Claude SDK Subagent Materializer

**Files:**
- Create: `src/lib/provider/claude/claude-subagent-materializer.ts`
- Modify: `src/lib/provider/claude/claude-provider-instance.ts`
- Modify: `src/lib/provider/claude/types.ts`
- Modify: `src/lib/persistence/effect/claude-event-persist-effect.ts`
- Test: `test/unit/provider/claude/claude-subagent-materializer.test.ts`
- Test: `test/unit/provider/claude/claude-provider-instance-send-turn.test.ts`

**Step 1: Define the SDK adapter seam**

Create:

```ts
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeSubagentSdk {
  listSubagents(
    parentClaudeSessionId: string,
    options: { dir: string },
  ): Promise<readonly string[]>;

  getSubagentMessages(
    parentClaudeSessionId: string,
    sdkSubagentId: string,
    options: { dir: string },
  ): Promise<readonly SessionMessage[]>;
}
```

Production implementation imports `listSubagents` and `getSubagentMessages` from `@anthropic-ai/claude-agent-sdk`.

**Step 2: Define materializer input/output**

Use an Effect-returning API:

```ts
export interface MaterializeClaudeSubagentsInput {
  readonly parentConduitSessionId: string;
  readonly parentClaudeSessionId: string;
  readonly workspaceRoot: string;
  readonly knownTasks: ReadonlyMap<string, {
    readonly toolUseId: string;
    readonly description?: string;
    readonly subagentType?: string;
  }>;
}

export interface MaterializedClaudeSubagent {
  readonly sdkSubagentId: string;
  readonly childSessionId: string;
  readonly parentToolUseId?: string;
}
```

**Step 3: Add deterministic child session IDs**

Use Node crypto:

```ts
export function claudeSubagentSessionId(input: {
  parentConduitSessionId: string;
  parentClaudeSessionId: string;
  sdkSubagentId: string;
}): string {
  const hash = createHash("sha256")
    .update(`${input.parentConduitSessionId}\0${input.parentClaudeSessionId}\0${input.sdkSubagentId}`)
    .digest("hex")
    .slice(0, 24);
  return `claude-subagent-${hash}`;
}
```

**Step 4: Convert SDK SessionMessage to canonical events**

Implement a narrow converter that handles only proven transcript shapes:

- `type: "user"` with `message.content` text blocks -> `message.created` + `text.delta`
- `type: "assistant"` with text blocks -> `message.created` + `text.delta`
- assistant thinking blocks, if present -> `thinking.start` / `thinking.delta` / `thinking.end`
- tool use/result blocks, if present and shape matches Anthropic content blocks -> `tool.started` / `tool.completed`
- unknown content blocks are skipped but logged in tests as unsupported fixture coverage

Do not cast the whole `message` object to a rich shape. Use small type guards:

```ts
function isMessageWithContent(value: unknown): value is {
  readonly content: unknown;
} {
  return value != null && typeof value === "object" && "content" in value;
}
```

**Step 5: Persist child sessions and transcript events**

Extend `ClaudeEventPersistEffect` with:

```ts
readonly persistClaudeSubagent: (input: {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly providerSessionId: string;
  readonly title: string;
  readonly events: readonly CanonicalEvent[];
}) => Effect.Effect<void, ClaudeEventPersistEffectError>;
```

Implementation:

1. `ensureRecovered()`.
2. Append a `session.created` event for the child with `parentId` and `providerSessionId`.
3. Append converted transcript events.
4. Project the batch.

Idempotence rule: before appending message events, drop events whose `messageId` already exists in the read model for that child session. If a read-model query service is not available in this layer, store last materialized SDK message UUID in `provider_state` and use that cursor.

**Step 6: Wire materialization after Claude turns**

In `ClaudeProviderInstance`, add deps:

```ts
readonly subagentSdk?: ClaudeSubagentSdk;
readonly materializeSubagents?: (input: MaterializeClaudeSubagentsInput) => Effect.Effect<readonly MaterializedClaudeSubagent[], unknown>;
```

Track known task metadata in `ClaudeSessionContext`, for example:

```ts
readonly subagentTasks: Map<string, {
  toolUseId: string;
  description?: string;
  subagentType?: string;
}>;
```

Populate it from `task_started` / `task_progress` metadata. After a `result` message resolves the parent turn, call the materializer when `ctx.resumeSessionId` exists.

**Step 7: Emit parent tool metadata with child session links**

For each materialized child linked to a parent tool, push:

```ts
tool.running {
  messageId: parentAssistantMessageId,
  partId: parentToolUseId,
  metadata: {
    childSessionId,
    sdkSubagentId,
    providerTaskId,
  }
}
```

This updates both live UI and persisted history via Task 3.

**Step 8: Add unit tests**

Cover:

- `listSubagents()` returning no subagents is a no-op.
- one SDK subagent transcript creates one child `session.created` with `parentId`.
- repeated materialization does not duplicate messages.
- direct `task_id`/subagent-id match links `metadata.childSessionId` to the parent Task tool.
- unmatched SDK subagent still creates a child session but does not mutate a parent tool.

**Step 9: Run focused tests**

Run:

```bash
pnpm vitest run \
  test/unit/provider/claude/claude-subagent-materializer.test.ts \
  test/unit/provider/claude/claude-provider-instance-send-turn.test.ts
```

Expected: materializer behavior passes without hitting a real Claude install.

**Step 10: Commit**

```bash
git add src/lib/provider/claude src/lib/persistence/effect test/unit/provider/claude
git commit -m "feat(claude): materialize subagents as child sessions"
```

---

## Task 6: Fix Parent Task Card Rendering and Navigation

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolSubagentCard.svelte`
- Modify: `src/lib/frontend/stories/mocks.ts`
- Test: component/unit test from Task 1
- Test: `test/visual/tool-item.spec.ts`

**Step 1: Replace ad hoc input parsing**

Add a small local parser:

```ts
function readTaskInput(input: unknown): {
  description: string;
  subagentType: string;
  prompt: string;
  taskId?: string;
} | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  return {
    description: typeof record["description"] === "string" ? record["description"] : "",
    subagentType:
      typeof record["subagentType"] === "string"
        ? record["subagentType"]
        : typeof record["subagent_type"] === "string"
          ? record["subagent_type"]
          : "general",
    prompt: typeof record["prompt"] === "string" ? record["prompt"] : "",
    ...(typeof record["taskId"] === "string"
      ? { taskId: record["taskId"] }
      : typeof record["task_id"] === "string"
        ? { taskId: record["task_id"] }
        : {}),
  };
}
```

Keep backwards-compatible snake_case reads only as migration fallback. Canonical output remains camelCase.

**Step 2: Prefer childSessionId metadata for navigation**

Update `subagentSessionId` priority:

1. `message.metadata.childSessionId`
2. `message.metadata.sessionId`
3. `taskInput.taskId`
4. result text `task_id: ...` legacy fallback

Do not require IDs to start with `ses_`; Claude child sessions use `claude-subagent-*`.

**Step 3: Keep the card compact**

Do not inline transcript body in the parent card. The card should show:

- agent type
- description
- running/completed/error status
- navigation affordance when child session exists

The child session window shows the transcript.

**Step 4: Update mocks**

Change story mocks to use canonical `subagentType` and `metadata.childSessionId`, while keeping one legacy snake_case story if useful.

**Step 5: Run tests**

Run:

```bash
pnpm vitest run test/unit/frontend/history-to-chat-messages.test.ts
pnpm exec playwright test --config test/visual/playwright.config.ts test/visual/tool-item.spec.ts
```

Expected: subagent cards render canonical Claude metadata and existing OpenCode fixture visuals remain stable.

**Step 6: Commit**

```bash
git add src/lib/frontend test/unit/frontend test/visual
git commit -m "fix(frontend): navigate canonical subagent tools"
```

---

## Task 7: Strengthen Claude-to-Canonical Type Guarantees

**Files:**
- Modify: `src/lib/persistence/events.ts`
- Modify: `src/lib/provider/claude/types.ts`
- Modify: `src/lib/provider/claude/normalize-tool-input.ts`
- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Create: `test/unit/provider/claude/claude-sdk-contract.test.ts`
- Test: `test/unit/schema/canonical-events.test.ts`
- Test: `test/unit/provider/claude/normalize-tool-input.test.ts`

**Step 1: Add compile-time SDK contract tests**

Create `claude-sdk-contract.test.ts` with `expectTypeOf` checks against real SDK types:

```ts
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKTaskProgressMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

expectTypeOf<SDKPartialAssistantMessage>().toHaveProperty("parent_tool_use_id");
expectTypeOf<SDKAssistantMessage>().toHaveProperty("parent_tool_use_id");
expectTypeOf<SDKUserMessage>().toHaveProperty("parent_tool_use_id");
expectTypeOf<SDKTaskProgressMessage>().toHaveProperty("tool_use_id");
```

These do not prove runtime behavior; they pin the exact SDK fields conduit depends on.

**Step 2: Schema the canonical tool input union**

Replace `ToolStartedPayloadSchema.input: Schema.Unknown` with a real `CanonicalToolInputSchema` that covers every variant in `CanonicalToolInput`.

Use `Schema.Union(...)` with `tool` discriminants. Unknown tools remain allowed only through:

```ts
{ tool: "Unknown", name: Schema.String, raw: Schema.Record({ key: Schema.String, value: Schema.Unknown }) }
```

**Step 3: Fix provider naming drift**

Choose one provider key for Claude in persistence. Current live code uses `"claude"` while old tests and `ProviderType` mention `"claude-sdk"`. Prefer `"claude"` because it is the active provider ID used by `ClaudeProviderInstance`, model handling, agent handling, and persisted Claude events.

Update:

- `PROVIDER_TYPES`
- schema tests
- projector tests that assert `"claude-sdk"` only because of older naming

Do not change OpenCode's `"anthropic"` provider models; only the conduit in-process provider key.

**Step 4: Remove broad SDK casts from tests**

Where tests currently use `as unknown as SDKMessage`, replace with typed fixture builders for each SDK variant:

```ts
function sdkTaskProgress(overrides: Partial<SDKTaskProgressMessage> = {}): SDKTaskProgressMessage {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: "task-1",
    description: "Working",
    usage: { total_tokens: 0, tool_uses: 0, duration_ms: 0 },
    uuid: "00000000-0000-0000-0000-000000000001",
    session_id: "sdk-session",
    ...overrides,
  };
}
```

Keep casts only at external-library construction sites where the SDK type is genuinely too wide to construct ergonomically, and comment why.

**Step 5: Run focused type/schema tests**

Run:

```bash
pnpm vitest run \
  test/unit/provider/claude/claude-sdk-contract.test.ts \
  test/unit/provider/claude/normalize-tool-input.test.ts \
  test/unit/schema/canonical-events.test.ts
pnpm check
```

Expected: SDK field usage and canonical event payloads are checked at compile time and runtime.

**Step 6: Commit**

```bash
git add src/lib/persistence src/lib/provider/claude test/unit/provider/claude test/unit/schema
git commit -m "test(claude): pin sdk canonical mapping"
```

---

## Task 8: Integration Test the Child Session Flow

**Files:**
- Create: `test/unit/pipeline/claude-subagent-materialization.test.ts`
- Modify existing helpers only if needed

**Step 1: Build a fake SDK transcript**

Use fake adapter functions:

```ts
const sdk: ClaudeSubagentSdk = {
  listSubagents: async () => ["task-1"],
  getSubagentMessages: async () => [
    {
      type: "user",
      uuid: "sub-user-1",
      session_id: "sdk-parent",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "Inspect auth" }] },
    },
    {
      type: "assistant",
      uuid: "sub-assistant-1",
      session_id: "sdk-parent",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: "Auth is fine" }] },
    },
  ],
};
```

**Step 2: Drive parent turn events**

Simulate:

- parent Claude session gets `resumeSessionId`
- Task tool starts with `tool_use_id: "task-tool-1"` and `task_id: "task-1"`
- parent result arrives
- materializer runs

**Step 3: Assert read models**

Assert:

- parent session has a Task tool with `metadata.childSessionId`
- child session exists with `parentID` equal to parent conduit session ID
- child history contains the subagent user and assistant messages
- session list roots mode excludes the child session
- direct switch to the child session returns the materialized transcript

**Step 4: Run the integration-style unit test**

Run:

```bash
pnpm vitest run test/unit/pipeline/claude-subagent-materialization.test.ts
```

Expected: parent-to-child navigation data and child transcript read models are coherent.

**Step 5: Commit**

```bash
git add test/unit/pipeline/claude-subagent-materialization.test.ts
git commit -m "test(claude): cover subagent child sessions"
```

---

## Task 9: Final Verification

**Files:**
- No code changes unless verification exposes a defect.

**Step 1: Run focused suite**

Run:

```bash
pnpm vitest run \
  test/unit/provider/claude \
  test/unit/provider/relay-event-sink.test.ts \
  test/unit/persistence/projectors/message-projector.test.ts \
  test/unit/persistence/projectors/session-projector.test.ts \
  test/unit/frontend/history-to-chat-messages.test.ts \
  test/unit/pipeline/claude-subagent-materialization.test.ts
```

**Step 2: Run standard checks**

Run:

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 3: Run broader suite only if needed**

If persistence migrations, session switching, or frontend session navigation changed in a way not covered above, run:

```bash
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed, see test-output.log" && exit 1)
```

**Step 4: Final review checklist**

Confirm:

- Claude parent Task tools navigate to child sessions via `metadata.childSessionId`.
- Child sessions use `parentID` and are hidden by roots-only session list mode.
- Claude subagent transcript text appears in the child session window.
- No parent Task card attempts to inline large subagent output.
- Canonical Task input uses `subagentType`, with snake_case only as backward-compatible UI fallback.
- Claude SDK fields used by conduit are pinned by type tests against real SDK imports.
- Provider key drift is resolved or explicitly documented if not changed.
