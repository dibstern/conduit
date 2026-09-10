// ─── Activity Style ───────────────────────────────────────────────────────────
// Icon and colour per activity part. Drives both the strip segments and the
// rows in the expanded log, so a colour always means the same kind of work.

import type { ToolMessage } from "../../types.js";
import { isSubagentToolName } from "../../utils/subagent-tools.js";
import {
	getToolCategory,
	type ToolCategory,
} from "../../utils/tool-category.js";
import type { ActivityPart } from "../../utils/turns.js";

export interface PartStyle {
	icon: string;
	/** Foreground class, for the row icon. */
	text: string;
	/** Background class, for the strip segment. */
	bg: string;
}

const CATEGORY_STYLE: Record<ToolCategory, PartStyle> = {
	explore: { icon: "search", text: "text-brand-b", bg: "bg-brand-b" },
	edit: { icon: "pencil", text: "text-brand-a", bg: "bg-brand-a" },
	shell: { icon: "terminal", text: "text-text", bg: "bg-text-secondary" },
	fetch: { icon: "external-link", text: "text-success", bg: "bg-success" },
	task: {
		icon: "git-fork",
		text: "text-harness-claude",
		bg: "bg-harness-claude",
	},
	other: { icon: "settings-2", text: "text-text-muted", bg: "bg-text-muted" },
};

const THINKING_STYLE: PartStyle = {
	icon: "sparkles",
	text: "text-thinking",
	bg: "bg-thinking",
};

const TEXT_STYLE: PartStyle = {
	icon: "message-square",
	text: "text-text-secondary",
	bg: "bg-text-dimmer",
};

/** Tools whose own icon reads better than their category's. */
const TOOL_ICONS: Record<string, string> = {
	Read: "file-text",
	Write: "file-code",
	Skill: "zap",
};

export function toolStyle(tool: ToolMessage): PartStyle {
	const base =
		CATEGORY_STYLE[
			isSubagentToolName(tool.name) ? "task" : getToolCategory(tool.name)
		];
	const icon = TOOL_ICONS[tool.name];
	return icon ? { ...base, icon } : base;
}

export function partStyle(part: ActivityPart): PartStyle {
	switch (part.type) {
		case "tool":
			return toolStyle(part);
		case "thinking":
			return THINKING_STYLE;
		default:
			return TEXT_STYLE;
	}
}

/** Failures always read as failures, whatever kind of work they were. */
export function segmentClass(part: ActivityPart): string {
	if (part.type === "tool") {
		if (part.status === "error" || part.isError) return "bg-error";
		if (part.status === "running" || part.status === "pending") {
			return `${toolStyle(part).bg} animate-pulse`;
		}
	}
	return partStyle(part).bg;
}
