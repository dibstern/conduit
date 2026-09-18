// src/lib/persistence/events.ts
import { randomUUID } from "node:crypto";
import { Schema } from "effect";

import {
	type CanonicalEvent,
	type CanonicalEventType,
	CommandId,
	EventId,
	type EventMetadata,
	type EventPayloadMap,
} from "../contracts/stored-event.js";

export * from "../contracts/stored-event.js";

// ─── ID Generators ──────────────────────────────────────────────────────────

export function createEventId(): EventId {
	return Schema.decodeSync(EventId)(`evt_${randomUUID()}`);
}

export function createCommandId(): CommandId {
	return Schema.decodeSync(CommandId)(`cmd_${randomUUID()}`);
}

// ─── Typed Event Factory ────────────────────────────────────────────────────

export function canonicalEvent<K extends CanonicalEventType>(
	type: K,
	sessionId: string,
	data: EventPayloadMap[K],
	opts?: {
		eventId?: EventId;
		metadata?: EventMetadata;
		provider?: string;
		createdAt?: number;
	},
): Extract<CanonicalEvent, { type: K }> {
	return {
		eventId: opts?.eventId ?? createEventId(),
		sessionId,
		type,
		data,
		metadata: opts?.metadata ?? {},
		provider: opts?.provider ?? "opencode",
		createdAt: opts?.createdAt ?? Date.now(),
	} as unknown as Extract<CanonicalEvent, { type: K }>;
}

// ─── Runtime Payload Validation ─────────────────────────────────────────────

import { PersistenceError } from "./errors.js";

const PAYLOAD_REQUIRED_FIELDS: Record<CanonicalEventType, readonly string[]> = {
	"session.created": ["sessionId", "title", "provider"],
	"session.renamed": ["sessionId", "title"],
	"session.deleted": ["sessionId"],
	"session.forked": ["sessionId", "parentId"],
	"session.status": ["sessionId", "status"],
	"session.compaction": ["sessionId", "state", "detail"],
	"session.provider_changed": ["sessionId", "oldProvider", "newProvider"],
	"session.provider_cleanup_failed": ["sessionId", "provider", "reason"],
	"session.permission_mode_changed": ["sessionId", "mode"],
	"message.created": ["messageId", "role", "sessionId"],
	"text.delta": ["messageId", "partId", "text"],
	"thinking.start": ["messageId", "partId"],
	"thinking.delta": ["messageId", "partId", "text"],
	"thinking.end": ["messageId", "partId"],
	"tool.started": ["messageId", "partId", "toolName", "callId"],
	"tool.running": ["messageId", "partId"],
	"tool.completed": ["messageId", "partId", "result", "duration"],
	"file.attached": ["messageId", "partId", "mime", "url"],
	"tool.input_updated": ["messageId", "partId"], // Historical compat
	"turn.completed": ["messageId"],
	"turn.error": ["messageId", "error"],
	"turn.interrupted": ["messageId"],
	"turn.model_resolved": ["actualModel"],
	"permission.asked": ["id", "sessionId", "toolName"],
	"permission.resolved": ["id", "decision"],
	"question.asked": ["id", "sessionId", "questions"],
	"question.resolved": ["id", "answers"],
};

export function validateEventPayload(event: CanonicalEvent): void {
	const required = PAYLOAD_REQUIRED_FIELDS[event.type];
	if (!required) return;
	const data = event.data as unknown as Record<string, unknown>;
	const missing = required.filter((field) => data[field] === undefined);
	if (missing.length > 0) {
		throw new PersistenceError({
			code: "SCHEMA_VALIDATION_FAILED",
			message: `Event ${event.type} missing required fields: ${missing.join(", ")}`,
			context: {
				eventId: event.eventId,
				sessionId: event.sessionId,
				type: event.type,
				missing,
			},
		});
	}
}
