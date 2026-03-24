# Unified Notification Stack

## Problem

Toasts render at fixed bottom-center, AttentionBanners render at fixed top-right. Multiple toasts overlap each other (no vertical offset). Cross-session `ask_user` events fire both a toast and an AttentionBanner item redundantly.

## Design

### NotificationStack Container

New `NotificationStack.svelte` component:
- Position: `fixed top-16 right-4 z-[400]`
- Layout: `flex flex-col gap-2`
- Renders two zones: attention items (top), toasts (below)
- Owns all positioning; children are relative-positioned cards

### Toast Changes

- Remove `fixed bottom-20 left-1/2` from individual toast items; they become cards inside the stack
- Default duration: 2000ms -> 7000ms
- Multiple toasts stack via flexbox gap instead of overlapping
- Keep or adapt animation to match top-right entry

### AttentionBanner Changes

- Remove `fixed top-16 right-4` from the banner; it becomes a section inside `NotificationStack`
- Content, dismiss logic, auto-reappear behavior unchanged

### Duplicate Toast Suppression

In `ws-dispatch.ts`, skip `showToast()` for `notification_event` with `eventType === "ask_user"` or `"ask_user_resolved"` since the AttentionBanner already covers these.

### Layout Changes

In `ChatLayout.svelte`:
- Remove standalone `<Toast />` from global overlays
- Remove standalone `<AttentionBanner />` from inside `#app`
- Add `<NotificationStack />` to global overlays (outside `#layout`)

### Stack Order

Attention items pin to top, toasts stack below them.

## Files Affected

- `src/lib/frontend/components/overlays/Toast.svelte` -- strip fixed positioning, become stack child
- `src/lib/frontend/components/permissions/AttentionBanner.svelte` -- strip fixed positioning, become stack child
- New: `src/lib/frontend/components/overlays/NotificationStack.svelte` -- container
- `src/lib/frontend/components/layout/ChatLayout.svelte` -- swap standalone components for NotificationStack
- `src/lib/frontend/stores/ui.svelte.ts` -- change default toast duration to 7000ms
- `src/lib/frontend/stores/ws-dispatch.ts` -- suppress duplicate toasts for ask_user events
- `src/lib/frontend/components/overlays/Toast.stories.ts` -- update for new positioning
