// ─── Group Tools — Utility Functions ──────────────────────────────────────────
// Groups consecutive same-category tool messages and extracts display summaries.

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

// ─── extractToolSummary ──────────────────────────────────────────────────────

function stripRepoRoot(filePath: string, repoRoot?: string): string {
	if (!repoRoot) return filePath;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	if (filePath.startsWith(prefix)) {
		return filePath.slice(prefix.length);
	}
	return filePath;
}

function extractHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}

/**
 * Reads the first defined string value from `input` matching one of `keys`.
 *
 * Motivation: OpenCode emits tool inputs in camelCase (`filePath`) while the
 * Claude Agent SDK emits snake_case (`file_path`). To render both providers,
 * we look up each canonical field under all known aliases.
 */
function readStr(
	input: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function extractToolSummary(
	name: string,
	input?: Record<string, unknown>,
	repoRoot?: string,
): { subtitle?: string; tags?: string[] } {
	if (!input) return {};

	switch (name) {
		case "Read": {
			const filePath = readStr(input, "filePath", "file_path");
			const tags: string[] = [];
			if (input["offset"] != null) tags.push(`offset:${input["offset"]}`);
			if (input["limit"] != null) tags.push(`limit:${input["limit"]}`);
			return {
				...(filePath != null && {
					subtitle: stripRepoRoot(filePath, repoRoot),
				}),
				...(tags.length > 0 ? { tags } : {}),
			};
		}

		case "Edit":
		case "Write": {
			const filePath = readStr(input, "filePath", "file_path");
			return {
				...(filePath != null && {
					subtitle: stripRepoRoot(filePath, repoRoot),
				}),
			};
		}

		case "Bash": {
			// Prefer the actual command so users see what ran; fall back to the
			// model-supplied description when the command is not yet streamed.
			const command = readStr(input, "command");
			if (command) {
				const subtitle =
					command.length > 40 ? `${command.slice(0, 40)}…` : command;
				return { subtitle };
			}
			const description = readStr(input, "description");
			return description ? { subtitle: description } : {};
		}

		case "Grep": {
			const pattern = readStr(input, "pattern");
			const tags: string[] = [];
			// `include` is OpenCode; `glob`/`type` are Claude SDK glob/type filters.
			const include = readStr(input, "include", "glob");
			if (include) tags.push(include);
			const fileType = readStr(input, "type");
			if (fileType) tags.push(fileType);
			const searchPath = readStr(input, "path");
			if (searchPath) tags.push(stripRepoRoot(searchPath, repoRoot));
			return {
				...(pattern != null && { subtitle: pattern }),
				...(tags.length > 0 ? { tags } : {}),
			};
		}

		case "Glob": {
			const pattern = readStr(input, "pattern");
			const tags: string[] = [];
			const searchPath = readStr(input, "path");
			if (searchPath) tags.push(stripRepoRoot(searchPath, repoRoot));
			return {
				...(pattern != null && { subtitle: pattern }),
				...(tags.length > 0 ? { tags } : {}),
			};
		}

		case "WebFetch": {
			const url = readStr(input, "url");
			const hostname = url ? extractHostname(url) : undefined;
			return { ...(hostname != null && { subtitle: hostname }) };
		}

		case "WebSearch": {
			// OpenCode passes a `url`; Claude SDK passes a `query` string.
			const url = readStr(input, "url");
			if (url) {
				const hostname = extractHostname(url);
				if (hostname) return { subtitle: hostname };
			}
			const query = readStr(input, "query");
			return query ? { subtitle: query } : {};
		}

		case "Task": {
			const description = readStr(input, "description");
			const subagentType = readStr(input, "subagent_type", "subagentType");
			return {
				...(description != null && { subtitle: description }),
				...(subagentType ? { tags: [subagentType] } : {}),
			};
		}

		case "LSP": {
			const operation = readStr(input, "operation");
			const filePath = readStr(input, "filePath", "file_path");
			const tags: string[] = [];
			if (filePath) tags.push(stripRepoRoot(filePath, repoRoot));
			return {
				...(operation != null && { subtitle: operation }),
				...(tags.length > 0 ? { tags } : {}),
			};
		}

		case "AskUserQuestion": {
			const questions = input["questions"] as
				| { header?: string; question?: string }[]
				| undefined;
			if (Array.isArray(questions) && questions.length > 0) {
				const first = questions[0];
				const subtitle = first?.header || first?.question;
				return {
					subtitle: subtitle
						? subtitle.length > 60
							? `${subtitle.slice(0, 60)}…`
							: subtitle
						: "Question",
				};
			}
			return { subtitle: "Question" };
		}

		case "Skill": {
			const skillName = input["name"] as string | undefined;
			return {
				...(skillName != null && { subtitle: skillName }),
			};
		}

		default:
			return {};
	}
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
