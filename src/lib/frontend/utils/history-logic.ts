// ─── History Pure Logic ──────────────────────────────────────────────────────
// Pure functions with no DOM or framework dependencies.
// Extracted for unit testing without a browser environment.

import { mapToolName } from "../../relay/event-translator.js";
import type {
	AssistantMessage,
	ChatMessage,
	HistoryMessage,
	HistoryMessagePart,
	ResultMessage,
	ThinkingMessage,
	ToolMessage,
	Turn,
	UserMessage,
} from "../types.js";
import { extractDisplayText, generateUuid } from "./format.js";
import { createToolMessage } from "./tool-message-factory.js";

// Re-export types for convenience
export type { HistoryMessage, Turn };

/**
 * Group a flat list of messages into user+assistant turn pairs.
 * Messages are expected in chronological order (oldest first).
 * Each turn starts with a user message. An assistant message following
 * a user message is grouped into the same turn. Orphan assistant messages
 * (without a preceding user message) form their own turn.
 */
export function groupIntoTurns(messages: HistoryMessage[]): Turn[] {
	const turns: Turn[] = [];
	let i = 0;

	while (i < messages.length) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const msg = messages[i]!;

		if (msg.role === "user") {
			const turn: Turn = { user: msg };
			// Check if next message is the assistant response
			const next = messages[i + 1];
			if (i + 1 < messages.length && next && next.role === "assistant") {
				turn.assistant = next;
				i += 2;
			} else {
				i += 1;
			}
			turns.push(turn);
		} else {
			// Orphan assistant message (no preceding user message)
			turns.push({ assistant: msg });
			i += 1;
		}
	}

	return turns;
}

/**
 * Find a clean page boundary that doesn't split user+assistant turns.
 * Given messages in chronological order and a target count, returns the
 * actual number of messages to include (may be more than targetCount to
 * avoid splitting a turn).
 */
export function findPageBoundary(
	messages: HistoryMessage[],
	targetCount: number,
): number {
	if (targetCount >= messages.length) return messages.length;
	if (targetCount <= 0) return 0;

	// Look at the message at the boundary
	// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
	const boundaryMsg = messages[targetCount - 1]!;

	// If the boundary message is a user message and the next message is
	// an assistant response, extend to include the assistant too
	if (
		boundaryMsg.role === "user" &&
		targetCount < messages.length &&
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		messages[targetCount]!.role === "assistant"
	) {
		return targetCount + 1;
	}

	return targetCount;
}

/**
 * Extract the visible text from an assistant message's parts.
 * OpenCode messages have multiple part types: step_start, reasoning, text,
 * tool, step_finish, agent, snapshot, etc. Only "text" type parts contain
 * the actual response text visible to users. Concatenates all text parts
 * (there may be multiple, separated by tool calls).
 */
export function getAssistantText(msg: HistoryMessage | undefined): string {
	if (!msg?.parts) return "";
	return msg.parts
		.filter((p) => p.type === "text")
		.map((p) => p.text ?? "")
		.join("\n\n");
}

// shouldLoadMore() and getOldestMessageId() were removed — dead code after
// the unified rendering migration. HistoryLoader.svelte inlines the guard
// logic and ws-dispatch tracks messageCount for the pagination offset.

// ─── History → ChatMessage Conversion ───────────────────────────────────────

/** Tool names that should preserve their live status in history.
 *  Question tools may still be awaiting a user response even when loaded
 *  from the REST API, so we must not force them to "completed". */
const LIVE_STATUS_TOOLS = new Set(["question", "AskUserQuestion"]);

/**
 * Map a tool status from the REST API to the ToolMessage status used in live rendering.
 * In history, "pending" and "running" tools are treated as "completed" since the
 * session is no longer active — EXCEPT for question tools, which may still be
 * awaiting a user response and should preserve their actual status so the UI
 * can render an interactive QuestionCard instead of "Answered ✓".
 */
function mapToolStatus(
	apiStatus: string | undefined,
	toolName?: string,
): ToolMessage["status"] {
	if (apiStatus === "error") return "error";
	// Question tools preserve their live status so the UI can render them interactively
	if (toolName && LIVE_STATUS_TOOLS.has(toolName)) {
		if (apiStatus === "pending") return "pending";
		if (apiStatus === "running") return "running";
	}
	return "completed";
}

/**
 * Convert a single assistant message's parts into ChatMessage[].
 * Each part type maps to the corresponding ChatMessage variant:
 *   - "text"      → AssistantMessage
 *   - "reasoning" → ThinkingMessage
 *   - "tool"      → ToolMessage
 *   - Others (step_start, step_finish, snapshot, agent) → skipped
 *
 * @param renderHtml Optional function to render markdown to HTML.
 *   If not provided, html is set to rawText (no markdown rendering).
 */
function convertAssistantParts(
	parts: HistoryMessagePart[],
	renderHtml?: (text: string) => string,
	messageId?: string,
): ChatMessage[] {
	const result: ChatMessage[] = [];
	let firstTextSeen = false;

	for (const part of parts) {
		switch (part.type) {
			case "text": {
				const rawText = part.text ?? "";
				if (!rawText) break;
				// Prefer server-pre-rendered HTML; fall back to client-side rendering
				const html =
					part.renderedHtml ?? (renderHtml ? renderHtml(rawText) : rawText);
				result.push({
					type: "assistant",
					uuid: generateUuid(),
					rawText,
					html,
					finalized: true,
					...(messageId != null && !firstTextSeen && { messageId }),
				} satisfies AssistantMessage);
				firstTextSeen = true;
				break;
			}
			case "reasoning": {
				const text = part.text ?? "";
				const time = part.time as { start?: number; end?: number } | undefined;
				const duration =
					time?.start !== undefined && time?.end !== undefined
						? time.end - time.start
						: undefined;
				result.push({
					type: "thinking",
					uuid: generateUuid(),
					text,
					done: true,
					...(duration != null && { duration }),
				} satisfies ThinkingMessage);
				break;
			}
			case "tool": {
				const state = part.state;
				const isError = state?.status === "error";
				const toolInput =
					state?.input != null &&
					typeof state.input === "object" &&
					!Array.isArray(state.input)
						? (state.input as Record<string, unknown>)
						: undefined;
				const rawToolName = part.tool ?? "unknown";
				const toolResult = isError
					? (state?.error ?? "Unknown error")
					: (state?.output ?? undefined);
				const toolMetadata =
					state != null &&
					typeof state === "object" &&
					"metadata" in state &&
					state["metadata"] != null &&
					typeof state["metadata"] === "object"
						? (state["metadata"] as Record<string, unknown>)
						: undefined;
				result.push(
					createToolMessage({
						uuid: generateUuid(),
						id: part.callID ?? part.id,
						name: mapToolName(rawToolName),
						status: mapToolStatus(state?.status, rawToolName),
						...(toolResult != null && { result: toolResult }),
						isError,
						...(toolInput !== undefined && { input: toolInput }),
						...(toolMetadata !== undefined && { metadata: toolMetadata }),
					}),
				);
				break;
			}
			// Skip structural parts that have no visual representation
			default:
				break;
		}
	}

	return result;
}

/**
 * Convert an array of HistoryMessage[] (from OpenCode REST API) into
 * ChatMessage[] suitable for rendering with the same components used
 * for live streaming messages.
 *
 * This provides visual parity between live and historical message rendering.
 *
 * @param messages  Flat array of HistoryMessage in chronological order.
 * @param renderHtml  Optional markdown→HTML renderer. If not provided,
 *   assistant message html is set to the raw text (no markdown rendering).
 */
export function historyToChatMessages(
	messages: HistoryMessage[],
	renderHtml?: (text: string) => string,
): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			// User messages: extract text from parts
			const text =
				msg.parts
					?.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("\n") ?? "";
			result.push({
				type: "user",
				uuid: generateUuid(),
				text: extractDisplayText(text),
			} satisfies UserMessage);
		} else if (msg.role === "assistant") {
			// Assistant messages: convert each part to the appropriate ChatMessage
			if (msg.parts && msg.parts.length > 0) {
				result.push(...convertAssistantParts(msg.parts, renderHtml, msg.id));
			}

			// Append a ResultMessage if cost/token metadata is present
			const hasCost = msg.cost !== undefined && msg.cost > 0;
			const hasTokens =
				msg.tokens?.input !== undefined || msg.tokens?.output !== undefined;
			const hasDuration =
				msg.time?.created !== undefined && msg.time?.completed !== undefined;

			if (hasCost || hasTokens) {
				const duration = hasDuration
					? // biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior null check
						msg.time!.completed! - msg.time!.created!
					: undefined;
				result.push({
					type: "result",
					uuid: generateUuid(),
					...(msg.cost != null && { cost: msg.cost }),
					...(duration != null && { duration }),
					...(msg.tokens?.input != null && { inputTokens: msg.tokens.input }),
					...(msg.tokens?.output != null && {
						outputTokens: msg.tokens.output,
					}),
					...(msg.tokens?.cache?.read != null && {
						cacheRead: msg.tokens.cache.read,
					}),
					...(msg.tokens?.cache?.write != null && {
						cacheWrite: msg.tokens.cache.write,
					}),
				} satisfies ResultMessage);
			}
		}
	}

	return result;
}

// ─── History Queued Flag ────────────────────────────────────────────────────

/**
 * Mark the last unresponded user message as queued when the session is
 * processing and queued flags haven't been cleared yet.
 *
 * No longer used in production after the unified rendering migration.
 * `applyQueuedFlagInPlace` in `chat.svelte.ts` replaced it.
 * Kept as utility/reference along with its tests.
 *
 * Returns the same array reference when no modification is needed.
 */
export function applyHistoryQueuedFlag(
	messages: ChatMessage[],
	processing: boolean,
	queuedFlagsCleared: boolean,
): ChatMessage[] {
	if (!processing || queuedFlagsCleared || messages.length === 0) {
		return messages;
	}

	// Walk backward to find the last user message
	for (let i = messages.length - 1; i >= 0; i--) {
		// biome-ignore lint/style/noNonNullAssertion: safe — loop bounded by array length
		const m = messages[i]!;
		if (m.type === "user") {
			// Check if there's an assistant response after it
			const hasResponse = messages
				.slice(i + 1)
				.some((msg) => msg.type === "assistant");
			if (hasResponse) return messages;
			// No response — mark as queued (immutable update)
			return messages.map((msg, idx) =>
				idx === i ? { ...msg, queued: true } : msg,
			);
		}
	}

	return messages;
}
