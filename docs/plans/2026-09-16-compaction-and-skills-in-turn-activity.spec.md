# Compaction and skills in the turn activity ledger

## Problem Statement

Three problems, all in how a turn reports what happened during it.

**A completed compaction interrupts the transcript instead of joining the record.** When the model's context is compacted mid-turn, the "Context compacted" divider renders as a full-width system notice wedged between the turn activity panel and the reply. It sits at the same visual weight as a crash, so it reads as "something went wrong" every time; and once the user scrolls past it, the one fact that matters later, that the model's memory was cut at this point in the turn, is gone. A user looking at a turn where the model re-read a file it had already read has no way to see that a compaction is the reason.

**Compaction never survives a reload, because the feature was built against a projector that production does not run.** The project's own event store holds 129 `session.compaction` events with state `completed`, spanning three months, and **zero** corresponding rows in `message_parts`. The cause is that the codebase contains two message projectors: a synchronous one that declares and implements compaction handling, and an Effect one that does not mention compaction anywhere. Only the Effect projector is wired into the running daemon; the synchronous projector, and the persistence layer that constructs it, have no production consumer at all and are reached only from tests. The commit that added compaction persistence touched the synchronous projector and its test file and never touched the Effect projector.

The failure is silent by construction. The Effect projection runner builds its dispatch map from each projector's declared handled types, so an unclaimed event type dispatches to zero projectors with no write, no error and no log line, while the projector's cursor advances past it regardless. The result is a green test suite over dead code, a feature that has never once worked in production, and three months during which nothing anywhere could have noticed.

For the user this means the in-thread compaction divider disappears the moment the session is reopened, and the post-compaction context gauge silently reverts to the pre-compaction figure.

**A skill call is invisible in the one place users read before deciding whether to look closer.** The collapsed summary sentence is built from counted buckets, and there was no bucket for skills, so a turn whose entire purpose was loading a skill described itself as "1 other". The skill was always in the duration strip and in the expanded log; only the summary refused to name it. Beyond naming it, there is no way to ask the obvious follow-up question: *which* skills ran, and *when* during the turn.

## Solution

A completed compaction becomes part of the turn's record rather than an interruption of it, and the persisted path that makes that record survive is repaired and tested. Separately, skills get named in the summary and become a way in to their own detail.

**Compaction splits by state rather than being one renderer.** A compaction in progress stays in the main thread, because the user is waiting on it and it belongs where they are already looking. A failed compaction stays a notice in the main thread, because the existing rule that a failure is never hidden behind a collapsed panel is correct. A completed compaction moves into the turn activity ledger, because it is history rather than news, and because its position in the sequence of work is the entire point.

Inside the ledger it appears at three weights, so what it costs the reader scales with how closely they are looking. Collapsed, a small badge on the summary row, in the same slot and at the same weight as the existing "N failed" badge. In the duration strip, a narrow fixed-width hatched seam at the point in the turn where it happened. Expanded, a full-width rule across the log with the token figures on it, separating the work before from the work after.

The seam is deliberately not weighted by duration. Every other strip segment's width means "how long this took". A compaction takes ten to thirty seconds of wall clock but it is not work, and weighting it would draw a wide bar that reads as progress. A narrow fixed seam reads as what it is: the timeline was cut here.

**The persisted path is fixed in the projector production actually runs, and the duplication that allowed the mistake is removed** so it cannot recur for the next event type. The fix is covered by a test that drives an event through the real ingestion path, not one that hands an event directly to a projector class. Compaction events already sitting in users' stores are recovered by a backfill, since every one of them retains a complete payload.

**Skills are counted in their own bucket and the count is clickable.** The summary sentence stops being one opaque string and becomes a sequence of parts, so the skills part can be a control. Activating it opens a list of the skills that ran in that turn, each with its name, how far into the turn it started, and how long it took; activating a row jumps into the expanded log at that step. While the list is open the strip emphasises the skill segments, so the "how far in" reads spatially as well as numerically.

## User Stories

### Compaction in the ledger

1. As a user reading a finished turn, I want a completed compaction to appear inside the turn activity panel, so that the transcript is not interrupted by a full-width notice at error weight.
2. As a user scanning a collapsed turn, I want a small badge on the summary row when a compaction happened, so that I can tell at a glance without expanding anything.
3. As a user reading that badge, I want it to show the before and after context sizes, so that I know how much was discarded.
4. As a user scanning the duration strip, I want a visible marker at the point in the turn where the compaction happened, so that I can see which work happened before it and which after.
5. As a user comparing turns, I want the compaction marker to be a fixed narrow width rather than scaled by how long the compaction took, so that it never reads as a long stretch of productive work.
6. As a user who expands the activity log, I want the compaction to render as a full-width rule rather than an indented tool row, so that its shape tells me it is a boundary before I read the words.
7. As a user reading the expanded log, I want the rule to carry the before and after token figures and whether the compaction was automatic or manual, so that I do not have to look elsewhere for the detail.
8. As a user debugging why the model re-read a file it had already read, I want to see the compaction seam above that row in the log, so that the cause is visible where the symptom is.
9. As a user in a long turn that compacted more than once, I want each compaction to get its own seam and rule, so that the record stays accurate without a new concept.
10. As a user in a turn with multiple compactions, I want the summary badge to collapse to a count rather than trying to show every token pair, so that the summary row stays scannable.
11. As a user waiting on a compaction that is currently running, I want it to keep showing as a status message in the main thread, so that I can see the session is busy without opening a panel.
12. As a user whose compaction failed, I want the failure to stay a notice in the main thread, so that it is never hidden behind a collapsed panel.
13. As a user, I want a compaction to appear at the correct position among the turn's other steps rather than being appended at the end, so that the ordering reflects what actually happened.
14. As a user of a turn that compacted before any tool ran, I want the seam to appear at the start of the strip, so that "nothing happened before it" is visible.
15. As a user, I want a compaction that arrives between two turns to remain a thread-level element rather than being forced into an adjacent turn's ledger, so that the record does not claim it happened during work it did not.
16. As a user hovering the compaction segment in the strip, I want the hover caption to describe it the way it describes any other step, so that the strip behaves consistently.

### Compaction persistence

17. As a user reopening a session, I want compactions that happened in that session to still be visible in the turn activity, so that the record of a turn does not change depending on when I look at it.
18. As a user reopening a session, I want the context gauge to reflect the post-compaction size rather than reverting to the pre-compaction figure, so that I am not misled about how much context is in use.
19. As a user reopening a session, I want a compaction to appear at the same position within the turn as it did live, so that reload does not reorder the record.
20. As a user with existing sessions whose compactions were never persisted, I want those events recovered from the stored event payloads, so that history is repaired rather than only fixed going forward.
21. As a user running the backfill, I want running it twice to be harmless, so that I do not have to reason about whether it has already been applied.
22. As a maintainer, I want the compaction persistence path covered by a test that drives an event through the real ingestion path rather than instantiating a projector directly, so that a test cannot be green while the feature is dead.
23. As a maintainer, I want a failing test written before the fix that reproduces the silent drop through the real path, so that the fix is proven to address the actual cause.
24. As a maintainer, I want only one message projector to exist, so that a future feature cannot be implemented against a version production does not run.
25. As a maintainer, I want any canonical event type that no live projector claims to fail a check, so that an unclaimed type is caught at build time rather than discovered months later by querying a database.
26. As a maintainer, I want a projection run that dispatches an event to zero projectors to be distinguishable from one that dispatched successfully, so that silent no-ops are observable.
27. As a user, I want a compaction that failed or is still in progress to remain unpersisted, so that the store does not accumulate transient state.

### Skills in the summary

28. As a user reading a collapsed turn summary, I want skills counted and named as skills, so that a turn that loaded a skill does not describe itself as "1 other".
29. As a user reading the summary sentence, I want the skill count to appear in a consistent position relative to the other counts, so that the sentence reads the same way across turns.
30. As a user who wants to know which skills ran, I want to click the skill count, so that I can see the detail without expanding the entire activity log.
31. As a user viewing the skill list, I want each skill's name, so that I know which ones were loaded.
32. As a user viewing the skill list, I want to see how far into the turn each skill started, so that I can tell whether it was loaded up front or reached for partway through.
33. As a user viewing the skill list, I want to see how long each skill's step took, so that I can tell whether it was a cheap load or a long one.
34. As a user viewing the skill list, I want clicking a row to open the expanded log at that step, so that the list is a way in to the full detail rather than a dead end.
35. As a user viewing the skill list, I want the strip to emphasise the skill segments while the list is open, so that "how far into the turn" reads visually as well as numerically.
36. As a user, I want the skill list to dismiss the way other transient surfaces in the app dismiss, so that I do not have to hunt for a way to close it.
37. As a user in a turn with no skills, I want no skill count and no control, so that the summary row does not acquire dead affordances.
38. As a keyboard user, I want the skill count to be reachable and operable without a mouse, so that the detail is not mouse-only.
39. As a screen reader user, I want the skill control to announce what it opens and its expanded state, so that the affordance is not silent.
40. As a user on a narrow viewport, I want the summary row to degrade the way it already does, truncating counts from the right while keeping the duration, so that the new control does not break the existing responsive behaviour.
41. As a user whose turn has no timestamps on its steps, I want the skill list to still show names, omitting the timing rather than guessing it, so that the list never shows an invented number.

## Implementation Decisions

### Compaction as an activity part

The frontend turn model currently treats every system message as a transcript-level notice, hoisted out of the activity log. That single rule is replaced by a distinction between an event and a failure. A completed compaction routes into the current segment's activity in arrival order; an in-progress or failed compaction continues to route to the turn's notices.

To make that routing possible, a compaction must be distinguishable from a generic system message by structure rather than by parsing its prose. The frontend system message type gains explicit compaction fields: the state, the pre-compaction and post-compaction token counts, and whether the trigger was automatic or manual. The wire and the persisted payload already carry the state, the token counts and the detail string; the frontend currently discards everything except the rendered prose and the post-compaction count. The trigger is currently flattened into the detail string by the provider translator and should be carried as a field instead.

The activity part union widens to include the compaction message type. Every consumer that switches over activity parts must handle it: the step label, the hover caption, the row renderer, the per-step icon and colour, and the statistics counter. The counter gains a compactions bucket, used for the summary badge, and compactions are excluded from the tool count so that a compaction never inflates "N tools".

Strip weighting is the one place where the compaction deliberately does not behave like other parts. Step durations continue to be computed the same way for all parts, including the compaction, so the hover caption can report how long it actually took. Step weights special-case the compaction to a fixed minimal weight independent of its duration.

The expanded log's row renderer branches on the compaction part and renders a full-width rule rather than the standard icon-label-detail row. The summary row gains a badge rendered in the same region as the existing failed-count badge, showing the token transition for a single compaction and a count when there is more than one.

Ordering depends on the compaction message carrying a creation timestamp that places it correctly among the surrounding parts. The live path appends in arrival order and is already correct. The persisted path depends on the fix below.

### Compaction persistence

The root cause is confirmed, not hypothesised. The Effect message projector, which is the one the running daemon uses, does not declare `session.compaction` among its handled types and contains no compaction logic. The Effect projection runner builds its dispatch map from those declared types, so the event matches no projector, nothing is written, nothing is logged, and the cursor advances anyway because cursor advancement is unconditional on whether any projector claimed the event. The synchronous projector that does implement compaction is only ever constructed by a persistence layer that nothing in the source tree imports.

The immediate fix is to implement compaction handling in the Effect projector, matching the existing synchronous implementation's semantics: only the terminal completed state is persisted, as a synthetic assistant message owning a single compaction part, with identifiers derived deterministically from the event sequence and both inserts conflict-tolerant so that replay is a no-op.

The durable fix is to remove the duplication rather than keep two implementations in sync. Since the synchronous projector, its projection runner and its persistence layer have no production consumer, they should be deleted along with the tests that exercise them, leaving one message projector. Where those tests assert behaviour not otherwise covered, the assertions move to the Effect projector's suite rather than being discarded. If the duplication is retained for a reason not visible here, the alternative is a parity assertion between the two projectors' declared handled types, but deletion is strongly preferred: parity tests preserve the hazard and only narrow the window.

Two structural guards follow from the failure mode, and are worth more than the compaction fix itself. First, every canonical event type must be claimed by at least one live projector or appear on an explicit ignore list, checked at test time, so that an unclaimed type fails loudly the way the synchronous runner's existing handled-or-ignored guard already does. Second, the Effect runner should make a dispatch to zero projectors observable rather than indistinguishable from success, so the same class of silence is detectable at runtime.

Recovery is straightforward because all 129 stored events retain complete payloads. A one-shot backfill over the compaction events is preferred to resetting the message projector's cursor, which would replay roughly six hundred thousand events for no benefit. The backfill is idempotent by virtue of the deterministic identifiers and conflict-tolerant inserts. One caveat to verify rather than assume: the synthetic message rows carry no turn identifier and their position in the reconstructed transcript depends on their creation timestamp, so the backfill must be checked to land each compaction at the right point in its turn rather than merely inserting the rows.

The provider translator currently folds the automatic-versus-manual trigger and the token transition into the detail prose. The persisted payload should carry the trigger as a field alongside the token counts it already carries, so that the renderer composes its own text and the frontend never parses prose.

### Skills in the summary

The statistics counter gains a skills bucket, populated from the canonical tool name, positioned in the summary sentence between fetches and subagents. This part is already implemented.

The summary sentence currently returns a single joined string. It is refactored to a primitive that returns the counts as an ordered list of parts, each carrying a key and its text, with the existing joined-string function derived from it. This keeps the sentence-building logic in one testable place while letting the component render one part as a control.

A new pure function reports the skill uses in a segment: for each skill step, its index in the activity list, the skill's name taken from the canonical tool input, the elapsed offset from the start of the segment to that step, and the step's duration. Offsets and durations derive from the existing step-duration computation and are absent rather than estimated when the underlying timestamps are missing, consistent with that function's existing contract of never guessing durations.

The turn activity component renders the skills count part as a button that toggles a list anchored to the summary row. Each row in the list shows the skill name, the offset into the turn, and the step duration. Activating a row reuses the component's existing jump behaviour, which expands the log and scrolls to the step. While the list is open, the strip receives the set of skill indices to emphasise, using the same visual mechanism as the existing hover emphasis rather than a new one.

### Design reference

A visual design document covering the compaction treatment, including the rejected alternatives and the reasoning for the fixed-width seam, exists at `docs/plans/2026-09-16-compaction-in-turn-activity.html`.

## Testing Decisions

A good test here asserts what a user would observe: the shape and ordering of the messages a turn produces, the counts and phrases the summary reports, and the fact that reopening a session yields the same record. It does not assert on internal call sequences, on the presence of particular CSS classes, or on the identity of intermediate objects. Where a behaviour is timing-dependent, timestamps are supplied explicitly rather than read from the clock.

**The primary seam is the existing pure turn-logic unit test suite.** It already covers segmentation, hand-back splitting, statistics and counts phrasing, and it is the highest and cheapest seam for most of this work. It gains coverage for: a completed compaction routing into segment activity at its arrival position; an in-progress and a failed compaction continuing to route to notices; a compaction being excluded from the tool count while incrementing the compactions count; the strip weight for a compaction being fixed and independent of its duration while its reported step duration is not; the counts parts function producing the skills entry in the correct position; the skill uses function reporting names, offsets and durations; and that function omitting timing rather than guessing when timestamps are absent.

**The persistence fix is tested through the real ingestion path, and this is the one testing decision in this spec that must not be compromised.** The existing end-to-end pipeline suite drives a stored event through a message projector, the read query service, the history adapter and the history-to-chat-messages conversion to produce frontend messages, which is exactly the right shape. But it constructs the synchronous projector directly, which is the dead one. That suite would have passed throughout the three months this bug was live, and adding a compaction case to it as written would produce a green test over a feature that still does not work.

The test must therefore submit a completed compaction event through the real ingestion service, the same path the daemon uses, and assert the user-visible outcome: after reload, the compaction comes back as an activity part at the correct index in the correct segment, with the turn's other steps in their original order. The existing subagent-materialization pipeline test is the prior art for driving the real ingestion path. Extending the chain with the turn segmentation step lets one test cover event submission through to rendered turn structure.

**This test is written first and observed to fail against the current code.** A fix applied without having seen the failure through the real path is not evidence of anything, given that this is the second time a correct-looking implementation has been landed with green tests against a projector production does not run.

The structural guards get their own tests: one asserting that every canonical event type is claimed by a live projector or explicitly ignored, and one asserting that a dispatch matching no projector is surfaced rather than silently succeeding. The first of these is the test that would have caught the original bug, and is worth writing even if the compaction work is deferred.

The history-to-chat-messages conversion already has direct tests for rendering a persisted compaction part; those are extended for the new structured fields. The provider translator's compaction handling already has direct tests; those are extended to assert the trigger is carried as a field rather than only appearing in prose.

Tests belonging to the deleted synchronous projector are removed with it. Any assertion in them that covers behaviour the Effect projector's suite does not already cover moves across rather than being dropped, and that migration is verified by inspection rather than assumed.

The backfill is tested by seeding a store with compaction events and no projected rows, running it, asserting the rows appear at the correct transcript position, and asserting that a second run changes nothing.

The visual layer is covered by the existing component stories and their visual baselines. New stories are added for a settled turn containing one compaction, a turn containing two, and the skills list in its open state. Baselines are recaptured and reviewed rather than accepted blind.

## Out of Scope

The turn segmentation behaviour around question-and-answer hand-back, raised separately, is not addressed here.

Changing how compaction is triggered, how often it fires, or what the provider does during it. This work only changes how a compaction that has already happened is recorded and presented.

Presenting compaction anywhere outside the transcript, such as in the session list or a session-level summary.

Showing what was discarded by a compaction, or any form of diff between pre- and post-compaction context. Only the aggregate token transition is shown.

Extending the same clickable-detail treatment to the other count buckets. Only skills gain a breakdown in this work; whether reads, edits or commands should follow is a separate question informed by how this one lands.

A general mechanism for popovers anchored to the summary row. The skills list is built for this case; generalising it is premature.

Backfilling compaction events for sessions whose underlying events have been evicted or whose payloads lack the required fields.

Auditing the remaining Effect projectors for the same drift against their synchronous counterparts. The duplication is the underlying hazard and compaction is only the instance that happened to be noticed, so a sweep of the other projectors is warranted, but it is its own piece of work and is tracked separately rather than being folded in here.

## Further Notes

The persistence defect is the highest-priority item in this spec and should ship ahead of the presentation work. It is a live data-loss bug affecting every session, it has been silently live since late July, and the presentation work rests on it: a compaction rendered in the ledger that vanishes on reload is worse than the current notice, because it looks like a durable record and is not.

The architectural finding is not that a test was missing. It is that the repository maintains two implementations of the same projector, only one of which runs, with no mechanism keeping them in agreement and a test suite that exercises the one that does not. A feature was written, reviewed, tested and merged entirely against dead code, and every signal available said it worked. Any response that only adds compaction coverage leaves the next feature free to make exactly the same mistake, which is why deleting the unused implementation is part of this spec rather than a follow-up.

The failure went unnoticed for three months because nothing could have noticed it. There was no error, no log line and no failing test, and detecting it required someone to reopen a session specifically to check that a compaction survived and then query the database when it did not. Guards added in response must fail in CI rather than depend on someone looking.

Work order: fix and guard the persistence path first, then the ledger presentation that depends on it, and the skills work independently of both. The skills statistics bucket is already implemented and covered; only the clickable breakdown remains.
