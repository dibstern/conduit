# Sticky turn: one owner for transcript scroll intent

Bead: `conduit-test-o8pak` (sticky turn activity head). Base: `tlr/integrate` at `b23650c2`.
Status: design accepted after three consecutive material review rounds. No production code yet.

## Goal

A reader expands a long turn log, scrolls through it with the turn head stuck at the top, and collapses, picks or
reveals from anywhere. The transcript must:

- never snap away from what the reader is looking at;
- never lose the reader's own scroll;
- close the phone session bar only because the reader moved to the latest message.

The shipped behaviour stays as it is, including the 20 sticky scenarios in `features/turn-activity.feature`, the
506tp same-frame rules and the phone bar rules in `test/unit/stores/session-view-compact.test.ts`.

## The pattern

The transcript's scroll position has seven writers:

1. the scroll controller;
2. `showTurnTarget`, which writes `root.scrollTop +=` outside the controller's recording;
3. the `scrollIntoView` center call in `reveal.svelte.ts`;
4. the TurnLog "earlier steps" anchor;
5. the MessageList clearance shift;
6. browser clamping;
7. the reader.

The controller never learns which writer moved the view. It guesses after the fact from three things:

- a remembered position (`programmaticScrollTop`);
- a time window (`jumpFrame`, one rAF);
- a flag that excuses its own edge (`preserveBar`).

The phone bar then guesses the reader's intent a second time, from rising edges of the derived following state in
`publishAtBottom`.

Every material finding across the three rounds is one of these guesses going wrong:

| Round | Finding | Guess that failed |
| --- | --- | --- |
| R1-B | Open card hidden under the head after `scrollIntoView` | Unrouted writer, no inset |
| R1-D | Phone bar collapses on collapse via `onjump` | Bar read a layout edge as reader intent |
| R2-P1 | Collapse that makes the transcript fit closes the bar | Same as R1-D |
| R2-P1 | Pin reveal scrolls up while following, next update snaps back | Unrouted writer, controller still following |
| R2-P2 | Dwell reads cards hidden under the head | Visibility measured without the sticky inset |
| R3-P2 | Reader scroll during the reveal settle frame is discarded | Time window swallowed reader input |

Each fix added a guard or a window, and that guard produced the next finding. In one sentence, the premise is
"the controller can tell who moved the view by looking at where it ended up and when". Two actors hold the
imbalance. The controller infers intent, and the session bar infers it again from the controller's output.

## State ownership

| State | Owner | Only writer |
| --- | --- | --- |
| Bottom-follow intent (`bottom` / `reading` / `holding`) | scroll controller | one `apply(event)` that assigns `nextIntent(intent, event)`; `settle()` is one of its events |
| Expected position of the controller's own write (`lastWrite`) | scroll controller | `write(top)`; cleared by the next mismatched scroll event or the rAF expiry |
| Layout observation (`extent`, `gap`, `extentFloor`) | scroll controller | `observe()` |
| Last consumed position (`seenTop`) | scroll controller | the scroll-event consumer in `onScroll` |
| `pinned` | derived (`gap < REFOLLOW_THRESHOLD`) | none |
| `ScrollState` (`loading` / `following` / `detached`) | derived (lifecycle, navigation, intent) | none |
| Transcript `scrollTop` | the reader, plus the controller through `write()` | every other code writer is moved behind the controller (T4) |
| Phone bar `barOpen` | session-view store | `noteScrollGesture`, `forceBarOpen`, `noteSessionChanged` (unchanged) |
| `--turn-reveal-margin` | TurnActivity sticky head | one ResizeObserver on the head (T5) |
| `activeMessageId`, `selectedTop` | scroll controller | `measure()` and `place()` (unchanged) |

Deleted state:

- `userDetached`
- `pinned` as a field
- `jumpFrame`
- `preserveBar`
- `sessionViewState.atBottom`
- `lastAtBottom`

Glossary. **Bottom follow** is the transcript tracking its own bottom. It is a different thing from the surfacing
card's **Following** in `CONTEXT.md`, so the intent value is named `bottom`, not `following`. The public
`ScrollState` keeps its existing `"following"` value.

## Design

### 1. One intent and its transitions

The controller holds `intent: "bottom" | "reading" | "holding"`. `holding` exists only inside a `reposition` transaction
(section 3). `ScrollState` is derived from lifecycle, `historical`, `busy` and intent, so `holding` is never seen
outside the transaction.

`settle()` is the one rule for every movement the controller caused or explained. It sets `bottom` if the gap is
below 5px and `reading` otherwise. `historical` and `busy` are not checked there, because `ScrollState` already
derives `detached` from them.

| Event | Next intent | Calls `onReaderFollow` |
| --- | --- | --- |
| Reader scroll ending within 5px of `extentFloor` | `bottom`, then write to the current bottom if the gap is above 0 | Yes, when the derived state becomes `following` |
| Reader scroll with gap above 50px | `reading` | No |
| Any other reader scroll | Unchanged | No |
| Event matching `lastWrite` | Unchanged | No |
| Browser clamp, or content fits while `reading` | `settle()` (the gap is 0, so `bottom`) | No |
| Growth while `bottom` | `bottom`, write to the bottom | No |
| `place("latest")` (jump button, composer send) | `bottom` | Yes, when the derived state becomes `following` |
| `place(message)` | `settle()` | No |
| `reposition` starts or ends | `holding`, then `settle()` | No |
| `resetForSession` | `bottom` | No |

Rows are checked top to bottom, and the first match wins. A reader who reaches an old bottom after growth of more
than 50px matches the first row, not the second.
The 5px and 50px thresholds keep their current values and their current hysteresis.

The invariant is that outside `holding`, every settle point that finds the view at the bottom resolves to `bottom`.
This keeps the shipped behaviour that a collapse or clamp to the bottom resumes following. Today that happens by
accident, when the clamp event is read as the reader. After this change it happens by rule.

The transitions live in one pure function, `nextIntent(intent, event)`, inside `scroll-controller.svelte.ts`. Unit
tests drive it through the controller's public surface, not through the function itself.

Every controller write goes through `write(top)`, which records `lastWrite` and calls `observe()`. That covers
`scrollToBottom`, `place`, `onPrepend` and `reposition`. Today `place` and `onPrepend` write without recording.

`lastWrite` and `seenTop` are separate on purpose:

- `lastWrite` is the 506tp expected position. It expires at the next frame. It is shipped and tested, so it is kept
  as it is.
- `seenTop` is the `scrollTop` of the last scroll event the controller consumed. It is used only to recognise a
  clamp. `observe()` never sets it. A read during a content change can include a reader scroll whose event has not
  arrived yet, and that is the 506tp hazard.

`requestFollow` has no production caller and is deleted. Its tests move to `place("latest")`.

### 2. Explained positions, with no time windows

A scroll event belongs to the controller in exactly two cases:

- **Own write.** `scrollTop === lastWrite`. The rAF expiry from 506tp is kept.
- **Clamp.** `seenTop > max` and `scrollTop === max`. A shrink left the last known position past the new bottom.

Every other event is the reader's.

**R3 rule.** `extentFloor` is the smallest extent observed since the later of the last consumed scroll event and
the controller's last `write()`. A controller write resets it to the current extent: after a write the controller
knows where the view is, so an older, smaller bottom is no longer one the reader can have reached. Without the reset
the 506tp case (follow-write to 1900, then the reader scrolls up 400px to the old bottom 1500 in the same frame)
would wrongly follow. A reader who
reached any bottom that existed during that span reached the bottom. The controller follows, then writes to the
new bottom.

This removes the R3 race without a window. In that race the reader scrolls to 1500, growth to 1600 lands, and only
then does the queued event arrive.

### 3. Repositioning as a synchronous transaction

`requestJump`, `jumpFrame`, `cancelJump` and the rAF settle are replaced by one method:

```ts
reposition(step: { change?: () => void; top: () => number | null }): Promise<void>
```

Placement policy is a pure function the caller passes in. The controller owns only the transaction and the write.
The policies are:

- `turnTargetTop(node)`: `showTurnTarget` made pure. It returns a top, or `null` to keep a visible target still.
- `anchorTop(row, before)`: keep a row's screen top (T4).

The transaction runs in this order:

1. Set `intent = "holding"` and take a sequence token.
2. Run `change()`.
3. `await tick()`.
4. If a newer `reposition`, `detach` or `resetForSession` has run, return. Whichever call superseded this one now owns
   intent.
5. If `top()` is not `null`, `write(top)`.
6. `settle()`.

Steps 2 to 6 sit in a `try`/`finally`. The `finally` settles only while this call's token is still current, so a throwing
`change` cannot leave intent at `holding`, and a superseded call cannot overwrite the newer one. `detach()` bumps the
token and ends any hold as `reading`. `resetForSession()` bumps it and sets `bottom`.

Svelte's `tick()` resolves in microtasks. Scroll events dispatch only in a rendering step. So no reader scroll can
arrive between the hold and the settle, and nothing is swallowed. `change` is typed as synchronous, which keeps
the transaction inside one task.

The hold stops `onContentChange` from following growth that `change` causes. Growth is followed only while `bottom`,
so this needs no extra guard. The hold is also what keeps a fully visible picked card still. The fits rule applies
only to `reading`, so it cannot fire mid-transaction.

Callers:

| Caller | `change` | `top` |
| --- | --- | --- |
| `toggleMinimised` | `panel.collapse` | `turnTargetTop(collapsedHead)` when the head was stuck and is now above the top, otherwise `null` |
| `selectPin` (full log) | Set `selection` | `turnTargetTop(readCardEl)` |
| `openQa` | `panel.qa` | `turnTargetTop(entry)` |
| `landTurnTarget` | None | `turnTargetTop(node)` |
| `SurfacingMessageCard` `onreveal` | None | `turnTargetTop(card)` |

The leaf props keep their `(node) => void` shape: `landTurnTarget`'s `scroll` option and the `onreveal` prop of
SurfacingCard and SurfacingMessageCard. TurnActivity adapts them once with
`(node) => onreposition({ top: () => turnTargetTop(node) })`. This keeps the T2 diff out of the leaf components.

The pre-change `onjump?.()` calls in TurnActivity are deleted.

The `onjump` prop keeps its prop-threaded path. It is renamed `onreposition` and typed as
`ScrollController["reposition"]`. TurnActivity's default, used by stories with no controller, is
`(step) => repositionWithoutController(scrollRoot, step)`, using TurnActivity's existing `scrollRoot` prop.
`repositionWithoutController(root: HTMLElement | undefined, step)` is exported from `scroll-controller.svelte.ts`, so
the only code that writes the transcript's `scrollTop` stays in that module. It runs `change()`, awaits `tick()`, then
writes `root.scrollTop = top()` when `root` is defined and `top()` is not `null`. With no `root` it only runs the
change: stories without a transcript do not scroll.

### 4. Phone bar from reader intent

`createScrollController` takes `onReaderFollow?: () => void`. MessageList passes
`() => { if (primary) noteScrollGesture("down"); }`.

Deleted:

- `publishAtBottom`, `lastAtBottom`, `sessionViewState.atBottom` and the `lastAtBottom` line in
  `noteSessionChanged`;
- the MessageList effect that calls `publishAtBottom`;
- the `preserveBar` getter and the `preserveBar` argument.

Shipped bar behaviour is kept:

- Jump-to-latest, keyboard or scrollbar arrival at the bottom closes the bar. The first is a follow command and the
  other two are reader scrolls.
- `place("latest")` fires `onReaderFollow` when it moves `intent` to `bottom` from anything else. It tests `intent`,
  not the derived `following` state: MessageList calls `place` before `acknowledgePlacement` clears navigation, so
  `busy` is still true there. Its only callers are jump-to-latest and `requestTranscriptFollow` (composer send),
  both reader commands. A send while `intent` is already `bottom` leaves the bar alone, as shipped.
- Wheel and touch gestures still toggle the bar through the existing effect.
- Collapse, clamp, fit and `reposition` settle never close it. They are not reader follows.

### 5. Other scroll writers (T4)

All of these route through the controller:

- **TurnLog's earlier-steps anchor.** It becomes `reposition({ change, top: anchorTop(row, before) })`.
- **The clearance shift.** It becomes `onClearanceChange(delta)`. This moves the existing `isPinned ? resize : shift`
  branch into the controller.
- **The center scroll in `reveal.svelte.ts`.** It goes to the controller through the transcript view that MessageList
  renders. The implementer confirms the `TranscriptView` shape before choosing the hook.

A source-scan unit test then fails on any `scrollTop =`, `scrollTop +=`, `scrollTo(` or `scrollIntoView` in these
files:

- `TurnActivity.svelte`
- `TurnLog.svelte`
- `SurfacingMessageCard.svelte`
- `turn-panel.svelte.ts`
- `reveal.svelte.ts`
- `MessageList.svelte`

The scan is a structural guard, not a behaviour test. It keeps the lesson in structure, not in a comment. Each
ticket's first failing test is still a behaviour test.

### 6. Sticky inset (T5)

`turnHeadInset` becomes a pure read. One ResizeObserver on `.turn-activity-sticky` in TurnActivity writes
`--turn-reveal-margin` on the turn. `turnTargetTop` and the read-dwell both read the inset. Neither writes it.

`scroll-margin` is not inherited and the browser reads it from the element it scrolls into view. Tab focuses the
button inside a `[data-log-part]` row, not the row. So the existing `scroll-margin` rule in TurnActivity also covers the
row's focusable descendants: `[data-log-part] :is(a, button, input, select, textarea, [tabindex])`. One CSS rule, one
variable, no per-element writes.

## Code this deletes

- **`scroll-controller.svelte.ts`:**
  - `userDetached` and the `pinned` field;
  - `jumpFrame`, `cancelJump`, `requestJump` and its rAF settle;
  - `preserveBar` and its getter;
  - `requestFollow`, which has no production caller (tests move to `place("latest")`);
  - the `jumpFrame` guard in `followIfContentFits` and in `onScroll`;
  - the `root.scrollTop +=` write in `showTurnTarget`;
  - the CSS write in `turnHeadInset`.
- **`session-view.svelte.ts`:** `publishAtBottom`, `lastAtBottom`, `atBottom`.
- **`MessageList.svelte`:** the `publishAtBottom` effect, and the clearance `scrollTop +=` (moved into the controller).
- **`TurnActivity.svelte`:** the two pre-change `onjump?.()` suspend calls, and the default writer, which moves into the
  controller module as `repositionWithoutController`.
- **`TurnLog.svelte`:** `scroller.scrollTop +=`.
- **Tests and stories:**
  - the settle-by-gap rAF tests are rewritten against `reposition`;
  - the `atBottom` assertions in `message-list-session-view.test.ts` and `task-drawer-transcript.test.ts` are
    rewritten against bar state and `ScrollState`;
  - the `atBottom` line in `SessionBar.stories.ts` is removed.

## Options considered

The core seam is attribution of scroll movement.

| | Option | Verdict |
| --- | --- | --- |
| A | Patch the R3 guard: re-read reader scrolls inside `jumpFrame` | Rejected. Fourth guard on the same premise. |
| B | Longer or adaptive settle window | Rejected. Any window can swallow reader input. |
| C | Input-event attribution (wheel, touch, pointer, key) like bb, paseo and monocode | Rejected. It reverses `2026-03-31-scroll-false-detach-fix.md`, where wheel with no scroll left the transcript stuck detached. Momentum windows bring time windows back. bb still churns on iOS (#6517). |
| D | Explicit intent, explained positions and a synchronous `reposition` transaction | **Chosen.** Removes every window and keeps position attribution. |
| E | bb-style anchor ownership (`bottom` / `free` / `anchor(row, offset)`, `overflow-anchor: none`) | Rejected. Largest scope (bb's keeper is 1059 lines), and it re-implements browser anchoring. |
| F | Keep the bar's at-bottom edge and add a cause flag | Rejected. Two owners for one fact, which is what `preserveBar` already is. |
| G | Bar driven by the controller's reader-follow event | **Chosen.** One owner of reader intent. |
| H | Purely gesture-driven bar (delete the edge close) | Rejected. Breaks the shipped close on jump-to-latest, keyboard and scrollbar. |
| I | Reveal through a bubbling DOM `CustomEvent` | Rejected. Untyped hidden coupling. The prop path already exists. |
| J | Reveal through Svelte context | Rejected. The `landTurnTarget` action cannot read context, so it would be a second path. |
| K | CSS `scroll-margin` with native `scrollIntoView` only | Rejected. Cannot keep a visible target still or show the start of an oversized one. Still unrecorded writes. |

Module lenses:

| | Option | Verdict |
| --- | --- | --- |
| M1 | Deep controller, with a pure intent function inside it | **Chosen.** |
| M2 | Separate intent store and writer module | Rejected. Both need the same mutable `lastWrite` and observation. |
| M3 | A new `TranscriptScroller` port module | Rejected as a new module. The controller's methods are the port (T4). |
| M4 | Move `barOpen` into the controller | Rejected. The bar is phone chrome and stays in session-view. The controller only emits the event. |

## Prior art

Manifest:

- t3code main@2026-10-30
- bb main@2026-10-29
- paseo main@2026-10-30
- zeron
- diri
- monocode main@2026-10-29
- capy docs

The mechanisms cited here come from bb, paseo and monocode only.

- **bb** (`apps/app/src/components/ui/scroll-position-keeper.ts`):
  - e5350c3b7e collapsed about ten owners into one keeper. Its message: "Attach and detach were inferred from
    scrollTop, so a layout change could flip them."
  - f8c0701e94 (#6434): a scroll with no input is layout and never detaches.
  - c6c23be71f keeps the pinned state when content collapses.
- **paseo** (`packages/app/src/agent-stream/bottom-anchor-controller.ts`):
  - explicit `sticky-bottom` and `detached` modes;
  - explicit local requests (jump-to-bottom, message-sent, rewind);
  - user scroll bracketed by input listeners.
- **monocode** (`useBottomChatMotion.ts`): input-paused follow with a `holdUntil` window, and `onScrollAdjust` to
  acknowledge its own writes.

All three converge on the same rules:

- one owner;
- the mode changes only on reader action or an explicit command;
- layout never flips the mode.

This design adopts the convergence. It keeps position attribution, for the 2026-03-31 reason.

## Testing

TDD per ticket. Each failing test is written first and seen failing for the stated reason on `b23650c2`.

Narrowest checks:

- `test/unit/stores/scroll-controller.test.ts`
- `test/unit/stores/session-view-compact.test.ts`
- `test/unit/components/message-list-session-view.test.ts`
- `test/e2e/specs/scroll-stability.spec.ts`
- `test/e2e/specs/phone-top-edge.spec.ts`
- the sticky scenarios in `features/turn-activity.feature`

`pnpm acceptance:visual` runs before merge, because T2 and T3 touch frontend behaviour that the feature files
cover.

## Tickets (ordered)

| Order | Bead | Ticket | Blocked by |
| --- | --- | --- | --- |
| 1 | `conduit-test-o8pak.1` | **T1. Intent and explained positions.** Replace `userDetached` and the `pinned` field with `intent`, `observe()`, `write()` and `settle()`. Add the clamp and `extentFloor` rules. Route `place` and `onPrepend` through `write()`. Delete `requestFollow`. Add `onReaderFollow`, with no caller yet. | none |
| 2 | `conduit-test-o8pak.2` | **T2. Reposition transaction.** Add `reposition` and `repositionWithoutController`. Delete `requestJump`, `jumpFrame` and `cancelJump`. Make `showTurnTarget` pure as `turnTargetTop`. Migrate the TurnActivity callers, and point the `landTurnTarget` default at `repositionWithoutController`. | .1 |
| 3 | `conduit-test-o8pak.3` | **T3. Bar from reader intent.** MessageList wires `onReaderFollow`. Delete `publishAtBottom`, `atBottom`, `lastAtBottom` and `preserveBar`. | .2 |
| 4 | `conduit-test-o8pak.6` | **T4. Route the other writers.** Move the TurnLog anchor, the clearance shift and the center scroll in `reveal.svelte.ts` behind the controller. Add the source-scan test. | .3 |
| 5 | `conduit-test-o8pak.7` | **T5. Single owner for the sticky inset.** Pure `turnHeadInset`, with a ResizeObserver writing `--turn-reveal-margin`. | .2 |

T3 waits for T2 because `preserveBar` is still set by `requestJump` until T2 deletes it.

Acceptance criteria and the first failing test for each ticket live on its bead.

## Risks

- **`extentFloor` false follow.** A reader who scrolls up to exactly an old, smaller bottom after content grew could
  re-follow. This needs growth with no controller write in between (so the reader was not following) and an upward
  reader scroll in the same frame, ending within 5px of the old extent. The write reset rules out the 506tp case.
  Inferred to be rare. Not measured.
- **Microtask assumption.** The transaction depends on `tick()` staying microtask-only. A Svelte change to `tick`
  would reopen R3. T2's tests assert that a reader scroll event in the next frame is honoured.
- **Hook for the center scroll in `reveal.svelte.ts`.** Not decided. The hook depends on the `TranscriptView` shape,
  which T4 confirms.
- **Unchanged pre-existing behaviour.** `landTurnTarget` reveals whose target mounts in a later frame can still show
  one frame of following before the reveal.
- **Visual baselines.** Should not change, because user-visible placement is unchanged. If any differs, the diff is
  a regression until reviewed.

## Review log

Each round applied ub-mode, then poteto-mode (Model the Domain, Separate Before Serializing Shared State, Minimize
Reader Load, Migrate Callers Then Delete Legacy APIs). Every change was applied to this spec and the beads before the
next round.

**Round 1.**

- Collapsed four settle variants into one `settle()`. `historical` and `busy` stay derived only.
- Routed `place` and `onPrepend` through `write()`. Both wrote without recording.
- Deleted `requestFollow` in T1.
- Replaced `reveal(target, change)` with `reposition({ change, top })`, so placement is a pure caller policy and T4's
  anchor reuses the same transaction.
- Added a `try`/`finally` and a sequence token, so `holding` cannot leak.
- Moved the story default writer into the controller module, which would otherwise break the T4 scan.
- Moved the T5 failing test to Playwright, because jsdom has no layout.

**Round 2.**

- Gave `seenTop` one writer, the scroll-event consumer. `observe()` can see a reader scroll before its event arrives,
  which is the 506tp hazard.
- Stated first-match precedence, so the `extentFloor` row beats the 50px detach row.
- Added pin tests for `place` and `onPrepend` to T1.
- Fixed T4's behaviour test. The navigation rail uses `place`, not `reveal.svelte.ts`.

**Round 3.**

- Made the `finally` settle only for the current token. Defined what `detach` and `resetForSession` do to a hold.
- Kept the leaf props as `(node) => void`, with one adapter in TurnActivity. This shrinks T2.
- Named the `intent` writer as a single `apply(event)`.
- Labelled the source scan as a structural guard, and made T4's first failing test the behaviour test.

Ownership check after round 3:

- Every row in the State ownership table has one writer.
- The transcript's `scrollTop` is written by the reader and by `write()`, plus the in-module
  `repositionWithoutController`, once T4 lands.
- Until T4, three known writers remain: the TurnLog anchor, the clearance shift and the `reveal.svelte.ts` center
  scroll.