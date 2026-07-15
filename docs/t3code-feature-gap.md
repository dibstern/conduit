# t3code → conduit feature gap

What [t3code](https://github.com/pingdotgg/t3code) (Theo/ping.gg's "minimal web GUI for coding agents") has that conduit does not, ordered by usefulness. Sourced from t3code's [docs](https://pingdotgg-t3code.mintlify.app/) and repo; conduit side verified against `src/lib/contracts/ws-rpc.ts`, `src/lib/provider/`, `src/lib/frontend/`, and `docs/agent-guide/architecture.md`.

## Important nuance on "forking" and "rewinding"

Conduit **already has both** — but only at the *conversation* layer:

- **Fork** — `ForkSession` RPC branches from any assistant message (`ws-rpc.ts:810`; `SessionInfo.parentID/forkMessageId/forkPointTimestamp`). This forks the *chat*, not the working tree.
- **Rewind** — `RewindSession` delegates to OpenCode's `session.revert` (`src/lib/handlers/prompt.ts:213`). It rewinds the *conversation*, is OpenCode-only, and does **not** restore files on disk.

t3code's fork/rewind are **git-backed**, which is the actual differentiator. That's why the two git items lead the list below.

---

## Gaps, most useful first

### 1. Git-backed checkpoints + rewind (restores files, not just chat) — **HIGH**
t3code commits a checkpoint per turn; the undo icon on a turn runs `git reset --hard` back to that checkpoint, **reverting the actual working tree** (with a "uncommitted changes will be lost" warning). Conduit's rewind only rolls back the OpenCode conversation — file edits the agent made stay on disk. This is the feature the user called out: the valuable half (undoing the *changes*) is missing. Also provider-agnostic in t3code; conduit rewind is OpenCode-only.

### 2. Git worktree "threads" — true parallel forking — **HIGH**
t3code can launch a thread in an isolated worktree: auto-creates a branch (`t3code/abc123`) under `.t3-worktrees/thread-id/`, so multiple agents run on the same repo without colliding. Conduit has no worktree/branch machinery at all (the only `worktree` references are OpenCode's own project-path field). This is "forking" at the filesystem level — safe parallel experimentation.

### 3. Native git-diff viewing — **HIGH / MEDIUM**
t3code has a side-by-side diff panel over real `git diff`: syntax highlight, unified/split, **filter by conversation turn**, change summaries (`src/auth.ts +45 -12`), and clickable paths that open in the editor. Conduit's `DiffView.svelte` renders LCS diffs of *tool-edit output* only — no git-backed diff, no side-by-side (README lists split/unified diff under "Future plans").

### 4. Git commit + PR workflow — **MEDIUM**
t3code has a Git menu: review uncommitted count, write a message (conventional-commit format), commit all; and "Create Pull Request" auto-generates title/description from commits via the `gh` CLI. Conduit has zero commit/PR UI.

### 5. More providers: Codex + Cursor — **MEDIUM**
t3code is Codex-first and also targets Claude, Cursor, and OpenCode. Conduit supports OpenCode + Claude Agent SDK, but **no Codex and no Cursor** adapter. (Codex is t3code's primary, most-polished path.)

### 6. Remote access / tunnel (T3 Connect) — **MEDIUM**
t3code: Settings → Connections → toggle network access, "Create Link" pairing links to connect phone→desktop, `t3 serve` headless, and a managed `cloudflared` tunnel (T3 Connect) to expose an environment from anywhere. Conduit has HTTPS + Tailscale + QR in its setup wizard, but no built-in pairing links or managed tunnel — reachability is the user's responsibility.

### 7. Global, customizable keybindings + project-script bindings — **MEDIUM / LOW**
t3code ships a global shortcut system editable at `~/.t3/keybindings.json` (toggle terminal `mod+j`, split/diff `mod+d`, new chat/terminal `mod+n`, open in editor `mod+o`, etc.) and lets you bind project scripts (`script.test.run`, `script.build.run`) to keys. Conduit only has per-component keydown handlers (Enter-to-send, Esc-to-close) — no global or user-configurable shortcuts (also on conduit's "Future plans").

### 8. Open project in external editor — **LOW**
`mod+o` opens the repo in your external editor. Conduit has no equivalent.

### 9. Native desktop app (Electron) + native mobile apps — **LOW**
t3code ships packaged desktop builds (winget / Homebrew / AUR) and native iOS/Android apps (`apps/mobile`). Conduit is daemon + web SPA with a solid PWA (service worker, manifest, install, push) — arguably a deliberate choice, but there's no packaged desktop or native mobile binary.

---

## Already at parity (not gaps)

Conduit matches or exceeds t3code on: image upload (paste/drag/camera), slash commands, `@` file mentions, model selection, thinking-level/variant and context-window selection, plan mode, runtime permission modes (allow/allow_always/deny with persist scopes), multi-tab PTY terminal, file browser, multi-project (`/p/<slug>`) and multi-instance management, PWA + Web Push notifications, PIN auth, subagent navigation, todo overlay, Mermaid/syntax rendering, themes, and the setup wizard (mkcert HTTPS, Tailscale, QR).

## Bottom line

Conduit's conversation model (fork + rewind + multi-provider + rich chat UI) is ahead of or level with t3code. **t3code's edge is entirely git-native workflow**: checkpoint-and-restore-files, worktree isolation, real git diffs, and commit/PR flows. If you want the "forking and rewinding" experience the user values most, the high-leverage work is items 1–3 — making rewind restore the working tree and adding worktree-isolated sessions — not re-implementing chat features conduit already has.
