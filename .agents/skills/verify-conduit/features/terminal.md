# Terminal

A user opens a terminal from the Views rail and gets a real shell in the project folder. The panel holds several terminal tabs, each with its own scrollback. Tabs can be added, renamed and closed, the font can be resized, and an on-screen key bar sends keys like Control. Hiding the panel or reloading the page keeps the shell and its scrollback. The terminal does not depend on the harness, so it was proven once.

## Sub-features

- `terminal-open` toggles the panel with **Terminal** on the Views rail. The button shows as pressed while the panel is open.
- `terminal-run` runs a command and shows its output in the project folder.
- `terminal-tabs` covers **+ Terminal**, switching tabs, renaming a tab by double-clicking it, and closing a tab with its ×.
- `terminal-keys` covers the key bar. **Control** then `c` interrupts a running command. Settings › Terminal chooses which keys show (see [Settings](./settings.md)).
- `terminal-font` covers the font size, with increase and decrease buttons.
- `terminal-persist` covers the shell and scrollback surviving hiding the panel, switching sessions and reloading.

## How to get to it (user POV)

- Click **Terminal** on the Views rail at the bottom of the composer, next to Diff and Files. It works from a draft and from an open session.
- Click it again, or use **Close terminal panel**, to hide the panel. The shell keeps running.

## Driving it with playwright-cli

```bash
D="test-results/verify-conduit/$RUN_ID/terminal"
mkdir -p "$D"
$V up
$V click 'role=button[name="Terminal"]'
$V click '#terminal-panel .xterm-screen >> visible=true'
$V type 'echo verify-$RUN_ID; pwd
'
rows='() => [...document.querySelectorAll("#terminal-panel .xterm-rows")].filter(r => r.checkVisibility()).map(r => [...r.children].map(d => d.textContent.trimEnd()).filter(Boolean))'
$V eval "$rows"
$V screenshot --file "$D/01-output.png"

# Second tab
$V click 'role=button[name="+ Terminal"]'
$V click '#terminal-panel .xterm-screen >> visible=true'
$V type 'echo second-tab $((6*7))
'
$V eval "$rows"
$V click 'role=tab[name="Terminal 1"]'

# Control-C from the key bar
$V click '#terminal-panel .xterm-screen >> visible=true'
$V type 'sleep 30
'
$V click 'role=button[name="Control"]'
$V type 'c'
$V eval "$rows"

# Font size, rename, close a tab
$V click 'role=button[name="Increase font size"]'
$V eval '() => document.querySelector("[data-testid=terminal-font-size]").textContent'
$V click 'role=tab[name="Terminal 2"]' --double
$V fill '.term-rename-input' 'build'
$V press Enter
$V click 'role=tab[name="build"] >> [title="Close terminal"]'

# Hide, show, reload
$V click 'role=button[name="Close terminal panel"]'
$V click 'role=button[name="Terminal"]'
$V home
$V click 'role=button[name="Terminal"]'
$V eval "$rows"
$V screenshot --file "$D/02-after-reload.png"
```

Check these results:

- The panel `#terminal-panel` opens with one tab, `Terminal 1`, and a `sh-3.2$` prompt.
- The rows show `verify-<run id>` and then the project folder, `<root>/process-test`.
- **+ Terminal** adds `Terminal 2`, which prints `second-tab 42`. Going back to `Terminal 1` shows its earlier output, unchanged.
- **Control** then `c` during `sleep 30` prints `^C` and gives the prompt back within about a second.
- The font size goes from `13` to `14`, and stays `14` after the reload.
- Double-clicking `Terminal 2` gives a rename box. After Enter the tab reads `build`. Its × removes it, which leaves only `Terminal 1`.
- After hiding and showing the panel, and after `$V home`, `Terminal 1` is still there with all its earlier rows.
- The panel stays open when you switch to another session.

## Gotchas

- Use `$V click 'role=tab[name="Terminal 2"]' --double` to rename a tab.
- With two tabs, `#terminal-panel .xterm-screen` matches both and the click fails. Add `>> visible=true`. Read rows from the visible `.xterm-rows` only, as in `$rows`.
- `type` sends text to whatever has focus. Click the visible `.xterm-screen` first, or the keys go to the composer. End the text with a real newline to press Enter in the shell.
- The shell is `/bin/sh` on macOS, so the prompt is `sh-3.2$`. On Linux it differs.
- Not checked: decrease font size, Settings › Terminal keys other than Arrows, the phone layout, and pasting into the terminal.
