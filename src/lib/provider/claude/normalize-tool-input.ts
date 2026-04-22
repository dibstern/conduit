import type { CanonicalToolInput } from "../../persistence/events.js";

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
			return {
				tool: "Skill",
				name: str(input, "name"),
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function toRecord(v: unknown): Record<string, unknown> {
	if (v && typeof v === "object" && !Array.isArray(v)) {
		return v as Record<string, unknown>;
	}
	return {};
}

/** Read the first defined string value from multiple key aliases. */
function str(input: Record<string, unknown>, ...keys: string[]): string {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string") return v;
	}
	return "";
}

/** Optional string field — only included if defined. */
function optStr(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, string> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "string" && v.length > 0) return { [k]: v };
	}
	return {};
}

/** Optional number field — only included if defined. */
function optNum(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, number> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "number") return { [k]: v };
	}
	return {};
}

/** Optional boolean field — only included if defined. */
function optBool(
	input: Record<string, unknown>,
	...keys: string[]
): Record<string, boolean> {
	for (const k of keys) {
		const v = input[k];
		if (typeof v === "boolean") {
			const canonicalKey = keys[keys.length - 1] ?? k;
			return { [canonicalKey]: v };
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
		const v = input[k];
		if (v !== undefined && v !== null && v !== "") return { [canonicalKey]: v };
	}
	return {};
}

/** Map Claude's `timeout` (number) to canonical `timeoutMs`. */
function optTimeoutMs(
	input: Record<string, unknown>,
): { timeoutMs: number } | Record<string, never> {
	const v = input["timeout"] ?? input["timeout_ms"] ?? input["timeoutMs"];
	if (typeof v === "number") return { timeoutMs: v };
	return {};
}
