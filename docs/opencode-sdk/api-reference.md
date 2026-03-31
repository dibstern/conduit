# OpenCode SDK JS — Full API Reference

Source: https://github.com/anomalyco/opencode-sdk-js/blob/main/api.md
Generated with Stainless from the OpenCode OpenAPI spec.

## Client Construction

```typescript
import Opencode from '@opencode-ai/sdk';
const client = new Opencode({
  maxRetries: 2,        // default
  timeout: 60 * 1000,   // 1 minute default
  fetch: customFetch,   // optional custom fetch
  logLevel: 'warn',     // 'debug' | 'info' | 'warn' | 'error' | 'off'
});
```

Supports custom `fetch`, proxy configuration, and logging.

## Shared Error Types

- `MessageAbortedError`
- `ProviderAuthError`
- `UnknownError`

Error classes: `BadRequestError` (400), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `UnprocessableEntityError` (422), `RateLimitError` (429), `InternalServerError` (>=500), `APIConnectionError`.

## Event (SSE)

Types: `EventListResponse`

- `client.event.list()` -> SSE stream of `EventListResponse`

```typescript
const stream = await client.event.list();
for await (const event of stream) {
  console.log(event);
}
```

## App

Types: `App`, `Mode`, `Model`, `Provider`, `AppInitResponse`, `AppLogResponse`, `AppModesResponse`, `AppProvidersResponse`

- `client.app.get()` -> `App`
- `client.app.init()` -> `AppInitResponse`
- `client.app.log({ body })` -> `AppLogResponse`
- `client.app.modes()` -> `AppModesResponse`
- `client.app.providers()` -> `AppProvidersResponse`

## Find

Types: `Symbol`, `FindFilesResponse`, `FindSymbolsResponse`, `FindTextResponse`

- `client.find.files({ query })` -> `FindFilesResponse`
- `client.find.symbols({ query })` -> `FindSymbolsResponse`
- `client.find.text({ query })` -> `FindTextResponse`

## File

Types: `File`, `FileReadResponse`, `FileStatusResponse`

- `client.file.read({ query })` -> `FileReadResponse`
- `client.file.status()` -> `FileStatusResponse`

## Config

Types: `Config`, `KeybindsConfig`, `McpLocalConfig`, `McpRemoteConfig`, `ModeConfig`

- `client.config.get()` -> `Config`

## Session

Types: `AssistantMessage`, `FilePart`, `FilePartInput`, `FilePartSource`, `FilePartSourceText`, `FileSource`, `Message`, `Part`, `Session`, `SnapshotPart`, `StepFinishPart`, `StepStartPart`, `SymbolSource`, `TextPart`, `TextPartInput`, `ToolPart`, `ToolStateCompleted`, `ToolStateError`, `ToolStatePending`, `ToolStateRunning`, `UserMessage`, `SessionListResponse`, `SessionDeleteResponse`, `SessionAbortResponse`, `SessionInitResponse`, `SessionMessagesResponse`, `SessionSummarizeResponse`

- `client.session.create()` -> `Session`
- `client.session.list()` -> `SessionListResponse`
- `client.session.delete(id)` -> `SessionDeleteResponse`
- `client.session.abort(id)` -> `SessionAbortResponse`
- `client.session.chat(id, { body })` -> `AssistantMessage` (POST /session/{id}/message — synchronous prompt)
- `client.session.init(id, { body })` -> `SessionInitResponse`
- `client.session.messages(id)` -> `SessionMessagesResponse`
- `client.session.revert(id, { body })` -> `Session`
- `client.session.share(id)` -> `Session`
- `client.session.summarize(id, { body })` -> `SessionSummarizeResponse`
- `client.session.unrevert(id)` -> `Session`
- `client.session.unshare(id)` -> `Session`

### Part Types (discriminated union)

- `TextPart` — `{ type: "text", text: string }`
- `ToolPart` — `{ type: "tool", ... state: ToolStateCompleted | ToolStateError | ToolStatePending | ToolStateRunning }`
- `FilePart` — `{ type: "file", ... }`
- `SnapshotPart` — `{ type: "snapshot", ... }`
- `StepStartPart` — `{ type: "step-start", ... }`
- `StepFinishPart` — `{ type: "step-finish", ... }`

### Message Types (discriminated union)

- `UserMessage` — `{ role: "user", ... }`
- `AssistantMessage` — `{ role: "assistant", ... }`

## TUI

Types: `TuiAppendPromptResponse`, `TuiOpenHelpResponse`

- `client.tui.appendPrompt({ body })` -> `TuiAppendPromptResponse`
- `client.tui.openHelp()` -> `TuiOpenHelpResponse`

## Undocumented Endpoints

Use `client.get()`, `client.post()`, etc. for undocumented endpoints:

```typescript
await client.post('/some/path', {
  body: { some_prop: 'foo' },
  query: { some_query_arg: 'bar' },
});
```

## Requirements

- TypeScript >= 4.9
- Node.js 20+ (LTS, non-EOL)
- Also: Deno 1.28+, Bun 1.0+, Cloudflare Workers, Vercel Edge
