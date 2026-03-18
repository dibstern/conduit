# Skill Item Separation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract Skill tool rendering into a dedicated `SkillItem.svelte` component, prevent Skills from being grouped with other tools, and route them through a separate rendering path.

**Architecture:** Rendering-only change — Skills remain `ToolMessage` internally. The grouping layer (`group-tools.ts`) excludes them from grouping. `MessageList.svelte` and `HistoryView.svelte` route `name === "Skill"` to the new `SkillItem` component. Skill-specific code is removed from `ToolItem.svelte` and `ToolGroupItem.svelte`.

**Tech Stack:** Svelte 5, TypeScript, Vitest

---

### Task 1: Add test for Skill never-grouped behavior

**Files:**
- Modify: `test/unit/handlers/group-tools.test.ts`

**Step 1: Write the failing tests**

Add three test cases at the end of the `groupMessages` describe block (after the `lowercase 'task'` test at line 509):

```typescript
it("Skill tools are never grouped — they need dedicated SkillItem", () => {
	const msgs: ChatMessage[] = [tool("Skill", "s1"), tool("Skill", "s2")];
	const result = groupMessages(msgs);
	expect(result).toHaveLength(2);
	expect(result[0]?.type).toBe("tool");
	expect(result[1]?.type).toBe("tool");
});

it("Skill breaks grouping of surrounding explore tools", () => {
	const msgs: ChatMessage[] = [
		tool("Read", "r1"),
		tool("Skill", "s1"),
		tool("Read", "r2"),
	];
	const result = groupMessages(msgs);
	expect(result).toHaveLength(3);
	expect(result.every((m) => m.type === "tool")).toBe(true);
});

it("Skill between grouped tools preserves the groups", () => {
	const msgs: ChatMessage[] = [
		tool("Read", "r1"),
		tool("Read", "r2"),
		tool("Skill", "s1"),
		tool("Bash", "b1"),
		tool("Bash", "b2"),
	];
	const result = groupMessages(msgs);
	expect(result).toHaveLength(3);
	expect((result[0] as ToolGroup).type).toBe("tool-group"); // Read group
	expect(result[1]?.type).toBe("tool"); // Skill standalone
	expect((result[2] as ToolGroup).type).toBe("tool-group"); // Bash group
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/unit/handlers/group-tools.test.ts`
Expected: 3 FAIL (Skill tools are currently grouped as "explore" category)

**Step 3: Commit**

```bash
git add test/unit/handlers/group-tools.test.ts
git commit -m "test: add failing tests for Skill never-grouped behavior"
```

---

### Task 2: Make Skill never-grouped in group-tools.ts

**Files:**
- Modify: `src/lib/frontend/utils/group-tools.ts`

**Step 1: Add Skill to the never-grouped list**

In `groupMessages()` function, find the condition block at lines 261-268:

```typescript
if (
	msg.name === "AskUserQuestion" ||
	msg.name === "Task" ||
	msg.name === "task"
) {
```

Add `msg.name === "Skill"`:

```typescript
if (
	msg.name === "AskUserQuestion" ||
	msg.name === "Task" ||
	msg.name === "task" ||
	msg.name === "Skill"
) {
```

**Step 2: Run tests to verify they pass**

Run: `pnpm vitest run test/unit/handlers/group-tools.test.ts`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/lib/frontend/utils/group-tools.ts
git commit -m "feat: exclude Skill from tool grouping"
```

---

### Task 3: Create SkillItem.svelte component

**Files:**
- Create: `src/lib/frontend/components/chat/SkillItem.svelte`

**Step 1: Create the component**

Extract the Skill rendering from `ToolItem.svelte` (lines 453-504) into a new dedicated component. Include the necessary derived values and status logic:

```svelte
<!-- ─── Skill Item ──────────────────────────────────────────────────────────── -->
<!-- Displays a Skill tool invocation with sparkles icon, formatted name, -->
<!-- and expandable result. Dedicated component — Skills are never grouped. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import Icon from "../shared/Icon.svelte";

	let { message }: { message: ToolMessage } = $props();
	let expanded = $state(false);

	// ─── Skill name parsing ──────────────────────────────────────────────
	const skillName = $derived.by(() => {
		const inp = message.input as Record<string, unknown> | null | undefined;
		return (inp?.['name'] as string) ?? null;
	});

	/** Format the skill name for display: kebab-case → Title Case */
	const skillDisplayName = $derived.by(() => {
		if (!skillName) return "Skill";
		return skillName
			.split("-")
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(" ");
	});

	// ─── Status ─────────────────────────────────────────────────────────
	const bulletClass = $derived.by(() => {
		switch (message.status) {
			case "pending":
				return "bg-text-muted";
			case "running":
				return "bg-accent animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "completed":
				return "bg-success";
			case "error":
				return "bg-error";
			default:
				return "bg-text-muted";
		}
	});

	const statusIconName = $derived.by(() => {
		switch (message.status) {
			case "running":
			case "pending":
				return "loader";
			case "completed":
				return "check";
			case "error":
				return "circle-alert";
			default:
				return "loader";
		}
	});

	const statusIconClass = $derived.by(() => {
		if (message.status === "running" || message.status === "pending")
			return "text-text-muted icon-spin";
		if (message.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	const subtitleText = $derived.by(() => {
		switch (message.status) {
			case "pending":
				return "Pending…";
			case "running":
				return "Running…";
			case "completed":
				return "Done";
			case "error":
				return "Error";
			default:
				return "";
		}
	});

	const borderColor = $derived(
		message.isError ? "border-error" : "border-tool"
	);

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div
	class="skill-item max-w-[760px] mx-auto px-5 my-1.5"
	data-tool-id={message.id}
>
	<div class="border-l-3 {borderColor} bg-tool-bg rounded-r-lg">
		<button
			class="skill-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-black/[0.03] transition-colors duration-150 border-none text-left rounded-tr-lg"
			onclick={handleToggle}
		>
			<!-- Status bullet -->
			<span class="tool-bullet w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>

			<!-- Skill icon -->
			<span class="text-accent [&_.lucide]:w-4 [&_.lucide]:h-4">
				<Icon name="sparkles" size={16} />
			</span>

			<!-- Skill label -->
			<div class="flex-1 min-w-0">
				<span class="skill-title text-accent font-semibold text-xs">
					{skillDisplayName}
				</span>
				{#if skillName}
					<span class="text-text-dimmer font-mono text-xs ml-1.5">
						{skillName}
					</span>
				{/if}
			</div>

			<!-- Status icon -->
			<span
				class="tool-status-icon shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}"
			>
				<Icon name={statusIconName} size={14} />
			</span>
		</button>

		<!-- Subtitle row -->
		<div
			class="tool-subtitle flex items-center gap-1.5 py-0.5 px-3 pl-4 text-xs italic text-text-dimmer"
		>
			<span class="tool-connector font-mono not-italic text-border">└</span>
			<span class="tool-subtitle-text">{subtitleText}</span>
		</div>

		{#if expanded && message.result}
			<div
				class="tool-result font-mono text-xs whitespace-pre-wrap break-all my-0.5 mx-2.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto"
			>
				{message.result.replace(/^<skill_content[^>]*>\n?/, "").replace(/\n?<\/skill_content>\s*$/, "")}
			</div>
		{/if}
	</div>
</div>
```

**Step 2: Verify no TypeScript errors**

Run: `pnpm tsc --noEmit -p src/lib/frontend/tsconfig.json` (or equivalent check)

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/SkillItem.svelte
git commit -m "feat: create dedicated SkillItem component"
```

---

### Task 4: Route Skills to SkillItem in MessageList and HistoryView

**Files:**
- Modify: `src/lib/frontend/components/chat/MessageList.svelte`
- Modify: `src/lib/frontend/components/features/HistoryView.svelte`

**Step 1: Update MessageList.svelte**

Add import at the top (after the ToolItem import at line 32):

```typescript
import SkillItem from "./SkillItem.svelte";
```

In the `{#each groupedMessages}` block, add a new branch **before** the generic `tool` check (between lines 184-185):

```svelte
{:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
	<SkillItem message={msg as ToolMessage} />
```

**Step 2: Update HistoryView.svelte**

Add import at the top (with the other chat component imports):

```typescript
import SkillItem from "../chat/SkillItem.svelte";
```

In the `{#each groupedMessages}` block, add the same branch **before** the generic `tool` check (between lines 173-174):

```svelte
{:else if msg.type === "tool" && (msg as ToolMessage).name === "Skill"}
	<SkillItem message={msg as ToolMessage} />
```

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/MessageList.svelte src/lib/frontend/components/features/HistoryView.svelte
git commit -m "feat: route Skill tools to dedicated SkillItem component"
```

---

### Task 5: Remove Skill code from ToolItem.svelte

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolItem.svelte`

**Step 1: Remove Skill derived values**

Delete the Skill detection block (lines 170-189):

```typescript
// ─── Skill detection ────────────────────────────────────────────────────
// ... through skillDisplayName
```

**Step 2: Remove the Skill rendering branch**

Delete the `{:else if isSkill}` block (lines 453-504), leaving the flow: `{#if isQuestion}` → `{:else if isSubagent}` → `{:else}` (generic).

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/ToolItem.svelte
git commit -m "refactor: remove Skill rendering from ToolItem"
```

---

### Task 6: Remove Skill code from ToolGroupItem.svelte

**Files:**
- Modify: `src/lib/frontend/components/chat/ToolGroupItem.svelte`

**Step 1: Remove Skill derived values**

Delete `isSkill`, `skillDisplayName`, and `skillResult` derived values (lines 17-36).

**Step 2: Remove Skill branches from template**

In the tool name display (line 107), simplify from:
```svelte
{isSkill && skillDisplayName ? skillDisplayName : message.name}
```
to:
```svelte
{message.name}
```

In the expanded result (line 139), simplify from:
```svelte
{#if isSkill && skillResult}{skillResult}{:else if message.result}{message.result}{/if}
```
to:
```svelte
{#if message.result}{message.result}{/if}
```

**Step 3: Commit**

```bash
git add src/lib/frontend/components/chat/ToolGroupItem.svelte
git commit -m "refactor: remove dead Skill code from ToolGroupItem"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all unit tests**

Run: `pnpm test:unit`
Expected: ALL PASS

**Step 2: Run the group-tools tests specifically**

Run: `pnpm vitest run test/unit/handlers/group-tools.test.ts`
Expected: ALL PASS (including the 3 new Skill tests)

**Step 3: Build the frontend**

Run: `pnpm build:frontend`
Expected: Build succeeds with no errors

**Step 4: Final commit (if any fixes needed)**

If any fixes were required, commit them.
