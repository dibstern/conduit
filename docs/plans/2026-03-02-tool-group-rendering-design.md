# Tool Group Rendering Design

Consecutive same-category tool calls should collapse into a single grouped card, matching the opencode web UI's "Explored · 11 reads" pattern. Solo tool calls render as today.

## Problem

Currently every tool call renders as its own `ToolItem` row. When Claude reads 11 files in parallel, the user sees 11 separate rows cluttering the chat. The opencode web UI groups these into a collapsible card with a summary header.

## Decision: Render-time grouping

The flat `chatState.messages` array stays unchanged. A `$derived` reactive computation in the render layer groups consecutive same-category tool messages into `ToolGroup` objects. This keeps stores, event handlers, and the server untouched.

```
chatState.messages (flat) → $derived groupedMessages → render
   ToolMessage[]               ToolGroup | ChatMessage      ToolGroupCard / ToolItem
```

## Category Mapping

| Category  | Tools                        | Verb Label |
|-----------|------------------------------|------------|
| explore   | Read, Glob, Grep, LSP        | Explored   |
| edit      | Edit, Write                  | Edited     |
| shell     | Bash                         | Shell      |
| fetch     | WebFetch                     | Fetched    |
| task      | Task                         | Tasked     |
| other     | (unmapped)                   | Used       |

Summary format: `"{verb} · {count} {tool_name_plural}"`.
Mixed tools within a category: `"Explored · 5 reads, 2 greps"`.

## Data Changes

### ToolMessage gets `input`

```typescript
export interface ToolMessage {
  // ... existing fields ...
  input?: Record<string, unknown>;  // NEW
}
```

### handleToolExecuting stores input

Currently discards `input` from the `tool_executing` event. Updated to persist it:

```typescript
export function handleToolExecuting(msg) {
  const { id, input } = msg;
  // ...find message by uuid...
  messages[idx] = { ...messages[idx], status: "running", input };
}
```

### history-logic.ts extracts input

`convertAssistantParts` already has access to `state?.input` but doesn't pass it through. Updated to include it in the `ToolMessage`.

## Input Display (Pretty Summaries)

Each tool type has a key-arg extractor that returns subtitle + optional tags.

| Tool    | Subtitle                         | Tags                    |
|---------|----------------------------------|-------------------------|
| Read    | Relative path from `filePath`    | `offset`, `limit`       |
| Edit    | Relative path from `filePath`    | —                       |
| Write   | Relative path from `filePath`    | —                       |
| Glob    | `pattern` value                  | —                       |
| Grep    | `pattern` value                  | `include`               |
| Bash    | `description` field              | —                       |
| Task    | `description` field              | `subagent_type`         |
| WebFetch| Hostname from `url`              | —                       |
| LSP     | `operation` value                | Relative path           |

File paths are made relative by stripping the repo root prefix (available from project/session info in frontend stores).

## Grouping Rules

Pure function: `groupMessages(messages: ChatMessage[]): (ChatMessage | ToolGroup)[]`

```typescript
interface ToolGroup {
  type: "tool-group";
  uuid: string;
  category: "explore" | "edit" | "shell" | "fetch" | "task" | "other";
  label: string;         // "Explored"
  summary: string;       // "5 reads, 2 greps"
  tools: ToolMessage[];
  status: "pending" | "running" | "completed" | "error";
}
```

Rules:
- Walk messages linearly
- Consecutive `ToolMessage`s of the same category merge into a `ToolGroup`
- Groups of 1 are NOT created — the tool stays as a solo `ToolMessage`
- Non-tool messages break the group
- Aggregate status: `"running"` if any pending/running, `"error"` if any errored, else `"completed"`

## Component Hierarchy

```
MessageList.svelte
  ├── ToolItem.svelte          ← solo tool calls (existing, enhanced with input display)
  └── ToolGroupCard.svelte     ← NEW: collapsible group
        └── ToolGroupItem.svelte  ← NEW: compact row within group
```

## Behavior

- **Collapsed by default** — shows summary header only
- **Click header** to expand/collapse the group list
- **Click individual item** to expand its result inline
- **Solo tools** (single, not grouped) render as current `ToolItem` but with the new input subtitle

## Visual Layout

### Collapsed group
```
▶ Explored · 11 reads                                 ✓
```

### Expanded group
```
▼ Explored · 11 reads                                 ✓
  Read   src/Process.hs
  Read   src/Prelude.hs
  Read   src/Config.hs
  Read   src/Model.hs                    offset=82  limit=10
  Read   src/Model.hs                    offset=260 limit=15
  Read   src/Parser.hs                   offset=280 limit=20
  ...
```

### Solo Bash tool
```
▶ Shell  Get base SHA for reviews                     ✓
```

### Solo Bash expanded
```
▼ Shell  Get base SHA for reviews                     ✓
  $ git rev-parse HEAD
  c14c4da090bb9b35ae2b716d44a9d0d6fa9bf112
```

## Files to Change

| File | Change |
|------|--------|
| `src/lib/public/types.ts` | Add `input` to `ToolMessage`, add `ToolGroup` type |
| `src/lib/public/stores/chat.svelte.ts` | Store input in `handleToolExecuting` |
| `src/lib/public/utils/history-logic.ts` | Pass `state?.input` to `ToolMessage` |
| `src/lib/public/utils/group-tools.ts` | NEW — `groupMessages` + `extractToolSummary` pure functions |
| `src/lib/public/components/chat/MessageList.svelte` | Use `$derived` grouped messages, render `ToolGroupCard` |
| `src/lib/public/components/chat/ToolGroupCard.svelte` | NEW — collapsible group component |
| `src/lib/public/components/chat/ToolGroupItem.svelte` | NEW — compact row within group |
| `src/lib/public/components/chat/ToolItem.svelte` | Enhance with input subtitle display |
| `src/lib/public/components/features/HistoryView.svelte` | Same grouping logic as MessageList |
| `src/lib/public/stories/mocks.ts` | Add mock data with `input` fields |
| Storybook stories | New stories for group states |
