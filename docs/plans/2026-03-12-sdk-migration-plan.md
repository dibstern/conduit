# OpenCode SDK Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hand-rolled `OpenCodeClient` (~691 lines) with the `@opencode-ai/sdk` package, gaining type-safe API calls generated from the OpenAPI spec and eliminating manually maintained type definitions.

**Architecture:** Install `@opencode-ai/sdk`. Create a composition-based `RelayClient` that wraps the SDK's `OpencodeClient` internally and exposes the **same flat API** as the current `OpenCodeClient` (e.g., `client.listSessions()`, `client.getMessages(id)`). This means consumer code only needs import path changes, not method-call rewrites. The `RelayClient` handles SDK response unwrapping, message normalization, provider normalization, and custom endpoints (permissions, questions) internally.

**Key Decisions (from audit):**
- **Composition over inheritance** — `RelayClient` wraps SDK client, does not extend it
- **`responseStyle: "data"` with `throwOnError: true`** — SDK methods return data directly and throw on error, matching existing behavior
- **Node.js >= 20** — bump minimum from 18 to 20
- **`provider.list()` (GET /provider)** — use consistently; includes `connected` array
- **`POST /permission/{id}/reply`** — old path is non-deprecated; add as custom method
- **Split commits by risk** — simple handlers separate from complex ones

**Tech Stack:** TypeScript, `@opencode-ai/sdk` (hey-api generated client), Vitest

**Prerequisite:** Run the SSE/PTY investigation spike (see `2026-03-12-sdk-sse-pty-spike.md`) in parallel. This plan covers REST client + types only.

---

### Task 1: Install SDK, Bump Node, and Explore Client Factory

**Files:**
- Modify: `package.json`

**Step 1: Bump Node.js minimum to 20 — ALREADY DONE**

`package.json:102` already has `engines.node: ">=20.19.0"` (bumped by session-switch-perf plan). No change needed. This satisfies `AbortSignal.any()` (available since Node 20.0.0).

**Step 2: Install the SDK**

```bash
pnpm add @opencode-ai/sdk
```

**Step 3: Explore SDK exports**

Create a temporary exploration script (not committed) to document:

1. **Client factory shape:** `createOpencodeClient({ baseUrl, fetch, throwOnError })` returns `OpencodeClient` (a class extending `_HeyApiClient`). It has nested resource objects: `client.session`, `client.path`, `client.provider`, `client.file`, `client.pty`, `client.config`, `client.app`, `client.event`, `client.global`, etc.

2. **Response behavior:** With `responseStyle: "data"` (our choice), methods return data directly. With `throwOnError: true`, non-2xx responses throw. This matches existing `OpenCodeClient` behavior.

3. **Type exports:** Verify which types are exported at the package root: `Session`, `Message` (discriminated union: `UserMessage | AssistantMessage`), `Part` (discriminated union), `Agent`, `Provider`, `SessionStatus`, etc.

4. **Message envelope:** `session.messages()` returns `Array<{ info: Message, parts: Part[] }>` — the relay's `normalizeMessage()` logic is still needed.

5. **Missing endpoints:** The SDK does NOT have methods for:
   - `GET /permission` (list pending permissions)
   - `POST /permission/{id}/reply` (reply permission — non-deprecated)
   - `GET /question` (list pending questions)
   - `POST /question/{id}/reply`
   - `POST /question/{id}/reject`
   - `GET /skill`
   - `GET /session/{id}/message?limit=N&before=X` (paginated messages)

6. **`directory` option:** Verify `createOpencodeClient({ directory })` sets `x-opencode-directory` header.

7. **`Session` type gaps:** SDK `Session` lacks `modelID`, `providerID`, `agentID`, `slug`. These may be returned by the server as extra fields not in the OpenAPI spec.

8. **Custom fetch injection:** Verify `createOpencodeClient({ fetch: customFetch })` accepts a custom fetch implementation. Confirm the custom fetch receives the full `url` + `init` args so that auth headers and `x-opencode-directory` can be injected. This is the foundation for Task 2's `relay-fetch` wrapper.

9. **Base URL / auth accessibility:** Confirm `OpencodeClient` has no public `getBaseUrl()` or `getConfig()` method. This validates the composition design where `RelayClient` stores `baseUrl` and auth credentials as its own properties.

**Step 4: Write findings to `docs/plans/sdk-migration-task-1-findings.md`**

Document the full SDK export map, response behavior verification, type comparison with relay types, and missing endpoint list.

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add @opencode-ai/sdk"
```

---

### Task 2: Create Custom Fetch Wrapper

The SDK's `createOpencodeClient` accepts a custom `fetch` implementation. We inject relay-specific behaviors: Basic Auth, `x-opencode-directory`, retry logic, and timeout.

**Files:**
- Create: `src/lib/instance/relay-fetch.ts`
- Create: `src/lib/instance/relay-fetch.test.ts`

**Step 1: Write failing tests** (same test cases as before, plus a test for throw-after-retry-exhaustion)

**Step 2: Write the implementation**

Key differences from the original plan (fixes from audit):

1. **Throw after retry exhaustion:** After all retries on 5xx, throw `OpenCodeConnectionError` (matching existing behavior), do NOT return the raw response.
2. **Use linear retry delay:** `retryDelay * (attempt + 1)` to match existing `opencode-client.ts:643` behavior.
3. **Use `AbortSignal.any()`** for signal chaining (Node 20+ guaranteed).
4. **Ensure `clearTimeout` in `finally` block** to prevent timer leaks.
5. **Do NOT set `Content-Type`/`Accept` headers** — the SDK handles these via hey-api's request serialization. Verify during Task 1 exploration.

The `extractAuthHeaders()` utility function is still needed for SSE consumer and PTY WebSocket upstream.

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat: add relay-fetch wrapper for SDK client auth, retry, and timeout"
```

---

### Task 3: Create Composition-Based RelayClient

**This is the most critical task.** Create a `RelayClient` class that uses **composition** (wrapping the SDK's `OpencodeClient` internally) and exposes the **same flat API** as the current `OpenCodeClient`. This is a drop-in replacement — all consumer code only needs import path changes, not method-call rewrites.

**Files:**
- Create: `src/lib/instance/sdk-client.ts`
- Create: `src/lib/instance/sdk-client.test.ts`

**Step 1: Design the class**

```typescript
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import { createRelayFetch, extractAuthHeaders, type RelayFetchOptions } from "./relay-fetch.js";
import { OpenCodeApiError, OpenCodeConnectionError } from "../errors.js";
import { ENV } from "../env.js";

export interface RelayClientOptions {
    baseUrl?: string;
    auth?: { username: string; password: string };
    directory?: string;
    timeout?: number;
    retries?: number;
    retryDelay?: number;
}

export class RelayClient {
    private readonly sdk: OpencodeClient;
    private readonly baseUrl: string;
    private readonly fetchOptions: RelayFetchOptions;
    private readonly customFetch: typeof globalThis.fetch;

    constructor(options: RelayClientOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_OPENCODE_URL).replace(/\/+$/, "");
        const auth = options.auth ?? {
            username: ENV.opencodeUsername,
            password: ENV.opencodePassword ?? "",
        };
        this.fetchOptions = {
            auth: auth.password ? auth : undefined,
            directory: options.directory,
            timeout: options.timeout,
            retries: options.retries,
            retryDelay: options.retryDelay,
        };
        this.customFetch = createRelayFetch(this.fetchOptions);
        this.sdk = createOpencodeClient({
            baseUrl: this.baseUrl,
            fetch: this.customFetch,
            responseStyle: "data",
            throwOnError: true,
            ...(options.directory && { directory: options.directory }),
        });
    }

    // ─── Flat API methods (mirror OpenCodeClient) ─────────────────

    // Each method delegates to the SDK and handles any normalization.
    // Since responseStyle: "data" + throwOnError: true, SDK methods
    // return data directly and throw on error — matching existing behavior.

    // System
    async getHealth() { /* call sdk.path.get() or raw fetch /path */ }
    async getPath() { return this.sdk.path.get(); }
    async getVcs() { return this.sdk.vcs.get(); }

    // Sessions
    async listSessions(options?) { return toArray(await this.sdk.session.list({ query: options })); }
    async getSession(id) { return this.sdk.session.get({ path: { id } }); }
    async createSession(options?) { return this.sdk.session.create({ body: options ?? {} }); }
    async deleteSession(id) { await this.sdk.session.delete({ path: { id } }); }
    async updateSession(id, updates) { /* custom fetch PATCH /session/{id} if SDK lacks PATCH */ }
    async getSessionStatuses() { return this.sdk.session.status() ?? {}; }

    // Messages (with normalization)
    async getMessages(sessionId) {
        const raw = await this.sdk.session.messages({ path: { id: sessionId } });
        return normalizeMessages(raw);
    }
    async getMessage(sessionId, messageId) { /* sdk + normalize */ }
    async getMessagesPage(sessionId, options?) { /* custom fetch with limit/before query params */ }

    // Prompt / session actions
    async sendMessageAsync(sessionId, prompt: PromptOptions) {
        // Convert PromptOptions to SDK body format:
        // prompt.text → { type: "text", text }
        // prompt.images → { type: "file", url, mime: "image/png" }
        const parts = [];
        if (prompt.text) parts.push({ type: "text", text: prompt.text });
        if (prompt.images) for (const img of prompt.images) parts.push({ type: "file", url: img, mime: "image/png" });
        const body = { parts, agent: prompt.agent, model: prompt.model, variant: prompt.variant };
        await this.sdk.session.promptAsync({ path: { id: sessionId }, body });
    }
    async abortSession(id) { await this.sdk.session.abort({ path: { id } }); }
    async forkSession(id, options) { return this.sdk.session.fork({ path: { id }, body: options }); }
    async revertSession(id, messageId) { await this.sdk.session.revert({ path: { id }, body: { messageID: messageId } }); }
    async unrevertSession(id) { /* sdk or custom fetch */ }
    async shareSession(id) { /* sdk or custom fetch */ }
    async summarizeSession(id) { /* sdk or custom fetch */ }
    async getSessionDiff(id, messageId) { /* sdk or custom fetch */ }

    // Permissions (custom — NOT in SDK, using non-deprecated paths)
    async listPendingPermissions() { return toArray(await this.rawGet("/permission")); }
    async replyPermission(options: { id: string; decision: string }) {
        await this.rawPost(`/permission/${options.id}/reply`, { reply: options.decision });
    }

    // Questions (custom — NOT in SDK)
    async listPendingQuestions() { return toArray(await this.rawGet("/question")); }
    async replyQuestion(options: { id: string; answers: string[][] }) {
        await this.rawPost(`/question/${options.id}/reply`, { answers: options.answers });
    }
    async rejectQuestion(id: string) { await this.rawPost(`/question/${id}/reject`, {}); }

    // Discovery
    async listAgents() { return toArray(await this.sdk.app.agents()); }
    async listProviders(): Promise<ProviderListResult> {
        // GET /provider returns { all, default, connected }
        // Normalize: all→providers, default→defaults, models keyed→array
        const raw = await this.sdk.provider.list();
        const all = Array.isArray(raw) ? raw : Array.isArray(raw?.all) ? raw.all : [];
        const providers = all.map(p => ({
            ...p,
            models: Array.isArray(p.models) ? p.models
                : p.models && typeof p.models === "object" ? Object.values(p.models) : [],
        }));
        return {
            providers,
            defaults: raw?.default ?? {},
            connected: Array.isArray(raw?.connected) ? raw.connected : [],
        };
    }
    async listCommands() { return toArray(await this.sdk.command.list()); }
    async listSkills() { return toArray(await this.rawGet("/skill")); }

    // Projects
    async getCurrentProject() { return this.sdk.project.current(); }
    async listProjects() { return toArray(await this.sdk.project.list()); }

    // Files
    async listDirectory(path?) { return toArray(await this.sdk.file.list({ query: { path: path ?? "." } })); }
    async getFileContent(path) { return this.sdk.file.read({ query: { path } }); }
    async getFileStatus() { return toArray(await this.rawGet("/file/status")); }
    async findText(pattern) { return toArray(await this.sdk.find.text({ query: { pattern } })); }
    async findFiles(query) { return toArray(await this.sdk.find.file({ query: { query } })); }
    async findSymbols(query) { return toArray(await this.sdk.find.symbol({ query: { query } })); }

    // Config
    async getConfig() { return this.sdk.config.get(); }
    async updateConfig(config) { return this.sdk.config.update({ body: config }); }

    // PTY
    async listPtys() { return toArray(await this.sdk.pty.list()); }
    async createPty(options?) { return this.sdk.pty.create({ body: options ?? {} }); }
    async deletePty(id) { await this.sdk.pty.remove({ path: { id } }); }
    async resizePty(id, cols, rows) { await this.sdk.pty.update({ path: { id }, body: { size: { cols, rows } } }); }

    // Meta
    getBaseUrl(): string { return this.baseUrl; }
    getAuthHeaders(): Record<string, string> { return extractAuthHeaders(this.fetchOptions); }

    // ─── Internal: raw fetch for endpoints not in SDK ────────────
    private async rawGet(path: string): Promise<unknown> { /* use this.customFetch */ }
    private async rawPost(path: string, body: unknown): Promise<unknown> { /* use this.customFetch */ }
}
```

> **Key design principles:**
> - Every public method matches the existing `OpenCodeClient` signature exactly
> - `normalizeMessage()`/`normalizeMessages()` are called inside `getMessages()`/`getMessage()` — callers never see `{ info, parts }` envelopes
> - `listProviders()` normalizes internally (models keyed→array, field renaming)
> - `sendMessageAsync()` converts `PromptOptions` to SDK body format internally
> - `rawGet()`/`rawPost()` handle endpoints missing from SDK using the same custom fetch with auth/retry/timeout
> - `toArray()` helper ensures responses are arrays (handles OpenCode's object-keyed formats)

**Step 2: Write tests**

Tests should verify:
- Client construction with baseUrl
- `getAuthHeaders()` returns correct headers
- `getBaseUrl()` returns stored URL
- `listPendingPermissions`, `listPendingQuestions`, `replyQuestion`, `rejectQuestion`, `replyPermission` exist and are callable
- `listProviders()` normalizes response (models keyed→array, field naming)
- `getMessages()` normalizes `{ info, parts }` to flat messages
- `sendMessageAsync()` converts `PromptOptions.text` to parts array

**Step 3: Implement and verify tests pass**

**Step 4: Commit**

```bash
git commit -m "feat: add composition-based RelayClient wrapping SDK with flat API"
```

---

### Task 4: Create Type Bridge and Move Relay-Internal Types

Move types that live in `opencode-client.ts` but are NOT covered by the SDK to a permanent home. Create re-export bridge so existing imports continue working during migration.

**Files:**
- Create: `src/lib/instance/relay-types.ts` (permanent home for relay-internal types)
- Modify: `src/lib/instance/opencode-client.ts` (add re-exports from relay-types.ts and sdk-client.ts)

**Step 1: Identify and categorize all exported types from `opencode-client.ts`**

| Type | Category | Destination |
|------|----------|-------------|
| `OpenCodeClient` (class) | Replaced by RelayClient | `sdk-client.ts` |
| `OpenCodeClientOptions` | Replaced by RelayClientOptions | `sdk-client.ts` |
| `SessionStatus` | Relay-internal (SDK has it but verify match) | `relay-types.ts` (or SDK re-export) |
| `SessionDetail` | SDK equivalent (`Session`) | SDK re-export |
| `Message` | SDK equivalent (discriminated union) | SDK re-export |
| `Agent` | SDK equivalent (but lacks `id`, `hidden`) | Needs adapter — see note |
| `Provider` | SDK equivalent (different model structure) | Internal to `listProviders()` normalization |
| `ProviderListResult` | Relay-constructed | `relay-types.ts` |
| `PromptOptions` | Relay-internal (input to sendMessageAsync) | `relay-types.ts` |
| `PermissionReplyOptions` | Relay-internal | `relay-types.ts` |
| `QuestionReplyOptions` | Relay-internal | `relay-types.ts` |
| `SessionCreateOptions` | SDK equivalent | SDK re-export or `relay-types.ts` |
| `SessionListOptions` | SDK equivalent | SDK re-export or `relay-types.ts` |
| `PtyCreateOptions` | Relay-internal | `relay-types.ts` |
| `HealthResponse` | Relay-fabricated | `relay-types.ts` |

> **Note on `Agent`:** The SDK Agent type has no `id` or `hidden` fields. The relay's `filterAgents()` uses `a.id`, `a.hidden`, `a.mode`. After migration, adapt `filterAgents()` to use `a.name` as identifier (SDK convention) and `a.mode !== "subagent"` instead of `!a.hidden`. Document this adaptation in Task 8 agent handler migration.

> **Note on `SessionStatus`:** The SDK's `SessionStatus` type is structurally identical to the relay's definition (confirmed by audit). Import from SDK.

**Step 2: Create `relay-types.ts`** with types that have no SDK equivalent.

**Step 3: Add re-exports to `opencode-client.ts`** so existing imports work during migration:
```typescript
// At bottom of opencode-client.ts:
export { RelayClient as OpenCodeClient } from "./sdk-client.js";
// Plus type re-exports from relay-types.ts and SDK
```

**Step 4: Verify all 21 importing files still compile**

Run `rg "from.*opencode-client" --type ts -l` and ensure the list matches:
- 11 source files: `relay-stack.ts`, `handlers/types.ts`, `session-manager.ts`, `session-status-poller.ts`, `client-init.ts`, `message-poller.ts`, `message-poller-manager.ts`, `handlers/agent.ts`, `status-transitions.ts`, `sse-wiring.ts`, `daemon.ts`
- 10 test files (list in audit task-13 finding #2)

**Step 5: Commit**

```bash
git commit -m "feat: create relay-types.ts and re-export bridge for incremental migration"
```

---

### Task 5: Swap Imports — Core Modules

Since `RelayClient` mirrors the flat API, this task is purely import-path swaps. No method-call changes needed.

**Files:**
- Modify: `src/lib/handlers/types.ts` — change `client: OpenCodeClient` to `client: RelayClient`, update import. **Also update `PromptOptions` import/re-export** (line 89-90) to import from `relay-types.ts`.
- Modify: `src/lib/bridges/client-init.ts` — change `ClientInitDeps.client: OpenCodeClient` to `RelayClient`, update import (line 12, 31).
- Modify: `src/lib/session/session-manager.ts` — change `SessionManagerOptions.client` type, update imports of `OpenCodeClient`, `SessionDetail`, `SessionStatus` (lines 7-11).
- Modify: `src/lib/session/session-status-poller.ts` — update `Pick<OpenCodeClient, ...>` to `Pick<RelayClient, "getSessionStatuses" | "getSession">` (preserving narrow interface), update imports (lines 12-15).
- Modify: `src/lib/relay/relay-stack.ts` — update import (line 19), client construction (line 150: `new OpenCodeClient(...)` → `new RelayClient(...)`), `ProjectRelay.client` type (line 71), `RelayStack.client` type (line 110), dynamic type import of `SessionStatus` (line 167), config variable name (use `ocConfig` not `config` to avoid shadowing).
- Modify: `src/lib/relay/message-poller.ts` — update import of `Message` and `OpenCodeClient` (line 11).
- Modify: `src/lib/relay/message-poller-manager.ts` — update import of `Message` and `OpenCodeClient` (line 13). Update `Pick<OpenCodeClient, "getMessages">` to `Pick<RelayClient, "getMessages">`.
- Modify: `src/lib/relay/status-transitions.ts` — update `SessionStatus` import (line 5).
- Modify: `src/lib/relay/sse-wiring.ts` — update dynamic type import of `SessionStatus` (line 78).
- Modify: `src/lib/handlers/agent.ts` — update `Agent` type import (line 3). **Adapt `filterAgents()`** to work with SDK Agent type: use `a.name` as identifier instead of `a.id`, use `a.mode !== "subagent"` instead of `!a.hidden`.
- Modify: `src/lib/daemon/daemon.ts` — update dynamic import at line 1001 from `OpenCodeClient` to `RelayClient`/`createRelayClient`.
- Modify: `test/helpers/mock-factories.ts` — update `createMockClient()` return type to match `RelayClient` (same method names, just different import path).

**Step 1: Update all source file imports** (batch — all are independent)

Since `RelayClient` has the same method signatures as `OpenCodeClient`, no method-call changes are needed. This is purely:
```typescript
// Before:
import { OpenCodeClient } from "../instance/opencode-client.js";
// After:
import { RelayClient } from "../instance/sdk-client.js";
```

**Step 2: Update mock factories**

`test/helpers/mock-factories.ts` `createMockClient()` stubs 30+ methods. Since method names are identical, only the return type annotation and import change. The mock method signatures stay the same.

**Step 3: Run verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

All should pass because `RelayClient` exposes the same flat API.

**Step 4: Commit (split by risk)**

Commit 1 — Low risk (simple files):
```bash
git add src/lib/relay/status-transitions.ts src/lib/relay/sse-wiring.ts src/lib/relay/message-poller-manager.ts src/lib/handlers/agent.ts
git commit -m "refactor: swap OpenCodeClient imports to RelayClient in simple modules"
```

Commit 2 — Medium risk (core modules):
```bash
git add src/lib/handlers/types.ts src/lib/bridges/client-init.ts src/lib/session/session-manager.ts src/lib/session/session-status-poller.ts src/lib/relay/message-poller.ts
git commit -m "refactor: swap OpenCodeClient imports to RelayClient in session/handler core"
```

Commit 3 — Higher risk (hub file + daemon):
```bash
git add src/lib/relay/relay-stack.ts src/lib/daemon/daemon.ts test/helpers/mock-factories.ts
git commit -m "refactor: swap to RelayClient in relay-stack, daemon, and test factories"
```

---

### Task 6: Update Test Files

All 10 test files that import from `opencode-client.ts` need import path updates. Since `RelayClient` has the same flat API, most changes are mechanical import swaps.

**Files:**
- Modify: `test/unit/session/session-manager-processing.test.ts`
- Modify: `test/unit/session/session-status-poller.test.ts`
- Modify: `test/unit/session/session-manager.pbt.test.ts`
- Modify: `test/unit/session/session-status-poller-augment.test.ts`
- Modify: `test/unit/session/session-manager-parentid.test.ts`
- Modify: `test/unit/server/m4-backend.test.ts` (lines 150-167 test OpenCodeClient methods — rewrite for RelayClient)
- Modify: `test/unit/relay/message-poller.test.ts`
- Modify: `test/unit/relay/status-transitions.test.ts`
- Modify: `test/integration/flows/sse-consumer.integration.ts` (uses OpenCodeClient as REST helper — simple 3-line swap: import, type annotation, constructor)
- Modify: `test/integration/flows/rest-client.integration.ts` (tests OpenCodeClient directly — change constructor, import, and SessionDetail type import)

**Step 1: Update import paths and type references** in all test files.

Import from new locations — do NOT rely on the Task 4 bridge in `opencode-client.ts` (Task 7 will delete it).

**Type import mapping:**
| Type | New Import Location |
|------|-------------------|
| `OpenCodeClient` | `RelayClient` from `sdk-client.ts` |
| `SessionStatus` | SDK or `relay-types.ts` (per Task 4) |
| `Message` | SDK or `relay-types.ts` (per Task 4) |
| `SessionDetail` | SDK `Session` or `relay-types.ts` (per Task 4) |

**Non-mechanical swaps (not just import path changes):**
- `session-manager.pbt.test.ts`: Has 4 `OpenCodeClient` references (lines 7, 9, 24, 84) — type casts and mock construction. Rename all to `RelayClient`.
- `session-manager-parentid.test.ts`: Type cast on line 22 (`as unknown as OpenCodeClient`) must become `as unknown as RelayClient`.

**Step 2: Update `rest-client.integration.ts`** to test `RelayClient` instead of `OpenCodeClient`. Change constructor and import. Also update `SessionDetail` type import (lines 7, 85, 95) to new location. Verify trailing-slash normalization test (lines 182-188) still passes — `RelayClient` constructor strips trailing slashes before passing to SDK.

**Step 3: Rewrite `m4-backend.test.ts`** method existence checks (lines 150-167). Change dynamic import path from `opencode-client.js` to `sdk-client.js`, destructure `RelayClient` instead of `OpenCodeClient`, rename `new OpenCodeClient(...)` to `new RelayClient(...)`. Method names stay the same.

**Step 4: Run all tests**

```bash
pnpm test:unit
pnpm test:integration
```

**Step 5: Commit**

```bash
git commit -m "test: update all test imports from OpenCodeClient to RelayClient"
```

---

### Task 7: Delete `opencode-client.ts`

**Files:**
- Delete: `src/lib/instance/opencode-client.ts`

**Step 1: Final import sweep**

```bash
rg "opencode-client" --type ts
```

Fix any remaining references (should be zero after Tasks 4-6, plus `mock-factories.ts` from Task 5). Note: `terminal.ts:114` has a code comment referencing `opencode-client` — update it to reference `sdk-client.ts`/`RelayClient`, but it's not a blocking import.

**Step 2: Delete the file**

```bash
rm src/lib/instance/opencode-client.ts
```

**Step 3: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete hand-rolled OpenCodeClient, fully replaced by RelayClient"
```

---

### Task 8: Clean Up Redundant Types (Post-Deletion Verification & Cleanup)

By this point, `opencode-client.ts` is deleted (Task 7) and types were migrated in Tasks 4-7. This task verifies the migration is correct, cleans up dead types, and documents what stays.

**Files:**
- Modify: `src/lib/types.ts` — remove dead types, verify no SDK duplicates remain
- Verify: `src/lib/shared-types.ts` — confirm relay-to-browser types are untouched (NOT candidates for SDK replacement)
- Verify: `src/lib/instance/relay-types.ts` — confirm it contains only relay-specific types (keep the file; Task 4 created it for this purpose)

**Step 1: Verify type migration completeness**

Verify all types currently in `relay-types.ts` are genuinely relay-specific and not duplicating an SDK type that became available. For types that migrated through Tasks 4-7, confirm the SDK type is actually being used where expected. Use a temp type-check file (not committed) for bidirectional assignability:
```typescript
// temp-type-check.ts (not committed)
import type { Session } from "@opencode-ai/sdk";
import type { SessionDetail } from "./relay-types.js";
const _check1: Session = {} as SessionDetail; // Does this compile?
const _check2: SessionDetail = {} as Session; // Bidirectional?
```

**Step 2: Verify relay-specific types, clean up dead types, replace duplicates**

Types to definitely KEEP (relay-specific, no SDK equivalent):
- `PromptOptions`, `PermissionReplyOptions`, `QuestionReplyOptions` — relay input types
- `ProviderListResult` — relay-constructed normalization output
- `HealthResponse` — relay-fabricated (note: there are TWO `HealthResponse` types — the one from `opencode-client.ts` is the API health check, now in `relay-types.ts`; the one in `shared-types.ts` is the relay HTTP endpoint response. Both are relay-specific.)
- `PtyCreateOptions` — relay-specific
- `OpenCodeEvent` — extended by 15+ event interfaces in `opencode-events.ts`, MUST stay as-is
- `PendingPermission` — relay-internal (created by PermissionBridge, has `timestamp`, `always`)
- `SessionInfo`, `HistoryMessage`, `AgentInfo`, `ProviderInfo` — relay-to-browser transforms

**Types in `shared-types.ts` are relay-to-browser transform types** (WebSocket messages, frontend stores). None are direct SDK equivalents. Do not attempt SDK replacement.

**Remove dead types from `types.ts`:** `PartState`, `PartDelta`, and `ModelEntry` are defined but never imported by any file (zero importers). Delete them.

Types to replace with SDK imports (if structurally compatible):
- `SessionDetail` → SDK `Session` (verify `title` optionality — keep `?? "Untitled"` fallback as defensive coding even if SDK makes `title` required)
- `SessionStatus` → SDK `SessionStatus` (confirmed identical by audit)
- `SessionCreateOptions`, `SessionListOptions` → SDK equivalents if they exist

**Step 3: Handle `Message` → `HistoryMessage` cast**

`session-manager.ts:149` does `as unknown as HistoryMessage[]`. Since `RelayClient.getMessages()` normalizes into the old flat `Message` shape (per Task 3), the unsafe cast continues to work after migration. Add a TODO comment at the cast site: `// TODO: Replace unsafe cast with toHistoryMessage() mapping function`.

**Step 4: Verify no deletions break consumers**

`shared-types.ts` is imported by 50+ files, `types.ts` by 64+ files. Run `rg 'TypeName' --type ts -l` for each removed type before deleting. Note: `shared-types.ts` types should NOT have been modified — verify they are untouched.

**Step 5: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 6: Commit**

```bash
git commit -m "refactor: remove redundant types now provided by SDK"
```

---

### Task 9: Final Verification

**Step 1: Run the full verification suite**

```bash
pnpm check
pnpm lint
pnpm test:unit
pnpm test:integration
pnpm test:contract   # Validates REST endpoint response shapes — most relevant for SDK migration
pnpm test:e2e
```

**Optional (if `opencode` is on `$PATH` with valid API credentials):**
```bash
pnpm test:e2e:live   # Automated equivalent of manual smoke test
```

**Step 2: Dead import sweep**

```bash
rg "opencode-client" src/ test/
```

Should return zero results. Comments referencing `opencode-client` (e.g., `terminal.ts:114`) should have been updated in Task 7 but are not blocking if missed.

**Step 3: Smoke test against a live OpenCode instance**

Start the relay and verify:
- Session list loads
- Creating a session works
- Sending a message works (prompt_async)
- **Messages display correctly with text content, tool calls, and thinking blocks** (confirms normalizeMessage path works)
- Permission/question prompts appear and can be replied to
- PTY terminals work
- **SSE events stream in real-time** (verify assistant response streams, not just final state)
- File browser works
- Model switching works
- Session history pagination works

**Step 4: Check bundle/dependency impact**

```bash
pnpm ls @opencode-ai/sdk
```

Verify the SDK version matches what was tested and no unexpected transitive dependencies.

---

## Resolved Questions

1. **Permission reply path:** Server supports `POST /permission/{id}/reply` (non-deprecated). SDK path `/session/{id}/permissions/{permissionID}` is deprecated. Use old path via custom `replyPermission()` method. No sessionId threading needed.

2. **Response shape:** `responseStyle: "data"` with `throwOnError: true`. Methods return data directly, errors throw. Matches existing behavior. No `.data` extraction needed.

3. **Message normalization:** Normalized inside `RelayClient.getMessages()`. Callers never see `{ info, parts }` envelopes. `normalizeMessage()`/`normalizeMessages()` move into `RelayClient`.

4. **Provider endpoint:** `provider.list()` (`GET /provider`) consistently. Returns `{ all, default, connected }`. Normalization (models keyed→array, field renaming) lives inside `RelayClient.listProviders()`.

5. **Architecture:** Composition, not inheritance. `RelayClient` wraps `OpencodeClient` and exposes the same flat API as `OpenCodeClient`.

6. **Node.js minimum:** Bumped to 20 (enables `AbortSignal.any()`).

7. **Commits:** Split by risk level within each task.
