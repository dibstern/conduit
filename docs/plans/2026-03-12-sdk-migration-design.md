# OpenCode SDK Migration Design

## Problem

The relay maintains a hand-rolled `OpenCodeClient` (~691 lines, 40+ methods) with manually maintained TypeScript types for all API entities. This creates maintenance burden: every time OpenCode adds or changes an API endpoint, we must update the client and types manually. The types can drift from reality.

## Solution

Replace `OpenCodeClient` with the `@opencode-ai/sdk` package, which provides a type-safe client auto-generated from OpenCode's OpenAPI specification via `@hey-api/openapi-ts`.

## Design

### SDK Client (`OpencodeClient`)

The SDK provides `createOpencodeClient({ baseUrl, fetch, ... })` returning an `OpencodeClient` with namespaced methods:
- `client.session.list()`, `client.session.create()`, `client.session.promptAsync()`, etc.
- `client.pty.list()`, `client.pty.create()`, `client.pty.remove()`, `client.pty.update()`
- `client.config.get()`, `client.config.update()`
- `client.event.subscribe()` (SSE)
- ~60+ typed methods covering nearly all OpenCode endpoints

### Custom Fetch Wrapper (`relay-fetch.ts`)

The SDK accepts a custom `fetch` function. We inject relay-specific behaviors:
- HTTP Basic Auth (`Authorization: Basic ...`)
- `x-opencode-directory` header for daemon multi-project scoping
- Retry logic (2 retries, linear backoff on 5xx, matching existing behavior)
- Timeout via `AbortSignal.any()` (Node 20+)
- Throws `OpenCodeConnectionError` after retry exhaustion (matching existing behavior)

### Composition-Based Client (`RelayClient`)

`RelayClient` uses **composition** (not inheritance) to wrap the SDK's `OpencodeClient`. It exposes the **same flat API** as the current `OpenCodeClient`:
- `client.listSessions()`, `client.getMessages(id)`, `client.createSession()`, etc.
- All normalization (messages, providers, sessions) is handled internally
- Custom endpoints for paths not in the SDK use raw `fetch` with auth/retry

This means consumer code needs only **import path changes**, not method-call rewrites.

**Configuration:** `responseStyle: "data"` with `throwOnError: true` — methods return data directly and throw on error, matching existing behavior.

### Custom Endpoints (NOT in SDK)

Seven endpoints are missing from the SDK. `RelayClient` handles them via raw `fetch`:
- `listPendingPermissions()` — `GET /permission`
- `replyPermission()` — `POST /permission/{id}/reply` (non-deprecated; SDK's `/session/{id}/permissions/{permissionID}` is deprecated)
- `listPendingQuestions()` — `GET /question`
- `replyQuestion()` — `POST /question/{id}/reply`
- `rejectQuestion()` — `POST /question/{id}/reject`
- `listSkills()` — `GET /skill`
- `getMessagesPage()` — `GET /session/{id}/message?limit=N&before=X`

Also exposes `getBaseUrl()` and `getAuthHeaders()` for SSE consumer and PTY WebSocket upstream.

### Internal Normalizations

`RelayClient` preserves existing normalization logic internally:
- **Messages:** `getMessages()` calls `normalizeMessages()` to flatten `{ info, parts }` envelopes into flat `Message` objects with embedded parts
- **Providers:** `listProviders()` normalizes `{ all, default, connected }` response: renames fields (`all`→`providers`, `default`→`defaults`), converts models from keyed objects to arrays
- **Sessions:** `listSessions()` handles both array and object-keyed server responses
- **Prompt:** `sendMessageAsync()` converts `PromptOptions.text`/`images` to SDK `parts[]` body format

### SSE and PTY

A parallel investigation spike determines whether `event.subscribe()` and `pty.connect()` can replace our custom `SSEConsumer` and `pty-upstream.ts`. The REST migration proceeds independently regardless of spike outcome.

### What Stays Custom

- `InstanceManager` — process lifecycle, crash recovery, port management (orthogonal to SDK)
- `SSEConsumer` — unless spike proves SDK SSE is sufficient
- `pty-upstream.ts` — WebSocket data channel, duck-typed `{ getAuthHeaders() }` interface works with `RelayClient`
- Relay-side types (`SessionInfo`, `HistoryMessage`, `OpenCodeEvent`, `PendingPermission`, etc.) — transformed shapes for browser clients

## Resolved Questions

1. **Permission reply path:** Server's `POST /permission/{id}/reply` is non-deprecated. SDK's `/session/{id}/permissions/{permissionID}` is deprecated. Use old path.
2. **Message normalization:** Normalized inside `RelayClient.getMessages()`. Consumers never see `{ info, parts }` envelopes.
3. **`responseStyle`:** `"data"` with `throwOnError: true`. Methods return data directly, errors throw. No `.data` extraction needed.
4. **Provider endpoint:** `provider.list()` (`GET /provider`) consistently. Returns `connected` array which `config.providers()` lacks.
5. **Architecture:** Composition over inheritance. `RelayClient` wraps `OpencodeClient`, exposes flat API.
6. **Node.js:** Minimum bumped from 18 to 20 (enables `AbortSignal.any()`).

## Files Changed

| Action | File | Reason |
|---|---|---|
| Create | `src/lib/instance/relay-fetch.ts` | Custom fetch wrapper |
| Create | `src/lib/instance/sdk-client.ts` | Composition-based `RelayClient` |
| Create | `src/lib/instance/relay-types.ts` | Permanent home for relay-internal types |
| Delete | `src/lib/instance/opencode-client.ts` | Replaced by RelayClient |
| Modify | `src/lib/relay/relay-stack.ts` | Client construction + import swap |
| Modify | `src/lib/session/session-manager.ts` | Import swap |
| Modify | `src/lib/session/session-status-poller.ts` | Import swap |
| Modify | `src/lib/bridges/client-init.ts` | Import swap |
| Modify | `src/lib/handlers/*.ts` (agent.ts needs `filterAgents` adaptation) | Import swap |
| Modify | `src/lib/relay/message-poller.ts` | Import swap |
| Modify | `src/lib/relay/message-poller-manager.ts` | Import swap |
| Modify | `src/lib/relay/status-transitions.ts` | Import swap |
| Modify | `src/lib/relay/sse-wiring.ts` | Import swap |
| Modify | `src/lib/daemon/daemon.ts` | Import swap |
| Modify | `test/helpers/mock-factories.ts` | Update mock return type |
| Modify | 10 test files | Import path updates |
| Modify | `src/lib/types.ts` | Remove redundant types |
| Modify | `package.json` | Add SDK dep, bump Node minimum to 20 |

## Verification

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

Plus manual smoke test: session CRUD, messaging, permissions, PTY, file browser, model switching, SSE streaming, message normalization.
