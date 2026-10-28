# Conduit verification map

This directory is the maintained source for verifying conduit's user-facing browser behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- `pnpm build` ran after the last code change, so `dist/` holds the code under test.
- `V=.agents/skills/verify-conduit/scripts/conduit-verify.mjs` and `RUN_ID=<id>` select the CLI and run. `up` returned `{baseUrl, runDir, controlSocket, cdpUrl}`, and `doctor` returned `healthy:true`.
- The instance has one project, `process-test`, one seeded idle session from the `chat-simple` recording, and four harnesses (Claude, OpenCode, Codex, Cursor) replaying recordings.
- The launcher owns Chromium and an attached page at the instance URL, sized 1440x900. `up --phone` selects 393x852 with mobile/touch enabled.
- Never drive `http://localhost:2633` or any instance this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise. Relaunch (`down`, then `up`) for a clean store.
- Prefer `data-testid` and the element ids from `test/e2e/page-objects/` over ARIA refs: `e123` refs change on every snapshot.
- Each agent shell call may be a fresh shell. Begin every call with the `V=` and `RUN_ID` setup lines from SKILL.md, and set recipe variables such as `$D` in that call too; `$D` means `test-results/verify-conduit/$RUN_ID/<feature>`.
- Use the control CLI first. It prints one JSON object per command; command and group `--help` disclose arguments and output shapes. `send` and `wait-settle` wait on turn state, composer state and DOM quiet, so recipes need no fixed sleep.
- For recipes still using `playwright-cli`, run `$V info` and execute its `playwrightAttach` command to attach to the same page. `$S` then means `-s=verify-$RUN_ID`. Do not open a second browser on the main page; a second context (`-s=verify-$RUN_ID-b open`) is fine for cross-browser checks. Attaching late only captures HTTP requests from then on; WebSocket traffic is in `$V ws-log`.
- Read state with `$V eval '() => ...'` rather than eyeballing screenshots. Use `$V ws-log` instead of `?feats=debug`, whose panel covers `#send` at 1440x900.
- Use `$V select-project process-test` for the scope menu, `$V scroll '#session-list-scroller' --to bottom` for list scrolling, and `$V feature-flag debug on` or `off` for debug state. Turn debug off before sending.
- Run `$V features check` after UI, selector or CLI changes and before trusting a recipe. Fix stale selectors, commands and relative links in the same change. Dynamic values are counted as skipped.

## Proof and skip reporting

- Capture the user action and the resulting state: a screenshot and ARIA snapshot before and after.
- Include a short video with change proof. Start with `$V up --video`; `$V down` finalizes all pages' recordings and returns absolute `.webm` paths in `videos`.
- Use `$V network-log --summary` for HTTP status and method/path counts, or `$V network-log --failed` to inspect failures. Requests are recorded from context creation, across reloads.
- Mutation proof includes a second view of the stored value: `$V store ...`, a reload, or a second browser context.
- `store`, `logs --level` and `eval` are for observing and debugging. They are not the user path and must not be used to reach an end state.
- Replay leaves real logins, real model output, and real provider CLIs and binaries unverified.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with playwright-cli`, `Gotchas`. Keep these headings, including the existing driving-section name when its recipe uses the control CLI. Keep implementation details out; name only user paths, stable handles, required state, commands and observable proof.

## Features

- [Chat: create a session and send](./chat.md) covers the draft composer, model picker, send, reply and stored messages for every harness. Proven end to end for Claude, OpenCode, Codex and Cursor on one instance on 2026-10-28 (`test-results/verify-conduit/all4/`).
- [Add a project](./add-project.md) covers the scope chip's Add a project…, the folder picker, name autofill and the new project's draft. Proven harness-independently on 2026-10-28 (`test-results/verify-conduit/a-main/`), with a first send working on Claude and Cursor. OpenCode and Codex hit replay limits in a second project.
- [Session list](./session-list.md) covers search, the Needs you/Running/Unread filters, grouping, the row menu (rename, pin, mark read, archive, delete), Settle and Settings › Archived. Proven with Claude, OpenCode, Codex and Cursor sessions on 2026-10-28 (`test-results/verify-conduit/a-main/`).
- [Terminal](./terminal.md) covers opening the panel, running commands, tabs (add, rename, close), the key bar, font size and scrollback across hide and reload. Proven harness-independently on 2026-10-28 (`test-results/verify-conduit/a-main/`).
- [Settings](./settings.md) covers the eight tabs, device vs server settings and the Server status. Proven harness-independently on 2026-10-28 (`test-results/verify-conduit/a-main/`).
- [Add an account](./add-account.md) covers Settings › Server › Add, the type picker, the new row, the picker gaining the harness, Make default and Remove. Proven for Cursor (added from scratch and used) and a second Claude account on 2026-10-28 (`test-results/verify-conduit/a-acct/`).
- [Fork a session](./fork.md) covers Fork from here, the inherited-history divider and continuing in the fork. Proven for OpenCode (`fork-reply`), Claude and Cursor on 2026-10-28 (`test-results/verify-conduit/fork-oc/`, `fork3/`), and Codex (`fork-native`, `lg-fork/`; `fork-of-fork`, `lg-fork2/`).
- [Side chats](./side-chats.md) covers `$btw`, the parent crumb, the side-thread panel and follow-ups. Proven for OpenCode (`side-thread`), Claude (`side-thread-ask-turn`) and Cursor on 2026-10-28 (`test-results/verify-conduit/side/`), and Codex (`fork-native`) (`lg-btw/`). Mid-turn (Claude, `lg-hold-claude/`) and side-thread permission and question (OpenCode, `lg-perm/`, `lg-question/`) use `hold`.
- [Subagent session viewing](./subagents.md) covers the Worked head, opening the child, the back bar and returning. Proven for Claude (`subagent-task-turn`), Codex (`subagent-spawn`) and Cursor (`subagent-foreground-default-fixed`) on 2026-10-28 (`test-results/verify-conduit/sub/`). Running children (Claude, Codex) use `hold` (`lg-sub/`), and the Claude child transcript uses `foreground-agent-backgrounded-turn` (`lg-reads/`). OpenCode has no recording.
- [Background tasks](./background-tasks.md) covers the task chip, the panel, completion and Stop. Proven for Claude (`background-shell-turn` with `--claude-delay-ms 300`), Codex (`subagent-stop`) and Cursor (`subagent-background-follow-up`) on 2026-10-28 (`test-results/verify-conduit/bg/`). Per-task Stop is reachable with `hold` but fails under replay (`lg-bg/`). OpenCode has no recording.
- [Goals](./goals.md) covers setting a goal, goal met, the details sheet, Clear, Pause (button and typed) and the unsupported state. Proven for Codex (`goal-chain`, `goal-cleared`, `goal-stop`, `goal-paused`) on 2026-10-28 (`test-results/verify-conduit/goal/`). Claude only through `goal-not-met-status-clear`, replayed in one go. Cursor and OpenCode have no goal support.
- [Queued messages](./queued-messages.md) covers queueing while a turn runs, the tray, drain order, Remove, Edit, Run now and image rows. Proven for Claude (pong x3 with `--claude-delay-ms 500`), Codex (`steer`), Cursor (`steer`) and OpenCode (`side-thread-mid-turn`) on 2026-10-28 (`test-results/verify-conduit/b-queue/`, `b-codex/`, `b-cursor/`, `b-oc/`). Claude's Run now ends the first turn `error`.
- [Steering](./steering.md) covers Cmd/Ctrl+Enter, tray Steer and the Steered marker. Proven for Claude (`steer-during-tool-folds`, `queued-input-promoted-to-steer`), Codex (`steer`) and Cursor (`steer`) on 2026-10-28 (`test-results/verify-conduit/b-steer/`, `b-steer2/`, `b-codex/`, `b-cursor/`). OpenCode can't steer; only its queue fallback is shown. The refusal strip is not reached.
- [Stopping a turn](./stopping.md) covers Stop, the paused queue, Resume and stopping with a steer pending. Proven for Claude and Codex (`stop-queued`) on 2026-10-28 (`test-results/verify-conduit/b-queue/`, `b-steer2/`, `b-codex-stop/`). Under replay, Cursor's turn still completes and OpenCode ends `stop_unconfirmed`.
- [Photo attachment](./photo-attachment.md) covers Attach → Add Photos, the chip, remove, the sent thumbnail and stored blob. The provider request is proven for Codex only, on 2026-10-28 (`test-results/verify-conduit/b-photo/`, `b-queue/`). Cursor drops the image, and Claude and OpenCode requests aren't readable under replay. Paste is unsupported.
