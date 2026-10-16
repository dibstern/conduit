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
	private textPart: string | undefined;
	private thinkingPart: string | undefined;
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
	private nextMessage = false;
	private readonly content: Array<{
		kind: "text" | "thinking";
		partId: string;
		text: string;
	}> = [];
	private readonly reconciledContent = new Map<string, string>();
	private pendingReconcile:
		| { result: unknown; content: ReadonlyMap<string, string> }
		| undefined;
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

	push<K extends Exclude<ProviderRuntimeEventType, "workspace.changed">>(
		type: K,
		data: ProviderRuntimeEventPayloadMap[K],
		refs?: ProviderRuntimeProviderRefs,
	) {
		return this.sink
			.push({
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
			})
			.pipe(
				Effect.tap(() =>
					Effect.sync(() => {
						if (type !== "tool.running" && type !== "tool.completed") return;
						const payload = toRecord(data);
						const tool = [...this.tools].find(
							([callId, tool]) =>
								`${tool.messageId}:tool:${callId}` === payload["partId"],
						)?.[1];
						if (!tool) return;
						Object.assign(tool.metadata, toRecord(payload["metadata"]));
						if (tool.completed)
							tool.completed = {
								...tool.completed,
								metadata: { ...tool.metadata },
							};
					}),
				),
			);
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
						this.textPart = `${this.messageId}:text:${++this.part}`;
						this.content.push({
							kind: "text",
							partId: this.textPart,
							text: "",
						});
					}
					{
						const part = this.content.find(
							(part) => part.partId === this.textPart,
						);
						if (part) part.text += update.text;
					}
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
						this.content.push({
							kind: "thinking",
							partId: this.thinkingPart,
							text: "",
						});
						yield* this.push("thinking.start", {
							messageId: this.messageId,
							partId: this.thinkingPart,
						});
					}
					{
						const part = this.content.find(
							(part) => part.partId === this.thinkingPart,
						);
						if (part) part.text += update.text;
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
							metadata: {},
						});
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
					if (child && !this.tools.get(callId)?.completed)
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
						const tool = this.tools.get(callId);
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
								...completed.metadata,
								...child?.metadata,
								...(tool?.truncated ? { truncated: true } : {}),
								...(parentCallId ? { parentToolCallId: parentCallId } : {}),
							},
							duration: Date.now() - (tool?.startedAt ?? Date.now()),
						};
						if (tool) tool.completed = data;
						yield* this.push("tool.completed", data, {
							providerToolUseId: update.callId,
						});
						if (child) {
							const envelope = toRecord(toolCall.result);
							const value = toRecord(envelope["value"]);
							if (envelope["status"] === "error") {
								yield* child.events.finishChildren("error");
								child.active = false;
							} else if (
								envelope["status"] === "success" &&
								value["isBackground"] === false
							) {
								yield* child.events.finishChildren("completed");
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
		// A snapshot seals durable history. Background children still stream,
		// so defer their snapshot reconciliation until Run.wait settles.
		if (toRecord(toRecord(result)["value"])["isBackground"] === true) {
			if (
				this.pendingReconcile &&
				isDeepStrictEqual(this.pendingReconcile.result, result)
			)
				return Effect.void;
			this.pendingReconcile = {
				result,
				content: new Map(this.content.map((part) => [part.partId, part.text])),
			};
			return Effect.void;
		}
		return this.reconcile(result);
	}

	/** Match live content in order; a snapshot can fill steps never streamed. */
	private reconcile(result: unknown, baseline?: ReadonlyMap<string, string>) {
		return Effect.gen(this, function* () {
			const value = toRecord(toRecord(result)["value"]);
			const steps = value["conversationSteps"];
			if (!Array.isArray(steps)) return;
			const authoritative = value["isBackground"] === false;
			const live = [...this.content];
			const used = new Set<string>();
			const offsets = { text: 0, thinking: 0 };
			const ordered: Array<
				ProviderRuntimeEventPayloadMap["message.snapshot"]["message"]["parts"][number]
			> = [];
			let previous = -1;
			let needsSnapshot = false;
			for (const step of steps) {
				const row = toRecord(step);
				for (const [key, kind] of [
					["assistantMessage", "text"],
					["thinkingMessage", "thinking"],
				] as const) {
					const text = toRecord(row[key])["text"];
					if (typeof text !== "string") continue;
					const position = `${kind}:${offsets[kind]++}`;
					const reconciledId = this.reconciledContent.get(position);
					const index = live.findIndex((part, index) => {
						if (reconciledId) return part.partId === reconciledId;
						if (index <= previous || part.kind !== kind) return false;
						const before = baseline?.get(part.partId) ?? part.text;
						if (baseline && !baseline.has(part.partId)) return false;
						if (!authoritative && before.startsWith(text)) return true;
						// A callback gap can omit a prefix or middle chunk, too.
						const characters = [...before];
						let matched = 0;
						for (const character of text)
							if (characters[matched] === character) matched++;
						return matched === characters.length;
					});
					let part = index === -1 ? undefined : live[index];
					if (part) {
						previous = index;
						const before = baseline?.get(part.partId) ?? part.text;
						const baseText =
							!authoritative && before.startsWith(text) ? before : text;
						const finalText =
							baseText + (baseline ? part.text.slice(before.length) : "");
						const prefix = finalText.startsWith(part.text);
						const suffix = prefix ? finalText.slice(part.text.length) : "";
						if (!prefix) needsSnapshot = true;
						part.text = finalText;
						if (suffix)
							yield* this.push(
								kind === "text" ? "text.delta" : "thinking.delta",
								{
									messageId: this.messageId,
									partId: part.partId,
									text: suffix,
								},
							);
					} else {
						// Reuse a previously reconciled missing part on a repeated snapshot.
						part = this.content.find(
							(candidate) =>
								!used.has(candidate.partId) &&
								!live.some((item) => item.partId === candidate.partId) &&
								candidate.kind === kind &&
								candidate.text === text,
						);
						if (!part) {
							part = {
								kind,
								partId: `${this.messageId}:${kind}:${++this.part}`,
								text,
							};
							this.content.push(part);
							yield* this.push(
								kind === "text" ? "text.delta" : "thinking.delta",
								{ messageId: this.messageId, partId: part.partId, text },
							);
						}
						needsSnapshot = true;
					}
					used.add(part.partId);
					this.reconciledContent.set(position, part.partId);
					ordered.push({ id: part.partId, type: kind, text: part.text });
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
					needsSnapshot = true;
				}
				const mapped = this.tools.get(callId);
				if (mapped?.completed)
					ordered.push({
						id: `${this.messageId}:tool:${callId}`,
						type: "tool",
						tool: mapped.toolName,
						callID: callId,
						time: {
							start: mapped.startedAt,
							end: mapped.startedAt + (mapped.completed.duration ?? 0),
						},
						state: {
							status:
								mapped.completed.metadata?.["isError"] === true
									? "error"
									: "completed",
							input: mapped.completed.input,
							output:
								typeof mapped.completed.result === "string"
									? mapped.completed.result
									: JSON.stringify(mapped.completed.result),
							metadata: mapped.metadata,
						},
					});
			}
			if (authoritative && this.content.some((part) => !used.has(part.partId)))
				needsSnapshot = true;
			if (needsSnapshot) {
				for (const part of this.content)
					if (!authoritative && !used.has(part.partId))
						ordered.push({ id: part.partId, type: part.kind, text: part.text });
				const known = new Set(ordered.map(({ id }) => id));
				for (const [callId, tool] of this.tools) {
					const id = `${this.messageId}:tool:${callId}`;
					if (!known.has(id))
						ordered.push({
							id,
							type: "tool",
							tool: tool.toolName,
							callID: callId,
							time: {
								start: tool.startedAt,
								...(tool.completed
									? { end: tool.startedAt + (tool.completed.duration ?? 0) }
									: {}),
							},
							state: {
								status: tool.completed
									? tool.completed.metadata?.["isError"] === true
										? "error"
										: "completed"
									: "running",
								input:
									tool.completed?.input ?? cursorToolInput(tool.call).input,
								output:
									typeof tool.completed?.result === "string"
										? tool.completed.result
										: JSON.stringify(tool.completed?.result),
								metadata: tool.metadata,
							},
						});
				}
				const message = {
					id: this.messageId,
					sessionID: this.sessionId,
					role: "assistant" as const,
					parts: ordered,
				};
				yield* this.push("message.snapshot", {
					messageId: this.messageId,
					digest: createHash("sha256")
						.update(JSON.stringify(message))
						.digest("hex"),
					message,
				});
			}
		});
	}

	finishChildren(
		status: "completed" | "interrupted" | "error",
		self = true,
	): Effect.Effect<void, EventSinkError> {
		return Effect.gen(this, function* () {
			for (const [callId, child] of this.children) {
				if (!child.active) continue;
				yield* child.events.finishChildren(status);
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
			yield* this.endThinking();
			if (this.pendingReconcile !== undefined) {
				yield* this.reconcile(
					this.pendingReconcile.result,
					this.pendingReconcile.content,
				);
				this.pendingReconcile = undefined;
			}
			if (!self) return;
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
				running.reverse().find(([, tool]) => tool.call.type === "task")?.[0] ??
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
