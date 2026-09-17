// ─── Tool Category ────────────────────────────────────────────────────────────
// What kind of work a tool does. Drives the colour of each activity strip
// segment and the icon on its row, so a colour always means the same thing.

import type { ToolName } from "../../shared-types.js";

export type ToolCategory =
	| "explore"
	| "edit"
	| "shell"
	| "fetch"
	| "task"
	| "other";

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

export function getToolCategory(toolName: string): ToolCategory {
	return TOOL_CATEGORIES[toolName as ToolName] ?? "other";
}
