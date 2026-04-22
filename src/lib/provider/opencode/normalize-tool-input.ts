import type { CanonicalToolInput } from "../../persistence/events.js";

/**
 * Normalize raw OpenCode tool input into CanonicalToolInput.
 * OpenCode emits camelCase field names — mostly passthrough.
 * Special case: WebSearch may carry `url` instead of `query`.
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
				filePath: str(input, "filePath"),
				...optNum(input, "offset"),
				...optNum(input, "limit"),
			};

		case "Edit":
			return {
				tool: "Edit",
				filePath: str(input, "filePath"),
				oldString: str(input, "oldString"),
				newString: str(input, "newString"),
				...optBool(input, "replaceAll"),
			};

		case "Write":
			return {
				tool: "Write",
				filePath: str(input, "filePath"),
				content: str(input, "content"),
			};

		case "Bash":
			return {
				tool: "Bash",
				command: str(input, "command"),
				...optStr(input, "description"),
				...optNum(input, "timeoutMs"),
			};

		case "Grep":
			return {
				tool: "Grep",
				pattern: str(input, "pattern"),
				...optStr(input, "path"),
				...optStr(input, "include"),
				...optStr(input, "fileType"),
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

		case "WebSearch": {
			// OpenCode may pass `url` instead of `query` — extract hostname as query fallback
			const query = str(input, "query");
			if (query) return { tool: "WebSearch", query };
			const url = str(input, "url");
			if (url) {
				const hostname = extractHostname(url);
				return { tool: "WebSearch", query: hostname ?? url };
			}
			return { tool: "WebSearch", query: "" };
		}

		case "Task":
			return {
				tool: "Task",
				description: str(input, "description"),
				prompt: str(input, "prompt"),
				...optStr(input, "subagentType"),
			};

		case "LSP":
			return {
				tool: "LSP",
				operation: str(input, "operation"),
				...optStr(input, "filePath"),
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

function str(input: Record<string, unknown>, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

function optStr(
	input: Record<string, unknown>,
	key: string,
): Record<string, string> {
	const v = input[key];
	if (typeof v === "string" && v.length > 0) return { [key]: v };
	return {};
}

function optNum(
	input: Record<string, unknown>,
	key: string,
): Record<string, number> {
	const v = input[key];
	if (typeof v === "number") return { [key]: v };
	return {};
}

function optBool(
	input: Record<string, unknown>,
	key: string,
): Record<string, boolean> {
	const v = input[key];
	if (typeof v === "boolean") return { [key]: v };
	return {};
}

function extractHostname(url: string): string | undefined {
	try {
		return new URL(url).hostname;
	} catch {
		return undefined;
	}
}
