# Tool Input Rendering Design

**Date:** 2026-04-19
**Goal:** Re-architect the Claude Agent SDK tool rendering pipeline so tool inputs are normalized at the adapter boundary, streamed as a single `tool.started` with complete input, and rendered through a per-tool summarizer registry. Preserve the consecutive-same-category grouping UX end-to-end.
**Approach:** Five independent phases landing in order (0 → 1 → 2 → 3), each a reviewable PR. Phase 0 is a standalone guardrail. Phase 1 introduces a canonical input shape at the adapter seam. Phase 2 deletes an intermediate event type. Phase 3 replaces a 150-line switch with a per-tool registry, incrementally tool-by-tool. Phase 5/5 is folded into Phase 3 (a test of its structural quality, not a separate deliverable).

## Triggering Bug

Two bugs, both already patched on this branch:

- `fix: forward tool.input_updated to browser as tool_executing` (commit `4761364`). `translateCanonicalEvent` in `relay-event-sink.ts` previously had `case "tool.input_updated": return [];` — it compiled, type-checked, and silently dropped every `tool.input_updated` event emitted by the Claude translator. The Claude SDK streams `tool_use` input incrementally via `input_json_delta`, so `tool.started` fires with `input: {}` and the real input arrives only in follow-up `tool.input_updated` events. With those events dropped, every Claude tool card rendered with an empty input payload.
- `fix: show Claude SDK tool input fields in chat tool cards` (commit `6f70d0e`). OpenCode emits tool inputs in camelCase (`filePath`); Claude SDK emits snake_case (`file_path`). The summary extractor in `group-tools.ts` only read the OpenCode spelling, so Claude tool rows showed no subtitles. The fix added a `readStr(input, "filePath", "file_path")` helper that tries multiple aliases per field.

Both fixes are tactical: they make the bugs non-blocking but leave the root structural issues. A canonical event type silently yielded zero `RelayMessage`s and no test caught it. Tool input normalization lives in a frontend summary helper instead of at the adapter boundary, so every downstream consumer (projector, history replay, permissions, export) still has to know both naming conventions.

See the investigation notes below for the full fragility analysis.

## Design

### Phase 0 — Translator return type guardrail

Change `translateCanonicalEvent` in `src/lib/provider/relay-event-sink.ts` from `RelayMessage[]` to a discriminated union:

```ts
type TranslationResult =
  | { kind: "emit"; messages: RelayMessage[] }
  | { kind: "silent"; reason: string };

function translateCanonicalEvent(event: CanonicalEvent): TranslationResult;
```

Every case that returns `[]` today must now return `{ kind: "silent", reason: "<why>" }`. Examples:

- `tool.running` → `silent({ reason: "ToolRunningPayload carries no callId; partId anchor already covered by tool.started" })`
- `session.status` for idle/busy → `silent({ reason: "prompt handler owns lifecycle; terminal done/error covers completion" })`
- `message.created` / `session.created` / `session.renamed` / `session.provider_changed` → `silent({ reason: "persistence-only event; no UI surface in relay" })`
- `permission.asked` / `permission.resolved` / `question.asked` / `question.resolved` → `silent({ reason: "handled via requestPermission/requestQuestion side-channel" })`

The caller in `push()` becomes:

```ts
const result = translateCanonicalEvent(event);
if (result.kind === "emit") { for (const m of result.messages) send(m); ... }
// silent: debug-log result.reason if verbose
```

Exhaustive test (`test/unit/provider/relay-event-sink-exhaustive.test.ts`) must also assert: for every event type in a fixture of payload-carrying types (`text.delta`, `thinking.*`, `tool.started`, `tool.completed`, `turn.*`), the translator returns `{ kind: "emit" }` with `messages.length >= 1`. A table-driven test constructs one minimal event per type and asserts shape. Had this existed, the `tool.input_updated → []` regression would have been caught at CI rather than in user sessions.

### Phase 1 — Normalize tool inputs at the adapter boundary

Define a canonical tool input schema as a discriminated union in `src/lib/persistence/events.ts`:

```ts
export type CanonicalToolInput =
  | { tool: "Read";      filePath: string; offset?: number; limit?: number }
  | { tool: "Edit";      filePath: string; oldString: string; newString: string; replaceAll?: boolean }
  | { tool: "Write";     filePath: string; content: string }
  | { tool: "Bash";      command: string; description?: string; timeoutMs?: number }
  | { tool: "Grep";      pattern: string; path?: string; include?: string; fileType?: string }
  | { tool: "Glob";      pattern: string; path?: string }
  | { tool: "WebFetch";  url: string; prompt?: string }
  | { tool: "WebSearch"; query: string }
  | { tool: "Task";      description: string; prompt: string; subagentType?: string }
  | { tool: "LSP";       operation: string; filePath?: string }
  | { tool: "Unknown";   name: string; raw: Record<string, unknown> };
```

`ToolStartedPayload.input` and `ToolInputUpdatedPayload.input` are retyped from `unknown` to `CanonicalToolInput`. Persistence stores canonical shape.

Each adapter owns a `normalizeToolInput(name: string, rawInput: unknown): CanonicalToolInput` function:

- `src/lib/provider/claude/normalize-tool-input.ts` — maps `file_path → filePath`, `old_string → oldString`, `subagent_type → subagentType`, `glob → include`, `type → fileType`, etc.
- `src/lib/provider/opencode/normalize-tool-input.ts` — mostly passthrough; handles `WebSearch` `url` vs `query` semantic divergence by preferring `query` as canonical and falling back to hostname extraction for OpenCode's `url`.
- Unknown tool names collapse to `{ tool: "Unknown", name, raw }` — never lost, always renderable.

Call sites:

- `src/lib/provider/claude/claude-event-translator.ts:430-462` (`handleBlockStart` tool_use branch) — normalizes `block.input` before emitting `tool.started`.
- `claude-event-translator.ts:502-539` (`handleBlockDelta` input_json_delta branch) — normalizes `parsed` before emitting `tool.input_updated`.
- OpenCode event translator's `message.part.updated` tool synthesis path — normalizes before canonical-event synthesis.

Downstream:

- The `readStr` helper in `src/lib/frontend/utils/group-tools.ts` is deleted.
- `extractToolSummary` narrows `input` to `CanonicalToolInput` and uses typed field access. No more alias maps anywhere downstream.

**Persistence migration.** SQLite already contains events with raw (un-normalized) `input` shapes. Two options:

| Option | Pros | Cons |
|---|---|---|
| Schema version field + replay-time upcast | No migration window; rollback-friendly; each adapter's `normalizeToolInput` doubles as the upcaster | Upcast runs on every replay forever; keeps dual code paths alive |
| One-time backfill migration | Clean event store; no runtime upcast | Backfill window + rollback complexity; schema-version field is the safer posture anyway for future refactors |

**Chosen: schema version field + replay-time upcast.** Add `schemaVersion?: number` to `EventMetadata` in `src/lib/persistence/events.ts`. New events tag `schemaVersion: 2`. The projector replay path (`src/lib/persistence/projectors/*`) calls `normalizeToolInput` against `event.data.input` when `schemaVersion` is absent or `< 2`. Adapter code is the single source of the normalization logic — no duplication. The upcast path is deleted once a future migration PR rewrites old rows in place.

### Phase 2 — Buffer tool.started; delete tool.input_updated

The current Claude path (`claude-event-translator.ts:397-472`):

1. `content_block_start` with `block.type === "tool_use"` → emit `tool.started` with whatever `block.input` the SDK populated (often `{}`).
2. Each `input_json_delta` on the same block index → buffer JSON, try to parse, emit `tool.running` + `tool.input_updated` when parse succeeds and fingerprint changed.
3. `content_block_stop` on that index → no-op (tool_use blocks wait for `tool_result`).

Change: buffer the tool_use block until either (a) `content_block_stop` on that index fires, or (b) the last `input_json_delta` on that index produces a parse that fingerprint-matches what we already have plus the block's own `stop` signal. Emit `tool.started` once, at buffer flush, with complete canonical input.

Concretely in `handleBlockStart` (tool_use branch): create the `ToolInFlight` entry but do **not** call `this.push(makeCanonicalEvent("tool.started", ...))`. Instead, set a `pendingStart: true` flag on the entry. In `handleBlockDelta` (input_json_delta branch): accumulate `partialInputJson`; on successful parse, stash the parsed object on the entry as `bufferedInput` without emitting `tool.input_updated`. In `handleBlockStop`: if `pendingStart` is set, emit `tool.started` now with `input: normalizeToolInput(tool.toolName, tool.bufferedInput ?? tool.input)`, clear `pendingStart`.

Delete:

- `tool.input_updated` from `CANONICAL_EVENT_TYPES` in `events.ts` (line 44).
- `ToolInputUpdatedPayload` interface (lines 111-122).
- The `"tool.input_updated"` key from `EventPayloadMap` and `PAYLOAD_REQUIRED_FIELDS`.
- The `case "tool.input_updated":` branch in `translateCanonicalEvent` (`relay-event-sink.ts:278-294`).
- The `running→running` branch in `src/lib/frontend/stores/tool-registry.ts:133-142` — it existed specifically to merge `tool_executing`-with-input events against an already-running entry. Once `tool.started` carries complete input, there is nothing to merge.
- The `"tool.input_updated"` entry from the exhaustive test's `HANDLED_TYPES` set.

**Optional `tool.streaming` signal (not a commitment, mention as design option).** If the UI wants a "tool is imminent" indicator during the block-streaming window (~50–300 ms between `content_block_start` and `content_block_stop` for a `tool_use` block), add a payload-free `tool.streaming` canonical event fired from `handleBlockStart`. It is a pure progress signal — no state-carrying fields, no input payload. The browser could use it to render a skeleton tool card during streaming. Deliberately deferred: the current UX does not distinguish the pre-input window from the post-input-pre-result window, so there is no concrete consumer. Record as a follow-up hook point.

### Phase 3 — Per-tool summarizer registry (preserves groups)

The 150-line `extractToolSummary` switch in `src/lib/frontend/utils/group-tools.ts:97-233` becomes a registry. One file per tool at `src/lib/frontend/utils/tool-summarizers/`:

```
tool-summarizers/
  index.ts           # SUMMARIZERS map + lookupSummarizer(name)
  read.ts
  edit.ts
  write.ts
  bash.ts            # docstring explains "command preferred over description"
  grep.ts
  glob.ts
  web-fetch.ts
  web-search.ts
  task.ts
  lsp.ts
  skill.ts
  ask-user-question.ts
  unknown.ts         # renders JSON preview as text expandedContent
```

Summary shape:

```ts
export type ToolSummary = {
  subtitle?: string;
  tags?: string[];
  expandedContent?: ExpandedContent;
};

export type ExpandedContent =
  | { kind: "code"; language: string; content: string }
  | { kind: "path"; filePath: string; offset?: number; limit?: number }
  | { kind: "link"; url: string; label: string }
  | { kind: "diff"; before: string; after: string }
  | { kind: "text"; body: string };

export type ToolSummarizer<I extends CanonicalToolInput> = {
  readonly tool: I["tool"];
  summarize(input: I, ctx: { repoRoot?: string }): ToolSummary;
};
```

**UX constraint preserved.** `getToolCategory`, `TOOL_CATEGORIES`, `CATEGORY_LABELS`, `groupMessages`, `buildToolGroup`, `aggregateStatus`, `toolCountSummary`, and `ToolGroupCard.svelte` are **untouched**. The consecutive-same-category collapsed group header with expand/collapse behavior remains exactly as it is today.

**What changes at the leaf.** `ToolGroupItem.svelte` (`src/lib/frontend/components/chat/ToolGroupItem.svelte:15`) and `ToolGenericCard.svelte` (`src/lib/frontend/components/chat/ToolGenericCard.svelte:92, 95-101`) call `lookupSummarizer(message.name).summarize(input, ctx)` instead of `extractToolSummary`. They render `summary.subtitle` / `summary.tags` in the header as they do today. When expanded, they render `summary.expandedContent` via a small switch on `kind`:

```svelte
{#if summary.expandedContent}
  {@const ec = summary.expandedContent}
  {#if ec.kind === "code"}<CodeBlock lang={ec.language} content={ec.content} />
  {:else if ec.kind === "path"}<FilePathExpand path={ec.filePath} offset={ec.offset} limit={ec.limit} />
  {:else if ec.kind === "link"}<LinkExpand url={ec.url} label={ec.label} />
  {:else if ec.kind === "diff"}<DiffExpand before={ec.before} after={ec.after} />
  {:else if ec.kind === "text"}<TextExpand body={ec.body} />
  {/if}
{/if}
```

Five presentation primitives, not a component per tool. The Bash-command-echo logic currently inlined in both ToolGroupItem and ToolGenericCard (Bash-specific `$ {bashCommand}` prefix) moves into the Bash summarizer's `expandedContent.kind = "code"` payload.

**Bash rationale documentation (Phase 5/5 absorbed).** `bash.ts` carries a top-of-file docstring explaining why `command` is preferred over `description`:

```ts
/**
 * Bash summarizer.
 *
 * Subtitle preference: `command` first, `description` fallback.
 *
 * Rationale: the user wants to see what actually ran, not what the model
 * claimed it would do. `description` is model-authored narrative prose;
 * `command` is the shell string that was executed. When both exist, the
 * shell string is more informative and more verifiable. When the command
 * has not yet streamed (rare, only during the input-buffering window in
 * Phase 2 of the tool-input-rendering refactor), fall back to description
 * so the row is not empty.
 *
 * History: this was accidentally the other way around before commit 6f70d0e
 * (description preferred). That was not a design choice — it was an artifact
 * of a switch-statement patch that never revisited its rationale. This file
 * exists in part so future changes have a place to put their reasoning.
 */
```

This is the structural test of Phase 3's quality: the rationale for a single conditional lives next to the code that implements it, not three levels deep in a switch statement.

**Unknown fallback.** `unknown.ts` summarizer takes any tool input it receives (as `{ tool: "Unknown", name, raw }`) and returns:

```ts
{
  subtitle: truncate(JSON.stringify(raw), 60),
  expandedContent: { kind: "text", body: JSON.stringify(raw, null, 2) },
}
```

Result: a newly-shipped tool type that nobody added a summarizer for renders a readable JSON preview in both collapsed and expanded forms. Never blank.

**Incremental migration.** The old `extractToolSummary` stays alive as a fallback during rollout. `lookupSummarizer(name)` returns the registry entry if present, else falls through to a shim that calls `extractToolSummary` and wraps its return into the new `ToolSummary` shape (without `expandedContent`). One tool per commit behind the `SUMMARIZERS` map. Once all tools are ported, delete `extractToolSummary` in a final cleanup commit.

## Migration

Each phase is a separate PR. Phases 1–3 depend on the per-session-chat-state refactor landing first (`2026-04-19-session-chat-state-per-session-design.md`) because Phase 3 reads `toolRegistry` from `SessionChatState`.

1. **Phase 0 (standalone).** Guardrail PR. Rewrites `translateCanonicalEvent` return type, updates `push()` caller, extends exhaustive test. Can land any time, before or after the per-session-state refactor. Net change: ~60 lines, all additive + one signature flip.
2. **Phase 1.** Add `CanonicalToolInput` + `schemaVersion` to events. Add `normalizeToolInput` to each adapter. Update adapter emit sites. Update projector replay to upcast. Migrate `group-tools.ts` to typed field access; delete `readStr`. Each step commits independently.
3. **Phase 2.** Buffer tool_use blocks in `ClaudeEventTranslator`. Delete `tool.input_updated` (event type, payload, `relay-event-sink` case, exhaustive-test entry, `running→running` branch in tool-registry). Can land in parallel with Phase 1 but cleaner after Phase 1 because the buffered input flows through `normalizeToolInput`.
4. **Phase 3.** Add `tool-summarizers/` directory with shim wrapper. Port tools one per commit (11 tools + Unknown = 12 commits). Port `ToolGroupItem` and `ToolGenericCard` expanded-content rendering to the new `ExpandedContent` switch. Delete `extractToolSummary` in the final commit.

Each PR compiles, passes existing tests, and preserves grouping UX. No feature flags — the structural preservation of `groupMessages` + `ToolGroupCard` is the guarantee.

## Tests

**Phase 0.**
- `test/unit/provider/relay-event-sink-translation-shape.test.ts` — new. Table-driven: for every canonical event type carrying a UI-relevant payload, assert `kind === "emit"` and `messages.length >= 1`. For every silent case, assert `kind === "silent"` and `reason.length > 0`.
- Existing `relay-event-sink-exhaustive.test.ts` migrated to assert on the discriminated union shape.

**Phase 1.**
- `test/unit/provider/claude/normalize-tool-input.test.ts` — per-tool fixtures for every `CanonicalToolInput` variant. Snake-case input → typed canonical output. Round-trip for `normalizeToolInput(name, raw)` into `CanonicalToolInput` stable for same raw shape.
- `test/unit/provider/opencode/normalize-tool-input.test.ts` — same coverage, camelCase input fixtures. WebSearch `url`-only input falls back to hostname-in-query; WebSearch `query` input passes through.
- `test/unit/persistence/schema-version-upcast.test.ts` — event row with no `schemaVersion` replays through upcast; event with `schemaVersion: 2` replays without upcast; upcast output matches fresh-emit output for identical raw.
- Unknown-tool-name test: any unmapped `name` collapses to `{ tool: "Unknown", name, raw }`.

**Phase 2.**
- `test/unit/provider/claude/tool-use-buffering.test.ts` — fixtures of Claude SDK message streams with 1/2/4-chunk `input_json_delta` runs. Assert exactly one `tool.started` emitted per tool_use block, with complete `CanonicalToolInput`. Assert zero `tool.input_updated` emitted (type no longer exists). Assert the final input matches the union of all delta chunks.
- `test/unit/frontend/tool-registry-single-start.test.ts` — registry's `running→running` branch deleted; a redundant executing event after start is now a reject, not a merge. Cover: duplicate `tool_start` still idempotent; the registry does not regress on OpenCode's legitimate metadata-later flow (which previously also used the merge branch — must survive via a narrower `updateMetadata` entry point).

**Phase 3.**
- `test/unit/frontend/tool-summarizers/<tool>.test.ts` — per-tool. Minimum 3 fixtures each: happy path, empty/partial input, edge case (e.g. Read with offset+limit, Bash with no command, Grep with all 4 filter fields, WebSearch with empty query). Each asserts `subtitle`, `tags`, and `expandedContent` shape.
- `test/unit/frontend/tool-summarizers/unknown.test.ts` — unknown tool names never return empty; JSON preview truncates correctly.
- `test/unit/frontend/group-tools-grouping.test.ts` — **regression**: consecutive same-category tool messages still collapse into `ToolGroup`. Task/AskUserQuestion/Skill still bypass grouping. Solo tools stay as `ToolMessage`. Run before and after Phase 3 to prove grouping behavior is byte-identical.
- Storybook: one story per summarizer covering collapsed row + expanded panel for each `ExpandedContent` kind. Regression story: three consecutive Reads render as a group (not three separate cards).
- E2E: Playwright test exercises a Claude SDK turn with Bash + Read + Edit; asserts group header text, expand → per-tool row content, and Bash expanded panel shows `$ command` prefix.

**Migrated tests.** Every existing test that constructs `tool.input_updated` events or asserts on the merge branch is migrated or deleted in Phase 2. Every test that calls `extractToolSummary` migrates to `lookupSummarizer(name).summarize(input, ctx)` in Phase 3.

## Risks

| Risk | Mitigation |
|------|------------|
| Phase 1 breaks replay of historical events in production SQLite | `schemaVersion` upcast path tested against a fixture of raw events captured from production. Dev-mode assertion that every projector replay either sees `schemaVersion >= 2` or exercises the upcast path (never raw-field access without upcast). |
| Deleting `tool.input_updated` breaks OpenCode's late-metadata flow | OpenCode's `running→running` merge covers subagent/Task metadata arriving after initial running. Preserve via a narrower `updateMetadata(id, metadata)` registry entry point (not tied to input). Explicit unit test. |
| `CanonicalToolInput` union does not capture every tool the SDK emits | `{ tool: "Unknown"; name; raw }` is the escape hatch. Every unknown name has a defined render path (JSON preview). No tool is ever rendered as blank. |
| Summarizer registry lookup misses a newly-added tool | `lookupSummarizer` falls through to the Unknown summarizer, never returns undefined. Type: `ToolSummarizer<CanonicalToolInput>`, exhaustively covered by the discriminated union. |
| ToolGroupItem / ToolGenericCard ExpandedContent rendering diverges between the two components | Shared `<ExpandedContent>` component consumed by both. Storybook renders both in the same story. |
| Schema-version upcast path never deleted, turns into debt | Bundle deletion into a separately-tracked issue: "rewrite old event rows in place once Phase 1 has been in prod 30 days." Referenced in the code at the upcast call site. |
| Grouping UX regresses silently | Regression test (`group-tools-grouping.test.ts`) runs before and after Phase 3 on the same fixture. Playwright asserts on the collapsed-group DOM attribute (`ToolGroupCard.svelte:42`) unchanged. |
| Bash rationale docstring rots | The docstring is adjacent to the only conditional it explains. If the conditional changes, the docstring is in the diff. |

## Non-Goals

- UI redesign. Grouping behavior, collapsed-header style, and expand/collapse animation are untouched.
- Per-tool custom components (one Svelte file per tool). Phase 3 explicitly rejects this — five `ExpandedContent` primitives cover every case, adding a new tool is a `.ts` file, not a `.svelte` file.
- Permissions-card or question-card redesign. Their render paths (`ToolQuestionCard`, `ToolSubagentCard`) remain separate from the generic summarizer flow — see `ToolItem.svelte:22-24`.
- Provider-adapter additions beyond Claude and OpenCode.
- Changes to `TOOL_CATEGORIES`, `CATEGORY_LABELS`, or grouping semantics.
- Tool-result rendering. Result content (the post-execution payload) is unchanged; only input rendering moves.

## Known Debt After This Refactor

- The schema-version upcast path in projectors is transitional. A follow-up PR should rewrite old rows in place and delete the upcast code.
- `ToolSubagentCard.svelte` and `ToolQuestionCard.svelte` bypass the summarizer registry. They have their own input-shape assumptions that should eventually flow through `CanonicalToolInput`'s `Task` and `AskUserQuestion` variants. Out of scope here.
- `TodoWrite` / `TodoRead` do not have canonical-input variants yet — they use a separate todo store. Eventually bring them into `CanonicalToolInput`.
- The `tool.streaming` signal is deferred. If UX later wants a pre-input skeleton state, the Phase 2 buffering code is the insertion point.

---

## Appendix A: Root Cause (investigation notes)

**R1 — Translator returned `[]` without a compiler signal.** `src/lib/provider/relay-event-sink.ts:228-375`. The `translateCanonicalEvent` function returns `RelayMessage[]`, and `[]` is a valid return. No type-level distinction between "this event deliberately emits nothing" and "this event emits nothing because I forgot to implement it." The exhaustive test at `test/unit/provider/relay-event-sink-exhaustive.test.ts` only checked that every event type appears in the switch, not that payload-carrying events produce output.

**R2 — Adapter-side naming conventions leak to every consumer.** `extractToolSummary` in `src/lib/frontend/utils/group-tools.ts:97-233` reads field names via `readStr(input, "filePath", "file_path")`. The helper exists because OpenCode and Claude SDK emit different casing. Every call site is a potential alias-drift bug. The recent fix (commit `6f70d0e`) added camelCase-OR-snake_case reads throughout — correct, but a patch applied at the leaf. The projector, history replay, permissions display, and any future consumer must repeat the same alias logic.

**R3 — `tool.input_updated` exists because `tool.started` lies.** `claude-event-translator.ts:397-461` emits `tool.started` with `input: {}` at `content_block_start`, because the SDK has not yet streamed the tool input. `handleBlockDelta` parses `input_json_delta` chunks and emits `tool.input_updated` events as the input fills in. Every consumer (relay sink, browser tool registry, projector) has merge logic to handle the two-phase delivery. The two-phase delivery is unnecessary: the SDK emits `content_block_stop` on the same index once the input is complete, so the translator can buffer and emit a single `tool.started` with complete input.

**R4 — `extractToolSummary` is a 150-line switch.** Adding a tool requires editing a central file. No per-tool tests (only fixtures-as-prose embedded in mixed-concern unit tests). No place to document Bash's "command preferred over description" rationale other than a code comment adjacent to a line inside a switch statement. The fix in commit `6f70d0e` flipped that preference; the reasoning had to be reconstructed by reading the diff because the old behavior had no docstring.

## Appendix B: Why Not Caught

- **W1** — No test for "does the translator emit at least one RelayMessage for a payload-carrying event." The exhaustive test asserted structural coverage (case exists) but not behavioral coverage (case emits).
- **W2** — No adapter-level contract test asserting that `ToolStartedPayload.input` has a stable shape regardless of provider. Consumers defensively coded around the divergence with alias reads.
- **W3** — `tool.input_updated` as a concept was introduced alongside the Claude SDK integration. Its asymmetry with OpenCode (which does not need it) was never flagged as a design smell — the translator has a merge-style `running→running` branch in the tool-registry that absorbs the asymmetry silently.
- **W4** — The `extractToolSummary` switch has no test-per-case structure. Changes to Bash preference logic (commit `6f70d0e`) passed review because the function still returned a plausible string; there was no test asserting "Bash subtitle is the command when command is present."
- **W5** — TypeScript has no way to say "this event type, when emitted, must produce at least one RelayMessage." Phase 0's discriminated union narrows that gap at the type level (`{ kind: "silent"; reason }` is intentional-emptiness, `{ kind: "emit"; messages }` is explicit-emission).

## Appendix C: File Touch List

| File | Phase(s) | Change |
|---|---|---|
| `src/lib/provider/relay-event-sink.ts` | 0, 2 | Return type; delete `tool.input_updated` case |
| `src/lib/provider/claude/claude-event-translator.ts` | 1, 2 | Normalize + buffer tool_use; single `tool.started` |
| `src/lib/provider/claude/normalize-tool-input.ts` | 1 | **new** |
| `src/lib/provider/opencode/normalize-tool-input.ts` | 1 | **new** |
| `src/lib/persistence/events.ts` | 1, 2 | `CanonicalToolInput`, `schemaVersion`; delete `ToolInputUpdatedPayload` |
| `src/lib/persistence/projectors/*` | 1 | Upcast call at replay seam |
| `src/lib/frontend/utils/group-tools.ts` | 1, 3 | Delete `readStr`; callers migrate to registry |
| `src/lib/frontend/utils/tool-summarizers/` | 3 | **new directory** |
| `src/lib/frontend/components/chat/ToolGroupItem.svelte` | 3 | Registry lookup + `ExpandedContent` switch |
| `src/lib/frontend/components/chat/ToolGenericCard.svelte` | 3 | Same |
| `src/lib/frontend/components/chat/ToolGroupCard.svelte` | — | **unchanged** |
| `src/lib/frontend/stores/tool-registry.ts` | 2 | Delete `running→running` input-merge; keep narrower `updateMetadata` |
| `test/unit/provider/relay-event-sink-exhaustive.test.ts` | 0 | Extend to shape assertion |
