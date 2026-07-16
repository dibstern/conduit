// src/lib/provider/claude/claude-event-translator.ts
/**
 * ClaudeEventTranslator maps Claude Agent SDK messages (SDKMessage) onto
 * provider runtime events and pushes them through EventSink.
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
import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import type {
	CanonicalEventType,
	CanonicalToolInput,
	EventPayloadMap,
} from "../../persistence/events.js";
import { createEventId } from "../../persistence/events.js";
import { providerRefsFromRuntimeData } from "../provider-runtime-refs.js";
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
// Events are provider ingress envelopes. The EventSink owns conversion to
// durable domain events before append/projection.

function makeProviderRuntimeEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	metadata?: Readonly<Record<string, unknown>>,
): ProviderRuntimeEvent {
	return {
		eventId: createEventId(),
		type,
		providerId: PROVIDER,
		sessionId,
		providerRefs: providerRefsFromRuntimeData(type, data),
		rawSource: { kind: "claude.sdk.translator" },
		createdAt: Date.now(),
		data,
		...(metadata ? { metadata } : {}),
	};
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

type ReadableContentBlockType = "text" | "thinking";

interface ContentBlockState {
	readonly type: ReadableContentBlockType;
	readonly partId: string;
	text: string;
	textLength: number;
	started: boolean;
	ended: boolean;
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
	private contentBlockStates = new Map<string, ContentBlockState>();

	private nextPartId(): string {
		return `claude-part-${this.partIdCounter++}`;
	}

	private contentBlockKey(
		messageId: string,
		index: number,
		type: ReadableContentBlockType,
	): string {
		// Type-scoped: the SDK's per-block assistant snapshots index their
		// content array independently of the wire content_block index, so a
		// text block can land on an index the stream used for thinking.
		return `${messageId}:${index}:${type}`;
	}

	private getOrCreateContentBlockState(
		messageId: string,
		index: number,
		type: ReadableContentBlockType,
		partId: string,
	): ContentBlockState {
		const key = this.contentBlockKey(messageId, index, type);
		const existing = this.contentBlockStates.get(key);
		if (existing) return existing;

		const state: ContentBlockState = {
			type,
			partId,
			text: "",
			textLength: 0,
			started: false,
			ended: false,
		};
		this.contentBlockStates.set(key, state);
		return state;
	}

	/** Find the streamed state an assistant-snapshot block corresponds to.
	 *  Snapshot content-array indexes don't line up with wire content_block
	 *  indexes (per-block snapshots restart at 0), so match by message, type,
	 *  and text prefix instead — the snapshot text extends what streamed. */
	private findSnapshotBlockState(
		messageId: string,
		type: ReadableContentBlockType,
		text: string,
	): ContentBlockState | undefined {
		const prefix = `${messageId}:`;
		let best: ContentBlockState | undefined;
		for (const [key, state] of this.contentBlockStates) {
			if (!key.startsWith(prefix) || state.type !== type) continue;
			if (!text.startsWith(state.text) && !state.text.startsWith(text)) {
				continue;
			}
			if (!best || state.text.length > best.text.length) best = state;
		}
		return best;
	}

	private assistantSnapshotMessageId(message: SDKAssistantMessage): string {
		const id = message.message.id;
		return typeof id === "string" && id.length > 0 ? id : message.uuid;
	}

	private pushMessageCreated(
		ctx: ClaudeSessionContext,
		messageId: string,
	): Effect.Effect<void, unknown> {
		return this.push(
			ctx,
			makeProviderRuntimeEvent("message.created", ctx.sessionId, {
				messageId,
				role: "assistant",
				sessionId: ctx.sessionId,
			}),
		);
	}

	private emitTextSuffix(
		ctx: ClaudeSessionContext,
		input: {
			readonly messageId: string;
			readonly index: number;
			readonly type: ReadableContentBlockType;
			readonly partId: string;
			readonly text: string;
			readonly complete?: boolean;
		},
	): Effect.Effect<void, unknown> {
		const state = this.getOrCreateContentBlockState(
			input.messageId,
			input.index,
			input.type,
			input.partId,
		);
		return this.emitTextSuffixForState(ctx, state, input);
	}

	private emitTextSuffixForState(
		ctx: ClaudeSessionContext,
		state: ContentBlockState,
		input: {
			readonly messageId: string;
			readonly type: ReadableContentBlockType;
			readonly text: string;
			readonly complete?: boolean;
		},
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			if (input.type === "thinking" && !state.started) {
				yield* this.push(
					ctx,
					makeProviderRuntimeEvent("thinking.start", ctx.sessionId, {
						messageId: input.messageId,
						partId: state.partId,
					}),
				);
				state.started = true;
			}

			if (input.text.length > state.textLength) {
				const suffix = input.text.slice(state.textLength);
				yield* this.push(
					ctx,
					makeProviderRuntimeEvent(
						input.type === "text" ? "text.delta" : "thinking.delta",
						ctx.sessionId,
						{
							messageId: input.messageId,
							partId: state.partId,
							text: suffix,
						},
					),
				);
				state.text = input.text;
				state.textLength = input.text.length;
			}

			if (input.type === "thinking" && input.complete && !state.ended) {
				yield* this.push(
					ctx,
					makeProviderRuntimeEvent("thinking.end", ctx.sessionId, {
						messageId: input.messageId,
						partId: state.partId,
					}),
				);
				state.ended = true;
			}
		});
	}

	/** Reset in-flight state at the start of every new turn to prevent
	 *  stale entries from a previous turn or reconnect. */
	resetInFlightState(): void {
		this.partIdCounter = 0;
		this.currentAssistantMessageId = "";
		this.contentBlockStates.clear();
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
					makeProviderRuntimeEvent("turn.error", ctx.sessionId, {
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
						makeProviderRuntimeEvent("session.status", ctx.sessionId, {
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
						makeProviderRuntimeEvent(
							"session.status",
							ctx.sessionId,
							{
								sessionId: ctx.sessionId,
								status: "retry",
							},
							{
								source: "api_retry",
								correlationId: reason,
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
						makeProviderRuntimeEvent("session.status", ctx.sessionId, {
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
				makeProviderRuntimeEvent("tool.running", ctx.sessionId, {
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
			makeProviderRuntimeEvent(
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
				makeProviderRuntimeEvent("tool.completed", ctx.sessionId, {
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
		// Cast: StreamEvent widens the SDK typing with the `ping` keepalive
		// the runtime really does pass through but the SDK's types omit
		// (plain annotation would be flow-narrowed back to the SDK type).
		const event = message.event as StreamEvent;

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
			case "ping":
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
			// A queued prompt was enqueued mid-turn (the SDK keeps one streaming
			// turn open across queued sends, so no `result` reset happens): the
			// next API round answers the queued message — start a fresh
			// assistant message instead of merging into the previous one.
			const boundary =
				ctx.pendingAssistantBoundary === true &&
				Boolean(msgId) &&
				msgId !== this.currentAssistantMessageId;
			if (boundary) {
				ctx.pendingAssistantBoundary = false;
				this.contentBlockStates.clear();
			}
			if (msgId && (boundary || !this.currentAssistantMessageId)) {
				this.currentAssistantMessageId = msgId;
				// Emit message.created so MessageProjector creates the row
				// and TurnProjector can link the turn to its assistant message.
				yield* this.pushMessageCreated(ctx, msgId);
				// Emit session.status: busy so TurnProjector transitions
				// the turn from "pending" → "running".
				yield* this.push(
					ctx,
					makeProviderRuntimeEvent("session.status", ctx.sessionId, {
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
				const state = this.currentAssistantMessageId
					? this.getOrCreateContentBlockState(
							this.currentAssistantMessageId,
							index,
							"thinking",
							tool.itemId,
						)
					: undefined;
				yield* this.push(
					ctx,
					makeProviderRuntimeEvent("thinking.end", ctx.sessionId, {
						messageId: this.currentAssistantMessageId,
						partId: tool.itemId,
					}),
				);
				if (state) state.ended = true;
				return;
			}

			if (tool.toolName === "__text") {
				// Plain text blocks need no completion event. The tool.completed
				// this used to emit carried the part's own uuid as messageId,
				// which the ingress pipeline expanded into a phantom "Unknown"
				// tool plus a phantom empty assistant message row.
				ctx.inFlightTools.delete(index);
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
					makeProviderRuntimeEvent(
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
					makeProviderRuntimeEvent("tool.running", ctx.sessionId, {
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
					const messageId = this.currentAssistantMessageId || itemId;
					const tool: ToolInFlight = {
						itemId,
						toolName,
						title: block.type === "text" ? "Assistant message" : "Thinking",
						input: {},
						partialInputJson: "",
					};
					ctx.inFlightTools.set(index, tool);
					this.getOrCreateContentBlockState(
						messageId,
						index,
						block.type,
						tool.itemId,
					);
					if (block.type === "thinking") {
						yield* this.emitTextSuffix(ctx, {
							messageId,
							index,
							type: "thinking",
							partId: tool.itemId,
							text: block.thinking,
						});
					} else if (block.text.length > 0) {
						yield* this.emitTextSuffix(ctx, {
							messageId,
							index,
							type: "text",
							partId: tool.itemId,
							text: block.text,
						});
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

					const type = delta.type === "text_delta" ? "text" : "thinking";
					const partId = tool ? tool.itemId : this.nextPartId();
					const messageId =
						this.currentAssistantMessageId || tool?.itemId || randomUUID();
					const state = this.getOrCreateContentBlockState(
						messageId,
						index,
						type,
						partId,
					);
					yield* this.emitTextSuffix(ctx, {
						messageId,
						index,
						type,
						partId: state.partId,
						text: state.text + text,
					});
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
	): Effect.Effect<void, unknown> {
		return Effect.gen(this, function* () {
			ctx.lastAssistantUuid = message.uuid;

			const snapshotId = this.assistantSnapshotMessageId(message);
			let messageId: string;
			if (
				ctx.pendingAssistantBoundary === true &&
				snapshotId !== this.currentAssistantMessageId
			) {
				ctx.pendingAssistantBoundary = false;
				this.contentBlockStates.clear();
				messageId = snapshotId;
			} else {
				messageId = this.currentAssistantMessageId || snapshotId;
			}
			this.currentAssistantMessageId = messageId;

			const content = message.message.content;
			if (!Array.isArray(content)) return;

			const readableBlocks = content.filter(
				(block) =>
					isRecord(block) &&
					((block["type"] === "text" && typeof block["text"] === "string") ||
						(block["type"] === "thinking" &&
							typeof block["thinking"] === "string")),
			);
			if (readableBlocks.length === 0) return;

			yield* this.pushMessageCreated(ctx, messageId);

			// Snapshot content-array indexes are NOT the wire content_block
			// indexes (per-block snapshots restart at 0), so resolve each block
			// to its streamed state by type + text prefix. Only when nothing
			// streamed (partial messages off or missed) does the snapshot mint
			// its own part.
			for (const [index, block] of content.entries()) {
				if (!isRecord(block)) continue;
				if (block["type"] === "text" && typeof block["text"] === "string") {
					if (block["text"].length === 0) continue;
					const state =
						this.findSnapshotBlockState(messageId, "text", block["text"]) ??
						this.getOrCreateContentBlockState(
							messageId,
							index,
							"text",
							`${messageId}-${index}`,
						);
					yield* this.emitTextSuffixForState(ctx, state, {
						messageId,
						type: "text",
						text: block["text"],
					});
					continue;
				}
				if (
					block["type"] === "thinking" &&
					typeof block["thinking"] === "string"
				) {
					const existing = this.findSnapshotBlockState(
						messageId,
						"thinking",
						block["thinking"],
					);
					if (block["thinking"].length === 0 && !existing) continue;
					const state =
						existing ??
						this.getOrCreateContentBlockState(
							messageId,
							index,
							"thinking",
							`${messageId}-${index}`,
						);
					yield* this.emitTextSuffixForState(ctx, state, {
						messageId,
						type: "thinking",
						text: block["thinking"],
						complete: true,
					});
				}
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
						makeProviderRuntimeEvent("tool.running", ctx.sessionId, {
							messageId: this.currentAssistantMessageId,
							partId: matchedTool.itemId,
						}),
					);
				}

				yield* this.push(
					ctx,
					makeProviderRuntimeEvent("tool.completed", ctx.sessionId, {
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
					makeProviderRuntimeEvent("turn.interrupted", ctx.sessionId, {
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
					makeProviderRuntimeEvent("turn.error", ctx.sessionId, {
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
					makeProviderRuntimeEvent("turn.error", ctx.sessionId, {
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
					makeProviderRuntimeEvent("text.delta", ctx.sessionId, {
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
				makeProviderRuntimeEvent("turn.completed", ctx.sessionId, {
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
					makeProviderRuntimeEvent(
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
					makeProviderRuntimeEvent("tool.completed", ctx.sessionId, {
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
		event: ProviderRuntimeEvent,
	): Effect.Effect<void, unknown> {
		const sink = this.deps.getSink(ctx);
		if (!sink) return Effect.void;
		const write = sink.push(event);
		if (!this.bufferedWrites) return write;
		this.bufferedWrites.push(write);
		return Effect.void;
	}
}
