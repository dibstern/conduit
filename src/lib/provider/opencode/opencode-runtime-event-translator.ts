import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
import { createLogger, type Logger } from "../../logger.js";
import {
	createEventId,
	type SessionStatusValue,
} from "../../persistence/events.js";
import { mapToolName } from "../../relay/event-translator.js";
import type { SSEEvent } from "../../relay/opencode-events.js";
import {
	isMessageCreatedEvent,
	isMessageUpdatedEvent,
	isPartDeltaEvent,
	isPartUpdatedEvent,
	isPermissionAskedEvent,
	isPermissionRepliedEvent,
	isQuestionAskedEvent,
	isSessionErrorEvent,
	isSessionStatusEvent,
	sessionErrorText,
} from "../../relay/opencode-events.js";
import { MonotoneText } from "../monotone-text.js";
import { normalizeToolInput } from "./normalize-tool-input.js";

interface TrackedPart {
	readonly type: string;
	readonly status?: string;
	readonly thinkingStarted?: boolean;
	/** Tool parts only: the input delivered downstream so far was empty (args stream late, e.g. skill). */
	readonly toolInputEmpty?: boolean;
}

const defaultLog = createLogger("opencode-runtime-event-translator");

/** One session's translation state: the messages already announced, what is
 *  known about each part, and the text already emitted for it. It is a value so
 *  a caller can translate into a fork and keep the fork only once the events it
 *  produced are durable — a batch that rolled back must translate again. */
export interface SessionTranslation {
	/** The reconnect generation this copy was forked from. A fork translated
	 *  before a reconnect may not restore the announcements that reconnect
	 *  deliberately discarded. */
	readonly epoch: number;
	readonly parts: Map<string, TrackedPart>;
	readonly seenMessages: Set<string>;
	/** Text already emitted per part. Owns what used to be an emitted-character
	 *  count: a count can only answer "is there more?", and answering it by
	 *  length is what let a rewritten part splice. */
	readonly emitted: MonotoneText;
}

export class OpenCodeRuntimeEventTranslator {
	private readonly committed = new Map<string, SessionTranslation>();
	/** Bumped by every reconnect. A number rather than a lock: it is written and
	 *  read synchronously, so no fiber can observe it half-applied and a reset
	 *  cannot interleave with a translation that is already in flight. */
	private epoch = 0;

	constructor(private readonly log: Logger = defaultLog) {}

	/** Translate and keep what was learned. Callers that persist the events must
	 *  use `forkSession`/`translateInto`/`commitSession` instead, so translation
	 *  state advances only when the events it produced do. */
	translate(
		event: SSEEvent,
		sessionId: string | undefined,
	): ProviderRuntimeEvent[] | null {
		if (!sessionId) return null;
		const working = this.forkSession(sessionId);
		const events = this.translateInto(event, sessionId, working);
		this.commitSession(sessionId, working);
		return events;
	}

	/** A working copy of a session's committed translation state. */
	forkSession(sessionId: string): SessionTranslation {
		const committed = this.committed.get(sessionId);
		return {
			epoch: this.epoch,
			parts: new Map(committed?.parts),
			seenMessages: new Set(committed?.seenMessages),
			emitted: committed?.emitted.clone() ?? new MonotoneText(),
		};
	}

	/** Make a working copy the session's state. A copy forked before a reconnect
	 *  keeps only its text ledger: the events it emitted are durable, so the
	 *  ledger must record them, but the announcements the reconnect dropped stay
	 *  dropped, or the reconnect would be silently undone for that session. */
	commitSession(sessionId: string, state: SessionTranslation): void {
		this.committed.set(
			sessionId,
			state.epoch === this.epoch
				? state
				: {
						epoch: this.epoch,
						parts: new Map(),
						seenMessages: new Set(),
						emitted: state.emitted,
					},
		);
	}

	translateInto(
		event: SSEEvent,
		sessionId: string,
		state: SessionTranslation,
	): ProviderRuntimeEvent[] | null {
		if (isMessageCreatedEvent(event)) {
			return this.translateMessageCreated(event, sessionId, state);
		}
		if (isPartDeltaEvent(event)) {
			return this.translatePartDelta(event, sessionId, state);
		}
		if (isPartUpdatedEvent(event)) {
			return this.translatePartUpdated(event, sessionId, state);
		}
		if (isMessageUpdatedEvent(event)) {
			return this.translateMessageUpdated(event, sessionId, state);
		}
		if (isSessionStatusEvent(event)) {
			return this.translateSessionStatus(event, sessionId);
		}
		if (isSessionErrorEvent(event)) {
			return this.translateSessionError(event, sessionId);
		}
		if (isPermissionAskedEvent(event)) {
			return this.translatePermissionAsked(event, sessionId);
		}
		if (isPermissionRepliedEvent(event)) {
			return this.translatePermissionReplied(event, sessionId);
		}
		if (isQuestionAskedEvent(event)) {
			return this.translateQuestionAsked(event, sessionId);
		}
		if (
			event.type === "question.replied" ||
			event.type === "question.rejected"
		) {
			const requestId = event.properties["requestID"];
			if (typeof requestId !== "string") return null;
			const answers = event.properties["answers"];
			return [
				opencodeRuntimeEvent("question.resolved", sessionId, event, {
					id: requestId,
					answers: Array.isArray(answers)
						? Object.fromEntries(
								answers.map((answer, index) => [String(index), answer]),
							)
						: {},
				}),
			];
		}
		if (event.type === "session.updated") {
			return this.translateSessionUpdated(event, sessionId);
		}

		return null;
	}

	/** Announce every message and part again, because a reconnected stream may
	 *  have dropped the events that explain them. The text ledger survives: it
	 *  records text already appended to the store, and re-emitting text is the
	 *  one thing the read model cannot absorb twice — "hello" would land as
	 *  "hellohello". Announcements are idempotent upserts, text is not. */
	resetAnnouncements(): void {
		this.epoch++;
		for (const [sessionId, state] of this.committed) {
			this.committed.set(sessionId, {
				epoch: this.epoch,
				parts: new Map(),
				seenMessages: new Set(),
				emitted: state.emitted,
			});
		}
	}

	/** What a refreshed part may still emit, or null when it may emit nothing.
	 *  A part whose text no longer extends what was already sent was rewritten
	 *  upstream: report it and send nothing, because slicing it at the old
	 *  length is what splices the tail of one text onto another. */
	private emittableSuffix(
		state: SessionTranslation,
		sessionId: string,
		partId: string,
		partText: string,
		kind: "text" | "reasoning",
	): string | null {
		const offer = state.emitted.offer(partId, partText);
		if (offer.kind === "emit") return offer.suffix;
		if (offer.kind === "diverged") {
			this.log.warn(
				`opencode ${kind} part no longer extends the text already sent; dropping it`,
				{
					sessionId,
					partId,
					emittedCharacters: offer.accepted.length,
					receivedCharacters: partText.length,
				},
			);
		}
		return null;
	}

	private markMessageSeen(
		state: SessionTranslation,
		messageId: string,
	): boolean {
		if (state.seenMessages.has(messageId)) return false;
		state.seenMessages.add(messageId);
		return true;
	}

	private translateMessageCreated(
		event: SSEEvent,
		sessionId: string,
		state: SessionTranslation,
	): ProviderRuntimeEvent[] | null {
		if (!isMessageCreatedEvent(event)) return null;
		const props = event.properties;
		const msg = props.info ?? props.message;
		const role = msg?.role;
		if (role !== "user" && role !== "assistant") return null;

		const messageId = props.messageID ?? "";
		if (!this.markMessageSeen(state, messageId)) return null;
		return [
			opencodeRuntimeEvent("message.created", sessionId, event, {
				messageId,
				role,
				sessionId,
			}),
		];
	}

	private translatePartDelta(
		event: SSEEvent,
		sessionId: string,
		state: SessionTranslation,
	): ProviderRuntimeEvent[] | null {
		if (!isPartDeltaEvent(event)) return null;
		const props = event.properties;
		const messageId = props.messageID ?? "";
		const partId = props.partID;
		const parts = state.parts;
		const tracked = parts.get(partId);

		if (tracked?.type === "reasoning") {
			parts.set(
				partId,
				trackedPart(tracked.type, tracked.status, tracked.thinkingStarted),
			);
			return [
				opencodeRuntimeEvent("thinking.delta", sessionId, event, {
					messageId,
					partId,
					text: state.emitted.append(partId, props.delta),
				}),
			];
		}

		if (props.field === "text" || props.field === "reasoning") {
			parts.set(
				partId,
				trackedPart(
					tracked?.type ?? props.field,
					tracked?.status,
					tracked?.thinkingStarted,
				),
			);
			return [
				opencodeRuntimeEvent("text.delta", sessionId, event, {
					messageId,
					partId,
					text: state.emitted.append(partId, props.delta),
				}),
			];
		}

		return null;
	}

	private translatePartUpdated(
		event: SSEEvent,
		sessionId: string,
		state: SessionTranslation,
	): ProviderRuntimeEvent[] | null {
		if (!isPartUpdatedEvent(event)) return null;
		const props = event.properties;
		const rawPart = props.part;
		if (!rawPart?.type) return null;

		const partId = props.partID ?? rawPart.id ?? "";
		// SDK 1.17.18 EventMessagePartUpdated.properties = { part, delta? }; the
		// message id lives on the part, not at the top level (same as part id).
		const messageId = rawPart.messageID ?? props.messageID ?? "";
		const parts = state.parts;
		const existing = parts.get(partId);
		const partText =
			"text" in rawPart && typeof rawPart.text === "string"
				? rawPart.text
				: undefined;

		parts.set(
			partId,
			trackedPart(
				rawPart.type,
				rawPart.state?.status,
				existing?.thinkingStarted,
				existing?.toolInputEmpty,
			),
		);

		if (rawPart.type === "reasoning") {
			const events: ProviderRuntimeEvent[] = [];
			if (!existing?.thinkingStarted) {
				parts.set(
					partId,
					trackedPart(rawPart.type, rawPart.state?.status, true),
				);
				events.push(
					opencodeRuntimeEvent("thinking.start", sessionId, event, {
						messageId,
						partId,
					}),
				);
			}
			const suffix =
				partText == null
					? null
					: this.emittableSuffix(
							state,
							sessionId,
							partId,
							partText,
							"reasoning",
						);
			if (suffix != null) {
				events.push(
					opencodeRuntimeEvent("thinking.delta", sessionId, event, {
						messageId,
						partId,
						text: suffix,
					}),
				);
			}
			if (rawPart.time?.end != null) {
				events.push(
					opencodeRuntimeEvent("thinking.end", sessionId, event, {
						messageId,
						partId,
					}),
				);
			}
			return events.length > 0 ? events : null;
		}

		if (rawPart.type === "text" && partText != null) {
			const suffix = this.emittableSuffix(
				state,
				sessionId,
				partId,
				partText,
				"text",
			);
			if (suffix != null) {
				return [
					opencodeRuntimeEvent("text.delta", sessionId, event, {
						messageId,
						partId,
						text: suffix,
					}),
				];
			}
		}

		if (rawPart.type === "tool") {
			const status = rawPart.state?.status;
			const toolName = mapToolName(rawPart.tool ?? "");
			const callId = rawPart.callID ?? partId;
			const metadata = isPlainObject(rawPart.state?.metadata)
				? rawPart.state.metadata
				: undefined;
			// Some tools (e.g. skill) stream input args after the part is first
			// seen, so tool.started can capture an empty input. Track that and
			// attach the refreshed input to the next lifecycle event once the
			// args arrive — never for tools whose input was complete at start.
			const hasInput =
				isPlainObject(rawPart.state?.input) &&
				Object.keys(rawPart.state.input).length > 0;
			const inputRefreshed = existing?.toolInputEmpty === true && hasInput;
			const stillEmpty = existing
				? existing.toolInputEmpty === true && !inputRefreshed
				: !hasInput;
			const setTracked = (toolInputEmpty: boolean) =>
				parts.set(
					partId,
					trackedPart(
						"tool",
						rawPart.state?.status,
						existing?.thinkingStarted,
						toolInputEmpty,
					),
				);

			if (status === "pending") {
				setTracked(stillEmpty);
				return [
					opencodeRuntimeEvent("tool.started", sessionId, event, {
						messageId,
						partId,
						toolName,
						callId,
						input: normalizeToolInput(toolName, rawPart.state?.input),
					}),
				];
			}

			if (status === "running") {
				setTracked(stillEmpty);
				const events: ProviderRuntimeEvent[] = [];
				if (!existing) {
					events.push(
						opencodeRuntimeEvent("tool.started", sessionId, event, {
							messageId,
							partId,
							toolName,
							callId,
							input: normalizeToolInput(toolName, rawPart.state?.input),
						}),
					);
				}
				events.push(
					opencodeRuntimeEvent("tool.running", sessionId, event, {
						messageId,
						partId,
						...(metadata ? { metadata } : {}),
						...(inputRefreshed
							? {
									input: normalizeToolInput(toolName, rawPart.state?.input),
									callId,
									toolName,
								}
							: {}),
					}),
				);
				return events;
			}

			if (status === "completed" || status === "error") {
				setTracked(stillEmpty);
				const duration =
					rawPart.time?.end && rawPart.time?.start
						? rawPart.time.end - rawPart.time.start
						: 0;
				return [
					opencodeRuntimeEvent("tool.completed", sessionId, event, {
						messageId,
						partId,
						result:
							status === "error"
								? (rawPart.state?.error ?? "Unknown error")
								: (rawPart.state?.output ?? ""),
						duration,
						...(metadata ? { metadata } : {}),
						...(inputRefreshed
							? { input: normalizeToolInput(toolName, rawPart.state?.input) }
							: {}),
					}),
				];
			}
		}

		if (rawPart.type === "file" && !existing) {
			if (typeof rawPart.mime !== "string" || typeof rawPart.url !== "string") {
				return null;
			}
			return [
				opencodeRuntimeEvent("file.attached", sessionId, event, {
					messageId,
					partId,
					mime: rawPart.mime,
					...(typeof rawPart.filename === "string"
						? { filename: rawPart.filename }
						: {}),
					url: rawPart.url,
				}),
			];
		}

		return null;
	}

	private translateMessageUpdated(
		event: SSEEvent,
		sessionId: string,
		state: SessionTranslation,
	): ProviderRuntimeEvent[] | null {
		if (!isMessageUpdatedEvent(event)) return null;
		const msg = event.properties.info ?? event.properties.message;
		if (!msg || (msg.role !== "user" && msg.role !== "assistant")) return null;

		const messageId = msg.id ?? "";
		const events: ProviderRuntimeEvent[] = [];
		if (this.markMessageSeen(state, messageId)) {
			events.push(
				opencodeRuntimeEvent("message.created", sessionId, event, {
					messageId,
					role: msg.role,
					sessionId,
				}),
			);
		}

		if (msg.role === "user" || msg.time?.completed == null) {
			return events.length > 0 ? events : null;
		}

		const tokens: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
			contextWindow?: number;
		} = {};
		if (msg.tokens?.input != null) tokens.input = msg.tokens.input;
		if (msg.tokens?.output != null) tokens.output = msg.tokens.output;
		if (msg.tokens?.cache?.read != null)
			tokens.cacheRead = msg.tokens.cache.read;
		if (msg.tokens?.cache?.write != null)
			tokens.cacheWrite = msg.tokens.cache.write;
		if (msg.tokens?.contextWindow != null)
			tokens.contextWindow = msg.tokens.contextWindow;

		const duration =
			msg.time?.completed && msg.time?.created
				? msg.time.completed - msg.time.created
				: undefined;
		const data: {
			messageId: string;
			cost?: number;
			tokens?: typeof tokens;
			duration?: number;
		} = { messageId };
		if (msg.cost != null) data.cost = msg.cost;
		if (Object.keys(tokens).length > 0) data.tokens = tokens;
		if (duration != null) data.duration = duration;

		events.push(opencodeRuntimeEvent("turn.completed", sessionId, event, data));
		return events;
	}

	private translateSessionStatus(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isSessionStatusEvent(event)) return null;
		const validStatuses: Record<string, SessionStatusValue> = {
			idle: "idle",
			busy: "busy",
			retry: "retry",
			error: "error",
		};
		const statusType = event.properties.status?.type;
		const status = statusType ? validStatuses[statusType] : undefined;
		if (!status) return null;

		return [
			opencodeRuntimeEvent("session.status", sessionId, event, {
				sessionId,
				status,
			}),
		];
	}

	private translateSessionError(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isSessionErrorEvent(event)) return null;
		return [
			opencodeRuntimeEvent("turn.error", sessionId, event, {
				messageId: "",
				error: sessionErrorText(event.properties.error),
				code: event.properties.error?.name ?? "Unknown",
			}),
		];
	}

	private translatePermissionAsked(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isPermissionAskedEvent(event)) return null;
		const props = event.properties;
		return [
			opencodeRuntimeEvent("permission.asked", sessionId, event, {
				id: props.id,
				sessionId,
				toolName: props.permission,
				input: {
					patterns: props.patterns ?? [],
					metadata: props.metadata ?? {},
				},
			}),
		];
	}

	private translatePermissionReplied(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isPermissionRepliedEvent(event)) return null;
		return [
			opencodeRuntimeEvent("permission.resolved", sessionId, event, {
				// `requestID` is the replied-to permission id (== asked event's
				// properties.id); `reply` is the actual decision. Verified via
				// live wire capture against opencode 1.17.18.
				id: event.properties.requestID,
				decision: event.properties.reply,
			}),
		];
	}

	private translateQuestionAsked(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isQuestionAskedEvent(event)) return null;
		return [
			opencodeRuntimeEvent("question.asked", sessionId, event, {
				id: event.properties.id,
				sessionId,
				questions: event.properties.questions,
			}),
		];
	}

	private translateSessionUpdated(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		const info = (event.properties as Record<string, unknown>)["info"];
		const title =
			isRecord(info) && typeof info["title"] === "string"
				? info["title"]
				: undefined;
		if (!title) return null;
		return [
			opencodeRuntimeEvent("session.renamed", sessionId, event, {
				sessionId,
				title,
			}),
		];
	}
}

export function opencodeSessionCreatedRuntimeEvent(
	sessionId: string,
	providerInstanceId: string,
): ProviderRuntimeEvent {
	return {
		eventId: `evt_opencode_session_created_${sessionId}`,
		type: "session.created",
		providerId: "opencode",
		sessionId,
		providerRefs: { providerSessionId: sessionId },
		rawSource: { kind: "conduit.opencode-runtime-ingress.session-seeder" },
		createdAt: Date.now(),
		data: {
			sessionId,
			title: "Untitled",
			provider: providerInstanceId,
		},
		metadata: {
			synthetic: true,
			source: "opencode-runtime-ingress",
		},
	};
}

function opencodeRuntimeEvent(
	type: ProviderRuntimeEvent["type"],
	sessionId: string,
	source: SSEEvent,
	data: Record<string, unknown>,
): ProviderRuntimeEvent {
	return {
		eventId: createEventId(),
		type,
		providerId: "opencode",
		sessionId,
		providerRefs: providerRefs(source, sessionId, data, type),
		rawSource: {
			kind: "opencode.sse",
			streamEventType: source.type,
		},
		createdAt: Date.now(),
		data,
	};
}

function providerRefs(
	source: SSEEvent,
	sessionId: string,
	data: Record<string, unknown>,
	type: ProviderRuntimeEvent["type"],
): ProviderRuntimeEvent["providerRefs"] {
	const props = source.properties as Record<string, unknown>;
	const refs: Record<string, string> = {};
	const providerSessionId = stringField(props["sessionID"]) ?? sessionId;
	const providerMessageId =
		stringField(props["messageID"]) ?? stringField(data["messageId"]);
	const providerToolUseId =
		stringField(data["callId"]) ??
		(type.startsWith("tool.") ? stringField(data["partId"]) : undefined);
	const providerRequestId =
		type.startsWith("permission.") || type.startsWith("question.")
			? stringField(data["id"])
			: undefined;

	if (providerSessionId) refs["providerSessionId"] = providerSessionId;
	if (providerMessageId) refs["providerMessageId"] = providerMessageId;
	if (providerToolUseId) refs["providerToolUseId"] = providerToolUseId;
	if (providerRequestId) refs["providerRequestId"] = providerRequestId;
	return refs;
}

function trackedPart(
	type: string,
	status?: string,
	thinkingStarted?: boolean,
	toolInputEmpty?: boolean,
): TrackedPart {
	return {
		type,
		...(status != null ? { status } : {}),
		...(thinkingStarted != null ? { thinkingStarted } : {}),
		...(toolInputEmpty != null ? { toolInputEmpty } : {}),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}
