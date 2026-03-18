# Subagent Back Bar Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the inline "← Parent agent" text link with a full-width context bar inside the input box that shows parent session context and a prominent "← PARENT ESC" button.

**Architecture:** Redesign `SubagentBackBar.svelte` markup/styles while keeping its reactive logic. Move its mount point in `InputArea.svelte` from the textarea row to above the context mini-bar. Wire ESC key in `InputArea`'s `handleKeydown` to navigate to parent when the textarea is empty. Update E2E page object and tests to match the new DOM structure.

**Tech Stack:** Svelte 5, Tailwind CSS v4

---

### Task 1: Redesign SubagentBackBar.svelte

**Files:**
- Modify: `src/lib/frontend/components/chat/SubagentBackBar.svelte`

**Step 1: Update file header comment**

Replace lines 1-3:

```svelte
<!-- ─── Subagent Context Bar ──────────────────────────────────────────────────── -->
<!-- Full-width context bar at the top of the input box when viewing a subagent session. -->
<!-- Shows parent session title and a "← PARENT" button to navigate back. -->
```

**Step 2: Replace markup and styles**

Replace the entire template (lines 36-45) with the new context bar layout. The outer div includes `subagent-back-bar` class for E2E test compatibility (`test/e2e/page-objects/chat.page.ts:29` locates via `.subagent-back-bar`). The rounded-corner clip wrapper is inside the `{#if}` block so no empty DOM node renders when the bar is hidden.

```svelte
{#if visible}
	<div class="subagent-back-bar overflow-hidden rounded-t-[calc(1.5rem-6px)] max-md:rounded-t-[calc(20px-6px)]">
		<div class="flex items-center gap-2 py-1.5 px-3.5 bg-bg-alt border-b border-border-subtle max-md:gap-1.5 max-md:py-1 max-md:px-3">
			<span class="w-1.5 h-1.5 rounded-full bg-tool shrink-0"></span>
			<span class="flex-1 min-w-0 text-[11px] text-text-muted truncate max-md:text-[10px]">
				Subagent of <strong class="text-text-secondary font-semibold">{parentTitle}</strong>
			</span>
			<button
				type="button"
				class="subagent-back-btn inline-flex items-center gap-1 py-0.5 px-2.5 rounded border-none bg-accent text-bg font-sans text-[11px] font-semibold cursor-pointer whitespace-nowrap transition-opacity duration-150 tracking-wide hover:opacity-85 max-md:text-[10px] max-md:px-2"
				onclick={navigateBack}
				title="Back to {parentTitle}"
			>
				<span class="text-[12px] leading-none">&#8592;</span>
				PARENT
				<span class="hidden md:inline-flex items-center py-px px-1 rounded-sm bg-white/20 text-[9px] font-bold tracking-wider ml-0.5">ESC</span>
			</button>
		</div>
	</div>
{/if}
```

Key design decisions:
- `subagent-back-bar` class on outer div: E2E locator compatibility (`.subagent-back-bar` selector)
- `subagent-back-btn` class on the button: allows E2E tests to target the clickable button specifically
- Rounded-corner clip wrapper (`overflow-hidden rounded-t-*`) is **inside** `{#if visible}` — no empty DOM when hidden
- The radius calculation is `parent-border-radius - parent-padding`: `input-row` has `rounded-3xl` (24px) with `p-1.5` (6px), so inner content clips at 18px. Mobile: `rounded-[20px]` minus 6px = 14px.
- `hidden md:inline-flex` on ESC badge: hides on mobile (no keyboard shortcut on touch devices)
- `bg-bg-alt` background with `border-b border-border-subtle` visually separates from textarea below

**Step 3: Verify renders correctly**

Run: `pnpm check`

**Step 4: Commit**

```
feat: redesign SubagentBackBar as full-width context bar
```

---

### Task 2: Relocate SubagentBackBar in InputArea

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte`

**Step 1: Move SubagentBackBar above context mini-bar**

Current location (line 457): inside `<div class="flex items-start">` alongside the textarea.

New location: first child of `#input-row` (before the context mini-bar div at line 419), with **no wrapper div** (the clip wrapper is now inside SubagentBackBar itself).

Remove `<SubagentBackBar />` from the textarea row (line 457) and place it as the first child inside `#input-row`:

```svelte
		<div
			id="input-row"
			class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200 max-md:rounded-[20px] focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>
			<!-- Subagent context bar (above all other input chrome) -->
			<SubagentBackBar />

			<!-- Context usage mini-bar -->
			<div ...>
```

The textarea row becomes just:

```svelte
			<div class="flex items-start">
				<textarea ...></textarea>
			</div>
```

**Step 2: Verify renders correctly**

Run: `pnpm check`

**Step 3: Commit**

```
refactor: move SubagentBackBar above context mini-bar in InputArea
```

---

### Task 3: Wire ESC keyboard shortcut

**Files:**
- Modify: `src/lib/frontend/components/layout/InputArea.svelte`
- Modify: `src/lib/frontend/components/chat/SubagentBackBar.svelte`

**Step 1: Export navigateBack from SubagentBackBar**

SubagentBackBar already imports `wsSend` and derives `parentId`. Export a function so InputArea can trigger navigation programmatically:

In SubagentBackBar.svelte, add after the `navigateBack` function:

```typescript
/** Exposed so the parent can trigger navigation (e.g. via ESC key). */
export function triggerNavigateBack(): boolean {
	if (parentId) {
		navigateBack();
		return true;
	}
	return false;
}
```

**Step 2: Add biome-ignore and bind ref in InputArea**

The import of SubagentBackBar needs a `biome-ignore` comment because `bind:this` requires a value import (not a type import). See the existing pattern for CommandMenu and FileMenu at lines 9-12 of InputArea.svelte.

Change line 14 from:

```typescript
import SubagentBackBar from "../chat/SubagentBackBar.svelte";
```

To:

```typescript
// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
import SubagentBackBar from "../chat/SubagentBackBar.svelte";
```

Add a ref in the state section:

```typescript
let subagentBackBarRef: SubagentBackBar | undefined = $state();
```

In the template, bind it:

```svelte
<SubagentBackBar bind:this={subagentBackBarRef} />
```

**Step 3: Add ESC handling in handleKeydown**

In `handleKeydown`, add an ESC case **after** the command menu and file menu forwarding (lines 150-158), but **before** the existing command-menu Escape handler (line 159).

The ESC shortcut must NOT fire when:
- The textarea has text in it
- The command menu is visible (user wants to dismiss the `/` menu)
- The file menu is visible (user wants to dismiss the `@` menu)

```typescript
	// Navigate to parent session on ESC when textarea is empty and no menus open
	if (
		e.key === "Escape" &&
		!inputText.trim() &&
		!commandMenuVisible &&
		!fileMenuVisible &&
		subagentBackBarRef
	) {
		const handled = subagentBackBarRef.triggerNavigateBack();
		if (handled) {
			e.preventDefault();
			return;
		}
	}
```

Place this immediately after the file menu forwarding block (after line 158), before the existing `if (commandMenuVisible && e.key === "Escape")` block.

**Step 4: Verify functionality**

Run: `pnpm check && pnpm lint`

**Step 5: Commit**

```
feat: wire ESC shortcut to navigate back to parent session
```

---

### Task 4: Update E2E tests

**Files:**
- Modify: `test/e2e/page-objects/chat.page.ts`
- Modify: `test/e2e/specs/subagent-sessions.spec.ts`

The E2E page object and tests need updates for the new DOM structure.

**Step 1: Add button locator to page object**

In `test/e2e/page-objects/chat.page.ts`, the existing `subagentBackBar` locator (`page.locator(".subagent-back-bar")`) still works because Task 1 adds the `subagent-back-bar` class to the outer div. But the click target has changed — the old component was a single `<button>`, the new one is a `<div>` containing a nested `<button>`.

Add a dedicated button locator after line 14:

```typescript
readonly subagentBackBar: Locator;
readonly subagentBackBtn: Locator;
```

And after line 29:

```typescript
this.subagentBackBar = page.locator(".subagent-back-bar");
this.subagentBackBtn = page.locator(".subagent-back-btn");
```

**Step 2: Update click target in E2E test**

In `test/e2e/specs/subagent-sessions.spec.ts`, line 422 currently clicks the container:

```typescript
await chat.subagentBackBar.click();
```

Change to click the button:

```typescript
await chat.subagentBackBtn.click();
```

The text assertions (`innerText()` calls at line 376) still work on the container div since it wraps the full text content including "Subagent of {title}".

**Step 3: Verify E2E tests pass**

Run: `pnpm test:e2e -- --grep "SubagentBackBar"` (or the project's E2E test command for the subagent suite)

**Step 4: Commit**

```
test: update E2E locators for SubagentBackBar DOM structure change
```

---

### Task 5: Verify end-to-end

**Step 1: Run full verification**

```bash
pnpm check
pnpm lint
pnpm test:unit
```

**Step 2: Visual verification**

Open the app at localhost:2633, navigate to a subagent session, and confirm:
- Context bar renders at top of input box with correct parent title
- Bar background clips to rounded corners cleanly
- ESC badge visible on desktop, hidden on mobile
- Clicking "← PARENT" button navigates back
- Pressing ESC with empty textarea navigates back
- Pressing ESC with text in textarea does NOT navigate (normal behavior)
- Pressing ESC with command menu (`/`) open dismisses the menu, not navigating
- Pressing ESC with file menu (`@`) open dismisses the menu, not navigating
- Context usage mini-bar renders correctly below the subagent bar when both are visible
- When not in a subagent session, no empty wrapper div or gap appears
