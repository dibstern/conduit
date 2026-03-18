# Message Type Differentiation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add left-border accent rails, background tints, and inline thinking to visually differentiate message types in the chat UI.

**Architecture:** Each message type gets a distinct left-border color and optional background tint via new CSS design tokens. ThinkingBlock is redesigned to show inline streaming text that collapses when done. ToolItems gain grouping logic for consecutive runs. SystemMessages become left-aligned with icons.

**Tech Stack:** Svelte 5 (runes), Tailwind CSS v4, Lucide icons

---

## Visual Hierarchy

```
[amber |] Thinking…                     ← "internal process"
[slate |] Tool: mcp_read                ← "mechanical action"
[slate |] Tool: mcp_grep                ← grouped with above
          Assistant response here        ← primary content, clean
[──────] $0.0042 · 1.2s · 1200 in      ← turn separator
[gray  |] Session forked                ← ambient system info
[red   |] Connection lost               ← error alert
```

---

### Task 1: Add Design Tokens

**Files:**
- Modify: `src/lib/public/style.css:6-31` (add to `@theme` block)

**Step 1: Add the four new color tokens**

Add these inside the existing `@theme { }` block, after `--color-success`:

```css
--color-thinking:    hsl(38, 55%, 62%);
--color-thinking-bg: hsla(38, 55%, 62%, 0.06);
--color-tool:        hsl(220, 12%, 64%);
--color-tool-bg:     hsla(220, 12%, 64%, 0.04);
```

These map automatically to Tailwind classes: `border-thinking`, `bg-thinking-bg`, `border-tool`, `bg-tool-bg`.

**Step 2: Verify build compiles**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 3: Commit**

```
feat: add design tokens for message type differentiation
```

---

### Task 2: Redesign ThinkingBlock

**Files:**
- Modify: `src/lib/public/components/chat/ThinkingBlock.svelte`

**Step 1: Replace the component template and logic**

The key changes:
- While streaming (`!message.done`): full-width block with amber left border, inline italic text, spinner + verb header
- When done (`message.done`): compact collapsible bar with amber left border, chevron to expand
- Add `$effect` to auto-collapse when thinking completes

Replace the full file contents with:

```svelte
<!-- ─── Thinking Block ──────────────────────────────────────────────────────── -->
<!-- Inline thinking stream with amber left-border accent. -->
<!-- Collapses to compact bar when done; expands on click. -->
<!-- Preserves .thinking-item / .thinking-block classes for E2E. -->

<script lang="ts">
	import type { ThinkingMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { message }: { message: ThinkingMessage } = $props();
	let expanded = $state(false);

	// Random thinking verb (assigned once per block)
	const thinkingVerbs = [
		"Contemplating", "Architecting", "Brewing", "Calibrating", "Channeling",
		"Composing", "Computing", "Conjuring", "Constructing", "Crafting",
		"Crystallizing", "Debugging", "Deciphering", "Designing", "Distilling",
		"Drafting", "Engineering", "Evaluating", "Evolving", "Exploring",
		"Fabricating", "Formulating", "Generating", "Ideating", "Imagining",
		"Innovating", "Integrating", "Iterating", "Manifesting", "Mapping",
		"Materializing", "Modeling", "Navigating", "Optimizing", "Orchestrating",
		"Parsing", "Pondering", "Processing", "Projecting", "Prototyping",
		"Reasoning", "Refining", "Resolving", "Sculpting", "Shaping",
		"Simulating", "Sketching", "Solving", "Strategizing", "Structuring",
		"Synthesizing", "Theorizing", "Thinking", "Transforming", "Unraveling",
		"Visualizing", "Weaving",
	];
	const verb = thinkingVerbs[Math.floor(Math.random() * thinkingVerbs.length)];

	const label = $derived(message.done ? "Thought" : verb);
	const durationText = $derived(
		message.duration !== undefined
			? `${(message.duration / 1000).toFixed(1)}s`
			: "",
	);

	function handleToggle() {
		expanded = !expanded;
	}

	// Auto-collapse when thinking completes
	$effect(() => {
		if (message.done) {
			expanded = false;
		}
	});
</script>

<div
	class="thinking-block thinking-item max-w-[760px] mx-auto my-1.5 px-5"
	class:expanded
	class:done={message.done}
>
	{#if !message.done}
		<!-- Streaming: inline thinking display -->
		<div class="border-l-3 border-thinking bg-thinking-bg rounded-r-lg py-2 px-3.5">
			<div class="flex items-center gap-1.5 mb-1.5">
				<span class="text-text-muted [&_.lucide]:w-3.5 [&_.lucide]:h-3.5">
					<Icon name="loader" size={14} class="icon-spin" />
				</span>
				<span class="text-xs text-text-muted font-medium">{label}…</span>
			</div>
			{#if message.text}
				<div class="font-mono text-[13px] leading-[1.55] text-text-muted italic whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
					{message.text}
				</div>
			{/if}
		</div>
	{:else}
		<!-- Done: compact collapsible bar -->
		<button
			class="thinking-header flex items-center gap-1.5 cursor-pointer py-2 px-3 select-none border-l-3 border-thinking rounded-r-lg text-xs text-text-dimmer hover:bg-thinking-bg transition-colors duration-150 border-t-0 border-r-0 border-b-0 w-full text-left"
			onclick={handleToggle}
		>
			<span
				class="thinking-chevron text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
				class:rotate-90={expanded}
			>
				<Icon name="chevron-right" size={14} />
			</span>

			<span class="thinking-label">{label}</span>
			{#if durationText}
				<span class="thinking-duration text-[11px] text-text-dimmer font-normal">
					{durationText}
				</span>
			{/if}
		</button>

		{#if expanded && message.text}
			<div
				class="thinking-content border-l-3 border-thinking py-2 px-3.5 font-mono text-[13px] leading-[1.55] text-text-muted italic whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto"
			>
				{message.text}
			</div>
		{/if}
	{/if}
</div>
```

**Step 2: Verify in Storybook**

Run: `npm run storybook`
Check ThinkingBlock stories: Active (amber border, inline text), Completed (amber border, compact bar), LongDuration.

**Step 3: Run existing tests**

Run: `npm run test:unit`
Expected: All pass (store tests don't test rendering).

**Step 4: Commit**

```
feat: redesign ThinkingBlock with inline streaming and amber accent
```

---

### Task 3: Redesign ToolItem with Grouping

**Files:**
- Modify: `src/lib/public/components/chat/ToolItem.svelte` (add left border, accept grouping props)
- Modify: `src/lib/public/components/chat/MessageList.svelte` (pass grouping info via index)

**Step 1: Add grouping props and border logic to ToolItem**

In `ToolItem.svelte`, change the props:

```ts
let { message, isFirstInGroup = true, isLastInGroup = true }: { 
	message: ToolMessage; 
	isFirstInGroup?: boolean; 
	isLastInGroup?: boolean;
} = $props();
```

Add derived values for group-aware styling:

```ts
const groupRadius = $derived.by(() => {
	if (isFirstInGroup && isLastInGroup) return "rounded-r-lg";
	if (isFirstInGroup) return "rounded-tr-lg";
	if (isLastInGroup) return "rounded-br-lg";
	return "";
});

const borderColor = $derived(
	message.isError ? "border-error" : "border-tool"
);
```

**Step 2: Update the ToolItem template**

Wrap the button + subtitle + result area inside a new `border-l-3` container. Remove `bg-black/[0.025]` from the header button. Update margins to use grouping-aware spacing:

```svelte
<div
	class="tool-item max-w-[760px] mx-auto px-5"
	class:expanded
	class:mt-1.5={isFirstInGroup}
	class:mt-0.5={!isFirstInGroup}
	class:mb-0.5={!isLastInGroup}
	class:mb-1={isLastInGroup}
	data-tool-id={message.id}
>
	<div class="border-l-3 {borderColor} bg-tool-bg {groupRadius}">
		<button
			class="tool-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-black/[0.03] transition-colors duration-150 border-none text-left"
			class:rounded-tr-lg={isFirstInGroup}
			onclick={handleToggle}
		>
			<!-- chevron, bullet, name, desc, status icon — unchanged -->
		</button>

		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>

		{#if expanded && message.result}
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto {resultErrorClass}"
				class:is-error={message.isError}
			>
				{message.result}
			</div>

			{#if message.isTruncated}
				<div class="flex items-center gap-2 mx-2.5 mt-1 mb-1 text-xs text-text-dimmer">
					<span class="font-mono">
						Showing {formatKB(message.result.length)} of {formatKB(message.fullContentLength ?? message.result.length)}
					</span>
					<button
						class="px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors duration-150 text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
						onclick={requestFullContent}
						disabled={loadingFullContent}
					>
						{#if loadingFullContent}
							Loading…
						{:else}
							Show full output
						{/if}
					</button>
				</div>
			{/if}
		{/if}
	</div>
</div>
```

**Step 3: Pass grouping info from MessageList**

In `MessageList.svelte`, add index `i` to the `{#each}` loop and compute grouping for tool messages:

```svelte
{#each chatState.messages as msg, i (msg.uuid)}
	<!-- ...other types unchanged... -->
	{:else if msg.type === "tool"}
		<ToolItem
			message={msg as ToolMessage}
			isFirstInGroup={chatState.messages[i - 1]?.type !== "tool"}
			isLastInGroup={chatState.messages[i + 1]?.type !== "tool"}
		/>
	<!-- ...rest unchanged... -->
{/each}
```

**Step 4: Verify in Storybook and test**

Run: `npm run storybook` — check all ToolItem stories
Run: `npm run test:unit` — all pass

**Step 5: Commit**

```
feat: redesign ToolItem with slate accent and consecutive grouping
```

---

### Task 4: Redesign SystemMessage

**Files:**
- Modify: `src/lib/public/components/chat/SystemMessage.svelte`

**Step 1: Replace the component**

Key changes:
- Left-aligned (not centered)
- Left border: `--color-border` for info, `--color-error` for error
- Icon: `info` for info, `circle-alert` for error
- Error gets faint red background tint

```svelte
<!-- ─── System Message ──────────────────────────────────────────────────────── -->
<!-- Displays system info/error messages with left-border accent. -->

<script lang="ts">
	import type { SystemMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { message }: { message: SystemMessage } = $props();

	const isError = $derived(message.variant === "error");
</script>

<div class="max-w-[760px] mx-auto my-2 px-5">
	<div
		class="flex items-start gap-2 py-2 px-3 text-xs rounded-r-lg"
		class:border-l-2={!isError}
		class:border-l-3={isError}
		class:border-border={!isError}
		class:border-error={isError}
		class:text-text-muted={!isError}
		class:text-error={isError}
		class:bg-[hsla(5,75%,55%,0.04)]={isError}
	>
		<span class="shrink-0 mt-0.5 [&_.lucide]:w-3 [&_.lucide]:h-3">
			{#if isError}
				<Icon name="circle-alert" size={12} />
			{:else}
				<Icon name="info" size={12} />
			{/if}
		</span>
		<span>{message.text}</span>
	</div>
</div>
```

**Step 2: Verify in Storybook**

Run: `npm run storybook` — check SystemMessage Info and ErrorState stories.

**Step 3: Run tests**

Run: `npm run test:unit`
Expected: All pass.

**Step 4: Commit**

```
feat: redesign SystemMessage with left-border accent and icons
```

---

### Task 5: Update Storybook Stories

**Files:**
- Modify: `src/lib/public/components/chat/ToolItem.stories.ts` (add grouping stories)

**Step 1: Read existing ToolItem stories to match format**

Read: `src/lib/public/components/chat/ToolItem.stories.ts`

**Step 2: Add three new stories for grouping states**

Add these stories using the existing story format, reusing existing message fixtures:

- `FirstInGroup`: `isFirstInGroup: true, isLastInGroup: false` (top rounded corner only)
- `MiddleOfGroup`: `isFirstInGroup: false, isLastInGroup: false` (no rounded corners)
- `LastInGroup`: `isFirstInGroup: false, isLastInGroup: true` (bottom rounded corner only)

**Step 3: Verify all stories render**

Run: `npm run storybook` and check every chat component story.

**Step 4: Commit**

```
feat: add Storybook stories for tool grouping states
```

---

### Task 6: Verify Build and Run Full Test Suite

**Step 1: Build**

Run: `npm run build`
Expected: Clean build, no errors.

**Step 2: Run all unit tests**

Run: `npm run test:unit`
Expected: All pass.

**Step 3: Visual verification with Storybook**

Run: `npm run storybook`
Walk through all chat component stories:
- ThinkingBlock: Active (amber border, inline text), Completed (amber border, compact bar)
- ToolItem: All status variants with slate border; grouping stories with rounded corners
- SystemMessage: Info (neutral border, info icon), Error (red border, alert icon, red tint)
- MessageList: FullConversation and MixedTypes stories to see all types together

**Step 4: Final commit if any adjustments needed**
