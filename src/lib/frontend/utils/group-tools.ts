// ─── Group Tools — Utility Functions ──────────────────────────────────────────
// Groups consecutive same-category tool messages into ToolGroups.

import type { ToolName, ToolStatus } from "../../shared-types.js";
import type { ChatMessage, ToolMessage } from "../types.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolCategory =
	| "explore"
	| "edit"
	| "shell"
	| "fetch"
	| "task"
	| "other";

export interface ToolGroup {
	type: "tool-group";
	uuid: string;
	category: ToolCategory;
	label: string;
	summary: string;
	tools: ToolMessage[];
	status: ToolStatus;
}

export type GroupedMessage = ChatMessage | ToolGroup;

// ─── Category Map ────────────────────────────────────────────────────────────

const TOOL_CATEGORIES: Partial<Record<ToolName, ToolCategory>> = {
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
	Skill: "explore",
};

const CATEGORY_LABELS: Record<ToolCategory, string> = {
	explore: "Explored",
	edit: "Edited",
	shell: "Shell",
	fetch: "Fetched",
	task: "Tasked",
	other: "Used",
};

// ─── getToolCategory ─────────────────────────────────────────────────────────

export function getToolCategory(toolName: string): ToolCategory {
	return TOOL_CATEGORIES[toolName as ToolName] ?? "other";
}

// ─── groupMessages ───────────────────────────────────────────────────────────

function toolCountSummary(tools: ToolMessage[]): string {
	const counts = new Map<string, number>();
	for (const t of tools) {
		const lower = t.name.toLowerCase();
		counts.set(lower, (counts.get(lower) ?? 0) + 1);
	}

	const parts: string[] = [];
	for (const [name, count] of counts) {
		const label = count === 1 ? name : `${name}s`;
		parts.push(`${count} ${label}`);
	}
	return parts.join(", ");
}

function aggregateStatus(tools: ToolMessage[]): ToolStatus {
	const hasRunning = tools.some(
		(t) => t.status === "running" || t.status === "pending",
	);
	if (hasRunning) return "running";

	const hasError = tools.some((t) => t.status === "error");
	if (hasError) return "error";

	return "completed";
}

function buildToolGroup(tools: ToolMessage[]): ToolGroup {
	// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
	const first = tools[0]!;
	const category = getToolCategory(first.name);
	return {
		type: "tool-group",
		uuid: `group-${first.uuid}`,
		category,
		label: CATEGORY_LABELS[category],
		summary: toolCountSummary(tools),
		tools,
		status: aggregateStatus(tools),
	};
}

export function groupMessages(messages: ChatMessage[]): GroupedMessage[] {
	const result: GroupedMessage[] = [];
	let currentToolBatch: ToolMessage[] = [];
	let currentCategory: ToolCategory | null = null;

	function flushBatch() {
		if (currentToolBatch.length === 0) return;
		if (currentToolBatch.length === 1) {
			// Solo tools stay as ToolMessage — no wrapping
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
			result.push(currentToolBatch[0]!);
		} else {
			result.push(buildToolGroup(currentToolBatch));
		}
		currentToolBatch = [];
		currentCategory = null;
	}

	for (const msg of messages) {
		if (msg.type === "tool") {
			// AskUserQuestion tools must never be grouped — they need
			// ToolItem's interactive QuestionCard, not ToolGroupItem.
			// Task tools must never be grouped — they need ToolItem's
			// subagent card with session navigation, not ToolGroupItem.
			if (
				msg.name === "AskUserQuestion" ||
				msg.name === "Task" ||
				msg.name === "task" ||
				msg.name === "Skill"
			) {
				flushBatch();
				result.push(msg);
				continue;
			}
			const cat = getToolCategory(msg.name);
			if (currentCategory === cat) {
				currentToolBatch.push(msg);
			} else {
				flushBatch();
				currentToolBatch = [msg];
				currentCategory = cat;
			}
		} else {
			flushBatch();
			result.push(msg);
		}
	}

	flushBatch();
	return result;
}
