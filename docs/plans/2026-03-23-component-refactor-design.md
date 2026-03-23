# Component Refactor Design

## Goal

Improve frontend component organization and readability by:
1. Eliminating the catch-all `features/` directory
2. Extracting model variant into its own component
3. Decomposing large components (InputArea, ToolItem, TodoOverlay) into focused sub-components
4. Adding a shared `useClickOutside` composable for the pattern duplicated in 5+ components

## Directory Reorganization

Eliminate `features/` entirely. Move each component to a domain-specific directory, creating new directories where none exist.

### New Directory Structure

```
components/
├── chat/           (message rendering - existing, expanded)
│   ├── AssistantMessage.svelte
│   ├── MessageList.svelte
│   ├── ResultBar.svelte
│   ├── SkillItem.svelte
│   ├── SubagentBackBar.svelte
│   ├── SystemMessage.svelte
│   ├── ThinkingBlock.svelte
│   ├── ToolGroupCard.svelte
│   ├── ToolGroupItem.svelte
│   ├── ToolItem.svelte           (dispatcher only)
│   ├── ToolQuestionCard.svelte   (NEW - extracted from ToolItem)
│   ├── ToolSubagentCard.svelte   (NEW - extracted from ToolItem)
│   ├── ToolGenericCard.svelte    (NEW - extracted from ToolItem)
│   ├── QuestionCard.svelte       (MOVED from features/)
│   ├── DiffView.svelte           (MOVED from features/)
│   ├── PastePreview.svelte       (MOVED from features/)
│   ├── HistoryLoader.svelte      (MOVED from features/)
│   ├── PlanMode.svelte           (MOVED from features/)
│   └── UserMessage.svelte
│
├── input/          (NEW - everything related to the input area)
│   ├── InputArea.svelte          (MOVED from layout/, slimmed down)
│   ├── AttachMenu.svelte         (NEW - extracted from InputArea)
│   ├── ContextBar.svelte         (NEW - extracted from InputArea)
│   ├── CommandMenu.svelte        (MOVED from features/)
│   ├── FileMenu.svelte           (MOVED from features/)
│   └── input-utils.ts            (NEW - file fetching, draft logic)
│
├── model/          (NEW - model and agent selection)
│   ├── ModelSelector.svelte      (MOVED from features/)
│   ├── ModelVariant.svelte       (NEW - extracted from ModelSelector)
│   └── AgentSelector.svelte      (MOVED from features/)
│
├── session/        (NEW - session management)
│   ├── SessionList.svelte        (MOVED from features/)
│   ├── SessionItem.svelte        (MOVED from features/)
│   └── SessionContextMenu.svelte (MOVED from features/)
│
├── terminal/       (NEW - terminal panel)
│   ├── TerminalPanel.svelte      (MOVED from features/)
│   └── TerminalTab.svelte        (MOVED from features/)
│
├── file/           (NEW - file browsing and viewing)
│   ├── FileViewer.svelte         (MOVED from features/)
│   ├── FileTreeNode.svelte       (MOVED from features/)
│   └── SidebarFilePanel.svelte   (MOVED from features/)
│
├── permissions/    (NEW - permission requests)
│   ├── PermissionCard.svelte     (MOVED from features/)
│   └── PermissionNotification.svelte (MOVED from features/)
│
├── todo/           (NEW)
│   ├── TodoOverlay.svelte        (MOVED from features/)
│   ├── TodoHeader.svelte         (NEW - extracted)
│   ├── TodoProgressBar.svelte    (NEW - extracted)
│   └── TodoItem.svelte           (NEW - extracted)
│
├── project/        (NEW)
│   └── ProjectSwitcher.svelte    (MOVED from features/)
│
├── layout/         (existing - structural wrappers only)
│   ├── ChatLayout.svelte
│   ├── Header.svelte
│   └── Sidebar.svelte
│
├── overlays/       (existing - unchanged)
├── setup/          (existing - unchanged)
├── debug/          (existing - unchanged)
│
└── shared/         (existing - expanded with composable)
    ├── BlockGrid.svelte
    ├── ConduitLogo.svelte
    ├── Icon.svelte
    ├── ToggleSetting.svelte
    └── use-click-outside.svelte.ts  (NEW)
```

### Movement Summary

| From `features/` | To |
|---|---|
| QuestionCard, DiffView, PastePreview, HistoryLoader, PlanMode | `chat/` |
| CommandMenu, FileMenu | `input/` |
| ModelSelector, AgentSelector | `model/` |
| SessionList, SessionItem, SessionContextMenu | `session/` |
| TerminalPanel, TerminalTab | `terminal/` |
| FileViewer, FileTreeNode, SidebarFilePanel | `file/` |
| PermissionCard, PermissionNotification | `permissions/` |
| TodoOverlay | `todo/` |
| ProjectSwitcher | `project/` |

InputArea moves from `layout/` to `input/`.

## Component Decompositions

### InputArea (572 → ~250 lines)

Extract from `InputArea.svelte`:

- **AttachMenu.svelte** (~50 lines): attach button + camera/photos dropdown + outside-click dismiss
- **ContextBar.svelte** (~30 lines): context usage percentage bar above textarea
- **input-utils.ts** (~60 lines): `fetchFileContent()` and `fetchDirectoryListing()` async WS helpers

InputArea keeps: state, per-session drafts, cross-tab sync, keydown dispatch, sendMessage, handleStop, and template composing sub-components.

### ToolItem (564 → ~50 line dispatcher)

Split into three rendering modes:

- **ToolItem.svelte** (~50 lines): thin dispatcher checking `isQuestion`/`isSubagent` and delegating
- **ToolQuestionCard.svelte** (~180 lines): question detection logic, pendingQuestionRequest matching, read-only display, completed answer, imports QuestionCard for interactive mode
- **ToolSubagentCard.svelte** (~80 lines): subagent detection, session ID extraction, navigate handler, agent card
- **ToolGenericCard.svelte** (~130 lines): expandable generic tool with status, result, truncation, "show full output"

Shared derived state (statusIconName, statusIconClass, subtitleText, groupRadius) either stays in ToolItem and is passed as props, or is duplicated in each sub-component where it's simple enough.

### ModelSelector → ModelVariant

Extract **ModelVariant.svelte** (~80 lines) from ModelSelector:
- Variant badge button
- Variant dropdown with option list
- `cycleVariant()`, `selectVariant()` handlers
- Ctrl+T keyboard shortcut

ModelSelector renders `<ModelVariant />` as a sibling to the model button.

### TodoOverlay (194 → ~70 lines)

Extract:
- **TodoHeader.svelte** (~30 lines): "Tasks 3/5" label with chevron toggle
- **TodoProgressBar.svelte** (~15 lines): track + fill bar
- **TodoItem.svelte** (~40 lines): single row with status icon + description

TodoOverlay keeps: auto-hide timer, collapsed/fading/hidden state, external collapse event, composition.

## Shared Composable

### use-click-outside.svelte.ts

A Svelte 5 action that calls a callback when clicks land outside the element:

```ts
export function clickOutside(node: HTMLElement, callback: () => void) {
  function handleClick(e: MouseEvent) {
    if (!node.contains(e.target as Node)) callback();
  }
  document.addEventListener("click", handleClick, true);
  return {
    destroy() {
      document.removeEventListener("click", handleClick, true);
    }
  };
}
```

Replaces manual outside-click in: ModelSelector, AgentSelector, ProjectSwitcher, InputArea (attach menu), ThemePicker.

## Storybook

All moved components keep their co-located `.stories.ts` files (move with the component). New extracted components get stories only if they're independently testable (ModelVariant yes; ContextBar probably not since it's purely derived from uiState).

## Import Updates

Every file that imports from `features/` or `layout/InputArea` needs its import path updated. This is the bulk of the mechanical work. Key consumers:
- `ChatLayout.svelte` imports ~15 feature components
- `MessageList.svelte` imports QuestionCard, PermissionCard
- `ToolItem.svelte` imports QuestionCard
- `Sidebar.svelte` imports SessionList, SidebarFilePanel, ProjectSwitcher
- `InputArea.svelte` imports CommandMenu, FileMenu, AgentSelector, ModelSelector

## Verification

After each phase: `pnpm check && pnpm lint && pnpm test:unit`
