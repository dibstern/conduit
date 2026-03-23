# Project Management Improvements Design

**Date:** 2026-03-23

## Overview

Two improvements to project management in conduit's web UI:

1. **Directory autocomplete** for the "+Add project" path input
2. **Context menu** (rename + delete) on project items in the switcher and dashboard

## Feature 1: Directory Autocomplete

### Backend

New WebSocket message type: `list_directories`.

**Request:** `{ type: "list_directories", path: string }`

Handler logic in `src/lib/handlers/settings.ts`:

1. Resolve `~` to home directory, normalize the path
2. Split input into `parentDir` + `prefix` (e.g., `/Users/ds` -> parent=`/Users/`, prefix=`ds`)
3. Call `fs.readdir(parentDir, { withFileTypes: true })`, filter to directories only
4. Filter entries whose name starts with `prefix` (case-insensitive)
5. Return `{ type: "directory_list", path: string, entries: string[] }` where entries are full absolute paths with trailing `/`
6. If parentDir doesn't exist or isn't readable, return empty entries
7. Cap results at 50 entries
8. Exclude hidden directories (starting with `.`) unless prefix starts with `.`

Register in `VALID_MESSAGE_TYPES`, `PayloadMap`, and `MESSAGE_HANDLERS`.

### Frontend

Drop-up popup above the input in the ProjectSwitcher add-project form.

**Trigger:** On input change, debounced ~150ms, send `list_directories` with current value.

**Display:** Show immediate child directories of the resolved parent path. If input is `/Users/`, show `dstern/`, `dave/`, etc.

**Keyboard interaction:**

- **Arrow Up/Down:** Navigate the list
- **Tab:** Accept highlighted entry into input, immediately re-trigger autocomplete for the next level (terminal-style tab-completion -- drill one level deeper)
- **Enter:** Accept highlighted entry as final path value, close dropdown
- **Escape:** Close popup without changing input

**Edge case:** If only one match on Tab, auto-complete and immediately fetch next level.

**Mouse:** Click an entry = same as Enter (select as final).

**Dismiss:** When input loses focus or list is empty.

## Feature 2: Project Context Menu

### Backend: New WebSocket Handlers

**`remove_project`**

- Payload: `{ type: "remove_project", slug: string }`
- Handler calls `deps.daemon.removeProject(slug)` (already exists)
- Broadcasts updated `project_list` to all connected clients
- Error if slug not found

**`rename_project`**

- Payload: `{ type: "rename_project", slug: string, title: string }`
- Handler calls `deps.daemon.setProjectTitle(slug, title)` (already exists via IPC)
- Broadcasts updated `project_list`
- Validation: non-empty, trimmed, max 100 chars

Register both in `VALID_MESSAGE_TYPES`, `PayloadMap`, and `MESSAGE_HANDLERS`.

### Frontend: ProjectContextMenu.svelte

Mirrors `SessionContextMenu.svelte` pattern:

- Fixed-position dropdown with backdrop overlay
- Positioned relative to anchor `...` button
- Two actions: Rename and Delete
- Dismissed on Escape, backdrop click, or action selection

### ... Button on Project Items

- Always visible on the right side of each project item
- Present in both ProjectSwitcher and DashboardPage
- Compact `MoreHorizontal` icon button
- Stops propagation to prevent navigation

### Rename Flow

1. Click `...` -> Rename in context menu
2. Project title becomes editable `<input>` inline (mirrors SessionItem pattern)
3. Enter or blur commits -> sends `rename_project` via WS
4. Escape cancels
5. Changes title only (display name). Slug/URL stays the same.
6. `project_list` broadcast updates all clients

### Delete Flow

1. Click `...` -> Delete in context menu
2. ConfirmModal: "Remove project '{title}' from conduit?"
3. "Remove" action button via existing `confirm()` API
4. On confirm -> sends `remove_project` via WS
5. `project_list` broadcast updates all clients
6. If deleted project was current, navigate to dashboard
7. Unregisters only -- project directory on disk is untouched

### Dashboard Page

Dashboard project cards also get the `...` button with the same context menu and flows. Dashboard re-fetches project list after mutations.

## Files Changed

### New files

- `src/lib/frontend/components/features/ProjectContextMenu.svelte`
- `src/lib/frontend/components/features/DirectoryAutocomplete.svelte`

### Modified files

- `src/lib/handlers/settings.ts` -- add `list_directories`, `remove_project`, `rename_project` handlers
- `src/lib/handlers/index.ts` -- register new handlers in dispatch table
- `src/lib/handlers/payloads.ts` -- add payload types
- `src/lib/server/ws-router.ts` -- add to `VALID_MESSAGE_TYPES`
- `src/lib/shared-types.ts` -- add message types to `PayloadMap`
- `src/lib/frontend/components/features/ProjectSwitcher.svelte` -- integrate autocomplete, add `...` button, rename state
- `src/lib/frontend/pages/DashboardPage.svelte` -- add `...` button and context menu
- `src/lib/frontend/stores/ws-dispatch.ts` -- route `directory_list` messages
