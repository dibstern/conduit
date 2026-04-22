# OpenCode Client → SDK Migration Design

**Date:** 2026-04-10
**Status:** Approved
**Branch:** feature/orchestrator-implementation

## Context

The orchestrator implementation (55/55 tasks) replaced the old in-memory relay with a SQLite event store + provider adapter architecture. The hand-rolled `OpenCodeClient` (691 lines, 42 methods) survived the orchestrator work unchanged. It still wraps every OpenCode REST call with native `fetch`, custom retry logic, Basic Auth, and message normalization.

The `@opencode-ai/sdk` v1.3.0 (auto-generated from OpenAPI) provides typed wrappers for ~35 of those 42 endpoints, plus SSE streaming via `event.subscribe()`. Five endpoints remain uncovered by the SDK.

This design replaces `OpenCodeClient` with the SDK, adopts SDK types as canonical throughout the codebase, and migrates SSE consumption to the SDK's streaming API.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Migration scope | Full replacement | SDK where it covers, raw-fetch for gaps. Delete hand-rolled HTTP layer. |
| Retry strategy | Custom fetch adapter | Injected into `createOpencodeClient({ fetch: retryFetch })`. Same backoff logic, applied transparently. |
| Type adoption | SDK types everywhere | `Session`, `UserMessage`, `AssistantMessage`, `Part` (11-type union), `Event` (20+ discriminated variants) become canonical. Largest change but best type safety. |
| SSE migration | Yes, SDK `event.subscribe()` | Replace manual SSE parser. Keep reconnection/health wrapper. |
| API style | SDK namespaced | `api.session.list()`, `api.permission.reply()`. Callers use SDK-style namespaces. |
| Gap endpoint visibility | Hybrid | Internal `gapEndpoints` field for maintainer clarity. Public API is unified namespaces — callers don't know which methods are SDK vs. raw-fetch. |
| Migration approach | Layered inside-out | Foundation → Client swap → Type migration → SSE migration → Cleanup. System works at every phase boundary. |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Callers (handlers, session-manager, wiring...)  │
│  ← Use SDK types directly                        │
└──────────────┬──────────────────┬───────────────┘
               │                  │
    ┌──────────▼──────────┐  ┌───▼──────────────────┐
    │  OpenCodeAPI         │  │  SSEStream            │
    │  ─ SDK for ~35 calls │  │  ─ sdk.event.subscribe│
    │  ─ raw fetch for ~5  │  │  ─ reconnect wrapper  │
    │    gap endpoints     │  │  ─ health tracking    │
    └──────────┬──────────┘  └───┬──────────────────┘
               │                  │
    ┌──────────▼──────────────────▼──────────────────┐
    │  retryFetch (custom fetch adapter)              │
    │  ─ Exponential backoff on 5xx / network errors  │
    │  ─ Timeout via AbortController                  │
    │  ─ Configurable attempts/delay                  │
    └────────────────────┬───────────────────────────┘
                         │
                   @opencode-ai/sdk
```

## Phase 1: Foundation

Zero consumers, zero risk. Lay the SDK groundwork.

### New files

**`lib/instance/retry-fetch.ts`** — Custom `fetch` adapter wrapping native `fetch`:
- Retry on 5xx and network errors with exponential backoff
- Configurable: attempts (default 2), delay (default 1000ms), timeout (default 10s)
- Abort via `AbortController` on timeout
- Does NOT retry 4xx client errors
- Injected into SDK: `createOpencodeClient({ fetch: retryFetch })`

**`lib/instance/sdk-factory.ts`** — Single factory for SDK client creation:
- Calls `createOpencodeClient()` with `baseUrl`, `fetch: retryFetch`, `directory` header
- Handles Basic Auth via custom fetch headers
- Single config point for all SDK consumers

**`lib/instance/gap-endpoints.ts`** — Raw-fetch helpers for 5 missing SDK endpoints:
- `listPendingPermissions()` — `GET /permission`
- `listPendingQuestions()` — `GET /question`
- `replyQuestion(id, answer)` — `POST /question/{id}/reply`
- `rejectQuestion(id)` — `POST /question/{id}/reject`
- `listSkills()` — `GET /skill`
- `getMessagesPage(sessionId, { limit?, before? })` — `GET /session/{id}/message?limit=N&before=X`

Uses the same `retryFetch` for consistency.

**Also:** Add `@opencode-ai/sdk` to `package.json` dependencies.

## Phase 2: Client Swap

Replace `OpenCodeClient` with `OpenCodeAPI` — a thin adapter delegating to SDK + gap endpoints.

### OpenCodeAPI structure

```typescript
class OpenCodeAPI {
  private sdk: OpencodeClient;           // from @opencode-ai/sdk
  private gapEndpoints: GapEndpoints;    // raw-fetch for missing endpoints

  readonly session: {
    list(): Promise<Session[]>
    get(id: string): Promise<Session>
    create(opts?): Promise<Session>
    delete(id: string): Promise<void>
    update(id: string, updates): Promise<Session>
    messages(id: string): Promise<MessageWithParts[]>
    messagesPage(id, opts): Promise<MessageWithParts[]>  // gap
    prompt(id, opts): Promise<void>
    abort(id: string): Promise<void>
    fork(id, opts): Promise<Session>
    revert(id, messageId): Promise<void>
    unrevert(id): Promise<void>
    share(id): Promise<{ url: string }>
    summarize(id): Promise<void>
    diff(id, messageId): Promise<DiffResponse>
    statuses(): Promise<Record<string, SessionStatus>>
  }
  readonly permission: {
    list(): Promise<Permission[]>         // gap
    reply(id, response): Promise<void>    // SDK
  }
  readonly question: {
    list(): Promise<Question[]>           // gap
    reply(id, answer): Promise<void>      // gap
    reject(id): Promise<void>             // gap
  }
  readonly config: {
    get(): Promise<Config>
    update(config): Promise<Config>
  }
  readonly provider: {
    list(): Promise<Provider[]>
  }
  readonly pty: {
    list(): Promise<Pty[]>
    create(opts?): Promise<Pty>
    delete(id): Promise<void>
    resize(id, cols, rows): Promise<void>
  }
  readonly file: {
    list(path?): Promise<FileEntry[]>
    read(path): Promise<FileContent>
    status(): Promise<FileStatus[]>
  }
  readonly find: {
    text(pattern): Promise<TextMatch[]>
    files(query): Promise<string[]>
    symbols(query): Promise<Symbol[]>
  }
  readonly app: {
    health(): Promise<HealthResponse>
    agents(): Promise<Agent[]>
    commands(): Promise<Command[]>
    skills(): Promise<Skill[]>            // gap
    path(): Promise<{ cwd: string }>
    vcs(): Promise<VcsInfo>
  }
  readonly event: {
    subscribe(): Promise<{ stream: AsyncGenerator<Event> }>
  }
}
```

### Permission decision mapping

Frontend sends `"allow" | "deny" | "allow_always"`. SDK expects `"once" | "always" | "reject"`.

```typescript
const DECISION_MAP = {
  allow: "once",
  deny: "reject",
  allow_always: "always",
} as const;
```

### Migration strategy

1. Create `OpenCodeAPI` alongside old `OpenCodeClient`
2. Update callers file-by-file from `client.listSessions()` → `api.session.list()`
3. Once all callers migrated, delete `OpenCodeClient`

## Phase 3: Type Migration

Adopt SDK types as canonical. Largest phase by files touched (~15-20 files).

### Key type replacements

| Old type | SDK type | Change |
|----------|----------|--------|
| `SessionInfo` | `Session` | Richer: has `time.created`, `time.updated`, `projectID`, `version` |
| `HistoryMessage` | `UserMessage \| AssistantMessage` | Discriminated union by `role` |
| `HistoryMessagePart` | `Part` (11-type union) | `TextPart \| ToolPart \| ReasoningPart \| FilePart \| SnapshotPart \| PatchPart \| AgentPart \| RetryPart \| CompactionPart \| StepStartPart \| StepFinishPart` |
| `PartState` | `ToolState` (4-type union) | `Pending \| Running \| Completed \| Error` |
| `OpenCodeEvent` (`{type, properties}`) | `Event` (discriminated union) | 20+ typed event variants with type narrowing |
| `SessionStatus` (string) | `SessionStatus` (object union) | `{type:"idle"} \| {type:"busy"} \| {type:"retry", attempt, message, next}` |

### Files that change

- All handlers (`handlers/*.ts`) — method calls + parameter/return types
- `session-manager.ts` — Session type, status type
- `session-status-poller.ts` — SessionStatus type
- `event-translator.ts` — Part types, event types
- `sse-wiring.ts` — Event type
- `event-pipeline.ts` — event types in RelayMessage
- `permission-bridge.ts` — Permission type
- `client-init.ts` — Multiple types
- `shared-types.ts` — Gut or delete (most types come from SDK now)
- `types.ts` — Remove `OpenCodeEvent` and replaced types

### Types we keep (relay-specific)

- `RelayMessage` — WebSocket message format to browsers
- `AskUserQuestion` — question system (not in SDK)
- `HealthResponse` — relay health endpoint
- `PtyOutput` — terminal streaming events
- Handler-specific request/response types
- `notification_event` — cross-session notifications

## Phase 4: SSE Migration

Replace the manual SSE parser (~200 lines) with `sdk.event.subscribe()` wrapped in reconnection/health logic.

### New SSEStream class (replaces SSEConsumer)

**What the SDK handles (we delete):**
- HTTP fetch + stream reading
- SSE message parsing (`data:`, `event:` fields)
- Text decoding / buffer management

**What we keep as wrapper logic:**
- Infinite reconnection loop (SDK stream ends normally on server close)
- Exponential backoff between reconnections (1s → 30s)
- Health state: `connected`, `lastEventAt`, `reconnectCount`, `stale`
- `EventEmitter` interface: `event`, `connected`, `disconnected`, `reconnecting`
- Heartbeat detection (SDK yields heartbeat events, we track timing)

**Wiring changes:** Minimal — `SSEStream` emits same events as `SSEConsumer`, but event type becomes `Event` (SDK discriminated union) instead of `OpenCodeEvent` (generic `{type, properties}`). Wiring code switches from `event.properties.foo` to type-narrowed access.

### SSEStream sketch

```typescript
class SSEStream extends EventEmitter {
  private api: OpenCodeAPI;
  private health: HealthState;
  private running: boolean;

  async connect(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const { stream } = await this.api.event.subscribe();
        this.emit("connected");
        this.health.markConnected();

        for await (const event of stream) {
          this.health.markEvent();
          if (event.type === "server.heartbeat") {
            this.emit("heartbeat");
          } else {
            this.emit("event", event);
          }
        }
        // Stream ended normally — reconnect
      } catch (err) {
        this.emit("error", err);
      }
      if (this.running) {
        const delay = this.health.nextBackoff();
        this.emit("reconnecting", { attempt: this.health.reconnectCount, delay });
        await sleep(delay);
      }
    }
  }

  disconnect(): void {
    this.running = false;
    this.emit("disconnected");
  }

  getHealth(): HealthState { return this.health; }
}
```

## Phase 5: Cleanup

- Delete `opencode-client.ts` (691 lines)
- Delete old `SSEConsumer` class
- Gut `shared-types.ts` — remove types now provided by SDK
- Gut `types.ts` — remove `OpenCodeEvent` and replaced types
- Delete dead imports across all files
- Update `relay-stack.ts` to construct `OpenCodeAPI` + `SSEStream`
- Delete unused SSE parsing utilities (`sse-backoff.ts` if subsumed)

## SDK Coverage Gaps (5 endpoints)

These endpoints exist in OpenCode's server but are not in the SDK:

| Endpoint | Used by |
|----------|---------|
| `GET /permission` | `permission-bridge.ts` (rehydration on reconnect) |
| `GET /question` | `client-init.ts` (rehydration) |
| `POST /question/{id}/reply` | `handlers/session.ts` |
| `POST /question/{id}/reject` | Not currently used, but supported |
| `GET /skill` | `handlers/settings.ts` |
| `GET /session/{id}/message?limit&before` | `message-poller.ts` (paginated fetch) |

When the SDK adds these, migrate from `gapEndpoints.*` to `sdk.*` — a one-line change per method.

## Testing Strategy

- **Phase 1:** Unit-test `retryFetch` (retry behavior, timeout, 4xx passthrough). Unit-test `GapEndpoints` against mock HTTP.
- **Phase 2:** Integration tests: `OpenCodeAPI` against mock OpenCode server (existing fixture tests). Verify parity with old `OpenCodeClient` responses.
- **Phase 3:** Type-level — `tsc --noEmit` catches all mismatches. Existing test assertions validate behavior hasn't changed.
- **Phase 4:** SSE integration tests: `SSEStream` against mock SSE server. Test reconnection, health tracking, event emission.
- **Phase 5:** Full test suite passes. No regressions.

## Superseded Plans

This design supersedes the Phase 1 of `2026-03-31-dual-sdk-design.md` (which proposed migrating to the SDK as part of a dual-backend architecture that was replaced by the orchestrator).

It also supersedes `2026-03-12-sdk-migration-design.md` (earlier SDK migration that was never executed).
