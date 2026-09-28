# Jev message surfacing: lift worthwhile mid-turn messages out of the activity log

Status: plan, not started. No beads filed yet.

## Problem

`segmentTurns` (`src/lib/frontend/utils/turns.ts`) folds every assistant text part
that a tool call follows into the collapsed `TurnActivity` log. Only the trailing
text, the reply, stays in the conversation. So a mid-turn message like "Found it: the
`<h1>` never got `id=session-bar-title`, so it auto-placed into column 1" sits in the
same collapsed log as "Let me read the file." The user has to open the log to find
the one that matters.

## Outcome

With the feature on and a TypeSafe API key configured, conduit asks Jev whether each
mid-turn assistant message deserves a place in the conversation. Messages Jev
surfaces render in the transcript, in order, between the work before and after them.
Everything else stays in the log.

With the feature off, no key, or a key that failed validation, nothing changes from
today: every mid-turn message folds into the log, and the last one is the reply.

## Decisions

### 1. Judge on the daemon, persist the verdict as an event

The daemon makes the call, appends a conduit-originated event, and a projector writes
the verdict onto the part row. That keeps the verdict stable across devices and
reloads, and each part is paid for once. The precedent is
`session-title-service.ts:351`, which appends `session.renamed` after an AI title
call.

Rejected:

- **Browser calls Jev.** The key would live in the browser. The SDK refuses this
  unless `dangerouslyAllowBrowser` is set. Every open tab would pay for, and could
  disagree on, the same part.
- **Judge on read, don't persist.** You pay on every history load, and old sessions
  change shape whenever the model changes.
- **Have the coding agent tag its own messages** (a system-prompt append asking it to
  mark user-facing text). It costs nothing and adds no latency, but it changes agent
  behaviour, can't be retrofitted to OpenCode, and compliance is unreliable. Worth
  keeping as a fallback idea if the eval shows Jev isn't clearly better than a
  heuristic.

### 2. Trigger: the fold moment, at the ingestion choke point

Claude emits no text-completed event (`claude-event-translator.ts:1084`). OpenCode
doesn't either. The one place that sees both providers after translation is
`ProviderRuntimeIngestion.ingestBatch`
(`provider-runtime-ingestion-service.ts:56`).

Rule: a text part is complete when the next non-delta event for the same session is
`tool.started`, `thinking.start`, or a new text part in the same turn. That is the
exact moment the frontend would fold it. `turn.completed` does **not** trigger a
judgment, because that text is the final reply and is always shown. As a side effect,
we never pay to judge final replies.

The service forks the call, so ingestion never waits on Jev. It is keyed by `partId`,
skips parts that already have a verdict, and runs only on live ingestion, never on
projection replay (the post-projection notifier already skips replay:
`projection-runner-effect.ts:135`).

### 3. Storage

- New canonical event `text.surfaced`, payload
  `{ messageId, partId, surfaced: boolean, probability: number | null, model: string | null }`.
  Register it in the six `events.ts` registries (type list ~51, payload map ~334,
  schema ~495, envelope ~760, union ~875, required fields ~919).
- Migration: `ALTER TABLE message_parts ADD COLUMN surfaced INTEGER` (NULL means not
  judged). Use a column, not the tool `metadata` JSON: this value is read on every
  transcript render and deserves a type.
- Policy (the threshold) is applied in the daemon. The raw `probability` and `model`
  stay in the event, so a later threshold change can be re-projected without calling
  Jev again.
- On timeout, 429/5xx after retry, or any other failure, the service still appends
  `surfaced: false, probability: null`. Every judged part therefore gets a verdict,
  which the frontend hold rule (decision 6) relies on.

### 4. The question to Jev

One **Noul** (yes/no probability). The decision is binary, and a Noul gives one clean
probability to threshold. A Choice over categories (finding, question, plan,
narration...) would add a policy layer that v1 doesn't need. Revisit it only if the
eval shows hybrid messages confusing the Noul.

State (an object, so each part has a name):

```json
{
  "request": "<the user's prompt for this turn, first 1,000 chars>",
  "message": "<the mid-turn message: first 2,000 chars + last 500>"
}
```

Question:

```json
{
  "surface": {
    "type": "noul",
    "instructions": "`message` was written by an AI coding agent partway through working on the user's `request`, between tool calls. It will either be shown in the conversation or folded into a collapsed log of the agent's work. Would the user want to read `message` in the conversation, instead of finding it only in the collapsed log?",
    "criteria": {
      "true": "It tells the user something they would want even if they never open the log: a finding, diagnosis, root cause, or result; a decision, assumption, trade-off, or deviation from the request; a risk, blocker, or failure; a question for the user or something they need to do; or a summary that answers part of the request.",
      "false": "It narrates what the agent is doing or about to do (for example 'Let me read the file', 'Now running the tests', 'Checking the config'), restates the plan or request without new information, is a brief acknowledgement or transition ('Good.', 'That worked, moving on.'), or only makes sense next to the tool call it describes."
    }
  }
}
```

Why it's phrased this way:

- **Positive polarity.** High probability means surface. The Noul guide warns against
  inverted phrasing, and the Jev 1.13 notes list double negatives as a weakness.
- **It names the consequence.** Jev reads instructions literally, so the question says
  what the answer controls ("shown in the conversation or folded into a collapsed
  log") rather than asking for an abstract "is this a status update?". Hybrid
  messages ("Store is wired. Before the chip UI, checking the guard...") get judged
  on the decision that actually matters.
- **Criteria carry the boundary.** The examples come from real transcripts in
  `.conduit/events.db`.
- **Minimal state.** The Jev 1.13 notes say irrelevant context lowers accuracy. User
  prompts here average about 3,700 chars because skills expand them, so `request` is
  truncated. Whether `request` helps at all is an eval question (ticket 0).
- **Prompt injection.** The message is agent output and could contain instructions.
  The worst an injection can do is move a message into or out of the log, which is
  acceptable.

Threshold: start at **0.5**. Hiding a real question is bad, but surfacing noise erodes
the feature. Ticket 0 sets the final value.

Model: pin `jev-1.13.0`, not `jev-latest`, so verdicts don't drift silently. Bumping
the model is a deliberate change.

### 5. API key and settings

Key and toggle are daemon-wide, since one key serves every project.

**Storage.**

- Keep the key in `~/.config/conduit/credentials/typesafe`, written atomically with
  mode `0600` (create the temp file with `{ mode: 0o600 }`, then `rename`), inside a
  `0700` directory.
- Never put it in `daemon.json`. That file is written without an explicit mode
  (`config-persistence.ts:355`), so it lands as 0644.
- Hold it in memory as Effect `Redacted<string>` (precedent: `daemon-config.ts:68`),
  so it can't reach logs or RPC payloads by accident.
- Rejected for v1: the OS keychain. macOS Keychain is easy, but Linux has no
  dependable equivalent on a headless box (libsecret needs a session bus). A 0600
  file is the same model `gh`, `codex`, and `claude` use on Linux. Keychain can come
  later as a second adapter behind the same interface.

**Environment override.** `TYPESAFE_API_KEY` in the daemon's environment wins. The UI
then shows "Set by environment" and disables editing.

**Write-only over the wire.** Two RPCs on `WsRpcGroup`:

- `GetMessageSurfacing` returns
  `{ enabled, key: { state: "missing" | "valid" | "invalid" | "env", last4?: string, checkedAt?: number } }`.
  The key itself never leaves the daemon. The push-subscription POST
  (`effect-http-router.ts:233`) is the write-only precedent.
- `UpdateMessageSurfacing({ enabled?, apiKey?: string | null })` uses patch semantics,
  so two browsers can't clobber each other (the lesson of `conduit-test-d7o6`).
  `apiKey: null` clears the key. It returns the same status shape as the Get.

**Validation.**

- A new key is checked with one minimal `POST /v1/systemone` (a one-word state and a
  trivial Noul, a few tokens). A 401 rejects the key and nothing is stored. TypeSafe
  documents no free ping endpoint.
- If a later call returns 401, the status flips to `invalid` and the service stops
  calling. The feature then reads as inactive, so the UI falls back to today's
  behaviour.

**Transport guard.** The server rejects any request that carries `apiKey` unless the
connection is TLS or loopback. The UI also disables the field when
`!window.isSecureContext` and explains why. The PIN model is unchanged: someone who can
reach an unpinned daemon can already read every transcript, so this adds no new
exposure.

**Settings UI.** Add a section to `SettingsPanel.svelte`, either in a new
"Transcript" tab or under "Agents & Models". This is a taste call, open question 1.

- Toggle: "Pull important messages out of the activity log"
- Hint: "Jev by TypeSafe decides which in-progress messages are worth showing. Status
  updates stay in the log."
- Key field: a password input. Once saved it shows `••••last4` with Replace and Remove
  buttons, plus a link to `console.typesafe.ai/keys`.
- Disclosure, always visible: "When on, conduit sends each in-progress agent message,
  and the prompt that started the turn, to TypeSafe (api.typesafe.ai)."

**Active** means `enabled && key.state ∈ {valid, env}`. The frontend reads it on
connect. Pushing changes live to other open browsers should use whatever
peer-notification pattern `conduit-test-ni8.12` lands. Until then, other tabs pick up
a change on reconnect.

### 6. Rendering: a surfaced message closes its segment

This reuses what already exists. A segment is `activity` then `reply`, and a hand-back
already closes a segment and opens the next, with each segment getting its own
`TurnActivity` line. A surfaced message works the same way:

- In `appendActivity`, when a non-text part arrives and the pending `reply` run holds
  a surfaced part, keep that run as the segment's `reply`, close the segment, and
  open a new one for the incoming part. Non-surfaced parts at the start of the run
  still fold into activity.
- Add `AssistantMessage` as a third `ClosedSegment.end` reason, next to result and
  hand-back. `segmentEnd` already stops at `reply[0].createdAt`, and `lastResult` /
  `turnDuration` key on `end.type === "result"`, so durations and the bill stay
  correct.
- `segmentTurns(messages, processing, surfacing: boolean)`. When `surfacing` is false
  the new path is dead, which gives exactly today's behaviour. That covers "turned off
  in settings" even for parts judged earlier.

**Hold rule: no fold-then-pop.** Without it, a message folds when the tool starts and
then pops back out when the verdict lands. With `surfacing` on, a part in the live
turn's final segment with `surfaced === undefined` is treated as surfaced, so it stays
where it already was, as the streaming reply. A `false` verdict then folds it,
roughly a second later than today. Once the turn is no longer live, `undefined` means
folded. The rule needs no clock in the pure function, because the service guarantees
a verdict (decision 3), and a daemon restart ends the live turn.

`AssistantMessage` gains `surfaced?: boolean`. It is threaded through
`read-model-types.ts:42`, `session-history-adapter.ts:110`, `shared-types.ts:333/449`,
`contracts/ws-rpc.ts:167`, `history-logic.ts:178`, and the live path.

## Module shape (deep-module view)

- **`MessageSurfacing`** (relay layer). Callers see no methods at all. Its whole
  interface is "watches ingestion, appends `text.surfaced`". Behind it sit
  completion detection, idempotency, concurrency (semaphore of 8, drop on overflow),
  timeouts (2s per attempt, one retry on 429/5xx only), the threshold, and failure
  verdicts.
  - Internal seam: `Judge = (input: { request: string; message: string }) => Effect<number, JudgeUnavailable>`.
    It has two adapters, the TypeSafe HTTP call and a scripted fake, so it is a real
    seam.
  - Tests go through the interface: feed canonical events, assert the appended
    events.
  - Deletion test: without this module, the completion rule and the failure policy
    would leak into ingestion.
- **`MessageSurfacingSettings`** (daemon layer). Interface: `status()`,
  `update(patch)`, and an internal `activeKey: Effect<Option<Redacted<string>>>`
  consumed by the Judge adapter. File, environment, and validation stay hidden.
- **`segmentTurns`** takes one extra boolean. The new rule lives inside
  `appendActivity` and the segment-closing branch, so there are no new frontend
  modules.

## Cost estimate

Price: **$0.042 per million input tokens, output free** (`docs.typesafe.ai/models`).
Tokens per call: about 250 for the question, up to about 250 for `request`, and the
message (about 180 on average, capped around 625). That's roughly **700 on average and
1,150 at most**.

Measured from this repo's `.conduit/events.db`: 293 sessions and 9,189 assistant text
parts between April and September 2026. The counts include final replies, so they are
an upper bound.

| Scope | Calls | Tokens | Cost |
|---|---|---|---|
| Average session (29 parts) | ~30 | ~21k | **~$0.001** |
| Busiest session ever (2,315 parts, 1.1M chars) | ~2,300 | ~1.9M | **~$0.08** |
| All of this project, 5 months | ~9,200 | ~6.4M | **~$0.27** |

Cost is not the constraint. Latency (not documented by TypeSafe) and privacy are.
The rate limit of 1,200 requests/min is far above an agent's pace of a few messages
per minute.

## Fit with existing work

- **Blocking: `conduit-test-ni8.5.20` (wire detail live, retire legacy arms).** The
  typed streaming work lives on unmerged `feat/ni8-*` branches. `main` still delivers
  transcripts through `session_switched` and `ws-dispatch.ts:280/861`, which
  `ni8.16` deletes. The frontend threading (ticket 5) waits for ni8.5.20 on `main`,
  so we don't thread a field through code that's about to be deleted. Once it lands,
  the verdict is a normal row update: the projector bumps the part's version and the
  subscription delivers the upsert, with no new push arm.
- **Soft: `conduit-test-ni8.12`.** Live fan-out of the setting to other browsers
  follows its peer-notification pattern.
- **Blocking OpenCode history only: `conduit-test-6ol`.** OpenCode history is read
  from provider REST, not projections (`handlers/session.ts:269`), so persisted
  verdicts won't appear there until 6ol lands. Claude works first.
- **`conduit-test-d7o6`.** Take its lesson (patch semantics) and avoid adding a
  second replace-style settings write.
- **`conduit-test-ly9n` / compaction-in-activity spec.** Both touch `segmentTurns`.
  The Strip Ledger splits per segment, so a surfaced message gives two strips. That
  needs a visual check in the story.

## Tickets (proposed)

0. **Eval spike (go/no-go gate).** Unblocked.
   - Sample about 150 mid-turn texts from `.conduit/events.db`, have opus-5 label
     them first, then have the user review.
   - Run Jev with and without `request`, plus a no-AI baseline (length plus a
     "Let me / Now I'll / Checking" regex).
   - Report precision, recall, threshold, and latency p50/p95.
   - If the heuristic lands within a few points of Jev, stop here and ship the
     heuristic without a third party.
1. **`text.surfaced` event, `message_parts.surfaced` column, projector.** Unblocked.
2. **`MessageSurfacingSettings`, credential file, and the two RPCs, with validation
   and the transport guard.** Unblocked.
3. **`MessageSurfacing` service with the Judge adapters.** Blocked by 1, 2, and 0
   (question and threshold).
4. **Settings UI section with stories.** Blocked by 2.
5. **Frontend threading, the segment rule, the hold rule, stories, and acceptance
   visuals if a feature file covers the transcript.** Blocked by 1, 4, and
   `ni8.5.20`.
6. **OpenCode history parity.** Blocked by 5 and `6ol`.

## Open questions

1. Where does the section live: a new "Transcript" tab, or under "Agents & Models"?
2. Should `request` be in the state? Ticket 0 decides.
3. Backfill old sessions on demand ("Judge this session" in the session menu)? Out of
   scope for v1. It costs about $0.001 per average session, so it could be offered
   later.
