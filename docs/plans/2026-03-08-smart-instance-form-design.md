# Smart Instance Creation Form — Design

## Problem

Creating a new managed OpenCode instance requires manually typing environment variable names and values one at a time (e.g. `ANTHROPIC_API_KEY`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`, `OPENCODE_EXPERIMENTAL_LSP_TOOL`). Users maintain shell scripts with these defaults instead of using the UI. Common configurations like "Anthropic with API key" or "CCS proxy" require the same boilerplate every time.

## Goals

1. Replace raw env var editor with **structured form sections** (provider config, feature flags)
2. Add a **preset bar** for one-click common configurations (Anthropic, CCS Proxy, Custom)
3. **Auto-detect CCS/CLIProxy** running locally and offer to connect
4. Keep the raw env var editor for edge cases (collapsed under "Additional")
5. Apply the same structured treatment to the **edit form**

## Non-Goals

- Connection profiles (reusable saved configurations) — deferred to v2
- User-defined presets — deferred to v2
- Deep CCS integration (profile selection, health monitoring) — deferred
- Changes to the backend data model — env stays `Record<string, string>`

## Design

### Form Layout

```
┌─────────────────────────────────────────────────┐
│  Quick Setup                                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ Anthropic│ │CCS Proxy │ │  Custom  │        │
│  │  (API)   │ │          │ │          │        │
│  └──────────┘ └──────────┘ └──────────┘        │
│                                                  │
│  ── Instance ──────────────────────────────────  │
│  Name:  [personal_____________]                  │
│  Port:  [4097_________________]  (auto-assigned) │
│  [x] Managed                                     │
│                                                  │
│  ── Provider ──────────────────────────────────  │
│  API Key:     [sk-ant-...____________]           │
│  Base URL:    [________________________] (opt.)  │
│                                                  │
│  ── Features ──────────────────────────────────  │
│  [x] Disable default plugins                     │
│  [x] Enable LSP tool (experimental)              │
│                                                  │
│  ▸ Additional Environment Variables              │
│     (collapsed, existing env var editor)         │
│                                                  │
│  [Create]  [Cancel]                              │
└─────────────────────────────────────────────────┘
```

### Preset System (v1 — hardcoded)

| Preset | Pre-fills |
|--------|-----------|
| **Anthropic (API)** | name: "anthropic", managed: true, port: auto, API key field focused, feature flags ON |
| **CCS Proxy** | name: "ccs", managed: true, port: auto, base URL: detected CCS port or placeholder, feature flags ON |
| **Custom** | All fields empty, managed: false |

Clicking a preset pre-fills but all fields remain editable. A different preset re-fills (with a dirty-form guard).

### CCS Auto-Detection

When the add form opens, the server probes `localhost:8317` (CCS default port) via HTTP:

1. Frontend sends `proxy_detect` WS message
2. Server probes `http://127.0.0.1:8317/health` (3s timeout)
3. Server responds with `proxy_detected` message: `{ found: boolean, port: number }`
4. If found, CCS Proxy preset card shows a green indicator

### Feature Flags as Checkboxes

| Toggle Label | Env Var | Default in presets |
|-------------|---------|---------|
| Disable default plugins | `OPENCODE_DISABLE_DEFAULT_PLUGINS` | ON |
| Enable LSP tool | `OPENCODE_EXPERIMENTAL_LSP_TOOL` | ON |

When mapped to env vars, checked = `"1"`, unchecked = omitted from env.

### Provider Fields → Env Var Mapping

| Form Field | Env Var |
|-----------|---------|
| API Key | `ANTHROPIC_API_KEY` |
| Base URL | `ANTHROPIC_BASE_URL` |

### Data Flow (no backend model changes)

The structured form fields are compiled into a flat `env: Record<string, string>` before sending the existing `instance_add` or `instance_update` WS message. The server, InstanceManager, and persistence layer are unchanged.

Compilation logic:
1. Start with empty env object
2. If API Key field has value → `env.ANTHROPIC_API_KEY = value`
3. If Base URL field has value → `env.ANTHROPIC_BASE_URL = value`
4. If "Disable default plugins" is checked → `env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"`
5. If "Enable LSP tool" is checked → `env.OPENCODE_EXPERIMENTAL_LSP_TOOL = "true"`
6. Merge in any "Additional" env vars
7. Send as `msg.env`

### Edit Mode

When editing, the reverse mapping extracts known env vars into structured fields:
- `ANTHROPIC_API_KEY` → API Key field
- `ANTHROPIC_BASE_URL` → Base URL field
- `OPENCODE_DISABLE_DEFAULT_PLUGINS` → checkbox state
- `OPENCODE_EXPERIMENTAL_LSP_TOOL` → checkbox state
- All other env vars → "Additional" section

### Backend Addition: proxy_detect Handler

One small backend addition for CCS detection:

**New message types** (in `PayloadMap` and `RelayMessage`):
- Incoming: `proxy_detect: Record<string, never>`
- Outgoing: `proxy_detected: { found: boolean; port: number }`

**New handler**: `handleProxyDetect` — probes `localhost:8317` and responds to the requesting client.

## Files Changed

| File | Change | Scope |
|------|--------|-------|
| `src/lib/frontend/components/overlays/SettingsPanel.svelte` | Major refactor: preset bar, structured sections, feature toggles, env compilation | Large |
| `src/lib/handlers/payloads.ts` | Add `proxy_detect` payload type | Tiny |
| `src/lib/shared-types.ts` | Add `proxy_detected` to RelayMessage union | Tiny |
| `src/lib/handlers/instance.ts` | Add `handleProxyDetect` function | Small |
| `src/lib/handlers/index.ts` | Register `proxy_detect` handler | Tiny |
| `test/unit/handlers/handlers-instance.test.ts` | Tests for proxy detection handler | Small |
| `test/e2e/specs/multi-instance.spec.ts` | E2E tests for preset buttons, structured form | Medium |

## Testing

- **Unit tests**: `handleProxyDetect` handler, env compilation logic (extract to pure function)
- **E2E (multi-instance)**: preset buttons pre-fill form, structured fields compile to env, edit mode extracts from env
- **Manual**: verify CCS detection with CCS running locally
