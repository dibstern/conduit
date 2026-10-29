# Session list

The sidebar lists every session across projects. A user searches it by title, filters it with the Needs you, Running and Unread chips, and groups it by status, project or time. Each row's menu renames, pins, marks read, archives or deletes the session. Settled sessions go to a collapsed Settled shelf. Archived sessions leave the list but stay findable by search and in Settings › Archived. The list is the same for every harness, and rows from Claude, OpenCode, Codex and Cursor were all driven through it.

## Sub-features

- `list-rows` shows a row per session, in groups. A new reply makes its row unread.
- `list-search` covers the search box (`#session-search-input`), its summary line, and **Include archived**.
- `list-filters` covers the **Needs you**, **Running** and **Unread** chips, with their counts.
- `list-group` covers **Group sessions**: Status (the default), Project, Time.
- `list-row-menu` covers each row's **More options** menu: Rename, Pin, Mark read, Archive, Delete. It also has Settle, Auto-settle, Snooze, Select, Fork and Copy resume.
- `list-settle` covers Settle from the session bar, and the Settled shelf.
- `list-archive` covers Archive, finding the session again with Include archived, and Unarchive or Delete in Settings › Archived.
- `list-drafts` covers the drafts tray and its **Clear all**.

## How to get to it (user POV)

- The sidebar is open on desktop. Search and the filter chips sit at its top. **Group sessions** is the icon button next to the chips.
- Hover a row to show its actions, then click **More options** (the ...). To use the right-click entry point, run `$V click "#session-list a[href='/s/<id>']" --button right`. That entry point remains unverified.
- In an open session, **Settle** is in the session bar.
- Archived sessions are under More actions › Settings › **Archived**.

## Driving it with playwright-cli

Make one session per harness, then drive the list.

```bash
D="test-results/verify-conduit/$RUN_ID/session-list"
mkdir -p "$D"
$V up
$V send 'Say hello' --harness claude --model opus --provider claude;                 C=<sessionId>
$V new-session; $V send 'Say hello' --harness opencode --model claude-opus-4-6 --provider anthropic; O=<sessionId>
$V new-session; $V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex;            X=<sessionId>
$V new-session; $V send 'Say hello' --harness cursor --model composer-2.5 --provider cursor;         U=<sessionId>
$V screenshot --file "$D/01-list.png"

# Search, then filters
$V fill '#session-search-input' 'Greet'
$V eval '() => document.querySelector("[data-testid=session-search-summary]").textContent'
$V fill '#session-search-input' ''
$V press Escape
$V click '[data-testid=session-filter-chip-unread]'
$V click '[data-testid=session-filter-chip-unread]'
$V click '[data-testid=session-filter-chip-running]'
$V click '[data-testid=session-filter-chip-running]'

# Grouping
$V click '[data-testid=session-group-button]'
$V click '[data-testid=session-group-option-project]'
$V click '[data-testid=session-group-chip]'          # back to Status

# Row menu: one helper for any session id
menu() { $V hover "#session-list a[href='/s/$1']"; $V click "#session-list a[href='/s/$1'] [aria-label^='More options']"; }
menu $C; $V click '[data-testid=session-ctx-rename]'
$V fill 'role=textbox[name="Session name"]' 'Claude hello'; $V press Enter
menu $U; $V click '[data-testid=session-ctx-pin]'
menu $X; $V click '[data-testid=session-ctx-mark-read]'
$V open-session $C; $V click '[data-testid=session-bar-settle]'

# Archive, find it again, unarchive
menu $O; $V click '[data-testid=session-ctx-archive]'
$V fill '#session-search-input' 'OpenCode'
$V click '[data-testid=search-include-archived]'
$V screenshot --file "$D/02-search-archived.png"
$V fill '#session-search-input' ''; $V press Escape
$V click 'role=button[name="More actions"]'; $V click '[data-testid=overflow-settings]'
$V click '[data-testid=settings-tab-archived]'
$V click 'role=dialog[name="Settings"] >> role=button[name="Unarchive"]'
$V click '[data-testid=settings-close-btn]'

# Delete the seeded session
menu <seeded id>; $V click '[data-testid=session-ctx-delete]'
$V screenshot --file "$D/03-delete-confirm.png"
$V click 'role=dialog >> role=button[name="Delete"]'

# Second view
$V store sql "select title, model_provider, unread, pinned_at is not null pinned, settled_at is not null settled, archived_at is not null archived from sessions" > "$D/04-sessions.json"
$V home
$V screenshot --file "$D/05-after-reload.png"
```

Check these results:

- With the seeded session and the four new ones, the list reads `Idle 5`. Each new reply makes its row `Done, unread`, even the one that is open. **Unread** reads `4`.
- Search `Greet` leaves only the OpenCode session (`Greeting`), and the summary reads `1 match  Include archived  Clear`. Search `mock model` gives 0 matches.
- **Unread** shows the 4 unread rows. **Running** shows `Nothing running` and **Clear filter**.
- Group by Project shows `process-test 5` and a chip `By project ✕`. Time shows `Today 5`. The chip's ✕ goes back to `Idle 5`.
- Rename works on all four harnesses. The store titles become `Claude hello`, `OpenCode hello`, `Codex hello`, `Cursor hello`.
- Pin puts Cursor under a `Pinned 1` group at the top, and sets `pinned_at`. Mark read takes **Unread** to `3` and sets Codex `unread` to `0`.
- Settle moves Claude to a collapsed `Settled 1` shelf, and sets `settled_at`.
- Archive removes OpenCode from the list and sets `archived_at`. Search `OpenCode` gives 0 matches until **Include archived**, then 1 match with an archived badge (`session-archived-badge`). Settings › Archived lists `OpenCode hello`, `Archived just now`, with Unarchive and Delete. Unarchive clears `archived_at`.
- Delete asks `Delete "<title>"? This session and its history will be permanently removed.` with Cancel and Delete. After Delete, the session is gone from the store, and still gone after the reload.
- After the reload the list reads `Pinned 1` (Cursor hello), `Idle 2` (OpenCode hello, Codex hello) and `Settled 1`.
- **Clear all** in the drafts tray removes every unsent draft.

## Gotchas

- Row actions only show on hover. A plain click on **More options** fails as not visible. Run `$V hover` on the row link first, then click.
- Focusing the search box opens the scope suggestions (`session-scope-suggestions`) over the list, even when the box is empty. This is the design (8db686cc, pinned by `test/e2e/specs/session-triage.spec.ts` and `sidebar-layout.spec.ts`). They cover the filter chips, so press Escape (twice if you typed) before clicking a chip.
- The open session stays unread after its reply arrives. This is the design: only a gesture (a click, typing, a resting pointer, tabbing in or scrolling) marks it read, and watching does not (`test/e2e/specs/session-unread.spec.ts`). playwright-cli makes no such gesture, so click in the conversation if you need it read.
- Search matches titles only. Message text doesn't match. Deep search was not tested.
- The OpenCode recording names its session `Greeting`. Claude, Codex and Cursor sessions keep their default titles until renamed.
- Not checked: Snooze, Auto-settle, Select and bulk actions, Copy resume, drag to reorder (Manual order), Needs you with a real question pending, automatic settle and archive after days. Fork from the menu is in [Fork a session](./fork.md), which drives it from the reply instead.
