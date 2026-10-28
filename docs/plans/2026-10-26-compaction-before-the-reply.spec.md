# Compaction before the reply: what the transcript shows between send and the first step

## Problem Statement

**The Working card claims Claude is working on your message while it is compacting.** When you send a message and the context is auto-compacted before Claude starts on it, the transcript shows an empty Working card with a running timer for the whole compaction, often ten to forty seconds. The card says "Working" when nothing is being worked on, and the timer counts housekeeping as work.

**Once it finishes, the compaction is filed as the turn's first step.** It joins the turn activity ledger: the summary row gets a "compacted ×1" badge, the duration strip gets a seam at its start, and the expanded log opens with a rule. The record then says the compaction was part of answering you. In fact it happened before Claude read your message.

**Right after send, the UI commits before it knows what's coming.** Before any event arrives, the transcript already shows the Working card. If the first event is a compaction, the card was wrong from the start, and the user has watched a "Working" timer tick over something else.

## Solution

Between send and Claude's first step, the transcript shows a quiet waiting state instead of the Working card. The Working card appears only once there is work to show.

- **Right after send:** your message appears, and below it a pulse with a dim "Sending…" label. No card, no timer.
- **If compaction starts:** the pulse becomes a full-width live rule reading "Compacting context".
- **If that compaction finishes before any step:** the rule settles in place into the existing "Compacted context" rule, with the before and after token figures and the amount saved, and no layout jump. It stays in the transcript and stays out of the turn's ledger. The pulse returns, labelled "Working", until the first step.
- **On the first step:** the Working card appears below the rule. Its timer counts from send, minus the opening compaction.

A compaction that happens after the turn's first step keeps the ledger behaviour from the Sept 16 spec.

## User Stories

### After send

1. As a user who has just sent a message, I want to see a quiet "Sending…" presence under it immediately, so that I know the send registered.
2. As a user who has just sent a message, I do not want a Working card before anything has happened, so that the UI never claims work it has not seen.
3. As a user who has just sent a message, I do not want a running timer yet, so that I am not watching a clock for work that has not started.
4. As a user whose first event is an ordinary step, I want "Sending…" to give way to the Working card at that moment, so that the switch marks real progress.
5. As a user on a slow connection, I want "Sending…" to stay up for as long as nothing has arrived, so that a long wait still reads as waiting, not as a stall in work.
6. As a user, I want the "Sending…" presence to appear with no delay, so that a fast reply never flickers through a blank gap.
7. As a user with reduced motion enabled, I want the pulse to be still, so that the waiting state does not animate at me.

### Compaction before the first step

8. As a user whose message triggered an auto-compaction, I want "Sending…" to turn into a live "Compacting context" rule, so that I know why nothing else is happening.
9. As a user watching a compaction, I do not want a Working card or timer while it runs, so that housekeeping is not presented as work on my message.
10. As a user watching a compaction, I want the in-progress compaction to appear once, as the rule, and not also as a status message, so that the transcript does not say the same thing twice.
11. As a user whose compaction finished before Claude did anything, I want the rule to settle in place as "Compacted context", so that the transcript keeps a record of where memory was cut.
12. As a user reading the settled rule, I want it to show the before and after token figures, so that I know how much was discarded.
13. As a user reading the settled rule, I want it to show how many tokens were saved, so that the one number worth reading stands out.
14. As a user reading a turn whose context was compacted before it started, I do not want a "compacted" badge on its summary row, so that the record does not claim the compaction happened during that turn's work.
15. As a user scanning the duration strip of such a turn, I do not want a compaction seam in it, so that the strip covers only the turn's work.
16. As a user expanding such a turn's log, I do not want the compaction rule inside it, so that the log starts with the turn's first real step.
17. As a user between the compaction finishing and Claude's first step, I want the pulse to come back labelled "Working", so that I can see the session is still busy without an empty card.
18. As a user whose turn compacts twice before its first step, I want each compaction to get its own settled rule, in order, so that the record stays accurate.

### The timer

19. As a user reading a live Working card after an opening compaction, I want its timer to exclude the compaction, so that it measures Claude's work on my message.
20. As a user reading a finished turn, I want its "Worked" duration to exclude the opening compaction too, so that live and settled figures agree.
21. As a user whose turn had no compaction, I want the timer to count from send, as it does today, so that the wait for Claude's first response still counts.

### Failure and interruption

22. As a user whose compaction failed before the first step, I want the failure to show as an error notice, as it does today, so that a failure is never hidden.
23. As a user whose compaction failed, I want the live rule to go away, so that the transcript never shows a compaction as both running and failed.
24. As a user who pressed Stop during a compaction, I want the live rule to disappear and no settled rule to be left, so that the transcript does not record a compaction that never finished.
25. As a user whose daemon restarted mid-compaction, I want the live rule to disappear rather than stick, so that the transcript never claims a compaction is still running.
26. As a user whose browser reconnected mid-compaction, I want the live rule to come back, so that a reconnect does not hide what the session is doing.

### History and mid-turn

27. As a user reopening a session, I want settled opening-compaction rules to appear where they were, so that the record survives a reload.
28. As a user whose turn compacts after its first step, I want that compaction to stay in the turn activity ledger, with badge, seam and log rule, as it does today, so that mid-turn behaviour is unchanged.
29. As a user whose turn compacts mid-turn, I want the in-progress compaction to keep showing as a status message, as it does today, so that mid-turn behaviour is unchanged.

## Implementation Decisions

- **The turn projection owns all of it.** This is the module that splits the flat transcript into turns, and the timer, ledger stats and duration strip already read from it. Each turn gains two fields:
  - **`preface`**: the ordered list of completed compactions that arrived before the turn's first step. The first step is the first activity part, reply text or hand-back in the turn's first segment. These compactions are not added to the segment's activity.
  - **`opening`**: one of `sending`, `compacting` or `working`, or absent. It is absent once the turn has a step. It is `compacting` while a compaction-started notice is on the turn. Otherwise, on the live turn, it is `working` if the turn has a preface or any notice, and `sending` if nothing has arrived. It is deliberately not called "waiting": the Turn log redesign (`conduit-test-xdyjq.10`) uses `waiting` as a turn phase meaning "waiting on the user's answer to a hand-back".
- **`compacting` does not check whether the turn is live.** The compaction-started notice only exists while the server reports the session as compacting, and the server clears that when a turn ends or the session goes idle. Not gating on liveness means a `compacting` row that reaches the browser before the turn counts as live cannot flash a plain notice.
- **The compaction-started notice leaves `notices` before the first step.** It is shown only as the live rule. After the first step it stays a notice, as today.
- **Ledger stats need no change.** Preface compactions are not activity, so the summary badge count, strip seams and expanded-log rule skip them automatically.
- **Working time subtracts the opening compaction.** The start is the later of today's start (the server's turn timing, or failing that the prompt's send time) and the last preface compaction's stamp. A compaction's stamp is when it completed. Approval waits and gaps between segments are already excluded; this extends that rule.
- **Render order within a turn:** prompt, preface rules, opening state, turn activity (only once there is a step), notices, reply. The placeholder Working card for an empty live turn is removed.
- **Lands after the Turn log redesign's one-component-per-Turn change** (`conduit-test-xdyjq.18`), which rewrites the same render loop. That change draws the turn component when a Turn "has any activity or is live". This work drops the "or is live" half.
- **Mid-turn "Compacting…" in the card head**, when follow-up `conduit-test-jdy7t.1` adds it, uses the head's run-label seam from `conduit-test-xdyjq.6`, not a new slot.
- **The settled rule is the existing compaction rule** from the expanded log ("Compacted context", before and after tokens, amount saved), rendered at transcript level at quiet weight, never error weight. It shows no automatic-or-manual trigger, because the frontend message carries none today.
- **The live rule settles in place with no layout jump.** The live and settled rules have the same position and height, and only the content changes.
- **The pulse sits where the Working card's head will appear**, so the switch from pulse to card does not move your message.
- **The live rule** is full width, with a dim spinner and "Compacting context". The pulse and spinner are static under reduced motion.
- **No grace delay** before "Sending…".
- **Transport is unchanged.** The in-progress compaction still rides the session row and becomes a client-side notice. Replacing that with run state is follow-up `conduit-test-jdy7t.1`, which waits on the Run Ledger (`conduit-test-82tn.32`).
- **The "Sending…" proxy is temporary.** For now, "sending" means the session is processing and the turn has nothing yet. When the Run Ledger lands, it moves to the ledger's Starting/Accepted run status, as part of `conduit-test-jdy7t.1`.
- **Provider-agnostic.** The design keys off the canonical compaction event and the projected messages, so any provider that emits compaction gets the same behaviour.

## Testing Decisions

- **One seam: the visual acceptance pipeline**, driven through the mocked browser socket against a preview build. A good test asserts what the user sees (text, presence or absence of the card, badge and timer figures) and a baseline screenshot of the messages region, never projection internals. No unit tests.
- **One new feature file** for the turn's opening, appended to the visual runner's hardcoded feature list, or it never runs. Scenarios:
  - Sent, no events: "Sending…" pulse, no Working card, no timer.
  - Compacting before the first step: live "Compacting context" rule, and no compaction status message.
  - Compaction completed, no step yet: settled "Compacted context" rule with tokens and amount saved, plus a "Working" pulse.
  - First step after the compaction: rule above the Working card, no "compacted" badge, and a timer that excludes the compaction (send at T, compaction completes at T+40s, clock at T+45s: timer reads 5s).
  - Compaction failed before the first step: error notice, no rule.
  - Stop during the compaction: no rule left behind.
  - Reload of a finished turn: settled rule still present, "Worked" duration excludes the compaction.
  - Mid-turn compaction (regression): stays in the ledger, badge reads ×1.
- **Prior art:** the composer context-warning steps already toggle a session row's in-progress compaction, and the transcript feed-states feature shows the scenario-plus-baseline shape.
- **Mutation:** run the visual mutation workflow once on the new feature to confirm the example values (such as the 5s) are wired to real assertions.
- **Existing baselines:** any baseline that captured a live turn with no steps will change from the empty Working card to the "Sending…" pulse. Re-capture those and review them visually, not blindly.
- **Artifact:** the committed baseline images and a green `pnpm acceptance:visual` run.

## Prior Art

Surveyed 2026-10-23 at these revisions: t3code `c96a4bb` (main), bb `1e80ca7` (main), paseo `59b01b3` (main), zeron `dd0c36f`, diri `e280a76`, monocode `74b8139` (main), capy (docs snapshot fetched 2026-10-23; vendor claims, not code).

- **After send, nobody waits for the first event to choose a presentation.** Every GUI competitor shows the prompt immediately with a generic busy state and turns Send into Stop, with no assistant placeholder. bb is the only one with a delay: 1.5s before "Working…" on an empty timeline, and 1s before its compaction row. zeron shows "Sending…", then "Thinking" when the turn starts.
- **Compaction convergence (t3code, bb, paseo):** an inline transcript row or divider reading "Compacting…" that updates in place to "Context compacted" and persists. t3code also switches its header to "Compacting…" and hides its Thinking row, with before and after tokens when available. paseo and bb keep their generic working indicator running alongside. zeron, monocode and diri show nothing distinct when compaction starts.
- **Timers:** all five competitors that show a timer include compaction time.
- **Conduit takes:**
  - the in-place rule that settles and persists (the convergence)
  - zeron's "Sending…" label
  - t3code's suppression of the busy indicator while compacting
- **Conduit departs on purpose:**
  - **The timer excludes the opening compaction.** Conduit's clock already excludes approval waits, and the rule shows the compaction separately.
  - **No delay before "Sending…".** The pulse is quiet enough to show at once.
  - **Mid-turn compaction stays in the turn activity ledger** (Sept 16 spec), not inline.
- **Gaps nobody fills:** compaction shown in the context meter, a viewer for the compaction summary, and handling "we don't know yet what's coming" at send time. The "Sending…" morph addresses the last one.

## Out of Scope

- **Mid-turn compaction display.** It stays as the Sept 16 spec defines it.
- **Replacing the transient compaction transport** (session row field plus client-side notice) with Run Ledger state. That is follow-up `conduit-test-jdy7t.1`.
- **Retry notice behaviour.** Retry shares the notice transport and is unchanged.
- **Compaction in the context meter, and a compaction summary viewer.**
- **Server or persistence changes.** None are needed.

## Further Notes

- **Amends the Sept 16 spec** (`2026-09-16-compaction-and-skills-in-turn-activity.spec.md`):
  - **Story 14 is superseded.** A compaction that completes before the first step leaves the ledger.
  - **Story 11 narrows to mid-turn.**
  - **Story 15 is extended:** the moment before Claude starts on a message is treated like the gap between turns.
  - **Story 7's trigger is not shown.** The settled transcript rule reuses today's rule, which has no trigger field to show.
- **Design page:** `docs/html_design_pages/compaction-send-states/`. The chosen options are S1 with the 2B label (neutral presence with "Sending…") and C1 (live seam), with 1A (settled rule stays in the transcript).
- **Follow-up epic:** `conduit-test-jdy7t` holds work that waits until `conduit-test-82tn` lands.
