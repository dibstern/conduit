# Jev message surfacing: lift worthwhile mid-turn messages out of the activity log

Status: plan, revised 2026-10-06 to follow B3's card (popover above the pins, coloured strip,
summary pill, Raise / Lower) and to add follow-up recaps. Not started.
Spec: epic `conduit-test-ahu8`. Designs: `2026-09-26-surfaced-messages-designs-round-3.html`.

Chosen presentation: **B7 Footnoted recap**, drawn the way **B3** draws it: the message
card is a popover above the pins, the pins sit on today's coloured `ActivityStrip`, the
summary is a pill and box under the strip, and feedback is B3's ▲ Raise / ▼ Lower with an
inline "Why?" row. M4 contributes the ledger and proposal review in Settings only.

## Problem

`segmentTurns` (`src/lib/frontend/utils/turns.ts`) folds every assistant text part
that a tool call follows into the collapsed `TurnActivity` log. Only the trailing
text, the reply, stays in the conversation. So a mid-turn message like "Found it: the
`<h1>` never got `id=session-bar-title`, so it auto-placed into column 1" sits in the
same collapsed log as "Let me read the file." The user has to open the log to find
the one that matters.

## Outcome

With the experimental flag on and a TypeSafe key configured:

- Jev puts each mid-turn message into one of the user's categories (Ask, Risk,
  Finding, a custom Perf…) or `routine`.
- Each turn's activity block gains B3's pin lane on the coloured activity strip. Pins
  are the messages at or above the session's level (Final / Key / Balanced / All).
  Tapping a pin, or scrubbing across the pins or the strip, opens the message in a card
  above the pins.
- A settled turn opens on a cited recap. Each `[#n]` in it opens message n. When a turn
  moves on after a recap, the user can summarise just what is new, and step between the
  recaps with ‹ ›.
- Each message can be marked read or unread, replied to with a reference token in
  the composer, and raised, lowered or retyped (B3's ▲ Raise / ▼ Lower, plus ⇄ Retype,
  each with an optional reason).
- Marks build a ledger. From Settings, the user can ask Opus to propose
  category changes. The proposal is scored by replaying Jev, and nothing changes
  until the user accepts it.

With the flag off, no key, or an invalid key, nothing changes from today. Stored
verdicts, marks and read state are kept, so turning the flag back on resumes.

## Decisions

### 1. One daemon flag gates everything

`enabled` on the daemon (already in `UpdateMessageSurfacing`) is the feature flag.
It gates Jev calls, recap calls, tuning calls, and the frontend card. The frontend
reads **active** = `enabled && key.state ∈ {valid, env}`.

Not the frontend `feature-flags` store (`stores/feature-flags.svelte.ts`). That is
per-browser localStorage. The daemon makes the paid calls, so a browser flag would
hide the UI while Jev kept charging.

The Settings section labels the feature experimental.

Turning the flag off mid-turn lets in-flight Jev calls finish and append (they are
already paid for). Parts folded while the feature is inactive are never judged later,
the same rule as old sessions, so they render as routine.

### 2. Judge on the daemon, persist the verdict as an event

Unchanged from the first plan. The daemon calls Jev, appends a conduit-originated
`text.surfaced` event, and a projector writes the verdict onto the part row. That
keeps the verdict stable across devices and reloads, and each part is paid for once.
The precedent is `session-title-service.ts:351` (`session.renamed`).

A verdict is a fact about the message that every viewer shares, so it belongs in the
log. Marks and read state are different (decisions 8 and 11).

Rejected: the browser calls Jev (key in the browser, every tab pays); judge on read
(pay on every load, old sessions drift); the coding agent tags its own messages
(changes agent behaviour, no OpenCode retrofit, unreliable).

### 3. Trigger: the fold moment, at the ingestion choke point

Unchanged. A text part is complete when the next non-delta event for the same
session is `tool.started`, `thinking.start`, or a new text part in the same turn.
`ProviderRuntimeIngestion.ingestBatch` (`provider-runtime-ingestion-service.ts:56`)
is the one place that sees both providers after translation. `turn.completed` does
not trigger a judgment: that text is the final reply and is always shown.

The service forks the call, so ingestion never waits on Jev. It is keyed by
`partId`, skips parts that already have a verdict, and runs only on live ingestion,
never on projection replay (`projection-runner-effect.ts:135`).

Invariant: every text part gets **at most one** verdict, and every part the daemon
detects as folded during live ingestion gets exactly one, failure verdicts included.
A part can still end up with none: a daemon restart mid-call, or a fold the daemon's
detection missed. Decision 15's settled fallback covers both, so nothing depends on
"exactly one". The daemon's fold detection and `segmentTurns` are two definitions of
"mid-turn", so a process-harness test pins them together.

The daemon also writes `ordinal` (decision 5) at the fold moment, because it is the
one place that sees the turn's parts in order.

### 4. The question: one Choice over the category set

The first plan's single Noul is replaced by one **Choice** per message. A Choice
returns a probability for every option, and that distribution is what makes reweighting
free and tuning possible (decision 9).

Options are the active categories (built-in and custom, not retired) plus a fixed
`routine` option. Criteria use the structured `what` / `not_for` / `examples` shape
that the TypeSafe Choice docs recommend for options that get confused. Field names are
ours, not reserved by the API.

```json
{
  "model": "jev-1.13.0",
  "state": {
    "request": "<the user's prompt for this turn, first 1,000 chars>",
    "message": "<the mid-turn message: first 2,000 chars + last 500>"
  },
  "questions": {
    "category": {
      "type": "choice",
      "instructions": {
        "question": "`message` was written by an AI coding agent partway through the user's `request`, between tool calls. What is the main thing it tells the user?",
        "focus": "Judge `message` against `request`. Saying what the agent will do next, or progress with nothing new, is routine."
      },
      "criteria": {
        "ask":     { "what": "Asks the user for a choice, fact, approval or action",
                     "not_for": "Questions the agent answers itself",
                     "examples": ["Recapture it, or keep the old paint order?"] },
        "risk":    { "what": "Names an unresolved plausible harm, regression or hazard" },
        "perf":    { "what": "Reports a measured change in latency, memory, bundle size or resource use" },
        "routine": { "what": "Says what the agent will do next, restates the plan, acknowledges, or reports progress with nothing new",
                     "examples": ["Let me read the file.", "Now running the tests.", "Good, moving on."] }
      }
    }
  }
}
```

The other built-ins follow the same pattern: Blocked, Scope, Replan, Correction,
Decision, Finding, Milestone. Their shipped `what` lines are the round-3 taxonomy.

Kept from the first plan: minimal state (`request` truncated; whether it helps is an
eval question), the injection note (worst case moves a message between levels), and
the pinned model (bumping it is deliberate).

On timeout, 429/5xx after one retry, a full concurrency queue, or any other failure,
the service appends a failure verdict (`probabilities: null`). Nothing is dropped
silently, so a live turn's pending pins always resolve (decision 15).

`categorySetVersion` in the verdict is provenance only. Levels always use the current
set, and nothing reads the version to pick an old one.

### 5. Levels: one pure function from probabilities, weights and the mark

Jev's level is computed, never stored (a mark stores the user's). One pure function, shared by the frontend
(rendering) and the daemon (the ledger and `score` in decision 9):

```
prominence = max over active categories c of weight[c] × p[c]     (0–100)
category   = the c that gives that max
level      = key       if prominence ≥ 70
             balanced  if prominence ≥ 40
             all       otherwise
             hidden    if routine beats every active category, or the verdict failed
mark       = { level, category? } replaces the computed level and category outright
```

At level L, the card shows messages whose level is L or higher. Final shows none.
Thresholds are constants. The eval spike may move them once; tuning never does, so
Key and Balanced keep their meaning.

Consequences:

- A weight change re-levels every message instantly, with no Jev call.
- A message judged before a category existed simply has no probability for it.
- A mark stores the level the user chose, not a step. The panel's ▲ / ▼ compute it
  from the shown level at save time. A retype stores the category plus the level its
  weight gives at save time. Because it is absolute, a mark doesn't drift when weights
  change later: a ▲ from All to Balanced stays Balanced even if Jev later says Balanced
  on its own. "Does Jev agree with this mark" is just
  `surfacingLevel(verdict, set).level === mark.level`.
- Message numbers: `#n` is the 1-based position among **all** of the turn's mid-turn
  text parts, routine ones included. The daemon computes it once at the fold moment and
  writes it into the verdict as `ordinal`. The card, recap and reply references all
  read that one stored value, so there is no second derivation to drift from it. It
  never changes when marks or categories change. Cached recap citations and sent reply
  references stay valid for good. At Key the numbers have gaps (#3, #17, #24), as B7's
  footnotes did. A pending part (no verdict yet) shows without a number until its
  verdict lands; a settled part that never got one has no number and stays in the log.

### 6. Category set: a versioned daemon config

Categories are daemon-wide (one user, one daemon), stored in
`~/.config/conduit/surfacing/categories.json`, written atomically. Not secret, so
normal file modes.

```ts
type CategorySet = {
	version: number;
	categories: Array<{
		id: string; // stable Choice option key: "ask", "perf"
		origin: "builtin" | "custom";
		label: string;
		glyph: string;
		colour: string;
		weight: number; // 0–100
		retired: boolean; // built-ins only; customs are deleted instead
		criteria: { what: string; not_for?: string; examples?: string[] };
	}>;
};
```

- Every write bumps `version`. No history is kept: levels always use the current set,
  and category ids are stable, so nothing ever needs an old set.
- Built-in defaults ship in contracts. "Reset" is a browser-side edit that restores a
  built-in's shipped weight and criteria. `routine` is implicit and not editable.
- Default weights: Ask 100; Blocked, Risk, Scope 80; Replan, Correction, Decision
  60; Finding, Milestone 40. Custom categories start at 50.
- One write: `replace(expectedVersion, nextSet)`. The daemon validates the set:
  - unique ids, derived from the label at creation and immutable;
  - weights 0–100;
  - built-ins may be retired, not deleted;
  - label 1–24 chars, glyph one character, colour a hex value;
  - at most 20 active categories (each is a Choice option, so each costs tokens).

  It rejects a stale `expectedVersion`. The version check is what `conduit-test-d7o6`
  needed (no blind overwrites), so patch operations would add nothing. The Categories
  UI and accepted tuning changes both build a next set and call `replace`, which makes
  CategorySet the only writer.
- Weight changes need no rerun. Criteria changes, additions and retirements apply to
  messages judged afterwards.
- An unreadable `categories.json` is renamed aside (`categories.json.corrupt-<time>`),
  logged, and replaced by the shipped defaults, so a bad file never stops judging.

### 7. Storage

| Data | Where | Why |
|---|---|---|
| Verdict | `text.surfaced` canonical event `{ messageId, partId, ordinal, categorySetVersion, model, probabilities \| null }`, projected onto `message_parts` columns (`surfacing_ordinal`, `surfacing_probabilities` JSON, `surfacing_set_version`, `surfacing_model`) | Shared fact about the message (decision 2) |
| Category set | Daemon config file (decision 6) | Daemon-wide, cross-project |
| Marks (Raise / Lower / Retype) | Per-project read-model table `surfacing_marks`, written directly | Per-viewer annotation, outside the log (ADR-0004 amendment) |
| Message read state | Per-project read-model table, written by `SessionAttention` | ADR-0004 amendment names read state and that module |
| Recaps | Per-project read-model table `turn_recaps` | Derived and regenerable |
| Level default | `GetMessageSurfacing` daemon settings | Same on phone and desktop |
| Session level override | Browser localStorage, per session | `files-pane-by-session` pattern |

Register `text.surfaced` in all `events.ts` registries and the four exhaustiveness
guards (see the `canonical-event-exhaustiveness-guards` memory).

Mark and read writes use the commit-and-signal stamp, bumping the part row's version,
so the existing row subscription delivers them live (ni8.5.20 has landed). A
boundary test, in the style of `session-mutation-boundary-grep.test.ts`, keeps writes
to each table inside its owning module.

Deleting a session deletes its marks, reads and recaps.

### 8. Marks: Raise, Lower, Retype (B3's controls)

The message card's foot has `▲ Raise`, `▼ Lower` and `⇄ Retype`. Pressing one opens
B3's inline "Why?" row inside the card, above the foot:

- **Prompt:** `▲ Raise #26: All → Balanced. Why?`, with Jev's arithmetic beneath in dim
  text (`Jev: Finding · p .64 × 40 = 26`).
- **Reasons:** up to three chips from the ledger's most used reasons for that direction,
  a free-text field, `no reason`, and ✕ to cancel. A chip, Enter in the field, or `no
  reason` saves.
- **Retype** first shows a menu of the active categories; the row then stores the new
  category plus the level its weight gives.

Raise and Lower store the absolute level one step from the shown level (decision 5).
Save writes the mark, the pin moves at once, and a toast `Saved · Undo` shows for 6s. A
message has at most one mark: the active button shows pressed, and pressing it again
clears the mark. Raise is disabled at Key; Lower from All sends the message back to the
log.

The expanded step log lists every mid-turn message with the same `▲` and `▼` (and the
same Why row), so misses and false alarms can both be reported. `▼` is disabled on a
message that is already only in the log.

A mark changes only its message. Weights change only through Settings or an
accepted proposal.

Row in `surfacing_marks`:
- `part_id` (primary key)
- `session_id`
- `level` (`hidden` | `all` | `balanced` | `key`)
- `category` (set only by a retype)
- `reason`
- `created_at`

There is no snapshot of Jev's answer. The verdict on the part row never changes, so
the ledger and tuning read it from there, together with the message and request text.
One write RPC: `SetSurfacingMark(partId, mark | null)`; null clears the mark.

### 9. Tuning: the ledger and "Improve with Opus"

Settings › Surfacing › Feedback (M4's ledger): counts by direction (above, below, or
retyped against Jev's current answer), a "Jev said → you said" grid by category, and
the records themselves. "Jev said" is computed with the **current** set, so a mark
that a later change resolved shows as agreeing. Marks from every registered project
are included.

`CategoryTuning` is stateless, with two operations.

**`propose({ avoid? })`** (enabled at 5 or more marks; `avoid` is the changes the user
unticked earlier in this review, so "Propose again" doesn't repeat them):
- **Model:** runs the tuning model through the shared one-shot Claude call, so there
  is no new key. The model is a setting that defaults to the newest Opus in the Claude
  provider's model catalog.
- **Input:**
  - the current category set;
  - every mark, with its message, request excerpt, Jev's probabilities and the
    marked level or category;
  - the criteria guidance (`what` / `not_for` / `examples`, positive phrasing, short
    examples);
  - the fixed level rules.
- **Output:** a schema-validated list of changes, each
  `{ id, categoryId, kind: weight | criteria | add | retire, before, after, rationale, markIds }`.

The probabilities let the model tell three mistakes apart:
- **Wrong weight:** a ▼ on a Finding at p .95 means the type is right but the weight
  is off.
- **Wrong definition:** a ▲ on a message judged routine means a category missed it.
- **Split probability:** an even split between two types calls for better `not_for`
  text.

**`score(set)`:** one symmetric operation, called on any set.
- Asks Jev with that set over every marked message, plus up to 50 recent unmarked
  judged messages (the same sample for every call, so two scores are comparable).
- Returns `{ agree, total, levels: [{ partId, level, category }] }`, using
  `surfacingLevel`. `agree` counts marked messages whose level matches the mark.
- Caches Jev answers by part and the set's criteria (options and their text, not
  weights). The current set's criteria were what live judging used, so scoring it
  reuses stored verdicts and costs no calls; weight-only edits also cost none.

**The flow in the browser:**
1. It calls `score(current)` once, builds a candidate set from the changes the user
   has ticked, and calls `score(candidate)` on every toggle. "Agree now → after" and
   the list of moved messages are a diff of the two results, computed in the browser.
2. Accepting calls `CategorySet.replace(expectedVersion, candidateSet)`.

There are no proposal ids and no server-side proposal state, so a restart loses
nothing that can't be regenerated. The Categories editor also gets a "Test against my
corrections" button that calls `score` on the unsaved edit.

Nothing is automatic. Marks are never consumed, so the ledger keeps growing as a test
set that every future proposal is scored against.

Cost: one Opus call on the user's subscription, plus up to about 75 Jev calls per
score (under $0.01).

### 10. Level preference: daemon default, per-session override

- **Default:** `defaultLevel ∈ final | key | balanced | all`, default `balanced`,
  stored in the daemon surfacing settings so phone and desktop agree.
- **Per session:** the level control in the card changes only this session. A dot
  shows when the session differs from the default. Its menu offers "Make default"
  (writes the daemon default, clears the override) and "Back to default".
- **Effective level** = override ?? default. Clearing an override makes the session
  follow the default again.
- Overrides are browser-local (LRU of 100 sessions, like `files-pane-by-session`), so
  an override set on desktop does not follow you to the phone. Moving them to the
  daemon is a small later change if that matters.
- Final still runs Jev, so a session can step up later. The flag is how you stop the
  calls.

### 11. Message read state

Per the ADR-0004 amendment, read state is a per-viewer annotation, written to the
read model through `SessionAttention`, outside the event log.

- A message becomes read once it has been open in the card for 1 second (tab visible,
  card on screen), or through "Mark N read", which marks the turn's unread messages at
  the effective level.
- The card's `Read` checkbox (B3's "Viewed") reverses it either way.
- Unread messages show a dot on their pin. The activity head shows `9 unread` (click =
  next unread), and the progress chip under the strip shows `21/30 read ›`.
- Reading the recap does not mark messages read. The recap has its own "Mark N read".
  B7's half-read state was dropped because it muddied the count.
- The session-level `seen_version` is unchanged.

### 12. Reply references

- ↩ Reply on the message card, or on a recap citation, inserts an atomic reference token
  (`[#24 Ask]`) at the composer caret. Several tokens can sit among free text in any
  order. × or Backspace removes a token.
- Selecting text inside a message or the recap offers "Reply to this", which makes a
  token quoting that excerpt.
- At send, each token becomes a plain-text block that any agent can read, followed by
  whatever the user typed after it:

  ```
  Re #24 (Ask, 31:02): "The phone sidebar baseline shifts 2px because the unread badge…"
  Recapture it, the 2px shift is intended.
  ```

  The quote is the first 280 characters, or the selected excerpt. The time is the
  offset from the turn's start, as shown on the card.
- The sent message is stored and shown as sent. Rendering the blocks as chips in the
  transcript is out of scope.

### 13. Recap

- `RecapService` on the daemon calls the recap model through the shared one-shot
  Claude call (see Module shape). It is server-side, so no key reaches the browser.
- Settings: model (default Sonnet; Opus; Off), and when (when a turn ends, on request
  only). The default is when a turn ends, matching B7's settled view. Both can also be
  changed from the summary pill's menu on the card.
- **Recaps are a chain of versions per turn, never overwritten.** Each version has a
  scope:
  - **Whole turn:** covers messages 1 to the newest ordinal.
  - **New:** covers only the messages after the previous version's last ordinal, the
    "changes since the last recap". Its input adds the previous version's text, so
    it can say what changed without repeating it.
  Ordinals never shift (decision 5), so every version's range and citations stay
  correct after marks or category changes.
- **Stale** means the newest version's last ordinal is behind the turn's newest
  message. A stale recap offers both `✦ Summarize N new` (a New version) and
  `↻ Whole turn` (a fresh Whole version). Either appends a version; the old ones stay
  reachable with ‹ ›.
- Input: the request, the numbered messages in range at All with type and time, the
  previous version's text (New only), and the final reply if the turn has settled.
  Output is at most 4 sentences of prose with `[#n]` citations. The daemon drops any
  citation whose number isn't the `ordinal` of a mid-turn message of that turn.
- Stored in `turn_recaps`: one row per version with turn, version number, scope, first
  and last ordinal, text, model, duration and time. Session deletion removes them.
- Interface: `list(turn) → versions` (never calls the model) and
  `generate(turn, scope) → version | failed`.
- Paid-call rule: only `generate` costs anything, and it runs only when the user asks
  or at `turn.completed` when timing is "when a turn ends" and the turn has at least 4
  non-routine messages. At completion it makes a Whole version if the turn has none,
  or a New version if the newest one is stale. Model Off never generates.
- Citations to unread messages are highlighted. There is no "since you last read"
  scope: that would tie the cache to each viewer's reads. "New since the last recap"
  gives the same catch-up and caches cleanly.
- A citation opens its message in the card above the pins. If the message is below the
  current level, the card shows it anyway and says so.

### 14. API key and settings

Unchanged from the first plan, with additions:

- Key in `~/.config/conduit/credentials/typesafe`, mode 0600, atomic write, held as
  `Redacted<string>`; `TYPESAFE_API_KEY` overrides it; write-only over the wire;
  validated with one minimal call; transport guard (TLS or loopback only). See the git
  history of this file for the full reasoning.
- **New:** `TYPESAFE_BASE_URL` overrides the API host. The process-harness tests need
  it to point Jev calls at a fake server.
- `GetMessageSurfacing` returns
  `{ enabled, active, key, defaultLevel, recap: { model, when }, tuningModel }`.
  `UpdateMessageSurfacing` patches any of `enabled`, `apiKey`, `defaultLevel`,
  `recap`, `tuningModel`.
- **Settings UI:** a new "Surfacing" tab (this resolves the first plan's open
  question 1), with three sections:
  - General: flag, key, default level, recap model and timing, tuning model.
  - Categories: weights, Retire / Restore / Reset for built-ins, and Add / Edit /
    Delete for custom categories.
  - Feedback: the ledger and Propose changes.
- Disclosure, always visible: "When on, conduit sends each in-progress agent message,
  and the prompt that started the turn, to TypeSafe (api.typesafe.ai)."

### 15. Rendering: B3's card inside the existing activity block

This replaces the first plan's "a surfaced message closes its segment" rule. Surfaced
messages no longer split segments. Each `TurnActivity` block gains the pin lane over
its existing `ActivityStrip`, the message card, the level control, the read progress
and the summary. The final reply renders after the block, as today. Existing hand-back
segmentation is unchanged.

- `segmentTurns` keeps folding every mid-turn text part into activity. When the
  feature is not active, the card is today's `TurnActivity`, exactly.
- **Pins share the strip's scale.** A mid-turn message is already a step in
  `segment.activity`, so it already has a segment in `ActivityStrip`. Its pin sits over
  the centre of that segment, using the same `stepWeights`. Pins and strip can never
  drift apart, and no new timing data is needed.
- **`surfaceTurn` view model.** One pure frontend function turns
  `(folded parts with verdict/mark/read, step weights, category set, effective level,
  turn live?, picked part?)` into `{ pins, card, openAsk, unreadCount, nextUnread,
  notJudged }`. It owns every rule below (pin placement and grouping, live follow,
  hold rule, settled fallback, numbers from `ordinal`). The Svelte card only renders
  its output and sends clicks. Acceptance tests exercise it through the UI; there are
  no unit tests on it.
- **Live:** the card follows the newest message until the user picks a pin. When a
  pin is picked, new pins arrive without moving the card, and `now ⇥` appears.
- **Hold rule:** while the turn is live, a folded part with no verdict yet shows in
  the card as the newest message with a pending pin. When the verdict arrives, a
  routine message's pin disappears and the card falls back to the previous newest.
  Nothing pops in and out of the transcript, because the card only ever shows the
  newest message. Once the turn settles, a part that still has no verdict renders as
  routine (log only), so nothing waits on a verdict for ever.
- **Settled:** the block opens with the summary open and no card, if a recap exists;
  otherwise with the newest message in the card.
- `AssistantMessage` gains the verdict fields, mark and read flag, threaded through
  the read model and the typed live path that ni8.5.20 landed.

## Component designs

This section is the source for the UI anatomy. It takes B3's card, lane, strip and
summary (round 3, `#b3`), B7's group pills and settled recap, and M4's ledger and
proposal review in Settings, adjusted to the decisions above. Where the mockups and a
decision differ, the decision wins; "Departures from the mockups" lists each one. The
implementation should port B3's CSS values (sizes, borders, colours, shadows) rather
than restyle from scratch.

### The card (inside each `TurnActivity` block)

Top to bottom:

1. **Head:** today's activity head (`Working 38m 12s — Running …` / `Worked · 18
   searches …`), unchanged, plus B3's `9 unread` pill on the right (accent outline;
   `All read ✓` in muted text at zero). Click = next unread. The head still expands
   the step log.
2. **Message card** (B3's popover), in normal flow directly above the pins, so it pushes
   the thread down and never overlays it:
   - Width 420px desktop (100% phone), `--bg-alt` background, 1px border, a 3px top
     border in the type colour, radius 6/6/8/8, shadow `0 8px 22px rgba(0,0,0,.45)`.
     It slides horizontally to sit over its pin (clamped to the block), with a caret
     pointing down at the pin.
   - **Head row:** the uppercase type label in the type colour (`? ASK`), then badges:
     `NEEDS REPLY` (open Ask, filled in the Ask colour), the mark tag `▲ you · <reason>`,
     `● unread`; on the right `#24 · 31:02 · 13/14` (position among pins at the level)
     and the `Read` checkbox.
   - **Note** (only when relevant): `At All, below Balanced · opened directly` or
     `hidden at this level` (a citation or a fresh Lower opened it).
   - **Body:** the full message text as markdown, 12px, line height 1.5, never clamped.
   - **Why row** (decision 8) when Raise, Lower or Retype is pressed.
   - **Foot**, above a hairline: `↩ Reply`, `▲ Raise`, `▼ Lower`, `⇄ Retype`, spacer,
     `now ⇥` (live, after a pick), `‹` `›` (previous / next pin at the level), and `–`
     (live: fold the card) or `✕` (settled: close it).
3. **Pin lane** (B3 chips, B7 groups), 38px tall:
   - A pin is a chip: glyph and number in 10.5px bold mono (`?24`), 1px border and text
     in the type colour, `--bg` fill, with a short tick down to the strip.
   - **Two rows.** Pins are placed most urgent first (the open Ask, then urgency order,
     then p), each in the first row with no chip within 34px (38px phone). The upper row
     sits 20px higher with a longer, fainter tick.
   - **Groups.** A pin with no room in either row joins the nearest chip as a group
     pill, `8 +1`, named and coloured by its most urgent member. The open Ask never
     joins a group; a Blocked always leads one. When a grouped member is current, the
     pill shows that member's number, filled.
   - **States:** current (filled in the type colour, dark text); read (50% opacity);
     unread (white dot at the top-right corner); mark (superscript ▲ ▼ ⇄); open Ask
     (a pulsing Ask-coloured ring); opened below the level (dashed border); recap-cited
     (lifts when its footnote is hovered or focused); pending (dashed, `…` instead of a
     number).
4. **Strip:** today's `ActivityStrip` (colour = kind of work, width = duration), 8px
   tall, with B3's thumb (a white bar with a knob) under the current pin.
   - **Scrub and tap on one surface.** The pins and the strip are one slider. Press
     anywhere on either and drag: the thumb and the card follow the nearest pin at the
     level. A press that doesn't move (under 4px) on a chip picks that chip. Release
     keeps the pick. Drags are horizontal with pointer capture and `touch-action:
     pan-y`, so vertical page scroll still works on touch.
   - Hovering a segment still captions the head (today's behaviour); clicking a segment
     that isn't under a pin still opens the step log at that step.
5. **Axis row** (B3), one line that wraps on phone: `00:00`, the open-Ask chip `? 1 open ·
   #24`, the progress chip `[▬▬  ] 21/30 read ›` (click = next unread), `⚠ 2 not judged`
   (muted; tooltip says Jev was unavailable and these are in the log), the level control
   `Final · Key · Bal 14 · All` (the count is the pins at that level; override dot and
   menu as decision 10), and on the right `38:12 now` / `44:30`, or `now ⇥` in warning
   colour once the user has picked away from the live end.
6. **Summary** (B3's pill and box, see Recap block).

**Open Ask:** the turn's most recent message whose effective category is Ask, while
its turn is the session's latest and the user hasn't sent a message since. Any user
message clears it. Derived in `surfaceTurn`, nothing stored.

**Fold:** the card's `–` hides the card; the lane, strip, axis and summary stay. Any pin
reopens it. Only the session's latest turn opens unfolded; earlier turns open with no
card and the summary collapsed. **Final** hides the pins and the card but keeps the
strip, the axis row (with `Final only · 30 hidden`) and the summary.

**Short turns:** a settled turn with fewer than 4 non-routine messages opens on its
newest message, not the recap, and gets no automatic recap. Summarize still works on
request.

**Several blocks in one turn** (hand-back): each block shows its own parts' pins over
its own strip, with turn-wide `#n`. The summary for the turn sits in the turn's last
block.

**Nothing at this level:** the lane is empty and the axis row shows `Nothing at Key ·
Show All`. A turn with no mid-turn text parts shows today's `TurnActivity`.

**Read timing:** a message open in the card for 1s becomes read only while the tab is
visible and the card is on screen, so auto-follow in a background tab doesn't mark
anything. Scrubbing reads only the message released on.

### Keyboard and accessibility

Keys work only while focus is inside the card, never globally, so typing in the
composer is never captured.

| Key | Action |
|---|---|
| ← / → , Home / End | previous / next pin at the level, first / last |
| digits then Enter | open `#n`, switching the session to All if it is below the level |
| a | open the Ask |
| u | next unread |
| s | toggle the summary |
| r | reply to the card's message |
| + / − | Raise / Lower (opens the Why row) |
| m | toggle Read |
| Esc | close the Why row, then fold the card |

- The pin lane and strip are one `role="slider"` with `aria-valuetext` like "#24 Ask,
  31:02, 13 of 14"; pins, group pills and footnotes are also Tab-reachable buttons
  named like "#24 Ask, 31:02, unread, waiting on you". Focusing a footnote lifts its pin.
- The Why row is a labelled group. Closing it returns focus to the card.
- Colour is never the only signal: every pin and footnote carries its glyph.

### Phone

Same components and order; only size and wrapping change (B3's phone rules):
- pins 12px text, 17px line, 38px row spacing; the card is full width;
- footnotes are chips with an invisible 32px hit pad, and summary line height 1.85;
- every button is at least 32px tall, including Raise, Lower, Retype, the Read
  checkbox, the level buttons and the summary pill;
- the axis row wraps to two lines and drops `00:00`; the summary pill drops the model;
- text selection uses native handles, and the "select words to reply" hint is hidden;
- Settings › Surfacing becomes three tabs: General, Categories, Feedback.

### Recap block (B3's summary pill and box)

Sits under the axis row.

- **No recap yet:** one dashed pill row, `✦ Summarize turn so far · 30` (live) or
  `✦ Summarize turn · 34` (settled), with `sonnet-5 · on request ▾` on the right.
- **The settings pill** `sonnet-5 · on request ▾` is its own button. It opens a small
  menu: Model (Sonnet / Opus / Off) and When (When a turn ends / On request), with the
  note "Applies to every session · Settings › Surfacing". It writes the daemon
  settings (decision 13).
- **With a recap:** a box (`--surface`, 1px border, radius 8). Its header row: chevron
  (collapses the box), `✦ Summary so far` (live) or `✦ Turn summary` (settled), the
  settings pill, then on the right the version switcher `‹ New since 27:15 · 9 › 2/2`
  (or `Whole turn · 30`). The body: the version's prose at 12.5px, line height 1.7,
  with each `[#n]` as a type-coloured footnote chip with its glyph. Citations to unread
  messages are highlighted.
- **Stale:** the header adds `· 9 new`, and a dashed row at the top of the body offers
  `✦ Summarize 9 new · since 27:15` and `↻ Whole turn`. Generating either appends a
  version and switches to it. Older versions stay one ‹ away.
- **Foot:** `sonnet-5 · 9 updates · 1.6s`, `↻ Regenerate` (a fresh version with the
  same scope), and `✓ Mark N read`.
- Clicking a footnote opens that message in the card above the pins; the summary stays
  open below, so there is no "back to recap". A followed footnote turns dashed.
- **States:** generating (`✦ Summarising…` in the pill or the stale row), failed
  (`Recap failed · Retry` in the same place), model Off (no pill; `✓ Mark N read` moves
  to the axis row), and Claude not signed in (the failure text from the SDK).

### Marks (B3's Raise and Lower)

- Raise, Lower and Retype in the card foot open the Why row described in decision 8;
  `+` and `−` do the same from the keyboard.
- Save → the pin moves, the card shows `▲ you · <reason>`, and a toast `Saved · Undo`
  shows for 6s. Undo restores the previous mark (or none). Pressing the active button
  again clears the mark, with the same toast.
- If a lowered message drops below the level, the card stays open on it with `hidden at
  this level`.
- If a mark's category is later deleted, the mark's level still applies and the
  message shows Jev's category.
- The step log rows use the same buttons and Why row.

### Reply references

- Token look: glyph, `#24`, type (`? #24 Ask`). Excerpt tokens show the quote
  clipped to 24 characters (`? #24 "Recapture it, or keep…"`); the full excerpt is
  sent. Recap excerpts make a `✦ Recap "…"` token, sent as `Re recap: "<excerpt>"`.
- A token is self-contained: it carries its own serialised block, so it survives
  draft persistence, session switching and cross-device draft sync, and sends
  correctly even if the feature is turned off before send. The composer renders it as
  a chip with the same highlight-backdrop technique it already uses for skills.
- `▸ What the agent receives` under the composer previews the exact text that will be
  sent, whenever a token is present.

### Settings › Surfacing

**General:** the experimental toggle; the key field with its state chip (`Not set`,
`Valid`, `Rejected by TypeSafe`, `Set by TYPESAFE_API_KEY`) plus Remove; the
disclosure; the default level control; recap model (Sonnet / Opus / Off) and timing
(When a turn ends / On request); tuning model (from the Claude catalog). Copy notes
that recaps and tuning use the Claude subscription.

**Categories** (B3/M4 list, edited as a local draft with Save and Discard):
- Row: coloured pill (glyph and label), the `what` line, a sample count, a weight
  stepper (−/+ 5, or type a value), and actions. Built-ins: Edit definition, Retire,
  ↺ Reset (only when changed from shipped). Customs: Edit (label, glyph, colour from a
  palette or hex, `what` / `not_for` / `examples`, weight) and Delete (confirmed in the
  row). Retired built-ins sit in a Retired box with Restore. `+ Add category` opens
  the same form at the top.
- **Preview** (B7): above the list, a readout `Of the last 50 judged messages:
  Balanced shows 16 · Key 6 · agrees with 19 of 23 corrections`, recomputed from
  `score(draft)` (debounced) on weight edits, which cost no Jev calls. Criteria edits,
  additions and retirements only re-score when the user presses `Test against my
  corrections`, because that costs Jev calls. The button shows the call count first.
- Copy: "Weight changes re-level every message at once, at no cost. Definition
  changes and new categories apply to messages judged from now on."
- Validation (daemon, in `replace`, mirrored in the form): label 1–24 chars, glyph one
  character, colour a hex value, id derived from the label at creation and immutable,
  at most 20 active categories (each is a Choice option).
- Stale version on Save: "Categories changed elsewhere." Reload, keeping the draft
  visible so it can be re-applied by hand.

**Feedback** (M4 ledger):
- **Tiles:** `23 marks · 14 ▲ · 9 ▼`, retypes counted separately, most-raised and
  most-lowered category, and top reasons.
- **Grid:** "Jev said → you said" by category.
- **Records:** newest first, with time, project, session title, `#n`, an excerpt,
  Jev's current answer (category, p, level), the mark, the reason, and agrees /
  disagrees with the current set. Clear per record.
- **Empty:** "No corrections yet. Use ▲ Raise or ▼ Lower on any surfaced message."
- **Propose changes:** disabled below 5 marks ("Needs 5 corrections, 3 so far"). While
  running: `✦ Reading 23 corrections and 10 categories…`. On a schema failure:
  "Couldn't read the proposal. Try again".
- **Proposal review:** one hunk per change, each with the category, before → after
  (a text diff for criteria, `40 → 55` for weight), the rationale, Evidence (its cited
  marks, each showing whether it agrees under the current candidate), and a tick.
  Above the hunks: `Agrees with 14 → 19 of 23 corrections · moves 6 other messages`,
  with the moved list expandable. Ticking re-scores. `Apply` calls `replace`; then
  `View in Categories`. `Propose again` passes the unticked changes as `avoid`, so the
  next proposal doesn't repeat them.

### Test IDs

Prefix `surfacing-`: `card`, `msg-card`, `pin-<n>`, `group`, `scrub`, `head-unread`,
`ask-chip`, `progress`, `level`, `level-default-dot`, `not-judged`, `read-toggle`,
`mark-raise`, `mark-lower`, `mark-retype`, `mark-why`, `toast-undo`, `step-mark-<n>`,
`summary`, `summary-generate`, `summary-settings`, `summary-version`, `summary-new`,
`recap-cite-<n>`, `ref-token`, `ref-preview`, `settings-general`,
`settings-categories`, `category-row-<id>`, `settings-feedback`, `ledger-record`,
`proposal-hunk-<id>`. The mocked-WebSocket acceptance harness gains fixtures for every
new RPC and part field.

### Departures from the mockups

- **The card sits above the pins in settled turns too.** B3 put it above while live
  and below when settled; one position is easier to learn, and the summary box below
  keeps its place.
- **The card body is never clamped** (B3 clamped to 5 lines). The full message is the
  point of opening it.
- **No zoom loupe** (round 2's B3). Two rows, group pills and scrubbing reach every pin;
  a grouped member shows its number in the pill while current.
- **No half-read state** (B7's "read via recap"): it muddied the count. Recap
  citations to unread messages are highlighted instead.
- **"Since you last read" became "New since the last recap"** (B3's scope switch). Same
  catch-up, but the cache doesn't depend on each viewer's reads. No length setting, no
  "whole session" scope, no Codex recap model; at most 4 sentences.
- **Replies are composer tokens** (decision 12), not B3's in-card draft and staged
  "pending replies" list.
- **No feedback.jsonl or "Open file"; no "Ask an agent to tune" session.** Marks live
  in the read model (ADR-0004 amendment); tuning is the in-Settings proposal review.
- **Weights re-level past messages at once** (M4's copy said past turns keep their
  levels). Decision 5 wins.
- **Recap timing has two options** (when a turn ends, on request); B7's "back after
  5+ min away" and "when 5+ are unread" were dropped. The default is "when a turn
  ends" (B3/B7's was "on request"), because settled turns open on the recap.
- **No cost in the summary pill or foot** (B3 showed `~$0.005`). Recaps run on the
  Claude subscription, so there is no per-call figure to show. The model stays.
- **Read after 1s open while visible**, not on open (B3 marked viewed on open). Auto-follow
  and arrow-key stepping would otherwise mark unwatched messages read. The checkbox says
  `Read`, not `Viewed`, to match the unread count.
- **`s` toggles the summary, `r` replies, `+`/`−` raise and lower, `m` toggles read,
  `u` is next unread** (B3 used `v` and `n`; B7 used `r` for the recap).
- **The Categories preview is a readout over the feedback sample**, not B7's live tick
  lane of the current turn. Settings has no "this turn".
- **Proposal evidence is agreement over your corrections plus "moves N other
  messages"**, not M4's "what it would have changed in this turn".
- **Rejected proposal hunks aren't remembered across sessions** (M4 logged them).
  `avoid` covers "Propose again" within one review.
- **No ledger deep link** to open a record's message in its session. Later.

## Module shape

- **`MessageSurfacing`** (relay).
  - Interface: watches ingestion and appends `text.surfaced`.
  - Hidden: completion detection, `ordinal`, idempotency, and failure verdicts.
  - Guarantees at most one verdict per part; never drops one silently.
- **Jev client** (daemon, plain module, not a seam).
  `judge(input, categorySet) => Effect<Probabilities, JudgeUnavailable>`.
  - Hidden: building the Choice, transport guard, 2s timeout, one retry on 429/5xx,
    and the one concurrency limit (8 in flight, a short bounded queue, then
    `JudgeUnavailable`). Live judging and `score` share it, so tuning can't starve
    live turns of more than the limit.
  - Two callers: `MessageSurfacing` and `CategoryTuning.score`.
  - There is one real implementation. Tests fake the TypeSafe server at the network
    edge through `TYPESAFE_BASE_URL`, not with an in-process fake.
- **Shared one-shot Claude call** (daemon). `ask(prompt, schema, model) => Effect<T, Failure>`.
  - Hidden: Claude Agent SDK options, single turn, schema validation.
  - It generalises the title service's injectable query factory. `SessionTitleService`,
    `RecapService` and `CategoryTuning` all use it, so it has three callers.
  - The process harness's fake SDK covers it.
- **`CategorySet`** (daemon).
  - Interface: `current()`, `replace(expectedVersion, nextSet)`.
  - Hidden: file IO and validation. The defaults live in contracts.
- **`surfacingLevel(verdict, categorySet, mark?) → { level, category }`** (contracts,
  pure). This is the only place the level arithmetic lives. It is used by the card,
  the ledger and `score`.
- **`SurfacingFeedback`** (relay).
  - Interface: `set(partId, mark | null)`, `ledger()`. A ledger record carries the
    mark, the part's verdict, `ordinal`, a message excerpt, the request excerpt, and
    the session id and title; the browser derives tiles, grid and agreement.
  - It owns `surfacing_marks` and stamps the part row.
  - The daemon merges ledgers across projects.
- **`SessionAttention`** gains per-message `setRead(partIds, read)`.
- **`RecapService`** (relay). Interface: `list(turn) → versions` and
  `generate(turn, scope: whole | new) → version | failed`, with the paid-call rule in
  decision 13. Hidden: building each scope's input, citation filtering, the
  turn-completion trigger.
- **`CategoryTuning`** (daemon, stateless).
  - Interface: `propose({ avoid? })`, `score(set)`.
  - It writes nothing; accepted changes go through `CategorySet.replace`.
- **`MessageSurfacingSettings`** (daemon). As in the first plan, plus the new fields.
- **`surfaceTurn(...)`** (frontend, pure). The card's view model (decision 15):
  pins placed on the strip's step weights (rows and groups), the card target, open
  Ask, unread count, next unread, not-judged count, and numbers.

RPCs: Get/UpdateMessageSurfacing, GetCategorySet, ReplaceCategorySet,
SetSurfacingMark, GetSurfacingLedger, SetMessagesRead, ListRecaps, GenerateRecap,
ProposeCategoryChanges,
ScoreCategorySet.

## Testing

Two existing seams, confirmed 2026-10-05. Each test leaves a repeatable artifact.

1. **Claude process harness** (`test/integration/daemon/`): the real built server, a
   fake Claude SDK playing the agent, the recap model and the tuning model, and a fake
   TypeSafe server reached through `TYPESAFE_BASE_URL`. Everything is driven through
   browser RPC and the WebSocket. Covers:
   - flag off sends zero TypeSafe requests and leaves the transcript unchanged;
   - every part the card folds gets exactly one verdict with the right `ordinal`,
     across tool, thinking, hand-back and compaction orderings, and no part gets two;
   - verdicts reach part rows through the subscription;
   - failure verdicts, including queue overflow under a burst of parts;
   - a weight change re-levels with no new TypeSafe call;
   - marks and read state persist across a restart;
   - a marked message keeps its level after a weight change;
   - recap citations are limited to real numbers, and survive a mark;
   - recap timing "on request" makes no Claude call until Summarize is pressed;
   - a New recap's input holds only the messages after the previous version plus its
     text, and both versions are listed afterwards;
   - at turn completion, a turn with a stale "so far" recap gets a New version, not a
     second Whole one;
   - reply blocks reach the agent's prompt verbatim;
   - propose → score(current) and score(candidate) → replace bumps the version, and a
     stale version is rejected;
   - scoring the current set, and weight-only re-scoring, make no TypeSafe request.

   Artifact: a JSON record of the requests each fake received.
2. **Acceptance pipeline** (Gherkin against a mocked WebSocket):
   - new feature files: card and levels (including the per-session override, read
     state, pin rows, groups and scrubbing), marks, reply references, recap versions,
     Settings › Surfacing, feedback ledger and tuning;
   - append each one to the hardcoded list in `scripts/acceptance-visual.sh`, or it
     silently never runs;
   - capture baselines and review them visually.

The eval spike (ticket .1) is a measurement, not a test.

## Cost estimate

Price: $0.042 per million input tokens, output free. Structured criteria for about 10
categories bring a call to roughly 1,000–1,500 input tokens, about twice the Noul
estimate. The eval spike measures the real figure.

| Scope | Calls | Cost |
|---|---|---|
| Average session (~30 mid-turn parts) | ~30 | ~$0.002 |
| Busiest session ever (~2,300 parts) | ~2,300 | ~$0.15 |
| All of this project, 5 months (~9,200 parts) | ~9,200 | ~$0.60 |
| One tuning score | up to ~75 | < $0.01 |

Recap and tuning calls use the Claude subscription, so they cost rate limit, not
money. An automatic recap is one call per settled turn.

## Fit with existing work

- **`conduit-test-ni8.5.20`: landed.** Verdicts, marks and reads are ordinary
  part-row updates delivered by the subscription.
- **`conduit-test-6ol`: landed.** OpenCode history is read from projections, so
  ticket .7 shrinks to verifying it.
- **`conduit-test-ni8.12` (soft).** Live fan-out of settings and category-set changes
  to other browsers. Until it lands, they pick changes up on reconnect.
- **`conduit-test-d7o6`.** Every new write uses patch semantics or `expectedVersion`.
- **ADR-0004 amendment.** Marks and read state stay out of the event log, by the same
  reasoning as session read state.
- **Forks.** A fork shows the parent's pre-fork messages from the parent's parts, so
  their verdicts, marks and read state come along with no copying. Verify in .7.
- **`conduit-test-ly9n` / the compaction-in-activity spec.** Surfaced messages no
  longer split segments, so the double-strip concern from the first plan is gone.

## Tickets

| Bead | Ticket | Blocked by |
|---|---|---|
| .1 | Eval spike: Choice accuracy, routine precision/recall, level agreement, tokens, latency, vs heuristic | none |
| .2 | `text.surfaced` with probabilities, part-row columns, projector | none |
| .3 | Settings, credentials and RPCs: flag, key, base URL, default level, recap and tuning model settings | none |
| .9 | `CategorySet` (`current`, `replace`), `surfacingLevel`, category-set RPCs | none |
| .15 | Shared one-shot Claude call; move `SessionTitleService` onto it | none |
| .4 | `MessageSurfacing` service: Choice from the category set | .1, .2, .3, .9 |
| .5 | Settings UI: Surfacing tab, General and Categories | .3, .9 |
| .6 | Frontend: B3 card in `TurnActivity`, pins over `ActivityStrip`, scrub and tap, axis row, levels, override, hold rule | .2, .3, .9 |
| .16 | Pin lane density: two rows, group pills, overflow | .6 |
| .10 | Marks: table, RPC, Raise / Lower / Retype with the Why row, ▲ ▼ in the step log | .2, .6 |
| .11 | Per-message read state | .6 |
| .12 | Reply references | .6 |
| .13 | Recap: versions (Whole, New since last), summary pill and box, settings menu | .6, .15 |
| .14 | Feedback ledger and Improve with Opus (`propose`, `score`) | .4, .5, .9, .10, .15 |
| .7 | Verify OpenCode sessions show surfaced messages | .6 |

## Open questions

1. Should unread surfaced messages mark the session unread in the sidebar? Out of
   scope for v1.
2. "Re-judge this session" after applying a proposal (~$0.002 per session)? Later.
3. A Codex model option for the recap? Later. v1 offers Claude models and Off.
