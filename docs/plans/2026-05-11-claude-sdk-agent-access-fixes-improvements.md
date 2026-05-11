# Claude SDK Agent Access Fixes — Improvement Plan

Companion to `2026-05-11-claude-sdk-agent-access-fixes.md`. The base plan ships correct fixes for all four audit findings plus the related subagent lifecycle bug. This plan upgrades four places where the base implementation chose a workable approach over a clean one.

The branch under review is `ds/claude-sdk-agent-access-fixes` in `.worktrees/claude-sdk-agent-access-fixes/`. All four improvements should be applied as additional commits on that branch before merge.

---

## Summary of gaps

| # | Where | Base plan did | Improvement |
|---|-------|---------------|-------------|
| 1 | `EventSink` permission resolution | Type-guarded `hasPermissionResolver` against a structurally extended sink type | Lift `resolvePermission` into the `EventSink` interface itself |
| 2 | Agent wire format | Strips `agent.model` in `toWireAgents` and `AgentInfo` schema | Forward `model` so the UI can show `Explore (haiku)` |
| 3 | Mid-session agent switch | Disposes the SDK query and starts a fresh one with only the new user prompt | Serialize prior conversation (text + tool calls + tool results) into the new query's first user turn |
| 4 | Tests | `makeBaseSendTurnInput` defaults `history: []`; existing agent-switch test does not exercise history | Add a test that asserts the new query's first prompt contains a faithful prior-conversation transcript |

The subagent lifecycle fix (`task_started` / `task_progress` / `task_notification` / `tool_progress` no longer driving `turn.completed`) is verified correct and needs no change.

---

## Improvement 1 — Lift `resolvePermission` into the `EventSink` interface

### Why the current code is a bandaid

`src/lib/provider/claude/claude-permission-bridge.ts` defines a structural extension and a type guard:

```ts
type PermissionResolvingSink = EventSink & {
    resolvePermission(requestId: string, response: PermissionResponse): void;
};

function hasPermissionResolver(
    sink: EventSink | undefined,
): sink is PermissionResolvingSink { … }
```

Both real implementations (`RelayEventSink` in `relay-event-sink.ts:91`, `EventSinkImpl` in the daemon path) already expose `resolvePermission`. The guard exists only because the **`EventSink` interface** in `src/lib/provider/types.ts:49` does not declare it. The result:

- Every caller that resolves a permission has to know to narrow the sink.
- A new sink implementation can silently omit `resolvePermission`, and the bridge will degrade to a silent permission hang instead of a compile error.
- The "permission promise contract" is split across the interface (`requestPermission`) and a structural extension nobody reads.

The cleaner fix is to make the symmetry explicit at the interface level: a sink that issues `requestPermission` must also be able to resolve it.

### Concrete edits

**File: `src/lib/provider/types.ts`**

Add to the `EventSink` interface (after `requestQuestion` at line 52):

```ts
export interface EventSink {
    push(event: CanonicalEvent): Promise<void>;
    requestPermission(request: PermissionRequest): Promise<PermissionResponse>;
    requestQuestion(request: QuestionRequest): Promise<Record<string, unknown>>;
    resolvePermission(requestId: string, response: PermissionResponse): void;
    resolveQuestion(requestId: string, answers: Record<string, unknown>): void;
}
```

Both resolvers are already on `RelayEventSink` (`relay-event-sink.ts:91-96`) and on the daemon path's `EventSinkImpl` — they are just being declared via a subtype. Lifting them to the base interface costs nothing for the implementations.

**File: `src/lib/provider/claude/claude-permission-bridge.ts`**

Delete the entire `PermissionResolvingSink` type, the `hasPermissionResolver` guard, and the `resolveSinkPermission` helper (lines 38-60). Replace their use:

```ts
// Before:
resolve: (decision) => {
    resolveSinkPermission(sink, requestId, decision);
},
reject: () => {
    resolveSinkPermission(sink, requestId, "reject");
},

// After:
resolve: (decision) => {
    sink.resolvePermission(requestId, { decision });
},
reject: () => {
    sink.resolvePermission(requestId, { decision: "reject" });
},
```

**File: `src/lib/provider/relay-event-sink.ts`**

`RelayEventSink` becomes a type alias for `EventSink` (drop the extension at line 91-96, since the methods are now part of the base interface). The two callsites that import `RelayEventSink` (verify with `grep -rn "RelayEventSink"`) keep working — the type is still exported.

**Sinks that need updating** (compile errors will surface these):

- `RelayEventSink` (already has both methods)
- `EventSinkImpl` (daemon path; verify and add if missing)
- Any test mock under `test/` (mostly `createMockEventSink` in `test/helpers/`)

Use `pnpm check` after the edit to surface every mock that needs `resolvePermission` / `resolveQuestion` stubs.

### Acceptance

- `pnpm check` clean after lifting the methods.
- `hasPermissionResolver` and `PermissionResolvingSink` no longer exist anywhere in `src/`.
- Existing permission tests still pass (the dispatch path becomes "call `sink.resolvePermission(...)` directly" — the runtime behavior is identical).

---

## Improvement 2 — Forward `agent.model` on the wire

### Why the current code is incomplete

The probe correctly captures `agent.model` into `ProviderAgentInfo` (`claude-capabilities-probe.ts:198`). But the value never reaches the UI:

- `toWireAgents` (`src/lib/handlers/agent.ts:62-70`) maps `ProviderAgentInfo → { id, name, description? }` — dropping `model`.
- `AgentInfo` and `AgentInfoSchema` in `src/lib/shared-types.ts:94-98, 416-420` have no `model` field.
- The existing test at `test/unit/bridges/client-init.test.ts:275-298` locks in the strip behavior — it passes `{ model: "opus" }` in and asserts `{ id, name }` out.

So today, the UI shows `Explore`, `OpusOnly`, `HaikuWorker` — and the user has no signal that picking `OpusOnly` silently overrides the parent-selected model with Opus. This is exactly the affordance the audit asked for.

### Concrete edits

**File: `src/lib/shared-types.ts`**

Add `model?: string` to `AgentInfo` and `AgentInfoSchema`:

```ts
export interface AgentInfo {
    id: string;
    name: string;
    description?: string;
    model?: string;
}

const AgentInfoSchema = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
});
```

**File: `src/lib/handlers/agent.ts`**

Update `toWireAgents` to forward `model`:

```ts
export function toWireAgents(
    agents: readonly ProviderAgentInfo[],
): Array<{ id: string; name: string; description?: string; model?: string }> {
    return agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        ...(agent.description ? { description: agent.description } : {}),
        ...(agent.model ? { model: agent.model } : {}),
    }));
}
```

The `filterAgents` path (used for OpenCode) doesn't have `model` to forward — leave it alone. The wire schema accepts an optional field, so OpenCode agents continue to serialize without it.

**File: `src/lib/frontend/stores/ws-dispatch.ts:795` and the agent picker UI**

This plan does not redesign the picker. Two ways to surface the model:

1. **Minimal change** — render the model id alongside the name when present: `Explore (haiku)`.
2. **Cleaner change** — wire `model` into the agent menu component as a separate column.

Pick (1) for this PR. The schema change above is the load-bearing part — the picker can be polished later without another wire change.

**File: `test/unit/bridges/client-init.test.ts:275-298`**

Update the assertion to expect `model` forwarded:

```ts
agents: [
    { id: "Explore", name: "Explore", description: "Explorer" },
    { id: "OpusOnly", name: "OpusOnly", model: "opus" },
    { id: "HaikuWorker", name: "HaikuWorker", model: "haiku" },
],
```

### Acceptance

- `pnpm check` passes.
- The updated `client-init` test asserts `model` is forwarded.
- Manual: start the daemon, switch a session to Claude, open the agent picker, confirm Claude SDK agents that declare a `model` show it.

---

## Improvement 3 — Serialize prior conversation into the new query on agent switch

### Why the current code is incomplete

`claude-adapter.ts:493-509` disposes the old SDK query, clears `resumeSessionId`, and calls `createSessionAndSendTurn` with the user's new prompt. The new agent's first turn receives **only the new prompt** — no record of what came before. The conduit-side event store still has the full chat (the UI shows it), but the new agent has zero memory of those turns. Any follow-up that references prior context ("apply the same fix to the other file we discussed") produces a confused or refusing reply.

The user's product intent is: switching agents must feel like the new agent reads the whole conversation before its first turn. The SDK has no `setAgent`, and resuming with a different agent risks system-prompt mismatch. The clean path is to **synthesize the prior conversation as a structured prefix** in the new agent's first user message.

### Design

1. **Where the transcript comes from.** `SendTurnInput.history` (`src/lib/provider/types.ts:139`) already carries `readonly HistoryMessage[]`. Conduit's orchestration engine populates it for every turn. On agent switch, this array is the source of truth.

2. **What gets serialized.** Per the user's choice (full fidelity), include:
   - Every prior `user` and `assistant` message in chronological order.
   - For assistant messages with `parts`, include tool calls (tool name + final input) and tool results (text content), not just the assistant's text. The exact part shapes come from conduit's projection layer (see `HistoryMessage.parts: readonly Record<string, unknown>[]`); the serializer interprets known kinds and falls back to a JSON dump for unknown ones.

3. **Structured prefix format.** A single text block prepended to the new agent's first user message:

   ```
   <prior-conversation-transcript>
   The following is the conversation history before you took over this session. Use it as context for your next response.

   [user]
   {user prompt 1}

   [assistant]
   {assistant text 1}

   [tool-call:Read id=tool_use_1]
   {"file_path":"/foo.ts"}
   [tool-result id=tool_use_1]
   {first 500 lines of foo.ts}

   [assistant]
   {assistant text 2}
   …
   </prior-conversation-transcript>

   {user's new prompt}
   ```

   Delimiters in lowercase-XML-like style — they don't collide with arbitrary markdown the user might type, and they make the boundary obvious to the model.

4. **Where the serializer lives.** New file: `src/lib/provider/claude/history-transcript.ts`. Single exported function:

   ```ts
   export function serializePriorConversation(
       history: readonly HistoryMessage[],
   ): string;
   ```

   Returns the formatted prefix, or an empty string when `history.length === 0` (no-op on first turn). Pure function — no side effects, easy to test.

5. **How it integrates with `restartSessionForAgentChange`.** The recreation path needs to override `input.prompt` for the first turn of the new session:

   ```ts
   private async restartSessionForAgentChange(
       ctx: ClaudeSessionContext,
       input: SendTurnInput,
   ): Promise<TurnResult> {
       const oldStreamConsumer = ctx.streamConsumer;
       await this.disposeSession(ctx, "Claude agent changed");
       if (oldStreamConsumer) {
           await oldStreamConsumer.catch(() => undefined);
       }

       const providerState = { ...input.providerState };
       delete providerState["resumeSessionId"];

       const transcript = serializePriorConversation(input.history);
       const promptWithHistory =
           transcript.length > 0 ? `${transcript}\n\n${input.prompt}` : input.prompt;

       return this.createSessionAndSendTurn({
           ...input,
           providerState,
           prompt: promptWithHistory,
       });
   }
   ```

   Only the agent-switch recreation path injects the transcript. Normal turns continue to enqueue into the existing query and rely on the SDK's own API-side conversation memory — no double-injection.

6. **Edge case: in-flight tool results.** When the switch happens between turns, all prior tools have finished and their results live in `history.parts`. The base plan already rejects mid-turn switches (`agentSwitchDuringActiveTurnResult` at `claude-adapter.ts:476-491`), so the serializer never has to invent in-progress tool state.

7. **Edge case: token budget.** A long conversation can produce a prefix that exceeds the new agent's context. Two non-bandaid options:
   - **(a)** Document the constraint: switching agents counts the entire transcript against the next turn's input tokens. The user already pays this for context-reload UX.
   - **(b)** Truncate from the head with an explicit `[earlier turns elided]` marker once the prefix exceeds a configurable threshold (default ~150K tokens).

   Default to (a) for this PR; add (b) only if a manual test produces an unworkable transcript. Don't summarize via a model call — that adds a network hop on every agent switch and silently degrades fidelity.

### Concrete edits

1. **New file: `src/lib/provider/claude/history-transcript.ts`** — pure serializer.
2. **`src/lib/provider/claude/claude-adapter.ts:493-509`** — call the serializer and prepend in `restartSessionForAgentChange`.

### Acceptance

- A new unit test in `test/unit/provider/claude/claude-adapter-send-turn.test.ts` (or a sibling file) asserts: after switching agent on a session with non-empty `history`, the second `queryFactory` call's `prompt` async iterable yields a user message whose `content[0].text` starts with `<prior-conversation-transcript>` and ends with `{user's new prompt}`. It verifies that user/assistant text and at least one tool-call/tool-result pair are present in the expected order.
- A second test asserts: when `history` is empty, the serializer is a no-op — the new query's first user message equals `input.prompt` verbatim.

---

## Improvement 4 — Test coverage gap for history injection

Covered as part of Improvement 3's acceptance — promoted to its own item because the existing `restarts the SDK query when the Claude agent changes between turns` test (`test/unit/provider/claude/claude-adapter-send-turn.test.ts:227`) asserts the new query is created with the right `options.agent` but does not exercise the prompt body. Without the new assertion, a future regression that silently drops the transcript would not fail any test.

Add the test alongside the existing one. Reuse `makeBaseSendTurnInput` with an explicit `history: [...]` override that contains:

- one prior user/assistant exchange,
- one assistant turn with a tool call + tool result,
- a fresh user prompt.

Assert the prefix structure described in Improvement 3.

---

## Out of scope

- **Effect.ts migration of `ClaudeAdapter` / `ClaudePermissionBridge` / `ClaudeEventTranslator`.** These are pre-existing plain-TS classes. The base branch does not change that, and this improvement plan keeps the boundary. Future migration to Effect Layers + typed errors is tracked separately in `docs/plans/2026-04-24-effect-ts-next-wave-design.md`.
- **Refactoring the capability cache to a `Layer`-provided service.** The current module-level `caches = new Map<string, TTLCache<ProbeResult>>()` works correctly per-workspace; converting it to a Layer is part of the broader migration, not a bug here.
- **Reworking the subagent fix.** The base implementation correctly routes `task_started` / `task_progress` / `task_notification` / `tool_progress` to `tool.running` metadata and leaves `turn.completed` driven solely by SDK `result`. The original code at `claude-event-translator.ts` (pre-branch) emitted `turn.completed` from `task_progress` — a real bug the base PR fixes.
- **Two-session permission isolation tests.** The base branch already covers this in `claude-permission-bridge.test.ts`. No improvement needed.

---

## Execution order

The four improvements are independent and can be applied in any order, but the cheapest sequence is:

1. **Improvement 2** (forward `model` on the wire) — small, type-checker-driven, ~20 lines.
2. **Improvement 1** (lift `resolvePermission` to `EventSink`) — moderate, every mock surfaces in `pnpm check`.
3. **Improvement 3 + 4** (history serialization + test) — most design work; new file + integration into one adapter method + two tests.

Single PR on the existing `ds/claude-sdk-agent-access-fixes` branch. Each improvement is one commit.

## Verification

After each commit:

```
pnpm check
pnpm lint
pnpm test:unit
```

`pnpm test:all` is gated on the local `better-sqlite3` binding matching the active Node version — this is a worktree-machine concern, not a code defect on the branch.

Manual check before merge:

1. Start the daemon, open a Claude session.
2. Verify the agent picker shows `model` next to any SDK agent that declares one.
3. Have a multi-turn conversation. Switch agent mid-session. Verify the new agent's first response references prior context (transcript visible to it).
4. Trigger a tool permission prompt; approve. Verify the SDK callback unblocks immediately (no hang).
