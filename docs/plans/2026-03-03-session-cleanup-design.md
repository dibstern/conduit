# Session List Cleanup Mode

## Overview

Add a multi-select cleanup mode to the session list sidebar, allowing users to select multiple sessions and delete them in bulk.

## Approach

**Inline Overlay Mode** — the session list transforms in-place when cleanup mode is activated. Each session item gains a selection circle; the header swaps to show select-all and cancel controls; a sticky delete bar appears at the bottom when sessions are selected.

## State Model

All state lives in `SessionList.svelte` — no new stores.

- `cleanupMode: boolean` — whether multi-select cleanup mode is active
- `selectedForDeletion: Set<string>` — session IDs marked for deletion
- `selectionCount` (derived) — `selectedForDeletion.size`, drives the delete bar counter
- `allSelected` (derived) — whether every visible session is selected, drives select-all toggle

### Mode transitions

- **Enter:** Click cleanup button (trash-2 icon in header) → `cleanupMode = true`, fresh empty Set
- **Exit:** Click Cancel, or after confirmed deletion → `cleanupMode = false`, Set cleared
- Stale IDs in the Set (from externally deleted sessions) are harmless

## Visual Design

### Entry Point

New `trash-2` icon button in session list header, matching existing button style:
`w-6 h-6 rounded-md bg-transparent text-text-dimmer hover:bg-black/[0.04] hover:text-text`

### Header (cleanup mode)

Swaps from `[ Sessions  [+] [search] [trash] ]` to `[ [o] Select all  [Cancel] ]`:

- **Select all toggle:** `circle` icon (partial/none) or `circle-check` (all). Click toggles all/none. Label: "Select all" / "Deselect all"
- **Cancel:** Text button, `text-text-dimmer hover:text-text`, exits cleanup mode

### Session Item — Selection Circle

- Rendered on **left edge**, before the title, only when `cleanupMode` is true
- **Unselected:** `circle` icon, `text-text-dimmer`, 16px
- **Selected:** `circle-check` icon, `text-accent` (or `text-white` on active dark-bg items)
- Touch target: `w-6 h-6` button with `e.stopPropagation()` so row click still navigates
- Three-dot more button hidden during cleanup mode
- `transition-colors duration-100` on the circle

### Sticky Delete Bar

Appears when `selectionCount > 0`, hidden otherwise. Pinned to bottom of `#session-list`:

- Container: `sticky bottom-0 bg-bg-surface border-t border-border-subtle py-2 px-2`
- Button: `w-full py-1.5 px-4 rounded-lg text-[13px] font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 hover:text-red-300`
- Text: `Delete 1 session` / `Delete N sessions` (pluralized)

### Confirm Dialog

Reuses existing `confirm()` modal:
- Text: `Delete N session(s)? These sessions and their history will be permanently removed.`
- Action label: `Delete`

## Bulk Delete Flow

```
handleBulkDelete()
  → confirm(...)
  → if confirmed:
      for each id in selectedForDeletion:
        wsSend({ type: "delete_session", sessionId: id })
      cleanupMode = false
      selectedForDeletion = new Set()
```

Server handles each delete independently and broadcasts updated `session_list`. If active session is deleted, server switches to most recent remaining.

## Components Modified

| File | Change |
|------|--------|
| `SessionList.svelte` | New state, cleanup header, delete bar, handlers |
| `SessionItem.svelte` | New optional props (`cleanupMode`, `selected`, `ontoggleselection`), selection circle, hide more button |

No new files. No store changes. No backend changes.

## Edge Cases

- **Session list updates while in cleanup mode:** Stale IDs harmless, won't render
- **All sessions deleted:** Existing empty state renders naturally
- **Mobile:** Circle buttons are comfortable touch targets; sticky bar works on mobile viewports
- **Search during cleanup:** Search bar closes and is suppressed during cleanup mode
