# Agent & Model Visibility Settings — Design

Date: 2026-07-22
Status: Approved

## Problem

The input-area dropdowns (`AgentSelector`, `ModelSelector`) show every discovered
agent and model. With multiple providers configured the list is noisy. We want a
settings menu to reduce the set shown, globally.

## Decisions

- **Scope:** global, server-side. One setting for the whole daemon, shared by all
  browsers/devices.
- **Semantics:** hide-list. Settings store what is *hidden*; anything newly
  discovered appears by default.
- **Enforcement:** server stores preferences, client filters presentation. The
  server keeps sending full lists; filtering is a `$derived` over
  `discoveryState`. No adversary exists (single-user daemon), and the settings
  tab needs the full list anyway, so no second "unfiltered" endpoint.

## Design

### 1. Persistence

`RelaySettings` (`src/lib/relay/relay-settings.ts`, persisted at
`~/.conduit/settings.jsonc` via existing load-merge-save) gains:

```ts
hiddenModels?: string[]   // keys: "<providerId>/<modelId>"
hiddenAgents?: string[]   // keys: "<scopeId>/<agentName>", scopeId = "opencode" | "claude"
```

Absent or empty means everything is visible.

### 2. Protocol

- `GetModelsResponseSchema` and the `model_list` push message gain
  `hiddenModels: string[]`; `GetAgentsResponseSchema` and `agent_list` gain
  `hiddenAgents: string[]`. Lists remain full/unfiltered.
- New RPC `setHiddenEntries({ hiddenModels?, hiddenAgents? })`:
  persists via `saveRelaySettings`, then rebroadcasts `model_list` /
  `agent_list` so all connected clients update live.

### 3. Frontend filtering

`discoveryState` (`src/lib/frontend/stores/discovery.svelte.ts`) stores the
hidden arrays. Selectors filter with `$derived`:

- `AgentSelector.svelte`: `visibleAgents` excludes hidden keys. Existing
  auto-hide when ≤1 visible agent is kept.
- `ModelSelector.svelte`: filter models inside `getProviderGroups()`; provider
  groups with zero visible models drop out.
- **Never-brick guard:** if filtering would leave zero agents, or zero models
  across all providers, ignore that filter and show everything.
- A session already using a hidden model/agent keeps working; the trigger still
  shows the current selection — it is just absent from the open list.
  Server-side default-model resolution is untouched.

### 4. Settings UI

New **"Agents & Models"** tab in `SettingsPanel.svelte` (existing tabbed modal).

- Models: full list grouped by provider (same grouping as the dropdown), a
  checkbox per model, and a provider-level toggle-all.
- Agents: checkboxes for the current provider scope only (the protocol carries
  a single scope's agents — accepted limitation).
- Each toggle fires `setHiddenEntries` immediately; no save button.

### 5. Testing

- Unit tests: `$derived` filter behavior including the never-brick guard;
  relay-settings merge of the new fields.
- Handler test: `setHiddenEntries` persists and rebroadcasts.
- Run `pnpm acceptance:visual` before claiming completion (touches input-area
  dropdown behavior).

## Alternatives considered

- **Server filters at source** (extend `filterAgents` / `getModelsResponse`):
  stronger enforcement, but requires a separate full-list RPC for the settings
  tab and multiplies edge cases (active session on hidden model, hidden default,
  empty agent scope). Rejected — more protocol surface for no real gain.
- **Client-only localStorage** (feature-flags pattern): cheapest, but per-browser
  rather than global. Rejected by requirement.
