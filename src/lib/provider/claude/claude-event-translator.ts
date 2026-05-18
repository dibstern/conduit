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
 *   turn.completed (result)
 *
 * All payloads match the EventPayloadMap interfaces from Phase 1 Task 4.
 */
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import type {
	CanonicalEvent,
	CanonicalEventType,
	CanonicalToolInput,
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

function serializeToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					const record = block as Record<string, unknown>;
					if (record["type"] === "text" && typeof record["text"] === "string") {
						return record["text"];
					}
				}
				return JSON.stringify(block);
			})
			.filter((part) => part != null && part !== "")
			.join("\n");
	}
	if (content == null) return "";
	return JSON.stringify(content);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function canonicalToolName(
	toolName: string,
	input: CanonicalToolInput | unknown,
): string {
	return isRecord(input) && input["tool"] === "Task" ? "Task" : toolName;
}

function enrichTaskInput(
	rawInput: unknown,
	metadata?: Record<string, unknown>,
): Record<string, unknown> {
	const input = isRecord(rawInput) ? { ...rawInput } : {};
	if (!metadata) return input;
	if (
		typeof metadata["description"] === "string" &&
		typeof input["description"] !== "string"
	) {
		input["description"] = metadata["description"];
	}
	if (
		typeof metadata["prompt"] === "string" &&
		typeof input["prompt"] !== "string"
	) {
		input["prompt"] = metadata["prompt"];
	}
	if (
		typeof metadata["subagentType"] === "string" &&
		typeof input["subagentType"] !== "string" &&
		typeof input["subagent_type"] !== "string"
	) {
		input["subagentType"] = metadata["subagentType"];
	}
	return input;
}

function taskCompletionResult(
	metadata: Record<string, unknown>,
): string | null {
	if (
		typeof metadata["summary"] === "string" &&
		metadata["summary"].length > 0
	) {
		return metadata["summary"];
	}
	if (typeof metadata["status"] === "string" && metadata["status"].length > 0) {
		return `Task ${metadata["status"]}`;
	}
	return null;
}

// ─── Translator ────────────────────────────────────────────────────────────

export interface ClaudeEventTranslatorDeps {
	readonly getSink: (ctx: ClaudeSessionContext) => EventSink | undefined;
}

export class ClaudeEventTranslator {
	// State tracker for mapping Claude content blocks to messageId/partId.
	private currentAssistantMessageId = "";
	private partIdCounter = 0;
	private bufferedWrites: Effect.Effect<void, unknown>[] | undefined;

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

	translate(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Effect.Effect<void, unknown> {
		return this.collectWrites(() => this.translateMessage(ctx, message));
	}

	private translateMessage(
		ctx: ClaudeSessionContext,
		message: SDKMessage,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			// Capture SDK session id for resume cursor on any message.
			// All SDK message variants carry session_id (required or optional),
			// but the union doesn't guarantee it statically — use an `in` guard.
			if ("session_id" in message && typeof message.session_id === "string") {
				ctx.resumeSessionId = message.session_id;
			}

			switch (message.type) {
				case "system":
					return yield* this.translateSystem(ctx, message);
				case "stream_event":
					return yield* this.translateStreamEvent(ctx, message);
				case "assistant":
					return yield* this.translateAssistantSnapshot(ctx, message);
				case "user":
					return yield* this.translateUserToolResults(ctx, message);
				case "result":
					return yield* this.translateResult(ctx, message);
				case "tool_progress":
					return yield* this.translateToolProgress(ctx, message);
				default:
					// Explicitly ignore known SDK message types we don't process
					// (auth_status, rate_limit_event, prompt_suggestion, etc.)
					return;
			}
		});
	}

	translateError(
		ctx: ClaudeSessionContext,
		cause: unknown,
	): Effect.Effect<void, unknown> {
		return this.collectWrites(() =>
			Effect.gen(this, function* () {
				const errorMsg = cause instanceof Error ? cause.message : String(cause);
				yield* this.push(
					ctx,
					makeCanonicalEvent("turn.error", ctx.sessionId, {
						messageId: this.currentAssistantMessageId || "",
						error: errorMsg,
						code: "provider_error",
					}),
				);
				this.resetInFlightState();
			}),
		);
	}

	// ─── System ──────────────────────────────────────────────────────────

	private translateSystem(
		ctx: ClaudeSessionContext,
		message: SDKSystemLike,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			switch (message.subtype) {
				case "status": {
					yield* this.push(
						ctx,
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
					const parts: string[] = [
						`Retrying (attempt ${attempt}/${maxRetries})`,
					];
					if (errorStatus !== undefined) {
						parts.push(`HTTP ${errorStatus}`);
					}
					if (errorKind !== "unknown") parts.push(errorKind);
					if (retryDelayMs !== undefined) {
						const secs = Math.round(retryDelayMs / 100) / 10;
						parts.push(`next in ${secs}s`);
					}
					const reason = parts.join(" · ");
					yield* this.push(
						ctx,
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
					return yield* this.translateTaskProgress(ctx, message);
				}

				case "task_started": {
					return yield* this.translateTaskStarted(ctx, message);
				}

				case "task_notification": {
					return yield* this.translateTaskNotification(ctx, message);
				}

				case "init": {
					// Store model info on context
					ctx.currentModel = message.model;
					yield* this.push(
						ctx,
						makeCanonicalEvent("session.status", ctx.sessionId, {
							sessionId: ctx.sessionId,
							status: "idle",
						}),
					);
					return;
				}

				default:
					// Ignore other system subtypes (compact_boundary, hook_*, etc.)
					return;
			}
		});
	}

	private translateTaskStarted(
		ctx: ClaudeSessionContext,
		message: SDKSystemLike & { subtype: "task_started" },
	): Effect.Effect<void, unknown> {
		if (!message.tool_use_id) return Effect.void;
		const extras = message as unknown as Record<string, unknown>;
		return this.pushTaskMetadata(ctx, message.tool_use_id, {
			providerTaskId: message.task_id,
			status: "running",
			description: message.description,
			...(message.task_type ? { subagentType: message.task_type } : {}),
			...(typeof extras["child_session_id"] === "string"
				? { childSessionId: extras["child_session_id"] }
				: {}),
			...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
			...(message.prompt ? { prompt: message.prompt } : {}),
			...(message.skip_transcript !== undefined
				? { skipTranscript: message.skip_transcript }
				: {}),
		});
	}

	private translateTaskProgress(
		ctx: ClaudeSessionContext,
		message: SDKSystemLike & { subtype: "task_progress" },
	): Effect.Effect<void, unknown> {
		if (!message.tool_use_id) return Effect.void;
		const usage = message.usage as Record<string, unknown>;
		const extras = message as unknown as Record<string, unknown>;
		return this.pushTaskMetadata(ctx, message.tool_use_id, {
			providerTaskId: message.task_id,
			status: "running",
			description: message.description,
			...(typeof extras["subagent_type"] === "string"
				? { subagentType: extras["subagent_type"] }
				: {}),
			...(typeof extras["child_session_id"] === "string"
				? { childSessionId: extras["child_session_id"] }
				: {}),
			totalTokens: usage["total_tokens"] ?? 0,
			toolUses: usage["tool_uses"] ?? 0,
			durationMs: usage["duration_ms"] ?? 0,
			...(message.last_tool_name
				? { lastToolName: message.last_tool_name }
				: {}),
			...(message.summary ? { summary: message.summary } : {}),
		});
	}

	private translateTaskNotification(
		ctx: ClaudeSessionContext,
		message: SDKSystemLike & { subtype: "task_notification" },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (!message.tool_use_id) return;
			const usage = message.usage as Record<string, unknown> | undefined;
			const extras = message as unknown as Record<string, unknown>;
			const metadata = {
				providerTaskId: message.task_id,
				status: message.status,
				outputFile: message.output_file,
				summary: message.summary,
				...(typeof extras["child_session_id"] === "string"
					? { childSessionId: extras["child_session_id"] }
					: {}),
				...(usage
					? {
							totalTokens: usage["total_tokens"] ?? 0,
							toolUses: usage["tool_uses"] ?? 0,
							durationMs: usage["duration_ms"] ?? 0,
						}
					: {}),
				...(message.skip_transcript !== undefined
					? { skipTranscript: message.skip_transcript }
					: {}),
			};
			yield* this.pushTaskMetadata(ctx, message.tool_use_id, metadata);
			if (message.status === "completed") {
				yield* this.completeTaskTool(
					ctx,
					message.tool_use_id,
					taskCompletionResult(metadata),
				);
			}
		});
	}

	private translateToolProgress(
		ctx: ClaudeSessionContext,
		message: SDKMessage & { type: "tool_progress" },
	): Effect.Effect<void, unknown> {
		const parentToolUseId = message.parent_tool_use_id;
		if (!parentToolUseId) return Effect.void;
		return this.pushTaskMetadata(ctx, parentToolUseId, {
			...(message.task_id ? { providerTaskId: message.task_id } : {}),
			parentToolUseId,
			activeToolUseId: message.tool_use_id,
			activeToolName: message.tool_name,
			elapsedTimeSeconds: message.elapsed_time_seconds,
		});
	}

	private pushTaskMetadata(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
		metadata: Record<string, unknown>,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const providerTaskId = metadata["providerTaskId"];
			const subagentTasks = ctx.subagentTasks;
			const task =
				typeof providerTaskId === "string" && subagentTasks
					? subagentTasks.get(providerTaskId)
					: undefined;
			const parentMessageId =
				this.currentAssistantMessageId ||
				ctx.lastAssistantUuid ||
				task?.parentMessageId ||
				"";
			const mergedMetadata = {
				...(task?.description != null ? { description: task.description } : {}),
				...(task?.subagentType != null
					? { subagentType: task.subagentType }
					: {}),
				...(task?.childSessionId != null
					? { childSessionId: task.childSessionId }
					: {}),
				...metadata,
			};
			if (typeof providerTaskId === "string" && subagentTasks) {
				subagentTasks.set(providerTaskId, {
					toolUseId: parentToolUseId,
					...(typeof mergedMetadata["childSessionId"] === "string"
						? { childSessionId: mergedMetadata["childSessionId"] }
						: {}),
					...(parentMessageId ? { parentMessageId } : {}),
					...(typeof mergedMetadata["description"] === "string"
						? { description: mergedMetadata["description"] }
						: {}),
					...(typeof mergedMetadata["subagentType"] === "string"
						? { subagentType: mergedMetadata["subagentType"] }
						: {}),
				});
			}
			yield* this.ensureTaskToolStarted(
				ctx,
				parentToolUseId,
				mergedMetadata,
				parentMessageId,
			);
			yield* this.push(
				ctx,
				makeCanonicalEvent("tool.running", ctx.sessionId, {
					messageId: parentMessageId,
					partId: parentToolUseId,
					metadata: mergedMetadata,
				}),
			);
		});
	}

	private ensureTaskToolStarted(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
		metadata: Record<string, unknown>,
		messageId: string,
	): Effect.Effect<void, unknown> {
		const tool = this.findInFlightTool(parentToolUseId, ctx);
		if (!tool || !tool.pendingStart) return Effect.void;
		if (tool.toolName !== "Agent" && tool.toolName !== "Task")
			return Effect.void;

		tool.pendingStart = false;
		const rawInput = enrichTaskInput(
			tool.bufferedInput ?? tool.input,
			metadata,
		);
		tool.input = rawInput;
		tool.bufferedInput = rawInput;
		const input = normalizeToolInput(tool.toolName, rawInput);
		return this.push(
			ctx,
			makeCanonicalEvent(
				"tool.started",
				ctx.sessionId,
				{
					messageId,
					partId: tool.itemId,
					toolName: canonicalToolName(tool.toolName, input),
					callId: tool.itemId,
					input,
				},
				{ schemaVersion: 2 },
			),
		);
	}

	private completeTaskTool(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
		result: string | null,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const messageId =
				this.currentAssistantMessageId || ctx.lastAssistantUuid || "";
			yield* this.push(
				ctx,
				makeCanonicalEvent("tool.completed", ctx.sessionId, {
					messageId,
					partId: parentToolUseId,
					result,
					duration: 0,
				}),
			);
			this.deleteInFlightTool(parentToolUseId, ctx);
		});
	}

	private taskMetadataForToolUseId(
		ctx: ClaudeSessionContext,
		parentToolUseId: string,
	): Record<string, unknown> | undefined {
		const tasks = ctx.subagentTasks;
		if (!tasks) return undefined;
		for (const [providerTaskId, task] of tasks) {
			if (task.toolUseId !== parentToolUseId) continue;
			return {
				providerTaskId,
				...(task.description ? { description: task.description } : {}),
				...(task.subagentType ? { subagentType: task.subagentType } : {}),
				...(task.childSessionId ? { childSessionId: task.childSessionId } : {}),
			};
		}
		return undefined;
	}

	private findInFlightTool(
		parentToolUseId: string,
		ctx: ClaudeSessionContext,
	): ToolInFlight | undefined {
		for (const tool of ctx.inFlightTools.values()) {
			if (tool.itemId === parentToolUseId) return tool;
		}
		return undefined;
	}

	private deleteInFlightTool(
		parentToolUseId: string,
		ctx: ClaudeSessionContext,
	): void {
		for (const [index, tool] of ctx.inFlightTools) {
			if (tool.itemId === parentToolUseId) {
				ctx.inFlightTools.delete(index);
				return;
			}
		}
	}

	// ─── Stream Events ───────────────────────────────────────────────────

	private translateStreamEvent(
		ctx: ClaudeSessionContext,
		message: SDKPartialAssistantMessage,
	): Effect.Effect<void, unknown> {
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
				return Effect.void;
		}
	}

	// ─── Message Start ──────────────────────────────────────────────────

	private handleMessageStart(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "message_start" },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
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
				yield* this.push(
					ctx,
					makeCanonicalEvent("message.created", ctx.sessionId, {
						messageId: msgId,
						role: "assistant",
						sessionId: ctx.sessionId,
					}),
				);
				// Emit session.status: busy so TurnProjector transitions
				// the turn from "pending" → "running".
				yield* this.push(
					ctx,
					makeCanonicalEvent("session.status", ctx.sessionId, {
						sessionId: ctx.sessionId,
						status: "busy",
					}),
				);
			}
		});
	}

	private handleBlockStop(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_stop" },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const index = event.index;
			const tool = ctx.inFlightTools.get(index);
			if (!tool) return;

			// Only complete text/thinking blocks here; tool_use blocks
			// complete when their tool_result arrives.
			if (tool.toolName === "__thinking") {
				ctx.inFlightTools.delete(index);
				yield* this.push(
					ctx,
					makeCanonicalEvent("thinking.end", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
					}),
				);
				return;
			}

			if (tool.toolName === "__text") {
				ctx.inFlightTools.delete(index);
				yield* this.push(
					ctx,
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
				const taskMetadata = this.taskMetadataForToolUseId(ctx, tool.itemId);
				const finalInput =
					tool.toolName === "Agent" || tool.toolName === "Task"
						? enrichTaskInput(tool.bufferedInput ?? tool.input, taskMetadata)
						: (tool.bufferedInput ?? tool.input);
				const normalizedInput = normalizeToolInput(tool.toolName, finalInput);
				yield* this.push(
					ctx,
					makeCanonicalEvent(
						"tool.started",
						ctx.sessionId,
						{
							messageId: this.currentAssistantMessageId,
							partId: tool.itemId,
							toolName: canonicalToolName(tool.toolName, normalizedInput),
							callId: tool.itemId,
							input: normalizedInput,
						},
						{ schemaVersion: 2 },
					),
				);
				yield* this.push(
					ctx,
					makeCanonicalEvent("tool.running", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
					}),
				);
			}
			// Do NOT delete from inFlightTools — tool_use blocks wait for tool_result

			// tool_use blocks: do NOT complete here — wait for tool_result
		});
	}

	private handleBlockStart(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_start" },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
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
						yield* this.push(
							ctx,
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
		});
	}

	private handleBlockDelta(
		ctx: ClaudeSessionContext,
		event: StreamEvent & { type: "content_block_delta" },
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const index = event.index;
			const tool = ctx.inFlightTools.get(index);
			const delta = event.delta;

			switch (delta.type) {
				case "text_delta":
				case "thinking_delta": {
					const text =
						delta.type === "text_delta" ? delta.text : delta.thinking;
					if (text.length === 0) return;

					const eventType =
						delta.type === "text_delta" ? "text.delta" : "thinking.delta";
					const partId = tool ? tool.itemId : this.nextPartId();
					yield* this.push(
						ctx,
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
		});
	}

	// ─── Assistant Snapshot ──────────────────────────────────────────────

	private translateAssistantSnapshot(
		ctx: ClaudeSessionContext,
		message: SDKAssistantMessage,
	): Effect.Effect<void> {
		return Effect.sync(() => {
			const uuid = message.uuid; // Typed: UUID
			if (uuid) {
				ctx.lastAssistantUuid = uuid;
				this.currentAssistantMessageId = uuid;
			}
		});
	}

	// ─── User Tool Results ──────────────────────────────────────────────

	private translateUserToolResults(
		ctx: ClaudeSessionContext,
		message: SDKUserMessage,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
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

				const resultContent = serializeToolResultContent(block.content);

				if (resultContent.length > 0) {
					yield* this.push(
						ctx,
						makeCanonicalEvent("tool.running", ctx.sessionId, {
							messageId: this.currentAssistantMessageId,
							partId: matchedTool.itemId,
						}),
					);
				}

				yield* this.push(
					ctx,
					makeCanonicalEvent("tool.completed", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: matchedTool.itemId,
						result: resultContent || null,
						duration: 0,
					}),
				);
				ctx.inFlightTools.delete(matchedIndex);
			}
		});
	}

	// ─── Result ──────────────────────────────────────────────────────────

	private translateResult(
		ctx: ClaudeSessionContext,
		result: SDKResultMessage,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (isInterruptedResult(result)) {
				yield* this.push(
					ctx,
					makeCanonicalEvent("turn.interrupted", ctx.sessionId, {
						messageId:
							this.currentAssistantMessageId || ctx.lastAssistantUuid || "",
					}),
				);
				this.resetInFlightState();
				return;
			}

			if (result.subtype !== "success") {
				const errors = result.errors.join("; ") || "Unknown error";
				yield* this.push(
					ctx,
					makeCanonicalEvent("turn.error", ctx.sessionId, {
						messageId:
							this.currentAssistantMessageId || ctx.lastAssistantUuid || "",
						error: errors,
					}),
				);
				this.resetInFlightState();
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
				yield* this.push(
					ctx,
					makeCanonicalEvent("turn.error", ctx.sessionId, {
						messageId:
							this.currentAssistantMessageId || ctx.lastAssistantUuid || "",
						error: errorText,
						code: "provider_error",
					}),
				);
				this.resetInFlightState();
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
				yield* this.push(
					ctx,
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

			yield* this.push(
				ctx,
				makeCanonicalEvent("turn.completed", ctx.sessionId, {
					messageId:
						this.currentAssistantMessageId || ctx.lastAssistantUuid || "",
					cost: result.total_cost_usd,
					tokens,
					duration: result.duration_ms,
				}),
			);
			this.resetInFlightState();
		});
	}

	// ─── Flush Pending Tools ────────────────────────────────────────────

	/** Flush any pendingStart tools (e.g. on stream interruption).
	 *  Emits tool.started + tool.completed for each buffered tool. */
	flushPendingTools(ctx: ClaudeSessionContext): Effect.Effect<void, unknown> {
		return this.collectWrites(() => this.flushPendingToolsMessage(ctx));
	}

	private flushPendingToolsMessage(
		ctx: ClaudeSessionContext,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			for (const [index, tool] of ctx.inFlightTools) {
				if (!tool.pendingStart) continue;
				tool.pendingStart = false;
				const taskMetadata = this.taskMetadataForToolUseId(ctx, tool.itemId);
				const finalInput =
					tool.toolName === "Agent" || tool.toolName === "Task"
						? enrichTaskInput(tool.bufferedInput ?? tool.input, taskMetadata)
						: (tool.bufferedInput ?? tool.input);
				const normalizedInput = normalizeToolInput(tool.toolName, finalInput);
				yield* this.push(
					ctx,
					makeCanonicalEvent(
						"tool.started",
						ctx.sessionId,
						{
							messageId: this.currentAssistantMessageId,
							partId: tool.itemId,
							toolName: canonicalToolName(tool.toolName, normalizedInput),
							callId: tool.itemId,
							input: normalizedInput,
						},
						{ schemaVersion: 2 },
					),
				);
				yield* this.push(
					ctx,
					makeCanonicalEvent("tool.completed", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
						result: null,
						duration: 0,
					}),
				);
				ctx.inFlightTools.delete(index);
			}
		});
	}

	// ─── Push Helper ─────────────────────────────────────────────────────

	private collectWrites(
		work: () => Effect.Effect<void, unknown>,
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			const previousWrites = this.bufferedWrites;
			const writes: Effect.Effect<void, unknown>[] = [];
			this.bufferedWrites = writes;
			yield* work().pipe(
				Effect.ensuring(
					Effect.sync(() => {
						this.bufferedWrites = previousWrites;
					}),
				),
			);
			yield* Effect.all(writes, { discard: true });
		});
	}

	private push(
		ctx: ClaudeSessionContext,
		event: CanonicalEvent,
	): Effect.Effect<void, unknown> {
		const sink = this.deps.getSink(ctx);
		if (!sink) return Effect.void;
		const write = sink.push(event);
		if (!this.bufferedWrites) return write;
		this.bufferedWrites.push(write);
		return Effect.void;
	}
}
