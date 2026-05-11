import type { HistoryMessage } from "../types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (value === null || typeof value !== "object") return undefined;
	return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function partType(part: Record<string, unknown>): string {
	return stringValue(part["type"]) ?? "unknown";
}

function partId(part: Record<string, unknown>): string | undefined {
	return (
		stringValue(part["id"]) ??
		stringValue(part["callID"]) ??
		stringValue(part["call_id"]) ??
		stringValue(part["tool_use_id"])
	);
}

function toolName(part: Record<string, unknown>): string {
	return (
		stringValue(part["name"]) ??
		stringValue(part["tool"]) ??
		stringValue(part["toolName"]) ??
		"tool"
	);
}

function toolInput(part: Record<string, unknown>): unknown {
	const state = asRecord(part["state"]);
	return part["input"] ?? state?.["input"] ?? {};
}

function toolOutput(part: Record<string, unknown>): string {
	const state = asRecord(part["state"]);
	return (
		stringValue(part["content"]) ??
		stringValue(part["text"]) ??
		stringValue(part["result"]) ??
		stringValue(part["output"]) ??
		stringValue(state?.["output"]) ??
		jsonValue(part)
	);
}

function isToolCall(part: Record<string, unknown>): boolean {
	const type = partType(part);
	return (
		type === "tool_use" ||
		type === "server_tool_use" ||
		type === "mcp_tool_use" ||
		type === "tool_call" ||
		type === "tool"
	);
}

function isToolResult(part: Record<string, unknown>): boolean {
	const type = partType(part);
	return type === "tool_result" || type === "tool-output";
}

function messageText(message: HistoryMessage): string {
	const direct = stringValue(message.content) ?? stringValue(message.text);
	if (direct) return direct;

	const textParts =
		message.parts
			?.map(asRecord)
			.filter((part): part is Record<string, unknown> => part !== undefined)
			.filter((part) => partType(part) === "text")
			.map((part) => stringValue(part["text"]) ?? "")
			.filter((text) => text.length > 0) ?? [];

	return textParts.join("\n\n");
}

function serializePart(part: Record<string, unknown>): string | undefined {
	const type = partType(part);
	if (type === "text") return undefined;

	if (isToolCall(part)) {
		const id = partId(part);
		const label = id
			? `[tool-call:${toolName(part)} id=${id}]`
			: `[tool-call:${toolName(part)}]`;
		return `${label}\n${jsonValue(toolInput(part))}`;
	}

	if (isToolResult(part)) {
		const id = partId(part);
		const label = id ? `[tool-result id=${id}]` : "[tool-result]";
		return `${label}\n${toolOutput(part)}`;
	}

	return `[part:${type}]\n${jsonValue(part)}`;
}

export function serializePriorConversation(
	history: readonly HistoryMessage[],
): string {
	if (history.length === 0) return "";

	const lines: string[] = [
		"<prior-conversation-transcript>",
		"The following is the conversation history before you took over this session. Use it as context for your next response.",
	];

	for (const message of history) {
		lines.push("", `[${message.role}]`);
		const text = messageText(message);
		if (text.length > 0) lines.push(text);

		for (const rawPart of message.parts ?? []) {
			const part = asRecord(rawPart);
			if (!part) continue;
			const serialized = serializePart(part);
			if (serialized) lines.push("", serialized);
		}
	}

	lines.push("", "</prior-conversation-transcript>");
	return lines.join("\n");
}
