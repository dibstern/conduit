# Per-Instance Environment Isolation and Provider Configuration

## Problem

Users want each OpenCode instance to have its own authentication and provider configuration. Today, all managed instances share the same `OPENCODE_SERVER_PASSWORD` for health checks, but already get isolated `XDG_DATA_HOME` directories automatically. The frontend UI does not expose env vars at all, so users cannot configure or override per-instance environment. There is also no way to edit an instance after creation.

Additionally, the Default instance is always unmanaged (connects to an existing OpenCode server). Users who don't have OpenCode running separately want the relay to spawn it automatically.

## Goals

1. Expose per-instance env vars in the settings UI (key-value editor)
2. Allow editing instance config (name, env, port) after creation
3. Smart Default instance: auto-detect whether to connect or spawn
4. Per-instance health check auth with global fallback
5. Users configure providers externally via `opencode auth` with the right `XDG_DATA_HOME`

## Non-Goals

- Building a provider configuration UI inside the relay
- Auto-generating per-instance passwords (keep single global password)
- Auto-restarting instances when env changes (user must restart manually)

## Design

### 1. Smart Default Instance

At daemon startup, probe `OPENCODE_URL` (default `http://localhost:4096`):

- **Reachable** (any HTTP response, including 401): create Default as **unmanaged** (external). This is today's behavior.
- **Not reachable** (connection refused / timeout): spawn `opencode serve` as a **managed** instance with auto-isolated `XDG_DATA_HOME` at `~/.local/share/opencode-relay/default/`. Find a free port starting from 4096.

On daemon restart, the persisted config remembers whether Default was managed or unmanaged. For managed instances, re-probe first to respect externally-started servers.

**Implementation:** Modify `Daemon.start()` (around lines 204-220 where the Default instance is created). Add async probe logic using the existing `isOpenCodeReachable()` pattern (fetch with 3s timeout, any response = reachable).

### 2. Per-Instance Env Vars in the UI

#### Settings Panel Form

Extend the instance creation/editing form in `SettingsPanel.svelte`:

- Name (text) — existing
- Port (number) — existing
- URL (text, external only) — existing
- Managed (checkbox) — existing
- **Environment Variables** (key-value editor) — **new**

The env editor is a list of `{key, value}` rows with add/remove buttons. `XDG_DATA_HOME` shows its auto-generated value as a placeholder (e.g. `~/.local/share/opencode-relay/{id}`) so users see what they'd override.

#### Instance Editing

Add an **expand/edit mode** for existing instances in the settings panel. When expanded, show the current config (name, port, env) as editable fields, plus a Save button.

#### Backend: `instance_update` Message

New WS message type:

```typescript
{ type: "instance_update", instanceId: string, name?: string, env?: Record<string, string>, port?: number }
```

Handler: update the instance in `InstanceManager`, persist config, broadcast updated `instance_list`.

#### `needsRestart` Tracking

Add `needsRestart?: boolean` to `OpenCodeInstance`. Set to `true` when env or port changes on a running instance. Clear on stop/start. Show an amber "Restart required" indicator in the UI next to affected instances.

### 3. Health Check Auth

Current: daemon reads `process.env.OPENCODE_SERVER_PASSWORD` once and uses it for all instances.

Enhancement: the health checker reads `instance.env?.OPENCODE_SERVER_PASSWORD` if present, falling back to the global password. This allows external instances with different passwords to be health-checked correctly.

For **managed instances**, the global `OPENCODE_SERVER_PASSWORD` is automatically injected into `effectiveEnv` during `startInstance()` (alongside the auto-generated `XDG_DATA_HOME`).

### 4. Data Flow

```
1. User creates instance "Claude Team" (managed, port 4097)
   -> Relay auto-sets XDG_DATA_HOME = ~/.local/share/opencode-relay/claude-team/
   -> User optionally overrides XDG_DATA_HOME in env editor

2. Relay spawns: opencode serve --port 4097
   -> env: { ...process.env, XDG_DATA_HOME: "...", OPENCODE_SERVER_PASSWORD: "..." }
   -> OpenCode reads auth.json from its own XDG_DATA_HOME

3. User configures providers externally:
   -> XDG_DATA_HOME=~/.local/share/opencode-relay/claude-team opencode auth
   -> Sets API keys for this instance only

4. Relay health-checks localhost:4097 with global password
   -> Instance shows "healthy" in UI

5. User binds project "my-app" to "Claude Team" instance
   -> All API calls for that project route through port 4097
   -> Using that instance's auth/provider config
```

## Changes Required

| Area | Change | Scope |
|------|--------|-------|
| `shared-types.ts` | Add `needsRestart?: boolean` to `OpenCodeInstance`. Add `instance_update` to `RelayMessage` union. | Small |
| `InstanceManager` | Add `updateInstance(id, config)` method. Track `needsRestart`. Inject `OPENCODE_SERVER_PASSWORD` into `effectiveEnv` in `startInstance()`. | Medium |
| `Daemon.start()` | Smart default detection: probe `OPENCODE_URL`, spawn managed if unreachable. | Medium |
| `handlers/instance.ts` | Add `handleInstanceUpdate` handler for `instance_update` WS message. | Small |
| `daemon-ipc.ts` | Add `instanceUpdate` IPC command. | Small |
| Health checker | Per-instance password: read `instance.env?.OPENCODE_SERVER_PASSWORD` with global fallback. | Small |
| `SettingsPanel.svelte` | Add env var key-value editor. Add edit mode for existing instances. Add restart indicator. | Large |
| `instance.svelte.ts` | Handle `needsRestart` in instance state. | Small |
| Persistence | Already handles `env` — no changes to schema. | None |

## Testing

- **Unit tests**: `updateInstance()`, smart default detection, per-instance health auth
- **E2E (multi-instance)**: env editor UI, instance update flow, restart indicator
- **E2E (daemon)**: managed default instance spawning, env isolation verification
