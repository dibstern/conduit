# Claude Commands + Agents Merge Plan Audit

Source plan: `docs/plans/2026-05-11-claude-commands-agents-merge.md`

Dispatched 8 task auditors across 8 top-level tasks.

## Resolution Update

After user follow-up on 2026-05-11, the source plan was rewritten around active-provider/model scoped commands and agents. It no longer unions providers in the UI, no longer adds provider icons/providerId wire fields, and no longer requires fixed manual project slugs. The Ask User items below are therefore resolved in the current source plan; the remaining audit bullets are retained as the original audit record.

## Result

- Amend Plan: 39 findings
- Ask User: 3 findings
- Accept: 0 findings

The plan is not ready for execution. Main problems are PR1 base-state assumptions, provider-vs-wire type confusion, shared schema gaps that strip `providerId`, duplicated OpenCode agent filtering, provider-scoped identity ambiguity, command routing ambiguity, frontend implementation mismatch, and loose verification gates.

## Ask User

1. Task 6: agents are unioned into one list but selection state is id-only.
   - Question: should agent selection become provider-scoped (`switch_agent` carries `providerId` and overrides store `{ providerId, agentId }`), should wire ids be prefixed/unique, or should the selector show only agents for the active provider/model?
2. Task 7: command selection inserts only text like `/<name> ` and discards provider metadata.
   - Question: are provider icons informational only, or should selecting a provider-specific command bind/switch provider context? If informational only, duplicate-name behavior must be defined.
3. Task 8: manual checks depend on local project setup.
   - Question: which concrete registered project slugs should be used for Claude and OpenCode manual checks? If none are stable, the plan needs temporary fixtures or an explicit local setup requirement.

## Amend Plan

### Task 1: Probe commands + agents

- Add a PR1 prerequisite: `claude-capabilities-probe.ts` and its test must exist before this task runs.
- Remove unused `ContextWindowOption` import so this PR remains independent of PR2.
- Do not type probe commands as frontend wire `CommandInfo` unless adding adapter-internal `source` elsewhere; use provider-layer commands or a dedicated probe DTO.
- Map SDK `argumentHint` to `args` where the UI can render it.
- Assert `result.commands` and `result.agents` directly equal empty arrays; do not use `?? []`.

### Task 2: Add `providerId` to wire shapes

- Update both `CommandInfoSchema` and `AgentInfoSchema` with optional `providerId`.
- Add relay schema tests proving `agent_list` and `command_list` decode preserves `providerId`, plus backward-compatible cases without it.

### Task 3: `AdapterCapabilities.agents`

- Rewrite OpenCode snippet as plain `async`/`await` against `this.client`, not `yield* Effect`.
- Move OpenCode agent normalization/filtering into a neutral shared helper used by handler, client init, and `OpenCodeAdapter.discover()`.
- Add explicit PR1 probe-module precondition.
- Depend on Task 2's `AgentInfo.providerId` type/schema update before examples rely on it.
- Remove or defer the "handler will not call endpoint twice" claim unless this task also rewires handlers/client-init through discovered capabilities.
- Strengthen OpenCode tests to prove subagent/hidden/blocklisted agents are filtered and id/name normalization is preserved.

### Task 4: Claude command union

- Add prerequisites: PR1 probe helpers and Task 3 adapter `agents` shape must exist; include required imports in task steps.
- Pick one boundary for command shapes. Preferred: probe returns provider-layer commands with `source: "claude-sdk"` and no `providerId`; handlers map to wire commands with `providerId`.
- Update `test/unit/provider/types.test.ts` for `CommandSource` including `"claude-sdk"`.
- Test conflict precedence and `source`, not only command names.
- Carry SDK `argumentHint` through provider or probe DTO and map it to wire `args`.

### Task 5: Union commands in handler

- Extend shared wire `CommandInfo`/`CommandInfoSchema` with provider ids before handler emits them.
- Remove `args` mapping from OpenCode commands unless `OpenCodeAPI.app.commands()` is first widened from verified API shape.
- Alias shared wire command type separately from provider-layer `CommandInfo`.
- Add a test where orchestration engine exists but Claude discovery rejects; assert tagged OpenCode commands are still sent and warning logs.
- Update existing `handleGetCommands` assertions to expect tagged OpenCode commands.

### Task 6: Union agents in handler

- Add explicit prerequisites on Task 3 and Task 2 before using `caps.agents` and `agent.providerId`.
- Add required imports: `OrchestrationEngineTag` and shared wire `AgentInfo`.
- Update existing `get_agents` test layers with `LoggerTag` as needed.
- Add bridge/client-init tests for unioned agents, OpenCode-only fallback, Claude discovery failure, and tagged OpenCode assertions.
- Update existing handler/dispatch assertions to expect `providerId: "opencode"`.

### Task 7: Provider icons

- `AgentSelector` currently renders dropdown rows through imperative portal HTML, not a Svelte `{#each}` loop. Either refactor to Svelte-rendered rows before using `ProviderIcon.svelte`, or create a raw HTML badge helper for the portal and use `ProviderIcon.svelte` only in Svelte-rendered menus.
- Resolve provider-qualified agent identity before icon work; provider icons alone do not make duplicate ids selectable.
- Update command menu location: render changes belong in `CommandMenu.svelte`; `InputArea.svelte` only passes props.
- Define ordering in the command component; handler order is not preserved because `CommandMenu` sorts by command name.
- Add opened/interacted story or component test for agent portal badges, plus command menu mixed-provider story/test.
- Replace nonexistent `tailwind.config` instruction with `src/lib/frontend/style.css` theme tokens or existing utility classes.

### Task 8: Verification gate

- Add schema verification before UI checks: `providerId` must survive `RelayMessageSchema` decode for `agent_list` and `command_list`.
- Add automated mixed-provider command palette coverage via replay WS mock or open `CommandMenu` component/storybook test.
- Manual `switch_agent` check must verify server-side behavior in an active session, not only optimistic UI highlight.
- Tighten `EADDRINUSE` waiver to an exact signature and rerun protocol.
- Replace `git add -A` with scoped `git status --short` and explicit staging of intended files only.

## Audit Files

- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-1.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-2.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-3.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-4.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-5.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-6.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-7.md`
- `docs/plans/audits/2026-05-11-claude-commands-agents-merge-task-8.md`
