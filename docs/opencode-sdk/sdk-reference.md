# OpenCode SDK Reference

Type-safe JS client for the OpenCode server API, generated from the OpenAPI spec via `@hey-api/openapi-ts`.

## Install

```bash
npm install @opencode-ai/sdk
```

## Create Client (with server)

```typescript
import { createOpencode } from "@opencode-ai/sdk"
const { client } = await createOpencode()
```

Options: `hostname` (default `127.0.0.1`), `port` (default `4096`), `signal`, `timeout` (5000ms), `config`.

## Create Client Only (connect to existing server)

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({
  baseUrl: "http://localhost:4096",
})
```

Options: `baseUrl`, `fetch` (custom fetch), `parseAs`, `responseStyle` (`"data"` | `"fields"`, default `"fields"`), `throwOnError` (default `false`).

## Types

All types are generated from the OpenAPI spec:

```typescript
import type { Session, Message, Part } from "@opencode-ai/sdk"
```

Types file: https://github.com/anomalyco/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts

Key types: `Session`, `Message` (discriminated: `UserMessage | AssistantMessage`), `Part` (discriminated union), `Agent`, `Provider`, `SessionStatus`.

## API Surface

### Global
- `global.health()` -> `{ healthy: true, version: string }`

### App
- `app.log({ body })` -> `boolean`
- `app.agents()` -> `Agent[]`

### Project
- `project.list()` -> `Project[]`
- `project.current()` -> `Project`

### Path
- `path.get()` -> `Path`

### Config
- `config.get()` -> `Config`
- `config.providers()` -> `{ providers: Provider[], default: Record<string, string> }`

### Sessions
- `session.list()` -> `Session[]`
- `session.get({ path: { id } })` -> `Session`
- `session.children({ path: { id } })` -> `Session[]`
- `session.create({ body })` -> `Session`
- `session.delete({ path: { id } })` -> `boolean`
- `session.update({ path, body })` -> `Session`
- `session.init({ path, body })` -> `boolean` (analyze app, create AGENTS.md)
- `session.abort({ path })` -> `boolean`
- `session.share({ path })` -> `Session`
- `session.unshare({ path })` -> `Session`
- `session.summarize({ path, body })` -> `boolean`
- `session.messages({ path })` -> `{ info: Message, parts: Part[] }[]`
- `session.message({ path })` -> `{ info: Message, parts: Part[] }`
- `session.prompt({ path, body })` -> `AssistantMessage` (or `UserMessage` with `noReply: true`)
- `session.command({ path, body })` -> `{ info: AssistantMessage, parts: Part[] }`
- `session.shell({ path, body })` -> `AssistantMessage`
- `session.revert({ path, body })` -> `Session`
- `session.unrevert({ path })` -> `Session`
- `postSessionByIdPermissionsByPermissionId({ path, body })` -> `boolean` (reply to permission)

### Files
- `find.text({ query: { pattern } })` -> match objects
- `find.files({ query: { query, type?, directory?, limit? } })` -> `string[]`
- `find.symbol({ query: { query } })` -> `Symbol[]`
- `file.read({ query: { path } })` -> `{ type, content }`
- `file.status()` -> `File[]`

### Auth
- `auth.set({ path: { id }, body: { type, key } })` -> `boolean`

### Events (SSE)
- `event.subscribe()` -> SSE stream
  ```typescript
  const events = await client.event.subscribe()
  for await (const event of events.stream) {
    console.log("Event:", event.type, event.properties)
  }
  ```

### Structured Output
Supports `format: { type: "json_schema", schema: {...} }` in prompt body.

## Message Envelope

`session.messages()` returns `{ info: Message, parts: Part[] }[]` — NOT flat messages. The `info` contains message metadata, `parts` contains the content parts.

## Missing Endpoints (not in SDK)

These endpoints exist on the OpenCode server but are NOT in the SDK:
- `GET /permission` (list pending permissions)
- `POST /permission/{id}/reply` (reply to permission — non-deprecated path)
- `GET /question` (list pending questions)
- `POST /question/{id}/reply`
- `POST /question/{id}/reject`
- `GET /skill`
- `GET /session/{id}/message?limit=N&before=X` (paginated messages)
