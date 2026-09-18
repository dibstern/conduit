# The detail stream's lifecycle contract: an amended coverage map

**conduit-test-6m3g.** Prerequisite for conduit-test-ni8.5.20, which deletes
central switch arms. Dated amendment to conduit-test-ni8.5 §11.

## What the original map got wrong

§11's rule is right: once a message type is routed per-session, its central
switch arm must go, because a type routed per-session *and* handled centrally
is two producers disagreeing about one piece of state.

Two premises under it were wrong.

The count is **thirteen, not eleven**. The thirteen are the chat-event arms in
`routePerSession` / `dispatchChatEvent`, not arms of the central `handleMessage`
switch (which has 45 labels, of which only four are in
`GLOBALLY_COORDINATED_TYPES`). The original eleven-type subset is not recorded
anywhere in the spec and could not be reconstructed.

The detail stream does **not** already produce these types. It emits
`transcriptMessage` only, and its query reads `messages` and `message_parts`
alone: no `turns`, no error records. So deleting the arms as written strands
turn completion, phase, notifications and error rendering with no producer.

## The principle that decides the hard cases

Three arms looked undecidable because each one does two jobs at once. They are
not undecidable; they are **overloaded**, and the answer is to split them, the
same move that separated the spinner question from the completion question in
conduit-test-ni8.5.19.

What decides where each half goes is **replayability**:

> The detail subscription is replayable. A client resuming from a cursor
> receives its upserts again. So durable state may ride it, and a user-visible
> side effect may not: replaying a completion would ding the user a second time
> for a turn that finished an hour ago.

A spurious alert is as costly as a missed one. It calls the user back to
nothing, and after it happens twice they stop trusting the alert, which
silently destroys the feature that motivated the epic. So the rule is
mechanical: **durable state rides the replayable stream, perceptible side
effects do not.**

## The map

| Arm | Disposition | Why |
| --- | --- | --- |
| `user_message` | detail | session-owned message |
| `delta` | detail | message/part text, already projected |
| `thinking_start` | detail | session-owned part lifecycle |
| `thinking_delta` | detail | session-owned text, already projected |
| `thinking_stop` | detail | part completion; projector must retain the completion fact |
| `tool_start` | detail | session-owned part; normalize projected `started` |
| `tool_executing` | detail | session-owned tool state; refreshed input not yet projected |
| `tool_result` | **split** | tool state to detail; todo panel to the plan/todo subscription (ni8.10) |
| `result` | detail | message-owned usage and cost |
| `done` | **split** | turn completion to detail; alert delivery stays non-replayable |
| `status` | detail | session lifecycle, true even when no assistant message exists |
| `compaction` | detail | session-owned operation |
| `error` | **split** | four owners, see below |

### The three splits

**`tool_result`** writes tool state and the todo panel from one arm. Tool state
is transcript content and goes to detail. Todos are their own concern with
their own subscription already specified (ni8.10), so they go there rather than
riding a transcript envelope. This makes ni8.10 a prerequisite of the
`tool_result` deletion, not a follow-up. Leaving todos in detail would keep two
competing todo writers and require fixing the unkeyed todo state anyway, so the
dependency buys correctness rather than deferring it.

**`done`** finalizes text, tools and thinking, advances `turnEpoch`, moves the
phase to idle, and calls `triggerNotifications`. Everything up to the phase
change is durable state and goes to detail, applied idempotently so a replayed
terminal envelope is a no-op rather than a second transition. `triggerNotifications`
is the perceptible side effect and stays on a non-replayable path.

**`error`** is five unrelated facts sharing one message type:

- turn failure and `RETRY` are durable session state, to detail;
- `PTY_CONNECT_FAILED` belongs to the PTY subscription (ni8.11);
- `INSTANCE_ERROR` belongs to instance state (ni8.14);
- `HANDLER_ERROR` is a transient toast about one request, so it stays globally
  coordinated: it is a fact about the request, not about any session;
- the alert it triggers follows the `done` rule and stays non-replayable.

No single disposition covers this arm because it was never one arm.

## What this costs, honestly

**A terminal reducer, shared.** `status`, `done` and `error` each advance
`turnEpoch` independently today. Once they are envelopes on a replayable
stream, three independent epoch advances become three chances to double-count.
They must converge on one idempotent terminal reducer before any of the three
arms is deleted. This is real work and it is the critical path, not a detail.

**Projection gaps.** Several arms assign cleanly to detail but the projection
does not hold the data yet:

- `thinking_stop`: the completion fact is lost.
- `tool_executing`: refreshed input is not fully projected.
- `compaction`: the Effect projector does not handle `session.compaction` at
  all; only the older synchronous projector persists it, completed-only.
- `error`: terminal error content is written by a separate projector and is
  outside the transcript query; retry lifecycle is not stored anywhere.
- `status`: turn states exist in the projection but outside the transcript
  query, so this is a new projection-backed path rather than a transcript
  change.

Each of those is production work before the matching arm can be deleted.

## The test that gates the deletion

**"A provider turn completes through the detail subscription with legacy chat
dispatch disabled."**

Drive a real provider-runtime turn through ingestion, canonical commit, the
Effect projectors, the read-model advance, `SubscribeSessionDetail`, and the
production frontend detail reducer. Assert the owning session reaches idle,
that assistant, tool and thinking content are finalized, that usage is visible,
that queued-message indication is released, and that another session is
unchanged. Then reconnect and reapply the terminal state, and assert there is
**no second terminal transition and no second alert**.

The nearest existing test is "delivers what the REAL ingestion service
committed, as projected messages"
(`test/unit/relay/session-detail-subscription.test.ts:341`). It drives real
ingestion through projected delivery but sends no terminal event and never
reaches a frontend reducer, so it does not prove the deletion safe.

## Two questions for a human

**1. Duration parity on `result`.** The projection holds cost, tokens and the
context window, but not the provider-reported duration; history computes
elapsed message timestamps instead. Either persist the reported duration or
accept that the displayed duration changes meaning. This is a visible product
decision, so it is not made here.

**2. Where the terminal reducer lands.** It is a prerequisite for three arms
and is larger than a line on a map. It should probably be its own ticket
blocking ni8.5.20 rather than absorbed into 6m3g.
