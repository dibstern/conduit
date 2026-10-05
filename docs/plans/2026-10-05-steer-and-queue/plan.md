## Problem Statement

While an agent is working, I often want to add something or correct it. Conduit gives me no say in what happens to that message, and the answer depends on which provider I'm using:

- **Claude** holds every mid-turn message until the turn finishes, so a correction ("stop, wrong file") arrives too late to matter.
- **OpenCode** folds every mid-turn message into the running turn, so a follow-up meant for later derails the current work.
- **The input box says "Reply to steer…"** for both, which is wrong for Claude.
- **The "queued" shimmer is a guess** the browser makes from timing. It is wrong after a reload and invisible to my other tabs and devices.
- **Once sent, a message can't be cancelled or edited.** A Claude message waiting in the runner is lost if the runner restarts.

## Solution

When the session is busy, **Send queues the message** by default, and **a second gesture steers it** into the running turn. This is the same for Claude and OpenCode.

- **Queued messages sit in a tray above the input box.** Conduit stores them, so they survive reloads and restarts, and every client sees the same tray. Each row can be **steered**, **edited** or **removed** for as long as it is queued.
- **The queue sends one message at a time** after each turn finishes normally. After Stop or an error it waits until I press Resume.
- **A steered message joins the running turn** at the agent's next tool boundary. If the turn ends first, it becomes the next turn.
- **The transcript shows each message where the agent actually read it.** A message enters the transcript when the provider starts it, not when I press Send, so the transcript order is always the true order.

Queue is the default because it can be undone and a steer can't. A queued message can be promoted to a steer at any time. Once a steer reaches the provider, nothing can recall it, and Claude still runs it after Stop.

## User Stories

1. As a user, I want Send to queue my message while the agent is busy, so that a follow-up never derails work in progress.
2. As a user, I want Cmd/Ctrl+Enter to steer my message into the running turn, so that a correction lands before the agent goes further.
3. As a user, I want Cmd/Ctrl+click on the send button to steer, so that I can steer with the mouse.
4. As a user, I want the send button to read "Queue message" while the agent is busy, so that I know what Send will do before I press it.
5. As a user, I want the send button's tooltip to name both the click action and the steer shortcut, so that I can discover steering without docs.
6. As a user, I want the send button to read "Send" when the session is idle, so that queue and steer only appear when they mean something.
7. As a user, I want Stop to replace Send when the input box is empty and the agent is busy, so that stopping keeps working as it does today.
8. As a user, I want queued messages to appear in a tray above the input box, so that I can see what will run next.
9. As a user, I want each tray row to show the message text, any attached images, and its state, so that I can tell rows apart at a glance.
10. As a user, I want a Steer action on each queued row, so that I can decide to steer after I have already queued.
11. As a phone user, I want to queue and then tap Steer on the row, so that I can steer without a keyboard shortcut or long-press.
12. As a user, I want a Remove action on each queued row, so that I can drop a message I no longer want sent.
13. As a user, I want an Edit action on each queued row that moves its text and images back into the input box, so that I can rewrite it and send it again as a queue or a steer.
14. As a user, I want a steered message to show as "Steering" in the tray until the agent reads it, so that I know it was handed over and is waiting for a tool boundary.
15. As a user, I want a steered message to leave the tray and enter the transcript at the moment the agent reads it, so that the transcript shows exactly when it took effect.
16. As a user, I want a steered message in the transcript to carry a small "Steered" label, so that I can tell it joined a turn that was already running.
17. As a user, I want a steer that misses the tool boundary to run as the next turn, so that my message is never dropped.
18. As a user, I want two steers sent during one tool call to both join at the same boundary, so that I can send several corrections quickly.
19. As a user, I want the queue to send the oldest message once the current turn finishes normally, so that queued work runs in the order I wrote it.
20. As a user, I want the queue to wait until any pending steers have been read before sending the next queued message, so that a steer is never overtaken by a queued message.
21. As a user, I want the queue to send one message per finished turn, so that each queued message gets its own answer.
22. As a user, I want the queue to stop after I press Stop, so that stopping the agent stops everything I lined up.
23. As a user, I want the queue to stop after a turn fails, so that queued work doesn't pile onto a broken session.
24. As a user, I want a paused queue to say "Paused" with a Resume button, so that I know why nothing is running and how to restart it.
25. As a user, I want Resume to send the next queued message, so that I control when work continues after a stop or failure.
26. As a user, I want the queue to carry on by itself after any later turn finishes normally, so that sending a new message after a Stop doesn't strand the queue.
27. As a user, I want my queue to survive a page reload, so that refreshing the browser never loses queued work.
28. As a user, I want my queue to survive a conduit restart, so that a crash or upgrade never loses queued work.
29. As a user, I want the queue after a conduit restart to follow the real outcome of the turn that was running, so that a turn that survives the restart lets the queue carry on and a turn that was cut off pauses it.
30. As a user with several tabs or devices open, I want every client to show the same tray, so that I don't double-send from another device.
31. As a user with several clients open, I want a remove, edit or steer from any client to update all of them, so that the tray is always the truth.
32. As a user, I want acting on a row that has just started to do nothing and tell me it already started, so that a race never sends a message twice.
33. As a user, I want each queued message to keep the model, agent and variant I had selected when I queued it, so that changing the picker afterwards doesn't change lined-up work.
34. As a user, I want a steer to be refused, with a reason and my text left in the input box, when my selected model, agent or variant differs from the running turn's, so that I'm never surprised that a steer used the running turn's model.
35. As a user, I want slash commands to be queue-only, with a steer refused and my text left in the input box, so that a command never runs in the middle of a turn.
36. As a user, I want Steer to be disabled while a permission or question prompt is open, so that I answer the prompt first and the agent isn't given two conflicting inputs.
37. As a user, I want Steer to be hidden when the provider can't report when it reads a message, so that conduit never offers a steer it can't place in the transcript.
38. As a user, I want Stop's tooltip to warn that a pending steer will still run, so that I'm not surprised when it runs after I stop.
39. As a user, I want a pending steer to stay in the tray after Stop until it runs, so that I can see it is still coming.
40. As a user, I want the processing indicator and its timeout to start when conduit hands my message to the agent, so that a long queue never times out a message that hasn't been sent.
41. As a user, I want the input box placeholder to describe what Send will do, so that the wording no longer claims Send steers when it queues.
42. As a user, I want queued and steered messages to behave the same on Claude and OpenCode, so that I don't have to remember per-provider rules.
43. As a user, I want the first message in an idle session to send immediately, so that the queue never gets in the way of normal use.
44. As a developer, I want the turn for a steered message to start when the provider reads it, so that there is still at most one open turn per session.
45. As a developer, I want the previous turn to close when a steer starts, so that the turn the steer joined splits into two clean turns.
46. As a developer, I want each provider result to settle its inputs by id, finishing exactly one of them, so that one result can answer several inputs and a turn is never reported done twice.
47. As a developer, I want pending inputs stored as canonical events and projected like messages, so that the tray is rebuilt from the event store and streamed like the transcript.
48. As a developer, I want the browser's timing heuristics for "queued" deleted, so that one source of truth drives the tray.
49. As a developer, I want the steer scenarios recorded once from the real Claude SDK and replayed on every run, so that tests are fast, deterministic and offline but still match real wire behaviour.
50. As a developer, I want every send to go through one session inbox with three commands, so that queueing, draining, pausing, steer gating and races live in one place.
51. As a developer, I want provider adapters to hand an input over at once and never hold it, so that conduit's queue is the only queue.
52. As a developer, I want each adapter to place a user message when its provider reads it, under the provider's own message id, so that conduit's transcript and the provider's history always agree.
53. As a developer, I want the server to be the only judge of whether a steer is allowed, so that the browser and the server never disagree.
54. As a developer, I want each input to carry one id from the browser to the provider seam, so that no provider echo is ever matched to its sender by order or text.

## Implementation Decisions

### Terms

These terms are new. They're not yet in the glossary; add them via `/grill-with-docs`.

- **Input**: a message the user sent. **Turn**: the work done in answer to one input. Today both are created together at send. This spec separates them.
- **Input id**: the one id an input carries from the browser to the provider seam. The browser mints it, the way it mints a command id today.
- **Pending Input**: an input that has been admitted but has not started. It is either **queued** (held by conduit) or **steering** (handed to the Provider Runtime while another turn is open, waiting for a tool boundary).
- **Handoff**: conduit giving an input to the Provider Runtime.
- **Started**: the moment the Provider Runtime reads an input. Its adapter places the user message in the transcript then, and that message starts the input's turn.
- **Delivery**: `queue` or `steer`, chosen by the user at send.
- **Session Inbox**: the conduit module that owns every input from send until handoff.

### The rule

> An input becomes a turn when it **starts**, not when it is sent. When an input starts, any turn still open in that session is closed.

This keeps the existing invariant of **at most one open turn per session**, which the model-resolved handling already depends on.

### Modules and seams

| Module | Interface | What it hides |
|---|---|---|
| **Session Inbox** (new, relay) | 3 commands in, 1 trigger (bus advance), publishes nothing | queue, drain, pause, the steer rule, races, restart |
| **Provider seam** (`ProviderInstance`, existing, 2 adapters) | 1 required input id, 1 capability, 2 invariants | how each SDK steers, places user messages and settles |
| **Pending-input read model** (new projection on the existing detail stream) | 1 table, 2 new stream arms | tray state for every client, with catch-up |
| **Projector** (existing) | one new rule | turn splitting and the Steered label |
| **Frontend** | renders the arms, calls the 3 commands | nothing: it holds no queue logic and no steer rule |

### Session Inbox

**Interface:**

- **`submit(inputId, request, delivery)`** is the composer's only send. On an idle session the input is handed off at once, whatever the delivery. On a busy session it is queued, or handed off as a steer. A retried submit with the same id is a no-op.
- **`sendNow(inputId)`** hands a queued input off now. On a busy session it steers; on an idle (paused) session it starts the next turn. This one command is both the row's **Steer** and the tray's **Resume**, which calls it on the oldest row.
- **`cancel(inputId)`** drops a queued input. **Edit** is `cancel` plus the browser putting the row's text and images back in the input box. The browser already has them from the tray row.
- **Errors:** a command is rejected with a typed reason, either `already_started` (also covers unknown ids) or a steer reason. Nothing else.
- **Ordering:** commands and drain checks run one at a time per session.
- **It publishes nothing.** Its output is canonical events, which reach browsers through the read model and the detail stream like every other event.

**Implementation:**

- **A pure decider** takes the session's inbox view and one command or drain check, and returns canonical events, an optional handoff, or a rejection. Same style as `decideRelayCommand`.
- **A thin, stateless shell** serialises per session, reads the inbox view, runs the decider and commits its output.
  - The view is read from read models on every call: the pending-input rows, session status, open prompts (`pending_approvals`), the running turn, the last turn's outcome and the provider's `steering` capability.
  - Holding no state in memory is what makes restart free: there is nothing to rebuild.
- **Drain trigger:** a `SessionEventBus` advance for a session with queued rows, plus one sweep at startup. The sweep is needed because the Claude startup and replay paths commit without publishing to the bus.
- **Drain rule:** hand off the oldest queued input when the session is idle, no input is steering, and the last turn ended normally.
- **Pause is derived, not stored.** The queue is paused exactly when it is non-empty and the last turn ended interrupted or failed. A later turn that ends normally lets draining continue.
- **The steer rule is a private pure function, `steerBlocker`.** Reasons:
  - the provider lacks `steering`;
  - a permission or question prompt is open;
  - the request's model, agent or variant differs from the running turn's;
  - the text is a slash command.
  The server is its only caller. The browser never re-implements it (see Browser contract).

**Deletion test.** Delete the inbox and the drain rule, pause, race rejection and the steer rule each reappear in three places: the relay handlers, both adapters (Claude's runner gate is already a hidden queue), and the browser's timing heuristics. It earns its keep.

### Handoff

The inbox hands off through `ProviderTurnService.sendTurn`, which keeps today's durable path.

- **`input.sent` and its `send_turn` outbox row commit in one transaction** through `decideDurableSendTurnCommand`. The outbox command id is the input id, so a retried handoff dedupes on its receipt. A crash can neither lose a handoff nor send one twice.
- **The processing status and its timeout start at handoff,** not at admission. A queued input never starts the timeout. A steer handed off to a busy session does not reset it.
- **Claude title generation starts at the session's first handoff,** replacing the call inside `maybePersistClaudeUserMessage`.
- **A handoff that ends without its message placed** (it failed, or the provider dropped it) is placed by `ProviderTurnService`. Its turn ends failed or interrupted, so the transcript shows the message and the error, as today, and the queue pauses.
- **Finalise once per provider result.** Today `handleDispatchResult` runs once per dispatched input. When one result answers several inputs, only the input that owns the result finalises: status, timeout, `done` and provider state updates. The rest resolve `joined` and finalise nothing.

### Inbox and outbox

The durable provider command outbox stays as it is. They hold different things:

- **The inbox holds inputs conduit is keeping.** Cancel is a conduit-only operation, so it is always available. A queued input never enters the outbox.
- **The outbox holds handoffs in flight** to the provider.
- **Restart:** queued inputs survive as events and their projection. Handoffs already in the outbox are recovered by the existing runner recovery. Claude runners are re-adopted, so a turn that was running may still end normally.
  - The inbox waits for that turn's real outcome, through the startup sweep and the bus. It pauses only if the turn ends interrupted or failed.
  - This includes recovery that can't re-adopt a runner and closes the turn as interrupted.
- **No new source-of-truth table.** Per ADR-0004, queued inputs are shared conversation state, so they are canonical events. `pending_inputs` is a projection, like `messages` and `turns`.

### Canonical events

Every input follows one path: `input.admitted`, then `input.sent`, then started. `input.cancelled` can end it before it is sent.

- **`input.admitted`** carries the input id, the delivery, and the full send request captured at admission: text, images, model, agent, variant and whether the model was user-selected.
- **`input.sent`** carries the input id. An idle send or a direct steer emits it in the same commit as `input.admitted`.
  - It is not redundant with the `send_turn` receipt. A receipt is not an event, so it neither advances the bus nor updates the projection, and other clients would never see a row turn from Queued to Steering.
- **`input.cancelled`** carries the input id. It covers Remove and Edit.
- **Started** is the user `message.created` the adapter places. Its payload gains an optional `inputId`, which links the message to its input.
- **All three new events are persistence-only in the relay translation.** Browsers get them through the detail stream.
- **Register each in all four exhaustiveness guards:** the Claude produced/not-applicable lists, the relay translation switch and its test set, the provider-runtime-event reclassification list, and the guard snapshot and event count.
- **Cost:** two small events per message, including idle sends. The single path is worth it: an idle send is a drain with an empty queue.

### Provider seam delta

`ProviderInstance` already has two adapters, so it is a real seam. The change shrinks its interface.

1. **One required input id.** `SendTurnInput` loses `turnId`, `userMessageId` and `commandId` and gains `inputId`.
   - The turn id is already the id of the user message that starts it, so a separate random turn id adds nothing.
   - Retry facts such as `commandAttempt` stay.
2. **`sendTurnEffect` hands off at once.** Adapters never hold, gate or reorder an input.
   - The inbox only hands off an input that should start now: on an idle session, or as a steer.
   - So there is **no `delivery` field.** Each adapter always uses its provider's steer mode, which on an idle session simply starts a turn.
3. **One static capability, `steering`.** Claude is true. OpenCode is true only once its started signal is verified.
4. **Placement invariant.** The adapter places the user message when its provider reads the input: at handoff on an idle session, at the provider's started signal for a steer.
   - The message id is the provider's own id for that message, so provider history and conduit's transcript always agree. `inputId` links it back.
   - No new Provider Runtime Event types. A provider that drops an input resolves its `sendTurnEffect` as cancelled.
5. **Settlement invariant.** Each provider result resolves exactly one input with that result, the latest one started. Every other input it covered resolves `joined`.
6. **Contract invariant, pinned by trace replay (ADR-0002):** every handed-off input is placed exactly once, or resolves unplaced as cancelled or failed. A placement always comes before any assistant output that answers it.

### Claude adapter internals

Requires Claude Agent SDK ≥ 0.3.289, which is already installed.

- **Send every input with `uuid`** set to the input id and `priority: "next"`. The Claude message id is therefore the input id.
- **Place on an idle query at handoff, and mid-turn at `command_lifecycle: started`.** This moves `maybePersistClaudeUserMessage` into the adapter, and `started` replaces the current "pending assistant boundary" guess: the next `message_start` opens a new assistant message.
- **The turn admission gate shrinks** to changes that need a query restart, such as an agent switch. A steer never needs one, because the steer rule rejects a steer whose agent differs.
- **Settle by id, not by order.** The FIFO of turn waiters becomes a map keyed by input id. A `result` settles every id in its `user_message_uuids`: the latest started gets the result, the rest `joined`.
- **`cancelled` before `started`** resolves that input as cancelled. **`queued`** is dropped.
- **Decode the new frames.** The Claude SDK message schema learns `command_lifecycle`, `user_message_uuid` and `user_message_uuids`. Until then, ADR-0001 skips and logs them.
- **No per-session `msg_lifecycle_v1` detection.** The pinned SDK always advertises it, and re-recording traces on each SDK upgrade (ADR-0002) catches a regression.
- **Stop with a steer pending.** Stop still calls `interrupt()`. The SDK reports the steer as still queued and runs it as its own turn afterwards. Conduit accepts this, keeps the row as Steering until it starts, and warns about it in Stop's tooltip.

### OpenCode adapter internals

The client is already on `@opencode-ai/sdk/v2` (1.18.34).

- **Hand off through the v2 prompt call** with `delivery: "steer"`.
- **OpenCode mints the message id.** Its ids are `msg_`-prefixed and must ascend, so conduit never passes its own. The adapter learns OpenCode's id for the input and tags OpenCode's user `message.created` with the input id.
  - On an idle session that is today's echo, now carrying `inputId`.
  - For a steer, placement waits for `session.next.prompted`, matched by id. Its decode schema already exists, but nothing consumes it yet.
- **History reconcile stays correct for free:** the placed message has OpenCode's id, so reconcile matches it instead of adding a duplicate.
- **Unverified:** whether the installed server emits `session.next.prompted`, honours `delivery`, and returns the new message's id from the prompt call.
  - The OpenCode ticket starts by capturing live traffic (ADR-0002).
  - Without a per-input signal, `steering` stays false and the adapter places at handoff. Queue still ships.

### Pending-input read model

- **A `pending_inputs` projection,** one row per pending input: input id, session, text, images, request, state (`queued` or `steering`) and version.
  - `input.admitted` inserts a queued row. `input.sent` marks it steering if another turn is open, and deletes it otherwise.
  - `input.cancelled`, or a user `message.created` carrying its `inputId`, deletes it.
  - Deletes leave tombstones, so catch-up can report removed rows.
- **The session-detail stream gains two arms,** so the tray rides the stream the browser already holds for the transcript, with the same resume and catch-up.
  - `pendingInput`: one tray row. The base read returns every row, whatever transcript page it returns.
  - `inbox`: `{ paused, steer: reason | null }`, computed on read. `steer` covers only the reasons that don't depend on the draft: no `steering` capability, or an open prompt.
- **One stream keeps the handoff in order.** A row leaving the tray and its message entering the transcript arrive on the same ordered stream.
- **This extends an existing adapter** of the `SubscriptionSource` seam. It adds no new seam and no new RPC.

### Browser contract

- **Three RPC methods** replace today's send call: `input.submit`, `input.sendNow` and `input.cancel`. Each returns ok or a typed rejection.
- **No pushed snapshot.** The tray is the two detail-stream arms.
- **The `user_message` broadcast is deleted.** An idle send appears when the adapter places it, milliseconds after handoff.
- **Schemas live in `src/lib/contracts/`.**

### Projector

- **On user `message.created`,** close any other open turn in the session, then insert the new turn.
  - If it closed one, the message is marked `steered`, which drives the transcript's "Steered" label. Adapters never decide this.
  - A fold therefore splits into two turns. A is the prompt plus its tool call; B is the steer plus the reply.
  - The closed turn ends at B's start time, which also feeds read-state turn ends.
- **The single folded `result` completes B,** the turn that owns the last assistant message.
  - That result's usage covers both A and B, so B is over-counted and A under-counted. This is accepted for now.
  - Session cost totals stay correct.
- **A steer that misses the boundary needs no special handling.** B starts after A completes.
- **`pending_inputs` follows the rules above.**

### Frontend

The frontend renders the two arms and calls the three commands. It holds no queue logic and no steer rule.

- **A pending-input tray above the input box.** Rows show the text, an image count and a state chip: **Queued** or **Steering**.
  - Queued rows offer **Steer**, **Edit** and **Remove**.
  - When paused, the tray header shows **Paused** and **Resume**.
- **Send button labels:**
  - idle: "Send";
  - busy with content: "Queue message";
  - busy and empty: Stop.
  - Cmd/Ctrl+Enter and Cmd/Ctrl+click steer, and the tooltip names both.
- **Steer availability:**
  - when `inbox.steer` is "no `steering` capability", Steer is hidden;
  - when it is "a prompt is open", Steer is disabled and the tooltip says so;
  - a steer refused for a draft-dependent reason (model, agent or variant differs, or a slash command) shows the reason beside the input box and leaves the text in it.
- **The transcript shows a user message only once it has started.** A started steer carries a "Steered" label.
- **Delete the timing heuristics.** `sentDuringEpoch`, `turnEpoch`, `waitingBehindReply`, `isQueued` and the queued shimmer go away, and the placeholder no longer says "Reply to steer…".

### Code this deletes

- **`PendingSendOwnership`**, and the `resolveOrigin` hook it feeds into the OpenCode message poller and event translator. It matches provider echoes to senders by order and text; `inputId` on the placed message replaces it.
- **The prompt handler's `user_message` broadcast.**
- **`maybePersistClaudeUserMessage`**, which moves into the Claude adapter.
- **`SendTurnInput.turnId`, `userMessageId` and `commandId`.**
- **Claude's FIFO turn waiters** and its "pending assistant boundary" guess.

### Alternatives considered

- **A queue inside each adapter,** extending Claude's runner gate or using OpenCode's `delivery: "queue"`. Rejected: two implementations, not cancellable, lost when a runner restarts, and Claude's survives Stop.
- **A queue in the browser.** Rejected: lost on reload and invisible to other clients.
- **Queued inputs as held outbox rows.** Rejected: an outbox row means "side effect requested". A hold state would make the reactor skip rows, and cancel would mutate rows. It mixes intent conduit is keeping with calls in flight.
- **A `delivery` field on `sendTurnEffect`.** Rejected: each adapter would implement a queue mode the inbox never uses.
- **Separate promote, resume and edit commands.** Rejected: each is `sendNow` or `cancel`, so five commands would do the work of three.
- **The inbox placing user messages** (the first design pass). Rejected: OpenCode mints its own message ids, so the inbox would need the provider's id anyway and would just relay it. Adapters already place OpenCode's echo.
- **One `steerBlocker` shared by browser and server,** fed by session facts in a published snapshot (first pass). Rejected: it put the running turn's model, agent and variant on the browser contract, and the picker isn't evented, so the browser's copy could go stale.
- **Dropping `input.sent` for the `send_turn` receipt.** Rejected: see Canonical events.
- **An inbox-published snapshot, or a third subscription for the tray.** Rejected: both add a second push path beside the detail stream, and lose the ordering between a row leaving the tray and its message arriving.
- **A `ProviderTurnService` result hook as the drain trigger.** Rejected: it misses turns that end through recovery. The bus covers both providers, and the startup sweep covers the two paths that skip it.

## Testing Decisions

**What makes a good test here:** assert what the user sees and what is durably stored, not runtime internals. That means:

- tray rows and their states;
- button labels;
- transcript order;
- `turns` rows;
- canonical events in the event store.

Never assert on the inbox's decider, the waiter map, deferreds or translator state. The inbox's interface is the test surface, and its pure decider is an internal seam with no tests of its own.

### Which seams each test crosses

| Test | Crosses |
|---|---|
| Claude replay lane | browser contract, Session Inbox, Provider seam (Claude adapter on a replayed SDK), projector, detail stream, UI |
| Record mode | the same, against the real Claude SDK |
| Visual acceptance | the UI only, with the detail stream's tray arms mocked over the WebSocket |
| Live OpenCode | the Provider seam's second adapter, against a real server |

### 1. Claude replay lane, the main seam

Playwright drives the real UI against a real relay whose Claude SDK replays committed Runtime Traces. Prior art: the Claude replay spec and its replay fixture, which already reads the event store.

**One extension: multi-input traces.** In a trace with more than one input, the replayer:
- holds before the `command_lifecycle: queued` frame of each later input until conduit pushes its next prompt;
- maps the recorded message ids, in order, to the input ids conduit actually sent;
- answers `interrupt()` with the recorded receipt.

Write down the replayer's new failure modes first, and pin them alongside the existing ones in the replayer's unit test. Examples:
- a prompt arrives that no recorded input matches;
- a recorded input is never sent;
- ids are mapped out of order;
- an interrupt arrives that the trace doesn't contain.

Scenarios:
- steer during a tool: one result, two turns, steer placed after the tool result;
- steer that misses the boundary: two results;
- two steers at one boundary;
- Stop with a steer pending: the steer still runs, and the queue pauses;
- queue drains after a normal end, one input per turn;
- Resume after a paused queue;
- remove and edit a queued input;
- promote a queued input to steer;
- reload with a non-empty tray: the tray survives;
- a second client sees and acts on the same tray;
- a row that has already started rejects actions;
- a steer refused for a model mismatch leaves the text in the input box;
- a handoff that fails before it starts places the message and the error, and pauses the queue;
- a folded result finishes once: one completed turn and one `done` per result;
- restart with a turn running and a non-empty queue: the queue follows that turn's real outcome. If the lane can't restart the relay, this scenario moves to the daemon lane.

### 2. Real Claude SDK E2E, recorded once and replayed after

The same scenarios have an opt-in **record mode** that runs through conduit against the real Claude SDK, with Runtime Trace capture on.

- **Record mode** writes the traces into the committed trace fixtures for review. Prior art: the capture test that produces the extra-folder trace.
- **Default runs replay only:** no network, no login, deterministic.
- **Re-record on every Claude SDK upgrade,** per ADR-0002.
- **The committed traces are the repeatable artifact.** The trace decode-and-invariants replay suite must pass on them, and gains the Provider seam's contract invariant: every handed-off input is placed exactly once, or resolves unplaced as cancelled or failed, and a placement comes before any assistant output that answers it.
- **The spike script and outputs** in the design folder are the reference for the expected shapes.

### 3. Visual acceptance pipeline

- **Add a new feature file** for the tray and the busy send-button states, covering queued, steering and paused rows on desktop and phone layouts.
- **Add it to the hardcoded feature list in the acceptance runner script,** or it silently never runs.
- **Commit baselines only after visual review.**
- Prior art: the composer send-button and live-status features.

### 4. One live OpenCode scenario

- **Runs in the opt-in live lane** against an ephemeral OpenCode server.
- **Scenario:** steer during a tool call. Assert transcript order and turn rows.
- **The captured traffic pins the v2 prompt and event contract** (ADR-0002), including the contract invariant.

### Replace, don't layer

These tests pin behaviour this spec removes. Delete or rewrite them in the same change, rather than keeping them alongside the new lanes:

- **The queued-shimmer and epoch cases** in `test/unit/stores/transcript.test.ts` and `test/unit/stores/chat-store.test.ts`, plus the single references in the other store and frontend tests that touch `sentDuringEpoch`, `waitingBehindReply` or `isQueued`.
- **The Claude "pending assistant boundary" expectation** in `test/unit/provider/claude/claude-translator-snapshot-dedupe.test.ts`, and any test that pins the runner's FIFO turn gate.
- **The "Reply to steer…" placeholder** in `features/composer-final-design.feature` and `features/composer-field-width.feature`, and their baselines.
- **`test/unit/domain/relay/pending-send-ownership.test.ts`,** with the module it tests.
- **The prompt-handler and provider-turn-service cases** that pin the `user_message` broadcast, send ownership or `maybePersistClaudeUserMessage`.
- **The E2E fixture `test/e2e/fixtures/subagent-snapshot.json`,** to be regenerated if the chat-state shape changes.

### Not added

No new unit tests for the inbox, runtime, projector, read model or relay beyond the replayer's failure-mode pins. The replay lane is the one seam that proves the behaviour.

## Out of Scope

- **Cancelling or recalling a steer after it reaches the provider.** The SDK protocol has `cancel_async_message` and `interrupt({cancel_queued})`, but `Query` doesn't expose them in 0.3.289. This needs a follow-up upstream request.
- **Claude `priority: "now"` and other interrupt-and-send modes.** Stop then Send covers this.
- **Provider-side queues** (Claude `"later"`, OpenCode `delivery: "queue"`).
- **Reordering queued inputs.**
- **A global "follow-up behaviour" setting** to flip the default.
- **Promote shortcuts:** promote-oldest (Cmd/Ctrl+Shift+Enter) and promote-on-empty-Enter.
- **Splitting token usage** between turns that share one result.
- **Steering into a subagent's own turn.** A steer during a subagent waits for the main agent's next tool boundary.

## Further Notes

- **Design record:**
  - `docs/plans/2026-10-05-steer-and-queue/plan.md` has the design and the Claude spike results table.
  - `ui-research.md` covers how t3code, Codex CLI, Claude Code, Cursor, OpenCode and CodeNomad handle this, with an options table.
  - `claude-spike/` holds the spike script and raw outputs.
- **t3code is the closest prior art.** It also defaults to queue, with a modifier to steer, server-stored queue rows and per-row Steer. One difference: its Claude steer uses `priority: "now"`. On SDK 0.3.289 that moves running work to the background and starts a separate turn, so conduit uses `"next"`.
- **Untested:** steering during a long subagent. The fold waits for the subagent's tool call to return, which can be minutes, and the row shows Steering for that long. Record a scenario if it misbehaves.
- **ADR check:** consistent with ADR-0001 (skip and log), ADR-0002 (record and replay) and ADR-0004 (canonical events). No conflicts.
- **Design vocabulary:** module, interface, seam, adapter and depth are used as in the codebase-design skill. The Session Inbox is the one new deep module. Everything else is a small change at an existing seam, and the provider seam's interface shrinks.
