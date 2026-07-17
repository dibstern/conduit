# Per-Session Permission Mode Dropdown

**Date:** 2026-07-17
**Status:** Designed, not implemented
**Branch:** `feat/permission-mode-dropdown`

## Goal

Let the user set an approval mode per session from a dropdown in the message composer:
auto-approve everything ("yolo"), auto-approve edits only, or the default ask-the-user
behavior. Works for both providers (Claude Agent SDK, OpenCode).

## Research findings that shape the design

- **OpenCode has no server-side "auto mode".** `--auto` / `--yolo` /
  `--dangerously-skip-permissions` all collapse to one client-local boolean; opencode's
  own TUI implements auto mode by auto-replying to `permission.asked` events via
  `POST /session/{id}/permissions/{permissionID}`. Explicit `deny` config rules are
  still enforced server-side (deny'd actions never generate asks). Conduit is the
  client, so conduit's relay implements auto mode the same way.
- **Both providers already funnel through one choke point:**
  `src/lib/provider/relay-event-sink.ts:196 requestPermission()`.
  - Claude: `claude-provider-runtime.ts:864` wires `canUseTool` →
    `claude-permission-bridge.ts:44` → `claude-permission-service.ts:194` →
    `sink.requestPermission` (line 221).
  - OpenCode: `opencode-runtime-event-translator.ts:468` emits runtime
    `permission.asked` → same sink.
- **Claude native `permissionMode` rejected** for this feature: `bypassPermissions`
  requires the SDK dangerous-skip flag, skips `canUseTool` entirely, and applies at
  query build time (mid-session change needs extra `query.setPermissionMode`
  plumbing). The relay-side short-circuit is one mechanism for both providers and
  reads the mode live per request.
- **Per-session overrides precedent:** `SwitchVariant` — in-memory
  `session-overrides-state.ts`, not event-sourced, lost on relay restart. We match it.
- SDK versions at design time: `@anthropic-ai/claude-agent-sdk` 0.3.207,
  `@opencode-ai/sdk` 1.17.18. No SDK upgrade required.

## Mode set

Conduit-level enum, provider-agnostic (reuse/subset `ProviderPermissionModeSchema`,
`src/lib/shared-types.ts:49`):

| Mode | Behavior | Claude classification | OpenCode classification |
|---|---|---|---|
| `ask` (default) | Current behavior — card in browser | — | — |
| `acceptEdits` | Auto-approve file edits, ask for the rest | tool name ∈ Edit/Write/NotebookEdit | ask type = `edit` |
| `auto` (yolo) | Auto-approve everything | allow every `canUseTool` | reply `once` to every ask |

Not exposed: `plan` (collides with existing PlanMode UI), `dontAsk` (semantics
unverified), native `bypassPermissions` (see above).

## Mechanism: relay-side auto-reply at the sink

In `relay-event-sink.ts requestPermission()`:

1. Look up the session's mode live from `OverridesStateTag` (relay layer — no
   provider-boundary violation; sessionId available at line 209).
2. If the mode covers this ask: skip `beginPermissionRequest` + browser `send()`,
   resolve immediately as allow — Claude's pending `canUseTool` resolves
   `{ behavior: "allow" }`; OpenCode gets `client.permission.reply(..., "once")`
   (existing `DECISION_MAP` in `pending-interaction-service.ts:22`).
3. Otherwise: current flow unchanged, card appears.

Because the mode is read per-request, a mid-turn toggle applies instantly to both
providers.

## State + wire (clone the SwitchVariant precedent)

- `src/lib/domain/relay/Services/session-overrides-state.ts`: add `permissionMode?`
  to `SessionState` (line 30) + `setPermissionMode`/`getPermissionMode` (mirror
  `setVariant`/`getVariant`, lines 291–308). `clearSession` already wipes the entry.
- `src/lib/contracts/ws-rpc.ts`: new `SwitchPermissionMode` TaggedRequest (mirror
  `SwitchVariant`/`SwitchContextWindow` at 616–643) + group registration.
- `src/lib/server/ws-rpc.ts`: binding (mirror SwitchContextWindow at 492–510).
- `src/lib/frontend/transport/ws-rpc-client.ts`: `switchPermissionModeRpc` wrapper
  (mirror `switchVariantRpc`, line 1216).
- `src/lib/frontend/stores/discovery.svelte.ts`: `discoveryState.permissionMode`
  (line 84), optimistic set + rollback on RPC failure (AgentSelector pattern,
  `AgentSelector.svelte:164–181`).

## UI

- New `src/lib/frontend/components/input/PermissionModeSelector.svelte`, cloning
  `components/model/ModelVariant.svelte` (small pill + `clickOutside` dropdown via
  `components/shared/use-click-outside.svelte.js`).
- Placement: `InputArea.svelte` `#input-bottom-left`, after `<ModelSelector>`
  (line 570).
- Copy: label "Approvals" with values **Ask / Edits / All** — avoids "mode" wording
  that collides with PlanMode.
- Amber/warning tint on the pill when not `ask`, so a yolo session is visibly yolo.
- Shown for both providers (mechanism is provider-agnostic).

## Edge cases & follow-through

- **Legacy SSE path:** `src/lib/relay/sse-wiring.ts:333/797` also broadcasts
  `permission_request`. Verify whether it is still live; if so it needs the same
  guard, or cards leak through in auto mode.
- **Audit trail:** record auto-approved asks in the event store as resolved
  (decision `allow`, resolver `auto`) so history shows what yolo approved.
- **Persistence:** per-session mode does not survive relay restart — same limitation
  as model/variant overrides, accepted for v1. A relay-settings global default
  (mirror `defaultVariants`, `handlers/model.ts:596/639`) is a possible follow-up.
- **acceptEdits classification:** the sink must classify asks. Claude gives the tool
  name via `canUseTool`; OpenCode's ask carries its permission type (`edit` is a
  first-class opencode category). Anything unclassifiable falls back to `ask`.

## Verification

- Unit tests: overrides getters/setters; sink short-circuit (mode × ask-type matrix,
  including the fallback-to-ask path).
- Feature scenario for the dropdown (`features/`), then the visual gate: the new
  pill shifts the `composer-with-text-dark` baseline pinned by
  `features/composer-send-button.feature` — re-run `pnpm acceptance:visual`,
  re-capture via `pnpm acceptance:visual:capture`, review, commit the baseline.
- `pnpm check`, `pnpm lint`, `pnpm test:unit`.

## Rough size

~6 small backend edits along an existing groove, one new Svelte component, one
contract addition, one visual-baseline refresh.

## Relevant prior docs

- `docs/plans/2026-03-10-session-scoped-permissions-design.md` — sessionId on
  `permission_request`, card-vs-notification model.
- `docs/plans/2026-03-09-variant-persistence-design.md` — the per-session override
  pattern this design clones.
- `docs/plans/2026-03-10-persistent-permission-rules-design.md` — existing
  `opencode.jsonc` rule persistence (`handlers/permissions.ts:99–156`); unchanged by
  this feature.
