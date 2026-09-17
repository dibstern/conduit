# Unified session sidebar: design exploration

Status: exploration, no code. Goal: drop the project switcher as a *container* and show sessions from every project in one sidebar, with filtering and grouping. Twenty-five designs follow: ten that stay inside web-interface best practice, fifteen that don't. A session-row redesign and a recommendation close the doc.

## 1. Where we are

Today the sidebar is `ProjectSwitcher` (dropdown, one project at a time) over a `SessionList` bucketed Today / Yesterday / Older. Each `SessionItem` is one line: indicator dot, title, `4m · 12 msgs`, kebab. Routing is `/p/<slug>/…`, so "project" is baked into the URL and into every RPC (`listSessions({projectSlug})`).

Per-session data we have now: `id, title, createdAt, updatedAt, messageCount, processing, parentID (fork), pendingQuestionCount`, plus a client-side indicator `attention | done-unviewed | processing`. Per-project: `slug, title, directory, instanceId`.

Data the good designs want and we don't yet surface on the list: `projectSlug` on each session (obviously), branch / worktree, provider + model, a labelled status (`approval | input | working | error | done-unread | idle`), working duration, last assistant line, diff stats, cost. `TurnEconomics` already computes cost per turn; the rest is cheap to project from the event store.

## 2. What the competitors taught us

**t3code** is the strongest reference. Projects are a *filter*, not a container: a flat thread list, project shown as a 16px favicon glyph on the row, one header row holding search + a project-scope combobox. Rows come in two densities chosen by *section* (78px card for pinned/active, 36px slim for snoozed/settled). Status is a six-state model with three colours and a "recede" rule: working threads dim, finished-unread threads brighten, because a running agent needs nothing from you. Hold ⌘ for 200ms and `1–9` jump pills float in. No time buckets at all.

**opencode / claudius** use a Discord-style icon rail of project tiles with corner status badges, a HoverCard that peeks at another project's sessions without switching, and a sort that pins anything touched in the last 60s so in-flight rows don't reshuffle under the cursor. Archive is the disposal verb, never delete.

**claude-relay** dims non-matching rows during search instead of hiding them, so structure stays put while you scan. It also collapses repeated loop runs into one expandable parent row.

**CodeNomad** uses a *labelled* status pill (dot + word) and a worktree badge on line 2. **perry** dims zero-message sessions to 60%. **paperclip** is Linear-shaped: colour squares for projects, pulsing pip + "N live" for agents.

Recurring lessons: project as glyph not heading; status is the primary sort key, time is secondary; search filters titles, ⌘K searches bodies; archive not delete; keep the row sparse and push detail to a hover card.

## 3. Shared vocabulary

Every design below uses this token set so they can be compared fairly.

- **Project glyph**: 16px square, project colour + two-letter initials, or user-chosen emoji / Lucide icon. Colour is deterministic from slug (17-colour palette) unless overridden. Tooltip = full title + directory.
- **Status**, resolved in this order: `approval` (amber shield) > `input` (indigo question) > `working` (sky dashed circle + `Xm` timer) > `error` (red alert) > `done-unread` (emerald check) > `idle` (nothing; show relative time). Three hues only, plus red.
- **Recede**: `working` and `idle` rows render at 70% foreground; `approval`, `input`, `error`, `done-unread` at 100% with medium weight.
- **Scope**: the set of projects currently shown. Default all. URL-encoded (`?p=conduit,dotfiles`).
- **Group-by**: `none | project | status | time`. URL-encoded (`?g=project`).

## 4. Best-practice designs (1–10)

Constraints all ten satisfy, per the Web Interface Guidelines: rows are `<a href>` (⌘-click, middle-click work); scope and group-by live in the URL; lists over 50 rows virtualize; status changes announce through one `aria-live="polite"` region, not per-row; timers use `tabular-nums`; every flex text child has `min-w-0` + truncate; icon-only buttons carry `aria-label`; transitions are `transform`/`opacity` and honour `prefers-reduced-motion`; empty and error states are drawn; destructive actions get undo.

### D1. Flat inbox, project as glyph (t3code baseline)

```
┌ 🔍 Search sessions…            [◫][+] ┐
│ ▣ conduit    ⚠ Approval               │
│   Fix auth token refresh              │
│   ⌥ feat/auth  ⌘ opus                 │
│ ▣ dotfiles   ○ 4m                     │
│   Migrate zsh config to nushell       │
│   ⌥ main                              │
│ ▣ conduit    ✓ Done                   │
│   Add session export                  │
│ ▣ perry      12m                      │
│   Investigate flaky e2e               │
└───────────────────────────────────────┘
```

One flat list, recency-sorted with status-tier boost (needs-you first). Three-line 78px card. Project scope is a combobox in the header whose trigger icon *becomes* the selected project glyph. Group-by is a secondary menu. Least novel, most proven. Weak spot: with six projects and forty sessions, the glyph column becomes noise; D2/D3 fix that.

### D2. Collapsible project sections with rollup badges

```
│ ▾ conduit                 ⚠1 ○2  ✓1  │
│     ⚠ Fix auth token refresh    2m   │
│     ○ Add session export        4m   │
│     ○ Refactor relay stack      9m   │
│ ▾ dotfiles                    ○1     │
│     ○ Migrate zsh to nushell    4m   │
│ ▸ perry                       ✓1  1h │
```

Projects are sticky section headers ordered by most recent activity, each with a badge strip counting sessions per status. Collapsed sections still show the strip, so a collapsed project can't hide an approval. Rows are one line (36px) because the project is already known. This is the closest to today's mental model and the least migration risk for users. Weak spot: cross-project triage requires scanning every header.

### D3. Icon rail + flat list (opencode/Discord)

```
┌──┬────────────────────────────────┐
│◉ │ All · Needs you 2 · Running 3 │
│▣●│ ⚠ Fix auth token refresh   2m │
│▣ │   conduit · feat/auth         │
│▣○│ ○ Migrate zsh to nushell   4m │
│▣ │   dotfiles · main             │
│  │ ✓ Add session export      12m │
│+ │   conduit                     │
└──┴────────────────────────────────┘
```

A 44px rail of project glyphs on the left, each with a corner badge (amber/sky/emerald) aggregating status. Clicking a tile *toggles it in the scope* rather than switching; ⌘-click for solo. Top tile is "All". Hover a tile for a peek card of that project's top five sessions. The list is a two-line row. Best balance of glanceability and density; costs 44px of width. Rail collapses into the header on narrow widths.

### D4. Filter chips + time buckets

```
│ [All] [Needs you 2] [Running 3] [Done 1]│
│ [▣ conduit ×] [▣ dotfiles ×] [+ project]│
│ TODAY                                   │
│ ⚠ ▣ Fix auth token refresh           2m │
│ ○ ▣ Migrate zsh to nushell           4m │
│ YESTERDAY                               │
│ ✓ ▣ Add session export               1d │
```

Two chip rows: status chips (single-select) and project chips (multi-select, removable). Below, the familiar Today / Yesterday / Older buckets. Group-by can be swapped to project or status via a small segmented control at the far right of the header. The most discoverable filtering model and the easiest to explain. Weak spot: chip rows eat 64px vertically before the first session.

### D5. Status-first triage (inbox zero)

```
│ NEEDS YOU                          2 │
│ ⚠ ▣ Fix auth token refresh   approve │
│ ? ▣ Pick a migration strategy  reply │
│ RUNNING                            3 │
│ ○ ▣ Migrate zsh to nushell      4m ▏ │
│ ○ ▣ Refactor relay stack        9m ▏ │
│ DONE, UNREAD                       1 │
│ ✓ ▣ Add session export           12m │
│ RECENT                               │
│   ▣ Investigate flaky e2e          1h │
│ ▸ Archived                        41  │
```

Sections are status tiers, not projects or dates. Rows in RUNNING and RECENT recede; NEEDS YOU rows carry a right-aligned verb (`approve`, `reply`) that is the row's primary action. The Archived shelf sinks to the bottom with `mt-auto`. Group-by-project is available *within* each tier. Best for the "many agents, one human" workload conduit is built for. Weak spot: sessions move between sections while you look at them; mitigate with a 60s pin like opencode's sort.

### D6. Colour-stripe compact rows

```
│┃ Fix auth token refresh        ⚠  2m │
│┃ conduit · feat/auth                 │
│┃ Migrate zsh to nushell        ○  4m │
│┃ dotfiles · main                     │
│┃ Add session export            ✓ 12m │
│┃ conduit                             │
```

Project is a 3px left stripe in the project colour, nothing else. Two lines, 52px. The active session's stripe widens to 5px with the existing brand glow. Scope filtering is a legend row at the top: click a colour swatch to toggle. Extremely dense and quiet; colour alone must not be the only signal (line 2 names the project) so it stays accessible. Best for people with three or fewer projects.

### D7. Pinned / Active / Archived shelves with drag

```
│ PINNED                              │
│ ▣ Fix auth token refresh    ⚠  2m  │
│ ─────────────────────────────────── │
│ ▣ Migrate zsh to nushell    ○  4m  │
│ ▣ Add session export        ✓ 12m  │
│ ▣ Investigate flaky e2e       1h   │
│                                     │
│ ▸ Snoozed                      2    │
│ ▸ Archived                    41    │
```

t3code's model verbatim: manual order in Active, fractional keys for Pinned, drag between shelves with a verb badge (Pin / Archive / Wake) replacing the status slot during drag. Snooze until a time. Zero time buckets. Needs keyboard alternatives for every drag (context menu + `⌘⇧P` pin, `⌘⇧S` archive). Best for people who curate; worst for people who never do (Active becomes the whole list).

### D8. Table density mode

```
│ Title                 Project  Status  Updated │
│ Fix auth token refr…  conduit  ⚠ Appr   2m    │
│ Migrate zsh to nush…  dotfiles ○ 4m     4m    │
│ Add session export    conduit  ✓ Done  12m    │
│ Investigate flaky e2e perry    –        1h    │
```

When the sidebar is dragged past ~380px it switches to a sortable table (click headers, `aria-sort`). Below that width it falls back to D1 cards. Users who keep a wide sidebar get a real list view; column sort *is* the grouping mechanism. Tabular numerics throughout. Weak spot: two layouts to maintain.

### D9. Palette-first, minimal sidebar

```
│ ⌘K  Search all sessions…             │
│ NEEDS YOU                            │
│ ⚠ ▣ Fix auth token refresh       2m  │
│ RECENT                               │
│ ○ ▣ Migrate zsh to nushell       4m  │
│ ✓ ▣ Add session export          12m  │
│   ▣ Investigate flaky e2e        1h  │
│   ▣ Wire PTY resize              3h  │
│ Show all 47 sessions →               │
```

The sidebar shows only what matters: needs-you plus the eight most recent. Everything else lives behind ⌘K, a full-height palette with fuzzy search over title + last message, results grouped by project with the glyph, and `⌘1–9` jumps. "Show all" opens a full-page session browser (D8-style table) rather than growing the sidebar. Cheapest to build on top of D5. Weak spot: discoverability of older sessions.

### D10. Mobile-first tabs

```
│ [All] [conduit ●] [dotfiles] [perry] ›│
│ ( Needs you | Running | Done | All )  │
│ ⚠ Fix auth token refresh          2m  │
│ ○ Migrate zsh to nushell          4m  │
│ ✓ Add session export             12m  │
│    ← swipe: archive   swipe →: pin    │
```

Horizontal scrolling project tabs (with badge dots) over a segmented status control. Single-line rows at 44px touch targets. Swipe actions with visible button alternatives on long-press. The same component renders on desktop where the tab row wraps. Best if the phone is a first-class surface; least distinctive on desktop.

## 5. Outside-the-box designs (11–25)

These break at least one convention on purpose. Each notes what it costs.

### D11. Kanban swimlanes

```
│ NEEDS YOU │ RUNNING     │ DONE      │
│ ▣ Fix aut…│ ▣ Migrate…  │ ▣ Add se… │
│ ▣ Pick a… │ ▣ Refacto…  │           │
│           │ ▣ Wire PT…  │           │
```

The sidebar becomes a three-column board. Columns are status; cards are sessions with glyph + title. Drag a card to Done to archive it. At sidebar widths the columns are 100px each and titles truncate hard, so this wants a 420px+ sidebar or a full-page mode. Costs: width, and it fights the vertical scroll everything else assumes.

### D12. Timeline strip

```
│ 15:00 ┼ ▣━━━━━━━━━━━━━━━━━━▶ Migrate zsh   │
│       │  ▣━━━━━━━━━━━▶ Fix auth ⚠         │
│ 14:30 ┼ ▣━━━━━━━┫ Add session export ✓    │
│       │         ▣━━━┫ Flaky e2e           │
│ 14:00 ┼ ▣━━━━━━━━━━━━━━━━━━━━━━━━┫ Relay  │
```

Vertical time axis, each session a horizontal bar from `createdAt` to last activity, running bars extend to the live edge with a soft pulse. Bar colour is project colour; the status glyph sits at the bar's head. You *see* which agents have been running longest and what overlapped. Scroll down for history. Costs: a lot of horizontal space is empty; long-lived sessions dominate.

### D13. Activity heatmap per project (BlockGrid native)

```
│ conduit   ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ ⚠1 ○2 │
│ dotfiles  ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ ○1    │
│ perry     ▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪▪ ✓1    │
│ ───────────────────── 24h ───────────────│
│ ⚠ Fix auth token refresh              2m │
│ ○ Migrate zsh to nushell              4m │
```

Each project is a 24-cell sparkline (one cell per hour) built from the existing `BlockGrid` component, intensity = messages, colour = project, cell pulses when live. Click a cell to filter the list below to sessions active in that hour; click the project name to toggle scope. The brand's block motif becomes functional. Costs: the sparkline row is informational not navigational; the list still does the work.

### D14. Treemap

```
│ ┌────────────────┬──────────┐ │
│ │ conduit        │ dotfiles │ │
│ │ ┌────┐┌──────┐ │ ┌──────┐ │ │
│ │ │Fix ││Add   │ │ │Migr  │ │ │
│ │ │auth││sess  │ │ │zsh   │ │ │
│ │ └────┘└──────┘ │ └──────┘ │ │
│ ├────────────────┴──────────┤ │
│ │ perry  [Flaky e2e]        │ │
│ └───────────────────────────┘ │
```

Projects are rectangles sized by recent activity; sessions are tiles inside sized by recency, tinted by status. One glance says "conduit is where the action is, and one of those tiles is amber". Squarified layout, animated with `transform` only. Costs: tiny tiles are unreadable and un-tappable; needs a list fallback beneath for anything below ~40px.

### D15. Attention orbit

```
│            ○ Migrate zsh              │
│    ○ Relay        ┌───────┐           │
│                   │ ⚠ Fix │  ✓ Export │
│                   │ auth  │           │
│    · Flaky        └───────┘           │
│            · Wire PTY                 │
```

Radial layout: the session that most needs you sits in the centre, needs-you ring next, running ring, then idle ring at the edge fading out. Angle within a ring = project (each project owns a sector). Sessions drift inward as they wait for you. Costs: radial layouts are hostile to screen readers and keyboard order; ship only as an alternate view over a real list.

### D16. Unified message river

```
│ ▣ conduit · Fix auth               2m │
│   ⚠ May I run `pnpm test:unit`?       │
│   [Allow] [Deny]                      │
│ ▣ dotfiles · Migrate zsh           4m │
│   Rewriting aliases… 14/32 files      │
│ ▣ conduit · Add session export    12m │
│   ✓ Done. Added JSON + Markdown.      │
```

The sidebar is a feed of *last assistant lines*, newest first, like a Slack unified inbox. Permission prompts and questions render inline with their buttons so you can approve without opening the session. The session title becomes secondary; the agent's last words are the row. Costs: taller rows (3–4 lines), and inline actions in a nav region need care for focus management. This one is genuinely useful for triage.

### D17. Spatial desk

```
│  ┌conduit────────┐   ┌dotfiles┐      │
│  │ [Fix auth ⚠]  │   │[zsh ○] │      │
│  │   [Export ✓]  │   └────────┘      │
│  │ [Relay ○]     │                   │
│  └───────────────┘  ┌perry──┐        │
│                     │[e2e]  │        │
│                     └───────┘        │
```

Freeform canvas. Sessions are draggable cards; projects are zones you can resize and move. Positions persist per user. Spatial memory ("the auth work is top-left") replaces sorting. New sessions spawn in their project zone. Costs: canvases decay into mess; needs a "tidy" command and a list mode for keyboard users. Works best as a full-page "mission control", not a 260px sidebar.

### D18. Terminal status list (mutt/tmux)

```
│ 1 ⚠ conduit   feat/auth   Fix auth token refresh   2m │
│ 2 ○ dotfiles  main        Migrate zsh to nushell   4m │
│ 3 ✓ conduit   main        Add session export      12m │
│ 4   perry     main        Investigate flaky e2e    1h │
│ :filter status=needs-you project=conduit              │
```

Monospace, fixed columns, zero chrome, `j/k` to move, `1–9` to jump, `/` to search, `:` for a filter mini-language (`status=working p=conduit since=1h`). Grouping is a `:group project` command. Fits the brand's block-grid, terminal-adjacent look and the fact that conduit already embeds a PTY. Costs: alienates anyone who doesn't live in a terminal; needs a discoverable palette that writes the commands for you.

### D19. Fork graph

```
│ conduit                              │
│ ● Fix auth token refresh          ⚠  │
│ ├─● Try refresh-token rotation    ○  │
│ │ └─● …with backoff              ✓  │
│ └─● Try session cookies              │
│ ● Add session export              ✓  │
```

We already have `parentID` and `forkMessageId`. Render sessions as a git-style graph: forks branch off their parent with connector lines, projects as lanes. Status glyphs sit on nodes. Collapsing a parent hides its subtree. Answers "which of these explorations is still alive" at a glance. Costs: unforked sessions are a flat list with wasted gutter; the graph only pays off for heavy forkers.

### D20. Card stacks per project

```
│ ┌────────────┐  ┌────────────┐       │
│ │▣ conduit  3│  │▣ dotfiles 1│       │
│ │┌──────────┐│  │┌──────────┐│       │
│ ││Fix auth ⚠││  ││zsh     ○││       │
│ │└┬─────────┘│  │└──────────┘│       │
│ │ └┬────────┘│  └────────────┘       │
│ │  └────────┘│                       │
│ └────────────┘                       │
```

Each project is a stack of cards, top card = most urgent session, count badge in the corner. Hover or arrow-key fans the stack out into a column; click a card to open. Scope is implicit (all stacks visible). Costs: only the top card is readable at rest, so it depends entirely on the sort being right.

### D21. Now-playing dock

```
│ ▣ Fix auth ⚠  ▣ zsh ◔ 4m  ▣ Relay ◔ 9m  ▣ …  │  ← bottom dock
```

Running and needs-you sessions leave the sidebar entirely and live in a bottom dock across the whole app, each as a chip with a progress ring (elapsed vs. that session's median turn time). The sidebar shrinks to a plain recency list of idle sessions. Live work is always visible regardless of which page you're on. Costs: two places to look; the dock competes with the terminal panel for the bottom edge.

### D22. Topic clusters

```
│ AUTH & SESSIONS                       │
│ ⚠ ▣ Fix auth token refresh            │
│ ✓ ▣ Add session export                │
│ SHELL & DOTFILES                      │
│ ○ ▣ Migrate zsh to nushell            │
│ TESTING                               │
│   ▣ Investigate flaky e2e             │
│   ▣ Stabilise visual baselines        │
```

Group by *what the session is about*, not where it lives. Cluster titles come from embeddings of title + first user message, labelled by a small model, recomputed nightly. Projects appear only as glyphs. Costs: nondeterministic groups confuse spatial memory; needs an "always group by project" escape hatch and clear "auto-grouped" labelling.

### D23. Waiting-time queue

```
│ ▣ Pick a migration strategy   ████████ 22m │
│ ▣ Fix auth token refresh      ███      6m │
│ ▣ Approve `rm -rf dist`       █        1m │
│ ─── running ──────────────────────────── │
│ ▣ Migrate zsh to nushell              4m │
```

Sessions blocked on you sort by how long they've been waiting, with a bar that grows in real time. It's an SLA view: the top row is the agent you've neglected longest. Everything else is below a rule. Costs: guilt-driven design; the bar reads as a progress bar (it isn't). Colour it neutral and label it "waiting 22m".

### D24. Deck columns (TweetDeck)

```
│ c │ d │ p │ ← rotated project tabs
│ o │ o │ e │
│ n │ t │ r │
│ ┌────────────┬────────────┐
│ │ conduit    │ dotfiles   │
│ │ ⚠ Fix auth │ ○ zsh      │
│ │ ✓ Export   │            │
│ │ ○ Relay    │            │
```

A rail of vertical text tabs; clicking one opens that project as a column next to whatever columns are already open. Two or three project columns side by side, each an independent scrolling list. Best when you're actively juggling exactly two repos. Costs: needs 500px+; rotated text is a readability and a11y hit (keep an `aria-label`).

### D25. Ambient pulse strip

```
│ ▏  ← 6px strip: one segment per session
│ ▏     amber = needs you (glows)
│ ▏     sky = working (breathes)
│ ▏     grey = idle
│ ▏  hover or ⌘B expands to D5
```

The sidebar collapses to a 6px strip of stacked coloured segments, one per session, ordered like D5. Segments glow (opacity animation) when they need you. Hover or ⌘B expands to a full list. Maximum canvas for the chat; peripheral-vision awareness of every agent. Costs: zero information density at rest; must honour `prefers-reduced-motion` by freezing to static colour.

## 6. Session row redesign

Whichever container wins, the row is the thing you look at four hundred times a day. Proposed default row (two lines, 52px), with a one-line 36px variant for archived / settled shelves:

```
 ⚠ Fix auth token refresh                     approve
   ▣ conduit · feat/auth · opus              tabular 2m
```

- **Slot 1, status**: one glyph from the six-state model, or nothing when idle. Never an animated spinner; the `Xm` timer on working rows is the motion.
- **Line 1, title**: truncate, weight 500 when unread / needs-you, 400 otherwise. Fork icon after the title when `parentID` is set.
- **Line 2, provenance**: project glyph + name (hidden when grouped by project), branch, model. All muted, all truncating from the right with `min-w-0`.
- **Trailing slot**: a cross-fade, not a second column. At rest it shows the verb (`approve`, `reply`) or the relative time. On hover/focus it swaps to actions (pin, archive, more) absolutely positioned so nothing reflows. Holding ⌘ swaps in the `1–9` jump pill.
- **Recede**: working and idle rows at 70% foreground; needs-you and done-unread at full.
- **Hover card** after 400ms: directory, worktree, model, last assistant line, cost so far, message count. Everything we're tempted to cram into line 3 goes here instead.
- **Row is `<a>`** with `href`, `aria-current="page"` when active, `data-session-id`, `content-visibility: auto` with `contain-intrinsic-size: 52px`.

Things deliberately dropped from today's row: `12 msgs` (nobody sorts by it; it moves to the hover card) and the always-visible kebab (hover/focus only, keyboard via context-menu key).

## 7. Recommendation

Build **D5 (status-first triage) as the container, D3's rail as the scope control, D1's header as the search, D9's ⌘K as the deep search**, with the row from §6. Group-by (`none | project | time`) is a menu on the header; status tiers are always the outer grouping because that's what the product is for. D16's inline approve/deny is the first follow-up once the row exists; D13's sparkline is a cheap brand flourish on the rail tooltips.

What that costs on the backend: `listSessions` needs to span projects (or the client fans out and merges, which is fine at our scale), each `SessionInfo` needs `projectSlug`, `status`, `branch`, `model`, and URL routing moves from `/p/<slug>/s/<id>` to `/s/<id>` with `?p=` and `?g=` for scope and grouping. Project *registration* stays exactly as it is; only the switcher-as-container goes.

Try D18 as a hidden `?view=tty` easter egg. It's a day of work and the brand wants it.

## 8. Settle v2 (ported from t3code, built into every design above)

Three shelves and one overlay. **Active** rows are full cards. **Settled** rows are slim, 70% ink, desaturated glyph, collapsed by default, sorted and labelled by *when they settled*. **Snoozed** is an overlay on Active with a wake time. Pinned is a flag. Only settling or snoozing collapses a row; the sidebar never guesses density on its own.

**Manual.** ✓ on card hover (replaces the time), `⌘⇧S`, menu, or drag onto the Settled header (verb badge Pin / Unpin / Settle / Un-settle / Wake replaces the status slot mid-drag). Settling clears the pin and manual Active slot. Un-settle (↶ on hover, chat banner, or just send a message) returns the session to the top of Active and blocks auto-settle until activity resumes the rules.

**Automatic (server-side, runs with the app closed).** Idle for N days (default 3, 1–90, or off); linked PR merged (default on) or an idle session's PR closed. conduit's stand-in for "PR merged" is branch merged into main / worktree removed until PR links exist. The merge must be newer than the user's last message, so resumed work isn't swept. Never while: pending approval or question, starting or running, background liveness (PTY, dev server), a queued message under 2 min old, manual un-settle override, or snoozed with time left. Per-project override; changing a rule never reopens settled sessions.

**Snooze.** Presets In 1 hour / In 3 hours / This evening (only while meaningfully before 18:00) / Tomorrow 9:00 / Next week / Custom. Not allowed while blocked on you. A raised hand (approval, question, fresh error, or a turn completing after the snooze) wakes it early; a **Woke** pill sits in its original slot until visited. Sort is static, so the pill is the whole signal.

**Chat.** Opening a settled or snoozed session shows a banner: "This session is settled · Send a message to un-settle [Un-settle]" / "…snoozed · Send a message to wake [Wake now]" / "Woke from snooze · Send a message to continue".

**Backend.** `SessionInfo` gains `settledOverride`, `settledAt`, `unsettledAt`, `snoozedUntil`, `snoozedAt`, `pinnedAt`; a settlement reactor sweeps every project on a timer; RPCs `session.settle / unsettle / snooze / unsnooze / pin`. Settled tail pages 10 then +25. Archive stays a Settings page; Settle is the sidebar's only parking verb.

Per design: D1/D3/D4/D6/D9/D10/D13/D21/D22/D23/D25 gain collapsed Snoozed + Settled floor shelves and ✓ on hover; D2 tails settled rows under each project; D5 and D7 show the shelves expanded; D8 adds a dimmed Settled group whose Status cell explains why; D11 drops past Done to settle; D12/D14/D15/D16/D17/D20 let settled work leave the axis / map / orbit / river / desk / stacks; D18 gets `:settled`, `s`, `u`, `z`; D19 keeps settled forks in the tree, dimmed; D24 has a Settled footer per column.


---

## 9. Mobile-first revision (`mobile-first-sidebar.html`)

The 25 designs above are a desktop exploration. conduit is a PWA, so the decision was re-drawn phone-first in a companion page. What changed:

- **D3's icon rail is out.** Seven replacements were drawn and judged; the winner is a **scope chip inside the search field** ("All projects ▾"), so the two controls that answer *which sessions* share one 38px row. Runner-up is a project chip scroller, which degrades past six projects. A navigation drawer was rejected for reintroducing the container we just deleted, and swipe-between-projects for colliding with the row's settle/snooze swipe.
- **Every lifecycle control is drawn, not implied.** Swipe right settles, swipe left snoozes with presets, long press opens the row sheet, select mode gives a bulk bar, and each action shows its keyboard equivalent on the sheet item. A full touch / pointer / keyboard matrix covers all 23 verbs.
- **Three ways, always.** Nothing is reachable only by hover, only by swipe, or only by key. Hover may own the trailing slot, the peek card and the ⌘-held jump pill, never the sole path to an action.
- **Keyboard.** Global `⌘N` `⌘F` `⌘K` `⌘P` `⌘⌥G` `⌘⇧S` `⌘⇧P` `⌘1–9` `⌘Z`; single keys with the list focused, Gmail-style: `j/k` `↵` `s` settle, `z` snooze, `p` pin, `u` unread, `e` archive, `x` select, `f` fork, `/` search, `?` for the sheet.
- **The row is rebuilt** at 60px with a 20px ranked status glyph, a single-line title, a truncating provenance line (PR → model → branch) and a trailing verb that is a word, not an icon. Settled rows collapse to 46px.
- **Pill contrast is fixed at the system level.** The white-pill bug was a specificity collision, not a palette choice: a `.verb` drag badge painted a light background while a more specific row rule repainted only the text. Pills are now `loud` (saturated fill, `#0c0d10` ink), `quiet` (coloured text, no fill) or `tint` (surface fill, hairline border). Fill and ink are always set together, and `--indigo` was lightened to `#9b9bff` so quiet indigo clears AA.
- **Responsive ladder:** <560px full-bleed list with sheets and a FAB; 560–900px denser rows plus hover if the device reports a fine pointer; >900px a 300px sidebar beside the session; >1400px a wider sidebar with branch and model columns. Capability is detected with `pointer: fine` / `hover: hover`, never inferred from width.

## 10. Density and mobile navigation

Two corrections to the mobile-first revision, both rendered in `mobile-first-sidebar.html`.

**Density (§7).** The first pass over-corrected to 60px rows. On a 390x844 phone, once the status bar, header, search field, chip row and home indicator are taken, 629px of list remains: 15 rows at 40px, 14 at 44px, 12 at 52px, 10 at 60px. Ship **52px** as the default (title on one line, project + branch on the second, 44pt-plus touch target), **40px** for settled rows in a collapsed shelf (over WCAG 2.5.8's 24px floor, under Apple's 44pt, acceptable for a shelf you are not meant to be working in), and a **Dense toggle at 44px** that drops the second line to a trailing glyph. Desktop uses 46px because the pointer is precise.

**Pills.** Three tiers only, and fill and ink are always set together: `loud` (saturated fill, near-black ink) for the one action in a row, `quiet` (coloured text, no fill, 2px inline padding so it sits on the baseline grid) for status, `tint` (surface fill, hairline border) for metadata. The earlier bug was a class collision, not a colour choice: a drag badge and a row pill both matched `.verb`.

**Reaching the list from an open session (§8).** Ten variants, five conventional and five risky. The decision:

- **Ship V1, the full-screen route.** The list is a route, the session is a route, back is back. In a PWA that single decision buys the OS back gesture, shareable links, a correct cold launch and a correct notification tap for free.
- **Fold in V4's affordance:** the session header shows `< 2` plus the title, so the badge answers "is it worth going back" without going back.
- **Layer V10, the next-up bar,** as a triage mode behind the "Needs you" chip: answer, advance, never open the list until the queue is empty. It is the only variant that removes navigation rather than redecorating it.
- **Add V8, overscroll-to-list,** later as a free accelerator once V1 exists.
- **Reject the drawer (V2).** It makes the session the root and the list a subordinate overlay, which is backwards for a product whose job is "what wants me", and it makes back ambiguous. It is one project switcher away from being the container we just deleted.
- V7's card grid is genuinely better at 8 sessions and worse at 47, so it is a view option at most; V6's rubber-band peek and V9's status strip are both answering "how many things want me", which the header badge answers for a hundredth of the cost.

## 11. Review round two

- **Row action sheet header.** Title, project, branch, length and last activity were one inline run; they are now a two-line title with a second row of separate objects (project glyph + name, branch as a mono tint pill, message count, last activity). Same fix applied to the snooze sheet header.
- **Scope: A + C, decided.** The chip and the token are the same state rendered twice. Tapping the chip opens the picker; typing `project:` produces the identical removable chip; both write `?p=`. The chip is the discoverable 80%, tokens are the expressive 20%, and suggestions are grouped so the syntax is taught by use rather than required. `/` focuses, `⌘P` jumps to the scope token.
- **New session button.** 44px circle, the touch floor and no more, with a plain shadow instead of a brand glow. It collapses to a `+` in the header on desktop.
- **Settle and snooze with a pointer.** Four routes, in frequency order: hover strip in the trailing slot (settle / snooze / pin / more, each tooltip carrying its shortcut), hover ☾ for the snooze presets in place (click without waiting applies your default and shows the undo toast), right-click for the full verb set in the same order and wording as the phone's long-press sheet, and `e` / `z` / `p` / `x` on a `j`/`k` focus ring. Shift-click ranges and ⌘-click adds; bulk actions emit one undo toast that `⌘Z` reverses as a batch. Drag to a shelf header is the fourth route and the only optional one, because touch has no equivalent that survives a scrolling list.
- **Leaving a session never requires browser chrome.** The desktop session header owns **Close** with `esc` on it, plus a `⇤` that collapses the list and turns the first control into **‹ All sessions**. Browser back still works and always did, as the second route; `⌘[` / `⌘]` walk history in-app.
- **Density: signed off** at 52px default, 40px settled, 44px Dense toggle.
- **Reaching the list: V1 + V4, signed off.** The control is labelled **‹ Sessions** with an amber badge only while something needs you: a bare count is a riddle, a naked chevron assumes you remember how you got here, and arriving from a push notification is the common case. Under ~120px of title room the label collapses to chevron + badge. V4's tappable title menu is in. **V8 (overscroll) and V10 (triage queue) are explicitly not being built now** — both are additive later and neither changes the shape of the build.

## 12. The session top bar

V1 settled the *label* (`‹ Sessions` with an amber badge), not the *layout*. At 320–340 px the one-row bar carrying back, title, project, branch and `⋯` already truncates the title to `Fix auth token refr…`, and there is no room for the terminal button or anything after it.

`mobile-first-sidebar.html` §8 now ends with fifteen arrangements of the whole bar, each drawn at phone width and desktop width: two rows, centred title, breadcrumb, collapse-on-scroll, hero-in-transcript, bottom action bar, segmented view switcher, title-as-menu, status lozenge, chip bar, floating island, corner controls, command field, identity-in-bar/title-in-content, and an unfolding toolbar.

What ships, drawn as **bar 16** at the end of the set (phone at the top of a thread, phone scrolled, desktop):

- **Bar 4 for the frame.** Two rows at the top of a thread (76 px), one row once you scroll (46 px). The title gets a whole line at 14.5 px exactly when it is needed and gives it back when it is not. Desktop never collapses; it is the same bar on one line.
- **Bar 7 for terminal.** Terminal, diff and files are *views*, not verbs. A segmented switcher on the second row carries them with per-view badges and absorbs the next three views without the bar noticing. This is the answer to "no room for the terminal button".
- **Bar 8 for the rest.** The title carries a `▾`; settle, snooze, pin, rename, fork and archive live in that menu with the metadata as its header. On desktop it is the same menu as the §5 right-click menu, so there is one action list, not two.
- **Bar 14's rule as the constraint.** Project and branch are laid out before the title, and the title is the only string allowed to ellipse.
Bar 16 concretely: row one is `‹ Sessions ②` with project, branch and PR at their natural width; row two is the title at 14.5 px carrying a `▾`; row three is the view switcher. Desktop is the same bar on one line in the same order: back, title, identity, views, overflow.

Bar 16 had two faults, and **bar 17** is the corrected version that ships:

1. **Scrolled, it dropped the title** and kept the switcher labels. That is backwards. Bar 4's rule is that the title is the thing that survives the collapse.
2. **The desktop title could vanish entirely.** `.btl{flex:0 1 auto;min-width:0}` shrinks to zero the moment the bar is over-subscribed, so the one string that matters was the first to go. Fixed with a hard floor, `.btl{min-width:110px}`, and stated as a rule: the switcher sheds its labels, then its `⌘J` hint, before the title gives up another pixel.

### Collapse, corrected again (bars 18 and 19)

Bar 17 still had the collapse wrong in two ways, and **bar 18** is what ships.

**The small state carries no modes.** At 46 px the bar is back, the full title, `⌄` and `⋯`. Mode glyphs are exactly what you should not have to decode at the moment the bar is smallest. `⌄` pulls the full bar back without scrolling; `⋯` is everything else, and its menu leads with a **Views** section (Chat `⌘1`, Terminal `⌘2`, Diff `⌘3`, Files `⌘4`) before the session verbs, so modes are reachable from the collapsed state without being drawn in it.

**Collapsing is a position, not a direction.** The expanded bar is the resting state. It is only given up while you are pinned to the bottom of the transcript reading live output; scroll up by any amount and all three bands return, flick back down to the latest message and they go away. Implementation-wise the state is one boolean, `atBottom` (within ~24 px), never a direction delta: direction-based bars jitter under momentum scrolling and can strand a user half-collapsed, and this cannot. `⌄` sets a forced-open flag that clears the next time you return to the bottom.

One deliberate asymmetry: you collapse by scrolling to the bottom and expand by scrolling up *or* by pressing `⌄`. There is no collapse button, because hiding chrome is never urgent and getting it back is.

Desktop never collapses. There is no pixel shortage and a bar that moves on a 1400 px window is noise.

**Bar 19** is bar 18 with bar 11's floating island as the collapsed form: at the bottom there is no bar at all, the transcript runs to the top edge, and an island over it carries back, the name, `⌄` and `⋯`. Same state machine, same menu. It buys 46 px of live transcript; it costs translucency over moving text (the least legible surface in the app), ~40 px less room for the name, an `env(safe-area-inset-top)` problem in the iOS notch strip, and one more layer in the z-order conversation with the sheet and the composer. Ship 18; 19 is a later swap or a setting, since the behaviour is identical and only the collapsed form differs.

### Side by side on desktop

The diff should be readable next to the chat without leaving the session. Two mechanisms, drawn as bars 17 and 20.

**Bar 17: tabs are also panes.** A `⊞` sits after the switcher (`⌘⇧D`). Press it and a second tab lights; the content area splits and each pane gets a 26 px header with its own name, count and close. The bar is unchanged, because the split is a property of the content, not a second chrome. The split is remembered per session, and below roughly 420 px of pane width it folds back to tabs on its own, so a 1100 px laptop cannot get stuck in an unusable layout. Cost: `⊞` is a learned affordance, and split is a state a user can enter and not know how to leave (the per-pane `✕` is the answer, which is why every pane has one).

**Bar 20: views are a dock.** No segmented control anywhere. A 38 px rail of view glyphs lives on the right edge of the content, always visible; clicking one opens it as a resizable pane beside the chat, clicking it again closes it. Side by side is the resting state rather than a mode, there is no `⊞` to discover, and the bar is only ever the session: back, title `▾`, identity, `✓ Settle`, `⋯`. On the phone the rail becomes a `⧉ Views³` button that raises a sheet listing the same views with `⌘1`–`⌘4`, which means bar 18's bar never changes shape between the top of a thread and a scrolled thread. Cost: a permanent 38 px strip, no way to read the current view off the bar, and a bottom sheet is one tap deeper than a tab.

Ship the split (bar 17, carried into 18 and 19). Revisit the dock, drawn as bar 20, if people turn out to live in the diff, because the decision is really one question: is side by side a mode you enter, or the way the app sits?

- **Not taking:** 11 and 12 (translucency and unlabelled corners cost more than the pixels they save), 13 (a session name should not look like an input), 6 (the bottom strip belongs to the composer).

## 13. Nothing counts the sets that grow without bound

Removed from the design, and from anything built from it: every count of settled sessions, and every count
of archived ones.

**The reason is the data model, not the layout.** A number next to Settled or Archived can only come from
one of two places: a scan of every session that ever existed, or a client that is holding them all. Today
the sidebar does the second — `ni8.5` S-10 has the subscription delivering the whole session set and the
search filtering client-side — and that is precisely what stops working after a year of use. Drop those two
counts and the subscription can be bounded to the *live* set, which is bounded in turn by how much work one
person can have in flight. The settled and archived shelves then load only when opened, a page at a time,
and there is no aggregate to maintain or invalidate on every settle, un-settle or scope change.

That is the whole point of the removal. Everything below is the product argument arriving at the same place.

Counts in this sidebar answer one question, *how much is waiting for me*. Needs you, Running, Done unread
and Snoozed all qualify, snoozed included because it wakes up on its own, so its count is a promise about
the near future. Settled is the opposite of all of those: it is where work goes to stop asking. The set only
grows, it never falls on its own, and nobody behaves differently on seeing 41 rather than 44.

So: the Settled shelf header is a caret and a word with no number, the scope picker's Settled row has no
trailing count, "Include settled" is a checkbox with no total, and no badge, chip or header anywhere sums
settled sessions. If you want to know how many are parked, open the shelf and scroll, which is the same
cost as caring.

**Archived** goes the same way, for both reasons. Its count is gone too: `Include archived` is now a
checkbox and nothing else. That leaves one rule rather than two exceptions to remember.

The consequence worth stating plainly: **every aggregate in the sidebar is a live count, and bounded by
construction.** `All 18` is
eighteen sessions you can act on across four projects, not the forty-odd rows in the database. Project chips,
scope rows and group-by-project headers all count the same way, so the number on a control always equals the
number of rows tapping it produces. Any number that disagrees with its own list is a bug.

## 14. Two themes, no custom themes

The design-system migration throws away the old custom themes. What ships is one light and one dark, and
`mobile-first-sidebar.html` now renders in both: a switch in the page header, `prefers-color-scheme` as the
default, and the choice persisted per device.

**The rule that makes it cheap: a token is either a surface or a fill.**

- **Surfaces, and the ink read on them, move.** `--bg`, `--surface`, `--alt`, the two border tokens, the four
  text tokens, and every *status ink* token (`--amber`, `--blue`, `--green`, `--red`, `--indigo`, `--violet`,
  `--brand`) get one value per theme. Amber text has to be dark on white and light on near-black; that is the
  entire job.
- **Saturated fills do not move.** `--amber-f`, `--indigo-f`, `--red-f`, `--green-f`, `--brand-f` and the four
  project colours are the same bytes in both themes, and `--onfill` stays `#0c0d10` on top of them. An Approve
  pill is the same object in light and dark, which is why it stays the loudest thing on screen in both.

One name, two values. A component reading `var(--amber)` is already correct in both themes; if it needs a
second class name to look right in light, the token set is wrong, not the component. §7 of the HTML proves it
by rendering the same list markup twice side by side, differing only by a `data-theme` attribute.

**The brand splits in two.** `#ff2d7b` on white is 3.3:1, so it cannot be text there. `--brand` is the ink and
darkens to `#c9004f` in light; `--brand-f` is the fill and stays `#ff2d7b` in both. The FAB is the same pink in
light mode; the word "Reset" is not.

**Light mode is not dark mode inverted.** In dark the page (`--bg`) is darker than the panels (`--surface`); in
light the page is the slightly grey `#f5f6f9` and the panels are pure white. Cards sit *above* the page in
both, and on light that means lighter, not darker.

**The four things a light mode actually breaks**, all the same failure — a colour written as a literal instead
of a token:

1. **Shadows.** `rgba(0,0,0,.5)` under a sheet reads as depth on near-black and as dirt on white. `--sh` and
   `--shx` drop to roughly a seventh of the opacity in light and pick up a blue cast (`rgba(19,26,37,.14)`) so
   the shadow belongs to the same grey family as the borders.
2. **Glass.** The floating island and the floating button are `rgba(24,25,29,.9)` over a blur; in light they
   become `rgba(255,255,255,.88)`. Same blur, same border token, opposite base.
3. **Scrim.** Not black at lower opacity — a cool grey at `.34`, because a true black wash makes the page under
   a sheet look switched off rather than backgrounded.
4. **Deliberate inversions.** The undo toast and the keyboard tooltip are meant to be the opposite of the page.
   They ride `--inv` / `--inv-ink`, which *swap* between themes rather than shifting. Miss this and the toast
   quietly becomes invisible in one of the two.

**Delivery details that are part of the decision:** the theme is set from a tiny `<head>` script before first
paint, never by a component after hydration (a dark-mode user loading a light flash is a bug report every
time); `color-scheme` is declared alongside the tokens so scrollbars and form controls follow for free; the
preference is local to the device, because a phone in the sun and a desktop at night genuinely want different
answers.

**Why two and not seven.** Custom themes looked free and were not: each one is a surface nobody tests, a
contrast pair nobody checks, and a support question nobody can reproduce. Two themes keeps the contrast matrix
small enough to check in CI on every token pair, and every screenshot in the design document is reviewable in
both with one tap.
