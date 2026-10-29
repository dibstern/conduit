# Full-session message navigation implementation plan

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** D1 shows every persisted user prompt while transcript bodies remain paginated, and selecting an unloaded prompt navigates directly to it.

**Architecture:** Deepen the existing transcript module. The server derives a compact prompt index from persisted messages; each open transcript view owns its loaded window, navigation request and stream lifetime. The scroll controller owns physical placement and follow mode; D1 owns only pointer/hover state and never fetches or reconstructs an index from the DOM.

**Tech Stack:** Svelte 5, Effect 4 RPC/streams, SQLite read model, Playwright replay/process tests.

## Ownership and invariants

- Database messages/parts remain the durable facts. No new persistent duplicate message table is needed.
- Prompt summaries are a server-derived projection (message ID, created time, compact display-text preview). Only that projection updates the browser index; loaded bodies do not reconstruct it.
- Each transcript view owns its body window and requests. Main and task views must not write the same mutable window even when viewing the same session.
- A window is an explicit contiguous interval, with earlier/later availability. An old window must not merge a live message across an unloaded gap.
- Latest remains the existing default. Loading a prompt changes the window only after a successful response; failures leave the current reading location usable.
- Every asynchronous commit belongs to a view identity and navigation generation. Old page/jump responses cannot overwrite a newer target, another session, or a disposed view.
- A jump to a loaded row is immediate. A jump outside the window reads a bounded page at the target, never every intervening page.
- Reconnect resumes or refreshes the selected window, not silently the latest window. Historical views do not overwrite the saved latest-page cache.
- Index delivery is bounded/chunked for long sessions. It must include a complete snapshot barrier and retain stable ordering while synchronizing. Markers do not rely on body presence.
- Mutations, removals, forks and provider backfill use the existing persisted ordering and rewind visibility rules. Local sends retain their existing owner; reconcile identities rather than independently writing index rows.
- New live data can update the index and session activity while historical body state stays bounded. Jump to latest transitions back through the same transcript owner.
- The rail's requested preview is not the observed active message. Pending navigation is explicit; no optimistic claim of a completed jump.

## Task 1: Give each transcript view its own window owner

**Files:** existing `stores/transcript.svelte.ts`, `stores/chat.svelte.ts`, `components/chat/MessageList.svelte`, `HistoryLoader.svelte`, `components/session/TaskDrawer.svelte`; existing transcript/task-drawer browser and component tests.

Keep existing default behavior while removing competing writes between primary and task detail feeds. Expose a small transcript view interface for its read state and paging; have MessageList/HistoryLoader consume the supplied view. Preserve the primary's legacy chrome/activity readers through one projection, not two independent stores that synchronize each other. Keep lifecycle, cancellation, and generation guards inside the transcript module. Avoid generic transport wrappers or a separate navigation store.

Concrete prefactor: retain the primary's registered SessionMessages object as its sole window, so legacy currentChat readers remain aliases. Each mounted TaskDrawer constructs and disposes a private transcript owner/messages object, rather than using the exported singleton callback. Move its resume ledger, pending page request, generation and errors with that window. Split install's view projection from session effects: activity/local-send settlement remain session-owned and idempotent; private projection preserves session notices without creating another activity writer. Historical projection must not lower the session's context estimate or mutate live inbox facts. Pass the view to MessageList/HistoryLoader; page failure belongs to that view. Capture project identity explicitly for requests. Guard both response commit and finally/loading cleanup by owner, generation and request identity, including delayed saved-cache reads/writes and scheduled frames.

1. Before code, add a failing behavior check proving two views of the same session can page independently and disposal/switching does not cancel the other view.
2. Run that check red for shared ownership, then minimally move window state/lifecycle into view ownership.
3. Run the new check plus existing transcript, task drawer and history-loader tests; preserve pending input, local sends and context usage behavior.
4. Review the diff for duplicate state writers. Commit only this slice when its checks pass.

## Task 2: Show the full prompt index and jump to a paginated target

**Files:** `contracts/ws-rpc.ts`; existing RPC routing tables/client transport; `persistence/effect/read-query-effect.ts`; `domain/relay/Services/session-detail-subscription.ts` and related wire helpers as needed; `stores/transcript.svelte.ts`; `MessageNavigationRail.svelte`, `MessageList.svelte`; `test/e2e/specs/message-navigation.spec.ts`; process/integration transcript fixtures.

Extend the transcript interface with navigation to a prompt or latest and paging in either direction. Keep schema parsing at the RPC seam. Read compact prompt summaries directly from SQLite with existing visibility/order rules; do not read assistant bodies to build markers. Reuse read-model advances and subscription lifecycle rather than polling or introducing another event store. Reuse the existing forward page read for targeted windows and bounded backward reads for adjacent pages. Audit the existing live detail/resume contracts before changing them; row/frame limits and version ordering remain enforced.

Use a window-parameterized detail subscription for navigation, retaining the existing snapshot/synchronized barrier and resume discipline. A separate compact prompt-index subscription is managed by the same view owner and survives body-window changes. Do not merge an unversioned targeted RPC response into an independently advancing detail stream. Filter historical message AND part reads and checksums to the explicit interval; existing listing.from is not sufficient. Page changes replace the subscription through one owner and preserve the current view until the replacement synchronizes. Reconnect retains the requested interval even when a resume token is rejected. Expose earlier/later availability separately; reaching the physical bottom of an old window must never mean session latest.

Historical reconnect initially refreshes the same requested window with no saved-latest resume token. Disable read sharing for historical sources unless their key includes immutable resolved bounds; a shared read must not skip subscriber-local initialization. Prompt-index snapshots use bounded byte/count chunks with a dedicated continuation shape, not repeated replacement snapshots. The consumer stages a complete index before publishing and preserves the previous index during reconnect. Reading the compact full index in one transaction is acceptable; this bounds wire/body cost, not server summary-query memory. Cap preview text in SQL before fetching, preserve pending-rewind visibility and durable tombstones, and verify undo/backfill mutations. Adjacent forward paging must advance beyond its inclusive seam even if a page contains only one message. Check server presence and client subscription option forwarding explicitly.

1. Write browser behavior checks before code: 120 persisted prompts, newest body page loaded, all 120 markers shown; selecting an old marker fetches its page directly and makes it visible; later paging and Jump to latest work without fetching the gap.
2. Add server-facing verification before implementation: index omits assistant/tool bodies, previews are capped, equal timestamps order by durable message ID, cross-session targets are rejected, and target reads obey page/frame limits. Document failure cases before isolated checks.
3. Implement the smallest complete path through query, contract, transcript owner and D1. D1 receives index entries and calls navigation; remove its rendered-user enumeration as the source of markers.
4. Make prompt selection during drag coalesce requests and ignore superseded completions. Keep tap/keyboard and loaded-message navigation immediate. Show bounded loading/failure feedback without hiding the existing window.
5. Verify phone and desktop click/touch/keyboard, complete index with a partial DOM, unchanged marker positions as bodies page, target alignment and preview bounds. Save screenshots/video.
6. Commit this slice once the behavior and affected contract checks pass.

## Task 3: Preserve navigation under live changes and reconnects

**Files:** the owners established above and their existing browser/integration tests. Remove obsolete paging/rail state left behind by Tasks 1–2; do not introduce a parallel implementation.

1. Write failing behavior checks for rapid out-of-order jumps, session change during load, old-window live streaming, index changes/removals, reconnect at an old target, independent main/task windows, collapsed inherited history, and optimistic sends becoming durable.
2. Fix each issue in its existing owner. Superseded work cannot commit; live updates outside the window never fill gaps; retired targets produce a recoverable state; selecting inherited prompts reveals their existing context.
3. Keep page errors/retry and newer/older availability derived from the view's single state. Save only cache records whose meaning matches existing latest-page resume semantics.
4. Run scoped E2E/integration regressions and type/lint checks. Run relevant phone transcript visual acceptance. Perform GPT-6 Astra browser verification on an isolated server, with repeatable artifacts and cleanup.
5. Self-review against `/codebase-design` and `/ub-mode`; run `/ts-sol-loop` before any main-line integration. Record evidence on the Beads tickets.

Placement contract: the view publishes one pending target and transition identity/kind; the scroll controller aligns after DOM commit and acknowledges the same request. Recheck identity after every tick/frame. D1's hover/requested preview may move before the observed active marker. Freeze message IDs during drag, not DOM nodes. Replace the heuristic that treats any first-UUID change as a prepend with explicit transition information, and guard delayed prepend callbacks. Fork expansion has one presentation owner keyed by the actual viewed session and can be revealed by pending placement. Save only synchronized latest-window snapshots; historical windows never overwrite the latest-page cache. Test late page updates/removals, short historical pages, stale cleanup, and main/task fork reveal, not only successful clicks.

## Verification commands

Use scoped `vitest` projects for existing transcript/contract/query tests and `pnpm exec playwright test --config test/e2e/playwright-replay.config.ts test/e2e/specs/message-navigation.spec.ts test/e2e/specs/transcript-detail.spec.ts --workers=1 --retries=0` for browser behavior. Full-process evidence must exercise the real RPC/database path with mocked provider boundaries, rather than only browser RPC fixtures.

Run `pnpm check`, `pnpm check:svelte`, `pnpm lint:rules` and scoped Biome for final edited files. `ACCEPTANCE_PORT=<free-port> pnpm acceptance:visual phone-transcript-scrolling` is the visual gate. Never run builds against the same output directory concurrently. In this worktree disable pnpm dependency auto-install; do not install into its shared node_modules symlink.

`crapper`, `dryer`, and `mutator` are unavailable in the active tool catalog. Use focused complexity/duplication review and demonstrate the new behavior tests fail on the pre-change implementation; do not claim those tools ran.
