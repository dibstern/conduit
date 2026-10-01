import type { CanonicalToolInput } from "../../persistence/events.js";
import {
	optNum,
	optStr,
	str,
	toRecord,
} from "../normalize-tool-input-helpers.js";

/**
 * Normalize raw Claude SDK tool input into CanonicalToolInput.
 * Claude SDK emits snake_case field names (file_path, old_string, etc.).
 * This function maps them to the canonical camelCase shape.
 */
export function normalizeToolInput(
	name: string,
	rawInput: unknown,
): CanonicalToolInput {
	const input = toRecord(rawInput);

	switch (name) {
		case "Read":
			return {
				tool: "Read",
				filePath: str(input, "file_path", "filePath"),
				...optNum(input, "offset"),
				...optNum(input, "limit"),
			};

		case "Edit":
			return {
				tool: "Edit",
				filePath: str(input, "file_path", "filePath"),
				oldString: str(input, "old_string", "oldString"),
				newString: str(input, "new_string", "newString"),
				...optBool(input, "replace_all", "replaceAll"),
			};

		case "Write":
			return {
				tool: "Write",
				filePath: str(input, "file_path", "filePath"),
				content: str(input, "content"),
			};

		case "Bash":
			return {
				tool: "Bash",
				command: str(input, "command"),
				...optStr(input, "description"),
				...optTimeoutMs(input),
			};

		case "Grep":
			return {
				tool: "Grep",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
				...optField("include", input, "glob", "include"),
				...optField("fileType", input, "type", "fileType"),
			};

		case "Glob":
			return {
				tool: "Glob",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
			};

		case "WebFetch":
			return {
				tool: "WebFetch",
				url: str(input, "url"),
				...optStr(input, "prompt"),
			};

		case "WebSearch":
			return {
				tool: "WebSearch",
				query: str(input, "query"),
			};

		case "Task":
		case "Agent":
			return {
				tool: "Task",
				description: str(input, "description"),
				prompt: str(input, "prompt"),
				...optField("subagentType", input, "subagent_type", "subagentType"),
			};

		case "LSP":
			return {
				tool: "LSP",
				operation: str(input, "operation"),
				...optField("filePath", input, "file_path", "filePath"),
			};

		case "Skill":
			// Claude SDK Skill input is { skill: string, args?: string }
			return {
				tool: "Skill",
				name: str(input, "skill", "name"),
			};

		case "AskUserQuestion":
			return {
				tool: "AskUserQuestion",
				questions: input["questions"] ?? null,
			};

		default:
			return { tool: "Unknown", name, raw: input };
	}
}

/** Optional boolean field — only included if defined. */
function optBool(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, boolean> {
	for (const k of keys) {
		const value = input[k];
		if (typeof value === "boolean") {
			const canonicalKey = keys[keys.length - 1] ?? k;
			return { [canonicalKey]: value };
		}
	}
	return {};
}

/** Optional field with a canonical output key, reading from multiple input aliases. */
function optField(
	canonicalKey: string,
	input: Record<string, unknown>,
	...inputKeys: string[]
): Record<string, unknown> {
	for (const k of inputKeys) {
		const value = input[k];
		if (value !== undefined && value !== null && value !== "")
			return { [canonicalKey]: value };
	}
	return {};
}

/** Map Claude's `timeout` (number) to canonical `timeoutMs`. */
function optTimeoutMs(
	input: Record<string, unknown>,
): { timeoutMs: number } | Record<string, never> {
	const value = input["timeout"] ?? input["timeout_ms"] ?? input["timeoutMs"];
	if (typeof value === "number") return { timeoutMs: value };
	return {};
}
