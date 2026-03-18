# Tool Group Rendering Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Group consecutive same-category tool calls into collapsible cards with pretty summaries, matching the opencode web UI pattern.

**Architecture:** Render-time grouping — the flat `chatState.messages` array stays unchanged. A pure `groupMessages()` function creates virtual `ToolGroup` objects at render time. Tool inputs are captured from `tool_executing` events and displayed as subtitles/tags.

**Tech Stack:** Svelte 5 (runes), TypeScript, Tailwind CSS, Vitest

---

### Task 1: Add `input` field to ToolMessage type

**Files:**
- Modify: `src/lib/public/types.ts:85-96`

**Step 1: Add the `input` field**

In `src/lib/public/types.ts`, add `input` to `ToolMessage`:

```typescript
export interface ToolMessage {
	type: "tool";
	uuid: string;
	id: string;
	name: string;
	input?: Record<string, unknown>;
	status: "pending" | "running" | "completed" | "error";
	result?: string;
	isError?: boolean;
	isTruncated?: boolean;
	fullContentLength?: number;
	messageId?: string;
}
```

**Step 2: Run tests to verify nothing breaks**

Run: `pnpm test:unit`
Expected: All tests pass (type addition is backward-compatible).

**Step 3: Commit**

```
feat: add input field to ToolMessage type
```

---

### Task 2: Store tool input in handleToolExecuting

**Files:**
- Modify: `src/lib/public/stores/chat.svelte.ts:225-238`
- Test: `test/unit/svelte-chat-store.test.ts`

**Step 1: Write the failing test**

In `test/unit/svelte-chat-store.test.ts`, find the existing tool tests section. Add:

```typescript
it("handleToolExecuting stores input on tool message", () => {
	handleToolStart({ type: "tool_start", id: "t1", name: "Read" });
	handleToolExecuting({
		type: "tool_executing",
		id: "t1",
		name: "Read",
		input: { filePath: "/repo/src/foo.ts", offset: 10 },
	});

	const tool = chatState.messages.find(
		(m) => m.type === "tool" && m.id === "t1",
	) as ToolMessage | undefined;
	expect(tool).toBeDefined();
	expect(tool!.status).toBe("running");
	expect(tool!.input).toEqual({ filePath: "/repo/src/foo.ts", offset: 10 });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- --grep "handleToolExecuting stores input"`
Expected: FAIL — `tool.input` is `undefined`.

**Step 3: Implement — store input in handleToolExecuting**

In `src/lib/public/stores/chat.svelte.ts`, modify `handleToolExecuting`:

```typescript
export function handleToolExecuting(
	msg: Extract<RelayMessage, { type: "tool_executing" }>,
): void {
	const { id, input } = msg;
	const uuid = toolUuidMap.get(id);
	if (!uuid) return;

	const messages = [...chatState.messages];
	const idx = messages.findIndex((m) => m.type === "tool" && m.uuid === uuid);
	if (idx >= 0) {
		const toolInput = input != null && typeof input === "object" && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: undefined;
		messages[idx] = { ...(messages[idx] as ToolMessage), status: "running", input: toolInput };
		chatState.messages = messages;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- --grep "handleToolExecuting stores input"`
Expected: PASS

**Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```
feat: store tool input from tool_executing events
```

---

### Task 3: Extract tool input in history-logic.ts

**Files:**
- Modify: `src/lib/public/utils/history-logic.ts:178-199`
- Test: `test/unit/history-to-chat-messages.test.ts`

**Step 1: Write the failing test**

In `test/unit/history-to-chat-messages.test.ts`, add a test that verifies tool input is extracted:

```typescript
it("extracts tool input from history parts", () => {
	const turns: Turn[] = [
		{
			assistant: assistantMsg("a1", [
				{
					id: "p1",
					type: "tool",
					callID: "call1",
					tool: "read",
					state: {
						status: "completed",
						input: { filePath: "/repo/src/lib/foo.ts" },
						output: "file contents here",
					},
				},
			]),
		},
	];

	const result = convertTurnsToMessages(turns);
	const tool = result.find((m) => m.type === "tool") as ToolMessage | undefined;
	expect(tool).toBeDefined();
	expect(tool!.input).toEqual({ filePath: "/repo/src/lib/foo.ts" });
});
```

Note: Check how `assistantMsg` helper is defined in the test file and adapt. The key is passing `state.input` through.

**Step 2: Run test to verify it fails**

Run: `pnpm test:unit -- --grep "extracts tool input"`
Expected: FAIL — `tool.input` is `undefined`.

**Step 3: Implement — pass input through in history-logic.ts**

In `src/lib/public/utils/history-logic.ts`, in the `case "tool":` block of `convertAssistantParts`, add `input`:

```typescript
case "tool": {
	const state = part.state as
		| {
				status?: string;
				input?: unknown;
				output?: string;
				error?: string;
		  }
		| undefined;
	const isError = state?.status === "error";
	const toolInput = state?.input != null && typeof state.input === "object" && !Array.isArray(state.input)
		? (state.input as Record<string, unknown>)
		: undefined;
	result.push({
		type: "tool",
		uuid: generateUuid(),
		id: (part.callID as string) ?? part.id,
		name: (part.tool as string) ?? "unknown",
		status: mapToolStatus(state?.status),
		result: isError
			? (state?.error ?? "Unknown error")
			: (state?.output ?? undefined),
		isError,
		input: toolInput,
	} satisfies ToolMessage);
	break;
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm test:unit -- --grep "extracts tool input"`
Expected: PASS

**Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```
feat: extract tool input from history parts
```

---

### Task 4: Create groupMessages utility + extractToolSummary

**Files:**
- Create: `src/lib/public/utils/group-tools.ts`
- Create: `test/unit/group-tools.test.ts`

**Step 1: Write the tests**

Create `test/unit/group-tools.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
	groupMessages,
	extractToolSummary,
	getToolCategory,
	type ToolGroup,
} from "../../src/lib/public/utils/group-tools.js";
import type { ChatMessage, ToolMessage } from "../../src/lib/public/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function tool(name: string, id: string, input?: Record<string, unknown>): ToolMessage {
	return {
		type: "tool",
		uuid: `uuid-${id}`,
		id,
		name,
		status: "completed",
		input,
	};
}

function assistantMsg(text: string): ChatMessage {
	return {
		type: "assistant",
		uuid: "a1",
		rawText: text,
		html: text,
		finalized: true,
	};
}

// ─── getToolCategory ────────────────────────────────────────────────────────

describe("getToolCategory", () => {
	it("maps Read to explore", () => {
		expect(getToolCategory("Read")).toBe("explore");
	});

	it("maps Glob to explore", () => {
		expect(getToolCategory("Glob")).toBe("explore");
	});

	it("maps Grep to explore", () => {
		expect(getToolCategory("Grep")).toBe("explore");
	});

	it("maps Edit to edit", () => {
		expect(getToolCategory("Edit")).toBe("edit");
	});

	it("maps Write to edit", () => {
		expect(getToolCategory("Write")).toBe("edit");
	});

	it("maps Bash to shell", () => {
		expect(getToolCategory("Bash")).toBe("shell");
	});

	it("maps WebFetch to fetch", () => {
		expect(getToolCategory("WebFetch")).toBe("fetch");
	});

	it("maps Task to task", () => {
		expect(getToolCategory("Task")).toBe("task");
	});

	it("maps unknown tools to other", () => {
		expect(getToolCategory("SomethingNew")).toBe("other");
	});
});

// ─── extractToolSummary ─────────────────────────────────────────────────────

describe("extractToolSummary", () => {
	it("extracts relative path for Read", () => {
		const result = extractToolSummary("Read", { filePath: "/home/user/repo/src/lib/foo.ts" }, "/home/user/repo");
		expect(result.subtitle).toBe("src/lib/foo.ts");
	});

	it("shows offset/limit tags for Read", () => {
		const result = extractToolSummary("Read", { filePath: "/repo/foo.ts", offset: 82, limit: 10 }, "/repo");
		expect(result.tags).toEqual(["offset=82", "limit=10"]);
	});

	it("extracts description for Bash", () => {
		const result = extractToolSummary("Bash", { command: "git status", description: "Check repo status" });
		expect(result.subtitle).toBe("Check repo status");
	});

	it("falls back to command for Bash without description", () => {
		const result = extractToolSummary("Bash", { command: "git rev-parse HEAD" });
		expect(result.subtitle).toBe("git rev-parse HEAD");
	});

	it("truncates long Bash commands", () => {
		const result = extractToolSummary("Bash", { command: "a".repeat(60) });
		expect(result.subtitle!.length).toBeLessThanOrEqual(43); // 40 + "…"
	});

	it("extracts pattern for Grep", () => {
		const result = extractToolSummary("Grep", { pattern: "handleTool.*" });
		expect(result.subtitle).toBe("handleTool.*");
	});

	it("extracts include tag for Grep", () => {
		const result = extractToolSummary("Grep", { pattern: "foo", include: "*.ts" });
		expect(result.tags).toEqual(["include=*.ts"]);
	});

	it("extracts pattern for Glob", () => {
		const result = extractToolSummary("Glob", { pattern: "**/*.svelte" });
		expect(result.subtitle).toBe("**/*.svelte");
	});

	it("extracts hostname for WebFetch", () => {
		const result = extractToolSummary("WebFetch", { url: "https://docs.example.com/api/v2" });
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("extracts description for Task", () => {
		const result = extractToolSummary("Task", { description: "Explore codebase", subagent_type: "explore" });
		expect(result.subtitle).toBe("Explore codebase");
		expect(result.tags).toEqual(["explore"]);
	});

	it("returns empty for unknown tool with no input", () => {
		const result = extractToolSummary("Unknown", undefined);
		expect(result.subtitle).toBeUndefined();
	});
});

// ─── groupMessages ──────────────────────────────────────────────────────────

describe("groupMessages", () => {
	it("passes through non-tool messages unchanged", () => {
		const msgs: ChatMessage[] = [assistantMsg("hello")];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual(msgs[0]);
	});

	it("does not group a single tool message", () => {
		const msgs: ChatMessage[] = [tool("Read", "t1")];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);
		expect(result[0].type).toBe("tool");
	});

	it("groups 2+ consecutive same-category tools", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "t1"),
			tool("Read", "t2"),
			tool("Glob", "t3"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(1);
		const group = result[0] as ToolGroup;
		expect(group.type).toBe("tool-group");
		expect(group.category).toBe("explore");
		expect(group.label).toBe("Explored");
		expect(group.tools).toHaveLength(3);
	});

	it("generates correct summary for mixed tools in category", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "t1"),
			tool("Read", "t2"),
			tool("Grep", "t3"),
		];
		const result = groupMessages(msgs);
		const group = result[0] as ToolGroup;
		expect(group.summary).toBe("2 reads, 1 grep");
	});

	it("breaks groups at non-tool messages", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "t1"),
			tool("Read", "t2"),
			assistantMsg("thinking..."),
			tool("Read", "t3"),
			tool("Read", "t4"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3); // group, assistant, group
		expect(result[0].type).toBe("tool-group");
		expect(result[1].type).toBe("assistant");
		expect(result[2].type).toBe("tool-group");
	});

	it("breaks groups at different categories", () => {
		const msgs: ChatMessage[] = [
			tool("Read", "t1"),
			tool("Read", "t2"),
			tool("Bash", "t3"),
		];
		const result = groupMessages(msgs);
		expect(result).toHaveLength(3); // group(explore), solo(shell)
		expect(result[0].type).toBe("tool-group");
		expect(result[1].type).toBe("tool"); // solo Bash
		// Wait — 2 Reads + 1 Bash = group of 2 + solo
		// Actually: Read,Read = explore, Bash = shell (different category)
		// So: group(Read,Read) + solo(Bash) = 2 items
		expect(result).toHaveLength(2);
	});

	it("sets aggregate status to running if any tool is pending/running", () => {
		const msgs: ChatMessage[] = [
			{ ...tool("Read", "t1"), status: "completed" },
			{ ...tool("Read", "t2"), status: "running" },
		];
		const result = groupMessages(msgs);
		const group = result[0] as ToolGroup;
		expect(group.status).toBe("running");
	});

	it("sets aggregate status to error if any tool errored", () => {
		const msgs: ChatMessage[] = [
			{ ...tool("Read", "t1"), status: "completed" },
			{ ...tool("Read", "t2"), status: "error" },
		];
		const result = groupMessages(msgs);
		const group = result[0] as ToolGroup;
		expect(group.status).toBe("error");
	});

	it("sets aggregate status to completed when all done", () => {
		const msgs: ChatMessage[] = [
			{ ...tool("Read", "t1"), status: "completed" },
			{ ...tool("Read", "t2"), status: "completed" },
		];
		const result = groupMessages(msgs);
		const group = result[0] as ToolGroup;
		expect(group.status).toBe("completed");
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test:unit -- --grep "group-tools"`
Expected: FAIL — module not found.

**Step 3: Implement group-tools.ts**

Create `src/lib/public/utils/group-tools.ts`:

```typescript
import type { ChatMessage, ToolMessage } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type ToolCategory = "explore" | "edit" | "shell" | "fetch" | "task" | "other";

export interface ToolGroup {
	type: "tool-group";
	uuid: string;
	category: ToolCategory;
	label: string;
	summary: string;
	tools: ToolMessage[];
	status: "pending" | "running" | "completed" | "error";
}

export type GroupedMessage = ChatMessage | ToolGroup;

// ─── Category Mapping ───────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, ToolCategory> = {
	Read: "explore",
	Glob: "explore",
	Grep: "explore",
	LSP: "explore",
	Edit: "edit",
	Write: "edit",
	Bash: "shell",
	WebFetch: "fetch",
	WebSearch: "fetch",
	Task: "task",
};

const CATEGORY_LABELS: Record<ToolCategory, string> = {
	explore: "Explored",
	edit: "Edited",
	shell: "Shell",
	fetch: "Fetched",
	task: "Tasked",
	other: "Used",
};

export function getToolCategory(toolName: string): ToolCategory {
	return CATEGORY_MAP[toolName] ?? "other";
}

// ─── Tool Summary Extraction ────────────────────────────────────────────────

export interface ToolSummaryInfo {
	subtitle?: string;
	tags?: string[];
}

function relativePath(absPath: string, repoRoot?: string): string {
	if (!repoRoot) return absPath;
	const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return absPath.startsWith(root) ? absPath.slice(root.length) : absPath;
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function extractToolSummary(
	name: string,
	input?: Record<string, unknown>,
	repoRoot?: string,
): ToolSummaryInfo {
	if (!input) return {};

	switch (name) {
		case "Read":
		case "Edit":
		case "Write": {
			const fp = input.filePath as string | undefined;
			const subtitle = fp ? relativePath(fp, repoRoot) : undefined;
			const tags: string[] = [];
			if (name === "Read") {
				if (input.offset != null) tags.push(`offset=${input.offset}`);
				if (input.limit != null) tags.push(`limit=${input.limit}`);
			}
			return { subtitle, tags: tags.length > 0 ? tags : undefined };
		}
		case "Glob": {
			return { subtitle: input.pattern as string | undefined };
		}
		case "Grep": {
			const tags: string[] = [];
			if (input.include) tags.push(`include=${input.include}`);
			return {
				subtitle: input.pattern as string | undefined,
				tags: tags.length > 0 ? tags : undefined,
			};
		}
		case "Bash": {
			const desc = input.description as string | undefined;
			const cmd = input.command as string | undefined;
			return { subtitle: desc ?? (cmd ? truncate(cmd, 40) : undefined) };
		}
		case "Task": {
			const tags: string[] = [];
			if (input.subagent_type) tags.push(String(input.subagent_type));
			return {
				subtitle: input.description as string | undefined,
				tags: tags.length > 0 ? tags : undefined,
			};
		}
		case "WebFetch":
		case "WebSearch": {
			const url = input.url as string | undefined;
			if (!url) return {};
			try {
				return { subtitle: new URL(url).hostname };
			} catch {
				return { subtitle: url };
			}
		}
		case "LSP": {
			const op = input.operation as string | undefined;
			const fp = input.filePath as string | undefined;
			const tags = fp ? [relativePath(fp, repoRoot)] : undefined;
			return { subtitle: op, tags };
		}
		default:
			return {};
	}
}

// ─── Group Messages ─────────────────────────────────────────────────────────

function toolCountSummary(tools: ToolMessage[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) {
		const name = t.name.toLowerCase();
		counts.set(name, (counts.get(name) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => `${count} ${count === 1 ? name : `${name}s`}`)
		.join(", ");
}

function aggregateStatus(
	tools: ToolMessage[],
): "pending" | "running" | "completed" | "error" {
	if (tools.some((t) => t.status === "running" || t.status === "pending"))
		return "running";
	if (tools.some((t) => t.status === "error")) return "error";
	return "completed";
}

export function groupMessages(messages: ChatMessage[]): GroupedMessage[] {
	const result: GroupedMessage[] = [];
	let currentGroup: ToolMessage[] = [];
	let currentCategory: ToolCategory | null = null;

	function flushGroup(): void {
		if (currentGroup.length === 0) return;
		if (currentGroup.length === 1) {
			// Solo tool — don't wrap in group
			result.push(currentGroup[0]);
		} else {
			const cat = currentCategory!;
			result.push({
				type: "tool-group",
				uuid: `group-${currentGroup[0].uuid}`,
				category: cat,
				label: CATEGORY_LABELS[cat],
				summary: toolCountSummary(currentGroup),
				tools: currentGroup,
				status: aggregateStatus(currentGroup),
			});
		}
		currentGroup = [];
		currentCategory = null;
	}

	for (const msg of messages) {
		if (msg.type === "tool") {
			const cat = getToolCategory(msg.name);
			if (currentCategory === cat) {
				currentGroup.push(msg);
			} else {
				flushGroup();
				currentCategory = cat;
				currentGroup = [msg];
			}
		} else {
			flushGroup();
			result.push(msg);
		}
	}
	flushGroup();

	return result;
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test:unit -- --grep "group-tools"`
Expected: All pass. Fix the test that expected 3 results for `[Read, Read, Bash]` — it should expect 2 (group + solo).

**Step 5: Run full test suite**

Run: `pnpm test:unit`
Expected: All pass.

**Step 6: Commit**

```
feat: add groupMessages utility for tool call grouping
```

---

### Task 5: Enhance ToolItem with input subtitle display

**Files:**
- Modify: `src/lib/public/components/chat/ToolItem.svelte`
- Modify: `src/lib/public/stories/mocks.ts`
- Modify or create: `src/lib/public/components/chat/ToolItem.stories.ts`

**Step 1: Update mock data to include input**

In `src/lib/public/stories/mocks.ts`, update existing tool mocks and add new ones:

```typescript
export const mockToolCompleted: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-003",
	id: "tool-003",
	name: "Read",
	status: "completed",
	input: { filePath: "/home/user/repo/src/auth.ts" },
	result: "export function authenticate...",
	isError: false,
};

export const mockToolBash: ToolMessage = {
	type: "tool",
	uuid: "msg-tool-007",
	id: "tool-007",
	name: "Bash",
	status: "completed",
	input: { command: "git rev-parse HEAD", description: "Get base SHA for reviews" },
	result: "c14c4da090bb9b35ae2b716d44a9d0d6fa9bf112",
	isError: false,
};
```

**Step 2: Enhance ToolItem.svelte with subtitle display**

Import `extractToolSummary` and display subtitle + tags. Replace the `descText` derived with input-aware logic. Add subtitle and tags rendering below the tool name.

The key changes to ToolItem.svelte:
1. Import `extractToolSummary` from `../../utils/group-tools.js`
2. Add a derived `toolSummary` that calls `extractToolSummary(message.name, message.input)`
3. Replace `descText` to prefer `toolSummary.subtitle` over the first line of result
4. Add tag pills after the subtitle when `toolSummary.tags` exists

**Step 3: Add storybook stories for input variants**

Add stories showing Read with path, Bash with description, Grep with pattern + include tag.

**Step 4: Visually verify in Storybook**

Run: `pnpm storybook` and check the ToolItem stories.

**Step 5: Commit**

```
feat: display tool input subtitles and tags in ToolItem
```

---

### Task 6: Create ToolGroupItem component

**Files:**
- Create: `src/lib/public/components/chat/ToolGroupItem.svelte`
- Create: `src/lib/public/components/chat/ToolGroupItem.stories.ts`

**Step 1: Create ToolGroupItem.svelte**

A compact row for display within a group. Shows: tool name + subtitle + tags + status dot. Clickable to expand result inline.

```svelte
<!-- ─── Tool Group Item ──────────────────────────────────────────────────── -->
<!-- Compact row for a single tool within a ToolGroupCard. -->

<script lang="ts">
	import type { ToolMessage } from "../../types.js";
	import { extractToolSummary } from "../../utils/group-tools.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import Icon from "../shared/Icon.svelte";

	let { message, isLast = false }: { message: ToolMessage; isLast?: boolean } = $props();
	let expanded = $state(false);
	let loadingFullContent = $state(false);

	const summary = $derived(extractToolSummary(message.name, message.input));

	const bulletClass = $derived.by(() => {
		switch (message.status) {
			case "pending": return "bg-text-muted";
			case "running": return "bg-accent animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "completed": return "bg-success";
			case "error": return "bg-error";
			default: return "bg-text-muted";
		}
	});

	function handleToggle() {
		expanded = !expanded;
	}

	function requestFullContent() {
		loadingFullContent = true;
		wsSend({ type: "get_tool_content", toolId: message.id });
		const timeout = setTimeout(() => { loadingFullContent = false; }, 10_000);
		// Effect watches for isTruncated becoming false
	}

	$effect(() => {
		if (!message.isTruncated) loadingFullContent = false;
	});
</script>

<div class="tool-group-item">
	<button
		class="flex items-center gap-2 w-full py-1.5 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-black/[0.03] transition-colors duration-150 border-none text-left"
		onclick={handleToggle}
	>
		<span class="text-text-dimmer font-mono text-xs w-3">
			{isLast ? "└" : "├"}
		</span>

		<span class="text-accent font-medium font-mono text-xs shrink-0">
			{message.name}
		</span>

		{#if summary.subtitle}
			<span class="font-mono text-xs text-text-dimmer truncate">
				{summary.subtitle}
			</span>
		{/if}

		{#if summary.tags}
			{#each summary.tags as tag}
				<span class="px-1.5 py-0.5 rounded bg-black/5 font-mono text-[11px] text-text-dimmer shrink-0">
					{tag}
				</span>
			{/each}
		{/if}

		<span class="flex-1"></span>

		<span class="w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>
	</button>

	{#if expanded && message.result}
		<div class="font-mono text-xs whitespace-pre-wrap break-all mx-8 my-0.5 py-2 px-2.5 bg-code-bg border border-border-subtle rounded-lg text-text-secondary max-h-[300px] overflow-y-auto"
			class:text-error={message.isError}
		>
			{message.result}
		</div>

		{#if message.isTruncated}
			<div class="flex items-center gap-2 mx-8 mt-1 mb-1 text-xs text-text-dimmer">
				<span class="font-mono">
					Showing {(message.result.length / 1024).toFixed(1)} KB of {((message.fullContentLength ?? message.result.length) / 1024).toFixed(1)} KB
				</span>
				<button
					class="px-2 py-0.5 rounded bg-accent/10 text-accent hover:bg-accent/20 transition-colors text-xs font-medium disabled:opacity-50"
					onclick={requestFullContent}
					disabled={loadingFullContent}
				>
					{loadingFullContent ? "Loading…" : "Show full output"}
				</button>
			</div>
		{/if}
	{/if}
</div>
```

**Step 2: Create stories**

Create `src/lib/public/components/chat/ToolGroupItem.stories.ts` with variants: Read with path, Bash with description, Grep with tags, error state.

**Step 3: Visually verify in Storybook**

Run: `pnpm storybook`

**Step 4: Commit**

```
feat: add ToolGroupItem component for grouped tool rows
```

---

### Task 7: Create ToolGroupCard component

**Files:**
- Create: `src/lib/public/components/chat/ToolGroupCard.svelte`
- Create: `src/lib/public/components/chat/ToolGroupCard.stories.ts`

**Step 1: Create ToolGroupCard.svelte**

Collapsible card that shows summary header and list of ToolGroupItems.

```svelte
<!-- ─── Tool Group Card ──────────────────────────────────────────────────── -->
<!-- Collapsible card grouping consecutive same-category tool calls. -->

<script lang="ts">
	import type { ToolGroup } from "../../utils/group-tools.js";
	import ToolGroupItem from "./ToolGroupItem.svelte";
	import Icon from "../shared/Icon.svelte";

	let { group }: { group: ToolGroup } = $props();
	let expanded = $state(false);

	const bulletClass = $derived.by(() => {
		switch (group.status) {
			case "pending": return "bg-text-muted";
			case "running": return "bg-accent animate-[pulse-dot_1.2s_ease-in-out_infinite]";
			case "completed": return "bg-success";
			case "error": return "bg-error";
			default: return "bg-text-muted";
		}
	});

	const statusIconName = $derived.by(() => {
		switch (group.status) {
			case "running":
			case "pending": return "loader";
			case "completed": return "check";
			case "error": return "circle-alert";
			default: return "loader";
		}
	});

	const statusIconClass = $derived.by(() => {
		if (group.status === "running" || group.status === "pending")
			return "text-text-muted icon-spin";
		if (group.status === "error") return "text-error";
		return "text-text-dimmer";
	});

	function handleToggle() {
		expanded = !expanded;
	}
</script>

<div class="tool-group max-w-[760px] mx-auto px-5 my-1.5">
	<div class="border-l-3 border-tool bg-tool-bg rounded-r-lg">
		<button
			class="tool-group-header flex items-center gap-2.5 w-full py-2 px-3 cursor-pointer select-none text-[13px] text-text-secondary hover:bg-black/[0.03] transition-colors duration-150 border-none text-left rounded-tr-lg"
			onclick={handleToggle}
		>
			<span
				class="text-text-dimmer transition-transform duration-200 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5"
				class:rotate-90={expanded}
			>
				<Icon name="chevron-right" size={14} />
			</span>

			<span class="w-2 h-2 rounded-full shrink-0 {bulletClass}"></span>

			<span class="font-medium text-text-secondary text-xs">
				{group.label}
			</span>

			<span class="text-text-dimmer text-xs">
				· {group.summary}
			</span>

			<span class="flex-1"></span>

			<span class="shrink-0 [&_.lucide]:w-3.5 [&_.lucide]:h-3.5 {statusIconClass}">
				<Icon name={statusIconName} size={14} />
			</span>
		</button>

		{#if expanded}
			<div class="tool-group-list">
				{#each group.tools as tool, i (tool.uuid)}
					<ToolGroupItem
						message={tool}
						isLast={i === group.tools.length - 1}
					/>
				{/each}
			</div>
		{/if}
	</div>
</div>
```

**Step 2: Create stories**

Create stories with: collapsed group of 5 reads, expanded group with mixed tools, running group, error group.

**Step 3: Visually verify in Storybook**

Run: `pnpm storybook`

**Step 4: Commit**

```
feat: add ToolGroupCard collapsible group component
```

---

### Task 8: Wire grouping into MessageList.svelte

**Files:**
- Modify: `src/lib/public/components/chat/MessageList.svelte`

**Step 1: Import grouping utilities and components**

Add imports for `groupMessages`, `ToolGroupCard`, and the `ToolGroup`/`GroupedMessage` types.

**Step 2: Add $derived groupedMessages**

```typescript
const groupedMessages = $derived(groupMessages(chatState.messages));
```

**Step 3: Update the render loop**

Change `{#each chatState.messages as msg, i (msg.uuid)}` to iterate over `groupedMessages` instead. Add a case for `msg.type === "tool-group"` that renders `<ToolGroupCard group={msg} />`. Keep the existing `ToolItem` rendering for solo tools (which come through as regular `ToolMessage`). Remove the `isFirstInGroup`/`isLastInGroup` props from solo `ToolItem` (they're no longer needed since solo tools don't need group border radius — they're always standalone).

**Step 4: Test manually with a live session**

Start the dev server and verify with a real opencode session that has tool calls.

**Step 5: Commit**

```
feat: wire tool grouping into MessageList render loop
```

---

### Task 9: Wire grouping into HistoryView.svelte

**Files:**
- Modify: `src/lib/public/components/features/HistoryView.svelte`

**Step 1: Apply same grouping pattern**

Import `groupMessages` and `ToolGroupCard`. Add derived grouping for the history messages array. Update the render loop to handle `tool-group` type.

**Step 2: Test with history**

Switch sessions (to trigger history loading) and verify grouped rendering.

**Step 3: Commit**

```
feat: wire tool grouping into HistoryView render loop
```

---

### Task 10: Run full test suite + cleanup

**Step 1: Run all tests**

Run: `pnpm test:unit`
Expected: All pass.

**Step 2: Run lint**

Run: `pnpm lint`
Expected: No errors.

**Step 3: Run typecheck**

Run: `pnpm check` (or whatever the svelte-check command is)
Expected: No new errors.

**Step 4: Final commit**

If any cleanup was needed:
```
chore: cleanup after tool group rendering implementation
```
