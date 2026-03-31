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

## Session Model

### Each Session Belongs to One Backend

Sessions are backend-owned. Each session has a `backendType` that identifies which backend manages it. The UI shows a merged list of sessions from all backends, tagged with their type.

| | OpenCode | Claude Agent SDK |
|---|---|---|
| **Grouping** | One server instance per project dir, or `x-opencode-directory` header | Sessions at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` |
| **List** | `GET /session` on the scoped instance | `listSessions({ dir: projectDir })` |
| **Resume** | `POST /session/{id}/message` | `query({ prompt, options: { resume: cliSessionId } })` |
| **Create** | `POST /session` | Implicit — first `query()` without `resume` creates a new session; SDK assigns `cliSessionId` |
| **Multi-turn within query** | N/A (each message is a separate REST call) | Async message queue — `pushMessage()` feeds additional prompts to a live `query()` stream |

### Session Resume (from Clay reference implementation)

The Claude Agent SDK backend uses **SDK-native `resume`** for session continuity. It never reconstructs or prepends conversation history for same-backend turns:

1. **New session**: First `query()` has no `resume`. SDK assigns a `cliSessionId`. Backend stores it.
2. **Follow-up while query is live**: `pushMessage()` into the async message queue (no new `query()`).
3. **Follow-up after query ends**: New `query()` with `resume: cliSessionId`. SDK loads its own transcript.
4. **After daemon restart**: `cliSessionId` persisted; next `query()` resumes normally.

### Cross-Backend Conversation Continuity

When the user switches backends mid-conversation (e.g., OpenCode → Claude or vice versa), the relay:

1. Gets the conversation history from the source backend's session.
2. Creates a new session on the target backend.
3. **On the first message only**, prepends the history as structured conversation turns.
4. On subsequent messages, uses the target backend's native session resume.

The relay tracks a "continuation chain" linking sessions across backends. The frontend shows it as one logical conversation.

### Lazy Session Creation

The Claude Agent SDK creates sessions implicitly on first `query()`. When the user clicks "New Session", the backend creates a local placeholder (kept until explicitly deleted). The actual SDK session materializes when the first message is sent.

### Unsupported Operations

`forkSession`, `revertSession`, `unrevertSession` are optional on the `SessionBackend` interface. The Claude Agent SDK has no equivalent. Callers check if the method exists before calling. The frontend hides the corresponding buttons when the active backend doesn't support them.

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

The `canUseTool` callback uses the correct SDK return format (`{ behavior: "allow" | "deny" }`, NOT the hooks `hookSpecificOutput` format):

```typescript
class ClaudeAgentBackend {
  private pendingPermissions = new Map<string, { deferred: Deferred<string>; metadata: PermissionMetadata }>();

  // canUseTool receives 3 args: toolName, toolInput, options (with signal)
  private canUseTool = async (toolName: string, toolInput: unknown, options?: { signal?: AbortSignal }) => {
    const id = crypto.randomUUID();
    const deferred = createDeferred<string>();
    this.pendingPermissions.set(id, { deferred, metadata: { id, tool: toolName, input: toolInput } });

    this.channel.push({
      type: "permission.created",
      properties: { id, tool: toolName, input: toolInput }
    });

    const decision = await deferred.promise;
    this.pendingPermissions.delete(id);

    // SDK canUseTool return format — NOT hookSpecificOutput
    if (decision === "allow" || decision === "once" || decision === "always") {
      return { behavior: "allow" as const };
    }
    return { behavior: "deny" as const, message: "User denied" };
  };
}
```

For `AskUserQuestion`: detected as a specific tool name in `canUseTool`. The response format differs — the answer is returned via `{ behavior: "allow", updatedInput: { answers: structuredAnswers } }`. This requires its own handling path separate from simple allow/deny permissions.

On `shutdown()`, all pending deferreds are rejected to unblock any blocked `canUseTool` callbacks.

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

### Phase 4: Model-Level Backend Switching

Backend routing is **provider-based**: if the provider is `anthropic` and auth type is `subscription`, use the Claude Agent SDK backend. Otherwise use OpenCode.

Switching backends within a project uses a **BackendProxy** pattern — all components (SessionManager, pollers, handlers) hold a reference to a proxy object that indirects through the currently active backend. Swapping the active backend updates the proxy, and all existing references see the new backend immediately. This avoids tearing down and rebuilding the component graph.

On backend switch:
- Active `query()` on the old backend is aborted
- Pending permissions/questions on the old backend are rejected
- Frontend receives a `backend_switched` event, clears stale caches, reloads session list
- If the user sends a message to a session from the other backend, cross-backend history prepending kicks in

Frontend shows a merged session list from all backends. Sessions are tagged with their backend type. The Claude Agent SDK backend uses `setModel()` for within-backend model switches (e.g., Sonnet → Opus). Cross-backend switches (e.g., GPT-4 → Claude) create a new session with history prepending.

**Delivers**: Seamless model switching between OpenCode and Claude Agent SDK within a single project.

## Resolved Questions

1. **Architecture**: SessionBackend abstraction with OpenCode and Claude Agent SDK implementations (Approach A).
2. **Feature parity**: Full parity for session-centric operations. PTY, files, search stay on OpenCode always.
3. **Concurrency**: One agent per project, shared across browser clients.
4. **PTY**: Model-agnostic, stays on OpenCode regardless of active backend.
5. **Share/Summarize/Diff**: Dropped — relay doesn't use them.
6. **Session grouping**: Both backends group by project directory. Natural mapping.
7. **Session resume**: SDK-native `resume` for Claude Agent SDK (from Clay reference). Never reconstruct history for same-backend turns.
8. **Cross-backend switching**: Prepend conversation history on first message to new backend. Native resume for subsequent messages.
9. **Lazy session creation**: Local placeholder kept until explicit delete. SDK session materializes on first message.
10. **Event streaming**: AsyncEventChannel bridges per-query generators to continuous relay stream.
11. **Permissions**: Deferred promise bridge with correct `canUseTool` return format (`{ behavior: "allow"|"deny" }`). No timeout on deferreds. Rejected on shutdown.
12. **V2 Agent SDK**: Use stable V1 `query()` API. V2 is unstable preview — future simplification.
13. **Backend selection**: Provider-based. Anthropic subscription → Agent SDK, everything else → OpenCode.
14. **Session list**: Merged from all backends, tagged with backend type.
15. **Unsupported ops**: `forkSession`/`revertSession`/`unrevertSession` optional on interface. Frontend hides buttons.
16. **Backend proxy**: Components hold proxy reference, not direct backend. Swap is non-disruptive.

## Reference Implementations

- **Clay (`claude-relay`)**: Full-featured Claude Agent SDK relay at `~/src/personal/opencode-relay/claude-relay`. Key patterns adopted: SDK-native session resume, async message queue for multi-turn within a live query, `canUseTool` permission bridging. See `lib/sdk-bridge.js` for the core SDK integration.

## SDK References

- OpenCode SDK: `docs/opencode-sdk/`
- Claude Agent SDK: `docs/claude-agent-sdk/`
