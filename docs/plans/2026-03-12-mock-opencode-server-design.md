# Mock OpenCode Server Design

## Problem

All 17 integration test files (118 tests) are skipped because they require a running OpenCode instance. The E2E Playwright tests mock at the browser WebSocket level, bypassing the relay entirely. Neither test type exercises the full stack: Browser -> Relay -> OpenCode.

## Solution

Replace the real OpenCode dependency with a **record+replay mock HTTP server**. Both integration and E2E tests run against a real relay backed by this mock. The only fake is the external dependency.

## Architecture

### Before

```
E2E replay:   Browser -> mocked WS (no relay involved)
Integration:  WS client -> real relay -> real OpenCode (skipped if unavailable)
Contract:     direct HTTP -> real OpenCode (skipped if unavailable)
```

### After

```
E2E:          Browser -> real relay -> mock OpenCode server
Integration:  WS client -> real relay -> mock OpenCode server
Contract:     direct HTTP -> real OpenCode (unchanged, still skip-if-unavailable)
```

## Recording Pipeline

### Recording Proxy

A transparent HTTP proxy inserted between the relay and real OpenCode during recording. Captures every interaction:

- **REST**: method, path, request body, response status, response body
- **SSE**: every event on `/event` with timestamps relative to the triggering `prompt_async`
- **PTY WebSocket**: forwarded for terminal scenarios

```
During recording:
  OpenCode <- Recording Proxy <- RelayStack <- WS client
                   |
            saves .opencode.json fixtures
```

### Extended record-snapshots.ts

The existing `test/e2e/scripts/record-snapshots.ts` is extended to:

1. Spawn ephemeral OpenCode (already done)
2. Start recording proxy on ephemeral port, forwarding to OpenCode
3. Point RelayStack at the proxy (instead of directly at OpenCode)
4. Run scenarios as before (connect WS, send prompts, collect events)
5. Save `.opencode.json` fixtures from the proxy's captured interactions
6. Continue saving `.json` WS fixtures during transition (removed once migration completes)

### Fixture Format

One `.opencode.json` file per scenario, containing an ordered sequence of all HTTP interactions and SSE events:

```typescript
interface OpenCodeRecording {
  name: string;
  recordedAt: string;
  opencodeVersion: string;

  interactions: Array<
    | {
        kind: "rest";
        method: string;
        path: string;         // e.g. "/session" or "/session/ses_abc123"
        requestBody?: unknown;
        status: number;
        responseBody: unknown;
      }
    | {
        kind: "sse";
        type: string;         // e.g. "message.part.delta"
        properties: Record<string, unknown>;
        delayMs: number;      // relative to previous event
      }
  >;
}
```

### Request Matching (Queued Replay)

The mock builds response queues keyed by request signature (method + path pattern):

```
Recording captures (in order):
  1. GET  /path              -> { cwd: "/tmp/test" }
  2. GET  /session           -> [{ id: "ses_1", title: "Test" }]
  3. POST /session           -> { id: "ses_2", title: "New" }
  4. GET  /session           -> [{ id: "ses_1" }, { id: "ses_2" }]
  5. DELETE /session/ses_2   -> 204
  6. GET  /session           -> [{ id: "ses_1" }]

Mock builds queues:
  "GET /path"            -> [response_1]
  "GET /session"         -> [response_2, response_4, response_6]
  "POST /session"        -> [response_3]
  "DELETE /session/:id"  -> [response_5]
```

Each incoming request matches a queue by method + path pattern, dequeues the next response. Path parameters (`/session/:id`) are matched by pattern, not literal string. If a queue is exhausted, the mock returns the last recorded response (handles polling endpoints).

SSE events are queued similarly. When `POST /session/:id/prompt_async` is dequeued, the mock streams the next batch of recorded SSE events until the next REST interaction or end of batch.

No programmatic CRUD logic. No invented responses. Every response the mock serves was captured from a real OpenCode instance.

### Queue Desync as a Signal

If the relay changes its call pattern between recording and replay (e.g., a code change adds an extra poll), the queues desync and tests fail. This is a useful signal that recordings need refreshing, which the contract tests also validate.

## Mock Server Implementation

`test/helpers/mock-opencode-server.ts` -- a Node.js `http.createServer` that:

1. Loads an `OpenCodeRecording` fixture
2. Groups `rest` interactions into queues by method + path pattern
3. Groups `sse` interactions into batches between `prompt_async` calls
4. Serves REST responses by dequeuing from the matching queue
5. Streams SSE events on `GET /event` (emits batches when triggered by `prompt_async`)
6. Forwards PTY WebSocket upgrades if the recording includes them
7. Listens on an ephemeral port (port 0)

## Test Changes

### Integration Tests

The relay harness (`test/integration/helpers/relay-harness.ts`) changes from:

```typescript
const available = await isOpenCodeRunning();
describe.skipIf(!available)("...", () => { ... });
```

To:

```typescript
let mockServer: MockOpenCodeServer;
beforeAll(async () => {
  mockServer = await startMockOpenCode("scenario-name");
  // RelayStack points at mockServer.url instead of localhost:4096
});
afterAll(() => mockServer.stop());
```

No skip logic. All 118 tests run in every environment.

### E2E Playwright Tests

Remove `page.routeWebSocket()` interception. The Playwright config starts a real relay backed by the mock:

```
globalSetup / per-test fixture:
  1. Start mock OpenCode server with recording
  2. Start relay (staticDir=dist/frontend, opencodeUrl=mock's URL)
  3. Playwright browses to relay's URL
```

Tests keep their existing DOM assertions. The difference is the full relay stack is exercised.

### Contract Tests

Unchanged. They validate the real OpenCode API and continue to skip when no server is available.

## Scenario Coverage

Each test needs a recording. Some recordings are shared:

| Integration test file | Recording |
|---|---|
| initial-state | `chat-simple` (init responses sufficient) |
| send-message | `chat-simple` |
| session-lifecycle | New: `session-crud` |
| terminal | New: `terminal-io` |
| error-handling | `chat-simple` (tests relay resilience) |
| multi-client | `chat-simple` (tests relay broadcast) |
| per-tab-sessions | New: `multi-session` |
| model-selection | `chat-simple` or new `model-switch` |
| cancel-lifecycle | New: `cancel-flow` |
| message-lifecycle | `chat-simple` |
| sse-consumer | `chat-simple` |
| sse-to-ws-pipeline | `chat-simple` |
| rest-client | New: `rest-crud` |
| ws-handler-coverage | New: `ws-coverage` |
| discovery-endpoints | `chat-simple` |
| session-switch-history | New: `multi-session` |
| switch-to-streaming-session | New: `streaming-switch` |

Exact list refined during implementation.

## Recording Refresh Workflow

```bash
# Re-record all fixtures (spawns ephemeral OpenCode)
pnpm test:record-snapshots

# Validate recordings still match live API
pnpm test:contract
```

## File Organization

```
test/
  helpers/
    mock-opencode-server.ts     # Replay HTTP server
    recording-proxy.ts          # HTTP proxy for capturing interactions
    opencode-utils.ts           # (existing, kept for contract tests)

  e2e/
    scripts/
      record-snapshots.ts       # Extended to use recording proxy
    fixtures/
      recorded/
        chat-simple.json              # WS fixture (removed after migration)
        chat-simple.opencode.json     # OpenCode HTTP-level recording
        types.ts                      # Extended with OpenCodeRecording type
    helpers/
      recorded-loader.ts        # Extended to load .opencode.json
      ws-mock.ts                # Removed after migration
      e2e-harness.ts            # Updated: starts mock server

  integration/
    helpers/
      relay-harness.ts          # Updated: starts mock server, removes skip
    flows/
      *.integration.ts          # Updated: remove describe.skipIf
```

## Migration Order

1. Build recording proxy (`recording-proxy.ts`) and mock server (`mock-opencode-server.ts`)
2. Extend `record-snapshots.ts` to produce `.opencode.json` fixtures
3. Run recording to generate initial fixtures
4. Migrate integration tests: update harness, remove skip logic, verify 118 tests pass
5. Migrate E2E Playwright tests: update harness, remove WS mocking, verify specs pass
6. Clean up: remove WS fixtures, `ws-mock.ts`, dead code
