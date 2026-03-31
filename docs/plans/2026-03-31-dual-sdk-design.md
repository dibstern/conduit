# Dual SDK Design — OpenCode SDK + Claude Agent SDK

## Problem

Anthropic subscription accounts (Claude Pro/Max) no longer work with OpenCode because OpenCode doesn't use the Claude Agent SDK for authentication. Users with subscription billing must use the Claude Agent SDK to access Claude models. Users with API keys or non-Claude providers continue to work through OpenCode.

Conduit needs to support both backends side-by-side: OpenCode for providers that work with it, and the Claude Agent SDK for Claude subscription accounts.

## Constraints

- **Model-level switching**: Within a single project, the user selects which backend handles the next prompt based on the model/provider.
- **Full feature parity**: Both backends must support session CRUD, messaging, streaming, permissions, questions, agent/model discovery.
- **One agent per project**: Shared across browser clients. Messages serialized through a single backend process.
- **Per-instance credentials**: Each backend instance can have different auth credentials, different working directories, running concurrently.

## Architecture: SessionBackend Abstraction

Create a `SessionBackend` interface that the relay stack programs against. Two implementations:

- **`OpenCodeBackend`** — wraps the OpenCode SDK (`@opencode-ai/sdk`). Talks to an OpenCode server via REST + SSE.
- **`ClaudeAgentBackend`** — wraps the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). Manages `query()` processes, translates async generator streams into relay events, bridges permissions via deferred promises.

### What Goes Through SessionBackend (Model-Dependent)

- Session CRUD (list, get, create, delete)
- Session statuses
- Messages (get, paginate)
- Send prompt / abort
- Permissions and questions
- Agent/model/provider discovery
- Config (get, update)
- Fork, revert, unrevert
- Event streaming

### What Stays on OpenCode Always (Model-Agnostic)

- **PTY** (create, resize, delete, WebSocket data) — terminal multiplexer, no tie to AI sessions
- **File browser** (list, read, status) — OpenCode file server
- **Search** (text, files, symbols) — OpenCode search indexing
- **Health/VCS/Path** — OpenCode instance metadata
- **Projects** — OpenCode concept

### Dropped (Unused by Relay)

- Share session
- Summarize session
- Session diff

### Relay Stack Structure

```
RelayStack
  ├── sessionBackend: SessionBackend    ← swappable per model
  └── infraClient: OpenCodeClient/SDK   ← always OpenCode, for PTY/files/search
```

When the user switches to a Claude model, only `sessionBackend` swaps. The `infraClient` stays the same. PTY connections are unaffected.

## SessionBackend Interface

Covers the full session-centric API surface (~30 methods):

```typescript
interface SessionBackend {
  // Lifecycle
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  getHealth(): Promise<HealthResponse>;

  // Sessions
  listSessions(options?: SessionListOptions): Promise<SessionDetail[]>;
  getSession(id: string): Promise<SessionDetail>;
  createSession(options?: SessionCreateOptions): Promise<SessionDetail>;
  deleteSession(id: string): Promise<void>;
  getSessionStatuses(): Promise<Record<string, SessionStatus>>;

  // Messages
  getMessages(sessionId: string): Promise<Message[]>;
  getMessagesPage(sessionId: string, options?: PaginationOptions): Promise<Message[]>;
  sendMessage(sessionId: string, prompt: PromptOptions): Promise<void>;
  abortSession(id: string): Promise<void>;

  // Permissions & Questions
  listPendingPermissions(): Promise<PendingPermission[]>;
  replyPermission(options: PermissionReplyOptions): Promise<void>;
  listPendingQuestions(): Promise<PendingQuestion[]>;
  replyQuestion(options: QuestionReplyOptions): Promise<void>;
  rejectQuestion(id: string): Promise<void>;

  // Discovery
  listAgents(): Promise<Agent[]>;
  listProviders(): Promise<ProviderListResult>;
  getConfig(): Promise<Config>;
  updateConfig(config: Partial<Config>): Promise<Config>;

  // Session operations
  forkSession(id: string, options: ForkOptions): Promise<SessionDetail>;
  revertSession(id: string, messageId: string): Promise<void>;
  unrevertSession(id: string): Promise<void>;

  // Events (key differentiator between backends)
  subscribeEvents(signal: AbortSignal): AsyncIterable<BackendEvent>;

  // Commands / Skills
  listCommands(): Promise<Command[]>;
  listSkills(): Promise<Skill[]>;

  // Auth/URL for SSE/PTY upstream wiring
  getBaseUrl(): string;
  getAuthHeaders(): Record<string, string>;
}
```

## Session Mapping Between Backends

Both backends group sessions by project directory:

| | OpenCode | Claude Agent SDK |
|---|---|---|
| **Grouping** | One server instance per project dir, or `x-opencode-directory` header | Sessions at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` |
| **List** | `GET /session` on the scoped instance | `listSessions({ dir: projectDir })` |
| **Resume** | `POST /session/{id}/message` | `query({ prompt, options: { resume: sessionId } })` |
| **Create** | `POST /session` | Implicit — `query()` without `resume` creates a new session |

Each project already has a `directory` in its config. The OpenCode backend passes it as `x-opencode-directory`. The Claude Agent SDK backend passes it as `cwd` to `query()` and `dir` to `listSessions()`.

**Lazy session creation**: The Claude Agent SDK creates sessions implicitly on first `query()`. When the user clicks "New Session" in the UI, the backend creates a local placeholder. The actual Agent SDK session is created when the first message is sent.

## Event Translation

### Current OpenCode Flow

```
OpenCode SSE → SSEConsumer → OpenCodeEvent → relay caches/pollers → RelayMessage → browser WS
```

### Claude Agent SDK Flow

```
query() async generator → SDKMessage → translator → BackendEvent → relay caches/pollers → RelayMessage → browser WS
```

### AsyncEventChannel Pattern

The Claude Agent SDK produces events only during active `query()` calls. The relay expects a continuous event stream. A push-pull async channel bridges this gap:

- `sendMessage()` starts a `query()`, iterates the generator, pushes translated events into the channel
- `subscribeEvents()` pulls from the channel via `yield`, blocking when empty
- Between queries, the channel is empty — `subscribeEvents()` awaits, no errors, no disconnection
- When a new `query()` starts, events flow again

```
sendMessage() ──► query() generator ──► translate ──► channel.push()
                                                         │
subscribeEvents() ◄── channel.pull() ◄──────────────────-┘
```

### SDKMessage → BackendEvent Mapping

| SDKMessage type | BackendEvent / OpenCodeEvent equivalent |
|---|---|
| `SDKAssistantMessage` (type: `"assistant"`) | `message.updated` |
| `SDKUserMessage` (type: `"user"`) | `message.updated` |
| `SDKPartialAssistantMessage` (type: `"stream_event"`) | `message.part.updated` (streaming deltas) |
| `SDKResultMessage` (type: `"result"`) | `session.updated` (status: completed/error) |
| `SDKSystemMessage` (type: `"system"`, subtype: `"init"`) | Session initialization metadata |
| `SDKStatusMessage` | `session.updated` (status changes) |

## Permission & Question Bridging

The two backends handle permissions differently:

- **OpenCode**: Async polling — relay polls `GET /permission`, shows to browser, POSTs response
- **Claude Agent SDK**: Sync callback — `canUseTool` is called during `query()` execution, blocks until it returns

### Deferred Promise Bridge

```typescript
class ClaudeAgentBackend {
  private pendingPermissions = new Map<string, Deferred<string>>();

  private canUseTool = async (toolName, toolInput) => {
    const id = crypto.randomUUID();
    const deferred = createDeferred<string>();
    this.pendingPermissions.set(id, deferred);

    // Push to event channel → relay → browser
    this.channel.push({
      type: "permission.created",
      properties: { id, tool: toolName, input: toolInput }
    });

    // Blocks until browser user responds via replyPermission()
    const decision = await deferred.promise;
    this.pendingPermissions.delete(id);
    return { hookSpecificOutput: { permissionDecision: decision } };
  };

  async replyPermission(options: { id: string; decision: string }) {
    const deferred = this.pendingPermissions.get(options.id);
    if (deferred) deferred.resolve(options.decision);
  }

  async listPendingPermissions() {
    return [...this.pendingPermissions.entries()].map(([id, d]) => ({
      id, ...d.metadata
    }));
  }
}
```

Same pattern for questions — `AskUserQuestion` tool fires through `canUseTool`, creates a deferred, pushes a question event, waits for `replyQuestion()`.

### No Timeout on Deferreds

The relay has a 5-minute UI-side timeout for permissions (clears the permission card from the browser), but it does NOT send reject/deny back to the server. The same applies here: the deferred promise has no timeout. It stays pending until explicitly resolved. If the browser reconnects, `listPendingPermissions()` returns unresolved deferreds, and the frontend re-shows them.

### Pre-Approved Tools

The `allowedTools` option on `query()` pre-approves low-risk tools (Read, Glob, Grep, etc.) so they skip `canUseTool` entirely. Only unapproved tools go through the permission bridge.

## Implementation Phases

### Phase 1: OpenCode SDK Migration (from existing plan)

Install `@opencode-ai/sdk`. Create composition-based `RelayClient` wrapping the SDK with the same flat API as the current `OpenCodeClient`. Swap imports, delete old client. This is the existing 9-task plan from `2026-03-12-sdk-migration-plan.md`, largely unchanged.

**Delivers**: Type-safe OpenCode client, eliminates manually maintained types.

### Phase 2: Extract SessionBackend Interface

Define `SessionBackend` from the `RelayClient` surface (session-centric methods only). Extract `OpenCodeBackend` as the first implementation — wraps `RelayClient` + SSE consumer. Split relay stack into `sessionBackend` + `infraClient`. Pure refactor, no new behavior.

**Delivers**: Abstraction point for plugging in alternative backends.

### Phase 3: Claude Agent SDK Backend

Install `@anthropic-ai/claude-agent-sdk`. Implement `ClaudeAgentBackend` with:
- `query()` lifecycle management (one active query per project)
- `AsyncEventChannel` for continuous event streaming
- Deferred promise map for permission/question bridging
- `SDKMessage` → `BackendEvent` translation
- Lazy session creation (placeholder until first message)

Wire into relay stack alongside `OpenCodeBackend`. Add per-project backend configuration (type, credentials).

**Delivers**: Claude subscription account support via Agent SDK.

### Phase 4: Model-Level Switching

Add UI/config for selecting backend per model. Implement backend switching in relay stack when user changes models. Handle session list switching (sessions are backend-specific — changing backends shows different session lists).

**Delivers**: Seamless model switching between OpenCode and Claude Agent SDK within a single project.

## Resolved Questions

1. **Architecture**: SessionBackend abstraction with OpenCode and Claude Agent SDK implementations (Approach A).
2. **Feature parity**: Full parity for session-centric operations. PTY, files, search stay on OpenCode always.
3. **Concurrency**: One agent per project, shared across browser clients.
4. **PTY**: Model-agnostic, stays on OpenCode regardless of active backend.
5. **Share/Summarize/Diff**: Dropped — relay doesn't use them.
6. **Session grouping**: Both backends group by project directory. Natural mapping.
7. **Lazy session creation**: Claude Agent SDK creates sessions implicitly on first `query()`. Frontend shows placeholder until then.
8. **Event streaming**: AsyncEventChannel bridges per-query generators to continuous relay stream.
9. **Permissions**: Deferred promise bridge. No timeout on deferreds — matches relay's existing behavior.
10. **V2 Agent SDK**: Use stable V1 `query()` API. V2 `createSession()`/`send()`/`stream()` is unstable preview — future simplification.
11. **Backend selection**: Model-level switching (Phase 4). Per-project config for credentials.

## SDK References

- OpenCode SDK: `docs/opencode-sdk/`
- Claude Agent SDK: `docs/claude-agent-sdk/`
