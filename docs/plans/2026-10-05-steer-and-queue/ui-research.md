## Findings per product

Read-only inspection; no files changed. The actual t3code HEAD is `01f894e`, October 4, rather than October 1.

### t3code

- **a. Default: queue**, across providers. The settings schema defaults `followUpBehavior` to `"queue"`. [settings.ts:450–455](/Users/dstern/src/personal/conduit-competitors/t3code/packages/contracts/src/settings.ts:450). Choosing **Steer** varies: Codex calls `turn/steer`; Claude offers SDK input with `priority: "now"`; Cursor and ACP providers use interrupt/restart. Pi/OpenCode advertise active steering. [Codex:5627](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:5627), [Claude:7362–7378](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7362), [Cursor:106–108](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/CursorAdapterV2.ts:106), [ACP:562–564](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.ts:562), [Pi:144–146](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts:144), [OpenCode:146–148](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Adapters/OpenCodeAdapterV2.ts:146).
- **b. Choice:** Settings → General → **Follow-up behavior**, **Queue/Steer**. Default Enter/send uses that preference; Cmd/Ctrl+Enter or modified click uses the opposite. Buttons say **Queue message/Steer message**; empty composer shows **Interrupt**. Mobile offers Settings → **Follow-ups**, with long-press for the opposite action. [SettingsPanels:2832–2868](/Users/dstern/src/personal/conduit-competitors/t3code/apps/web/src/components/settings/SettingsPanels.tsx:2832), [ComposerPrimaryActions:250–279](/Users/dstern/src/personal/conduit-competitors/t3code/apps/web/src/components/chat/ComposerPrimaryActions.tsx:250), [composer.md:37–56](/Users/dstern/src/personal/conduit-competitors/t3code/docs/user/composer.md:37).
- **c. Pending:** queue rows above composer support thumbnails, edit, removal, drag/arrow-key reordering and **Steer** promotion. Cmd/Ctrl+Shift+Enter promotes oldest; Option/Alt+Up edits newest. Steers appear in the transcript labelled **Steer**; consumption-specific undo is **UNVERIFIED**. [QueuedRunsControl:339–483](/Users/dstern/src/personal/conduit-competitors/t3code/apps/web/src/components/chat/QueuedRunsControl.tsx:339), [keybindings:48–50](/Users/dstern/src/personal/conduit-competitors/t3code/packages/shared/src/keybindings.ts:48), [MessagesTimeline:2315–2349](/Users/dstern/src/personal/conduit-competitors/t3code/apps/web/src/components/chat/MessagesTimeline.tsx:2315).
- **d. Storage:** server SQL projections, shared through snapshot/live subscriptions, survive reload and serve multiple clients. Server restart preserves order but holds the queue until **Resume**. [ProjectionStore:1753–1796](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/ProjectionStore.ts:1753), [ws:821–860](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/ws.ts:821), [recovery:278–289](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:278).
- **e. Turns:** native steering appends another user message/turn-item using the existing `runId` and `providerTurnId`. The timeline explicitly excludes steer messages from starting another response header. [Orchestrator:3743–3803,3871–3893](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/src/orchestration-v2/Orchestrator.ts:3743), [timeline logic:778–794](/Users/dstern/src/personal/conduit-competitors/t3code/apps/web/src/components/chat/MessagesTimeline.logic.ts:778).

### OpenCode TUI and web

**July clone and released TUI:** Enter effectively **steers**, despite a **QUEUED** badge. Submission persists a user message, joins the existing loop, and history reloads before subsequent model steps. New assistant messages reference the latest user through `parentID`. [prompt.ts:1046–1070,1092–1096,1186–1188,1343–1346](/Users/dstern/src/personal/conduit-competitors/opencode/packages/opencode/src/session/prompt.ts:1046). Alternate queue submission and pending management are **UNVERIFIED**.

**Released web:** also **steer**; settings actively coerce Queue into Steer. [settings.tsx:354–377](/Users/dstern/src/personal/conduit-competitors/opencode/packages/app/src/context/settings.tsx:354). [#44108](https://github.com/anomalyco/opencode/issues/44108) corroborates: “sending a message while the agent is busy always steers”. The V2 backend already has a durable server inbox and distinct boundary rules. [SQL:140–161](/Users/dstern/src/personal/conduit-competitors/opencode/packages/core/src/session/sql.ts:140), [runner:393–404](/Users/dstern/src/personal/conduit-competitors/opencode/packages/core/src/session/runner/llm.ts:393).

**Separate V2 TUI branch:** Enter steers; Ctrl+X then Enter queues. Ctrl+X then Q manages pending inputs; Enter promotes, Ctrl+D deletes, Ctrl+U retrieves into composer. Empty-composer Enter promotes oldest; pending steers offer **Move to queue/Delete**. [#32157 maintainer comment](https://github.com/anomalyco/opencode/issues/32157#issuecomment-5930208475): “Enter steers”; [V2 source](https://github.com/anomalyco/opencode/blob/22803892bc36c0b4a6eccb3d18e4c3cd40da986b/packages/tui/src/routes/session/index.tsx#L627-L674): “Undo queued prompt”. Release availability and reordering are **UNVERIFIED**.

### OpenAI Codex CLI

**Enter steers; Tab queues** “for the next turn”. [Official CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli). Separate previews say **“Messages to be submitted after next tool call”** and **“Queued follow-up inputs”**; pending steers offer Esc interruption/immediate submission. [preview source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/bottom_pane/pending_input_preview.rs#L96-L172).

Shift+Left/Alt+Up retrieves the latest queued input for editing, enabling cancellation or resubmission as steer. Queues are client `VecDeque`s; steering retains the same `turn_id`. [bindings](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/keymap.rs#L1675), [queue source](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/tui/src/chatwidget/input_queue.rs#L27-L47), [same-turn test, “Steered”](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/tests/suite/pending_input_persistence.rs#L231-L297).

### Claude Code CLI

Enter’s labelled queue is **steer** for ordinary messages during tools: delivery occurs after tools, **“within the same turn”**. Commands wait until turn end. Pending entries appear gray; Up retrieves them for editing/removal, merging resubmitted entries.

**Ctrl+Enter / Ctrl+X Ctrl+S**, **“Send queued messages now”**, flushes pending inputs plus draft, backgrounds eligible work, otherwise interrupts. Esc interrupts and sends already-pending inputs. A plain-message queue-after-turn choice is **UNVERIFIED**. [Official interactive-mode documentation](https://code.claude.com/docs/en/interactive-mode#queue-messages-while-claude-works).

### Cursor Agent

Current generic documentation: **Enter queues**, Cmd/Ctrl+Enter bypasses, appending to the latest user message; entries below the task support drag reordering. Web/Agents Window: **“Send now”/Enter twice steers**, Tab queues. CLI: Enter steers; Enter again interrupts. [Official Agent docs](https://cursor.com/docs/agent/overview#queued-messages).

Historical **1.4** instead documented default steer, Option/Alt+Enter queue, Cmd/Ctrl+Enter interrupt, and Settings → Chat → **“Queue messages”**. These keymaps cannot safely be combined. [1.4 changelog](https://cursor.com/changelog/1-4#more-agent-steerability).

### CodeNomad

Busy messages go directly to OpenCode `promptAsync`; with the inspected legacy backend, this steers. Default Cmd/Ctrl+Enter sends; **Stop session** is separate. **QUEUED** is a positional badge, not delivery metadata. No delivery chooser was verified. [session-actions:168–219](/Users/dstern/src/personal/conduit-competitors/CodeNomad/packages/ui/src/stores/session-actions.ts:168), [keys:238–276](/Users/dstern/src/personal/conduit-competitors/CodeNomad/packages/ui/src/components/prompt-input/usePromptKeyDown.ts:238), [badge:215–220](/Users/dstern/src/personal/conduit-competitors/CodeNomad/packages/ui/src/components/message-block.tsx:215). Messages reload from server history; the executable is configurable, so deployed semantics remain **UNVERIFIED**. [history:634–675](/Users/dstern/src/personal/conduit-competitors/CodeNomad/packages/ui/src/stores/session-api.ts:634), [runtime:115–142](/Users/dstern/src/personal/conduit-competitors/CodeNomad/packages/server/src/workspaces/runtime.ts:115).

## Options table

Pros/cons below are analysis; V2 means the separate OpenCode branch.

| Option | Products | Pro | Con / failure mode |
|---|---|---|---|
| Steer default; alternate queue key | Codex, Cursor 1.4, OpenCode V2 | Fast correction | Accidental steer; hidden shortcut |
| Queue default; alternate immediate key | t3code, current Cursor docs | Sequential tasks | Urgent correction delayed; override may interrupt |
| Global default setting | t3code, Cursor 1.4 | Personal preference | Hidden state changes submission |
| Modified click / long-press | t3code | Pointer/touch access | Poor discoverability |
| Queued row/list promotion | t3code, OpenCode V2 | Decide after enqueueing | Consumption race |
| Empty Enter promotes oldest | OpenCode V2 | Minimal gesture | Accidental promotion |
| Pending steer → queue | OpenCode V2 | Undo delivery intent | Must act before consumption |
| Retrieve, edit, resubmit | Codex, Claude, OpenCode V2 | Reuses composer | Removed/merged entries can confuse |
| Send now / double Enter | Cursor web | Quick escalation | Double submission ambiguity |
| Flush all pending now | Claude | Urgent batch | Tool-dependent background/abort |
| Interrupt-and-send escalation | Codex Esc, Claude Esc, Cursor CLI | Immediate response | Aborts current work |

## Files/URLs inspected

Linked files above; snapshots: t3code `01f894e`, OpenCode `e8b0992` plus upstream release/dev/V2, CodeNomad `d6462ef`, Codex `rust-v0.160.0`; official Claude and Cursor documentation/changelogs.

## Uncertainty

**UNVERIFIED:** Codex restart/shared queues and direct reorder; Claude/Cursor persistence, remaining pending controls and internal turn IDs; CodeNomad pending management/deployed backend; OpenCode V2 release availability.

t3code Claude execution is version-dependent: [declared SDK `^0.3.276`](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/package.json:31) differs from [installed `0.2.77`](/Users/dstern/src/personal/conduit-competitors/t3code/apps/server/node_modules/@anthropic-ai/claude-agent-sdk/package.json:3). SDK 0.3.286 changed immediate inputs to **“join the running turn instead of stopping it”**. Guaranteed noninterrupting behavior here is **UNVERIFIED**. [Official release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.286).