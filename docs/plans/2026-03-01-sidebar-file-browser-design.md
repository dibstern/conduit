# Design: Sidebar File Browser (Ticket 10.2)

**Date**: 2026-03-01
**Status**: Approved
**Ticket**: `plans/tickets/10.2-sidebar-file-browser.md`

## Problem

The file browser currently renders as a floating right-side overlay (`fixed right-0`, 380px wide with backdrop) that blocks the chat area and feels disconnected from sidebar navigation. The sidebar already has a vestigial `sidebarPanel: "sessions" | "files"` state in `ui.svelte.ts` that was never wired up.

## Decision

**Approach B: Extract SidebarFilePanel as a separate component.** The sidebar is already 227 lines; adding file tree logic inline would push it past 350. A dedicated `SidebarFilePanel.svelte` keeps concerns separated and is independently testable.

## Architecture

### State Changes (`ui.svelte.ts`)

- Wire up existing `sidebarPanel` state to drive panel visibility
- `setSidebarPanel("files")` replaces `openFileBrowser()` as the trigger
- Remove `fileBrowserOpen`, `openFileBrowser()`, `closeFileBrowser()`
- Switching to `"files"` triggers initial directory load via WS

### New Component: `SidebarFilePanel.svelte`

- Location: `src/lib/public/components/features/`
- Outer wrapper: `id="sidebar-panel-files"` (matches E2E page object)
- Contains: back button (`#file-panel-back`), breadcrumbs, file tree (`#file-tree`)
- Owns WS subscription for `file_list`/`file_content`/`file_changed` (moved from `FileBrowser.svelte`)
- Loads root directory on mount, handles lazy child loading
- File clicks open FileViewer split pane; sidebar stays on files panel

### Sidebar.svelte Changes

- Import `SidebarFilePanel`
- Read `uiState.sidebarPanel`
- Conditional render: `"sessions"` → sessions panel, `"files"` → `<SidebarFilePanel />`
- "File browser" button calls `setSidebarPanel("files")`
- Mobile: panel switching in-place within slide-over

### Deletions

- `FileBrowser.svelte` — entire file
- `fileBrowserOpen`, `openFileBrowser()`, `closeFileBrowser()` from `ui.svelte.ts`
- `<FileBrowser>` render from `ChatLayout.svelte` (line 318)
- Related overlay CSS (backdrop, fixed positioning)

### Unchanged

- `FileTreeNode.svelte` — reused as-is
- `FileViewer.svelte` — reused as-is

## Data Flow

```
User clicks "File browser" → setSidebarPanel("files")
  → uiState.sidebarPanel = "files"
  → Sidebar renders <SidebarFilePanel />
  → SidebarFilePanel mounts → WS listFiles request
  → WS returns file_list → tree renders via FileTreeNode
  → User clicks file → WS readFile → FileViewer opens in main area
  → User clicks "Back" → setSidebarPanel("sessions") → sessions panel returns
```

## Mobile Behavior

On viewports < 768px, the sidebar is a slide-over. Panel switching happens within the slide-over — tapping "File browser" replaces the session list without closing the slide-over. The back button returns to sessions in-place.

## Testing

- **Unit**: `sidebarPanel` state transitions, removal of `fileBrowserOpen`
- **E2E**: Scaffolded page objects expect `#sidebar-panel-files`, `#file-panel-back`, `#file-tree`
- **Storybook**: Existing `FileBrowserPanel` story sets `sidebarPanel = "files"` — will now render the actual panel

## Acceptance Criteria Mapping

| AC | How Addressed |
|----|---------------|
| AC1: Panel switching | `sidebarPanel` drives conditional render in Sidebar |
| AC2: Back button | `#file-panel-back` calls `setSidebarPanel("sessions")` |
| AC3: Inline file tree | `SidebarFilePanel` renders `FileTreeNode` with breadcrumbs |
| AC4: FileViewer on click | File click opens FileViewer, sidebar stays on files |
| AC5: Mobile switching | Panel swap in-place within slide-over |
| AC6: Wire up vestigial state | `sidebarPanel` state now drives all panel transitions |
| AC7: Remove overlay | Delete `FileBrowser.svelte`, overlay markup, `ChatLayout` render |
