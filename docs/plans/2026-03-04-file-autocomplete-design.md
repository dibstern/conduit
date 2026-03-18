# File Autocomplete (`@` Mention) Design

## Overview

Add an `@` file autocomplete picker to the chat input. When the user types `@` (at start of input or after whitespace), a popup appears showing project files. Selecting a file inserts `@path/to/file` into the text and attaches the file's content to the message when sent. Directories attach a listing instead of content.

## Decisions

- **Approach**: New `FileMenu.svelte` component parallel to `CommandMenu` (not a generic abstraction)
- **Trigger**: Mid-text, cursor-position-aware `@` detection
- **Data**: Background-preloaded flat file tree, client-side fuzzy filtering
- **Selection**: Inserts `@path` into input text AND attaches file content on send
- **Multiple references**: Supported (e.g., "Compare @src/old.ts and @src/new.ts")
- **Directories**: Attach directory listing, not contents of files inside

## Architecture

### Data Flow

```
ChatLayout (onConnect) → wsSend({ type: "get_file_tree" })
                            ↓
Server recursively walks project via listDirectory()
                            ↓
Server → Client: { type: "file_tree", entries: ["src/index.ts", "src/lib/", ...] }
                            ↓
file-tree.svelte.ts store populates fileTreeState.entries
                            ↓
User types "@src/ut" → extractAtQuery() → "src/ut"
                            ↓
filterFiles("src/ut") → client-side fuzzy match → top 20 results
                            ↓
FileMenu.svelte renders popup with results
                            ↓
User selects → InputArea replaces @query with @full/path
                            ↓
On send → parse all @references → fetch file contents → prepend to message
```

### New Files

| File | Purpose |
|------|---------|
| `src/lib/public/stores/file-tree.svelte.ts` | File tree state, fuzzy filter, @ query extraction |
| `src/lib/public/components/features/FileMenu.svelte` | Popup component |
| `src/lib/public/components/features/FileMenu.stories.ts` | Storybook story |
| `test/unit/file-tree-store.test.ts` | Unit tests for filtering |
| `test/unit/at-query-extraction.test.ts` | Unit tests for @ detection |

### Modified Files

| File | Change |
|------|--------|
| `src/lib/shared-types.ts` | Add `file_tree` to `RelayMessage` |
| `src/lib/handlers/files.ts` | Add `handleGetFileTree` handler |
| `src/lib/handlers/index.ts` | Wire up `get_file_tree` in dispatch table |
| `src/lib/public/stores/ws.svelte.ts` | Route `file_tree` message to store |
| `src/lib/public/components/layout/ChatLayout.svelte` | Send `get_file_tree` on connect |
| `src/lib/public/components/layout/InputArea.svelte` | Add @ trigger, FileMenu, ref tracking, async send |
| `src/lib/public/components/chat/UserMessage.svelte` | Apply `extractDisplayText()` to strip XML wrapper |
| `src/lib/public/utils/history-logic.ts` | Apply `extractDisplayText()` for REST API fallback path |

## Component Design

### `FileMenu.svelte`

Props: `query`, `visible`, `entries` (filtered), `onSelect`, `onClose`, `loading`.

Mirrors `CommandMenu` patterns:
- Absolute positioning above input (`bottom-full`)
- Keyboard nav via exported `handleKeydown()` method (ArrowUp/Down, Tab/Enter, Escape)
- Max 300px height, overflow scroll, max 20 items
- File/folder Lucide icons, path with dimmed directory portion
- Loading and empty states

### `InputArea.svelte` Changes

- Track cursor position via `oninput`/`onkeyup`
- `$derived` expressions for `fileMenuVisible` and `fileQuery` using `extractAtQuery()`
- `CommandMenu` takes priority over `FileMenu` (only one visible at a time)
- `handleFileSelect(path)`: replaces `@query` with `@path ` at cursor position
- `sendMessage()` becomes async: parses `@references`, fetches file contents, prepends context

### `file-tree.svelte.ts` Store

State: `entries: string[]`, `loading: boolean`, `loaded: boolean`

Pure functions:
- `extractAtQuery(text, cursorPos)` — returns `{ query: string, start: number, end: number } | null`
- `filterFiles(entries, query)` — case-insensitive substring match, basename bonus, top 20, sorted

Message handler: `handleFileTree(msg)` — populates `fileTreeState.entries`

### Server Handler

`handleGetFileTree` recursively calls `deps.client.listDirectory()` breadth-first, building flat path list. Directories have trailing `/`. Respects OpenCode's gitignore filtering.

## Display vs. Send Separation

**Problem**: Both the message cache (JSONL replay) and OpenCode's REST API store and return the exact text we send. If we send XML-wrapped text, that XML comes back verbatim when loading a past session.

**Solution**: Strip XML at render time. The full XML is always what gets stored and sent to the LLM. At display time, a pure function extracts just the user's original message.

### Send path

- `addUserMessage(expandedText)` — the full XML-wrapped text (same as what's sent to server, so cache replay works consistently)
- `wsSend({ type: "message", text: expandedText })` — XML-structured expanded text (what the LLM receives)

### Render path

A utility function `extractDisplayText(text)` is applied at render time:

```ts
function extractDisplayText(text: string): string {
  const match = text.match(/<user-message>\n?([\s\S]*?)\n?<\/user-message>/);
  return match ? match[1] : text;
}
```

Applied in:
- `UserMessage.svelte` — for live chat rendering
- `historyToChatMessages()` in `history-logic.ts` — for REST API fallback rendering

**Backward compatible**: Messages without XML wrapper pass through unchanged. No protocol or storage changes needed.

## Message Format (Server Payload)

When sending with `@` references, the server payload uses XML structure:

```xml
<attached-files>
<file path="src/utils/auth.ts">
...file content...
</file>
</attached-files>

<user-message>
Explain the logic in @src/utils/auth.ts
</user-message>
```

For directories:

```xml
<attached-files>
<directory path="src/utils/">
auth.ts (1.2KB, file)
session.ts (3.4KB, file)
helpers/ (directory)
</directory>
</attached-files>

<user-message>
List the files in @src/utils/
</user-message>
```

Multiple references:

```xml
<attached-files>
<file path="src/old.ts">
...content...
</file>
<file path="src/new.ts">
...content...
</file>
</attached-files>

<user-message>
Compare @src/old.ts and @src/new.ts
</user-message>
```

## Edge Cases

- File tree not loaded yet when user types `@`: show "Loading files..." in popup
- File content fetch fails on send: show toast error, don't send message
- Very large files: truncate content with a note (reuse existing file content handler limits)
- Binary files: skip content attachment, note `<file path="..." binary="true" />`
- User deletes `@path` text after selection: reference is removed (re-parsed on send)
- Messages without `@` references: sent as plain text (no XML wrapping)
