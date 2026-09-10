# Provider driver + instance model (harness fixed at session creation)

Status: proposed
Date: 2026-07-27
Beads epic: see `conduit-test` epic "Provider driver + instance model"

## Problem

Two connected user asks:

1. **Agent filtering by harness.** Some custom agents exist only for Claude (Agent
   SDK), some only for OpenCode. The composer must show only the agents available
   for the harness the session actually uses.
2. **Harness selection in a session.** The user wants to pick the harness
   (provider) for a session.

`~/src/personal/conduit-competitors/t3code` solves this with a *driver + instance*
model. We adopt that model, with one deliberate constraint decided up front:

- **The harness is chosen at session creation and fixed thereafter.** We do not
  reconcile Claude-SDK vs OpenCode backing state mid-session. (conduit already
  defines a `session.provider_changed` event and projector, but there is no runtime
  emitter and we are not adding one here.)

## Current state (grounded)

conduit already contains two-thirds of this feature; the gaps are *explicitness*
and *generalization*.

- **Agent scoping already exists per provider.**
  `src/lib/domain/relay/Services/agent-service.ts` `listAgents(activeSessionId)`
  returns agents for exactly ONE provider scope, chosen implicitly by
  `preferredProviderId = activeProviderId ?? defaultModel.providerID`.
  `AgentProviderScope = { id: "opencode"|"claude", name }`. So filtering is
  structurally present — it is just keyed by a provider *derived implicitly* and
  never re-requested when the harness changes.
- **Session→provider binding already exists.**
  `session_providers` table (migration `0001`), `provider-projector.ts`
  (`session.created` → active binding; `session.provider_changed` → rebind), and
  `provider-session-binding-read-model.ts` (`getProviderForSession`). Turn routing
  already prefers the binding:
  `provider-turn-service.ts` `getProviderForSession(sessionId) ?? (isClaude…)`.
- **A named-instance precedent already exists — for OpenCode only.**
  `DaemonConfig.instances[]` in `config-persistence.ts` are named OpenCode server
  configs (`id, name, port, managed, env?, url?`); projects bind one via
  `project.instanceId`. Claude has only a single implicit config
  (`daemonConfig.claudeConfigDir`).
- **Harness is currently derived implicitly.**
  `session-manager-service.ts` `getConfiguredLocalSessionProvider()` reads
  `state.defaultModel?.providerID`; `createSession(title, {providerId})` binds it.

So the driver+instance model is a **generalization of two things conduit already
has** (`instances[]` + `session_providers`), not a greenfield build.

## Design

Split the *driver kind* (which implementation: `claude` | `opencode` | future)
from the *instance id* (a user-named routing key). All persisted session state
references the **instance id**; a `defaultInstanceIdForDriver(kind) = kind` mapping
keeps existing rows valid (bare `"claude"`/`"opencode"` are legal instance ids).

Selecting an instance structurally scopes every affordance (models + agents) —
exactly how `listAgents` already behaves, only keyed by instance instead of by an
implicitly-derived provider.

### Contract (`src/lib/contracts/`)

- `ProviderDriverKind` — closed enum for now (`"claude" | "opencode"`), but
  *validated as a string* with a graceful "unavailable" fallback for unknown
  kinds (t3code keeps it open; conduit has two providers, so a closed enum with a
  string escape hatch is the right cost/benefit — do **not** build a plugin
  system). Push back here only if pluggable drivers become a real requirement.
- `ProviderInstanceId` — branded string routing key.
- `ProviderInstance` — self-describing per-instance snapshot:
  `{ id: ProviderInstanceId, name, driver: ProviderDriverKind, available: boolean, models: ModelInfo[], agents: ProviderAgentInfo[] }`.
- `ModelSelection` gains `instanceId` (keep a legacy `{ provider, model }` →
  `{ instanceId, model }` transform via `defaultInstanceIdForDriver`, matching
  t3code `orchestration.ts`).

### Config (`config-persistence.ts`)

- Generalize `instances[]` so each entry carries a `driver` kind. Existing entries
  migrate to `driver: "opencode"` (they have `port`/`managed`).
- Synthesize implicit default instances so a fresh config still works:
  `{ id: "opencode", driver: "opencode" }` and `{ id: "claude", driver: "claude",
  configDir: claudeConfigDir }`.
- Add an instance→driver resolution helper (config-derived read model) used by the
  binding and discovery layers.
- Migration must be backward compatible: an old `daemon.json` with OpenCode-only
  `instances[]` and no driver field loads unchanged.

### Persistence (`session_providers`, `provider-projector.ts`)

- The binding column stores the **instance id** rather than a bare driver string.
  Bare `"claude"`/`"opencode"` remain valid (they are the default instance ids),
  so **no data migration is required**.
- Turn routing resolves instance → driver kind via the config read model before
  dispatching to the adapter.

### Discovery (`agent-service.ts`, `handlers/agent.ts`, `handlers/model.ts`)

- Assemble one `ProviderInstance` snapshot per configured instance (models +
  agents + availability).
- `listAgents(instanceId)` scopes agents to that instance's driver (reusing the
  existing per-provider filter, keyed by instance).
- Frontend keeps discovery state keyed by instance and **re-requests agents when
  the selected instance changes** — this is the visible fix for ask (1).

### Selection + creation (`session-manager-service.ts`, `handlers/session.ts`)

- The composer holds a selected instance (client-persisted draft, t3code style).
- `createSession(instanceId)` resolves the driver from config and binds the
  provider. Because the harness is fixed at creation, no rebind path is needed.
- Replace the implicit default-model-provider derivation in
  `getConfiguredLocalSessionProvider()` with the explicit selected instance;
  the default model becomes per-instance.
- Once a session exists, the instance rail enters **locked-provider mode**: only
  the bound instance is enabled (others dimmed + tooltip). The trigger keeps
  showing the bound instance icon. Model switching within the bound harness stays
  available.

### Frontend UX decision — instance rail in the model picker (t3code-faithful)

Decision (2026-07-27): **port t3code's model-picker UX** — a single composer
trigger button that carries the selected **instance icon** + model name, opening a
popover whose left edge is a **48px instance rail** (one icon per instance) with
the model list to its right. Rendered in conduit's design language (Chakra Petch,
Conduit Dark tokens, hot-pink accent, upward-opening popover). Chosen because we
expect to add more harnesses over time and an icon rail scales; the trigger icon
keeps the active harness visible at rest (the original complaint).

Correction to an earlier draft of this doc: t3code has **no instance rail in the
app chrome**. Its app sidebar groups by project → session state. The instance rail
(`ModelPickerSidebar`, `w-12 border-r bg-muted/30`) lives **inside the model-picker
popover** (`ModelPickerContent`, `max-w-100 flex-row`), opened from the composer's
single `ProviderModelPicker` trigger. We port that structure, not a standing rail.

Faithful details to carry over:
- Favorites entry at the top of the rail; one icon per configured instance
  (built-in + custom). Duplicate-driver instances (e.g. two Claude configs) are
  disambiguated by an accent badge; a "new" sparkle flags newly-added built-ins.
- Selected-instance indicator bar; hover tooltips opening toward the rail.
- Right pane: search box + model rows reusing conduit's existing model-row styling
  (checkmark on active, cost per 1K, favorite/default star, context/variant tags).
- **Locked-provider mode** for the fixed-at-creation constraint: in an existing
  session the rail renders all icons but **disables every instance except the bound
  one** (dimmed + tooltip). Model switching *within* the bound harness stays live.
  This reuses t3code's own `disabledInstanceIds` / locked-provider rail affordance.

Net composer toolbar: `[attach] [agent ▾] … [◧ instance-icon · model ▾] [approvals] … [send]`.
The harness is selected by clicking a rail icon inside the picker; no separate
harness control is added.

## Phasing

1. **Contracts + config foundation** — schemas + generalized `instances[]` +
   instance→driver resolution. No behavior change.
2. **Discovery keyed by instance** — per-instance snapshots; `listAgents(instanceId)`;
   frontend keyed by instance; re-fetch agents on instance switch. *Satisfies ask
   (1) on its own.*
3. **Instance rail + selection at creation** — port the t3code model picker
   (trigger button carries the instance icon → popover with a 48px instance rail +
   model list) in conduit's design language; `createSession(instanceId)` binds via
   config-resolved driver; replace implicit derivation; locked-provider rail once
   bound. *Satisfies ask (2).*
4. **Config UI** — manage named instances (2nd OpenCode server / alt Claude config
   dir) in `SettingsPanel`.

## Acceptance strategy

Backend/contract phases: `pnpm check`, `pnpm test:unit`, targeted integration
tests (provider binding, projector back-compat).

Frontend-facing phases (2, 3, and optionally 4) additionally ship Gherkin
`.feature` specs run through the installed UBM acceptance pipeline
(`pnpm acceptance:visual`), including at least one visual-baseline scenario, per
the repo's Visual Acceptance Gate. The concrete Gherkin for each is specified in
the corresponding Beads story. New `.feature` files land *with* their step
handlers and captured baselines in the same story (never committed ahead of
implementation, which would break the local gate).

## Non-goals

- Mid-session harness switching / cross-provider state reconciliation.
- A pluggable/open driver registry.
- Claude *auth* changes (still `claudeConfigDir`; the Claude SDK env still strips
  `ANTHROPIC_*` per `claude-sdk-env.ts`). Phase 4 does make `configDir`
  *per-instance* (below), but the auth mechanism is unchanged.

## Phase 4 expanded — full instance-management integration (chosen 2026-07-27)

User chose the full integration (not the minimal config slice): a named OpenCode
instance is a **real managed/unmanaged OpenCode server** a session can bind to,
and a named Claude instance is an **alternate config dir** — all pickable per
session from the rail, with turns routing to the bound instance's runtime.

Grounding (from a structural map of `src/lib/instance/*`, `src/lib/provider/*`,
relay wiring):

- **Two disjoint "instance" registries** share the `daemon.json.instances[]`
  array: the daemon runtime `InstanceManagerState` (real OpenCode servers;
  spawn/health/URL; feeds `instance_list`) and the new provider-instance model
  (driver/configDir; feeds the rail via model discovery).
  `getPersistedInstanceConfigs` (`instance-manager-service.ts`) rebuilds the array
  from the OpenCode runtime and **drops `driver`/`configDir` and cannot represent
  a Claude instance** — the landmine Phase 4 must defuse first.
- **Named-instance turn routing is unimplemented.** `session_providers.provider`
  holds the branded instanceId, but every routing site (`isClaudeProviderId`
  literal `===`, `registry.getInstanceEffect(providerId)`) assumes it is
  `"claude"|"opencode"`. Only the two default ids round-trip today (so Phases 1–3
  and `.6` are safe; named instances would fail with `ProviderNotRegistered`).
- **Per-project→per-session routing** is the deep assumption: one `OpenCodeAPI`/URL
  per relay, `replaceEffectRelay` on project-instance switch, single SSE/poller.
- **Claude named instances are cheap** (env-only `configDir` at
  `claude-provider-runtime.ts` query edge); **OpenCode ones are expensive**
  (2nd client + per-instance SSE completion). Ship Claude first.

Phasing (Beads children of `conduit-test-3xj.4`):

1. **`.4.1`** Unify `instances[]` ownership + round-trip `driver`/`configDir`
   (fix `getPersistedInstanceConfigs`; single config source). *Foundation.*
2. **`.4.2`** Instance-aware turn routing: one `instanceId→{driver,endpoint}`
   normalization used at all routing sites; registry keyed by instanceId
   (defaults aliased); unresolvable instance → clean `SEND_FAILED`.
3. **`.4.3`** Claude named instances: thread per-instance `configDir` through
   `makeClaudeSdkEnv` (cheap; PTY still daemon-env, out of scope).
4. **`.4.4`** OpenCode named instances: per-instance client + turn routing to a
   2nd managed/unmanaged server; keep pollers/file/model/settings/PTY on the
   project default instance (scope to turn routing).
5. **`.4.5`** Frontend: SettingsPanel instances editor + converge the rail on the
   configured-instances source (with live status) + UBM feature/baseline.
