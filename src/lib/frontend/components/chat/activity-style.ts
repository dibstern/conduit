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
	/** Semantic paint chosen by the timeline primitive. */
	tone: "neutral" | "dim" | "edit" | "fail" | "compaction" | "live";
}

const CATEGORY_STYLE: Record<ToolCategory, PartStyle> = {
	explore: { icon: "search", text: "text-text-muted", tone: "neutral" },
	edit: {
		icon: "pencil",
		text: "text-text-secondary",
		tone: "edit",
	},
	shell: { icon: "terminal", text: "text-text", tone: "neutral" },
	fetch: { icon: "external-link", text: "text-success", tone: "neutral" },
	task: {
		icon: "git-fork",
		text: "text-harness-claude",
		tone: "neutral",
	},
	other: { icon: "settings-2", text: "text-text-muted", tone: "neutral" },
};

const THINKING_STYLE: PartStyle = {
	icon: "brain",
	text: "text-thinking",
	tone: "dim",
};

const TEXT_STYLE: PartStyle = {
	icon: "message-square",
	text: "text-text-secondary",
	tone: "dim",
};

/** Full contrast, so the seam reads as a cut through the strip rather than work. */
const COMPACTION_STYLE: PartStyle = {
	icon: "minimize",
	text: "text-text-muted",
	tone: "compaction",
};

/** Tools whose own icon reads better than their category's. */
const TOOL_ICONS: Record<string, string> = {
	Read: "file-text",
	Write: "file-code",
	Skill: "sparkles",
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
		case "system":
			return COMPACTION_STYLE;
		default:
			return TEXT_STYLE;
	}
}

/**
 * Failures always read as failures, whatever kind of work they were. A step
 * breathes while it runs, and while a background task it launched is live.
 */
export function segmentAppearance(
	part: ActivityPart,
	running: ReadonlySet<string>,
): { tone: PartStyle["tone"]; running: boolean } {
	if (part.type === "tool") {
		if (part.status === "error" || part.isError)
			return { tone: "fail", running: false };
		const taskId = part.metadata?.["providerTaskId"];
		if (
			typeof taskId === "string" && part.metadata?.["backgrounded"] === true
				? running.has(taskId)
				: part.status === "running" || part.status === "pending"
		) {
			return { tone: "live", running: true };
		}
	}
	return { tone: partStyle(part).tone, running: false };
}
