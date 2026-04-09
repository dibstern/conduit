// ─── Canonical Event Translator (Task 7) ─────────────────────────────────────
// Maps OpenCode SSE events → canonical persistence events.
// Stateful: tracks part lifecycle (tool pending → running → completed,
// reasoning start → end) per session.

import { mapToolName } from "../relay/event-translator.js";
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
} from "../relay/opencode-events.js";
import type { OpenCodeEvent } from "../types.js";
import {
	type CanonicalEvent,
	canonicalEvent,
	type SessionStatusValue,
} from "./events.js";

// ─── Part Tracking ───────────────────────────────────────────────────────────

interface TrackedPart {
	type: string; // "text" | "tool" | "reasoning"
	status?: string | undefined; // ToolStatus for tool parts
	thinkingStarted?: boolean | undefined; // Whether thinking.start has been emitted
}

// ─── Translator ──────────────────────────────────────────────────────────────

export class CanonicalEventTranslator {
	/**
	 * Per-session part tracking: sessionId → (partId → TrackedPart).
	 * Tracks part types and tool status transitions to emit correct
	 * canonical lifecycle events.
	 */
	private readonly sessions = new Map<string, Map<string, TrackedPart>>();

	/**
	 * Translate an OpenCode SSE event into zero or more canonical events.
	 *
	 * Returns null for events that are not persisted (PTY, file, unknown)
	 * or when sessionId is missing.
	 */
	translate(
		event: OpenCodeEvent,
		sessionId: string | undefined,
	): CanonicalEvent[] | null {
		if (!sessionId) return null;

		// ── message.created ──────────────────────────────────────────────
		if (isMessageCreatedEvent(event)) {
			return this.translateMessageCreated(event, sessionId);
		}

		// ── message.part.delta ───────────────────────────────────────────
		if (isPartDeltaEvent(event)) {
			return this.translatePartDelta(event, sessionId);
		}

		// ── message.part.updated ─────────────────────────────────────────
		if (isPartUpdatedEvent(event)) {
			return this.translatePartUpdated(event, sessionId);
		}

		// ── message.updated ──────────────────────────────────────────────
		if (isMessageUpdatedEvent(event)) {
			return this.translateMessageUpdated(event, sessionId);
		}

		// ── session.status ───────────────────────────────────────────────
		if (isSessionStatusEvent(event)) {
			return this.translateSessionStatus(event, sessionId);
		}

		// ── session.error ────────────────────────────────────────────────
		if (isSessionErrorEvent(event)) {
			return this.translateSessionError(event, sessionId);
		}

		// ── permission.asked ─────────────────────────────────────────────
		if (isPermissionAskedEvent(event)) {
			return this.translatePermissionAsked(event, sessionId);
		}

		// ── permission.replied ───────────────────────────────────────────
		if (isPermissionRepliedEvent(event)) {
			return this.translatePermissionReplied(event, sessionId);
		}

		// ── question.asked ───────────────────────────────────────────────
		if (isQuestionAskedEvent(event)) {
			return this.translateQuestionAsked(event, sessionId);
		}

		// ── session.updated (title change) ───────────────────────────────
		if (event.type === "session.updated") {
			return this.translateSessionUpdated(event, sessionId);
		}

		// ── PTY, file, and other non-persisted events → null ─────────────
		return null;
	}

	/**
	 * Clear all tracked part state. If sessionId is provided, only
	 * clear that session; otherwise clear everything.
	 */
	reset(sessionId?: string): void {
		if (sessionId != null) {
			this.sessions.delete(sessionId);
		} else {
			this.sessions.clear();
		}
	}

	/** Get tracked parts for a session (exposed for testing). */
	getTrackedParts(
		sessionId: string,
	): ReadonlyMap<string, TrackedPart> | undefined {
		return this.sessions.get(sessionId);
	}

	// ─── Private helpers ─────────────────────────────────────────────────────

	private getOrCreateParts(sessionId: string): Map<string, TrackedPart> {
		let parts = this.sessions.get(sessionId);
		if (!parts) {
			parts = new Map();
			this.sessions.set(sessionId, parts);
		}
		return parts;
	}

	// ─── message.created ─────────────────────────────────────────────────────

	private translateMessageCreated(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isMessageCreatedEvent(event)) return null;
		const props = event.properties;

		// OpenCode wraps message data under "info" or "message"
		const msg = props.info ?? props.message;
		const role = msg?.role;
		if (role !== "user" && role !== "assistant") return null;

		const messageId = props.messageID ?? "";

		return [
			canonicalEvent("message.created", sessionId, {
				messageId,
				role,
				sessionId,
			}),
		];
	}

	// ─── message.part.delta ──────────────────────────────────────────────────

	private translatePartDelta(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isPartDeltaEvent(event)) return null;
		const props = event.properties;

		const messageId = props.messageID ?? "";
		const partId = props.partID;
		const parts = this.getOrCreateParts(sessionId);
		const tracked = parts.get(partId);

		// If the part is tracked as reasoning, emit thinking.delta
		if (tracked?.type === "reasoning") {
			return [
				canonicalEvent("thinking.delta", sessionId, {
					messageId,
					partId,
					text: props.delta,
				}),
			];
		}

		// Otherwise emit text.delta (default for text parts or untracked parts)
		if (props.field === "text" || props.field === "reasoning") {
			return [
				canonicalEvent("text.delta", sessionId, {
					messageId,
					partId,
					text: props.delta,
				}),
			];
		}

		return null;
	}

	// ─── message.part.updated ────────────────────────────────────────────────

	private translatePartUpdated(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isPartUpdatedEvent(event)) return null;
		const props = event.properties;

		const rawPart = props.part;
		if (!rawPart?.type) return null;

		const partId = props.partID ?? rawPart.id ?? "";
		const messageId = props.messageID ?? "";
		const parts = this.getOrCreateParts(sessionId);
		const existing = parts.get(partId);

		// Track the part
		parts.set(partId, {
			type: rawPart.type,
			status: rawPart.state?.status,
			thinkingStarted: existing?.thinkingStarted,
		});

		// ── Reasoning lifecycle ──────────────────────────────────────────
		if (rawPart.type === "reasoning") {
			const results: CanonicalEvent[] = [];

			// First time we see this reasoning part → thinking.start
			if (!existing?.thinkingStarted) {
				parts.set(partId, {
					type: rawPart.type,
					status: rawPart.state?.status,
					thinkingStarted: true,
				});
				results.push(
					canonicalEvent("thinking.start", sessionId, {
						messageId,
						partId,
					}),
				);
			}

			// If time.end is set → thinking.end
			if (rawPart.time?.end != null) {
				results.push(
					canonicalEvent("thinking.end", sessionId, {
						messageId,
						partId,
					}),
				);
			}

			return results.length > 0 ? results : null;
		}

		// ── Tool lifecycle ───────────────────────────────────────────────
		if (rawPart.type === "tool") {
			const status = rawPart.state?.status;
			const toolName = mapToolName(rawPart.tool ?? "");
			const callId = rawPart.callID ?? partId;

			if (status === "pending") {
				return [
					canonicalEvent("tool.started", sessionId, {
						messageId,
						partId,
						toolName,
						callId,
						input: rawPart.state?.input ?? null,
					}),
				];
			}

			if (status === "running") {
				const results: CanonicalEvent[] = [];

				// If first seen as running (never saw pending), emit tool.started first
				if (!existing) {
					results.push(
						canonicalEvent("tool.started", sessionId, {
							messageId,
							partId,
							toolName,
							callId,
							input: rawPart.state?.input ?? null,
						}),
					);
				}

				results.push(
					canonicalEvent("tool.running", sessionId, {
						messageId,
						partId,
					}),
				);
				return results;
			}

			if (status === "completed" || status === "error") {
				const duration =
					rawPart.time?.end && rawPart.time?.start
						? rawPart.time.end - rawPart.time.start
						: 0;
				return [
					canonicalEvent("tool.completed", sessionId, {
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

			return null;
		}

		return null;
	}

	// ─── message.updated ─────────────────────────────────────────────────────

	private translateMessageUpdated(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isMessageUpdatedEvent(event)) return null;
		const props = event.properties;

		// OpenCode wraps message data under "info" or "message"
		const msg = props.info ?? props.message;
		if (!msg || msg.role !== "assistant") return null;

		const messageId = msg.id ?? "";
		const duration =
			msg.time?.completed && msg.time?.created
				? msg.time.completed - msg.time.created
				: undefined;

		// Build tokens object, only including defined fields (exactOptionalPropertyTypes)
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

		// Build payload, only including defined optional fields
		const payload: {
			messageId: string;
			cost?: number;
			tokens?: typeof tokens;
			duration?: number;
		} = { messageId };
		if (msg.cost != null) payload.cost = msg.cost;
		if (Object.keys(tokens).length > 0) payload.tokens = tokens;
		if (duration != null) payload.duration = duration;

		return [canonicalEvent("turn.completed", sessionId, payload)];
	}

	// ─── session.status ──────────────────────────────────────────────────────

	private translateSessionStatus(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isSessionStatusEvent(event)) return null;
		const statusType = event.properties.status?.type;

		// Map SSE status types to our constrained union
		const validStatuses: Record<string, SessionStatusValue> = {
			idle: "idle",
			busy: "busy",
			retry: "retry",
			error: "error",
		};

		const status = statusType ? validStatuses[statusType] : undefined;
		if (!status) return null;

		return [
			canonicalEvent("session.status", sessionId, {
				sessionId,
				status,
			}),
		];
	}

	// ─── session.error ───────────────────────────────────────────────────────

	private translateSessionError(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isSessionErrorEvent(event)) return null;

		const errName = event.properties.error?.name ?? "Unknown";
		const errMsg = event.properties.error?.data?.message ?? "An error occurred";

		return [
			canonicalEvent("turn.error", sessionId, {
				messageId: "",
				error: errMsg,
				code: errName,
			}),
		];
	}

	// ─── permission.asked ────────────────────────────────────────────────────

	private translatePermissionAsked(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isPermissionAskedEvent(event)) return null;
		const props = event.properties;

		return [
			canonicalEvent("permission.asked", sessionId, {
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

	// ─── permission.replied ──────────────────────────────────────────────────

	private translatePermissionReplied(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isPermissionRepliedEvent(event)) return null;

		return [
			canonicalEvent("permission.resolved", sessionId, {
				id: event.properties.id,
				// We don't know the actual decision from the SSE event;
				// default to "once" as the most common case
				decision: "once",
			}),
		];
	}

	// ─── question.asked ──────────────────────────────────────────────────────

	private translateQuestionAsked(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		if (!isQuestionAskedEvent(event)) return null;
		const props = event.properties;

		return [
			canonicalEvent("question.asked", sessionId, {
				id: props.id,
				sessionId,
				questions: props.questions,
			}),
		];
	}

	// ─── session.updated ─────────────────────────────────────────────────────

	private translateSessionUpdated(
		event: OpenCodeEvent,
		sessionId: string,
	): CanonicalEvent[] | null {
		// session.updated carries session info under properties.info
		const info = (event.properties as Record<string, unknown>)["info"] as
			| Record<string, unknown>
			| undefined;
		const title = info?.["title"] as string | undefined;

		if (!title) return null;

		return [
			canonicalEvent("session.renamed", sessionId, {
				sessionId,
				title,
			}),
		];
	}
}
