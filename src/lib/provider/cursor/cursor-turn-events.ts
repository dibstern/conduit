import { Effect, Either, Schema } from "effect";
import type {
	ProviderRuntimeEventPayloadMap,
	ProviderRuntimeEventType,
	ProviderRuntimeProviderRefs,
} from "../../contracts/providers/provider-runtime-event.js";
import { createLogger } from "../../logger.js";
import { createEventId } from "../../persistence/events.js";
import type { EventSink } from "../types.js";

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
			type: Schema.Literal(
				"token-delta",
				"step-started",
				"step-completed",
				"turn-ended",
				"tool-requests-listed",
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
			type: Schema.Literal(
				"status",
				"assistant",
				"thinking",
				"tool_call",
				"usage",
				"system",
				"user",
				"error",
				"result",
			),
		}),
	),
);

/** Deltas own content; the message stream supplies correlation only. */
export class CursorTurnEvents {
	private part = 0;
	private textPart: string | undefined;
	private thinkingPart: string | undefined;
	private readonly tools = new Map<string, number>();
	private lastTool: string | undefined;
	readonly refs: {
		providerSessionId?: string | undefined;
		providerTurnId?: string | undefined;
		providerRequestId?: string | undefined;
	} = {};

	constructor(
		private readonly sessionId: string,
		readonly messageId: string,
		private readonly sink: EventSink,
	) {}

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
		return Effect.sync(() => {
			const decoded = decodeStream(value);
			if (Either.isLeft(decoded)) {
				log.warn("Skipped malformed Cursor stream update", { payload: value });
				return;
			}
			if (decoded.right.type === "request")
				this.refs.providerRequestId = decoded.right.request_id;
		});
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

	delta(value: unknown) {
		return Effect.gen(this, function* () {
			const decoded = decodeDelta(value);
			if (Either.isLeft(decoded)) {
				log.warn("Skipped malformed Cursor delta update", { payload: value });
				return;
			}
			const update = decoded.right;
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
					const { callId, toolCall } = update;
					const input = {
						tool: "Unknown" as const,
						name: toolCall.type,
						raw: toolCall.args,
					};
					if (!this.tools.has(callId)) {
						this.tools.set(callId, Date.now());
						this.lastTool = callId;
						yield* this.push(
							"tool.started",
							{
								messageId: this.messageId,
								partId: callId,
								callId,
								toolName: toolCall.type,
								input,
							},
							{ providerToolUseId: callId },
						);
					}
					if (update.type === "tool-call-completed") {
						yield* this.push(
							"tool.completed",
							{
								messageId: this.messageId,
								partId: callId,
								result: toolCall.result ?? null,
								input,
								duration: Date.now() - (this.tools.get(callId) ?? Date.now()),
							},
							{ providerToolUseId: callId },
						);
						this.tools.delete(callId);
					} else if (update.type === "partial-tool-call") {
						yield* this.push(
							"tool.running",
							{
								messageId: this.messageId,
								partId: callId,
								input,
								callId,
								toolName: toolCall.type,
							},
							{ providerToolUseId: callId },
						);
					}
					break;
				}
				case "shell-output-delta":
					if (this.lastTool)
						yield* this.shellOutput(this.lastTool, update.event);
					break;
				case "tool-call-delta":
					// Nested task rendering belongs to the subagent ticket. Shell output
					// stays on its owning generic tool row without duplicating content.
					if (update.taskUpdate["type"] === "shell-output-delta") {
						yield* this.shellOutput(update.callId, update.taskUpdate);
					}
					break;
			}
		});
	}

	private shellOutput(
		callId: string,
		output: Readonly<Record<string, unknown>>,
	) {
		return this.push(
			"tool.running",
			{
				messageId: this.messageId,
				partId: callId,
				metadata: { shellOutput: output },
			},
			{ providerToolUseId: callId },
		);
	}
}
