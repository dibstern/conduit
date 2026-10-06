// Pure functions with no DOM or framework dependencies.
// Extracted for unit testing without a browser environment.

import {
	endsOpenCodeTurn,
	mapToolName,
	openCodeTurnTotals,
} from "../../relay/event-translator.js";
import type {
	AssistantMessage,
	ChatMessage,
	HistoryMessage,
	HistoryMessagePart,
	ResultMessage,
	SystemMessage,
	ThinkingMessage,
	ToolMessage,
	Turn,
	UserMessage,
} from "../types.js";
import { extractDisplayText, generateUuid } from "./format.js";
import { SUBAGENT_TOOL_NAMES } from "./subagent-tools.js";
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
		const msg = messages[i];
		if (msg === undefined) break;

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
	const boundaryMsg = messages[targetCount - 1];
	if (boundaryMsg === undefined) return targetCount;

	// If the boundary message is a user message and the next message is
	// an assistant response, extend to include the assistant too
	if (
		boundaryMsg.role === "user" &&
		targetCount < messages.length &&
		messages[targetCount]?.role === "assistant"
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

/** Tool names that should preserve their live status in history.
 *  Question tools may still be awaiting a user response even when loaded
 *  from the REST API, so we must not force them to "completed".
 *  Subagent (Task/Agent) tools may still be running — forcing them to
 *  "completed" would show "Done" while the subagent session is still active. */
const LIVE_STATUS_TOOLS = new Set([
	"question",
	"AskUserQuestion",
	...SUBAGENT_TOOL_NAMES,
]);

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
	metadata?: Record<string, unknown>,
): ToolMessage["status"] {
	if (apiStatus === "error") return "error";
	if (metadata?.["status"] === "completed") return "completed";
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
 *   - "text"                    → AssistantMessage
 *   - "reasoning" | "thinking"  → ThinkingMessage
 *   - "tool"                    → ToolMessage
 *   - Others (step_start, step_finish, snapshot, agent) → skipped
 *
 * @param renderHtml Optional function to render markdown to HTML.
 *   If not provided, html is set to rawText (no markdown rendering).
 */
function convertAssistantParts(
	parts: HistoryMessagePart[],
	renderHtml?: (text: string) => string,
	messageId?: string,
	createdAt?: number,
	uuidFor?: (messageId: string, partId: string) => string,
	completed = true,
): ChatMessage[] {
	const result: ChatMessage[] = [];
	// One fork point per message, on the text the transcript shows as the reply.
	const replyPart = parts.filter((p) => p.type === "text" && p.text).at(-1);

	for (const [index, part] of parts.entries()) {
		const uuid =
			messageId && uuidFor ? uuidFor(messageId, part.id) : generateUuid();
		const settled = completed || index < parts.length - 1;
		// A turn's parts all live under one message, so the message stamp would
		// make every step 0ms. Use the part's own stamp when the store has one.
		const partCreatedAt = part.time?.start ?? createdAt;
		const partEndedAt = part.time?.end;
		switch (part.type) {
			case "text": {
				const rawText = part.text ?? "";
				if (!rawText) break;
				// Prefer server-pre-rendered HTML; fall back to client-side rendering
				const html =
					part.renderedHtml ?? (renderHtml ? renderHtml(rawText) : rawText);
				result.push({
					type: "assistant",
					uuid,
					rawText,
					html,
					finalized: settled,
					partId: part.id,
					...(messageId != null && part === replyPart && { messageId }),
					...(partCreatedAt != null && { createdAt: partCreatedAt }),
					...(partEndedAt != null && { endedAt: partEndedAt }),
				} satisfies AssistantMessage);
				break;
			}
			case "thinking":
			case "reasoning": {
				const text = part.text ?? "";
				const time = part.time;
				const duration =
					time?.start !== undefined && time?.end !== undefined
						? time.end - time.start
						: undefined;
				result.push({
					type: "thinking",
					uuid,
					text,
					done: settled && part.state?.status !== "running",
					...(duration != null && { duration }),
					...(partCreatedAt != null && { createdAt: partCreatedAt }),
					...(partEndedAt != null && { endedAt: partEndedAt }),
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
						uuid,
						id: part.callID ?? part.id,
						name: mapToolName(rawToolName),
						status: mapToolStatus(state?.status, rawToolName, toolMetadata),
						...(toolResult != null && { result: toolResult }),
						...(state?.isTruncated === true && {
							isTruncated: true,
							...(state.fullContentLength != null && {
								fullContentLength: state.fullContentLength,
							}),
						}),
						isError,
						...(toolInput !== undefined && { input: toolInput }),
						...(toolMetadata !== undefined && { metadata: toolMetadata }),
						...(partCreatedAt != null && { createdAt: partCreatedAt }),
						...(partEndedAt != null && { endedAt: partEndedAt }),
					}),
				);
				break;
			}
			case "compaction": {
				// Persisted `/compact` outcome. A completed one is the "Context
				// compacted" divider; postTokens lets restoreContextFromMessages
				// recover the reduced context bar. A failed one stays a notice.
				result.push({
					type: "system",
					uuid,
					text: part.text ?? "",
					variant: part.failed ? "error" : "info",
					compaction: part.failed ? "failed" : "completed",
					...(typeof part.preTokens === "number" && part.preTokens > 0
						? { preTokens: part.preTokens }
						: {}),
					...(typeof part.postTokens === "number" && part.postTokens > 0
						? { postTokens: part.postTokens }
						: {}),
					...(partCreatedAt != null && { createdAt: partCreatedAt }),
				} satisfies SystemMessage);
				break;
			}
			case "error":
				// A turn that ended in error: the notice the live error event shows.
				result.push({
					type: "system",
					uuid,
					text: part.text ?? "",
					variant: "error",
					...(part.code !== undefined && { errorCode: part.code }),
					...(partCreatedAt != null && { createdAt: partCreatedAt }),
				} satisfies SystemMessage);
				break;
			default:
				// Intentionally skipped structural part types:
				// step_start, step_finish, snapshot, agent
				// If you add a new PartType that should produce a ChatMessage,
				// add a case above — don't let it fall through to here.
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
	turnContext: readonly HistoryMessage[] = messages,
	uuidFor?: (messageId: string, partId: string) => string,
): ChatMessage[] {
	return messages.flatMap((msg) => {
		const result: ChatMessage[] = [];
		if (msg.role === "user") {
			// User messages: extract text from parts
			const text =
				msg.parts
					?.filter((p) => p.type === "text")
					.map((p) => p.text ?? "")
					.join("\n") ?? "";
			result.push({
				type: "user",
				uuid: uuidFor ? uuidFor(msg.id, "user") : generateUuid(),
				messageId: msg.id,
				text: extractDisplayText(text),
				...(msg.time?.created != null && { createdAt: msg.time.created }),
				...(msg.modelExecution != null
					? { modelExecution: msg.modelExecution }
					: {}),
				...(msg.turnTiming != null ? { turnTiming: msg.turnTiming } : {}),
			} satisfies UserMessage);
		} else if (msg.role === "assistant") {
			// Assistant messages: convert each part to the appropriate ChatMessage
			if (msg.parts && msg.parts.length > 0) {
				result.push(
					...convertAssistantParts(
						msg.parts,
						renderHtml,
						msg.id,
						msg.time?.created,
						uuidFor,
						!uuidFor || msg.time?.completed !== undefined,
					),
				);
			}

			// Append a ResultMessage once a step with cost/token metadata has
			// completed. An OpenCode turn is one assistant message per step; only
			// the step that ends the turn gets a result, billed for every step.
			const hasCost = msg.cost !== undefined && msg.cost > 0;
			const hasTokens =
				msg.tokens?.input !== undefined ||
				msg.tokens?.output !== undefined ||
				msg.tokens?.context_window !== undefined;

			if (
				(hasCost || hasTokens) &&
				msg.time?.completed !== undefined &&
				endsOpenCodeTurn(msg)
			) {
				const turnSteps =
					msg.parentID === undefined
						? [msg]
						: turnContext.filter(
								(m) => m.role === "assistant" && m.parentID === msg.parentID,
							);
				const { cost, duration } = openCodeTurnTotals(msg, turnSteps);
				result.push({
					type: "result",
					uuid: uuidFor ? uuidFor(msg.id, "result") : generateUuid(),
					...(msg.cost != null && { cost }),
					duration,
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
					...(msg.tokens?.context_window != null && {
						context_window: msg.tokens.context_window,
					}),
					// The bill lands when the turn finishes. Stamping it with the
					// message's start would put it before the turn's own last step.
					createdAt: msg.time.completed,
				} satisfies ResultMessage);
			}
		}
		const createdAt = msg.time?.created;
		return createdAt === undefined
			? result
			: result.map((part) => ({
					...part,
					messageOrder: { createdAt, id: msg.id },
				}));
	});
}

// History Queued Flag (REMOVED)
// `applyHistoryQueuedFlag` was removed: it wrote the old mutable `queued`
// boolean which no longer exists on UserMessage (replaced by the immutable
// `sentDuringEpoch` + derived-state pattern). The queued visual is now
// handled entirely by addUserMessage (write-once sentDuringEpoch) and the
// $derived check in UserMessage.svelte.
