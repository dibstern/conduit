// src/lib/provider/claude/claude-event-translator.ts
/**
 * ClaudeEventTranslator maps Claude Agent SDK messages (SDKMessage) onto
 * conduit's canonical event types and pushes them through EventSink.
 *
 * The translator is stateless with respect to its own instance -- all
 * mutable state (in-flight tools, resume cursor, turn counters) lives on
 * the ClaudeSessionContext passed in. This keeps a single translator
 * usable across many concurrent sessions.
 *
 * Event type mappings use EXISTING canonical types only:
 *   text.delta (text) or thinking.delta (thinking)
 *   tool.started (tool_use, text, thinking block starts)
 *   tool.running (input_json_delta on fingerprint change)
 *   tool.completed (block stop, tool result)
 *   turn.error (SDK errors)
 *   session.status (system init, status updates)
 *   turn.completed (result, task_progress)
 *
 * All payloads match the EventPayloadMap interfaces from Phase 1 Task 4.
 */
import { randomUUID } from "node:crypto";
import type {
	CanonicalEvent,
	CanonicalEventType,
	EventMetadata,
	EventPayloadMap,
} from "../../persistence/events.js";
import { canonicalEvent } from "../../persistence/events.js";
import type { EventSink } from "../types.js";
import { normalizeToolInput } from "./normalize-tool-input.js";
import type {
	ClaudeSessionContext,
	SDKAssistantMessage,
	SDKMessage,
	SDKPartialAssistantMessage,
	SDKResultMessage,
	SDKSystemLike,
	SDKUserMessage,
	StreamEvent,
	ToolInFlight,
} from "./types.js";

const PROVIDER = "claude" as const;

// ─── Typed event construction helper ───────────────────────────────────────
// Uses the shared canonicalEvent() factory from persistence/events.ts.
// All events are tagged with provider: "claude" via the PROVIDER constant.

function makeCanonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	metadata?: EventMetadata,
): CanonicalEvent {
	return canonicalEvent(type, sessionId, data, {
		provider: PROVIDER,
		...(metadata && { metadata }),
	});
}

// ─── Tool classification ───────────────────────────────────────────────────

type CanonicalItemType =
	| "assistant_message"
	| "command_execution"
	| "file_change"
	| "file_read"
	| "web_search"
	| "mcp_tool_call"
	| "dynamic_tool_call";

function classifyToolItemType(toolName: string): CanonicalItemType {
	const n = toolName.toLowerCase();
	if (n.includes("bash") || n.includes("shell") || n.includes("command")) {
		return "command_execution";
	}
	if (
		n === "read" ||
		n.includes("grep") ||
		n.includes("glob") ||
		n.includes("search")
	) {
		return "file_read";
	}
	if (
		n.includes("edit") ||
		n.includes("write") ||
		n.includes("patch") ||
		n.includes("create") ||
		n.includes("delete")
	) {
		return "file_change";
	}
	if (n.includes("websearch") || n.includes("web_search")) return "web_search";
	if (n.includes("mcp")) return "mcp_tool_call";
	return "dynamic_tool_call";
}

function titleForItemType(t: CanonicalItemType): string {
	switch (t) {
		case "command_execution":
			return "Command run";
		case "file_change":
			return "File change";
		case "file_read":
			return "File read";
		case "web_search":
			return "Web search";
		case "mcp_tool_call":
			return "MCP tool call";
		case "dynamic_tool_call":
			return "Tool call";
		case "assistant_message":
			return "Assistant message";
	}
}

export function isInterruptedResult(result: SDKResultMessage): boolean {
	if (result.subtype === "success") return false;
	const errors = result.errors.join(" ").toLowerCase();
	if (errors.includes("interrupt") || errors.includes("aborted")) return true;
	return (
		result.subtype === "error_during_execution" &&
		!result.is_error &&
		(errors.includes("cancel") || errors.includes("user"))
	);
}

// ─── Translator ────────────────────────────────────────────────────────────

export interface ClaudeEventTranslatorDeps {
	readonly sink: EventSink;
}

export class ClaudeEventTranslator {
	// State tracker for mapping Claude content blocks to messageId/partId.
	private currentAssistantMessageId = "";
	private partIdCounter = 0;

	private nextPartId(): string {
		return `claude-part-${this.partIdCounter++}`;
	}

	/** Reset in-flight state at the start of every new turn to prevent
	 *  stale entries from a previous turn or reconnect. */
	resetInFlightState(): void {
		this.partIdCounter = 0;
		this.currentAssistantMessageId = "";
	}

	constructor(private readonly deps: ClaudeEventTranslatorDeps) {}

	async translate(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		// Capture SDK session id for resume cursor on any message.
		// All SDK message variants carry session_id (required or optional),
		// but the union doesn't guarantee it statically — use an `in` guard.
		if ("session_id" in message && typeof message.session_id === "string") {
			ctx.resumeSessionId = message.session_id;
		}

		switch (message.type) {
			case "system":
				return this.translateSystem(ctx, message);
			case "stream_event":
				return this.translateStreamEvent(ctx, message);
			case "assistant":
				return this.translateAssistantSnapshot(ctx, message);
			case "user":
				return this.translateUserToolResults(ctx, message);
			case "result":
				return this.translateResult(ctx, message);
			default:
				// Explicitly ignore known SDK message types we don't process
				// (auth_status, tool_progress, rate_limit_event, prompt_suggestion, etc.)
				return;
		}
	}

	async translateError(
		ctx: ClaudeSessionContext,
		cause: unknown,
	): Promise<void> {
		const errorMsg = cause instanceof Error ? cause.message : String(cause);
		await this.push(
			makeCanonicalEvent("turn.error", ctx.sessionId, {
				messageId: this.currentAssistantMessageId || "",
				error: errorMsg,
				code: "provider_error",
			}),
		);
	}

	// ─── System ──────────────────────────────────────────────────────────

	private async translateSystem(
		ctx: ClaudeSessionContext,
		message: SDKSystemLike,
	): Promise<void> {
		switch (message.subtype) {
			case "status": {
				await this.push(
					makeCanonicalEvent("session.status", ctx.sessionId, {
						sessionId: ctx.sessionId,
						status: "idle",
					}),
				);
				return;
			}

			// SDK is retrying a failed API call. Surface it as
			// session.status:retry so the UI can display retry progress
			// instead of silence. Attempt/delay/error details travel via metadata.
			case "api_retry": {
				const {
					attempt,
					max_retries: maxRetries,
					retry_delay_ms: retryDelayMs,
				} = message;
				// error_status is number | null in the SDK type
				const errorStatus = message.error_status ?? undefined;
				// error is SDKAssistantMessageError (string literal union)
				const errorKind: string = message.error ?? "unknown";
				const parts: string[] = [`Retrying (attempt ${attempt}/${maxRetries})`];
				if (errorStatus !== undefined) {
					parts.push(`HTTP ${errorStatus}`);
				}
				if (errorKind !== "unknown") parts.push(errorKind);
				if (retryDelayMs !== undefined) {
					const secs = Math.round(retryDelayMs / 100) / 10;
					parts.push(`next in ${secs}s`);
				}
				const reason = parts.join(" · ");
				await this.push(
					canonicalEvent(
						"session.status",
						ctx.sessionId,
						{
							sessionId: ctx.sessionId,
							status: "retry",
						},
						{
							provider: PROVIDER,
							metadata: {
								source: "api_retry",
								correlationId: reason,
							},
						},
					),
				);
				return;
			}

			// Token usage updates. The SDK type declares usage as
			// { total_tokens, tool_uses, duration_ms } but runtime payloads
			// include input_tokens/output_tokens/cache_read_input_tokens.
			// Cast to Record for those extended fields not in the SDK type.
			case "task_progress": {
				const usage = message.usage as Record<string, unknown>;
				const inputTokens =
					typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : 0;
				const outputTokens =
					typeof usage["output_tokens"] === "number"
						? usage["output_tokens"]
						: 0;
				const cacheRead =
					typeof usage["cache_read_input_tokens"] === "number"
						? usage["cache_read_input_tokens"]
						: undefined;
				await this.push(
					makeCanonicalEvent("turn.completed", ctx.sessionId, {
						messageId: this.currentAssistantMessageId || "",
						tokens: {
							input: inputTokens,
							output: outputTokens,
							...(cacheRead !== undefined ? { cacheRead } : {}),
						},
						cost: 0,
						duration: 0,
					}),
				);
				return;
			}

			case "init": {
				// Store model info on context
				ctx.currentModel = message.model;
				await this.push(
					makeCanonicalEvent("session.status", ctx.sessionId, {
						sessionId: ctx.sessionId,
						status: "idle",
					}),
				);
				return;
			}

			default:
				// Ignore other system subtypes (task_notification, task_started,
				// compact_boundary, hook_*, etc.)
				return;
		}
	}

	// ─── Stream Events ───────────────────────────────────────────────────

	private async translateStreamEvent(
		ctx: ClaudeSessionContext,
		message: SDKPartialAssistantMessage,
	): Promise<void> {
		const event = message.event; // Typed: BetaRawMessageStreamEvent

		switch (event.type) {
			case "message_start":
				return this.handleMessageStart(ctx, event);
			case "content_block_start":
				return this.handleBlockStart(ctx, event);
			case "content_block_delta":
				return this.handleBlockDelta(ctx, event);
			case "content_block_stop":
				return this.handleBlockStop(ctx, event);
			case "message_delta":
			case "message_stop":
				// No action needed for these event types
				return;
		}
	}

	// ─── Message Start ──────────────────────────────────────────────────

	private async handleMessageStart(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "message_start" },
	): Promise<void> {
		// Capture the assistant message ID at the START of streaming so all
		// content blocks (text, tool_use, thinking) share a single messageId.
		// Without this, currentAssistantMessageId is empty during streaming
		// (only set later in translateAssistantSnapshot) and every block falls
		// back to its own per-block UUID — creating dozens of separate messages
		// in the persistence layer instead of one cohesive assistant message.
		const msgId = event.message.id;
		if (msgId && !this.currentAssistantMessageId) {
			this.currentAssistantMessageId = msgId;
			// Emit message.created so MessageProjector creates the row
			// and TurnProjector can link the turn to its assistant message.
			await this.push(
				makeCanonicalEvent("message.created", ctx.sessionId, {
					messageId: msgId,
					role: "assistant",
					sessionId: ctx.sessionId,
				}),
			);
			// Emit session.status: busy so TurnProjector transitions
			// the turn from "pending" → "running".
			await this.push(
				makeCanonicalEvent("session.status", ctx.sessionId, {
					sessionId: ctx.sessionId,
					status: "busy",
				}),
			);
		}
	}

	private async handleBlockStop(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_stop" },
	): Promise<void> {
		const index = event.index;
		const tool = ctx.inFlightTools.get(index);
		if (!tool) return;

		// Only complete text/thinking blocks here; tool_use blocks
		// complete when their tool_result arrives.
		if (tool.toolName === "__thinking") {
			ctx.inFlightTools.delete(index);
			await this.push(
				makeCanonicalEvent("thinking.end", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
				}),
			);
			return;
		}

		if (tool.toolName === "__text") {
			ctx.inFlightTools.delete(index);
			await this.push(
				makeCanonicalEvent("tool.completed", ctx.sessionId, {
					messageId: tool.itemId,
					partId: `part-stop-${index}`,
					result: null,
					duration: 0,
				}),
			);
			return;
		}

		// tool_use blocks: emit buffered tool.started now with complete input
		if (tool.pendingStart) {
			tool.pendingStart = false;
			const finalInput = tool.bufferedInput ?? tool.input;
			await this.push(
				makeCanonicalEvent(
					"tool.started",
					ctx.sessionId,
					{
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
						toolName: tool.toolName,
						callId: tool.itemId,
						input: normalizeToolInput(tool.toolName, finalInput),
					},
					{ schemaVersion: 2 },
				),
			);
			await this.push(
				makeCanonicalEvent("tool.running", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
				}),
			);
		}
		// Do NOT delete from inFlightTools — tool_use blocks wait for tool_result

		// tool_use blocks: do NOT complete here — wait for tool_result
	}

	private async handleBlockStart(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_start" },
	): Promise<void> {
		const index = event.index;
		const block = event.content_block;

		switch (block.type) {
			case "text":
			case "thinking": {
				const itemId = randomUUID();
				const toolName = block.type === "text" ? "__text" : "__thinking";
				const tool: ToolInFlight = {
					itemId,
					toolName,
					title: block.type === "text" ? "Assistant message" : "Thinking",
					input: {},
					partialInputJson: "",
				};
				ctx.inFlightTools.set(index, tool);
				if (block.type === "thinking") {
					// Emit thinking.start so the UI creates a ThinkingMessage with verbs.
					// text blocks don't need an event — content streams via text.delta → delta.
					await this.push(
						makeCanonicalEvent("thinking.start", ctx.sessionId, {
							messageId: this.currentAssistantMessageId,
							partId: tool.itemId,
						}),
					);
				}
				return;
			}

			case "tool_use":
			case "server_tool_use":
			case "mcp_tool_use": {
				const toolName = block.name ?? "unknown";
				const itemType = classifyToolItemType(toolName);
				const rawInput = block.input;
				const input =
					rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
						? (rawInput as Record<string, unknown>)
						: {};
				const blockId = block.id ?? randomUUID();
				const tool: ToolInFlight = {
					itemId: blockId,
					toolName,
					title: titleForItemType(itemType),
					input,
					partialInputJson: "",
					pendingStart: true,
				};
				ctx.inFlightTools.set(index, tool);
				// Do NOT emit tool.started here — buffered until content_block_stop
				return;
			}

			// Other SDK block types (redacted_thinking, web_search_tool_result,
			// web_fetch_tool_result, code_execution_tool_result,
			// bash_code_execution_tool_result, text_editor_code_execution_tool_result,
			// tool_search_tool_result, mcp_tool_result, container_upload,
			// compaction) are silently ignored — they don't map to canonical events.
			default:
				return;
		}
	}

	private async handleBlockDelta(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_delta" },
	): Promise<void> {
		const index = event.index;
		const tool = ctx.inFlightTools.get(index);
		const delta = event.delta;

		switch (delta.type) {
			case "text_delta":
			case "thinking_delta": {
				const text = delta.type === "text_delta" ? delta.text : delta.thinking;
				if (text.length === 0) return;

				const eventType =
					delta.type === "text_delta" ? "text.delta" : "thinking.delta";
				const partId = tool ? tool.itemId : this.nextPartId();
				await this.push(
					makeCanonicalEvent(eventType, ctx.sessionId, {
						messageId:
							this.currentAssistantMessageId || tool?.itemId || randomUUID(),
						partId,
						text,
					}),
				);
				return;
			}

			case "input_json_delta": {
				if (!tool) return;
				const partialJson = delta.partial_json;
				const merged = tool.partialInputJson + partialJson;
				tool.partialInputJson = merged;
				let parsed: Record<string, unknown> | undefined;
				try {
					const p: unknown = JSON.parse(merged);
					if (p && typeof p === "object" && !Array.isArray(p)) {
						parsed = p as Record<string, unknown>;
					}
				} catch {
					return;
				}
				if (!parsed) return;

				const fingerprint = JSON.stringify(parsed);
				if (tool.lastEmittedFingerprint === fingerprint) return;
				tool.lastEmittedFingerprint = fingerprint;
				tool.input = parsed;
				tool.bufferedInput = parsed;
				// Do NOT emit tool.input_updated or tool.running — buffered
				return;
			}

			// Other SDK delta types (citations_delta, signature_delta,
			// compaction_delta) are silently ignored.
			default:
				return;
		}
	}

	// ─── Assistant Snapshot ──────────────────────────────────────────────

	private async translateAssistantSnapshot(
		ctx: ClaudeSessionContext,
		message: SDKAssistantMessage,
	): Promise<void> {
		const uuid = message.uuid; // Typed: UUID
		if (uuid) {
			ctx.lastAssistantUuid = uuid;
			this.currentAssistantMessageId = uuid;
		}
	}

	// ─── User Tool Results ──────────────────────────────────────────────

	private async translateUserToolResults(
		ctx: ClaudeSessionContext,
		message: SDKUserMessage,
	): Promise<void> {
		const content = message.message.content;
		if (!Array.isArray(content)) return;

		for (const block of content) {
			if (typeof block === "string") continue;
			if (block.type !== "tool_result") continue;
			const toolUseId = block.tool_use_id;
			if (!toolUseId) continue;

			// Find the in-flight tool by itemId
			let matchedIndex: number | undefined;
			let matchedTool: ToolInFlight | undefined;
			for (const [idx, t] of ctx.inFlightTools) {
				if (t.itemId === toolUseId) {
					matchedIndex = idx;
					matchedTool = t;
					break;
				}
			}
			if (!matchedTool || matchedIndex === undefined) continue;

			// content on ToolResultBlockParam is string | ContentBlockParam[] | undefined.
			// Coerce to string for downstream use.
			const rawContent = block.content;
			const resultContent = typeof rawContent === "string" ? rawContent : "";

			if (resultContent.length > 0) {
				await this.push(
					makeCanonicalEvent("tool.running", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: matchedTool.itemId,
					}),
				);
			}

			await this.push(
				makeCanonicalEvent("tool.completed", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: matchedTool.itemId,
					result: resultContent || null,
					duration: 0,
				}),
			);
			ctx.inFlightTools.delete(matchedIndex);
		}
	}

	// ─── Result ──────────────────────────────────────────────────────────

	private async translateResult(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Promise<void> {
		if (isInterruptedResult(result)) {
			await this.push(
				makeCanonicalEvent("turn.interrupted", ctx.sessionId, {
					messageId:
						ctx.lastAssistantUuid || this.currentAssistantMessageId || "",
				}),
			);
			return;
		}

		if (result.subtype !== "success") {
			const errors = result.errors.join("; ") || "Unknown error";
			await this.push(
				makeCanonicalEvent("turn.error", ctx.sessionId, {
					messageId:
						ctx.lastAssistantUuid || this.currentAssistantMessageId || "",
					error: errors,
				}),
			);
			return;
		}

		// result is now narrowed to SDKResultSuccess — typed access to
		// result.is_error, result.result, result.uuid, result.usage, etc.

		// Success subtype with is_error=true: the SDK wraps an upstream API
		// error (e.g. "unknown provider for model X", 502s after all retries,
		// reasoning_effort validation failures) as a synthetic successful
		// completion whose `result` field contains the error text. Surface
		// this as a turn.error so the UI shows the message instead of a
		// silent empty assistant reply.
		if (result.is_error) {
			const errorText = result.result || "Provider returned an error";
			await this.push(
				makeCanonicalEvent("turn.error", ctx.sessionId, {
					messageId:
						ctx.lastAssistantUuid || this.currentAssistantMessageId || "",
					error: errorText,
					code: "provider_error",
				}),
			);
			return;
		}

		// If the SDK bypassed streaming (short responses, slash commands handled
		// locally, skill lookups), the full response text lives in `result.result`.
		// Emit a synthetic text.delta so the UI renders it as an assistant bubble.
		// Skip when any assistant message was already seen — streaming already
		// delivered the content to avoid duplicate rendering.
		const resultText = result.result;
		if (
			resultText &&
			resultText.length > 0 &&
			!ctx.lastAssistantUuid &&
			!this.currentAssistantMessageId
		) {
			const resultUuid =
				result.uuid ?? `claude-result-${ctx.sessionId}-${Date.now()}`;
			this.currentAssistantMessageId = resultUuid;
			ctx.lastAssistantUuid = resultUuid;
			await this.push(
				makeCanonicalEvent("text.delta", ctx.sessionId, {
					messageId: resultUuid,
					partId: `${resultUuid}-0`,
					text: resultText,
				}),
			);
		}

		// Usage — typed via NonNullableUsage on SDKResultSuccess
		const usage = result.usage;
		const tokens: {
			readonly input?: number;
			readonly output?: number;
			readonly cacheRead?: number;
			readonly cacheWrite?: number;
		} = {
			input: usage.input_tokens,
			output: usage.output_tokens,
			...(usage.cache_read_input_tokens > 0
				? { cacheRead: usage.cache_read_input_tokens }
				: {}),
			...(usage.cache_creation_input_tokens > 0
				? { cacheWrite: usage.cache_creation_input_tokens }
				: {}),
		};

		await this.push(
			makeCanonicalEvent("turn.completed", ctx.sessionId, {
				messageId:
					ctx.lastAssistantUuid || this.currentAssistantMessageId || "",
				cost: result.total_cost_usd,
				tokens,
				duration: result.duration_ms,
			}),
		);
	}

	// ─── Flush Pending Tools ────────────────────────────────────────────

	/** Flush any pendingStart tools (e.g. on stream interruption).
	 *  Emits tool.started + tool.completed for each buffered tool. */
	async flushPendingTools(ctx: ClaudeSessionContext): Promise<void> {
		for (const [index, tool] of ctx.inFlightTools) {
			if (!tool.pendingStart) continue;
			tool.pendingStart = false;
			const finalInput = tool.bufferedInput ?? tool.input;
			await this.push(
				makeCanonicalEvent(
					"tool.started",
					ctx.sessionId,
					{
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
						toolName: tool.toolName,
						callId: tool.itemId,
						input: normalizeToolInput(tool.toolName, finalInput),
					},
					{ schemaVersion: 2 },
				),
			);
			await this.push(
				makeCanonicalEvent("tool.completed", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
					result: null,
					duration: 0,
				}),
			);
			ctx.inFlightTools.delete(index);
		}
	}

	// ─── Push Helper ─────────────────────────────────────────────────────

	private async push(event: CanonicalEvent): Promise<void> {
		await this.deps.sink.push(event);
	}
}
