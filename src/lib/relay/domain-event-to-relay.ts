import type { CanonicalEvent } from "../persistence/events.js";
import type { UntaggedRelayMessage } from "../shared-types.js";
import type { RelayMessage } from "../types.js";

export type DomainEventRelayTranslation =
	| {
			kind: "emit";
			messages: UntaggedRelayMessage[];
	  }
	| { kind: "silent"; reason: string };

export function translateDomainEventToRelay(
	event: CanonicalEvent,
): DomainEventRelayTranslation {
	switch (event.type) {
		case "text.delta":
			return emit({
				type: "delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.start":
			return emit({ type: "thinking_start", messageId: event.data.messageId });

		case "thinking.delta":
			return emit({
				type: "thinking_delta",
				text: event.data.text,
				messageId: event.data.messageId,
			});

		case "thinking.end":
			return emit({ type: "thinking_stop", messageId: event.data.messageId });

		case "tool.started": {
			const { toolName, callId, input, messageId } = event.data;
			return emit(
				{ type: "tool_start", id: callId, name: toolName, messageId },
				{
					type: "tool_executing",
					id: callId,
					name: toolName,
					input: isRecord(input) ? input : undefined,
					messageId,
				},
			);
		}

		case "tool.running": {
			const { partId, messageId, metadata, input, callId, toolName } =
				event.data;
			// Refreshed input (args streamed after tool.started, e.g. skill):
			// anchor to callId — the id tool_start registered the tool under.
			if (isRecord(input)) {
				return emit({
					type: "tool_executing",
					id: callId ?? partId,
					name: toolName ?? "Task",
					input,
					...(metadata ? { metadata } : {}),
					messageId,
				});
			}
			if (metadata) {
				return emit({
					type: "tool_executing",
					id: partId,
					name: "Task",
					input: undefined,
					metadata,
					messageId,
				});
			}
			return silent(
				"ToolRunningPayload carries no callId; partId anchor already covered by tool.started",
			);
		}

		case "tool.input_updated":
			return silent("Historical event - no longer emitted after Phase 2");

		case "tool.completed": {
			const { partId, result, messageId } = event.data;
			return emit({
				type: "tool_result",
				id: partId,
				content: typeof result === "string" ? result : stringify(result),
				is_error: false,
				messageId,
			});
		}

		case "turn.completed": {
			const { tokens, cost, duration } = event.data;
			return emit(
				{
					type: "result",
					usage: {
						input: tokens?.input ?? 0,
						output: tokens?.output ?? 0,
						cache_read: tokens?.cacheRead ?? 0,
						cache_creation: tokens?.cacheWrite ?? 0,
					},
					cost: cost ?? 0,
					duration: duration ?? 0,
					sessionId: event.sessionId,
				} satisfies RelayMessage,
				{ type: "done", code: 0 },
			);
		}

		case "turn.error": {
			const { error, code } = event.data;
			return emit(
				{ type: "error", code: code ?? "TURN_ERROR", message: error },
				{ type: "done", code: 1 },
			);
		}

		case "turn.interrupted":
			return emit({ type: "done", code: 1 });

		case "session.status":
			if (event.data.status === "retry") {
				const reason =
					typeof event.metadata.correlationId === "string"
						? event.metadata.correlationId
						: "Retrying";
				return emit({ type: "error", code: "RETRY", message: reason });
			}
			return silent(
				"prompt handler owns lifecycle; terminal done/error covers completion",
			);

		case "message.created":
		case "file.attached":
		case "session.created":
		case "session.renamed":
		case "session.provider_changed":
			return silent("persistence-only event; no UI surface in relay");

		case "permission.asked":
		case "permission.resolved":
		case "question.asked":
		case "question.resolved":
			return silent(
				"handled via requestPermission/requestQuestion side-channel",
			);

		default:
			return silent("unhandled event type");
	}
}

function emit(
	...messages: UntaggedRelayMessage[]
): DomainEventRelayTranslation {
	return { kind: "emit", messages };
}

function silent(reason: string): DomainEventRelayTranslation {
	return { kind: "silent", reason };
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function stringify(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "string") return v;
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}
