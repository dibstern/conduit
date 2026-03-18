# Default Model + Per-Tab Sessions Implementation Plan (v3)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent default model settings and per-tab session selection with URL routing, plus fix 5 architectural limitations that would break or degrade multi-session support.

**Architecture:** Two independent features plus infrastructure fixes. Feature 1 (default model) adds relay settings persistence + UI control. Feature 2 (per-tab sessions) replaces the global active session with per-client session tracking, routes SSE events to the right clients, and adds URL-based session routing. Part C fixes 5 architectural limitations: per-session processing timeouts, multi-session message polling, per-session model/agent overrides, translator memory cap, and `getActiveSessionId()` semantics.

**Tech Stack:** TypeScript, Vitest, Svelte 5 (runes), `ws` library, JSONC config files

**Key architectural decisions for per-tab sessions:**
- The translator's `seenParts` map uses globally unique part IDs — parts from different sessions never collide. We stop calling `translator.reset()` on session view changes and let it accumulate state (with a size cap to prevent unbounded growth — see Task 22).
- The `session_changed` event (which resets the translator) is only emitted when a new session is *created*, not when a client *views* a different session.
- Processing timeouts are per-session so two tabs sending to different sessions get independent timeouts (Task 20).
- Message polling supports multiple concurrent sessions via `MessagePollerManager` since the user uses both OpenCode TUI and the relay simultaneously (Task 21).
- Model/agent overrides are per-session so switching model in session A doesn't affect session B (Task 20).

---

## Part A: Default Model Setting

### Task 1: RelaySettings persistence layer

**Files:**
- Create: `src/lib/relay-settings.ts`
- Create: `test/unit/relay-settings.test.ts`

**Step 1: Write the failing test**

```typescript
// test/unit/relay-settings.test.ts
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRelaySettings,
  saveRelaySettings,
  parseDefaultModel,
} from "../../src/lib/relay-settings.js";

describe("relay-settings", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "relay-settings-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("loadRelaySettings", () => {
    it("returns empty settings when file does not exist", () => {
      const settings = loadRelaySettings(tempDir);
      expect(settings).toEqual({});
    });

    it("parses valid JSON settings", () => {
      writeFileSync(
        join(tempDir, "settings.jsonc"),
        JSON.stringify({ defaultModel: "anthropic/claude-sonnet-4-20250514" }),
      );
      const settings = loadRelaySettings(tempDir);
      expect(settings.defaultModel).toBe("anthropic/claude-sonnet-4-20250514");
    });

    it("strips JSONC comments before parsing", () => {
      writeFileSync(
        join(tempDir, "settings.jsonc"),
        '{\n  // Default model\n  "defaultModel": "openai/gpt-4o" /* inline */\n}',
      );
      const settings = loadRelaySettings(tempDir);
      expect(settings.defaultModel).toBe("openai/gpt-4o");
    });

    it("returns empty settings on corrupt file", () => {
      writeFileSync(join(tempDir, "settings.jsonc"), "not json{{{");
      const settings = loadRelaySettings(tempDir);
      expect(settings).toEqual({});
    });
  });

  describe("saveRelaySettings", () => {
    it("creates the file with correct content", () => {
      saveRelaySettings({ defaultModel: "anthropic/claude-opus-4-6" }, tempDir);
      const content = readFileSync(join(tempDir, "settings.jsonc"), "utf-8");
      expect(JSON.parse(content)).toEqual({ defaultModel: "anthropic/claude-opus-4-6" });
    });

    it("creates the directory if missing", () => {
      const nested = join(tempDir, "nested", "dir");
      saveRelaySettings({ defaultModel: "test/model" }, nested);
      const content = readFileSync(join(nested, "settings.jsonc"), "utf-8");
      expect(JSON.parse(content).defaultModel).toBe("test/model");
    });

    it("overwrites existing settings atomically", () => {
      saveRelaySettings({ defaultModel: "old/model" }, tempDir);
      saveRelaySettings({ defaultModel: "new/model" }, tempDir);
      const settings = loadRelaySettings(tempDir);
      expect(settings.defaultModel).toBe("new/model");
    });
  });

  describe("parseDefaultModel", () => {
    it("splits provider/model string into ModelOverride", () => {
      expect(parseDefaultModel("anthropic/claude-opus-4-6")).toEqual({
        providerID: "anthropic",
        modelID: "anthropic/claude-opus-4-6",
      });
    });

    it("returns undefined for empty string", () => {
      expect(parseDefaultModel("")).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseDefaultModel(undefined)).toBeUndefined();
    });
  });
});
```

**Step 2:** Run: `pnpm vitest run test/unit/relay-settings.test.ts` → Expected: FAIL (module not found)

**Step 3: Write implementation**

```typescript
// src/lib/relay-settings.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG_DIR } from "./env.js";
import type { ModelOverride } from "./session-overrides.js";

export interface RelaySettings {
  defaultModel?: string;
}

const SETTINGS_FILE = "settings.jsonc";

function resolveDir(configDir?: string): string {
  return configDir ?? DEFAULT_CONFIG_DIR;
}

function stripComments(text: string): string {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

export function loadRelaySettings(configDir?: string): RelaySettings {
  try {
    const dir = resolveDir(configDir);
    const raw = readFileSync(join(dir, SETTINGS_FILE), "utf-8");
    return JSON.parse(stripComments(raw)) as RelaySettings;
  } catch {
    return {};
  }
}

export function saveRelaySettings(settings: RelaySettings, configDir?: string): void {
  const dir = resolveDir(configDir);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${SETTINGS_FILE}.tmp`);
  const finalPath = join(dir, SETTINGS_FILE);
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf-8");
  renameSync(tmpPath, finalPath);
}

export function parseDefaultModel(value: string | undefined): ModelOverride | undefined {
  if (!value) return undefined;
  const slashIdx = value.indexOf("/");
  if (slashIdx <= 0) return undefined;
  return { providerID: value.slice(0, slashIdx), modelID: value };
}
```

**Step 4:** Run: `pnpm vitest run test/unit/relay-settings.test.ts` → Expected: PASS

**Step 5:** Commit: `feat: add relay settings persistence layer`

---

### Task 2: SessionOverrides — default model + per-session overrides + per-session timeouts

**Files:**
- Modify: `src/lib/session-overrides.ts`
- Modify: `test/unit/session-overrides.test.ts`

This is a major refactor of SessionOverrides. The class changes from holding global state to managing per-session state with a global default model.

**Step 1: Write failing tests** — Add test blocks for:

```typescript
describe("defaultModel", () => {
  it("setDefaultModel stores the default", () => { ... });
  it("getModel returns defaultModel for unknown sessions", () => { ... });
  it("clearSession restores to defaultModel", () => { ... });
  it("clearSession with no defaultModel returns undefined", () => { ... });
});

describe("per-session overrides", () => {
  it("setModel scopes to session", () => {
    overrides.setModel("sess-1", { providerID: "a", modelID: "a/m1" });
    overrides.setModel("sess-2", { providerID: "b", modelID: "b/m2" });
    expect(overrides.getModel("sess-1")?.modelID).toBe("a/m1");
    expect(overrides.getModel("sess-2")?.modelID).toBe("b/m2");
  });
  it("setAgent scopes to session", () => { ... });
  it("isModelUserSelected scopes to session", () => { ... });
});

describe("per-session processing timeout", () => {
  it("startProcessingTimeout scoped to session", () => { ... });
  it("clearProcessingTimeout only clears that session's timer", () => { ... });
  it("two sessions can have independent timeouts", () => { ... });
});
```

**Step 2:** Run: `pnpm vitest run test/unit/session-overrides.test.ts` → Expected: FAIL

**Step 3: Implement** — Refactor the class:

```typescript
interface SessionState {
  model?: ModelOverride;
  agent?: string;
  modelUserSelected: boolean;
  processingTimer: ReturnType<typeof setTimeout> | null;
}

export class SessionOverrides {
  defaultModel: ModelOverride | undefined = undefined;
  private sessions: Map<string, SessionState> = new Map();

  private getOrCreate(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { modelUserSelected: false, processingTimer: null };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  setDefaultModel(model: ModelOverride): void { this.defaultModel = model; }

  setModel(sessionId: string, model: ModelOverride): void {
    const s = this.getOrCreate(sessionId);
    s.model = model;
    s.modelUserSelected = true;
  }

  setModelDefault(sessionId: string, model: ModelOverride): void {
    const s = this.getOrCreate(sessionId);
    s.model = model;
    // Don't touch modelUserSelected
  }

  getModel(sessionId: string): ModelOverride | undefined {
    return this.sessions.get(sessionId)?.model ?? this.defaultModel;
  }

  getAgent(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agent;
  }

  isModelUserSelected(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.modelUserSelected ?? false;
  }

  setAgent(sessionId: string, agentId: string): void {
    this.getOrCreate(sessionId).agent = agentId;
  }

  clearSession(sessionId: string): void {
    const timer = this.sessions.get(sessionId)?.processingTimer;
    if (timer) clearTimeout(timer);
    this.sessions.delete(sessionId);
  }

  startProcessingTimeout(sessionId: string, onTimeout: () => void): void {
    const s = this.getOrCreate(sessionId);
    if (s.processingTimer) clearTimeout(s.processingTimer);
    s.processingTimer = setTimeout(() => {
      s.processingTimer = null;
      onTimeout();
    }, PROCESSING_TIMEOUT_MS);
  }

  clearProcessingTimeout(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (s?.processingTimer) {
      clearTimeout(s.processingTimer);
      s.processingTimer = null;
    }
  }

  dispose(): void {
    for (const [, s] of this.sessions) {
      if (s.processingTimer) clearTimeout(s.processingTimer);
    }
    this.sessions.clear();
  }
}
```

**IMPORTANT: API change** — All methods that were previously global (`setModel(model)`, `setAgent(id)`, `clear()`, `startProcessingTimeout(cb)`, `clearProcessingTimeout()`) now take a `sessionId` as first parameter. All callers must be updated. This affects:
- `src/lib/handlers/prompt.ts` — handleMessage, handleCancel
- `src/lib/handlers/model.ts` — handleSwitchModel, handleGetModels
- `src/lib/handlers/session.ts` — handleNewSession
- `src/lib/client-init.ts` — auto-detect model
- `src/lib/relay-stack.ts` — session_changed handler, SSE wiring
- `src/lib/sse-wiring.ts` — clearProcessingTimeout on done

These callers will be updated in Tasks 5, 6, 10-14 as they're touched. For now, ensure the new API compiles by updating the minimal callers needed for tests to pass.

**Step 4:** Run tests → Expected: PASS

**Step 5:** Commit: `feat: refactor SessionOverrides to per-session state with default model`

---

### Task 3: Type definitions for new message types

**Files:**
- Modify: `src/lib/shared-types.ts` — add `default_model_info` to `RelayMessage` union
- Modify: `src/lib/ws-router.ts` — add `set_default_model` and `view_session` to both `IncomingMessageType` union AND `VALID_MESSAGE_TYPES` set

**Step 1: Add to shared-types.ts** (after `model_info` line ~205):

```typescript
| { type: "default_model_info"; model: string; provider: string }
```

**Step 2: Add to ws-router.ts** `IncomingMessageType` (the type union, ~line 10-42):

```typescript
| "set_default_model"
| "view_session"
```

**Step 3: Add to ws-router.ts** `VALID_MESSAGE_TYPES` (the Set, ~line 44-77):

```typescript
"set_default_model",
"view_session",
```

**Step 4:** Run: `pnpm test:unit` → Expected: PASS

**Step 5:** Commit: `feat: add message type definitions for default model and view_session`

---

### Task 4: Handler deps interface — add session tracking methods

**Files:**
- Modify: `src/lib/handlers/types.ts` — extend `HandlerDeps.wsHandler`
- Modify: `src/lib/client-init.ts` — extend `ClientInitDeps.wsHandler`
- Modify: `src/lib/sse-wiring.ts` — extend `SSEWiringDeps.wsHandler`

**Step 1: Modify HandlerDeps.wsHandler** in `src/lib/handlers/types.ts` (~line 16-20):

```typescript
wsHandler: {
  broadcast: (msg: RelayMessage) => void;
  broadcastExcept: (msg: RelayMessage, excludeClientId: string) => void;
  sendTo: (clientId: string, msg: RelayMessage) => void;
  // Per-tab session tracking
  setClientSession: (clientId: string, sessionId: string) => void;
  getClientSession: (clientId: string) => string | undefined;
  getClientsForSession: (sessionId: string) => string[];
  sendToSession: (sessionId: string, msg: RelayMessage) => void;
};
```

**Step 2: Modify ClientInitDeps.wsHandler** in `src/lib/client-init.ts` (~line 24-27):

```typescript
wsHandler: {
  broadcast: (msg: RelayMessage) => void;
  sendTo: (clientId: string, msg: RelayMessage) => void;
  setClientSession: (clientId: string, sessionId: string) => void;
};
```

**Step 3: Modify SSEWiringDeps.wsHandler** in `src/lib/sse-wiring.ts` (~line 84-86):

```typescript
wsHandler: {
  broadcast: (msg: RelayMessage) => void;
  sendToSession: (sessionId: string, msg: RelayMessage) => void;
  getClientsForSession: (sessionId: string) => string[];
};
```

**Step 4:** Run: `pnpm test:unit` → May have failures from mock deps not implementing new methods. Fix mock `createMockDeps()` in test files by adding `vi.fn()` stubs for the new methods.

**Step 5:** Commit: `feat: extend handler deps interfaces with session tracking methods`

---

### Task 5: Wire relay settings into relay-stack + client-init

**Files:**
- Modify: `src/lib/relay-stack.ts` — load settings on startup
- Modify: `src/lib/client-init.ts` — send default_model_info, prefer settings default

**Step 1: In relay-stack.ts**, after `const overrides = new SessionOverrides();` (~line 159):

```typescript
import { loadRelaySettings, parseDefaultModel } from "./relay-settings.js";

const relaySettings = loadRelaySettings(config.configDir);
const defaultModel = parseDefaultModel(relaySettings.defaultModel);
if (defaultModel) {
  overrides.setDefaultModel(defaultModel);
  log(`   ✓ Default model from settings: ${relaySettings.defaultModel}`);
}
```

**Step 2: In client-init.ts**, after sending model_list (~line 200), add:

```typescript
if (overrides.defaultModel) {
  wsHandler.sendTo(clientId, {
    type: "default_model_info",
    model: overrides.defaultModel.modelID,
    provider: overrides.defaultModel.providerID,
  });
}
```

**Step 3:** Run: `pnpm test:unit` → Expected: PASS

**Step 4:** Commit: `feat: wire relay settings into startup and client init`

---

### Task 6: set_default_model handler + registration

**Files:**
- Modify: `src/lib/handlers/model.ts` — add `handleSetDefaultModel`
- Modify: `src/lib/handlers/index.ts` — import, export, and add to `MESSAGE_HANDLERS`
- Create: `test/unit/handlers-model.test.ts`

**Step 1: Write tests**

```typescript
describe("handleSetDefaultModel", () => {
  it("persists model and broadcasts model_info + default_model_info", async () => {
    const deps = createMockDeps();
    await handleSetDefaultModel(deps, "client-1", {
      provider: "anthropic", model: "anthropic/claude-opus-4-6",
    });
    expect(deps.overrides.defaultModel).toEqual({
      providerID: "anthropic", modelID: "anthropic/claude-opus-4-6",
    });
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "model_info" }),
    );
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "default_model_info" }),
    );
  });

  it("ignores empty provider or model", async () => {
    const deps = createMockDeps();
    await handleSetDefaultModel(deps, "client-1", { provider: "", model: "" });
    expect(deps.wsHandler.broadcast).not.toHaveBeenCalled();
  });
});
```

**Step 2: Implement handler** in `src/lib/handlers/model.ts`:

```typescript
import { saveRelaySettings } from "../relay-settings.js";

export async function handleSetDefaultModel(
  deps: HandlerDeps, clientId: string, payload: Record<string, unknown>,
): Promise<void> {
  const provider = String(payload.provider ?? "");
  const model = String(payload.model ?? "");
  if (!provider || !model) return;

  const override = { providerID: provider, modelID: model };
  deps.overrides.setDefaultModel(override);
  // Also set as active model for the client's current session
  const sessionId = deps.wsHandler.getClientSession(clientId);
  if (sessionId) deps.overrides.setModel(sessionId, override);
  saveRelaySettings({ defaultModel: model }, deps.config.configDir);

  deps.wsHandler.broadcast({ type: "model_info", model, provider });
  deps.wsHandler.broadcast({ type: "default_model_info", model, provider });
  deps.log(`   [model] client=${clientId} Set default: ${model} (${provider})`);
}
```

**Step 3: Register in index.ts** — Add import of `handleSetDefaultModel` from `./model.js`, add to exports, add `set_default_model: handleSetDefaultModel` to `MESSAGE_HANDLERS`.

**Step 4:** Run: `pnpm test:unit` → Expected: PASS

**Step 5:** Commit: `feat: add set_default_model WS handler`

---

### Task 7: Frontend — default model UI

**Files:**
- Modify: `src/lib/public/stores/discovery.svelte.ts` — add default model state + `handleDefaultModelInfo`
- Modify: `src/lib/public/stores/ws.svelte.ts` — add `case "default_model_info"` to dispatch switch, import `handleDefaultModelInfo`
- Modify: `src/lib/public/components/layout/ModelSelector.svelte` (or wherever the model dropdown is) — add "Set as default" action
- Modify: `test/unit/svelte-discovery-store.test.ts` — test the new handler

**Step 1: In discovery.svelte.ts**, add to `discoveryState`:

```typescript
defaultModelId: "" as string,
defaultProviderId: "" as string,
```

Add handler:

```typescript
export function handleDefaultModelInfo(
  msg: Extract<RelayMessage, { type: "default_model_info" }>,
): void {
  discoveryState.defaultModelId = msg.model ?? "";
  discoveryState.defaultProviderId = msg.provider ?? "";
}
```

**Step 2: In ws.svelte.ts**, import `handleDefaultModelInfo` from discovery store. Add dispatch case after `model_info`:

```typescript
case "default_model_info":
  handleDefaultModelInfo(msg);
  break;
```

**Step 3: In ModelSelector**, add a "Set as default" action:

```typescript
wsSend({ type: "set_default_model", provider: selectedProvider, model: selectedModel });
```

Show which model is default (star icon filled vs outline, comparing `discoveryState.defaultModelId`).

**Step 4:** Run: `pnpm build` → Expected: PASS

**Step 5:** Commit: `feat: frontend default model UI`

---

## Part B: Per-Tab Session Selection

### Task 8: WsHandler — per-client session tracking

**Files:**
- Modify: `src/lib/ws-handler.ts` — add `clientSessions` map + 4 methods + cleanup on disconnect
- Create: `test/unit/ws-handler-sessions.test.ts`

**Step 1: Write tests**

```typescript
describe("per-client session tracking", () => {
  // Use real HTTP server + WS handler (same pattern as ws-handler.pbt.test.ts)
  it("setClientSession and getClientSession round-trip", () => { ... });
  it("getClientsForSession returns only matching clients", () => { ... });
  it("sendToSession sends only to session viewers", () => { ... });
  it("disconnect removes client from clientSessions map", () => { ... });
  it("getClientsForSession returns empty array for unknown session", () => { ... });
});
```

**Step 2: Implement** in `src/lib/ws-handler.ts`:

Add property: `private readonly clientSessions: Map<string, string> = new Map();`

Add 4 public methods: `setClientSession`, `getClientSession`, `getClientsForSession`, `sendToSession`.

In `onConnection` close handler (~line 195-199), add: `this.clientSessions.delete(clientId);`

In `close()` method (~line 152-164), add: `this.clientSessions.clear();`

**Step 3:** Run tests → Expected: PASS

**Step 4:** Commit: `feat: add per-client session tracking to WsHandler`

---

### Task 9: SessionManager — suppress broadcasts from createSession

**Files:**
- Modify: `src/lib/session-manager.ts` — add `silent` option to `createSession`
- Modify: `test/unit/session-manager.test.ts` (if exists) or test alongside Task 10

**Problem:** `createSession()` (line 152-162) emits `session_switched` and `session_list` broadcasts to ALL clients. `deleteSession()` (line 183-202) also broadcasts `session_switched`. With per-tab sessions, these should be scoped to the requesting client.

**Step 1: Modify createSession** to accept options:

```typescript
async createSession(title?: string, opts?: { silent?: boolean }): Promise<SessionDetail> {
  const session = await this.client.createSession(title ? { title } : {});
  this.activeSessionId = session.id;
  this.emit("session_changed", { sessionId: session.id });

  if (!opts?.silent) {
    this.emit("broadcast", { type: "session_switched", id: session.id });
    await this.broadcastSessionList();
  }

  return session;
}
```

**Step 2: Modify deleteSession** — when deleting the active session and switching to the next, emit `session_changed` but NOT `session_switched` broadcast (let the handler scope it):

```typescript
async deleteSession(sessionId: string, opts?: { silent?: boolean }): Promise<void> {
  await this.client.deleteSession(sessionId);

  if (this.activeSessionId === sessionId) {
    const remaining = await this.listSessions();
    if (remaining.length > 0) {
      this.activeSessionId = remaining[0]!.id;
      this.emit("session_changed", { sessionId: this.activeSessionId });
      if (!opts?.silent) {
        this.emit("broadcast", { type: "session_switched", id: this.activeSessionId });
      }
    } else {
      this.activeSessionId = null;
    }
  }

  if (!opts?.silent) {
    await this.broadcastSessionList();
  }
}
```

**Step 3:** Run: `pnpm test:unit` → Expected: PASS

**Step 4:** Commit: `feat: add silent option to SessionManager createSession/deleteSession`

---

### Task 10: view_session handler + refactor all session handlers

**Files:**
- Modify: `src/lib/handlers/session.ts` — add `handleViewSession`, refactor `handleNewSession`, `handleDeleteSession`, `handleForkSession`
- Modify: `src/lib/handlers/index.ts` — register `view_session`, alias `switch_session`
- Create: `test/unit/handlers-session.test.ts`

**Step 1: Write tests**

```typescript
describe("handleViewSession", () => {
  it("sets client session and sends history to that client only", async () => {
    const deps = createMockDeps();
    deps.messageCache.getEvents = vi.fn().mockReturnValue(null);
    deps.sessionMgr.loadHistory = vi.fn().mockResolvedValue({
      messages: [], hasMore: false, total: 0,
    });

    await handleViewSession(deps, "client-1", { sessionId: "sess-1" });

    expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith("client-1", "sess-1");
    expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
      "client-1", expect.objectContaining({ type: "session_switched", id: "sess-1" }),
    );
    // Also sends model_info and status
    expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
      "client-1", expect.objectContaining({ type: "status" }),
    );
    // Should NOT broadcast
    expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_switched" }),
    );
  });
});

describe("handleNewSession (per-tab)", () => {
  it("only sends session_switched to requesting client", async () => {
    const deps = createMockDeps();
    deps.sessionMgr.createSession = vi.fn().mockResolvedValue({ id: "new-sess" });
    deps.sessionMgr.listSessions = vi.fn().mockResolvedValue([]);

    await handleNewSession(deps, "client-1", {});

    expect(deps.wsHandler.setClientSession).toHaveBeenCalledWith("client-1", "new-sess");
    expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
      "client-1", expect.objectContaining({ type: "session_switched" }),
    );
    // session_list goes to all
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_list" }),
    );
  });
});
```

**Step 2: Implement handleViewSession** (does NOT call `sessionMgr.switchSession` — no translator reset, no poller restart):

```typescript
export async function handleViewSession(
  deps: HandlerDeps, clientId: string, payload: Record<string, unknown>,
): Promise<void> {
  const id = String(payload.sessionId ?? "");
  if (!id) return;

  deps.wsHandler.setClientSession(clientId, id);

  // Send session history to THIS client only
  const events = deps.messageCache.getEvents(id);
  const hasChatContent = events?.some((e) => e.type === "user_message" || e.type === "delta") ?? false;

  if (events && hasChatContent) {
    deps.wsHandler.sendTo(clientId, { type: "session_switched", id, events });
  } else {
    try {
      const history = await deps.sessionMgr.loadHistory(id);
      deps.wsHandler.sendTo(clientId, {
        type: "session_switched", id,
        history: { messages: history.messages, hasMore: history.hasMore, total: history.total },
      });
    } catch {
      deps.wsHandler.sendTo(clientId, { type: "session_switched", id });
    }
  }

  try {
    const session = await deps.client.getSession(id);
    if (session.modelID) {
      deps.wsHandler.sendTo(clientId, {
        type: "model_info", model: session.modelID, provider: session.providerID ?? "",
      });
    }
  } catch { /* non-fatal */ }

  deps.wsHandler.sendTo(clientId, {
    type: "status",
    status: deps.statusPoller?.isProcessing(id) ? "processing" : "idle",
  });

  deps.log(`   [session] client=${clientId} Viewing: ${id}`);
}
```

**Step 3: Refactor handleNewSession** — use `{ silent: true }`, scope to client:

```typescript
export async function handleNewSession(
  deps: HandlerDeps, clientId: string, payload: Record<string, unknown>,
): Promise<void> {
  const title = payload.title ? String(payload.title) : undefined;
  const session = await deps.sessionMgr.createSession(title, { silent: true });
  // clearSession for the OLD session is not needed — the old session's overrides stay
  // in the map for other tabs that might still be viewing it.

  deps.wsHandler.setClientSession(clientId, session.id);
  deps.wsHandler.sendTo(clientId, { type: "session_switched", id: session.id });

  const sessions = await deps.sessionMgr.listSessions();
  deps.wsHandler.broadcast({ type: "session_list", sessions });

  deps.log(`   [session] client=${clientId} Created: ${session.id}`);
}
```

**Step 4: Refactor handleDeleteSession** — use `{ silent: true }`, scope:

```typescript
export async function handleDeleteSession(
  deps: HandlerDeps, clientId: string, payload: Record<string, unknown>,
): Promise<void> {
  const id = String(payload.sessionId ?? "");
  if (!id) return;

  const wasActive = deps.wsHandler.getClientSession(clientId) === id;
  deps.messageCache.remove(id);
  await deps.sessionMgr.deleteSession(id, { silent: true });

  if (wasActive) {
    const sessions = await deps.sessionMgr.listSessions();
    if (sessions.length > 0) {
      // Switch only the requesting client to the next session
      await handleViewSession(deps, clientId, { sessionId: sessions[0]!.id });
    }
  }

  const sessions = await deps.sessionMgr.listSessions();
  deps.wsHandler.broadcast({ type: "session_list", sessions });
  deps.log(`   [session] client=${clientId} Deleted: ${id}`);
}
```

**Step 5: Refactor handleForkSession** — scope `session_switched` to client:

In `handleForkSession`, change the `session_switched` broadcast (line ~221) to `sendTo(clientId, ...)`. Keep `session_forked` and `session_list` as broadcasts (sidebar updates).

**Step 6: Register in dispatch table** — In `handlers/index.ts`:
- Import `handleViewSession` from `./session.js`
- Add to exports
- In `MESSAGE_HANDLERS`: `view_session: handleViewSession, switch_session: handleViewSession` (alias)

**Step 7:** Run: `pnpm test:unit` → Fix any failures

**Step 8:** Commit: `feat: per-client session handlers (view, new, delete, fork)`

---

### Task 11: Scope prompt handlers to client's session

**Files:**
- Modify: `src/lib/handlers/prompt.ts` — use client's session for message, cancel, rewind, input_sync
- Modify: `test/unit/message-handlers.test.ts` — add/update tests

**Step 1: Write tests**

```typescript
describe("handleMessage with per-client sessions", () => {
  it("uses client's session instead of global active", async () => {
    const deps = createMockDeps();
    deps.wsHandler.getClientSession = vi.fn().mockReturnValue("client-session-1");
    deps.sessionMgr.getActiveSessionId = vi.fn().mockReturnValue("global-session-2");

    await handleMessage(deps, "client-1", { text: "hello" });

    expect(deps.client.sendMessageAsync).toHaveBeenCalledWith("client-session-1", expect.anything());
  });

  it("broadcasts status:processing to session viewers only", async () => {
    const deps = createMockDeps();
    deps.wsHandler.getClientSession = vi.fn().mockReturnValue("sess-1");

    await handleMessage(deps, "client-1", { text: "hello" });

    expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
      "sess-1", expect.objectContaining({ type: "status", status: "processing" }),
    );
    expect(deps.wsHandler.broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "status" }),
    );
  });
});

describe("handleInputSync with per-client sessions", () => {
  it("only relays to clients viewing the same session", async () => {
    const deps = createMockDeps();
    deps.wsHandler.getClientSession = vi.fn().mockReturnValue("sess-1");
    deps.wsHandler.getClientsForSession = vi.fn().mockReturnValue(["client-1", "client-2", "client-3"]);

    await handleInputSync(deps, "client-1", { text: "typing..." });

    expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-2", expect.objectContaining({ type: "input_sync" }));
    expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-3", expect.objectContaining({ type: "input_sync" }));
    expect(deps.wsHandler.sendTo).not.toHaveBeenCalledWith("client-1", expect.anything());
  });
});
```

**Step 2: Modify handleMessage**

```typescript
export async function handleMessage(deps: HandlerDeps, clientId: string, payload: Record<string, unknown>): Promise<void> {
  const text = String(payload.text ?? "");
  const activeId = deps.wsHandler.getClientSession(clientId) ?? deps.sessionMgr.getActiveSessionId();
  if (!text) return;
  if (!activeId) { /* NO_SESSION error — sendTo(clientId) */ return; }

  // ... cache + send logic unchanged ...

  // CHANGED: status to session viewers only
  deps.wsHandler.sendToSession(activeId, { type: "status", status: "processing" });

  // CHANGED: per-session processing timeout
  deps.overrides.startProcessingTimeout(activeId, () => {
    // CHANGED: error + done to session viewers only
    deps.wsHandler.sendToSession(activeId, new RelayError(...).toMessage());
    deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
  });

  try {
    await deps.client.sendMessageAsync(activeId, prompt);
  } catch (sendErr) {
    deps.overrides.clearProcessingTimeout(activeId);
    deps.wsHandler.sendToSession(activeId, { type: "done", code: 1 });
    deps.wsHandler.sendTo(clientId, RelayError.fromCaught(sendErr, "SEND_FAILED", "Failed to send message").toMessage());
  }
}
```

**Step 3: Modify handleCancel** — use `getClientSession(clientId)`, use `sendToSession` for done.

**Step 4: Modify handleRewind** — use `getClientSession(clientId)`.

**Step 5: Modify handleInputSync** — scope to same-session clients:

```typescript
export async function handleInputSync(deps: HandlerDeps, clientId: string, payload: Record<string, unknown>): Promise<void> {
  const senderSession = deps.wsHandler.getClientSession(clientId);
  if (!senderSession) return;

  const targets = deps.wsHandler.getClientsForSession(senderSession);
  for (const targetId of targets) {
    if (targetId !== clientId) {
      deps.wsHandler.sendTo(targetId, { type: "input_sync", text: String(payload.text ?? ""), from: clientId });
    }
  }
}
```

**Step 6:** Run: `pnpm test:unit` → Fix failures

**Step 7:** Commit: `feat: scope prompt handlers to client's session`

---

### Task 12: Scope remaining handlers that use getActiveSessionId

**Files:**
- Modify: `src/lib/handlers/model.ts` — `handleGetModels` and `handleSwitchModel`
- Modify: `src/lib/handlers/session.ts` — `handleLoadMoreHistory`, `handleForkSession` (fallback)

**Step 1: handleGetModels** (~line 29): Change `deps.sessionMgr.getActiveSessionId()` to `deps.wsHandler.getClientSession(clientId) ?? deps.sessionMgr.getActiveSessionId()`.

**Step 2: handleSwitchModel** (~line 73): Change `deps.wsHandler.broadcast(model_info)` to `deps.wsHandler.sendToSession(clientSession, model_info)` — model switch only affects the session the client is viewing.

**Step 3: handleLoadMoreHistory** (~line 163): Change fallback `deps.sessionMgr.getActiveSessionId()` to `deps.wsHandler.getClientSession(clientId)`.

**Step 4: handleForkSession** (~line 187): Change fallback session lookup. Change `session_switched` broadcast (line ~221) to `sendTo(clientId, ...)`.

**Step 5: dispatchMessage log** in `handlers/index.ts` (~line 150): Change to use `deps.wsHandler.getClientSession?.(clientId) ?? deps.sessionMgr.getActiveSessionId()` (safe optional chain since it's just logging).

**Step 6:** Run: `pnpm test:unit` → Fix failures

**Step 7:** Commit: `feat: scope all handlers to client's session`

---

### Task 13: SSE event routing — per-session instead of global

**Files:**
- Modify: `src/lib/sse-wiring.ts` — replace `isActiveSession` with per-session routing
- Modify: `test/unit/sse-wiring.test.ts` — add multi-session routing tests

**Step 1: Write tests**

```typescript
describe("per-session SSE routing", () => {
  it("routes delta events only to clients viewing that session", () => {
    const deps = createMockSSEDeps();
    deps.wsHandler.getClientsForSession = vi.fn().mockReturnValue(["c1", "c2"]);
    deps.wsHandler.sendToSession = vi.fn();

    const event = makeSSEEvent("message.part.delta", { sessionID: "sess-1", ... });
    handleSSEEvent(deps, event);

    expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("sess-1", expect.anything());
    expect(deps.wsHandler.broadcast).not.toHaveBeenCalled(); // No broadcast for chat events
  });

  it("still broadcasts session_list on session.updated", () => {
    const deps = createMockSSEDeps();
    const event = makeSSEEvent("session.updated", { ... });
    handleSSEEvent(deps, event);

    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_list" }),
    );
  });

  it("caches events even when no clients are viewing the session", () => {
    const deps = createMockSSEDeps();
    deps.wsHandler.getClientsForSession = vi.fn().mockReturnValue([]);

    const event = makeSSEEvent("message.part.delta", { sessionID: "sess-1", ... });
    handleSSEEvent(deps, event);

    expect(deps.messageCache.recordEvent).toHaveBeenCalled();
    expect(deps.wsHandler.sendToSession).not.toHaveBeenCalled();
  });

  it("broadcasts permission_request to all clients regardless of session", () => {
    const deps = createMockSSEDeps();
    const event = makeSSEEvent("permission.asked", { ... });
    handleSSEEvent(deps, event);

    // Permission events should reach all clients
    expect(deps.wsHandler.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "permission_request" }),
    );
  });
});
```

**Step 2: Modify handleSSEEvent** — Replace the `isActiveSession` logic:

```typescript
const targetSessionId = eventSessionId;

for (let msg of toSend) {
  if (msg.type === "done" && targetSessionId) {
    overrides.clearProcessingTimeout();
  }

  // Truncation unchanged...

  // Cache for any session
  const recordId = targetSessionId;
  if (recordId && isCacheable(msg)) {
    messageCache.recordEvent(recordId, msg);
  }

  // Permission/question events: broadcast to all (regardless of session)
  if (msg.type === "ask_user" || msg.type === "ask_user_resolved" ||
      msg.type === "permission_request" || msg.type === "permission_resolved") {
    wsHandler.broadcast(msg);
    continue;
  }

  // Chat events: route to session viewers
  if (targetSessionId) {
    const hasViewers = wsHandler.getClientsForSession(targetSessionId).length > 0;
    if (hasViewers) {
      wsHandler.sendToSession(targetSessionId, msg);
    }
  }
}
```

Keep `session.updated` → `session_list` as `broadcast()` (already above the translate loop).
Keep `connection_status` as `broadcast()` (wired in `wireSSEConsumer`).

**Step 3:** Run: `pnpm test:unit` → Expected: PASS

**Step 4:** Commit: `feat: route SSE events per-session`

---

### Task 14: relay-stack.ts — update sessionMgr broadcast listener + message poller wiring

**Files:**
- Modify: `src/lib/relay-stack.ts` — update `sessionMgr.on("broadcast")`, message poller events, status poller wiring

**Step 1: sessionMgr broadcast listener** (~line 341-358): The `session_switched` augmentation still makes sense for cache hit events. But since `handleNewSession` now uses `{ silent: true }`, this listener will no longer receive session_switched from createSession. Only non-silent paths (if any remain) will hit this. Consider if this listener is still needed. If not, simplify.

**Step 2: Replace `MessagePoller` with `MessagePollerManager`**: Change the import and instantiation:

```typescript
// Before:
const messagePoller = new MessagePoller({ client, log });
// After:
const pollerManager = new MessagePollerManager({ client, log });
```

**Step 3: message poller event wiring** (~line 521-549): Update to use pollerManager events which now include sessionId:

```typescript
pollerManager.on("events", (events, sessionId) => {
  // Signal message activity for this session
  if (events.length > 0 && sessionId) {
    statusPoller.markMessageActivity(sessionId);
  }

  for (let msg of events) {
    // Truncation + caching unchanged...
    if (msg.type === "tool_result") {
      const { truncated, fullContent } = truncateToolResult(msg);
      if (fullContent !== undefined && sessionId) {
        toolContentStore.store(msg.id, fullContent, sessionId);
      }
      msg = truncated;
    }

    if (sessionId && isCacheable(msg)) {
      messageCache.recordEvent(sessionId, msg);
    }

    // Route to session viewers instead of broadcast
    if (sessionId) {
      const hasViewers = wsHandler.getClientsForSession(sessionId).length > 0;
      if (hasViewers) {
        wsHandler.sendToSession(sessionId, msg);
      }
    }
  }
});
```

**Step 4: status poller handler** (~line 480-517): Update to manage pollers for ALL busy sessions, not just the global active session:

```typescript
statusPoller.on("changed", async (statuses) => {
  // ... existing session_list broadcast ...

  // Manage pollers for ALL sessions based on their status
  for (const [sessionId, status] of Object.entries(statuses)) {
    const isBusy = status?.type === "busy" || status?.type === "retry";

    if (isBusy && !pollerManager.isPolling(sessionId)) {
      // Session is busy but no poller — start one (seeded with existing messages)
      client
        .getMessages(sessionId)
        .then((msgs) => pollerManager.startPolling(sessionId, msgs))
        .catch(() => pollerManager.startPolling(sessionId));
    } else if (!isBusy && pollerManager.isPolling(sessionId)) {
      // Session went idle — emit done, stop polling, clear overrides timeout
      pollerManager.emitDone(sessionId);
      pollerManager.stopPolling(sessionId);
      statusPoller.clearMessageActivity(sessionId);
      overrides.clearProcessingTimeout(sessionId);
    }
  }
});
```

**Step 5: session_changed handler** (~line 359-405): Keep translator.reset() here. The `session_changed` event is now only emitted by `createSession` (which resets for new sessions — correct) and `deleteSession` fallback. It is NOT emitted by `handleViewSession` (which doesn't call `sessionMgr.switchSession`). This means the translator is only reset when genuinely needed (new session creation), not on every tab view change. **This is the key architectural fix.**

**Step 6: SSE wiring** — update `clearProcessingTimeout` calls to be per-session:

In `sse-wiring.ts`, where `overrides.clearProcessingTimeout()` is called on `done` events, change to `overrides.clearProcessingTimeout(sessionId)` using the event's session ID.

**Step 7:** Run: `pnpm test:unit` → Fix failures

**Step 8:** Commit: `feat: update relay-stack wiring for per-session routing and multi-poller`

---

### Task 15: Client init — assign session on connect

**Files:**
- Modify: `src/lib/client-init.ts`

**Step 1:** In `handleClientConnected`, after determining `activeId` (~line 81):

```typescript
if (activeId) {
  wsHandler.setClientSession(clientId, activeId);
  // ... existing session_switched send
}
```

**Step 2:** Run: `pnpm test:unit` → Expected: PASS

**Step 3:** Commit: `feat: assign session to client on connect`

---

### Task 16: Frontend — URL routing for sessions

**Files:**
- Modify: `src/lib/public/stores/router.svelte.ts`
- Modify: `src/lib/public/stores/session.svelte.ts`
- Modify: `src/lib/public/stores/ws.svelte.ts`
- Modify: `src/lib/public/components/features/SessionList.svelte` (or wherever session clicks happen)
- Modify: `test/unit/svelte-router-store.test.ts`

**Step 1: Update Route type and parser** in router.svelte.ts:

```typescript
export type Route =
  | { page: "auth" }
  | { page: "setup" }
  | { page: "dashboard" }
  | { page: "chat"; slug: string; sessionId?: string };

export function getCurrentRoute(): Route {
  const path = routerState.path;

  // Match /p/:slug/s/:sessionId (BEFORE the plain /p/:slug/ match)
  const sessionMatch = path.match(/^\/p\/([^/]+)\/s\/([^/]+)\/?$/);
  if (sessionMatch) {
    return { page: "chat", slug: sessionMatch[1]!, sessionId: sessionMatch[2]! };
  }

  // Match /p/:slug/
  const slugMatch = path.match(/^\/p\/([^/]+)\/?$/);
  if (slugMatch) {
    return { page: "chat", slug: slugMatch[1]! };
  }
  // ... rest unchanged
}

export function getCurrentSessionId(): string | null {
  const route = getCurrentRoute();
  return route.page === "chat" ? route.sessionId ?? null : null;
}
```

**Step 2: Add tests** for the new URL pattern in `test/unit/svelte-router-store.test.ts`.

**Step 3: Update session store** — add `switchToSession` function:

```typescript
export function switchToSession(sessionId: string, sendWs: (data: Record<string, unknown>) => void): void {
  sessionState.currentId = sessionId;
  const slug = getCurrentSlug();
  if (slug) navigate(`/p/${slug}/s/${sessionId}`);
  sendWs({ type: "view_session", sessionId });
}
```

**Step 4: Update ws.svelte.ts** — send `view_session` on connect:

In the `open` handler, after `_onConnectFn?.()`:
```typescript
const sessionId = getCurrentSessionId();
if (sessionId) rawSend({ type: "view_session", sessionId });
```

**Step 5: Update ws.svelte.ts** — update URL on receiving `session_switched`:

In the `case "session_switched"` handler, after `handleSessionSwitched(msg)`:
```typescript
const slug = getCurrentSlug();
if (slug && msg.id) replaceRoute(`/p/${slug}/s/${msg.id}`);
```

**Step 6: Update SessionList** — change `switch_session` to use `switchToSession`.

**Step 7:** Run: `pnpm build` → Expected: PASS

**Step 8:** Commit: `feat: URL-based session routing for per-tab independence`

---

### Task 17: Frontend — input_sync receive handler

**Files:**
- Modify: `src/lib/public/stores/ws.svelte.ts` — add `input_sync` dispatch case
- Modify: `src/lib/public/stores/chat.svelte.ts` (or new store) — add `inputSyncState` + handler
- Modify: `src/lib/public/components/layout/InputArea.svelte` — receive + send input_sync

**Step 1: Add inputSyncState** to chat.svelte.ts:

```typescript
export const inputSyncState = $state({
  text: "",
  lastFrom: "",
  lastUpdated: 0,
});

export function handleInputSyncReceived(msg: { text: string; from?: string }): void {
  inputSyncState.text = msg.text ?? "";
  inputSyncState.lastFrom = msg.from ?? "";
  inputSyncState.lastUpdated = Date.now();
}
```

**Step 2: Add dispatch** in ws.svelte.ts:

```typescript
case "input_sync":
  handleInputSyncReceived(msg);
  break;
```

**Step 3: In InputArea.svelte**, add `$effect` to receive:

```typescript
let lastSyncApplied = 0;
$effect(() => {
  if (inputSyncState.lastUpdated > lastSyncApplied) {
    lastSyncApplied = inputSyncState.lastUpdated;
    inputText = inputSyncState.text;
  }
});
```

Add debounced outgoing:

```typescript
let inputSyncTimer: ReturnType<typeof setTimeout> | null = null;
function onInputWithSync() {
  // ... existing input handling ...
  if (inputSyncTimer) clearTimeout(inputSyncTimer);
  inputSyncTimer = setTimeout(() => {
    wsSend({ type: "input_sync", text: inputText });
  }, 300);
}
```

**Step 4:** Run: `pnpm build` → Expected: PASS

**Step 5:** Commit: `feat: functional input text sync between same-session tabs`

---

### Task 18: Integration tests

**Files:**
- Create: `test/integration/flows/per-tab-sessions.integration.ts`

**Step 1: Write tests:**
- Two clients view different sessions independently
- New session only switches the requesting client
- Session list updates reach all clients
- Chat events only reach session viewers
- Multi-session pollers run concurrently for different sessions

**Step 2:** Run: `pnpm test:integration` → Expected: PASS

**Step 3:** Commit: `test: add integration tests for per-tab sessions`

---

### Task 19: Full test suite + cleanup

**Step 1:** Run: `pnpm test:unit` — fix all failures
**Step 2:** Run: `pnpm test:integration` — fix all failures
**Step 3:** Run: `pnpm build` — fix type errors
**Step 4:** Run: `pnpm lint` — fix lint issues
**Step 5:** Commit: `chore: fix tests and lint after per-tab sessions refactor`

---

## Part C: Architectural Limitation Fixes

> These tasks fix the 5 identified architectural limitations that would break or degrade multi-session support. Limitations 1 (per-session timeout) and 3 (per-session overrides) are already addressed by the Task 2 refactor. The remaining 3 are addressed here.

### Task 20: MessagePollerManager — multi-session polling

**Files:**
- Create: `src/lib/message-poller-manager.ts`
- Create: `test/unit/message-poller-manager.test.ts`
- Modify: `src/lib/relay-stack.ts` — swap `MessagePoller` for `MessagePollerManager`

**Step 1: Write tests**

```typescript
describe("MessagePollerManager", () => {
  it("starts independent pollers for different sessions", () => {
    const mgr = new MessagePollerManager({ client: mockClient, log: vi.fn() });
    mgr.startPolling("sess-1");
    mgr.startPolling("sess-2");
    expect(mgr.isPolling("sess-1")).toBe(true);
    expect(mgr.isPolling("sess-2")).toBe(true);
  });

  it("emits events with sessionId", async () => {
    const mgr = new MessagePollerManager({ client: mockClient, log: vi.fn() });
    const received: Array<{ events: RelayMessage[]; sessionId: string }> = [];
    mgr.on("events", (events, sessionId) => received.push({ events, sessionId }));

    mgr.startPolling("sess-1");
    // ... trigger poll with new content ...
    expect(received[0].sessionId).toBe("sess-1");
  });

  it("stops only the specified session's poller", () => {
    const mgr = new MessagePollerManager({ client: mockClient, log: vi.fn() });
    mgr.startPolling("sess-1");
    mgr.startPolling("sess-2");
    mgr.stopPolling("sess-1");
    expect(mgr.isPolling("sess-1")).toBe(false);
    expect(mgr.isPolling("sess-2")).toBe(true);
  });

  it("enforces max concurrent pollers (5)", () => {
    const mgr = new MessagePollerManager({ client: mockClient, log: vi.fn() });
    for (let i = 0; i < 6; i++) mgr.startPolling(`sess-${i}`);
    // 6th should be rejected (logged warning, not started)
    expect(mgr.isPolling("sess-5")).toBe(false);
  });

  it("notifySSEEvent forwards to the correct poller", () => { ... });
  it("emitDone forwards to the correct poller", () => { ... });
  it("stopAll clears all pollers", () => { ... });
  it("no-op when starting a poller that already exists", () => { ... });
});
```

**Step 2: Implement**

```typescript
// src/lib/message-poller-manager.ts
import { EventEmitter } from "node:events";
import { MessagePoller, type MessagePollerOptions } from "./message-poller.js";
import type { OpenCodeClient, Message } from "./opencode-client.js";
import type { RelayMessage } from "./types.js";

const MAX_CONCURRENT_POLLERS = 5;

export interface MessagePollerManagerEvents {
  /** Emitted with synthesized events + sessionId from REST diff */
  events: [messages: RelayMessage[], sessionId: string];
}

export class MessagePollerManager extends EventEmitter<MessagePollerManagerEvents> {
  private readonly pollers: Map<string, MessagePoller> = new Map();
  private readonly client: Pick<OpenCodeClient, "getMessages">;
  private readonly log: (...args: unknown[]) => void;
  private readonly interval?: number;

  constructor(options: MessagePollerOptions) {
    super();
    this.client = options.client;
    this.log = options.log ?? (() => {});
    this.interval = options.interval;
  }

  startPolling(sessionId: string, seedMessages?: Message[]): void {
    if (this.pollers.has(sessionId)) return;
    if (this.pollers.size >= MAX_CONCURRENT_POLLERS) {
      this.log(`   [poller-mgr] MAX POLLERS reached (${MAX_CONCURRENT_POLLERS}), skipping ${sessionId.slice(0, 12)}`);
      return;
    }

    const poller = new MessagePoller({
      client: this.client,
      interval: this.interval,
      log: this.log,
    });
    poller.on("events", (events) => this.emit("events", events, sessionId));
    poller.startPolling(sessionId, seedMessages);
    this.pollers.set(sessionId, poller);
  }

  stopPolling(sessionId: string): void {
    const poller = this.pollers.get(sessionId);
    if (poller) {
      poller.stopPolling();
      poller.removeAllListeners();
      this.pollers.delete(sessionId);
    }
  }

  isPolling(sessionId?: string): boolean {
    if (sessionId) return this.pollers.has(sessionId);
    return this.pollers.size > 0;
  }

  notifySSEEvent(sessionId: string): void {
    this.pollers.get(sessionId)?.notifySSEEvent(sessionId);
  }

  emitDone(sessionId: string): void {
    this.pollers.get(sessionId)?.emitDone(sessionId);
  }

  stopAll(): void {
    for (const [, poller] of this.pollers) {
      poller.stopPolling();
      poller.removeAllListeners();
    }
    this.pollers.clear();
  }
}
```

**Step 3: Update relay-stack.ts** — This is already described in Task 14 Steps 2-4. Ensure the import is updated from `MessagePoller` to `MessagePollerManager` and all references to `messagePoller` are changed to `pollerManager`.

**Step 4: Update notifySSEEvent calls** — In `sse-wiring.ts` or wherever `messagePoller.notifySSEEvent(sessionId)` is called, update to use `pollerManager.notifySSEEvent(sessionId)`.

**Step 5:** Run: `pnpm vitest run test/unit/message-poller-manager.test.ts` → Expected: PASS

**Step 6:** Commit: `feat: add MessagePollerManager for multi-session REST polling`

---

### Task 21: Translator size cap (FIFO eviction)

**Files:**
- Modify: `src/lib/event-translator.ts` — add size cap to `seenParts`
- Modify: `test/unit/event-translator.test.ts` — add size cap tests

**Step 1: Write tests**

```typescript
describe("seenParts size cap", () => {
  it("evicts oldest entries when exceeding 10,000", () => {
    const translator = createEventTranslator();
    // Seed with 10,000 parts
    for (let i = 0; i < 10_000; i++) {
      translator.getSeenParts().set(`part-${i}`, { type: "text" });
    }
    expect(translator.getSeenParts().size).toBe(10_000);

    // Translate one more event that adds a new part
    translator.translate(makePartUpdatedEvent("part-10000", "text"));
    // Should have evicted oldest ~2000 entries
    expect(translator.getSeenParts().size).toBeLessThanOrEqual(10_001 - 2000 + 1);
    // New part should exist
    expect(translator.getSeenParts().has("part-10000")).toBe(true);
    // Oldest parts should be gone
    expect(translator.getSeenParts().has("part-0")).toBe(false);
  });
});
```

**Step 2: Implement** — Add eviction logic in the `seenParts.set()` call site inside `handlePartUpdated()`:

```typescript
const SEEN_PARTS_MAX = 10_000;
const SEEN_PARTS_EVICT_COUNT = 2_000;

// After seenParts.set(partID, ...):
if (seenParts.size > SEEN_PARTS_MAX) {
  // Map preserves insertion order — delete oldest entries
  let evicted = 0;
  for (const key of seenParts.keys()) {
    if (evicted >= SEEN_PARTS_EVICT_COUNT) break;
    seenParts.delete(key);
    evicted++;
  }
}
```

**Step 3:** Run: `pnpm vitest run test/unit/event-translator.test.ts` → Expected: PASS

**Step 4:** Commit: `fix: add FIFO eviction cap to translator seenParts`

---

### Task 22: Document getActiveSessionId() semantics

**Files:**
- Modify: `src/lib/session-manager.ts` — add JSDoc clarifying semantics
- No code changes needed — Task 11-12 already replaced all handler call sites with `getClientSession()`

**Step 1:** Add JSDoc to `getActiveSessionId()`:

```typescript
/**
 * Returns the "server's last known active session" — the session most recently
 * created or switched to via SessionManager.switchSession()/createSession().
 *
 * IMPORTANT: This is NOT the session a specific client is viewing.
 * For per-client session tracking, use `wsHandler.getClientSession(clientId)`.
 *
 * This is used as a fallback only:
 * - In handlers: `getClientSession(clientId) ?? getActiveSessionId()`
 * - For message poller lifecycle management (which sessions to poll)
 * - For client-init when no session ID is in the URL
 */
getActiveSessionId(): string | null { ... }
```

**Step 2: Audit remaining call sites** — Verify that all handler code (prompt.ts, model.ts, session.ts) uses `getClientSession(clientId)` with `?? getActiveSessionId()` as fallback. The only direct `getActiveSessionId()` calls should be in:
- `relay-stack.ts` — status poller wiring (server-level concern, not client-level)
- `client-init.ts` — default session for new connections with no URL session ID
- `session-manager.ts` — internal state

**Step 3:** Commit: `docs: clarify getActiveSessionId() semantics and usage`

---

### Task 23: Final verification + full test suite

**Step 1:** Run: `pnpm test:unit` — all tests pass
**Step 2:** Run: `pnpm test:integration` — all tests pass
**Step 3:** Run: `pnpm build` — no type errors
**Step 4:** Run: `pnpm lint` — no lint issues
**Step 5:** Manual smoke test: open two browser tabs, verify:
  - Each tab can view a different session independently
  - Sending a message in tab A only shows in tab A (if viewing different sessions)
  - Session list updates in both tabs when a new session is created
  - Default model setting persists across relay restarts
  - Input sync works between tabs viewing the same session
**Step 6:** Commit: `chore: final cleanup after per-tab sessions + limitation fixes`
