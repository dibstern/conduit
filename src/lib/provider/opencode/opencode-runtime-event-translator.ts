import type { ProviderRuntimeEvent } from "../../contracts/providers/provider-runtime-event.js";
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
} from "../../relay/opencode-events.js";
import { normalizeToolInput } from "./normalize-tool-input.js";

interface TrackedPart {
	readonly type: string;
	readonly status?: string;
	readonly thinkingStarted?: boolean;
}

export class OpenCodeRuntimeEventTranslator {
	private readonly sessions = new Map<string, Map<string, TrackedPart>>();

	translate(
		event: SSEEvent,
		sessionId: string | undefined,
	): ProviderRuntimeEvent[] | null {
		if (!sessionId) return null;

		if (isMessageCreatedEvent(event)) {
			return this.translateMessageCreated(event, sessionId);
		}
		if (isPartDeltaEvent(event)) {
			return this.translatePartDelta(event, sessionId);
		}
		if (isPartUpdatedEvent(event)) {
			return this.translatePartUpdated(event, sessionId);
		}
		if (isMessageUpdatedEvent(event)) {
			return this.translateMessageUpdated(event, sessionId);
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
		if (event.type === "session.updated") {
			return this.translateSessionUpdated(event, sessionId);
		}

		return null;
	}

	reset(sessionId?: string): void {
		if (sessionId != null) {
			this.sessions.delete(sessionId);
		} else {
			this.sessions.clear();
		}
	}

	getTrackedParts(
		sessionId: string,
	): ReadonlyMap<string, TrackedPart> | undefined {
		return this.sessions.get(sessionId);
	}

	private getOrCreateParts(sessionId: string): Map<string, TrackedPart> {
		let parts = this.sessions.get(sessionId);
		if (!parts) {
			parts = new Map();
			this.sessions.set(sessionId, parts);
		}
		return parts;
	}

	private translateMessageCreated(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isMessageCreatedEvent(event)) return null;
		const props = event.properties;
		const msg = props.info ?? props.message;
		const role = msg?.role;
		if (role !== "user" && role !== "assistant") return null;

		const messageId = props.messageID ?? "";
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
	): ProviderRuntimeEvent[] | null {
		if (!isPartDeltaEvent(event)) return null;
		const props = event.properties;
		const messageId = props.messageID ?? "";
		const partId = props.partID;
		const tracked = this.getOrCreateParts(sessionId).get(partId);

		if (tracked?.type === "reasoning") {
			return [
				opencodeRuntimeEvent("thinking.delta", sessionId, event, {
					messageId,
					partId,
					text: props.delta,
				}),
			];
		}

		if (props.field === "text" || props.field === "reasoning") {
			return [
				opencodeRuntimeEvent("text.delta", sessionId, event, {
					messageId,
					partId,
					text: props.delta,
				}),
			];
		}

		return null;
	}

	private translatePartUpdated(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isPartUpdatedEvent(event)) return null;
		const props = event.properties;
		const rawPart = props.part;
		if (!rawPart?.type) return null;

		const partId = props.partID ?? rawPart.id ?? "";
		// SDK 1.17.18 EventMessagePartUpdated.properties = { part, delta? }; the
		// message id lives on the part, not at the top level (same as part id).
		const messageId = rawPart.messageID ?? props.messageID ?? "";
		const parts = this.getOrCreateParts(sessionId);
		const existing = parts.get(partId);

		parts.set(
			partId,
			trackedPart(
				rawPart.type,
				rawPart.state?.status,
				existing?.thinkingStarted,
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

		if (rawPart.type === "tool") {
			const status = rawPart.state?.status;
			const toolName = mapToolName(rawPart.tool ?? "");
			const callId = rawPart.callID ?? partId;

			if (status === "pending") {
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
					}),
				);
				return events;
			}

			if (status === "completed" || status === "error") {
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
					}),
				];
			}
		}

		return null;
	}

	private translateMessageUpdated(
		event: SSEEvent,
		sessionId: string,
	): ProviderRuntimeEvent[] | null {
		if (!isMessageUpdatedEvent(event)) return null;
		const msg = event.properties.info ?? event.properties.message;
		if (!msg || msg.role !== "assistant") return null;

		const tokens: {
			input?: number;
			output?: number;
			cacheRead?: number;
			cacheWrite?: number;
		} = {};
		if (msg.tokens?.input != null) tokens.input = msg.tokens.input;
		if (msg.tokens?.output != null) tokens.output = msg.tokens.output;
		if (msg.tokens?.cache?.read != null)
			tokens.cacheRead = msg.tokens.cache.read;
		if (msg.tokens?.cache?.write != null)
			tokens.cacheWrite = msg.tokens.cache.write;

		const duration =
			msg.time?.completed && msg.time?.created
				? msg.time.completed - msg.time.created
				: undefined;
		const data: {
			messageId: string;
			cost?: number;
			tokens?: typeof tokens;
			duration?: number;
		} = { messageId: msg.id ?? "" };
		if (msg.cost != null) data.cost = msg.cost;
		if (Object.keys(tokens).length > 0) data.tokens = tokens;
		if (duration != null) data.duration = duration;

		return [opencodeRuntimeEvent("turn.completed", sessionId, event, data)];
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
				error: event.properties.error?.data?.message ?? "An error occurred",
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
				id: event.properties.permissionID,
				// OpenCode 1.17.18 reports the actual reply ("once" | "always" |
				// "reject"); it was previously hardcoded to "once".
				decision: event.properties.response,
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
): ProviderRuntimeEvent {
	return {
		eventId: createEventId(),
		type: "session.created",
		providerId: "opencode",
		sessionId,
		providerRefs: { providerSessionId: sessionId },
		rawSource: { kind: "conduit.opencode-runtime-ingress.session-seeder" },
		createdAt: Date.now(),
		data: {
			sessionId,
			title: "Untitled",
			provider: "opencode",
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
): TrackedPart {
	return {
		type,
		...(status != null ? { status } : {}),
		...(thinkingStarted != null ? { thinkingStarted } : {}),
	};
}

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}
