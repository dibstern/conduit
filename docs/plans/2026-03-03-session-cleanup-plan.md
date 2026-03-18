# Session Cleanup Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a multi-select cleanup mode to the sidebar session list for bulk-deleting sessions.

**Architecture:** Inline overlay mode — the session list transforms in-place when cleanup is activated. New local state in `SessionList.svelte` (`cleanupMode`, `selectedForDeletion` Set) drives conditional rendering in both `SessionList` and `SessionItem`. The sticky delete bar counter updates reactively via `$derived` from `selectedForDeletion.size`. All backend infrastructure (delete_session WS message, confirm modal) is already in place.

**Tech Stack:** Svelte 5, Tailwind CSS v4, Lucide icons via `Icon.svelte`

---

### Task 1: Add cleanup mode state and entry button to SessionList

**Files:**
- Modify: `src/lib/public/components/features/SessionList.svelte`

**Step 1: Add cleanup state variables**

After the existing "Rename state" comment block (line 33), add:

```svelte
// Cleanup mode state
let cleanupMode = $state(false);
let selectedForDeletion = $state<Set<string>>(new Set());
```

**Step 2: Add derived values for selection**

After the existing `emptyMessage` derived (line 43), add:

```svelte
const selectionCount = $derived(selectedForDeletion.size);
const allSelected = $derived(
  filtered.length > 0 && filtered.every((s) => selectedForDeletion.has(s.id)),
);
```

**Step 3: Add handler functions**

After `handleCtxFork` (line 132), add:

```typescript
function handleEnterCleanup() {
  cleanupMode = true;
  selectedForDeletion = new Set();
  // Close search if open
  if (searchVisible) {
    searchVisible = false;
    localSearchValue = "";
    setSearchQuery("");
  }
}

function handleExitCleanup() {
  cleanupMode = false;
  selectedForDeletion = new Set();
}

function handleToggleSelection(id: string) {
  const next = new Set(selectedForDeletion);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  selectedForDeletion = next;
}

function handleToggleSelectAll() {
  if (allSelected) {
    selectedForDeletion = new Set();
  } else {
    selectedForDeletion = new Set(filtered.map((s) => s.id));
  }
}

async function handleBulkDelete() {
  const count = selectionCount;
  const label = count === 1 ? "1 session" : `${count} sessions`;
  const confirmed = await confirm(
    `Delete ${label}? These sessions and their history will be permanently removed.`,
    "Delete",
  );
  if (confirmed) {
    for (const id of selectedForDeletion) {
      wsSend({ type: "delete_session", sessionId: id });
    }
    cleanupMode = false;
    selectedForDeletion = new Set();
  }
}
```

**Step 4: Add cleanup button to header**

Replace the session list header div (lines 147-168) with conditional rendering:

```svelte
<!-- Session list header -->
{#if cleanupMode}
  <div class="session-list-header flex items-center justify-between px-2 py-1">
    <button
      type="button"
      class="flex items-center gap-1.5 border-none bg-transparent text-[11px] font-semibold text-text-dimmer cursor-pointer p-0 hover:text-text transition-colors duration-100"
      onclick={handleToggleSelectAll}
    >
      <Icon name={allSelected ? "circle-check" : "circle"} size={14} />
      <span>{allSelected ? "Deselect all" : "Select all"}</span>
    </button>
    <button
      type="button"
      class="border-none bg-transparent text-[11px] font-semibold text-text-dimmer cursor-pointer p-0 hover:text-text transition-colors duration-100"
      onclick={handleExitCleanup}
    >
      Cancel
    </button>
  </div>
{:else}
  <div class="session-list-header flex items-center justify-between px-2 py-1">
    <span class="text-[11px] font-semibold uppercase tracking-[0.5px] text-text-dimmer">Sessions</span>
    <div class="session-list-header-actions flex items-center gap-0.5">
      <button
        type="button"
        title="New session"
        class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-black/[0.04] hover:text-text"
        onclick={handleNewSession}
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        id="search-session-btn"
        type="button"
        title="Search sessions"
        class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-black/[0.04] hover:text-text"
        onclick={handleToggleSearch}
      >
        <Icon name="search" size={14} />
      </button>
      <button
        type="button"
        title="Cleanup sessions"
        class="flex items-center justify-center w-6 h-6 border-none rounded-md bg-transparent text-text-dimmer cursor-pointer transition-[background,color] duration-100 p-0 hover:bg-black/[0.04] hover:text-text"
        onclick={handleEnterCleanup}
      >
        <Icon name="trash-2" size={14} />
      </button>
    </div>
  </div>
{/if}
```

**Step 5: Pass cleanup props to SessionItem**

In each of the three `{#each}` blocks (today, yesterday, older), add cleanup props to `<SessionItem>`:

```svelte
<SessionItem
  session={s}
  active={s.id === sessionState.currentId}
  renaming={s.id === renamingSessionId}
  {cleanupMode}
  selected={selectedForDeletion.has(s.id)}
  onswitchsession={handleSwitchSession}
  ontoggleselection={handleToggleSelection}
  oncontextmenu={handleContextMenu}
  onrename={handleRename}
  onrenameend={handleRenameEnd}
/>
```

**Step 6: Add sticky delete bar**

After the session groups `{/if}` (line 243) but still inside the `#session-list` div, add:

```svelte
<!-- Sticky delete bar (cleanup mode) -->
{#if cleanupMode && selectionCount > 0}
  <div class="sticky bottom-0 bg-bg-surface border-t border-border-subtle py-2 px-2">
    <button
      type="button"
      class="w-full py-1.5 px-4 rounded-lg text-[13px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 cursor-pointer transition-colors duration-100 hover:bg-red-500/20 hover:text-red-300"
      onclick={handleBulkDelete}
    >
      Delete {selectionCount === 1 ? "1 session" : `${selectionCount} sessions`}
    </button>
  </div>
{/if}
```

**Step 7: Suppress context menu during cleanup mode**

Wrap the context menu block (lines 247-257) in an additional guard:

```svelte
{#if !cleanupMode && ctxMenuSession && ctxMenuAnchor}
```

**Step 8: Verify — run the build**

Run: `npx vite build`
Expected: No errors

**Step 9: Commit**

```
feat: add cleanup mode state and entry button to SessionList
```

---

### Task 2: Add selection circle to SessionItem

**Files:**
- Modify: `src/lib/public/components/features/SessionItem.svelte`

**Step 1: Add new props**

Extend the props destructuring (lines 14-30) to include:

```typescript
let {
  session,
  active = false,
  renaming: renamingProp = false,
  cleanupMode = false,
  selected = false,
  onswitchsession,
  ontoggleselection,
  oncontextmenu: oncontextmenuProp,
  onrename,
  onrenameend,
}: {
  session: SessionInfo;
  active?: boolean;
  renaming?: boolean;
  cleanupMode?: boolean;
  selected?: boolean;
  onswitchsession?: (id: string) => void;
  ontoggleselection?: (id: string) => void;
  oncontextmenu?: (session: SessionInfo, anchor: HTMLElement) => void;
  onrename?: (id: string, title: string) => void;
  onrenameend?: () => void;
} = $props();
```

**Step 2: Add selection toggle handler**

After `handleMoreClick` (line 91), add:

```typescript
function handleSelectionToggle(e: MouseEvent) {
  e.stopPropagation();
  ontoggleselection?.(session.id);
}
```

**Step 3: Add selection circle to template**

After the opening `<div>` tag (line 148), before the processing indicator, add:

```svelte
<!-- Selection circle (cleanup mode) -->
{#if cleanupMode}
  <button
    type="button"
    class="shrink-0 w-6 h-6 border-none rounded p-0 bg-transparent cursor-pointer flex items-center justify-center transition-colors duration-100 {active ? (selected ? 'text-white' : 'text-white/40') : (selected ? 'text-accent' : 'text-text-dimmer')}"
    onclick={handleSelectionToggle}
  >
    <Icon name={selected ? "circle-check" : "circle"} size={16} />
  </button>
{/if}
```

**Step 4: Hide three-dot more button during cleanup mode**

Change the more button guard (line 197) from:

```svelte
{#if !isRenaming}
```

to:

```svelte
{#if !isRenaming && !cleanupMode}
```

**Step 5: Verify — run the build**

Run: `npx vite build`
Expected: No errors

**Step 6: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests pass (no store changes were made)

**Step 7: Commit**

```
feat: add selection circle to SessionItem for cleanup mode
```

---

### Task 3: Manual testing checklist

After both tasks are implemented, verify the following manually:

1. **Entry:** Trash icon appears in session list header. Clicking it enters cleanup mode.
2. **Header swap:** Normal header (Sessions / + / search / trash) swaps to (Select all / Cancel).
3. **Selection circles:** Each session shows an empty circle on its left edge.
4. **Toggle selection:** Clicking a circle fills it. Clicking again empties it.
5. **Row click still navigates:** Clicking the session title/row (not the circle) switches to that session.
6. **Counter updates:** Delete bar shows "Delete 1 session", "Delete 2 sessions", etc., updating live as circles are toggled.
7. **Select all / Deselect all:** Toggle works correctly. Label updates.
8. **Delete bar visibility:** Hidden when 0 selected, visible when >= 1 selected.
9. **Confirm dialog:** Clicking delete bar button shows confirm modal with correct count.
10. **Bulk delete:** After confirming, sessions are deleted and cleanup mode exits.
11. **Cancel:** Clicking Cancel clears selection and exits cleanup mode.
12. **Active session styling:** Selection circle is white on the dark active session row.
13. **Mobile:** Touch targets are comfortable, sticky bar works.
