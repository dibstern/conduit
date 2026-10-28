# Side chats (side threads)

A user asks a side question with `$btw <question>` (or `$side <question>`) in a session that has a finished turn. Conduit opens a side thread that inherits the parent's conversation, answers there in Ask mode, and keeps it out of the sidebar. The parent shows an "N Side Thread(s)" control that lists side threads and reopens them.

## Sub-features

- `side-ask` sends `$btw <question>` and lands in the side thread with the answer.
- `side-crumb` returns to the parent through the parent crumb.
- `side-list` opens the parent's side-thread panel and reopens a thread.
- `side-follow-up` continues the side thread.
- `side-mid-turn` asks a side question while the parent's turn is still running.
- `side-permission` and `side-question` answer a permission or question raised inside the side thread.
- `side-opencode`, `side-claude`, `side-cursor`, `side-codex` are the same journey per harness.

## How to get to it (user POV)

- In a session with a finished reply, type `$btw <question>` in the composer and send. A bare `$btw` only opens the list, without creating a thread.
- In a side thread, the crumb (`[data-testid=side-thread-parent-crumb]`) goes back to the parent.
- In the parent, **N Side Thread(s)** (`[data-testid=side-threads-control]`) opens the panel. Each row (`side-thread`) has `side-thread-title`, `side-thread-time` and `side-thread-open`.

## Driving it with playwright-cli

```bash
D="test-results/verify-conduit/$RUN_ID/side-chats"
mkdir -p "$D"
$V up --opencode-recording side-thread --claude-turns side-thread-ask-turn
$V new-session
$V send "Remember the word 'alpha'. Reply with only: ok, remembered." --harness opencode --model big-pickle --provider opencode
$V send '$btw What word did I ask you to remember? Reply with only the word.'
$V screenshot --file "$D/01-side-thread.png"
$V click '[data-testid=side-thread-parent-crumb]'
$V wait-settle
$V click '[data-testid=side-threads-control]'
$V screenshot --file "$D/02-panel.png"
$V snapshot --file "$D/02-panel.aria.yml"
$V click '[data-testid=side-thread-open]'
$V send 'Reply with only: ok, raised.'
$V store sql "select id, parent_id, side_thread, permission_mode, title from sessions where side_thread=1" > "$D/03-sessions.json"
```

For Claude or Cursor, repeat from `new-session` with `--harness claude --model opus --provider claude` or `--harness cursor --model composer-2.5 --provider cursor`. One launch serves all three.

Codex needs its own launch, because the side thread replays the fork slice of `fork-native`. The parent must have exactly one turn:

```bash
$V up --codex-turn fork-native
$V new-session
$V send 'Say hello' --harness codex --model gpt-6.1-sol --provider codex
$V send '$btw What do you remember?'
```

Side question mid-turn (Claude). Hold the parent's second turn before its tool result, ask, then release:

```bash
D="test-results/verify-conduit/$RUN_ID/side-chats"
mkdir -p "$D"
$V up --claude-turns pong-thinking-text-turn,extra-folder-read-turn
$V hold --claude 2:21
$V new-session
$V send ping --harness claude --model opus --provider claude
$V send 'Read the marker' --no-wait
# the parent shows Working and stays there; the hold stops it before the tool result
$V send '$btw What did I say first?'
$V screenshot --file "$D/04-mid-turn.png"
$V release
$V click '[data-testid=side-thread-parent-crumb]'
$V wait-settle
```

Permission or question inside a side thread (OpenCode). Without a hold, the recording answers itself at once:

```bash
D="test-results/verify-conduit/$RUN_ID/side-chats"
mkdir -p "$D"
$V up --opencode-recording side-thread-permission     # or side-thread-question
$V new-session
$V send "Remember the word 'alpha'. Reply with only: ok, remembered." --harness opencode --model big-pickle --provider opencode
$V hold --opencode permission.asked                     # or question.asked
$V send "\$btw Use the bash tool to run printf 'side-thread-approval'. Do not answer without running this command." --no-wait
$V screenshot --file "$D/05-pending.png"
$V click 'role=button[name="Allow"]'                    # question: click 'text=Use the word '"'"'Alpha'"'"'', then 'role=button[name="Submit"]'
$V release
$V wait-settle
$V store sql "select session_id, type, status from pending_approvals" > "$D/06-approvals.json"
```

The question prompt is `$btw Use the question tool to ask me to choose between Alpha and Beta, with header Choice and question Which word should we use? Wait for my answer before continuing.`

Check these results:

- The `$btw` send returns a new `/s/<id>` path, different from the parent's. OpenCode and Claude reply `alpha`. Cursor replies with its usual greeting.
- The crumb reads `Idle <parent title>`.
- Back in the parent, the control reads `1 Side Thread`, the panel has one row titled with the question and timed `just now`, and the sidebar has no row for the side thread.
- `side-thread-open` reopens the side thread, and the follow-up gets a reply: OpenCode replies `ok, raised.`
- Codex: the side thread replies `Hello from the mock model.`, and the store has it with `side_thread:1`.
- Mid-turn: the side thread replies `pong` while the parent's turn is still `running` in the store. After `release`, the parent replies `The file contains: CONDUIT-EXTRA-FOLDER-MARKER-7f3a`.
- Permission: the side thread shows a Permission Required card for `bash`. The parent's sidebar row shows **Approve**, and a toast reads `1 session needs attention`. After Allow and release, the approval is `resolved` and the side thread's turn is `completed`.
- Question: the card reads `Choice`, `Which word should we use?` with Alpha, Beta and Other. The parent row shows **Reply**. After Alpha, Submit and release, the side thread replies `Alpha it is.`
- The store has the side thread with `side_thread:1`, `permission_mode:"ask"`, `parent_id` and `forked_from` set to the parent, and the question as its title. Its messages start with the inherited parent turn.

## Gotchas

- `side-thread` only offers `opencode/big-pickle`. The OpenCode model picker has nothing else.
- `--claude-turns side-thread-ask-turn` is needed for Claude. The parent and the side thread each start the replay from the top, so both get that trace and both reply `alpha`.
- `send` follows the URL change to the side thread, and `sessionId` in its output is the side thread's id.
- Codex: `fork-native` forked from the parent's first turn, so the parent must have exactly one turn when you ask. A follow-up in the Codex side thread fails (`turnStatus:"error"`), because the fork slice has one turn.
- Side-thread permissions and questions are only recorded for OpenCode. Claude and Codex have no side-thread recording with an approval.
- In the OpenCode permission and question recordings, the elapsed time reads tens of thousands of minutes and the user message shows the recording's clock time. Both come from recorded timestamps, not from conduit.
- A Claude hold applies to every Claude session that reaches that prompt and line. A side thread starts the trace list from the top, so hold a later prompt than the side thread will reach.
