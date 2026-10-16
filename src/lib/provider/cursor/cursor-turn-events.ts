import { Effect, Either, Schema } from "effect";
import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
	ProviderRuntimeProviderRefs,
} from "../../contracts/providers/provider-runtime-event.js";
import { createLogger } from "../../logger.js";
import { createEventId } from "../../persistence/events.js";
import type { EventSinkError } from "../event-sink-errors.js";
import { toRecord } from "../normalize-tool-input-helpers.js";
import type { EventSink, TurnTokens } from "../types.js";
import {
	type CursorToolCall,
	CursorToolResults,
	cursorToolInput,
} from "./cursor-tool-events.js";

const log = createLogger("cursor-turn-events");
const RecordSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
});
const ToolDelta = Schema.Struct({
	type: Schema.Literal(
		"tool-call-started",
		"tool-call-completed",
		"partial-tool-call",
	),
	callId: Schema.String,
	toolCall: Schema.Struct({
		type: Schema.String,
		args: RecordSchema,
		result: Schema.optional(Schema.Unknown),
	}),
});
const decodeDelta = Schema.decodeUnknownEither(
	Schema.Union(
		Schema.Struct({
			type: Schema.Literal("text-delta", "thinking-delta"),
			text: Schema.String,
		}),
		Schema.Struct({ type: Schema.Literal("thinking-completed") }),
		ToolDelta,
		Schema.Struct({
			type: Schema.Literal("shell-output-delta"),
			event: RecordSchema,
		}),
		Schema.Struct({
			type: Schema.Literal("tool-call-delta"),
			callId: Schema.String,
			taskUpdate: RecordSchema,
		}),
		Schema.Struct({
			type: Schema.Literal("tool-requests-listed"),
			callCount: Schema.Number,
		}),
		Schema.Struct({
			type: Schema.Literal(
				"token-delta",
				"step-started",
				"step-completed",
				"turn-ended",
				"user-message-appended",
				"summary-started",
				"summary-completed",
				"summary",
			),
		}),
	),
);
const decodeStream = Schema.decodeUnknownEither(
	Schema.Union(
		Schema.Struct({
			type: Schema.Literal("request"),
			request_id: Schema.String,
		}),
		Schema.Struct({
			type: Schema.Literal("task"),
			text: Schema.optional(Schema.String),
			status: Schema.optional(Schema.String),
		}),
		Schema.Struct({
			type: Schema.Literal("tool_call"),
			call_id: Schema.String,
			truncated: Schema.optional(
				Schema.Struct({
					args: Schema.optional(Schema.Boolean),
					result: Schema.optional(Schema.Boolean),
				}),
			),
		}),
		Schema.Struct({
			type: Schema.Literal(
				"status",
				"assistant",
				"thinking",
				"usage",
				"system",
				"user",
				"error",
				"result",
			),
		}),
	),
);

const decodeUsage = Schema.decodeUnknownEither(
	Schema.Struct({
		inputTokens: Schema.NonNegative,
		outputTokens: Schema.NonNegative,
		cacheReadTokens: Schema.NonNegative,
		cacheWriteTokens: Schema.NonNegative,
		reasoningTokens: Schema.optional(Schema.NonNegative),
	}),
);

/** Deltas own content; stream messages add correlation, truncation, progress and per-turn usage. */
export class CursorTurnEvents {
	private part = 0;
	private textPart: string | undefined;
	private thinkingPart: string | undefined;
	private progressText: string | undefined;
	private readonly truncatedTools = new Set<string>();
	private readonly tools = new Map<
		string,
		{
			startedAt: number;
			toolName: string;
			call: CursorToolCall;
			providerToolUseId: string;
			completed?: ProviderRuntimeEventPayloadMap["tool.completed"];
			truncated?: true;
			stdout: string;
			stderr: string;
		}
	>();
	private readonly lastShell = new Map<string, string>();
	private readonly results: CursorToolResults;
	private readonly questionSources = new Map<string, string>();
	tokens: TurnTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	contextTokens: number | undefined;
	readonly refs: {
		providerSessionId?: string | undefined;
		providerTurnId?: string | undefined;
		providerRequestId?: string | undefined;
	} = {};

	constructor(
		private readonly sessionId: string,
		readonly messageId: string,
		private readonly sink: EventSink,
		cwd: string,
	) {
		this.results = new CursorToolResults(cwd);
	}

	questionSource(callId: string): string | undefined {
		return this.questionSources.get(callId);
	}

	private trackQuestionSource(value: unknown, parent?: string): void {
		if (!Schema.is(RecordSchema)(value)) return;
		const callId = value["callId"];
		if (typeof callId !== "string") return;
		if (value["type"] === "tool-call-delta") {
			this.trackQuestionSource(
				value["taskUpdate"],
				this.questionSources.get(callId) ?? parent,
			);
			return;
		}
		const tool = value["toolCall"];
		if (Schema.is(RecordSchema)(tool) && tool["type"] === "task") {
			const args = tool["args"];
			if (!Schema.is(RecordSchema)(args)) return;
			const subagent = args["subagentType"];
			const name = Schema.is(RecordSchema)(subagent)
				? subagent["name"]
				: undefined;
			const label = name ?? args["description"] ?? args["agentId"];
			if (typeof label === "string") this.questionSources.set(callId, label);
		} else if (parent) {
			// 1.0.37 reports the parent in callback context.sessionId. Task's
			// nested call ID, rather than that context, identifies the asker.
			this.questionSources.set(callId, parent);
		}
	}

	push<K extends Exclude<ProviderRuntimeEventType, "workspace.changed">>(
		type: K,
		data: ProviderRuntimeEventPayloadMap[K],
		refs?: ProviderRuntimeProviderRefs,
	) {
		return this.sink.push({
			eventId: createEventId(),
			type,
			providerId: "cursor",
			sessionId: this.sessionId,
			providerRefs: {
				...this.refs,
				providerMessageId: this.messageId,
				...refs,
			},
			rawSource: { kind: "cursor.sdk.translator" },
			createdAt: Date.now(),
			data,
		});
	}

	stream(value: unknown) {
		return Effect.gen(this, function* () {
			const decoded = decodeStream(value);
			if (Either.isLeft(decoded)) {
				log.warn("Skipped malformed Cursor stream update", { payload: value });
				return;
			}
			if (decoded.right.type === "request")
				this.refs.providerRequestId = decoded.right.request_id;
			if (decoded.right.type === "task") {
				const text = decoded.right.text ?? decoded.right.status;
				if (text) yield* this.progress(text);
			}
			if (
				decoded.right.type === "tool_call" &&
				(decoded.right.truncated?.args || decoded.right.truncated?.result)
			) {
				const callId = decoded.right.call_id;
				this.truncatedTools.add(callId);
				const entry = [...this.tools.entries()].find(
					([, tool]) => tool.providerToolUseId === callId,
				);
				const tool = entry?.[1];
				if (tool) {
					tool.truncated = true;
					if (tool.completed) {
						tool.completed = {
							...tool.completed,
							metadata: { ...tool.completed.metadata, truncated: true },
						};
						yield* this.push("tool.completed", tool.completed, {
							providerToolUseId: tool.providerToolUseId,
						});
					} else
						yield* this.push(
							"tool.running",
							{
								messageId: this.messageId,
								partId: `${this.messageId}:tool:${entry?.[0] ?? callId}`,
								metadata: { cursorToolType: tool.call.type, truncated: true },
							},
							{ providerToolUseId: tool.providerToolUseId },
						);
				}
			}
			if (
				decoded.right.type === "usage" &&
				typeof value === "object" &&
				value &&
				"usage" in value
			) {
				const usage = decodeUsage(value.usage);
				if (Either.isLeft(usage)) {
					log.warn("Skipped malformed Cursor usage update");
					return;
				}
				this.contextTokens =
					usage.right.inputTokens +
					usage.right.cacheReadTokens +
					usage.right.cacheWriteTokens;
				this.tokens = {
					input: this.tokens.input + usage.right.inputTokens,
					output: this.tokens.output + usage.right.outputTokens,
					cacheRead: (this.tokens.cacheRead ?? 0) + usage.right.cacheReadTokens,
					cacheWrite:
						(this.tokens.cacheWrite ?? 0) + usage.right.cacheWriteTokens,
					...(usage.right.reasoningTokens !== undefined
						? {
								reasoning:
									(this.tokens.reasoning ?? 0) + usage.right.reasoningTokens,
							}
						: {}),
				};
			}
		});
	}

	reconcileUsage(value: unknown) {
		const usage = decodeUsage(value);
		if (Either.isLeft(usage)) return;
		// RunResult repeats the sum of every reported turn on this run, including
		// background follow-ups. Fill missing reports without adding the sum twice.
		this.tokens = {
			input: Math.max(this.tokens.input, usage.right.inputTokens),
			output: Math.max(this.tokens.output, usage.right.outputTokens),
			cacheRead: Math.max(
				this.tokens.cacheRead ?? 0,
				usage.right.cacheReadTokens,
			),
			cacheWrite: Math.max(
				this.tokens.cacheWrite ?? 0,
				usage.right.cacheWriteTokens,
			),
			...(usage.right.reasoningTokens !== undefined
				? {
						reasoning: Math.max(
							this.tokens.reasoning ?? 0,
							usage.right.reasoningTokens,
						),
					}
				: {}),
		};
	}

	endThinking() {
		return Effect.gen(this, function* () {
			if (!this.thinkingPart) return;
			yield* this.push("thinking.end", {
				messageId: this.messageId,
				partId: this.thinkingPart,
			});
			this.thinkingPart = undefined;
		});
	}

	delta(
		value: unknown,
		parentCallId?: string,
	): Effect.Effect<void, EventSinkError> {
		return Effect.gen(this, function* () {
			this.trackQuestionSource(value);
			const decoded = decodeDelta(value);
			if (Either.isLeft(decoded)) {
				log.warn("Skipped malformed Cursor delta update", { payload: value });
				return;
			}
			const update = decoded.right;
			if (
				parentCallId &&
				(update.type === "text-delta" || update.type === "thinking-delta")
			) {
				yield* this.progress(update.text, parentCallId);
				return;
			}
			switch (update.type) {
				case "text-delta":
					yield* this.endThinking();
					this.textPart ??= `${this.messageId}:text:${++this.part}`;
					yield* this.push("text.delta", {
						messageId: this.messageId,
						partId: this.textPart,
						text: update.text,
					});
					break;
				case "thinking-delta":
					this.textPart = undefined;
					if (!this.thinkingPart) {
						this.thinkingPart = `${this.messageId}:thinking:${++this.part}`;
						yield* this.push("thinking.start", {
							messageId: this.messageId,
							partId: this.thinkingPart,
						});
					}
					yield* this.push("thinking.delta", {
						messageId: this.messageId,
						partId: this.thinkingPart,
						text: update.text,
					});
					break;
				case "thinking-completed":
					yield* this.endThinking();
					break;
				case "tool-call-started":
				case "tool-call-completed":
				case "partial-tool-call": {
					yield* this.endThinking();
					this.textPart = undefined;
					const { toolCall } = update;
					const callId = parentCallId
						? `${parentCallId}:${update.callId}`
						: update.callId;
					const { toolName, input } = cursorToolInput(toolCall);
					if (!this.tools.has(callId)) {
						this.tools.set(callId, {
							startedAt: Date.now(),
							toolName,
							call: toolCall,
							providerToolUseId: update.callId,
							...(this.truncatedTools.has(update.callId)
								? { truncated: true as const }
								: {}),
							stdout: "",
							stderr: "",
						});
						if (toolCall.type === "shell")
							this.lastShell.set(parentCallId ?? "", callId);
						yield* this.push(
							"tool.started",
							{
								messageId: this.messageId,
								partId: `${this.messageId}:tool:${callId}`,
								callId: update.callId,
								toolName,
								input,
							},
							{ providerToolUseId: update.callId },
						);
						if (this.progressText)
							yield* this.push(
								"tool.running",
								{
									messageId: this.messageId,
									partId: `${this.messageId}:tool:${callId}`,
									metadata: {
										cursorToolType: toolCall.type,
										progress: this.progressText,
									},
								},
								{ providerToolUseId: update.callId },
							);
					}
					if (update.type === "tool-call-completed") {
						const tool = this.tools.get(callId);
						const completed = yield* this.results.complete(
							toolCall,
							tool?.truncated,
						);
						const data = {
							messageId: this.messageId,
							partId: `${this.messageId}:tool:${callId}`,
							result: completed.result,
							input,
							metadata: {
								...completed.metadata,
								...(tool?.truncated ? { truncated: true } : {}),
								...(parentCallId ? { parentToolCallId: parentCallId } : {}),
							},
							duration: Date.now() - (tool?.startedAt ?? Date.now()),
						};
						if (tool) tool.completed = data;
						yield* this.push("tool.completed", data, {
							providerToolUseId: update.callId,
						});
					} else if (update.type === "partial-tool-call") {
						yield* this.push(
							"tool.running",
							{
								messageId: this.messageId,
								partId: `${this.messageId}:tool:${callId}`,
								input,
								callId: update.callId,
								toolName,
								metadata: { cursorToolType: toolCall.type },
							},
							{ providerToolUseId: update.callId },
						);
					}
					break;
				}
				case "tool-requests-listed":
					yield* this.progress(
						`Running ${update.callCount} tool${update.callCount === 1 ? "" : "s"}`,
						parentCallId,
					);
					break;
				case "shell-output-delta":
					{
						const callId = this.lastShell.get(parentCallId ?? "");
						if (callId) yield* this.shellOutput(callId, update.event);
					}
					break;
				case "tool-call-delta":
					// Keep task calls generic; .10 owns their eventual child sessions.
					yield* this.delta(
						update.taskUpdate,
						parentCallId ? `${parentCallId}:${update.callId}` : update.callId,
					);
					break;
			}
		});
	}

	private shellOutput(
		callId: string,
		output: Readonly<Record<string, unknown>>,
	) {
		const tool = this.tools.get(callId);
		if (!tool || tool.completed) return Effect.void;
		const value = toRecord(output["value"]);
		const content = value["content"];
		if (typeof content === "string") {
			if (output["case"] === "stdout") tool.stdout += content;
			if (output["case"] === "stderr") tool.stderr += content;
		}
		return this.push(
			"tool.running",
			{
				messageId: this.messageId,
				partId: `${this.messageId}:tool:${callId}`,
				metadata: {
					cursorToolType: tool.call.type,
					output: tool.stdout + tool.stderr,
				},
			},
			{ providerToolUseId: tool.providerToolUseId },
		);
	}

	private progress(message: string, callId?: string) {
		return Effect.gen(this, function* () {
			this.progressText = message;
			const running = [...this.tools.entries()].filter(
				([, tool]) => !tool.completed,
			);
			const tail = running.at(-1)?.[0];
			const owner =
				callId ??
				running
					.reverse()
					.find(([, tool]) => tool.toolName === "cursor.task")?.[0] ??
				tail;
			yield* this.push("session.status", {
				sessionId: this.sessionId,
				status: "busy",
				message,
			});
			if (owner && this.tools.has(owner))
				yield* this.push(
					"tool.running",
					{
						messageId: this.messageId,
						partId: `${this.messageId}:tool:${owner}`,
						metadata: {
							cursorToolType: this.tools.get(owner)?.call.type,
							progress: message,
						},
					},
					{
						providerToolUseId:
							this.tools.get(owner)?.providerToolUseId ?? owner,
					},
				);
		});
	}
}
