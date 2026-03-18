# Terminal Touch Scrolling & Font Zoom

## Summary

Add two features to the terminal:
1. **Touch scrolling** — swipe up/down on the terminal to scroll through scrollback history on mobile
2. **Font size buttons** — A-/A+ buttons in the tab bar to zoom terminal text in/out (6–24px range)

## Feature 1: Touch Scrolling

**Approach:** Add touch event handlers to `TerminalTab.svelte` that translate vertical swipe gestures into xterm `scrollLines()` calls.

**Details:**
- Listen for `touchstart`, `touchmove`, `touchend` on the terminal container
- Track vertical delta, convert to line-count scrolls (based on cell height)
- Use `{ passive: false }` on touchmove to prevent page scroll while interacting with terminal
- No momentum/inertia — direct 1:1 mapping of swipe distance to scroll lines
- Expose `scrollLines()` method on `XtermAdapter`

**Files changed:**
- `src/lib/public/utils/xterm-adapter.ts` — add `scrollLines(n)` method
- `src/lib/public/components/features/TerminalTab.svelte` — add touch handlers

## Feature 2: Font Size +/- Buttons

**Approach:** Add `A-` and `A+` buttons in the terminal tab bar (right-aligned, before close-panel button). Buttons change font size in 1px steps, range 6–24px. Persisted to localStorage.

**Details:**
- Add `setFontSize(px)` method to `XtermAdapter` that updates xterm's `fontSize` option and re-fits
- Store font size in `localStorage` key `"terminal-font-size"`, default 13px
- Font size state lives in `TerminalPanel.svelte` (shared across all tabs)
- Pass font size to `XtermAdapter` constructor and provide update method
- On font size change, iterate all active adapters and update them

**Files changed:**
- `src/lib/public/utils/xterm-adapter.ts` — add `setFontSize(px)` method
- `src/lib/public/components/features/TerminalPanel.svelte` — add buttons, state, pass to tabs
- `src/lib/public/components/features/TerminalTab.svelte` — accept fontSize prop, apply on change
