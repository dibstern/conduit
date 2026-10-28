# Settings

A user opens Settings from the session bar and changes how conduit behaves. Settings is one dialog with eight tabs. Some settings belong to this browser only (theme, composer controls, context warning, sessions per project). The rest are saved on the server and shared by every browser (auto settle, archive and delete, default session mode, terminal keys, default approval mode). Settings works the same on every harness, so it was proven once.

## Sub-features

- `settings-open` opens the dialog from **More actions** and closes it with the close button.
- `settings-general` covers You (avatar), Appearance (theme), Composer (controls, context warning), Notifications, Sessions (default mode, sessions per project, settle, archive, delete), Worktree cleanup and Advanced (debug).
- `settings-device` covers device settings that live in this browser: theme and composer controls.
- `settings-server` covers server settings that survive a reload and reach every browser: settle after, terminal key bar, Claude approval mode.
- `settings-tabs` covers the Terminal, Models & agents, Claude, Jev, Archived, Usage and Server tabs.
- `settings-server-status` covers the Server tab's version, port and connected browser count.
- The Archived tab is covered in [Session list](./session-list.md). Accounts on the Server tab are in [Add an account](./add-account.md).

## How to get to it (user POV)

- On desktop, click **More actions** (the ... button) in the session bar, then **Settings**. This works from a draft too.
- On a phone (`up --phone`), the sidebar has its own settings button (`list-bar-settings`). Unverified here.
- The model picker's **Add account** and the Usage strip's **Usage settings ›** also open Settings on a tab. Only the first was walked, in [Add an account](./add-account.md).

## Driving it with playwright-cli

```bash
D="test-results/verify-conduit/$RUN_ID/settings"
mkdir -p "$D"
$V up
$V click 'role=button[name="More actions"]'
$V click '[data-testid=overflow-settings]'
$V snapshot --file "$D/01-general.aria.yml"
$V screenshot --file "$D/01-general.png"

# Server setting: Settle idle sessions after 3 days -> 1 week
$V click 'role=button[name=/Settle idle sessions after/]'
$V click 'role=menuitemradio[name="1 week"]'
# Device settings: composer controls and theme
$V click 'role=radio[name="Words"]'
$V click 'role=button[name="Theme: Dark"]'
$V click 'role=menuitemradio[name="Light"]'
$V eval '() => [localStorage.getItem("conduit-theme"), localStorage.getItem("conduit-composer-preferences"), document.documentElement.className]'

# Terminal tab: hide the arrow keys on the terminal key bar
$V click '[data-testid=settings-tab-terminal]'
$V click 'role=switch[name="Arrows"]'
# Claude tab: default approval mode Ask -> Edits
$V click '[data-testid=settings-tab-claude]'
$V click 'role=button[name=/Default approval mode/]'
$V click 'role=menuitemradio[name="Edits"]'

# Walk the other tabs
for t in models surfacing archived usage server; do
  $V click "[data-testid=settings-tab-$t]"
  $V snapshot --file "$D/tab-$t.aria.yml"
done
$V eval '() => ["server-status-version","server-status-port","server-status-browsers"].map(id => document.querySelector(`[data-testid=${id}]`)?.textContent.trim())'

# Second view: reload and the files on disk
$V home
$V click 'role=button[name="More actions"]'
$V click '[data-testid=overflow-settings]'
$V screenshot --file "$D/02-after-reload.png"
cfg=$($V info | node -pe 'JSON.parse(require("fs").readFileSync(0)).configDir')
grep -o '"autoSettleAfterDays":[0-9]*' "$cfg/daemon.json"
grep -n 'arrows\|defaultPermissionMode' "$cfg/settings.jsonc"
$V click '[data-testid=settings-close-btn]'
```

`send` and `pick-model` work with either **Icons** or **Words** controls.

Check these results:

- General opens first, with Theme `Dark`, Controls `Icons`, Context warning `80%`, Default session mode `Local`, Sessions per project `6`, Settle `3 days`, Archive `30 days`, Delete archived `30 days`, Advanced `Debug off`. Browser alerts are on, push and sound are off, and the page says push is blocked by the browser.
- Light theme puts `light-theme` on `<html>` and `conduit-theme` = `light` in localStorage. Words gives `conduit-composer-preferences` = `{"controls":"words","contextWarning":80}`.
- `daemon.json` holds `autoSettleAfterDays: 7`. `settings.jsonc` holds `terminalKeys.bar.arrows: false` and `"defaultPermissionMode": "acceptEdits"`.
- With Arrows off, the arrow keys are gone from the terminal key bar. With Edits, a new draft's Approvals pill reads `Auto-accept edits`.
- After the reload, all five values hold: light theme, Words, 1 week, Arrows off, Edits.
- In a separate browser context the theme is still Dark and Controls still Icons, but Settle reads `1 week`. Device settings stay local; server settings are shared.
- Models & agents shows the default model `Not set` for all four harnesses and Title generation `Claude · Claude Opus (latest)`.
- Usage shows Claude `12%` / `37%` and Cursor `Usage isn't enabled`.
- Server shows version `0.1.3` (the same as `package.json`), `port <baseUrl port>` and `· 1 browser connected`. It also has sections for Access, Security (PIN Off), Power, Advanced, Logs, Instances, and the Claude, Cursor and Codex accounts and OpenCode servers.

## Gotchas

- `reload` keeps the current URL and waits for the composer. Use it to prove settings persist. `home` navigates to `/`.
- The Claude tab shows `Checking…` for a moment before its status loads. Wait for it before you snapshot.
- `$V eval` on `[role=dialog]` can return null even with Settings open. Query `document.body` or a testid instead.
- Push notifications can't be turned on in the launched Chromium (the browser blocks them), so push is unverified.
- Not changed here: avatar, context warning, sessions per project, worktree cleanup, debug, Jev, the Server tab's PIN and access options. Their controls were seen but not saved.
