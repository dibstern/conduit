# Component Refactor Implementation Plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Reorganize frontend components by eliminating `features/`, extracting sub-components from large files, and adding shared composables.

**Architecture:** Pure structural refactoring — move files to domain directories, extract sub-components from oversized components, consolidate duplicated patterns. Zero behavior changes.

**Tech Stack:** Svelte 5, TypeScript, Tailwind CSS

**Verification command:** `pnpm check && pnpm lint` (after every task)

**Design doc:** `docs/plans/2026-03-23-component-refactor-design.md`

---

## Phase 1: Directory Reorganization (Move Components)

Each task moves component(s) + co-located stories to a new directory, then updates all import paths. Stories files use `"./"` relative imports so they move with their component without import changes. Only external importers need path updates.

### Task 1: Create new directories

**Step 1: Create directories**

```bash
mkdir -p src/lib/frontend/components/{input,model,session,terminal,file,permissions,todo,project}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "refactor: create component domain directories"
```

---

### Task 2: Move session components (SessionList, SessionItem, SessionContextMenu)

**Files to move:**
- `components/features/SessionList.svelte` → `components/session/SessionList.svelte`
- `components/features/SessionList.stories.ts` → `components/session/SessionList.stories.ts`
- `components/features/SessionItem.svelte` → `components/session/SessionItem.svelte`
- `components/features/SessionItem.stories.ts` → `components/session/SessionItem.stories.ts`
- `components/features/SessionContextMenu.svelte` → `components/session/SessionContextMenu.svelte`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/SessionList.svelte session/
git mv features/SessionList.stories.ts session/
git mv features/SessionItem.svelte session/
git mv features/SessionItem.stories.ts session/
git mv features/SessionContextMenu.svelte session/
```

**Step 2: Update imports**

Files that import from features/Session*:
- `components/layout/Sidebar.svelte:8` — change `../features/SessionList.svelte` → `../session/SessionList.svelte`
- `components/session/SessionList.svelte` — internally imports `./SessionItem.svelte` (no change needed) and `./SessionContextMenu.svelte` — verify these are relative `"./"` imports that still work

Cross-check: `SessionItem.svelte` imports `SessionContextMenu` — verify the import path. If it was `./SessionContextMenu.svelte`, it still works after move.

**Step 3: Update stories titles**

In `session/SessionList.stories.ts` — change `title: "Features/SessionList"` to `title: "Session/SessionList"`
In `session/SessionItem.stories.ts` — change `title: "Features/SessionItem"` to `title: "Session/SessionItem"`

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move session components to session/"
```

---

### Task 3: Move terminal components (TerminalPanel, TerminalTab)

**Files to move:**
- `components/features/TerminalPanel.svelte` → `components/terminal/TerminalPanel.svelte`
- `components/features/TerminalPanel.stories.ts` → `components/terminal/TerminalPanel.stories.ts`
- `components/features/TerminalTab.svelte` → `components/terminal/TerminalTab.svelte`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/TerminalPanel.svelte terminal/
git mv features/TerminalPanel.stories.ts terminal/
git mv features/TerminalTab.svelte terminal/
```

**Step 2: Update imports**

- `components/layout/ChatLayout.svelte:23` — change `../features/TerminalPanel.svelte` → `../terminal/TerminalPanel.svelte`
- `test/unit/components/chat-layout-ws.test.ts:86` — update mock path from `features/TerminalPanel.svelte` to `terminal/TerminalPanel.svelte`
- `components/terminal/TerminalPanel.svelte` — verify internal import of `TerminalTab` was `./TerminalTab.svelte` (should still work)

**Step 3: Update stories titles**

In `terminal/TerminalPanel.stories.ts` — change `title: "Features/TerminalPanel"` to `title: "Terminal/TerminalPanel"`

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move terminal components to terminal/"
```

---

### Task 4: Move file components (FileViewer, FileTreeNode, SidebarFilePanel)

**Files to move:**
- `components/features/FileViewer.svelte` → `components/file/FileViewer.svelte`
- `components/features/FileTreeNode.svelte` → `components/file/FileTreeNode.svelte`
- `components/features/FileTreeNode.stories.ts` → `components/file/FileTreeNode.stories.ts`
- `components/features/SidebarFilePanel.svelte` → `components/file/SidebarFilePanel.svelte`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/FileViewer.svelte file/
git mv features/FileTreeNode.svelte file/
git mv features/FileTreeNode.stories.ts file/
git mv features/SidebarFilePanel.svelte file/
```

**Step 2: Update imports**

- `components/layout/ChatLayout.svelte:25` — change `../features/FileViewer.svelte` → `../file/FileViewer.svelte`
- `components/layout/Sidebar.svelte:10` — change `../features/SidebarFilePanel.svelte` → `../file/SidebarFilePanel.svelte`
- `test/unit/components/chat-layout-ws.test.ts:94` — update mock path for FileViewer
- `components/file/SidebarFilePanel.svelte` — verify internal import of `FileTreeNode` (should be `./FileTreeNode.svelte`, still works)
- `components/file/FileTreeNode.svelte` — verify recursive self-import (should be `./FileTreeNode.svelte`, still works)

**Step 3: Update stories titles**

In `file/FileTreeNode.stories.ts` — change title prefix from `"Features/"` to `"File/"`

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move file components to file/"
```

---

### Task 5: Move permission components (PermissionCard, PermissionNotification)

**Files to move:**
- `components/features/PermissionCard.svelte` → `components/permissions/PermissionCard.svelte`
- `components/features/PermissionCard.stories.ts` → `components/permissions/PermissionCard.stories.ts`
- `components/features/PermissionNotification.svelte` → `components/permissions/PermissionNotification.svelte`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/PermissionCard.svelte permissions/
git mv features/PermissionCard.stories.ts permissions/
git mv features/PermissionNotification.svelte permissions/
```

**Step 2: Update imports**

- `components/chat/MessageList.svelte:34` — change `../features/PermissionCard.svelte` → `../permissions/PermissionCard.svelte`
- `components/layout/ChatLayout.svelte:26` — change `../features/PermissionNotification.svelte` → `../permissions/PermissionNotification.svelte`
- `test/unit/components/chat-layout-ws.test.ts:98` — update mock path for PermissionNotification

**Step 3: Update stories titles**

In `permissions/PermissionCard.stories.ts` — change title prefix from `"Features/"` to `"Permissions/"`

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move permission components to permissions/"
```

---

### Task 6: Move model components (ModelSelector, AgentSelector)

**Files to move:**
- `components/features/ModelSelector.svelte` → `components/model/ModelSelector.svelte`
- `components/features/ModelSelector.stories.ts` → `components/model/ModelSelector.stories.ts`
- `components/features/AgentSelector.svelte` → `components/model/AgentSelector.svelte`
- `components/features/AgentSelector.stories.ts` → `components/model/AgentSelector.stories.ts`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/ModelSelector.svelte model/
git mv features/ModelSelector.stories.ts model/
git mv features/AgentSelector.svelte model/
git mv features/AgentSelector.stories.ts model/
```

**Step 2: Update imports**

- `components/layout/InputArea.svelte:8` — change `../features/AgentSelector.svelte` → `../model/AgentSelector.svelte`
- `components/layout/InputArea.svelte:13` — change `../features/ModelSelector.svelte` → `../model/ModelSelector.svelte`

**Step 3: Update stories titles**

In `model/ModelSelector.stories.ts` — change title prefix from `"Features/"` to `"Model/"`
In `model/AgentSelector.stories.ts` — change title prefix from `"Features/"` to `"Model/"`

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move model components to model/"
```

---

### Task 7: Move chat-related feature components (QuestionCard, DiffView, PastePreview, HistoryLoader, PlanMode)

**Files to move:**
- `components/features/QuestionCard.svelte` → `components/chat/QuestionCard.svelte`
- `components/features/QuestionCard.stories.ts` → `components/chat/QuestionCard.stories.ts`
- `components/features/DiffView.svelte` → `components/chat/DiffView.svelte`
- `components/features/DiffView.stories.ts` → `components/chat/DiffView.stories.ts`
- `components/features/PastePreview.svelte` → `components/chat/PastePreview.svelte`
- `components/features/PastePreview.stories.ts` → `components/chat/PastePreview.stories.ts`
- `components/features/HistoryLoader.svelte` → `components/chat/HistoryLoader.svelte`
- `components/features/PlanMode.svelte` → `components/chat/PlanMode.svelte`
- `components/features/PlanMode.stories.ts` → `components/chat/PlanMode.stories.ts`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/QuestionCard.svelte chat/
git mv features/QuestionCard.stories.ts chat/
git mv features/DiffView.svelte chat/
git mv features/DiffView.stories.ts chat/
git mv features/PastePreview.svelte chat/
git mv features/PastePreview.stories.ts chat/
git mv features/HistoryLoader.svelte chat/
git mv features/PlanMode.svelte chat/
git mv features/PlanMode.stories.ts chat/
```

**Step 2: Update imports**

- `components/chat/ToolItem.svelte:15` — change `../features/QuestionCard.svelte` → `./QuestionCard.svelte`
- `components/chat/MessageList.svelte:35` — change `../features/QuestionCard.svelte` → `./QuestionCard.svelte`
- `components/chat/MessageList.svelte:36` — change `../features/HistoryLoader.svelte` → `./HistoryLoader.svelte`
- `components/layout/ChatLayout.svelte:24` — change `../features/PlanMode.svelte` → `../chat/PlanMode.svelte`
- `test/unit/components/chat-layout-ws.test.ts:90` — update mock path for PlanMode
- `test/unit/components/history-loader.test.ts:51` — change `features/HistoryLoader.svelte` → `chat/HistoryLoader.svelte`

Also verify: `AssistantMessage.svelte` imports `DiffView` — check if it's from `./DiffView.svelte` or `../features/DiffView.svelte` and update accordingly.

**Step 3: Update stories titles**

Change title prefix from `"Features/"` to `"Chat/"` in all moved stories files.

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: move chat-related feature components to chat/"
```

---

### Task 8: Move remaining feature components (TodoOverlay, ProjectSwitcher, CommandMenu, FileMenu)

**Files to move:**
- `components/features/TodoOverlay.svelte` → `components/todo/TodoOverlay.svelte`
- `components/features/TodoOverlay.stories.ts` → `components/todo/TodoOverlay.stories.ts`
- `components/features/ProjectSwitcher.svelte` → `components/project/ProjectSwitcher.svelte`
- `components/features/ProjectSwitcher.stories.ts` → `components/project/ProjectSwitcher.stories.ts`
- `components/features/CommandMenu.svelte` → `components/input/CommandMenu.svelte`
- `components/features/CommandMenu.stories.ts` → `components/input/CommandMenu.stories.ts`
- `components/features/FileMenu.svelte` → `components/input/FileMenu.svelte`
- `components/features/FileMenu.stories.ts` → `components/input/FileMenu.stories.ts`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv features/TodoOverlay.svelte todo/
git mv features/TodoOverlay.stories.ts todo/
git mv features/ProjectSwitcher.svelte project/
git mv features/ProjectSwitcher.stories.ts project/
git mv features/CommandMenu.svelte input/
git mv features/CommandMenu.stories.ts input/
git mv features/FileMenu.svelte input/
git mv features/FileMenu.stories.ts input/
```

**Step 2: Update imports**

- `components/layout/ChatLayout.svelte:22` — change `../features/TodoOverlay.svelte` → `../todo/TodoOverlay.svelte`
- `test/unit/components/chat-layout-ws.test.ts:82` — update mock path for TodoOverlay
- `components/layout/Sidebar.svelte:9` — change `../features/ProjectSwitcher.svelte` → `../project/ProjectSwitcher.svelte`
- `components/layout/InputArea.svelte:10` — change `../features/CommandMenu.svelte` → `../input/CommandMenu.svelte` (BUT NOTE: InputArea itself will move to input/ in Task 9, so temporarily use this path)
- `components/layout/InputArea.svelte:12` — change `../features/FileMenu.svelte` → `../input/FileMenu.svelte` (same note)

**Step 3: Delete empty features/ directory**

```bash
# Verify features/ is empty
ls src/lib/frontend/components/features/
# If empty, git will remove it automatically. If not, check for remaining files.
rmdir src/lib/frontend/components/features/
```

**Step 4: Update stories titles**

Change title prefixes from `"Features/"` to their new directory names.

**Step 5: Verify**

```bash
pnpm check && pnpm lint
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move remaining feature components, delete features/"
```

---

### Task 9: Move InputArea from layout/ to input/

**Files to move:**
- `components/layout/InputArea.svelte` → `components/input/InputArea.svelte`
- `components/layout/InputArea.stories.ts` → `components/input/InputArea.stories.ts`

**Step 1: Move files**

```bash
cd src/lib/frontend/components
git mv layout/InputArea.svelte input/
git mv layout/InputArea.stories.ts input/
```

**Step 2: Update imports in InputArea itself**

InputArea's internal imports will change because its position relative to other components changed:
- `../shared/Icon.svelte` → `../shared/Icon.svelte` (same depth, no change)
- `../features/AgentSelector.svelte` → was already changed in Task 6 to `../model/AgentSelector.svelte`, now becomes `../model/AgentSelector.svelte` (same depth from input/ as from layout/)
- `../features/CommandMenu.svelte` → was changed in Task 8, now becomes `./CommandMenu.svelte` (same directory!)
- `../features/FileMenu.svelte` → was changed in Task 8, now becomes `./FileMenu.svelte` (same directory!)
- `../features/ModelSelector.svelte` → was changed in Task 6, now becomes `../model/ModelSelector.svelte` (same depth)
- `../chat/SubagentBackBar.svelte` → `../chat/SubagentBackBar.svelte` (same depth, no change)
- Store imports (`../../stores/...`) → `../../stores/...` (same depth, no change)
- Utils imports (`../../utils/...`) → `../../utils/...` (same depth, no change)

**Step 3: Update external imports of InputArea**

- `components/layout/ChatLayout.svelte:10` — change `./InputArea.svelte` → `../input/InputArea.svelte`
- `test/unit/components/chat-layout-ws.test.ts:32` — update mock path from `layout/InputArea.svelte` → `input/InputArea.svelte`

**Step 4: Update stories**

In `input/InputArea.stories.ts` — change title from `"Layout/InputArea"` to `"Input/InputArea"`
Note: The visual test `mockup-fidelity.spec.ts` references storyIds like `"layout-inputarea--empty"` — these will change to `"input-inputarea--empty"`. Update those storyIds.

**Step 5: Verify**

```bash
pnpm check && pnpm lint
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: move InputArea from layout/ to input/"
```

---

## Phase 2: Component Extractions

### Task 10: Extract ModelVariant from ModelSelector

**Create:** `components/model/ModelVariant.svelte`

**IMPORTANT — Dropdown coordination:** ModelSelector currently has mutual exclusion between the model dropdown and variant dropdown (`toggleDropdown` closes `variantDropdownOpen` and vice versa, `handleOutsideClick` closes both, Escape prioritizes closing variant first). To preserve this behavior, ModelVariant receives callback props from ModelSelector.

**Step 1: Create ModelVariant.svelte**

Extract from `ModelSelector.svelte`:
- The variant-related state: `variantDropdownOpen`
- The variant-related derived: `variants`, `currentVariant`, `variantLabel`
- The variant handlers: `toggleVariantDropdown`, `selectVariant`, `cycleVariant`
- The Ctrl+T keyboard shortcut (separate `$effect` for keydown)
- The template from the `{#if variants.length > 0}` block (lines 211-268)

Props interface:
```typescript
let { onOpen }: { onOpen?: () => void } = $props();
```

When the variant dropdown opens (`toggleVariantDropdown`), call `onOpen?.()` so the parent can close its model dropdown.

The component reads directly from the discovery store. It imports `wsSend` to send `switch_variant` messages.

It manages its own outside-click handler for the variant dropdown.

**Step 2: Update ModelSelector.svelte**

- Remove all variant-related state, derived values, and handlers
- Remove the variant template block
- Import and render `<ModelVariant onOpen={() => { dropdownOpen = false }} />` as a sibling after the model button
- Keep `handleOutsideClick` for the model dropdown only (remove `variantDropdownOpen` references)
- In `toggleDropdown`, remove the `variantDropdownOpen = false` line (ModelVariant manages its own state)

**Step 3: Create ModelVariant.stories.ts**

Basic story that renders the variant badge.

**Step 4: Verify**

```bash
pnpm check && pnpm lint
```

**Step 5: Commit**

```bash
git add -A && git commit -m "refactor: extract ModelVariant from ModelSelector"
```

---

### Task 11: Extract ToolItem sub-components

**Create:**
- `components/chat/ToolQuestionCard.svelte`
- `components/chat/ToolSubagentCard.svelte`
- `components/chat/ToolGenericCard.svelte`

**Step 1: Create ToolQuestionCard.svelte**

Extract from `ToolItem.svelte`:
- All question detection logic (lines 47-176): `isQuestion`, `questionDataFromInput`, `pendingQuestionRequest`, `isQuestionActive`, `questionRequest`, `isSyntheticQuestion`, `isDeferredQuestion`, `questionData`, `questionAnswer`
- The shared tool status derived values: `statusIconName`, `statusIconClass`, `subtitleText`
- The question template section (lines 330-422)
- The `QuestionCard` import (from `./QuestionCard.svelte` since it was moved to chat/ in Task 7)
- Requires imports: `Icon` from `../shared/Icon.svelte`, `BlockGrid` from `../shared/BlockGrid.svelte`, `QuestionCard` from `./QuestionCard.svelte`, `permissionsState` from `../../stores/permissions.svelte.js`
- Props: `{ message: ToolMessage, groupRadius: string }`
- Must export `isDeferredQuestion` as a derived prop so the parent dispatcher can check it without duplicating 100 lines of question-detection logic. Use `export const isDeferredQuestion = $derived(...)` or pass it via a bindable prop.

**Step 2: Create ToolSubagentCard.svelte**

Extract from `ToolItem.svelte`:
- All subagent detection logic (lines 177-233): `isSubagent`, `taskInput`, `subagentSessionId`, `agentLabel`, `agentDescription`, `navigateToSubagent`
- Shared derived: `statusIconName`, `statusIconClass`, `subtitleText`
- The subagent template section (lines 423-480)
- Requires imports: `Icon` from `../shared/Icon.svelte`, `BlockGrid` from `../shared/BlockGrid.svelte`, `wsSend` from `../../stores/ws.svelte.js`
- Props: `{ message: ToolMessage, groupRadius: string }`

**Step 3: Create ToolGenericCard.svelte**

Extract from `ToolItem.svelte`:
- The remaining generic tool logic (lines 235-313): status derived, `toolSummary`, `bashCommand`, `descText`, `handleToggle`, `requestFullContent`, `formatKB`
- The generic tool template section (lines 481-562)
- Requires imports: `Icon` from `../shared/Icon.svelte`, `BlockGrid` from `../shared/BlockGrid.svelte`, `wsSend` from `../../stores/ws.svelte.js`, `extractToolSummary` from `../../utils/group-tools.js`, `TOOL_CONTENT_LOAD_TIMEOUT_MS` from `../../ui-constants.js`
- Must include state: `expanded`, `loadingFullContent`, `loadingTimeout`
- Must include derived: `resultErrorClass`
- Props: `{ message: ToolMessage, groupRadius: string }`

**Step 4: Slim down ToolItem.svelte to dispatcher**

ToolItem becomes a thin wrapper (~80 lines):
- Keeps: `message` prop, `isFirstInGroup`/`isLastInGroup`, `groupRadius`/`isStandalone` computed
- Keeps the outer `<div class="tool-item" ...>` wrapper with its conditional classes and `data-tool-id`
- For question detection: Use `bind:this` on ToolQuestionCard and read its exported `isDeferredQuestion` value, OR compute `isQuestion` and `isDeferredQuestion` minimally in the dispatcher (just check `message.name === "AskUserQuestion"` + status check) and pass to ToolQuestionCard
- Detects `isQuestion`/`isSubagent` and delegates to the right sub-component

**Step 5: Verify**

```bash
pnpm check && pnpm lint
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extract ToolItem into question/subagent/generic sub-components"
```

---

### Task 12: Extract InputArea sub-components

**Create:**
- `components/input/AttachMenu.svelte`
- `components/input/ContextBar.svelte`
- `components/input/input-utils.ts`

**Step 1: Create input-utils.ts**

Extract from `InputArea.svelte`:
- `fetchFileContent()` function (lines 318-341)
- `fetchDirectoryListing()` function (lines 343-366)
- Import `wsSend` from `../../stores/ws.svelte.js`, `onFileBrowser` from `../../stores/ws-listeners.js`, and `formatFileSize` from `../../utils/format.js` within this file

**Step 2: Create AttachMenu.svelte**

Extract from `InputArea.svelte`:
- Props: `{ open: boolean, onToggle: () => void, onCamera: () => void, onPhotos: () => void }`
- Import `Icon` from `../shared/Icon.svelte`
- The `#attach-wrap` div, attach button, and menu template (lines 496-532) — the `#attach-wrap` ID must be INSIDE this component, wrapping both the button and menu
- Outside-click: The parent InputArea's `handleDocumentClick` checks `#attach-wrap` — since AttachMenu contains that ID, the parent handler still works. Alternatively, move the outside-click logic into AttachMenu and have it call `onToggle()` to close.

**Step 3: Create ContextBar.svelte**

Extract from `InputArea.svelte`:
- Props: `{ percent: number }`
- Derive `contextFillColor` locally from the `percent` prop (not from `uiState`):
  ```typescript
  const contextFillColor = $derived.by(() => {
    if (percent >= 80) return "bg-brand-a";
    if (percent >= 50) return "bg-warning";
    return "bg-brand-b";
  });
  ```
- The context bar template (lines 444-465)

**Step 4: Update InputArea.svelte**

- Import and use `fetchFileContent`, `fetchDirectoryListing` from `./input-utils.ts`
- Import and render `<AttachMenu>` and `<ContextBar>` replacing inline markup
- Remove the extracted code sections

**Step 5: Verify**

```bash
pnpm check && pnpm lint
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extract AttachMenu, ContextBar, input-utils from InputArea"
```

---

### Task 13: Extract TodoOverlay sub-components

**Create:**
- `components/todo/TodoHeader.svelte`
- `components/todo/TodoProgressBar.svelte`
- `components/todo/TodoItemRow.svelte` (named TodoItemRow to avoid conflict with the TodoItem type)

**Step 1: Create TodoHeader.svelte**

Props: `{ completed: number, total: number, collapsed: boolean, onToggle: () => void }`
Template: the header div (lines 120-139) with "Tasks" label, count, and chevron.
Include `handleHeaderKeydown` — it calls `onToggle()` on Enter/Space.

**Step 2: Create TodoProgressBar.svelte**

Props: `{ percentage: number }`
Template: the progress bar track + fill (lines 142-149).

**Step 3: Create TodoItemRow.svelte**

Props: `{ item: TodoItem }`
Template: a single todo item row (lines 156-188) with status icon and description.
Move `getStatusIconClass()` here.

**Step 4: Update TodoOverlay.svelte**

Import and compose the three sub-components, removing the inline markup.

**Step 5: Verify**

```bash
pnpm check && pnpm lint
```

**Step 6: Commit**

```bash
git add -A && git commit -m "refactor: extract TodoHeader, TodoProgressBar, TodoItemRow from TodoOverlay"
```

---

## Phase 3: Shared Composable

### Task 14: Create use-click-outside action

**Create:** `components/shared/use-click-outside.svelte.ts`

**Step 1: Create the action**

```typescript
/**
 * Svelte action that calls `callback` when a click lands outside the element.
 * Usage: <div use:clickOutside={() => (open = false)}>
 */
export function clickOutside(node: HTMLElement, callback: () => void) {
	function handleClick(e: MouseEvent) {
		if (!node.contains(e.target as Node)) {
			callback();
		}
	}

	document.addEventListener("click", handleClick, true);

	return {
		update(newCallback: () => void) {
			callback = newCallback;
		},
		destroy() {
			document.removeEventListener("click", handleClick, true);
		},
	};
}
```

**Step 2: Verify**

```bash
pnpm check && pnpm lint
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add clickOutside Svelte action"
```

---

### Task 15: Apply clickOutside to components

Apply the `clickOutside` action to replace manual outside-click handling in applicable components.

**IMPORTANT — Exclusions:**
- **AgentSelector** — uses a `document.body` portal for its dropdown. `node.contains()` won't detect clicks in the portal, so `clickOutside` would immediately close the dropdown. **Skip AgentSelector.**

**Components to update:**
- `components/model/ModelSelector.svelte` — replace `handleOutsideClick`. Note: callback must close `dropdownOpen` only (variant dropdown is now in ModelVariant per Task 10)
- `components/project/ProjectSwitcher.svelte` — replace outside-click logic. Note: callback must also reset `showAddForm` and `addError` state, not just `open`
- `components/input/AttachMenu.svelte` — replace outside-click logic (if extracted in Task 12)
- `components/overlays/ThemePicker.svelte` — replace outside-click logic

For each: remove the manual `document.addEventListener("click", ...)` and `handleOutsideClick` function, replace with `use:clickOutside` on the dropdown wrapper element.

**Step 1: Update each component one by one**

Pattern for each (customize the callback per component):
```svelte
<div use:clickOutside={() => { dropdownOpen = false; /* + any other state resets */ }}>
  <!-- dropdown content -->
</div>
```

**Step 2: Verify after each**

```bash
pnpm check && pnpm lint
```

**Step 3: Commit**

```bash
git add -A && git commit -m "refactor: use clickOutside action in dropdown components"
```

---

## Phase 4: Final Cleanup

### Task 16: Update visual test storyIds and references

**Files:**
- `test/visual/mockup-fidelity.spec.ts`
- `test/visual/components.spec.ts` (if it exists)

Update storyIds that changed due to component moves. Story IDs are derived from story titles by lowercasing and hyphenating: `"Features/SessionList"` → `features-sessionlist`, `"Session/SessionList"` → `session-sessionlist`.

**Specific storyId changes:**
- `"layout-inputarea--*"` → `"input-inputarea--*"` (InputArea moved from Layout to Input)
- `"features-sessionlist--*"` → `"session-sessionlist--*"`
- `"features-sessionitem--*"` → `"session-sessionitem--*"`
- `"features-terminalpanel--*"` → `"terminal-terminalpanel--*"`
- `"features-filetreenode--*"` → `"file-filetreenode--*"`
- `"features-permissioncard--*"` → `"permissions-permissioncard--*"`
- `"features-modelselector--*"` → `"model-modelselector--*"`
- `"features-agentselector--*"` → `"model-agentselector--*"`
- `"features-questioncard--*"` → `"chat-questioncard--*"`
- `"features-diffview--*"` → `"chat-diffview--*"`
- `"features-pastepreview--*"` → `"chat-pastepreview--*"`
- `"features-planmode--*"` → `"chat-planmode--*"`
- `"features-todooverlay--*"` → `"todo-todooverlay--*"`
- `"features-projectswitcher--*"` → `"project-projectswitcher--*"`
- `"features-commandmenu--*"` → `"input-commandmenu--*"`
- `"features-filemenu--*"` → `"input-filemenu--*"`

Also check `SKIP_STORIES` arrays in `components.spec.ts` for hardcoded `features-*` storyIds that need updating.

Also check for fragment HTML files loaded by storyId name (in `test/visual/fragments/`) — these may need regenerating after the renames.

**Step 1: Update storyIds**

Grep for all storyId references across test files and update to match new Storybook titles. Use ripgrep: `rg "features-|layout-inputarea" test/`

**Step 2: Verify**

```bash
pnpm check && pnpm lint
```

**Step 3: Commit**

```bash
git add -A && git commit -m "fix: update visual test storyIds for moved components"
```

---

### Task 17: Final verification

**Step 1: Full verification**

```bash
pnpm check && pnpm lint && pnpm test:unit
```

The pre-existing ci.test.ts failure (lefthook prepare script) is expected and unrelated.

**Step 2: Verify no remaining features/ references**

```bash
# Check source files
grep -r "features/" src/lib/frontend/ --include="*.svelte" --include="*.ts" | grep -v node_modules
# Also check test files
grep -r "features/" test/ --include="*.ts" | grep -v node_modules
```

Both should return zero results.

**Step 3: Commit design doc**

```bash
git add docs/plans/2026-03-23-component-refactor-design.md docs/plans/2026-03-23-component-refactor-plan.md
git commit -m "docs: add component refactor design and plan"
```
