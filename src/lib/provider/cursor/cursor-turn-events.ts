import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
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
import type { SessionOutput } from "../runner/session-runner.js";
import type { EventSink, TurnTokens } from "../types.js";
import {
	type CursorToolCall,
	CursorToolResults,
	cursorToolInput,
} from "./cursor-tool-events.js";

const log = createLogger("cursor-turn-events");
type ContentPart = {
	kind: "text" | "thinking";
	partId: string;
	text: string;
};
type MessagePart =
	ProviderRuntimeEventPayloadMap["message.snapshot"]["message"]["parts"][number];
type ChildSessionInput = Extract<
	SessionOutput,
	{ type: "ensure-subagent-session" }
>["input"];
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
	private textPart: ContentPart | undefined;
	private thinkingPart: ContentPart | undefined;
	private progressText: string | undefined;
	private readonly truncatedTools = new Set<string>();
	private readonly tools = new Map<
		string,
		{
			startedAt: number;
			messageId: string;
			toolName: string;
			call: CursorToolCall;
			providerToolUseId: string;
			completed?: ProviderRuntimeEventPayloadMap["tool.completed"];
			truncated?: true;
			stdout: string;
			stderr: string;
			metadata: Record<string, unknown>;
		}
	>();
	private readonly lastShell = new Map<string, string>();
	private readonly results: CursorToolResults;
	private readonly questionSources = new Map<string, string>();
	private nextMessage = false;
	private readonly content: Array<
		ContentPart | { kind: "tool"; callId: string }
	> = [];
	private readonly children = new Map<
		string,
		{
			events: CursorTurnEvents;
			metadata: Record<string, unknown>;
			active: boolean;
		}
	>();
	tokens: TurnTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	contextTokens: number | undefined;
	readonly refs: {
		providerSessionId?: string | undefined;
		providerTurnId?: string | undefined;
		providerRequestId?: string | undefined;
	} = {};

	constructor(
		private readonly sessionId: string,
		public messageId: string,
		private readonly sink: EventSink,
		private readonly cwd: string,
		private readonly childSession?: {
			readonly instanceId?: string | undefined;
			readonly ensure: (
				input: ChildSessionInput,
			) => Effect.Effect<void, EventSinkError>;
		},
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
					tool.metadata["truncated"] = true;
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
				partId: this.thinkingPart.partId,
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
				this.nextMessage &&
				(update.type === "text-delta" ||
					update.type === "thinking-delta" ||
					((update.type === "tool-call-started" ||
						update.type === "partial-tool-call") &&
						!this.tools.has(update.callId)))
			) {
				yield* this.endThinking();
				this.messageId = createEventId();
				this.textPart = undefined;
				this.content.length = 0;
				this.nextMessage = false;
				yield* this.push("message.created", {
					sessionId: this.sessionId,
					messageId: this.messageId,
					role: "assistant",
				});
			}
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
					if (!this.textPart) {
						this.textPart = {
							kind: "text",
							partId: `${this.messageId}:text:${++this.part}`,
							text: "",
						};
						this.content.push(this.textPart);
					}
					this.textPart.text += update.text;
					yield* this.push("text.delta", {
						messageId: this.messageId,
						partId: this.textPart.partId,
						text: update.text,
					});
					break;
				case "thinking-delta":
					this.textPart = undefined;
					if (!this.thinkingPart) {
						this.thinkingPart = {
							kind: "thinking",
							partId: `${this.messageId}:thinking:${++this.part}`,
							text: "",
						};
						this.content.push(this.thinkingPart);
						yield* this.push("thinking.start", {
							messageId: this.messageId,
							partId: this.thinkingPart.partId,
						});
					}
					this.thinkingPart.text += update.text;
					yield* this.push("thinking.delta", {
						messageId: this.messageId,
						partId: this.thinkingPart.partId,
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
					const toolMessageId =
						this.tools.get(callId)?.messageId ?? this.messageId;
					const child =
						toolCall.type === "task"
							? yield* this.ensureChild(update.callId, toolCall)
							: undefined;
					if (!this.tools.has(callId)) {
						this.tools.set(callId, {
							startedAt: Date.now(),
							messageId: toolMessageId,
							toolName,
							call: toolCall,
							providerToolUseId: update.callId,
							...(this.truncatedTools.has(update.callId)
								? { truncated: true as const }
								: {}),
							stdout: "",
							stderr: "",
							metadata: {
								cursorToolType: toolCall.type,
								...child?.metadata,
								...(this.progressText ? { progress: this.progressText } : {}),
							},
						});
						this.content.push({ kind: "tool", callId });
						if (toolCall.type === "shell")
							this.lastShell.set(parentCallId ?? "", callId);
						yield* this.push(
							"tool.started",
							{
								messageId: toolMessageId,
								partId: `${toolMessageId}:tool:${callId}`,
								callId: update.callId,
								toolName,
								input,
							},
							{ providerToolUseId: update.callId },
						);
						if (child)
							yield* this.push(
								"tool.running",
								{
									messageId: toolMessageId,
									partId: `${toolMessageId}:tool:${callId}`,
									metadata: child.metadata,
								},
								{ providerToolUseId: update.callId },
							);
						if (this.progressText)
							yield* this.push(
								"tool.running",
								{
									messageId: toolMessageId,
									partId: `${toolMessageId}:tool:${callId}`,
									metadata: {
										cursorToolType: toolCall.type,
										progress: this.progressText,
									},
								},
								{ providerToolUseId: update.callId },
							);
					}
					const tool = this.tools.get(callId);
					if (child && tool) Object.assign(tool.metadata, child.metadata);
					if (child && !tool?.completed)
						yield* this.push(
							"tool.running",
							{
								messageId: toolMessageId,
								partId: `${toolMessageId}:tool:${callId}`,
								input,
								metadata: child.metadata,
							},
							{ providerToolUseId: update.callId },
						);
					if (update.type === "tool-call-completed") {
						if (tool?.completed) {
							if (child) yield* child.events.reconcileTask(toolCall.result);
							break;
						}
						if (child) yield* child.events.reconcileTask(toolCall.result);
						if (
							child &&
							toRecord(toRecord(toolCall.result)["value"])["isBackground"] ===
								true
						) {
							Object.assign(child.metadata, { backgrounded: true });
							if (tool) Object.assign(tool.metadata, child.metadata);
							// The session projector reads the existing part before applying
							// completion, so background liveness must be stamped first.
							yield* this.push(
								"tool.running",
								{
									messageId: toolMessageId,
									partId: `${toolMessageId}:tool:${callId}`,
									metadata: child.metadata,
								},
								{ providerToolUseId: update.callId },
							);
						}
						const completed = yield* this.results.complete(
							toolCall,
							tool?.truncated,
						);
						const data = {
							messageId: toolMessageId,
							partId: `${toolMessageId}:tool:${callId}`,
							result: completed.result,
							input,
							metadata: {
								...tool?.metadata,
								...completed.metadata,
								...child?.metadata,
								...(tool?.truncated ? { truncated: true } : {}),
								...(parentCallId ? { parentToolCallId: parentCallId } : {}),
							},
							duration: Date.now() - (tool?.startedAt ?? Date.now()),
						};
						if (tool) {
							tool.metadata = data.metadata;
							tool.completed = data;
						}
						yield* this.push("tool.completed", data, {
							providerToolUseId: update.callId,
						});
						if (child) {
							const envelope = toRecord(toolCall.result);
							const value = toRecord(envelope["value"]);
							if (envelope["status"] === "error") {
								yield* child.events.finishChild("error");
								child.active = false;
							} else if (
								envelope["status"] === "success" &&
								value["isBackground"] === false
							) {
								yield* child.events.finishChild("completed");
								child.active = false;
							}
						}
					} else if (update.type === "partial-tool-call") {
						yield* this.push(
							"tool.running",
							{
								messageId: toolMessageId,
								partId: `${toolMessageId}:tool:${callId}`,
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
					{
						const child = this.children.get(update.callId);
						if (child) yield* child.events.delta(update.taskUpdate);
					}
					break;
				case "turn-ended":
					this.nextMessage = true;
					break;
			}
		});
	}

	private ensureChild(callId: string, call: CursorToolCall) {
		return Effect.gen(this, function* () {
			const existing = this.children.get(callId);
			const childSessionId = `cursor-subagent-${createHash("sha256").update(`${this.sessionId}\0${callId}`).digest("hex").slice(0, 24)}`;
			const model = call.args["model"];
			if (
				!existing ||
				(typeof model === "string" &&
					model !== existing.metadata["subagentModel"])
			)
				yield* this.childSession?.ensure({
					childSessionId,
					parentSessionId: this.sessionId,
					providerSessionId: callId,
					title:
						typeof call.args["description"] === "string"
							? call.args["description"]
							: "Cursor subagent",
					...(this.childSession.instanceId
						? { instanceId: this.childSession.instanceId }
						: {}),
					...(typeof model === "string" ? { modelId: model } : {}),
				}) ?? Effect.void;
			if (existing) {
				if (typeof model === "string")
					existing.metadata["subagentModel"] = model;
				if (typeof call.args["mode"] === "string")
					existing.metadata["subagentMode"] = call.args["mode"];
				return existing;
			}
			const events = new CursorTurnEvents(
				childSessionId,
				createEventId(),
				this.sink,
				this.cwd,
				this.childSession,
			);
			Object.assign(events.refs, this.refs);
			const child = {
				events,
				active: true,
				metadata: {
					childSessionId,
					...(typeof model === "string" ? { subagentModel: model } : {}),
					...(typeof call.args["mode"] === "string"
						? { subagentMode: call.args["mode"] }
						: {}),
				},
			};
			this.children.set(callId, child);
			yield* events.push("session.status", {
				sessionId: childSessionId,
				status: "busy",
			});
			yield* events.push("message.created", {
				sessionId: childSessionId,
				messageId: events.messageId,
				role: "assistant",
			});
			return child;
		});
	}

	private reconcileTask(result: unknown) {
		return Effect.gen(this, function* () {
			const value = toRecord(toRecord(result)["value"]);
			const steps = value["conversationSteps"];
			// Background results can precede more live updates. Only foreground
			// completion is an authoritative transcript; Run.wait finishes the rest.
			if (value["isBackground"] !== false || !Array.isArray(steps)) return;
			const before = this.messageParts();
			const live = {
				text: this.content.filter(
					(part): part is ContentPart => part.kind === "text",
				),
				thinking: this.content.filter(
					(part): part is ContentPart => part.kind === "thinking",
				),
			};
			const offsets = { text: 0, thinking: 0 };
			const ordered: typeof this.content = [];
			for (const step of steps) {
				const row = toRecord(step);
				for (const [key, kind] of [
					["assistantMessage", "text"],
					["thinkingMessage", "thinking"],
				] as const) {
					const text = toRecord(row[key])["text"];
					if (typeof text !== "string") continue;
					ordered.push({
						kind,
						partId:
							live[kind][offsets[kind]++]?.partId ??
							`${this.messageId}:${kind}:${++this.part}`,
						text,
					});
				}
				const tool = toRecord(row["toolCall"]);
				const callId = tool["toolCallId"];
				if (typeof callId !== "string") continue;
				if (!this.tools.get(callId)?.completed) {
					const entry = Object.entries(tool).find(([key]) =>
						key.endsWith("ToolCall"),
					);
					if (!entry) continue;
					const [name, payload] = entry;
					const wire = toRecord(payload);
					const outcome = toRecord(wire["result"]);
					// Serialized kinds absent from the public ToolCall union stay generic.
					yield* this.delta({
						type: "tool-call-completed",
						callId,
						toolCall: {
							type: name,
							args: toRecord(wire["args"]),
							result:
								"success" in outcome
									? { status: "success", value: outcome["success"] }
									: { status: "error", error: outcome["error"] ?? outcome },
						},
					});
				}
				ordered.push({ kind: "tool", callId });
			}
			this.content.splice(0, this.content.length, ...ordered);
			this.textPart = undefined;
			const parts = this.messageParts();
			if (isDeepStrictEqual(before, parts)) return;
			const message = {
				id: this.messageId,
				sessionID: this.sessionId,
				role: "assistant" as const,
				parts,
			};
			yield* this.push("message.snapshot", {
				messageId: this.messageId,
				digest: createHash("sha256")
					.update(JSON.stringify(message))
					.digest("hex"),
				message,
			});
		});
	}

	private messageParts(): MessagePart[] {
		return this.content.flatMap<MessagePart>((part) => {
			if (part.kind !== "tool")
				return [{ id: part.partId, type: part.kind, text: part.text }];
			const tool = this.tools.get(part.callId);
			if (!tool) return [];
			return [
				{
					id: `${tool.messageId}:tool:${part.callId}`,
					type: "tool",
					tool: tool.toolName,
					callID: tool.providerToolUseId,
					time: {
						start: tool.startedAt,
						...(tool.completed
							? { end: tool.startedAt + (tool.completed.duration ?? 0) }
							: {}),
					},
					state: {
						status: tool.completed
							? tool.metadata["isError"] === true
								? "error"
								: "completed"
							: "running",
						input: tool.completed?.input ?? cursorToolInput(tool.call).input,
						output:
							typeof tool.completed?.result === "string"
								? tool.completed.result
								: JSON.stringify(tool.completed?.result),
						metadata: tool.metadata,
					},
				},
			];
		});
	}

	finishChildren(
		status: "completed" | "interrupted" | "error",
	): Effect.Effect<void, EventSinkError> {
		return Effect.gen(this, function* () {
			for (const [callId, child] of this.children) {
				if (!child.active) continue;
				yield* child.events.finishChild(status);
				child.active = false;
				const tool = this.tools.get(callId);
				if (tool) {
					const metadata = {
						...child.metadata,
						outcome:
							status === "completed"
								? "completed"
								: status === "interrupted"
									? "stopped"
									: "failed",
					};
					Object.assign(tool.metadata, metadata);
					if (tool.completed)
						tool.completed = {
							...tool.completed,
							metadata: { ...tool.completed.metadata, ...metadata },
						};
					yield* this.push(
						"tool.running",
						{
							messageId: tool.messageId,
							partId: `${tool.messageId}:tool:${callId}`,
							metadata,
						},
						{ providerToolUseId: callId },
					);
				}
			}
		});
	}

	private finishChild(
		status: "completed" | "interrupted" | "error",
	): Effect.Effect<void, EventSinkError> {
		return Effect.gen(this, function* () {
			yield* this.finishChildren(status);
			yield* this.endThinking();
			if (status === "completed")
				yield* this.push("turn.completed", { messageId: this.messageId });
			else if (status === "interrupted")
				yield* this.push("turn.interrupted", { messageId: this.messageId });
			else
				yield* this.push("turn.error", {
					messageId: this.messageId,
					error: "Parent Cursor run failed",
				});
			yield* this.push("session.status", {
				sessionId: this.sessionId,
				status: "idle",
			});
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
		const metadata = {
			cursorToolType: tool.call.type,
			output: tool.stdout + tool.stderr,
		};
		Object.assign(tool.metadata, metadata);
		return this.push(
			"tool.running",
			{
				messageId: tool.messageId,
				partId: `${tool.messageId}:tool:${callId}`,
				metadata,
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
				running.reverse().find(([, tool]) => tool.call.type === "task")?.[0] ??
				tail;
			yield* this.push("session.status", {
				sessionId: this.sessionId,
				status: "busy",
				message,
			});
			const tool = owner ? this.tools.get(owner) : undefined;
			if (tool) {
				const metadata = { cursorToolType: tool.call.type, progress: message };
				Object.assign(tool.metadata, metadata);
				yield* this.push(
					"tool.running",
					{
						messageId: tool.messageId,
						partId: `${tool.messageId}:tool:${owner}`,
						metadata,
					},
					{
						providerToolUseId: tool.providerToolUseId,
					},
				);
			}
		});
	}
}
