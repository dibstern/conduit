# Claude SDK Agent Access — Second-Pass Improvement Plan

Companion to `2026-05-11-claude-sdk-agent-access-fixes.md` and `2026-05-11-claude-sdk-agent-access-fixes-improvements.md`. Those two plans deliver a correct, working fix for all four audit findings. Reading the implementation back, six smaller concerns remain — none block merge, but each is a real residual issue worth closing before this branch lands.

Branch under review: `ds/claude-sdk-agent-access-fixes`. All work below lands as additional commits on this branch.

---

## What's already correct (do not touch)

Verified against the committed code:

| Audit item | Where | Status |
|---|---|---|
| P0 permission resolution routes through ctx.eventSink | `claude-permission-bridge.ts:84-106`, `types.ts:55-56` | ✅ Solid — `resolvePermission` is on the `EventSink` interface, bridge uses `ctx.eventSink ?? this.deps.sink`, both real sinks implement it. |
| P1 model filter removed | `handlers/agent.ts:62-71` | ✅ `toWireAgents` surfaces all agents and forwards `agent.model`. |
| P1 capability probe scoped to workspace | `claude-capabilities-probe.ts:174-238` | ✅ Uses `cwd: workspaceRoot`, `settingSources: ["user","project","local"]`, `Map<workspaceRoot, TTLCache>` per workspace. |
| P2 agent switch dispose + recreate + history | `claude-adapter.ts:435-514`, `history-transcript.ts` | ✅ Mid-turn switch rejected; idle switch disposes the old query, awaits the stream consumer, recreates with the new agent, and prepends a structured prior-conversation transcript. |
| (Extra) Subagent lifecycle | `claude-event-translator.ts:296-386` | ✅ `task_started` / `task_progress` / `task_notification` / `tool_progress` all route to `tool.running` with task metadata; none of them emit `turn.completed`. |
| Wire `model` end-to-end | `shared-types.ts`, `client-init.ts`, `bridges/client-init.test.ts` | ✅ Optional `model?: string` flows through to `agent_list`. |

---

## Residual issues (this plan addresses)

| # | Where | Priority | Shape |
|---|---|---|---|
| 1 | `claude-permission-bridge.ts` | P2 | Vestigial indirection — `bridge.resolvePermission` is now a no-op wrapper around `sink.resolvePermission`. Simplify or drop. |
| 2 | `history-transcript.ts:48-58, 91-110` | P1 | `jsonValue(part)` fallback dumps entire SDK part records (incl. `tool_use_id`, `type`, redacted blobs) into the transcript that feeds the next agent. Data-integrity hazard. |
| 3 | `claude-adapter-send-turn.test.ts:348-444` | P1 | Transcript test uses a synthetic part shape (`{type:"tool_use", id, name, input}`) that does **not** match what `messageRowsToHistory` actually produces (`{type, tool, callID, state}`). The serializer's real-data branches are untested. |
| 4 | `claude-adapter.ts:494-514` + `history-transcript.ts` | P2 | No guardrail on transcript size. A long session can produce a 200K+ token prefix that silently blows the next agent's context budget. |
| 5 | `claude-adapter.ts:477-491` + `provider/types.ts:71-76` | P3 | `agentSwitchDuringActiveTurnResult` returns `error.code: "provider_error"` with a human message. UI can't render a specific affordance because the code is generic. |
| 6 | `claude-capabilities-probe.ts:230-243` | P3 | Per-workspace cache has 5-min TTL but no invalidation hook for filesystem changes (`~/.claude/agents/Foo.md` added → invisible for up to 5 minutes). No `/reload`-style entry point. |

---

## Improvement 1 — Drop the vestigial bridge resolver

### Why it's bandaid-shaped now

The flow today:

```
adapter.resolvePermission(sessionId, requestId, decision)
  → bridge.resolvePermission(ctx, requestId, decision)
      → pending.resolve(decision)                    // PendingApproval.resolve callback
          → sink.resolvePermission(requestId, { decision })   // the real work
              → deferred.resolve(response)            // unblocks `await sinkPromise` in _handlePermission
```

`bridge.resolvePermission` does exactly one thing: look up `ctx.pendingApprovals.get(requestId)` and call `pending.resolve(decision)`. `pending.resolve` then calls `sink.resolvePermission`. There is no transformation, no state mutation, no abort wiring — just two hops to the same call.

Originally the indirection existed because `EventSink` didn't declare `resolvePermission`. With the method now on the interface, the bridge layer adds zero value. Worse, `cleanupSession` (`claude-adapter.ts:766-773`) loops through `ctx.pendingApprovals.values()` and calls `pending.resolve("reject")` — which means the **same callback runs against the sink at session shutdown**, when the bridge's pending entry might not even exist anymore.

### Fix shape

Two reasonable endpoints:

**Option A (minimum diff, recommended).** Keep `pendingApprovals` as a tracking set, drop the callback layer. Replace `PendingApproval`'s `resolve`/`reject` callbacks with plain fields, and let both `adapter.resolvePermission` and `cleanupSession` call `ctx.eventSink?.resolvePermission(...)` directly.

```ts
// types.ts (claude/types.ts:81-88) — drop the callbacks:
export interface PendingApproval {
    readonly requestId: string;
    readonly toolName: string;
    readonly toolInput: Record<string, unknown>;
    readonly createdAt: string;
}

// claude-permission-bridge.ts _handlePermission — no resolve/reject closures:
const pending: PendingApproval = { requestId, toolName, toolInput: toolInput ?? {}, createdAt };
ctx.pendingApprovals.set(requestId, pending);

// Adapter.resolvePermission — call the sink directly, look up pending only to confirm it exists:
async resolvePermission(sessionId, requestId, decision) {
    const ctx = this.sessions.get(sessionId);
    if (!ctx) return;
    if (!ctx.pendingApprovals.has(requestId)) return;       // unknown id → silent no-op (matches today)
    ctx.eventSink?.resolvePermission(requestId, { decision });
    // _handlePermission's finally{} removes the entry.
}

// cleanupSession — same pattern, deny all in-flight approvals:
for (const { requestId } of ctx.pendingApprovals.values()) {
    ctx.eventSink?.resolvePermission(requestId, { decision: "reject" });
}
ctx.pendingApprovals.clear();
```

**Option B (cleaner, slightly more diff).** Delete the bridge class entirely. `createCanUseTool(ctx)` becomes a free function in `claude-permission-bridge.ts`. `ClaudeAdapter` holds no `permissionBridge` field; `getPermissionBridge`/`setPermissionBridge` go away.

Pick **A** unless you also want to migrate the bridge module to a `Layer` / typed-error shape as part of the Effect migration — in which case **B** is the better foundation.

### Tests to update

- `claude-permission-bridge.test.ts:199-237` — adjust the "resolvePermission resolves the pending approval's deferred" test to call `adapter.resolvePermission` (or directly call `sink.resolvePermission`), not `bridge.resolvePermission`.
- `claude-permission-bridge.test.ts:21-33` — the test file declares its own `EventSink`-ish type with `resolvePermission`; this stays correct because the interface now has the method.
- The "no-op for unknown requestId" test (line 234-237) becomes "adapter.resolvePermission for unknown requestId silently no-ops" — verify the sink resolver is **not** called.

---

## Improvement 2 — Stop leaking SDK part internals into the prior-conversation transcript

### What leaks today

`history-transcript.ts:48-58`:

```ts
function toolOutput(part: Record<string, unknown>): string {
    const state = asRecord(part["state"]);
    return (
        stringValue(part["content"]) ??
        stringValue(part["text"]) ??
        stringValue(part["result"]) ??
        stringValue(part["output"]) ??
        stringValue(state?.["output"]) ??
        jsonValue(part)            // ← dumps the entire part record on miss
    );
}
```

And `serializePart:108-110`:

```ts
// Unknown part type:
return `[part:${type}]\n${jsonValue(part)}`;
```

Concrete leaks:

- **Failed tool with no string output.** A tool that returned `{}`, `null`, or only structured data gets serialized as the entire JSON of the part — including `tool_use_id`, `type`, and any SDK-internal fields stashed there. The next agent sees opaque JSON that wastes tokens and may include identifiers tied to a different SDK session.
- **`redacted_thinking` parts.** If the projection ever stores these as a part with `type: "redacted_thinking"`, the serializer dumps the redacted blob into the prefix — the *opposite* of what redaction means.
- **`citations`, `signature`, MCP-result blobs.** Any non-text-non-tool-call-non-tool-result part falls into the unknown branch and gets JSON-dumped verbatim.

### Fix shape

Two-part: lock down the unknown branches, and never JSON-dump on missing tool output.

```ts
// toolOutput: explicit "(no output)" on miss
function toolOutput(part: Record<string, unknown>): string {
    const state = asRecord(part["state"]);
    const text =
        stringValue(part["content"]) ??
        stringValue(part["text"]) ??
        stringValue(part["result"]) ??
        stringValue(part["output"]) ??
        stringValue(state?.["output"]);
    return text ?? "(no output)";
}

// serializePart: allowlist; unknown emits a tag with no payload
function serializePart(part: Record<string, unknown>): string | undefined {
    const type = partType(part);
    if (type === "text") return undefined;
    if (isToolCall(part))   return `[tool-call:${toolName(part)}${idSuffix(part)}]\n${jsonValue(toolInput(part))}`;
    if (isToolResult(part)) return `[tool-result${idSuffix(part)}]\n${toolOutput(part)}`;
    return `[part:${type}]`;   // tag-only; no payload for unknown types
}
```

(The `idSuffix` helper consolidates the existing `id ? \` id=${id}\` : ""` pattern.)

### Tests to add

In `history-transcript.test.ts` (new file, or sibling unit test next to the serializer):

- `tool_result` with `state.output: undefined` → text contains `(no output)`, never JSON-of-the-part.
- `tool_result` with `content: ""` (empty string) → still `(no output)` (empty `stringValue` returns `undefined`).
- A part with unknown type `redacted_thinking` → emits `[part:redacted_thinking]` with no payload.
- A part with unknown type `citations_delta` → same.

These tests should fail against the current `jsonValue(part)` fallback and pass after the fix.

---

## Improvement 3 — Test the serializer against the real `messageRowsToHistory` shape

### The gap

`claude-adapter-send-turn.test.ts:388-411` constructs history parts like:

```ts
{ type: "tool_use",    id: "toolu_1", name: "Read", input: {...} }
{ type: "tool_result", tool_use_id: "toolu_1", content: "..." }
```

But `session-history-adapter.ts:50-58` (the actual loader used by `prompt.ts:180-202` via `loadPriorHistoryForTurn`) produces:

```ts
{ id, type: <projection type>, text?, tool: <name>?, callID: <id>?, state: { status, input, output }? }
```

So the *real* tool-call part on the wire has `type` from the projection (often `"tool"`), `tool: "Read"`, `callID: "toolu_1"`, and `state: { input, output }` — not the SDK-shape `{type:"tool_use", id, name, input}` the synthetic test uses.

The serializer happens to handle both because `toolName` reads `name|tool|toolName` and `partId` reads `id|callID|call_id|tool_use_id`. But `isToolCall` matches only `type === "tool_use" | "server_tool_use" | "mcp_tool_use" | "tool_call" | "tool"` — whether real projection parts hit `"tool"` is unverified.

If they don't, every real tool call falls into the unknown branch and gets dumped as `[part:tool]\n{...}` — which is exactly the leak Improvement 2 is closing.

### Fix shape

1. **Determine the actual `type` value** emitted by `partRowToHistoryPart` for tool calls and tool results. This is a 5-minute investigation:
   - Read `MessagePartRow.type` definition and the projection logic that writes the rows.
   - Or: run `sqlite3 ~/.local/share/conduit/conduit.db "select distinct type from message_parts limit 20"` from a live session that exercised tools.

2. **Update `isToolCall`/`isToolResult` allowlists** to include whatever real values appear. Most likely `"tool"` is the unified type and there's a `state.status` to distinguish call-vs-result-vs-running.

3. **Add an end-to-end transcript test** that builds `MessageWithParts[]` rows in the shape the projection actually produces, runs them through `messageRowsToHistory`, then through `serializePriorConversation`, and asserts the transcript contains `[tool-call:Read id=…]` and `[tool-result id=…]` with the expected `idSuffix` populated from `callID`.

This is the load-bearing test for the agent-switch UX. Without it, the serializer's correctness on real data is assumed, not verified.

---

## Improvement 4 — Transcript-size guardrail

### Why

Switching agent on a session with 50+ tool-using turns produces a multi-hundred-K-character prefix. The new agent silently runs with most of its context window consumed by transcript; the first user reply may be truncated or refused for context overflow with no clear explanation.

### Fix shape (no bandaid)

Two-tier:

1. **Warn-and-truncate at a documented threshold.** In `history-transcript.ts`, after building the prefix, check `lines.join("\n").length` against a constant (start at `~600_000` chars ≈ ~150K tokens for a Sonnet 200K budget). On overflow:
   - Drop oldest turns from the head until the prefix fits.
   - Replace the dropped section with `[earlier turns elided: N user/assistant pairs]`.
   - `log.warn` with the session id, dropped pair count, and final prefix length.

2. **Emit a user-visible heads-up.** When truncation fires, push a `session.status` event with `status: "retry"` and a `correlationId` like `"Agent switched: prior transcript truncated (N earlier turns elided)"`. This reuses the existing retry-banner path the UI already renders (`relay-event-sink.ts:339-345`).

Default threshold to 600_000 chars; expose it as a const at the top of `history-transcript.ts` so it's easy to tune.

### Tests

- Build a 1000-turn synthetic history, serialize, assert prefix length ≤ threshold + elision marker present.
- Build a short history, serialize, assert no elision marker.

---

## Improvement 5 — Typed error code for in-flight agent-switch rejection

### Current

`claude-adapter.ts:477-491` returns:

```ts
{
    status: "error",
    error: { code: "provider_error", message: `Cannot switch Claude agent while a turn is active (...)` },
    ...
}
```

`TurnErrorCode` (`provider/types.ts:71-76`) is `"send_failed" | "provider_error" | "interrupted" | "timeout" | "unknown"`. None of these distinguish "the provider refused this send because of a precondition" from "the provider attempted the send and the upstream API errored."

### Fix shape

Add a typed code:

```ts
// provider/types.ts
export type TurnErrorCode =
    | "send_failed"
    | "provider_error"
    | "interrupted"
    | "timeout"
    | "agent_switch_during_turn"   // ← new
    | "unknown";
```

Use it in `agentSwitchDuringActiveTurnResult`:

```ts
error: { code: "agent_switch_during_turn", message: `...` }
```

UI can then render "Wait for the current turn to finish, then try switching." instead of the generic provider error chrome. The pre-existing tests at `claude-adapter-send-turn.test.ts:497+` need the code updated.

Why "no bandaid": today the UI can only string-match on the message to render the special affordance; that's fragile. The typed code makes the contract explicit.

---

## Improvement 6 — Manual invalidation hook for the capability cache

### Why

`claude-capabilities-probe.ts:230-243` ships per-workspace `TTLCache` with a 5-minute TTL. Adding `~/.claude/agents/Foo.md` produces an agent the user can't see for up to 5 minutes.

The existing `resetCapabilityCacheForTesting()` already does the right thing — but it's marked for tests. Production has no entry point.

### Fix shape

Two-line addition:

```ts
// claude-capabilities-probe.ts — drop the "for testing" suffix on the public method:
export function invalidateClaudeCapabilityCache(workspaceRoot?: string): void {
    if (workspaceRoot) caches.delete(workspaceRoot);
    else caches = new Map();
}

// Keep the existing resetCapabilityCacheForTesting() as a thin alias for the global form.
```

Wire it from:

1. A `/reload` handler if conduit has one (search for `discover` re-invocation paths in handlers).
2. A SIGHUP handler in the daemon entry point (low-effort manual refresh).

Both are optional polish — even shipping just the function without callers is an improvement because the next person who needs it can wire it in one line.

### Out of scope (deliberately)

- A filesystem watcher on `~/.claude/agents` and `<workspace>/.claude/agents`. Watchers come with cross-platform pain (recursive watching, debouncing, symlinks). Not worth it for a 5-minute TTL.

---

## What we are explicitly NOT doing in this pass

- **Effect-ts migration of `ClaudeAdapter` / `ClaudePermissionBridge` / `ClaudeEventTranslator`.** These remain plain-TS classes. The branch's commit `9af17d8` does not migrate them, and this pass keeps that boundary. Tracked separately in `docs/plans/2026-04-24-effect-ts-next-wave-design.md`.
- **Replacing the capability cache with an Effect `Layer`.** Same reasoning. Per-workspace `Map<string, TTLCache>` is correct today; Layer migration is a refactor, not a fix.
- **Reworking the subagent-lifecycle implementation.** Verified correct. `task_*` events route to `tool.running` metadata with `parent_tool_use_id` correlation; no path emits a premature `turn.completed`.
- **Touching opencode side.** The base branch updated `opencode-adapter-actions.test.ts` and `opencode-adapter-send-turn.test.ts` to add `resolvePermission` to mock sinks — that's the entire opencode-side delta and it's correct.

---

## Execution order

Recommended single-PR sequence, one commit per improvement:

1. **Improvement 2** (transcript leak) — pure addition to the serializer; smallest blast radius.
2. **Improvement 3** (real-shape test) — depends on knowing the real part `type`; fastest follow-on.
3. **Improvement 4** (size guardrail) — additive in the same file as #2.
4. **Improvement 5** (typed error code) — touches `provider/types.ts` + one adapter line + one test assertion.
5. **Improvement 1** (drop bridge indirection) — most diff (touches `PendingApproval` shape and several test files); land last so the earlier commits are easier to review in isolation.
6. **Improvement 6** (rename probe reset to invalidate) — trivial; can fold into #1 or stand alone.

### Verification gate after each commit

```
pnpm check
pnpm lint
pnpm test:unit
```

Full test gate before merge:

```
pnpm test:all > test-output.log 2>&1 || (echo "Tests failed — see test-output.log"; exit 1)
```

Manual smoke (already in the base improvements doc, kept here for completeness):

1. Start the daemon, open a Claude session, do a multi-turn conversation that includes at least one tool use.
2. Switch agent mid-session. Confirm the new agent's first response references prior context (proves Improvement 3's fix on real data, not synthetic).
3. Trigger a tool permission prompt and approve — confirm no hang (proves the simplified resolver path).
4. Confirm `agent_list` shows the model annotation for any SDK agent that declares one.
