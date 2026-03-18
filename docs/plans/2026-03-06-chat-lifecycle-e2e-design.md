# Chat Lifecycle E2E Tests — Design

## Problem

The frontend store tests (`svelte-chat-store.test.ts`, `ws-message-dispatch.test.ts`, etc.) test chat message lifecycle behaviors by calling store functions directly with crafted payloads and mocked dependencies. While the existing `chat.spec.ts` E2E test covers basic send/receive, it does not exercise:

- Tool call lifecycle (pending → running → completed)
- Tool result content rendering
- Result bar with token/cost info
- Thinking block lifecycle
- Multi-turn conversation rendering
- Streaming state indicators (stop button)

These are real user-facing behaviors that could silently break if the relay protocol, SSE translation, or Svelte rendering change.

## Approach

**Full Playwright E2E** against a real OpenCode instance via the existing `E2EHarness` infrastructure. New tests supplement (not replace) existing unit tests — unit tests remain for edge cases requiring mocks (debounce timing, rate limiting, error codes, malformed messages).

Uses a free-tier model to avoid costs (configured via `E2E_MODEL` / `E2E_PROVIDER` env vars, same as existing `chat.spec.ts`).

## Files to Create/Modify

### New: `test/e2e/specs/chat-lifecycle.spec.ts`

Sequential test suite with 90s timeout per test (matching `chat.spec.ts`). Desktop viewport only to avoid duplicate LLM calls across viewports.

### Modified: `test/e2e/page-objects/chat.page.ts`

New methods added to `ChatPage`:

| Method | Selector | Purpose |
|--------|----------|---------|
| `waitForToolBlock(timeout?)` | `.tool-item` | Wait for any tool block to appear |
| `waitForToolCompleted(timeout?)` | `.tool-bullet.bg-success` | Wait for a tool to reach completed state |
| `getToolBlockCount()` | `.tool-item` | Count tool blocks |
| `waitForResultBar(timeout?)` | `.result-bar` | Wait for result bar to appear |
| `getResultBarText()` | `.result-bar` | Get token/cost text |
| `waitForThinkingBlock(timeout?)` | `.thinking-block` | Wait for thinking block |
| `isProcessing()` | `#stop` | Check if stop button is visible |

## Tests

### 1. Tool call lifecycle

**Prompt:** "Read the file package.json and tell me the project name. Use the read_file tool."

**Assertions:**
- `.tool-item` becomes visible (tool block rendered)
- `.tool-bullet.bg-success` appears (tool completed successfully)
- Assistant message appears after tool result with non-empty text

### 2. Tool result content accuracy

**Prompt:** Same as above (reuses response from test 1 if sequential)

**Assertions:**
- Assistant text mentions the project name from `package.json` (e.g., "opencode-relay")
- Validates the full pipeline: OpenCode reads file → SSE events → relay translates → browser renders

### 3. Result bar after response

**Prompt:** Any prompt that completes (e.g., "Reply with just 'ok'")

**Assertions:**
- `.result-bar` element is visible after streaming completes
- Result bar text contains token indicators (matches `/\d+\s*(in|out)/` or similar)

### 4. Multi-turn conversation

**Prompt 1:** "Remember the word 'banana'. Reply with just 'ok, remembered'."
**Prompt 2:** "What word did I ask you to remember? Reply with just the word."

**Assertions:**
- 2 `.msg-user` elements visible
- 2 `.msg-assistant` elements visible (both with non-empty `.md-content`)
- Messages appear in correct order (user, assistant, user, assistant)
- Second assistant response contains "banana"

### 5. Streaming state indicators

**Prompt:** "Write a short paragraph about testing."

**Assertions:**
- `#stop` button becomes visible during processing
- `#stop` button disappears after streaming completes
- `#send` button is visible after completion

### 6. Thinking block (conditional)

**Prompt:** A reasoning-heavy prompt (e.g., "Think step by step: what is 17 * 23?")

**Precondition:** Skip if current model doesn't support extended thinking.

**Assertions:**
- `.thinking-block` appears
- Thinking block contains text content
- `.thinking-block.done` eventually appears (thinking completes)

## Assertion Strategy

All assertions use flexible matching to handle LLM non-determinism:
- Check **existence/visibility**, not exact text
- Use `toContain()` for keywords, not `toBe()` for full text
- Use generous timeouts (60-90s) for LLM responses
- Use `test.skip()` for model-dependent features (thinking)

## Selectors Reference

| Element | Selector | State indicators |
|---------|----------|-----------------|
| Tool block | `.tool-item` | `[data-tool-id]` |
| Tool status bullet | `.tool-bullet` | `.bg-success` (done), `.bg-error` (error), `animate-*` (running) |
| Tool subtitle | `.tool-subtitle-text` | Text: "Done", "Running...", "Error" |
| Result bar | `.result-bar` | Always visible when present |
| Thinking block | `.thinking-block` | `.done` class when complete |
| Thinking content | `.thinking-content` | Visible when expanded |
| Stop button | `#stop` | Present only during processing |
| Send button | `#send` | `.stop` class during processing (legacy) |
| User message | `.msg-user` | — |
| Assistant message | `.msg-assistant` | `.md-content` for rendered content |

## Test Isolation

- Worker-scoped `E2EHarness` (one relay per test file)
- Tests run sequentially within the describe block
- Each test waits for streaming to complete before returning
- Session cleanup handled by harness teardown
