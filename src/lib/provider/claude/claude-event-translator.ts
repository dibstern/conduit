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
	EventPayloadMap,
} from "../../persistence/events.js";
import { canonicalEvent } from "../../persistence/events.js";
import type { EventSink } from "../types.js";
import type {
	ClaudeSessionContext,
	SDKMessage,
	SDKResultMessage,
	SDKSystemLike,
	ToolInFlight,
} from "./types.js";

const PROVIDER = "claude" as const;

// ─── Safe record accessor ──────────────────────────────────────────────────
// The SDK message types are structurally typed and many fields are accessed
// via Record<string, unknown>. This helper avoids the need for bracket
// notation on every access.

function asRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return {};
}

function getString(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

function getNumber(
	obj: Record<string, unknown>,
	key: string,
): number | undefined {
	const v = obj[key];
	return typeof v === "number" ? v : undefined;
}

function getRecord(
	obj: Record<string, unknown>,
	key: string,
): Record<string, unknown> | undefined {
	const v = obj[key];
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}

// ─── Typed event construction helper ───────────────────────────────────────
// Uses the shared canonicalEvent() factory from persistence/events.ts.
// All events are tagged with provider: "claude" via the PROVIDER constant.

function makeCanonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
): CanonicalEvent {
	return canonicalEvent(type, sessionId, data, { provider: PROVIDER });
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
			// Use Record cast for those extended fields.
			case "task_progress": {
				const usage = message.usage as Record<string, unknown>;
				const cacheRead = getNumber(usage, "cache_read_input_tokens");
				await this.push(
					makeCanonicalEvent("turn.completed", ctx.sessionId, {
						messageId: this.currentAssistantMessageId || "",
						tokens: {
							input: getNumber(usage, "input_tokens") ?? 0,
							output: getNumber(usage, "output_tokens") ?? 0,
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
		message: SDKMessage,
	): Promise<void> {
		const record = asRecord(message as unknown);
		const event = getRecord(record, "event");
		if (!event) return;
		const eventType = getString(event, "type");
		if (!eventType) return;

		// Capture the assistant message ID at the START of streaming so all
		// content blocks (text, tool_use, thinking) share a single messageId.
		// Without this, currentAssistantMessageId is empty during streaming
		// (only set later in translateAssistantSnapshot) and every block falls
		// back to its own per-block UUID — creating dozens of separate messages
		// in the persistence layer instead of one cohesive assistant message.
		if (eventType === "message_start") {
			const msgRecord = getRecord(event, "message");
			if (msgRecord) {
				const msgId = getString(msgRecord, "id");
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
			return;
		}

		if (eventType === "content_block_start") {
			return this.handleBlockStart(ctx, event);
		}
		if (eventType === "content_block_delta") {
			return this.handleBlockDelta(ctx, event);
		}
		if (eventType === "content_block_stop") {
			return this.handleBlockStop(ctx, event);
		}
	}

	private async handleBlockStop(
		ctx: ClaudeSessionContext,
		event: Record<string, unknown>,
	): Promise<void> {
		const index = getNumber(event, "index");
		if (index === undefined) return;
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

		// tool_use blocks: do NOT complete here — wait for tool_result
	}

	private async handleBlockStart(
		ctx: ClaudeSessionContext,
		event: Record<string, unknown>,
	): Promise<void> {
		const index = getNumber(event, "index") ?? 0;
		const block = getRecord(event, "content_block");
		if (!block) return;
		const blockType = getString(block, "type");

		if (blockType === "text" || blockType === "thinking") {
			const itemId = randomUUID();
			const toolName = blockType === "text" ? "__text" : "__thinking";
			const tool: ToolInFlight = {
				itemId,
				toolName,
				title: blockType === "text" ? "Assistant message" : "Thinking",
				input: {},
				partialInputJson: "",
			};
			ctx.inFlightTools.set(index, tool);
			if (blockType === "thinking") {
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

		if (
			blockType === "tool_use" ||
			blockType === "server_tool_use" ||
			blockType === "mcp_tool_use"
		) {
			const toolName = getString(block, "name") ?? "unknown";
			const itemType = classifyToolItemType(toolName);
			const rawInput = block["input"];
			const input =
				rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
					? (rawInput as Record<string, unknown>)
					: {};
			const blockId = getString(block, "id") ?? randomUUID();
			const tool: ToolInFlight = {
				itemId: blockId,
				toolName,
				title: titleForItemType(itemType),
				input,
				partialInputJson: "",
			};
			ctx.inFlightTools.set(index, tool);
			await this.push(
				makeCanonicalEvent("tool.started", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
					toolName,
					callId: blockId,
					input,
				}),
			);
		}
	}

	private async handleBlockDelta(
		ctx: ClaudeSessionContext,
		event: Record<string, unknown>,
	): Promise<void> {
		const index = getNumber(event, "index") ?? 0;
		const tool = ctx.inFlightTools.get(index);
		const delta = getRecord(event, "delta");
		if (!delta) return;
		const deltaType = getString(delta, "type");

		if (deltaType === "text_delta" || deltaType === "thinking_delta") {
			const text =
				deltaType === "text_delta"
					? (getString(delta, "text") ?? "")
					: (getString(delta, "thinking") ?? "");
			if (text.length === 0) return;

			const eventType =
				deltaType === "text_delta" ? "text.delta" : "thinking.delta";
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

		if (deltaType === "input_json_delta" && tool) {
			const partialJson = getString(delta, "partial_json") ?? "";
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

			await this.push(
				makeCanonicalEvent("tool.running", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
				}),
			);

			await this.push(
				makeCanonicalEvent("tool.input_updated", ctx.sessionId, {
					messageId: this.currentAssistantMessageId,
					partId: tool.itemId,
					input: parsed,
				}),
			);
		}
	}

	// ─── Assistant Snapshot ──────────────────────────────────────────────

	private async translateAssistantSnapshot(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		const record = asRecord(message as unknown);
		const uuid = getString(record, "uuid");
		if (uuid) {
			ctx.lastAssistantUuid = uuid;
			this.currentAssistantMessageId = uuid;
		}
	}

	// ─── User Tool Results ──────────────────────────────────────────────

	private async translateUserToolResults(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Promise<void> {
		const record = asRecord(message as unknown);
		const msg = getRecord(record, "message");
		if (!msg) return;
		const content = msg["content"];
		if (!Array.isArray(content)) return;

		for (const rawBlock of content) {
			const block = asRecord(rawBlock);
			if (getString(block, "type") !== "tool_result") continue;
			const toolUseId = getString(block, "tool_use_id");
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

			const resultContent = getString(block, "content") ?? "";

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

		// Success subtype with is_error=true: the SDK wraps an upstream API
		// error (e.g. "unknown provider for model X", 502s after all retries,
		// reasoning_effort validation failures) as a synthetic successful
		// completion whose `result` field contains the error text. Surface
		// this as a turn.error so the UI shows the message instead of a
		// silent empty assistant reply.
		const resultRec = asRecord(result as unknown);
		const isErrorFlag = resultRec["is_error"] === true;
		if (isErrorFlag) {
			const errorText =
				getString(resultRec, "result") || "Provider returned an error";
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
		const resultText = getString(resultRec, "result");
		if (
			resultText &&
			resultText.length > 0 &&
			!ctx.lastAssistantUuid &&
			!this.currentAssistantMessageId
		) {
			const resultUuid =
				getString(resultRec, "uuid") ??
				`claude-result-${ctx.sessionId}-${Date.now()}`;
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

		const usage = result.usage ?? {};
		const cacheReadVal =
			typeof usage.cache_read_input_tokens === "number"
				? usage.cache_read_input_tokens
				: undefined;
		const cacheWriteVal =
			typeof usage.cache_creation_input_tokens === "number"
				? usage.cache_creation_input_tokens
				: undefined;

		// Build tokens object, omitting undefined optional fields to satisfy
		// exactOptionalPropertyTypes.
		const tokens: {
			readonly input?: number;
			readonly output?: number;
			readonly cacheRead?: number;
			readonly cacheWrite?: number;
		} = {
			input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
			output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
			...(cacheReadVal !== undefined ? { cacheRead: cacheReadVal } : {}),
			...(cacheWriteVal !== undefined ? { cacheWrite: cacheWriteVal } : {}),
		};

		const costVal =
			typeof result.total_cost_usd === "number"
				? result.total_cost_usd
				: undefined;
		const durationVal =
			typeof result.duration_ms === "number" ? result.duration_ms : undefined;

		await this.push(
			makeCanonicalEvent("turn.completed", ctx.sessionId, {
				messageId:
					ctx.lastAssistantUuid || this.currentAssistantMessageId || "",
				...(costVal !== undefined ? { cost: costVal } : {}),
				tokens,
				...(durationVal !== undefined ? { duration: durationVal } : {}),
			}),
		);
	}

	// ─── Push Helper ─────────────────────────────────────────────────────

	private async push(event: CanonicalEvent): Promise<void> {
		await this.deps.sink.push(event);
	}
}
