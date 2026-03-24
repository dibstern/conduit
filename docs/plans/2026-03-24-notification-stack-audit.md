# Notification Stack Plan Audit Synthesis

Dispatched 5 auditors across 7 tasks.

## Amend Plan (5)

1. **Tasks 1-4 atomicity:** Intermediate states are broken (fixed-inside-fixed, pointer-events blocking). Merge Tasks 1-4 into a single atomic commit.

2. **Task 3 — Toast width:** Toast divs lose width constraint after removing fixed positioning. Add `w-full` to toast items for consistent width within parent's `max-w-[320px]`.

3. **Task 4 — Test mock:** `test/unit/components/chat-layout-ws.test.ts` mocks `Toast.svelte` and `AttentionBanner.svelte`. Must add `vi.mock` for `NotificationStack.svelte` and remove stale mocks.

4. **Task 5 — Test assertion:** `test/unit/stores/ui-store.test.ts:140` asserts default duration `toBe(2000)`. Must update to `toBe(7000)`.

5. **Task 7 — Story state leak:** Stories need `beforeEach` cleanup hooks to reset toast and permission state between stories, since all now render via NotificationStack.

## Ask User (1)

1. **Task 5 — INSTANCE_ERROR duration:** `ws-dispatch.ts:690` passes `duration: 4000` for instance errors. Previously this was *longer* than the 2000ms default (intentional), but now it's *shorter* than the new 7000ms default. Should this be updated?

## Accept (11)

Various informational findings about CSS correctness, import paths, flexbox behavior, etc. All verified correct.
