# Message date labels

Approved design: timestamp option 2A. Preserve the local clock and add Today,
Yesterday, or 2–6 days ago. Older and future messages use a calendar date; dates
outside the current year include the year. Use the stored message timestamp.
Missing timestamps remain absent. Hover exposes the full local date and timezone;
click, tap, or keyboard activation opens the same information in a popover.

Formatting and full-date access stay in `src/lib/frontend/components/chat/MessageTime.svelte`.
Reuse the shared clock and existing Popover primitive. Derive the local calendar
day from the clock so relative labels change after midnight. Calculate day
differences from UTC representations of local year/month/day, avoiding DST-hour
differences. Make the title/time group in `AssistantHeader.svelte` wrappable on
narrow screens. Keep the semantic time inside the native popover-trigger button.

Failure cases to verify before implementation: same-day messages, yesterday
across DST, 2/6/7-day boundaries, prior-year and future dates, absent timestamp,
midnight rollover, full-date access with keyboard/touch, and narrow headers.

Add a browser test to `test/e2e/specs/transcript-detail.spec.ts` before changing
the component. Seed timestamped user/assistant messages via the existing mocked
detail stream, install the browser clock before navigation and advance it across
midnight, set the timezone, and assert visible labels and
popover contents. Save a screenshot as a repeatable artifact. Run the focused
test and the transcript visual acceptance feature against committed baselines.
No baseline changes or commits without review.

Navigation remains design work. Update the existing Tailscale page with a
source-based T3 reference and three vertical-rail variants, each demonstrated at
phone and desktop sizes. Explicitly label T3's lack of touch support. Verify the
published prototypes with GPT-6 Astra browser tools before presenting them.
