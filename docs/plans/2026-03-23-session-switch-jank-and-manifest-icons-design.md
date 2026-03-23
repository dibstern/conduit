# Session Switch Jank & Manifest Icon Fix — Design

## Context

Two issues surface when switching sessions:

1. **Chrome violations**: `[Violation] 'message' handler took 358ms` from `history-logic.ts:252`. The WebSocket `onmessage` handler blocks the main thread during session switches.

2. **Manifest icon errors**: `Error while trying to use the following icon from the Manifest: .../apple-touch-icon.png (Download error or resource isn't a valid image)`. The manifest's internal icon paths are broken in production builds.

### Prior Art

`docs/plans/2026-03-17-session-switch-perf.md` designed and partially implemented several session-switch optimizations. The following are **already implemented**: server-side markdown pre-rendering (C3 via `preRenderHistoryMessages`), WebSocket perMessageDeflate (S5), `chatState.replaying` guard in AssistantMessage `$effect` (C1), CSS `content-visibility:auto` (C4-css, later removed due to Safari scroll bugs).

This design addresses what remains: the synchronous `replayEvents()` loop itself and the O(n^2) array allocation pattern inside it, plus the manifest icon bug (not covered by prior plan).

---

## Fix 1: Manifest Icon Paths (Vite Plugin)

### Problem

`manifest.webmanifest` references icon paths like `/static/apple-touch-icon.png`. Vite's `publicDir: "static"` copies file *contents* to the build root, so the actual file is emitted at `dist/frontend/apple-touch-icon.png` (served at `/apple-touch-icon.png`). Vite rewrites `<link>` tags in `index.html` to hashed `/assets/` paths, but treats `.webmanifest` as an opaque asset — its internal JSON `src` values are never processed. The manifest icon URLs all 404 in production.

### Solution

A small Vite plugin in `vite.config.ts` that hooks `generateBundle`:
1. Find the emitted manifest asset (by original filename match).
2. Parse its JSON content.
3. For each icon `src`, match the basename against emitted assets and rewrite to the actual output path.
4. Update the asset source in-place.

This ensures manifest icon paths match whatever Vite does with the files (including content hashing). The source `manifest.webmanifest` keeps clean `/static/...` paths for dev readability.

### Verification

- Build with `pnpm build`
- Inspect `dist/frontend/assets/manifest-*.webmanifest` — icon `src` values should reference `/assets/apple-touch-icon-*.png` (hashed paths that exist)
- Open in browser, check no manifest icon error in console

---

## Fix 2: Replay Performance (Three Layers)

### Problem

`replayEvents()` in `ws-dispatch.ts` is a single synchronous `for` loop over every event in a session. For sessions with hundreds of events:

- **No yielding**: The entire loop blocks the main thread. Chrome flags any handler >50ms as a violation.
- **O(n^2) array copies**: Every event handler does `chatState.messages = [...chatState.messages, newItem]`, creating a new array reference per event. Over N events this copies O(N^2) total elements.
- **Synchronous markdown**: Each `handleDone` triggers `flushAssistantRender()` → `renderMarkdown()` (marked.parse + DOMPurify.sanitize) synchronously. The server pre-renders for the REST path (C3), but the events/replay path has no pre-rendered HTML — all markdown rendering is client-side.

### Layer A: Chunked Replay with Event Loop Yielding

Make `replayEvents()` async. Process events in chunks of ~50-100, yielding to the event loop between chunks via `setTimeout(0)` (or `scheduler.yield()` if available).

- `chatState.replaying` stays `true` for the entire async duration, suppressing post-render work (C1 guard).
- The `session_switched` handler awaits the async replay.
- An abort mechanism (monotonic generation counter) handles rapid session switching: if a new replay starts while one is in-flight, the in-progress replay checks its generation at each yield point and bails out.

```
replayEvents(events):
  chatState.replaying = true
  generation = ++replayGeneration
  for chunk in chunks(events, CHUNK_SIZE):
    processChunk(chunk)       // synchronous within chunk
    flush batch to chatState  // one reactive update per chunk
    await yield()             // setTimeout(0) or scheduler.yield()
    if generation !== replayGeneration: return  // aborted
  flushPendingRender()
  chatState.replaying = false
```

### Layer B: Batched Array Mutations During Replay

During replay, accumulate mutations in a local working array instead of replacing `chatState.messages` on every event:

- Before the replay loop, create a mutable `replayBatch: ChatMessage[]` initialized from `chatState.messages`.
- Event handlers detect replay mode (e.g., `replayBatch !== null`) and push/update into `replayBatch` directly — no spread, no new array per event.
- At each chunk boundary (before yielding), assign `chatState.messages = [...replayBatch]` once — a single Svelte reactive update per chunk.
- This changes O(N^2) total copies to O(N) with ~N/chunkSize reactive updates.

The module-level `replayBatch` variable acts as the signal: when non-null, handlers like `handleDelta`, `handleToolStart`, `handleDone`, etc. operate on it instead of `chatState.messages`. When null, they use the normal spread pattern (live streaming path unchanged).

### Layer C: Deferred Markdown Rendering During Replay

During replay, skip `renderMarkdown()` entirely in `flushAssistantRender()`. Store raw text on the assistant message with `html` set to raw text (unrendered fallback).

After the full replay completes and `chatState.replaying` becomes false:
1. Kick off an idle-time pass using `requestIdleCallback` (or `setTimeout` batches).
2. Iterate finalized assistant messages that lack rendered HTML.
3. Call `renderMarkdown()` on each in small batches (e.g., 5 at a time).
4. Update the messages array with the rendered HTML.

The C1 guard in `AssistantMessage.svelte` already suppresses hljs/mermaid during replay, so the raw-text fallback is visually consistent. When markdown rendering catches up, the `$effect` detects the `html` change and runs post-render.

For the user, this means: content appears immediately (raw text), then progressively enhances to rendered markdown. Since replay typically takes <1s and idle rendering follows immediately, the visual gap is negligible.

### REST History Path

The `history_page` and `session_switched` REST fallback path already benefits from server-side pre-rendering (C3). The remaining cost is the synchronous `historyToChatMessages()` conversion loop itself.

Solution: the call sites in `ws-dispatch.ts` that invoke `historyToChatMessages` should use the same async chunked pattern — process messages in batches, yield between batches, then call `prependMessages` once with the full result. `historyToChatMessages` itself stays synchronous (pure function, well-tested).

### Edge Cases

- **Rapid session switching**: Generation counter ensures stale replays abort at the next yield point.
- **Live events during replay**: Not possible — `session_switched` clears messages, and no live events for the new session arrive until after `session_switched` is processed.
- **History loading during replay**: `historyState.hasMore` stays false (set by `clearMessages()`), so the IntersectionObserver can't fire.
- **TodoWrite detection in replay**: The `tool_result` handler reads `chatState.messages` to find a ToolMessage by id. During batched replay, this read must come from `replayBatch` instead.

### Testing

- **Unit**: New tests for the chunked replay helper, batch mechanism, and generation-counter abort.
- **Regression**: Run full test suite (`pnpm test:unit`) to verify no regressions in session switching, history loading, or message rendering.
- **Manual**: Switch between sessions with large histories, verify no console violations, no visual jank, and messages render progressively.

---

## Summary

| Fix | What | Where | Impact |
|-----|------|-------|--------|
| 1 | Vite plugin rewrites manifest icon paths | `vite.config.ts` | Fixes 404 icon errors |
| 2A | Chunked async replay with yielding | `ws-dispatch.ts` | Eliminates main-thread blocking |
| 2B | Batched array mutations during replay | `chat.svelte.ts`, `ws-dispatch.ts` | O(N^2) → O(N) allocations |
| 2C | Deferred markdown during replay | `chat.svelte.ts`, `ws-dispatch.ts` | Removes sync markdown cost from replay |
| 2-REST | Async chunked history conversion | `ws-dispatch.ts` | Unblocks REST fallback path |
