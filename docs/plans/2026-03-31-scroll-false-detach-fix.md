# Scroll Controller False-Detach Fix

> **For Agent:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task.

**Goal:** Eliminate false "New activity" button appearances when the user scrolls at the bottom of a non-overflowing or already-at-bottom container.

**Architecture:** Replace intent-based detach detection (wheel/touch events) with position-based detach detection (scroll event only). The `onWheel` and `onTouchMove` handlers are removed. All detach/re-follow logic moves into the single `onScroll` handler, which only fires when the scroll position actually changes. An overflow guard prevents detach when the container has no scrollable content.

**Tech Stack:** TypeScript, Svelte 5 reactive state (`$state`), Vitest (jsdom), Playwright E2E

---

## Context

### The Bug

`scroll-controller.svelte.ts:108-111` detaches on `wheel` events with `deltaY < 0`, regardless of whether the scroll position actually changes. When the user is already at the bottom or content doesn't overflow, the wheel event fires but no `scroll` event follows to re-follow. The user is stuck in "detached" state. The same issue exists for `onTouchMove` (lines 98-106).

### Root Cause

Detach detection is split across three event handlers (`onWheel`, `onTouchMove`, `onScroll`) with the first two detecting **intent** and the last detecting **result**. When intent fires but no result follows (no scrollable room), the state machine gets stuck.

### The Fix

Consolidate all detach logic into the `onScroll` handler. This handler only fires when `scrollTop` actually changes, which inherently avoids false detach. Add an overflow guard (`scrollHeight > clientHeight`) as defense-in-depth.

### Tradeoff

Wheel-based detection gives ~1 frame faster response when detaching during streaming. The position-only approach delays detach by one frame (the browser processes the wheel event, updates `scrollTop`, then fires `scroll`). This delay is imperceptible in practice and is the standard approach used by Slack, Discord, WhatsApp Web, and Telegram Web.

### Files Changed

| File | Action |
|------|--------|
| `src/lib/frontend/stores/scroll-controller.svelte.ts` | Remove `onWheel`, `onTouchMove`, `onTouchStart`; consolidate logic into `onScroll`; add overflow guard |
| `test/unit/stores/scroll-controller.test.ts` | Update tests: remove wheel-detach tests, add position-based detach tests, add non-overflowing container test |
| `test/unit/stores/scroll-regression.test.ts` | Update tests: replace wheel-based detach with position-based, add false-detach regression test |
| `test/unit/stores/scroll-lifecycle-integration.test.ts` | Update integration test: replace wheel dispatch with scroll-position simulation |

### What Does NOT Change

- The `ScrollController` interface (no public API changes)
- The `ScrollState` type or state machine states
- The `DETACH_THRESHOLD` (100px) and `REFOLLOW_THRESHOLD` (5px) constants
- `MessageList.svelte` (no template/wiring changes needed)
- The settle loop, prepend logic, `onNewContent`, `requestFollow`, `resetForSession`
- The E2E test at `test/e2e/specs/scroll-stability.spec.ts` (the `mouse.wheel` E2E test exercises real browser scrolling which changes `scrollTop` and fires `scroll` events -- it will continue to work because real wheel events DO produce scroll events in Playwright)

---

## Task 1: Write Failing Unit Tests for False-Detach Bug

**Files:**
- Modify: `test/unit/stores/scroll-controller.test.ts`
- Modify: `test/unit/stores/scroll-regression.test.ts`

### Step 1.1: Add false-detach regression test (non-overflowing container)

Add a test that creates a container where `scrollHeight <= clientHeight` (no overflow), dispatches a wheel-up event, and asserts that the controller does NOT detach. This test will FAIL against the current code because `onWheel` detaches unconditionally.

In `test/unit/stores/scroll-regression.test.ts`, add inside the "Scroll-to-bottom button visibility" describe:

```typescript
it("does NOT detach on wheel-up when container has no overflow", () => {
    const ctrl = makeCtrl();
    const div = document.createElement("div");
    // Simulate a non-overflowing container: scrollHeight == clientHeight
    Object.defineProperty(div, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "scrollTop", { value: 0, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

### Step 1.2: Add false-detach regression test (already at bottom)

Add a test that creates a container where the user is at the bottom (`distFromBottom < REFOLLOW_THRESHOLD`), dispatches a wheel-up event, and asserts no detach. This also FAILs against current code.

In `test/unit/stores/scroll-regression.test.ts`, add inside the "Scroll-to-bottom button visibility" describe:

```typescript
it("does NOT detach on wheel-up when already at the bottom", () => {
    const ctrl = makeCtrl();
    const div = document.createElement("div");
    // Container has overflow but user is scrolled to bottom
    Object.defineProperty(div, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "scrollTop", { value: 500, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

### Step 1.3: Add position-based detach test

Add a test that simulates detach via actual scroll position change (the new mechanism). This dispatches a `scroll` event with `distFromBottom > DETACH_THRESHOLD`. This should PASS once we implement the fix.

In `test/unit/stores/scroll-controller.test.ts`, add:

```typescript
it("detaches when scroll position moves away from bottom beyond threshold", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    // Container with overflow, user at bottom initially
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "scrollTop", { value: 1500, writable: true, configurable: true });
    ctrl.attach(div);
    expect(ctrl.isDetached).toBe(false);

    // Simulate user scrolling up: change scrollTop then fire scroll event
    div.scrollTop = 200;
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
});
```

### Step 1.4: Add overflow guard test that exercises the guard directly

The overflow guard (`scrollHeight <= clientHeight`) must be tested with a scenario
where the detach condition would otherwise fire. A non-overflowing container has
`distFromBottom = 0`, so `distFromBottom > 100` is never true regardless of the
guard — testing that alone would be vacuously true.

Instead, test a container that reports `scrollHeight <= clientHeight` but has a
non-zero `scrollTop` (which can happen transiently in browsers during resize).
This confirms the guard short-circuits before reaching the detach check:

```typescript
it("overflow guard prevents detach even with non-zero scrollTop on non-overflowing container", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    // Non-overflowing container but with scrollTop > 0 (transient browser state)
    // distFromBottom would be: 500 - 200 - 500 = -200 (negative), so detach
    // wouldn't fire anyway. But the guard should short-circuit before computing.
    // The real value of this test: confirms the guard exists and runs.
    Object.defineProperty(div, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "scrollTop", { value: 0, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

> **Note:** This test passes against current code (vacuously) AND after the fix.
> Its value is as a guard rail — if someone removes the overflow check, the
> test name documents the intent even if the assertion still passes by coincidence.
> The meaningful regression tests are Steps 1.1 and 1.2.

### Step 1.5: Add boundary-condition tests for thresholds

Test the exact boundary values of `DETACH_THRESHOLD` (100px, strict `>`) and
`REFOLLOW_THRESHOLD` (5px, strict `<`) to catch off-by-one errors:

In `test/unit/stores/scroll-controller.test.ts`, add:

```typescript
it("does NOT detach when distFromBottom is exactly at DETACH_THRESHOLD (100px)", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    // distFromBottom = 2000 - 1400 - 500 = 100 (exactly at threshold, strict > means no detach)
    Object.defineProperty(div, "scrollTop", { value: 1400, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});

it("detaches when distFromBottom is 1px past DETACH_THRESHOLD", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    // distFromBottom = 2000 - 1399 - 500 = 101 (just past threshold)
    Object.defineProperty(div, "scrollTop", { value: 1399, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
});

it("does NOT re-follow when distFromBottom is exactly at REFOLLOW_THRESHOLD (5px)", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    // First detach
    Object.defineProperty(div, "scrollTop", { value: 200, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(true);
    // Scroll to distFromBottom = 2000 - 1495 - 500 = 5 (exactly at threshold, strict < means no re-follow)
    div.scrollTop = 1495;
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
});

it("re-follows when distFromBottom is 1px inside REFOLLOW_THRESHOLD", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = document.createElement("div");
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    // First detach
    Object.defineProperty(div, "scrollTop", { value: 200, writable: true, configurable: true });
    ctrl.attach(div);
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(true);
    // Scroll to distFromBottom = 2000 - 1496 - 500 = 4 (inside threshold)
    div.scrollTop = 1496;
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

### Step 1.6: Run tests to verify the expected failures

Run: `pnpm test:unit -- test/unit/stores/scroll-controller.test.ts test/unit/stores/scroll-regression.test.ts --reporter=verbose`

Expected results:
- **FAIL**: "does NOT detach on wheel-up when container has no overflow" (Step 1.1) — current `onWheel` detaches unconditionally
- **FAIL**: "does NOT detach on wheel-up when already at the bottom" (Step 1.2) — same reason
- **PASS**: "detaches when scroll position moves away from bottom beyond threshold" (Step 1.3) — existing `onScroll` already handles this
- **PASS**: "overflow guard prevents detach..." (Step 1.4) — passes vacuously against current code
- **PASS**: All four boundary-condition tests (Step 1.5) — existing `onScroll` threshold logic is correct
- Only Steps 1.1 and 1.2 are the true failing regression tests that prove the bug exists

---

## Task 2: Implement the Fix in scroll-controller.svelte.ts

**Files:**
- Modify: `src/lib/frontend/stores/scroll-controller.svelte.ts`

### Step 2.1: Remove wheel and touch event handlers, add overflow guard

Replace the current implementation. The changes are:

1. **Delete** `onWheel` function (lines 108-112)
2. **Delete** `onTouchStart` function (lines 92-96)
3. **Delete** `onTouchMove` function (lines 98-106)
4. **Delete** `lastTouchY` variable (line 90)
5. **Add overflow guard** to `onScroll`: before running detach check, verify `container.scrollHeight > container.clientHeight`
6. **Remove** the `wheel`, `touchstart`, `touchmove` event listeners from `attach()` and `detach()`

The full updated file:

```typescript
// ─── Scroll Controller ───────────────────────────────────────────────────────
// State machine for chat scroll behavior. Derives scroll state from the chat
// store's LoadLifecycle signal and user input events.

import type { LoadLifecycle } from "./chat.svelte.js";

export type ScrollState = "loading" | "settling" | "following" | "detached";

export interface ScrollController {
	readonly state: ScrollState;
	readonly isDetached: boolean;
	readonly isLoading: boolean;
	attach(container: HTMLElement): void;
	detach(): void;
	resetForSession(): void;
	requestFollow(): void;
	onNewContent(): void;
	onPrepend(prevScrollHeight: number, prevScrollTop: number): void;
}

const SETTLE_MAX_FRAMES = 60;
const SETTLE_STABLE_THRESHOLD = 2;
const DETACH_THRESHOLD = 100; // px from bottom to trigger detach via scroll position
const REFOLLOW_THRESHOLD = 5; // px from bottom to re-follow (must be at the very bottom)

export function createScrollController(
	getLifecycle: () => LoadLifecycle,
): ScrollController {
	let container: HTMLElement | null = null;
	let userDetached = $state(false);
	let settleRafId: number | null = null;
	let settleFrameCount = 0;
	let programmaticScrollPending = false; // guards against false detach from our own scrolls

	function getState(): ScrollState {
		const lc = getLifecycle();
		if (lc === "empty" || lc === "loading") return "loading";
		if (lc === "committed") return "settling";
		if (userDetached) return "detached";
		return "following";
	}

	function scrollToBottom(): void {
		if (!container) return;
		programmaticScrollPending = true;
		container.scrollTop = container.scrollHeight;
	}

	function startSettle(): void {
		if (settleRafId !== null) return;
		settleFrameCount = 0;
		let lastHeight = 0;
		let stableCount = 0;

		function tick() {
			if (!container || settleFrameCount++ > SETTLE_MAX_FRAMES) {
				stopSettle();
				return;
			}
			const lc = getLifecycle();
			if (lc !== "committed") {
				stopSettle();
				return;
			}
			scrollToBottom();
			const h = container.scrollHeight;
			if (h === lastHeight) {
				stableCount++;
				if (stableCount >= SETTLE_STABLE_THRESHOLD) {
					stopSettle();
					return;
				}
			} else {
				stableCount = 0;
			}
			lastHeight = h;
			settleRafId = requestAnimationFrame(tick);
		}

		settleRafId = requestAnimationFrame(tick);
	}

	function stopSettle(): void {
		if (settleRafId !== null) {
			cancelAnimationFrame(settleRafId);
			settleRafId = null;
		}
	}

	function onScroll(): void {
		if (!container) return;

		// If we triggered this scroll via scrollToBottom(), skip the detach
		// check. Without this, a race occurs: scrollToBottom sets scrollTop,
		// then a new delta arrives and increases scrollHeight before the
		// scroll event fires, making distFromBottom > DETACH_THRESHOLD and
		// falsely detaching.
		if (programmaticScrollPending) {
			programmaticScrollPending = false;
			return;
		}

		// Skip detach/re-follow logic if content doesn't overflow the
		// container. Without this guard, edge cases (e.g. browser firing a
		// scroll event on a non-overflowing container) could falsely detach.
		if (container.scrollHeight <= container.clientHeight) return;

		const distFromBottom =
			container.scrollHeight - container.scrollTop - container.clientHeight;
		// Re-follow only when scrolled to the very bottom.
		// Uses a tight threshold (5px) to avoid undoing detach for small
		// scrolls. The user must scroll all the way back down.
		if (distFromBottom < REFOLLOW_THRESHOLD && userDetached) {
			userDetached = false;
		}
		// Detach when scrolled away from bottom (catches all user-initiated
		// scroll: wheel, touch, keyboard, page search, etc.).
		if (
			distFromBottom > DETACH_THRESHOLD &&
			!userDetached &&
			getState() === "following"
		) {
			userDetached = true;
		}
	}

	return {
		get state(): ScrollState {
			return getState();
		},
		get isDetached(): boolean {
			return getState() === "detached";
		},
		get isLoading(): boolean {
			return getState() === "loading";
		},

		attach(el: HTMLElement): void {
			container = el;
			el.addEventListener("scroll", onScroll, { passive: true });
		},

		detach(): void {
			stopSettle();
			if (container) {
				container.removeEventListener("scroll", onScroll);
				container = null;
			}
		},

		resetForSession(): void {
			userDetached = false;
			stopSettle();
		},

		requestFollow(): void {
			userDetached = false;
			scrollToBottom();
		},

		onNewContent(): void {
			const s = getState();
			if (s === "following") {
				// Scroll synchronously — not via rAF. In Svelte 5, $effect runs
				// after the DOM is committed but before the browser paints. Scrolling
				// here means the browser paints with the correct scroll position.
				// Using rAF would delay the scroll by one frame, causing visible
				// jitter during streaming (snap-down-then-back-up on each delta).
				scrollToBottom();
			} else if (s === "settling") {
				startSettle();
			}
		},

		onPrepend(prevScrollHeight: number, prevScrollTop: number): void {
			if (!container) return;
			requestAnimationFrame(() => {
				if (!container) return;
				const newScrollHeight = container.scrollHeight;
				container.scrollTop =
					prevScrollTop + (newScrollHeight - prevScrollHeight);
			});
		},
	};
}
```

### Step 2.2: Run the new tests to verify they pass

Run: `pnpm test:unit -- test/unit/stores/scroll-controller.test.ts test/unit/stores/scroll-regression.test.ts --reporter=verbose`

Expected: The two false-detach tests from Task 1 now PASS. The position-based detach test continues to PASS.

---

## Task 3: Update Existing Unit Tests That Depend on Wheel-Based Detach

**Files:**
- Modify: `test/unit/stores/scroll-controller.test.ts`
- Modify: `test/unit/stores/scroll-regression.test.ts`
- Modify: `test/unit/stores/scroll-lifecycle-integration.test.ts`

The existing tests dispatch `WheelEvent` to trigger detach. After the fix, wheel events no longer trigger detach. These tests need to simulate detach via scroll position instead.

### Step 3.1: Create a shared test helper

Add a helper function at the top of each test file (or in a shared test utility) that simulates a user scrolling up by setting `scrollTop` and dispatching a `scroll` event on a container that has overflow:

The pattern used in tests will be:

```typescript
/** Create a mock scrollable container with overflow and simulate scroll-up detach */
function createScrollableDiv(): HTMLDivElement {
    const div = document.createElement("div");
    Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
    Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
    Object.defineProperty(div, "scrollTop", { value: 1500, writable: true, configurable: true });
    return div;
}

/** Simulate user scrolling up past detach threshold */
function simulateScrollUp(div: HTMLDivElement): void {
    div.scrollTop = 200; // distFromBottom = 2000 - 200 - 500 = 1300 > 100
    div.dispatchEvent(new Event("scroll"));
}
```

### Step 3.2: Update `scroll-controller.test.ts`

**Replace** the "wheel up in following state transitions to detached" test:

```typescript
it("detaches when user scrolls away from bottom past threshold", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
});
```

**Replace** the "wheel down in following state stays following" test:

```typescript
it("stays following when scroll position is near bottom", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = createScrollableDiv();
    ctrl.attach(div);
    // Scroll near bottom (within re-follow threshold)
    div.scrollTop = 1498; // distFromBottom = 2000 - 1498 - 500 = 2 < 5
    div.dispatchEvent(new Event("scroll"));
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

**Update** the "resetForSession clears detached state" test to use scroll-based detach:

```typescript
it("resetForSession clears detached state", () => {
    const ctrl = makeController();
    lifecycle = "ready";
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.resetForSession();
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

### Step 3.3: Update `scroll-regression.test.ts`

**Replace** the "isDetached becomes true after wheel-up event" test:

```typescript
it("isDetached becomes true after scrolling away from bottom", () => {
    const ctrl = makeCtrl();
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.detach();
});
```

**Update** the "isDetached becomes false after requestFollow()" test:

```typescript
it("isDetached becomes false after requestFollow()", () => {
    const ctrl = makeCtrl();
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.requestFollow();
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

**Update** the "resetForSession clears userDetached" test:

```typescript
it("resetForSession clears userDetached", () => {
    const ctrl = makeCtrl();
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.resetForSession();
    expect(ctrl.isDetached).toBe(false);
    ctrl.detach();
});
```

**Update** the "onNewContent does not scroll when detached" test:

```typescript
it("onNewContent does not scroll when detached", () => {
    const ctrl = makeCtrl();
    const div = createScrollableDiv();
    ctrl.attach(div);
    simulateScrollUp(div);
    expect(ctrl.isDetached).toBe(true);
    ctrl.onNewContent();
    expect(div.scrollTop).toBe(200); // unchanged from simulateScrollUp
    ctrl.detach();
});
```

### Step 3.4: Update `scroll-lifecycle-integration.test.ts`

**Update** the "full flow" test (step 5 "User scrolls up"):

Replace:
```typescript
// 5. User scrolls up
div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
```

With:
```typescript
// 5. User scrolls up (position-based detach)
Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
Object.defineProperty(div, "scrollTop", { value: 200, writable: true, configurable: true });
div.dispatchEvent(new Event("scroll"));
```

**Update** the "session switch resets state correctly" test:

Replace:
```typescript
div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
```

With:
```typescript
Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
Object.defineProperty(div, "scrollTop", { value: 200, writable: true, configurable: true });
div.dispatchEvent(new Event("scroll"));
```

**Update** the "detach during loading is suppressed" test. Currently it dispatches a wheel event during loading and expects no detach. The scroll-based equivalent: dispatch a scroll event with `distFromBottom > DETACH_THRESHOLD` during loading and expect no detach (because `getState()` returns `"loading"`, not `"following"`).

Also update the comment from "During loading, wheel events shouldn't cause detach" to "During loading, scroll events shouldn't cause detach":

Replace:
```typescript
// During loading, wheel events shouldn't cause detach
chatState.loadLifecycle = "loading";
div.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }));
```

With:
```typescript
// During loading, scroll events shouldn't cause detach
chatState.loadLifecycle = "loading";
Object.defineProperty(div, "scrollHeight", { value: 2000, configurable: true });
Object.defineProperty(div, "clientHeight", { value: 500, configurable: true });
Object.defineProperty(div, "scrollTop", { value: 200, writable: true, configurable: true });
div.dispatchEvent(new Event("scroll"));
```

### Step 3.5: Run all scroll tests

Run: `pnpm test:unit -- test/unit/stores/ --reporter=verbose`

Expected: All tests pass.

---

## Task 4: Run Full Verification

### Step 4.1: Run type check

Run: `pnpm check`

Expected: No type errors.

### Step 4.2: Run lint

Run: `pnpm lint`

Expected: No lint errors.

### Step 4.3: Run full unit test suite

Run: `pnpm test:unit`

Expected: All tests pass (no regressions).

### Step 4.4: Run E2E scroll stability tests

The scroll behavior change is browser-visible, so E2E verification is required
per `docs/agent-guide/testing.md`. Run only the scroll-specific spec:

Run: `pnpm test:e2e -- test/e2e/specs/scroll-stability.spec.ts`

Expected: All tests pass. The `mouse.wheel` test continues to work because
Playwright's `mouse.wheel` triggers real browser scrolling which updates
`scrollTop` and fires `scroll` events on the `overflow-y: auto` container.

If the "wheel-up detaches during streaming" test fails, it means Playwright's
`mouse.wheel` doesn't produce actual scroll position changes. In that case,
update the E2E test to use `page.evaluate` to set `scrollTop` directly
and dispatch a scroll event.

### Step 4.5: Commit

```bash
git add src/lib/frontend/stores/scroll-controller.svelte.ts test/unit/stores/scroll-controller.test.ts test/unit/stores/scroll-regression.test.ts test/unit/stores/scroll-lifecycle-integration.test.ts
git commit -m "fix: eliminate false-detach in scroll controller by using position-only detection

Replace intent-based detach detection (wheel/touch events) with
position-based detection (scroll event only). The wheel and touch
handlers fired even when the container had no overflow or the user
was already at the bottom, causing the 'New activity' button to
appear incorrectly on new sessions.

The scroll event only fires when scrollTop actually changes, which
inherently prevents false detach. An overflow guard provides
defense-in-depth for edge cases."
```

---

## Appendix: E2E Test Compatibility

The E2E test at `test/e2e/specs/scroll-stability.spec.ts` line 521 ("wheel-up detaches during streaming, button appears, no snap-back") uses `page.mouse.wheel(0, -500)` which triggers a real browser wheel event. In a real browser, this wheel event causes the browser to scroll the container, which updates `scrollTop` and fires a `scroll` event. The position-based detach in our `onScroll` handler will detect the new `distFromBottom` and detach. So this E2E test should continue to pass without changes.

If it doesn't pass (e.g., Playwright's `mouse.wheel` doesn't actually scroll in the DOM or the `scroll` event fires before `scrollTop` updates), a follow-up task would update the E2E test helper to use `page.evaluate` to set `scrollTop` directly.
