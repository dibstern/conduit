# Design: Hide Subagent Sessions Toggle

**Date:** 2026-03-06  
**Status:** Approved

## Problem

Subagent sessions (sessions with a `parentID`) currently appear in the session list alongside top-level sessions. This clutters the sidebar when the AI spawns many tool-based subagents. The filter should be user-controllable and survive page reloads.

## Background

`getFilteredSessions()` in `session.svelte.ts` already unconditionally filters out sessions where `parentID` is set. The goal is to make this filter toggleable with a persistent preference.

## Design

### State

Add `hideSubagentSessions: boolean` to `uiState` in `src/lib/public/stores/ui.svelte.ts`:

- Persisted via `localStorage` under the key `"hide-subagent-sessions"`
- Default: `true` (subagent sessions hidden by default)
- Action: `toggleHideSubagentSessions()` flips the value and writes to localStorage

### Filtering

`getFilteredSessions()` in `src/lib/public/stores/session.svelte.ts` changes from always filtering `parentID` sessions to checking `uiState.hideSubagentSessions`. When the flag is `false`, sessions with a `parentID` pass through (still subject to the search query filter).

### UI

`SessionList.svelte` gets a small icon-button in its header toolbar (alongside the existing search toggle button). The button uses an appropriate icon (e.g. `git-branch` or `bot`):

- When `hideSubagentSessions` is `true` (default): icon is muted/inactive, tooltip "Show subagent sessions"
- When `hideSubagentSessions` is `false`: icon is active/accent-coloured, tooltip "Hide subagent sessions"

Clicking calls `toggleHideSubagentSessions()`.

## Files Changed

| File | Change |
|---|---|
| `src/lib/public/stores/ui.svelte.ts` | Add `hideSubagentSessions` state + `toggleHideSubagentSessions()` action |
| `src/lib/public/stores/session.svelte.ts` | Make `getFilteredSessions()` conditional on `uiState.hideSubagentSessions` |
| `src/lib/public/components/features/SessionList.svelte` | Add toggle button to header toolbar |

## Non-Goals

- No server-side change needed
- No Settings panel tab (can be added later)
- Does not change fork-vs-subagent distinction (both are identified by `parentID`)
