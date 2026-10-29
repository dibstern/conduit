# Message navigation rail implementation plan

Approved design: D1 from the timestamp/navigation preview. A quiet left rail
works on phone and desktop, with small ticks at rest and a prompt preview during
hover, keyboard navigation, or touch scrubbing.

## Implementation

Add `src/lib/frontend/components/chat/MessageNavigationRail.svelte`, mounted by
`MessageList.svelte` in a relative wrapper around the existing scroll container.
Keep `#messages`, its scroll controller and history loader intact. The rail gets
typed user messages, its own pane's scroller, phone top clearance, and the existing
`scrollCtrl.requestJump` callback. Key it by viewed session. Hide it during feed
catch-up, rewind, cold open, and when fewer than two user messages are rendered.

Resolve messages to scoped `.msg-user[data-uuid]` elements. Omit inherited fork
messages whose collapsed block has not rendered. Observe child changes and size
changes; cache offsets and throttle geometry reads to one animation frame.
Scrolling updates the active message; it must not rescan all DOM on every event.
At the bottom, the last message is active even when its short turn cannot align
at the top. Do not add permanent blank space below the transcript.

One focusable slider owns a 44px-wide hit strip. Ticks grow around the hovered
message. Pointer capture scrubs through targets and suppresses text selection
only on the strip. Ignore secondary buttons and unrelated pointers. Release on
cancel, lost capture, teardown and session change. Snapshot the target list during
a drag so prepend or append does not change the message under the finger. Freeze
identities only; read current target geometry when navigating. Include optimistic
local sends and preserve an explicit selection when several short turns share a
clamped scroll position. A small
reserved gutter keeps the strip away from message controls; bind its visibility
to the parent for layout. The preview stays beside the strip, clamps vertically,
uses the message's own timestamp, and does not intercept pointer events.

Home/End and Arrow Up/Down navigate. Escape and blur dismiss the preview. Tap or
keyboard selection updates the transcript immediately; ordinary transcript
scrolling remains unchanged. Use theme tokens and reduced-motion styling.
Each navigation calls requestJump before scrolling so streaming cannot steal the
reader's position. Earlier messages load through the existing top sentinel;
represent loaded, rendered prompts rather than fabricating unseen history.

## Verification

Before implementation, add browser coverage in
`test/e2e/specs/message-navigation.spec.ts` using the existing replay/RPC mocks.
Exercise 60 user turns at desktop and phone widths, click/tap, intermediate drag
positions, Home/End, preview bounds, endpoint selection, scroll-driven active
state, pointer cancellation, streaming while detached, and session switch.
Verify prepend adds entries without moving the selected prompt and non-user
messages do not become ticks. Check expanded fork context and content reflow above
the selected prompt. Capture repeatable phone and desktop screenshots.
Run the relevant existing transcript tests, Svelte checks, and the focused
`pnpm acceptance:visual phone-transcript-scrolling` gate. Visually inspect the
real implementation through GPT-6 Astra before completion. No PR, commit, or
baseline update is part of this approval.
