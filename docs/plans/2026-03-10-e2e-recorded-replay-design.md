# E2E Recorded Session Replay

## Problem

The E2E test harness (`test/e2e/helpers/e2e-harness.ts`) deletes real production sessions from the user's OpenCode instance. During teardown, it snapshots the top 100 sessions (OpenCode's default API limit), then deletes any session not in that snapshot — catching real sessions when the 100-session window shifts between startup and teardown.

Additionally, E2E tests depend on a locally running `opencode serve` instance, making them non-portable and unsafe to run alongside active development work.

## Solution

Replace real-OpenCode E2E tests with **recorded session replay**: capture full WebSocket event sequences from a self-spawned, ephemeral OpenCode instance and replay them in tests via the existing WS mock infrastructure.

## Architecture

Three layers:

### 1. Recording Script (`pnpm test:record-snapshots`)

Runs against a **self-spawned OpenCode instance** on an ephemeral port:

1. Spawn `opencode serve --port {port}` with isolated `XDG_DATA_HOME` (temp dir)
2. Wait for health check
3. Start `RelayStack` pointed at spawned instance
4. Switch model to Big Pickle (free zen model)
5. For each of the 17 test prompts:
   - Connect WS client to relay
   - Send prompt, capture all server→client WS messages in order
   - Record init handshake messages (session_switched, status, model_info, session_list, etc.)
6. Write recorded fixtures to `test/e2e/fixtures/recorded/<scenario>.json`
7. Fetch live OpenAPI spec, compare against `test/fixtures/opencode-api-snapshot.json` — warn on drift
8. Kill OpenCode process (temp DB cleaned up automatically)

### 2. Replay Harness

Extends the existing `ws-mock.ts` pattern. Each recorded fixture:

```typescript
interface RecordedScenario {
  name: string;
  model: string;
  recordedAt: string;          // ISO timestamp
  initMessages: MockMessage[]; // Sent on WS connect
  turns: Array<{
    prompt: string;            // Exact prompt text
    events: MockMessage[];     // Full response sequence
  }>;
}
```

Converted specs load fixtures and use `mockRelayWebSocket()`:

```typescript
const scenario = loadRecordedScenario("chat-simple");
const control = await mockRelayWebSocket(page, {
  initMessages: scenario.initMessages,
  responses: new Map(scenario.turns.map(t => [t.prompt, t.events])),
});
```

### 3. Validation Layer

During snapshot recording:
- Fetch OpenAPI spec from live OpenCode, diff against committed snapshot
- Flag structural changes in SSE event shapes
- Output a validation report

## Spec Conversion Plan

### Convert to recorded replay (currently uses real OpenCode + LLM):

| Spec | Fixture Files | Prompts |
|------|--------------|---------|
| `chat.spec.ts` | `chat-simple.json`, `chat-code-block.json` | 5 simple response prompts |
| `chat-lifecycle.spec.ts` | `chat-tool-call.json`, `chat-result-bar.json`, `chat-multi-turn.json`, `chat-streaming.json`, `chat-thinking.json` | Tool use, token bar, banana memory, stop button, thinking blocks |
| `permissions.spec.ts` | `permissions-read.json`, `permissions-bash.json` | Permission cards for file read + bash |
| `advanced-ui.spec.ts` | `advanced-diff.json`, `advanced-mermaid.json` | File create/edit/read diffs, mermaid diagram |

### Convert to WS mock (currently uses real OpenCode, but no LLM prompts):

| Spec | Notes |
|------|-------|
| `smoke.spec.ts` | Use standard `initMessages` pattern |
| `sessions.spec.ts` | Mock session creation response |
| `sidebar-layout.spec.ts` | Pure layout testing |
| `ui-features.spec.ts` | Pure DOM structure |
| `pin-page.spec.ts` | Needs minimal HTTP server for `/auth` endpoint |
| `dashboard.spec.ts` | Needs HTTP for `/health`, `/setup` |

### Already mocked (no changes needed):

`visual-mockup.spec.ts`, `multi-instance.spec.ts`, `question-flow.spec.ts`, `subagent-sessions.spec.ts`, `variant-selector.spec.ts`

### Keep real OpenCode (1 minimal smoke test):

A single `live-smoke.spec.ts` that:
- Spawns ephemeral `opencode serve` with isolated XDG_DATA_HOME
- Uses Big Pickle model
- Sends one prompt ("Reply with pong")
- Confirms response received
- Kills process on teardown (no session cleanup needed — DB is ephemeral)

## Prompt Catalog

17 prompts across 4 spec files:

1. `Hello, reply with just the word pong`
2. `Reply with just the word 'pong'. Nothing else.`
3. `Reply with just the word 'ok'`
4. `Reply with just the word 'hello'.`
5. `Write a single JavaScript function called greet that returns 'hello'. Reply with ONLY the code block, no explanation.`
6. `Read the file package.json and tell me the exact value of the "version" field.`
7. `Reply with just the word 'ok'. Nothing else.` (result bar)
8. `Remember the word 'banana'. Reply with only: ok, remembered.`
9. `What word did I ask you to remember? Reply with just the word.`
10. `Write a paragraph explaining why automated testing is important for software quality.`
11. `Go away and think for a bit to plan how you'll write this, considering the best possible style, and write a 300 word essay on agentic ai context management`
12. `Read the file package.json and tell me the name field`
13. `List the files in the current directory using bash: ls -la`
14. `Create a file called /tmp/e2e-test-diff.txt with the text 'hello world'`
15. `Edit the file /tmp/e2e-test-diff.txt and change 'hello' to 'goodbye'`
16. `Read the file /tmp/e2e-test-diff.txt and tell me its contents`
17. `Draw a simple mermaid flowchart with 3 nodes: Start -> Process -> End. Use a mermaid code block.`

## Fixture File Format

```json
{
  "name": "chat-simple",
  "model": "big-pickle",
  "recordedAt": "2026-03-10T12:00:00Z",
  "initMessages": [
    { "type": "session_switched", "id": "ses_xxx" },
    { "type": "status", "status": "idle" },
    { "type": "model_info", "model": "big-pickle", "provider": "opencode" }
  ],
  "turns": [
    {
      "prompt": "Reply with just the word 'pong'. Nothing else.",
      "events": [
        { "type": "status", "status": "processing" },
        { "type": "user_message", "text": "..." },
        { "type": "delta", "content": "pong" },
        { "type": "result", "tokens": { "input": 50, "output": 5 } },
        { "type": "done" },
        { "type": "status", "status": "idle" }
      ]
    }
  ]
}
```

## Self-Spawned OpenCode Instance

Both the recording script and live smoke test spawn their own OpenCode:

```typescript
const port = await getEphemeralPort();
const tmpDir = await mkdtemp(path.join(os.tmpdir(), "opencode-e2e-"));
const proc = spawn("opencode", ["serve", "--port", String(port)], {
  env: { ...process.env, XDG_DATA_HOME: tmpDir },
  stdio: "pipe",
});
// Wait for health check, then proceed
// On teardown: proc.kill("SIGTERM"), rm -rf tmpDir
```

This ensures:
- No dependency on a pre-running OpenCode server
- Isolated database (test sessions never touch real data)
- Clean teardown (kill process, remove temp dir)

## Snapshot Validation

When `pnpm test:record-snapshots` runs:

1. Fetch `GET /openapi.json` (or equivalent) from spawned OpenCode
2. Deep-compare against `test/fixtures/opencode-api-snapshot.json`
3. Report: added/removed/changed endpoints, new fields, type changes
4. Optionally update the committed snapshot if `--update-schema` flag passed

This ensures mocks stay in sync with OpenCode's actual API surface.

## Migration Strategy

1. Build recording infrastructure first
2. Convert structural-only specs (smoke, sidebar-layout, etc.) to WS mocks — low risk
3. Record and convert LLM-dependent specs one at a time
4. Add live-smoke.spec.ts as the single real-OpenCode canary
5. Remove old e2e-harness.ts and test-fixtures.ts once all specs are converted
6. Update Playwright configs — most specs use `vite preview` server
