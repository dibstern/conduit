# Fork a session

A user forks a session from one of its replies. Conduit opens a new session that inherits the conversation up to and including that reply, drops everything after it, shows a "Forked from" divider with a collapsible "Prior conversation" block, and lists the fork in the sidebar. The next prompt continues from the inherited history.

## Sub-features

- `fork-reply` forks from an assistant reply with **Fork from here** in its header.
- `fork-context` shows the divider and the expandable inherited history.
- `fork-continue` sends in the fork and gets a reply that only knows the inherited turns.
- `fork-opencode`, `fork-claude`, `fork-cursor`, `fork-codex` are the same journey per harness.

## How to get to it (user POV)

- In a session with at least one finished reply, use **Fork from here** in that reply's header. The button is visible without hovering.
- The session's right-click menu also has **Fork** (`session-ctx-fork`). Use `$V click "#session-list a[href='/s/<id>']" --button right`, then `$V click '[data-testid=session-ctx-fork]'`. This entry point remains unverified.

## Driving it with playwright-cli

OpenCode, the strictest check: the recording remembers words, so the fork's reply proves which turns were inherited.

```bash
D="test-results/verify-conduit/$RUN_ID/fork"
mkdir -p "$D"
$V up --opencode-recording fork-reply
$V send "Remember the word 'alpha'. Reply with only: ok, remembered." --harness opencode --model big-pickle --provider opencode
$V send "Now remember the word 'beta' too. Reply with only: ok, remembered."
mid=$($V eval '() => document.querySelector(".assistant-header").dataset.messageId' | tr -d '"')
$V screenshot --file "$D/01-parent.png"
$V click ".assistant-header[data-message-id='$mid'] [aria-label='Fork from here']"
$V wait-settle
$V send "Which words did I ask you to remember? Reply with only the words."
$V click '.fork-context-toggle'
$V screenshot --file "$D/02-fork.png"
$V snapshot --file "$D/02-fork.aria.yml"
$V store sql "select id, forked_from, fork_point_event, title from sessions" > "$D/03-sessions.json"
```

Claude and Cursor use the default launch. Send once, fork from the last reply, send again:

```bash
$V new-session
$V send 'first' --harness claude --model opus --provider claude   # or: cursor composer-2.5 cursor
mid=$($V eval '() => [...document.querySelectorAll(".assistant-header")].at(-1).dataset.messageId' | tr -d '"')
$V click ".assistant-header[data-message-id='$mid'] [aria-label='Fork from here']"
$V wait-settle
$V send 'in fork'
```

Codex needs `fork-native`, which forks from the first of two replies:

```bash
$V up --codex-turn fork-native
$V new-session
$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex
$V send 'Say hello again'
mid=$($V eval '() => document.querySelector(".assistant-header").dataset.messageId' | tr -d '"')
$V click ".assistant-header[data-message-id='$mid'] [aria-label='Fork from here']"
$V wait-settle
$V send 'What do you remember?'
$V info    # codexStage shows which slice new Codex sessions get
```

Codex fork of a fork uses `fork-of-fork`. Fork B is forked from the parent's reply and gets one turn of its own. Fork C is forked from B's inherited copy of that reply, not from B's own reply:

```bash
$V up --codex-turn fork-of-fork
$V new-session
$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex
mid=$($V eval '() => document.querySelector(".assistant-header").dataset.messageId' | tr -d '"')
$V click ".assistant-header[data-message-id='$mid'] [aria-label='Fork from here']"
$V wait-settle
$V send 'Only on B'
$V click '.fork-context-toggle'    # show B's inherited history
mid=$($V eval '() => document.querySelector(".fork-context-messages .assistant-header").dataset.messageId' | tr -d '"')
$V click ".assistant-header[data-message-id='$mid'] [aria-label='Fork from here']"
$V wait-settle
$V send 'What do you remember?'
```

Check these results:

- After the click, the path changes to the fork's `/s/<id>`, and the sidebar has a row for it.
- OpenCode's fork replies `alpha`, without `beta`. Claude replies `pong`, Codex `Hello from the mock model.`, and Cursor replies with its usual greeting.
- Codex `fork-of-fork`: fork C replies `Hello from the mock model.` with `turnStatus:"completed"`, and `info` shows `codexStage` `{current:2,total:3}`.
- `.fork-divider` reads `Forked from <parent title>`, and `.fork-context-toggle` reads `Prior conversation`. After the click, `.fork-context-messages` holds the inherited user message and reply.
- `store sessions` shows the fork with `forked_from` set to the parent and a non-null `fork_point_event`. Titles: OpenCode `Remember alpha (fork #1)`, the others `Process harness session (fork)`.
- `store messages --session <fork>` marks inherited rows `is_inherited:1` and the new turn `is_inherited:0`.

## Gotchas

- `fork-reply` only offers `opencode/big-pickle` in the picker. Default `claude-opus-4-6` times out in `pick-model`.
- The OpenCode recording always returns the same fork id. A second fork of the same parent reopens the first one. Relaunch for a fresh fork.
- Codex: the launcher splits a trace at each `thread/fork` into a parent slice and child slices. The first Codex session gets the parent slice. Once a Codex session has a finished turn, new Codex sessions get the next slice, and every later session gets the last one. `info` reports this as `codexStage`, and `launcher.log` logs each switch.
- Codex: fork from the reply the recording forked from. `fork-native` forks from the first reply. In `fork-of-fork`, fork C comes from B's inherited reply. Forking from the wrong reply creates the fork, but its send fails with `turnStatus:"error"`, and `codex-trace-report.jsonl` shows a `thread/fork` mismatch.
- Codex: the child slice of `fork-native` has one turn, so only the fork's first send gets a reply. A second send in the fork fails.
- Claude and Cursor fork locally, so creating the fork asks nothing of the provider. Only the first prompt in the fork reaches the replay.
- Once, `#stop` stayed visible for 10 s in a new fork before anything was sent, and `wait-settle` timed out. A fresh run did not reproduce it. If it recurs, screenshot it and record the run: it may be a real UI bug.
