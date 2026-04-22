# Claude Adapter sendTurn() Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Implement `sendTurn()` on `ClaudeAdapter` so conduit can run Claude sessions via the published Claude Agent SDK, completing Phase 6b of the orchestrator plan.

**Architecture:** `sendTurn()` creates one long-lived SDK `query()` per conduit session. The first turn creates a `PromptQueue` + `query()` + background stream consumer. Subsequent turns enqueue into the existing `PromptQueue`. The stream consumer reads `SDKMessage`s and translates them to canonical events via `ClaudeEventTranslator`. The `TurnResult` promise resolves when a `result` message arrives from the SDK.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` (published npm), Vitest, existing conduit provider adapter infrastructure.

**Reference Implementation:** `claude-relay/lib/sdk-bridge.js` — the `startQuery()` function (line 1927) and `processSDKMessage()` (line 196) show the production pattern for wiring the SDK.

---

## Pre-Task: SDK Type Alignment

### Task 0: Replace SDK Type Stubs with Real Imports

The existing `src/lib/provider/claude/types.ts` contains structural stubs for SDK types that were written before the SDK was published. Now that `@anthropic-ai/claude-agent-sdk` is installed and exports real types, replace the stubs with imports.

**Files:**
- Modify: `src/lib/provider/claude/types.ts`
- Modify: `src/lib/provider/claude/prompt-queue.ts`
- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Modify: `src/lib/provider/claude/claude-permission-bridge.ts`
- Modify: `src/lib/provider/claude/claude-adapter.ts`
- Modify: `test/unit/provider/claude/types.test.ts`
- Modify: `test/unit/provider/claude/prompt-queue.test.ts`
- Modify: `test/unit/provider/claude/claude-event-translator.test.ts`
- Modify: `test/unit/provider/claude/claude-permission-bridge.test.ts`
- Modify: `test/unit/provider/claude/claude-adapter-discover.test.ts`
- Modify: `test/unit/provider/claude/claude-adapter-lifecycle.test.ts`

**Step 1: Identify which types to import vs keep**

Types to **import from SDK** (delete stubs):
- `SDKMessage` (union of ~24 types)
- `SDKUserMessage`
- `SDKResultMessage` → actually `SDKResultSuccess | SDKResultError`
- `SDKSystemMessage`
- `SDKPartialAssistantMessage` (was `SDKStreamEventMessage`)
- `SDKAssistantMessage`
- `PermissionMode`
- `PermissionResult`
- `CanUseTool`
- `Query` (was `ClaudeQueryRuntime`)
- `Options` (query options)

Types to **keep** (conduit-specific, not in SDK):
- `ClaudeSessionContext`
- `PendingApproval`
- `PendingQuestion`
- `ToolInFlight`
- `PromptQueueController`
- `PromptQueueItem`
- `ClaudeResumeCursor`
- `ClaudeAdapterConfig`

**Step 2: Rewrite types.ts**

Replace the stub section with SDK imports:

```typescript
// src/lib/provider/claude/types.ts
import type {
	CanUseTool,
	Options as SDKOptions,
	PermissionMode,
	PermissionResult,
	Query,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
```

Delete all `SDK*` stub interfaces and type aliases. Re-export the imported types for convenience:

```typescript
export type {
	CanUseTool,
	PermissionMode,
	PermissionResult,
	Query,
	SDKAssistantMessage,
	SDKMessage,
	SDKOptions,
	SDKResultMessage,
	SDKSystemMessage,
	SDKUserMessage,
};
```

Update `ClaudeQueryRuntime` references: the real SDK exports `Query` which extends `AsyncGenerator<SDKMessage, void>` with control methods. Replace all `ClaudeQueryRuntime` references with `Query`.

Update `SDKStreamEventMessage` references: the real SDK calls this `SDKPartialAssistantMessage` with `type: 'stream_event'` and `event: BetaRawMessageStreamEvent`. The translator already handles `type === "stream_event"` via record access, so it just needs the import path change.

Update `SDKUserMessage`: the real type uses `message: MessageParam` instead of our custom `message` shape. The `PromptQueue` already treats it as opaque, so this is compatible. Test mocks need to use the real shape.

Update `PromptQueueController`: change `extends AsyncIterable<SDKUserMessage>` to use the imported `SDKUserMessage`.

Update `ClaudeSessionContext.query` type from `ClaudeQueryRuntime` to `Query`.

**Step 3: Update PromptQueue**

The `PromptQueue` imports `SDKUserMessage` from `./types.js`. After Task 0, that re-export points to the real SDK type. The `PromptQueue` class treats `SDKUserMessage` as opaque (it doesn't access any fields), so the implementation needs no changes — only the test mocks need updating to use the real `SDKUserMessage` shape.

**Step 4: Update event translator imports**

The `ClaudeEventTranslator` imports `SDKMessage`, `SDKResultMessage`, `ClaudeSessionContext`, `ToolInFlight` from `./types.js`. After the re-exports, `SDKMessage` and `SDKResultMessage` point to real SDK types. The translator uses `asRecord()` for field access (defensive against type shape changes), so the implementation should still compile. Verify with `pnpm check`.

The `SDKResultMessage` in the real SDK is `SDKResultSuccess | SDKResultError`. The translator's `translateResult` accesses `.subtype`, `.is_error`, `.errors`, `.usage`, `.total_cost_usd`, `.duration_ms` — all present on both variants. It should work, but verify.

**Step 5: Update permission bridge imports**

The `ClaudePermissionBridge` imports `CanUseTool`, `ClaudeSessionContext`, `PendingApproval`, `PermissionResult` from `./types.js`. After re-exports, `CanUseTool` and `PermissionResult` point to real SDK types.

The real `CanUseTool` signature is:
```typescript
(toolName: string, input: Record<string, unknown>, options: {
    signal: AbortSignal;
    toolUseID: string;
    suggestions?: PermissionUpdate[];
    blockedPath?: string;
    decisionReason?: string;
    agentID?: string;
}) => Promise<PermissionResult>
```

Our bridge's `createCanUseTool` uses `(toolName, toolInput, { signal, toolUseID })` — compatible since extra options fields are just ignored.

The real `PermissionResult` is a discriminated union:
```typescript
{ behavior: "allow"; updatedInput?: Record<string, unknown>; ... }
| { behavior: "deny"; message: string; interrupt?: boolean; ... }
```

Our bridge returns `{ behavior: "allow", updatedInput }` or `{ behavior: "deny", message }` — compatible.

**Step 6: Update adapter imports**

The `ClaudeAdapter` imports from `./types.js`. After re-exports, `Query` replaces `ClaudeQueryRuntime`. The adapter methods that access `ctx.query.interrupt()` and `ctx.query.close()` use methods present on the real `Query` interface.

**Step 7: Update all test files**

Test files that create mock `SDKMessage` objects need to use the real type shapes. The key difference: `SDKUserMessage.message` is now `MessageParam` (from Anthropic SDK) instead of our custom shape. For test mocks, construct objects that satisfy the real types.

> **Audit amendment (A1):** `MessageParam` is a complex type from `@anthropic-ai/sdk` (transitive dep). For test mocks, construct plain objects matching the structural shape and cast via `as unknown as SDKUserMessage`. Example:
> ```typescript
> const mockUserMsg = {
> 	type: "user" as const,
> 	message: { role: "user" as const, content: [{ type: "text", text: "hello" }] },
> 	parent_tool_use_id: null,
> } as unknown as SDKUserMessage;
> ```
> This is acceptable in test code (D2 allows `as unknown as T` in mocks). Do NOT import `MessageParam` directly — it bloats test dependencies.

**Step 8: Verify**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass. If any type errors, fix them.

**Commit:** `refactor: replace Claude SDK type stubs with real @anthropic-ai/claude-agent-sdk imports`

---

## Task 1: Rewrite ClaudeEventTranslator for Real SDK Types

The existing translator was written against 5 stub message types. The real SDK has ~24. Rewrite to handle the real types properly, using SDK type discriminants instead of `asRecord()` where possible.

**Files:**
- Modify: `src/lib/provider/claude/claude-event-translator.ts`
- Rewrite: `test/unit/provider/claude/claude-event-translator.test.ts`

**Step 1: Write tests for the real SDK message types**

Create comprehensive tests covering the message types the translator must handle:

1. **`system` (subtype `init`)** → `session.status` event with model capture
2. **`system` (subtype `status`)** → `session.status` event
3. **`system` (subtype `task_progress`)** → `turn.completed` with usage
4. **`stream_event` (content_block_start: text)** → `tool.started` for `__text`
5. **`stream_event` (content_block_start: thinking)** → `tool.started` for `__thinking`
6. **`stream_event` (content_block_start: tool_use)** → `tool.started` with tool name
7. **`stream_event` (content_block_delta: text_delta)** → `text.delta`
8. **`stream_event` (content_block_delta: thinking_delta)** → `thinking.delta`
9. **`stream_event` (content_block_delta: input_json_delta)** → `tool.running` + `tool.input_updated`
10. **`stream_event` (content_block_stop)** → `tool.completed` for text/thinking
11. **`assistant`** → capture `uuid` on context
12. **`user` (tool_result)** → `tool.completed` for matching in-flight tool
13. **`result` (success)** → `turn.completed` with tokens, cost, duration
14. **`result` (error)** → `turn.error`
15. **`result` (interrupted)** → `turn.interrupted`
16. **Unknown message types** (e.g., `status`, `rate_limit`, `prompt_suggestion`) → silently ignored

For test mocks, use the real SDK types. The `SDKPartialAssistantMessage` has `type: "stream_event"` and `event: BetaRawMessageStreamEvent`. For tests, create helper factories:

```typescript
function makeStreamEvent(event: Record<string, unknown>): SDKMessage {
	return { type: "stream_event", event, session_id: "test-session" } as unknown as SDKMessage;
}
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: FAIL (existing translator may partially work but tests for new types will fail)

**Step 3: Rewrite the translator**

Keep the same class shape (`ClaudeEventTranslatorDeps`, `translate()`, `translateError()`, `resetInFlightState()`). Rewrite internals:

- Keep `asRecord()` helpers for `stream_event` handling (the `BetaRawMessageStreamEvent` type from Anthropic SDK is complex; record access is simpler and matches the reference implementation)
- Add explicit handling for message types we care about: `system`, `stream_event`, `assistant`, `user`, `result`
- Add default case that silently ignores all other message types (status, rate_limit, prompt_suggestion, hook_*, task_*, etc.)
- The `SDKResultMessage` is now `SDKResultSuccess | SDKResultError`. Use the `subtype` discriminant:
  - `SDKResultSuccess` has `subtype: "success"` and `result?: string`
  - `SDKResultError` has `subtype: "error_max_turns" | "error_during_execution" | ...` and `errors: string[]`
- Keep the existing `stream_event` handling logic — it already processes `content_block_start`, `content_block_delta`, `content_block_stop` correctly via record access

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/provider/claude/claude-event-translator.test.ts`
Expected: All pass

**Step 5: Verify full suite**

Run: `pnpm check && pnpm test:unit`
Expected: All pass

**Commit:** `feat: rewrite ClaudeEventTranslator for real SDK message types`

---

## Task 2: Implement sendTurn() on ClaudeAdapter

This is the core task. Implement the `sendTurn()` method that creates an SDK `query()` on first turn and enqueues on subsequent turns.

**Files:**
- Modify: `src/lib/provider/claude/claude-adapter.ts`
- Create: `test/unit/provider/claude/claude-adapter-send-turn.test.ts`

> **Audit amendment (A2 — DI seam for SDK `query()`):** The adapter must NOT call `query()` directly from a top-level SDK import. Instead, add a `queryFactory` to `ClaudeAdapterDeps`:
> ```typescript
> export interface ClaudeAdapterDeps {
> 	readonly workspaceRoot: string;
> 	/** Injectable factory for the SDK's query() function. Defaults to the real SDK. */
> 	readonly queryFactory?: (params: { prompt: AsyncIterable<SDKUserMessage>; options?: SDKOptions }) => Query;
> }
> ```
> In the constructor, default to the real SDK:
> ```typescript
> import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
> // ...
> private readonly queryFactory: ClaudeAdapterDeps["queryFactory"];
> constructor(deps: ClaudeAdapterDeps) {
> 	this.queryFactory = deps.queryFactory ?? sdkQuery;
> }
> ```
> Then `sendTurn()` calls `this.queryFactory(...)` instead of `query(...)`. This lets tests inject `createMockQuery()` without `vi.mock()`. Task 3 integration tests use the same seam.

**Step 1: Write failing tests**

Test cases:

1. **First turn creates a new session**: Call `sendTurn()` with a new sessionId. Verify:
   - A `PromptQueue` is created
   - `query()` is called with the prompt queue and correct options
   - The initial user message is enqueued
   - A stream consumer is started
   - When the SDK emits a `result` message, `sendTurn()` resolves with a `TurnResult`

2. **Subsequent turn enqueues into existing session**: Call `sendTurn()` twice with the same sessionId. Second call should:
   - NOT create a new `query()`
   - Enqueue the message into the existing `PromptQueue`
   - Resolve when the next `result` message arrives

3. **Resume uses SDK resume option**: Call `sendTurn()` with `providerState` containing a `resumeSessionId`. Verify `query()` is called with `options.resume`.

4. **Abort signal propagates to SDK**: Pass an already-aborted signal. Verify `sendTurn()` rejects or the abort controller is wired.

5. **Stream consumer translates all messages**: Verify that messages from the SDK output stream are passed to `ClaudeEventTranslator.translate()`.

6. **Stream consumer handles errors**: If the SDK stream throws, verify `translateError()` is called and `sendTurn()` resolves with `status: "error"`.

7. **Concurrent sendTurn() for same session is serialized**: Two simultaneous `sendTurn()` calls for a new session — only one `query()` is created (per-session mutex).

8. **sendTurn() without persistence**: Verify graceful behavior when `eventSink` is the only required dep.

9. **Stream ends without result message**: Mock query that yields messages but completes without a `result`. Verify `sendTurn()` rejects with "SDK stream ended without result" (A3 amendment).

For all tests, **mock the SDK's `query()` function**. Create a mock that returns a controllable async generator:

```typescript
function createMockQuery(messages: SDKMessage[]): Query {
	const gen = (async function* () {
		for (const msg of messages) yield msg;
	})();
	return Object.assign(gen, {
		interrupt: vi.fn(async () => {}),
		close: vi.fn(),
		setModel: vi.fn(async () => {}),
		setPermissionMode: vi.fn(async () => {}),
		streamInput: vi.fn(async () => {}),
		// ... other Query methods as no-op mocks
	}) as unknown as Query;
}
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/provider/claude/claude-adapter-send-turn.test.ts`
Expected: FAIL (sendTurn throws "not implemented")

**Step 3: Implement sendTurn()**

The implementation follows the reference implementation pattern from `claude-relay/lib/sdk-bridge.js`:

```typescript
async sendTurn(input: SendTurnInput): Promise<TurnResult> {
	const { sessionId } = input;

	// Per-session mutex: prevent duplicate session creation
	const pending = this.sessionLocks.get(sessionId);
	if (pending) {
		await pending;
		return this.sendTurn(input);
	}

	const existingCtx = this.sessions.get(sessionId);
	if (existingCtx) {
		return this.enqueueTurn(existingCtx, input);
	}

	return this.createSessionAndSendTurn(input);
}
```

Key implementation details:

**a) createSessionAndSendTurn():**
1. Set session lock (synchronous, before any await)
2. Create a `PromptQueue`
3. Build initial `SDKUserMessage` from `input.prompt` (and `input.images`)
4. Enqueue the initial message
5. Build `query()` options:
   - `cwd: input.workspaceRoot`
   - `model: input.model?.modelId`
   - `includePartialMessages: true`
   - `abortController` from `input.abortSignal`
   - `canUseTool` from `ClaudePermissionBridge.createCanUseTool(ctx)`
   - `resume: providerState.resumeSessionId` (if present)
   - `settingSources: ["user", "project", "local"]`
6. Call `query({ prompt: promptQueue, options })`
7. Create `ClaudeSessionContext` with all fields populated
8. Store in `this.sessions`
9. Start background stream consumer (async IIFE)
10. Clear session lock
11. Return a promise that resolves when `result` message arrives

**b) enqueueTurn():**
1. Build `SDKUserMessage` from `input.prompt`
2. Enqueue into existing `ctx.promptQueue`
3. Return a promise that resolves when next `result` message arrives

**c) Stream consumer (runStreamConsumer):**

> **Audit amendment (A3 — cleanup on no-result):** The SDK query stream may end (iterator completes) without emitting a `result` message (e.g., process crash, network drop). The `finally` block below catches this and rejects the turn deferred so it doesn't hang forever. Also add test case 9 to cover this.

```typescript
private async runStreamConsumer(
	ctx: ClaudeSessionContext,
	translator: ClaudeEventTranslator,
): Promise<void> {
	try {
		for await (const message of ctx.query) {
			await translator.translate(ctx, message);
			if (message.type === "result") {
				this.resolveTurn(ctx, message);
			}
		}
	} catch (err) {
		await translator.translateError(ctx, err);
		this.rejectTurn(ctx, err);
	} finally {
		// If the stream ended without a result message, reject the pending turn
		// so sendTurn() doesn't hang forever.
		this.rejectTurnIfPending(ctx, new Error("SDK stream ended without result"));
	}
}
```

**d) Turn resolution:**
Use a per-session deferred (`turnDeferred: { resolve, reject }`) that `sendTurn()` awaits and `runStreamConsumer` resolves when a `result` message arrives. Convert the SDK's `SDKResultMessage` to a `TurnResult`:

```typescript
private sdkResultToTurnResult(result: SDKResultMessage): TurnResult {
	const isSuccess = result.subtype === "success";
	const isInterrupted = !isSuccess && isInterruptedResult(result);
	return {
		status: isSuccess ? "completed" : isInterrupted ? "interrupted" : "error",
		cost: result.total_cost_usd ?? 0,
		tokens: {
			input: result.usage?.input_tokens ?? 0,
			output: result.usage?.output_tokens ?? 0,
			...(result.usage?.cache_read_input_tokens != null
				? { cacheRead: result.usage.cache_read_input_tokens }
				: {}),
		},
		durationMs: result.duration_ms ?? 0,
		...(!isSuccess && !isInterrupted && "errors" in result
			? { error: { code: result.subtype, message: result.errors?.join("; ") ?? "Unknown error" } }
			: {}),
		providerStateUpdates: [
			...(ctx.resumeSessionId
				? [{ key: "resumeSessionId", value: ctx.resumeSessionId }]
				: []),
			...(ctx.lastAssistantUuid
				? [{ key: "lastAssistantUuid", value: ctx.lastAssistantUuid }]
				: []),
			{ key: "turnCount", value: ctx.turnCount },
		],
	};
}
```

**e) Building SDKUserMessage from input.prompt:**

```typescript
private buildUserMessage(input: SendTurnInput): SDKUserMessage {
	const content: Array<{ type: string; text?: string; source?: unknown }> = [];
	if (input.images) {
		for (const img of input.images) {
			content.push({
				type: "image",
				source: { type: "base64", media_type: "image/png", data: img },
			});
		}
	}
	content.push({ type: "text", text: input.prompt });
	return {
		type: "user",
		message: { role: "user", content },
		parent_tool_use_id: null,
	} as unknown as SDKUserMessage;
}
```

**Step 4: Run tests**

Run: `pnpm vitest run test/unit/provider/claude/claude-adapter-send-turn.test.ts`
Expected: All pass

**Step 5: Verify full suite**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Commit:** `feat: implement ClaudeAdapter.sendTurn() — SDK query lifecycle and stream consumer`

---

## Task 3: Wire sendTurn into Orchestration + Integration Tests

Verify the full dispatch path works: `OrchestrationEngine.dispatch(SendTurnCommand)` → `ClaudeAdapter.sendTurn()` → SDK `query()` → stream consumer → canonical events via EventSink.

**Files:**
- Modify: `test/unit/provider/orchestration-engine.test.ts`
- Modify: `test/unit/provider/claude/provider-wiring.test.ts`

> **Audit amendment (A4 — explicit test cases and mock strategy):** The mock opencode adapter's `sendTurn` stub in provider-wiring.test.ts (line 50) is on a mock used for multi-provider listing tests — leave it as-is. For integration tests, use the `queryFactory` DI seam from A2 to inject `createMockQuery()` into a real `ClaudeAdapter`. Extract `createMockQuery()` to `test/helpers/mock-sdk.ts` so both Task 2 unit tests and Task 3 integration tests can reuse it.

**Step 1: Extract shared mock helper**

Create `test/helpers/mock-sdk.ts` with `createMockQuery()` (the helper from Task 2's test). Both Task 2 and Task 3 test files import from here.

**Step 2: Add integration tests in orchestration-engine.test.ts**

Add a new `describe("Claude adapter integration")` section with these test cases:

1. **Happy path dispatch**: Create a real `ClaudeAdapter` with `queryFactory: () => createMockQuery([resultMessage])`. Register it in `ProviderRegistry`. Dispatch `SendTurnCommand` with `providerId: "claude"`. Verify `TurnResult` returned with `status: "completed"` and correct cost/tokens.

2. **Session binding persists after sendTurn**: Dispatch sendTurn for Claude, verify `engine.getProviderForSession(sessionId)` returns `"claude"`.

3. **Error propagation**: Create `ClaudeAdapter` with `queryFactory` that returns a mock query throwing an error. Dispatch sendTurn. Verify `TurnResult` has `status: "error"`.

4. **sendTurn failure leaves stale binding (known issue)**: Document that `OrchestrationEngine.handleSendTurn()` sets the session binding *before* calling `adapter.sendTurn()` (line 146 vs 152 of orchestration-engine.ts). If sendTurn throws synchronously, the binding is stale. Test this and mark with `// Known issue: binding set before sendTurn — stale on failure`.

**Step 3: Add wiring test in provider-wiring.test.ts**

5. **End-to-end Claude wiring**: Create real `ProviderRegistry` + `ClaudeAdapter` (with `queryFactory` mock) + `OrchestrationEngine`. Dispatch sendTurn with `providerId: "claude"`. Verify result flows back through the full stack.

**Step 3: Run tests**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Commit:** `test: add Claude adapter sendTurn integration tests for orchestration engine`

---

## Task 3.5: E2E Test with Real Claude Agent SDK

Add an E2E test that calls the real Claude Agent SDK with a live API key, verifying the full `sendTurn()` → SDK `query()` → stream consumer → canonical events pipeline works against the real service.

**Files:**
- Create: `test/e2e/provider/claude-adapter-real-sdk.test.ts`
- Modify: `package.json` (add `test:e2e:expensive-real-prompts` script)

**Gating:** This test is expensive (real API calls, real money). It runs ONLY via `pnpm test:e2e:expensive-real-prompts`, never in `pnpm test` or `pnpm test:unit`. Gate with:

```typescript
import { describe, it, expect } from "vitest";

const RUN_EXPENSIVE = process.env.RUN_EXPENSIVE_E2E === "1";

describe.skipIf(!RUN_EXPENSIVE)("ClaudeAdapter E2E (real SDK)", () => {
```

**Step 1: Add the npm script**

In `package.json`, add:
```json
"test:e2e:expensive-real-prompts": "RUN_EXPENSIVE_E2E=1 vitest run test/e2e/provider/"
```

**Step 2: Write the E2E test**

Test case:

1. **Full turn with Haiku**: Create a real `ClaudeAdapter` with NO `queryFactory` override (uses real SDK). Create a real `EventSink` that collects pushed canonical events into an array. Call `sendTurn()` with:
   - `prompt: "Reply with exactly: hello world"`
   - `model: { providerId: "claude", modelId: "claude-haiku-3-5" }` (cheapest model)
   - `workspaceRoot: process.cwd()`
   - A real `AbortSignal`
   - `eventSink` that collects events

   Verify:
   - `sendTurn()` resolves with a `TurnResult` with `status: "completed"`
   - `TurnResult.tokens.input > 0` and `TurnResult.tokens.output > 0`
   - The collected events include at least one `text.delta` event
   - The collected events include a `turn.completed` event
   - Total cost is under $0.01 (sanity check)

   Set a 60-second timeout for the test.

**Step 3: Verify**

Run: `pnpm test:e2e:expensive-real-prompts` (requires `ANTHROPIC_API_KEY` in env)
Expected: Pass (1 test, ~5-15 seconds, ~$0.001 cost)

Without the env var, verify: `pnpm test:unit` still passes and the E2E test is skipped.

**Commit:** `test: add real-SDK E2E test for ClaudeAdapter.sendTurn() (gated behind RUN_EXPENSIVE_E2E)`

---

## Task 4: Update PROGRESS.md and Clean Up

**Files:**
- Modify: `docs/PROGRESS.md`

**Step 1: Update progress tracking**

Mark Tasks 48-50 (or their equivalents in the new numbering) as complete. Update stats.

**Step 2: Remove "not yet available" comments**

Search the codebase for any remaining "SDK not available" or "not yet published" comments and remove them:

```bash
rg -n 'not yet available\|not yet published\|not implemented.*Claude Agent SDK\|SDK is not yet' src/
```

Fix any found.

**Step 3: Verify**

Run: `pnpm check && pnpm lint && pnpm test:unit`
Expected: All pass

**Commit:** `docs: mark Claude sendTurn tasks complete, remove SDK-not-available comments`

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 0 | Replace SDK type stubs with real imports | Update all existing tests |
| 1 | Rewrite ClaudeEventTranslator for real SDK types | 16+ test cases |
| 2 | Implement sendTurn() on ClaudeAdapter (with queryFactory DI seam) | 9 test cases |
| 3 | Wire into orchestration + integration tests (shared mock helper) | 5 test cases |
| 3.5 | E2E test with real SDK (Haiku, gated behind `RUN_EXPENSIVE_E2E`) | 1 test case |
| 4 | Update progress, clean up | Verification grep |

---

## Audit Amendments Applied

| ID | Finding | Task | Amendment |
|----|---------|------|-----------|
| A1 | `MessageParam` import bloat in test mocks | 0 | Added guidance to use `as unknown as SDKUserMessage` casts in tests, avoid importing `MessageParam` directly |
| A2 | No DI seam for SDK `query()` function | 2 | Added `queryFactory` to `ClaudeAdapterDeps` with default to real SDK, enabling test injection |
| A3 | Stream consumer hangs if query ends without `result` | 2 | Added `finally` block with `rejectTurnIfPending()`, added test case 9 |
| A4 | Task 3 underspecified — no test cases, no mock strategy | 3 | Enumerated 5 specific test cases, added shared `test/helpers/mock-sdk.ts` helper, clarified mock opencode stub is unchanged |
