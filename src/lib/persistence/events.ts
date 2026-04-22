// src/lib/persistence/events.ts
import { randomUUID } from "node:crypto";

// ─── Branded ID Types ───────────────────────────────────────────────────────

export type EventId = string & { readonly __brand: "EventId" };
export type CommandId = string & { readonly __brand: "CommandId" };

// ─── ID Generators ──────────────────────────────────────────────────────────

export function createEventId(): EventId {
	return `evt_${randomUUID()}` as EventId;
}

export function createCommandId(): CommandId {
	return `cmd_${randomUUID()}` as CommandId;
}

// ─── Constrained String Unions ──────────────────────────────────────────────

export const PROVIDER_TYPES = ["opencode", "claude-sdk"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const SESSION_STATUSES = ["idle", "busy", "retry", "error"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

export const PERMISSION_DECISIONS = ["once", "always", "reject"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export const MESSAGE_ROLES = ["user", "assistant"] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

// ─── Canonical Event Types ──────────────────────────────────────────────────

export const CANONICAL_EVENT_TYPES = [
	"message.created",
	"text.delta",
	"thinking.start",
	"thinking.delta",
	"thinking.end",
	"tool.started",
	"tool.running",
	"tool.completed",
	"tool.input_updated",
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"session.created",
	"session.renamed",
	"session.status",
	"session.provider_changed",
	"permission.asked",
	"permission.resolved",
	"question.asked",
	"question.resolved",
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

// ─── Event Payloads ─────────────────────────────────────────────────────────

export interface MessageCreatedPayload {
	readonly messageId: string;
	readonly role: MessageRole;
	readonly sessionId: string;
	readonly turnId?: string;
}

export interface TextDeltaPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly text: string;
}

export interface ThinkingStartPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ThinkingDeltaPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly text: string;
}

export interface ThinkingEndPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ToolStartedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly toolName: string;
	readonly callId: string;
	readonly input: unknown;
}

export interface ToolRunningPayload {
	readonly messageId: string;
	readonly partId: string;
}

export interface ToolCompletedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly result: unknown;
	readonly duration: number;
}

export interface ToolInputUpdatedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly input: unknown;
	/**
	 * Optional tool name. Carried through so downstream translators (e.g.
	 * the relay event sink forwarding to the browser) can tag the derived
	 * `tool_executing` RelayMessage with the correct tool name. Not required:
	 * callers that look up the in-flight tool by `partId` alone can omit it.
	 */
	readonly toolName?: string;
}

export interface TurnCompletedPayload {
	readonly messageId: string;
	readonly cost?: number;
	readonly tokens?: {
		readonly input?: number;
		readonly output?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
	};
	readonly duration?: number;
}

export interface TurnErrorPayload {
	readonly messageId: string;
	readonly error: string;
	readonly code?: string;
}

export interface TurnInterruptedPayload {
	readonly messageId: string;
}

export interface SessionCreatedPayload {
	readonly sessionId: string;
	readonly title: string;
	readonly provider: string;
}

export interface SessionRenamedPayload {
	readonly sessionId: string;
	readonly title: string;
}

export interface SessionStatusPayload {
	readonly sessionId: string;
	readonly status: SessionStatusValue;
	readonly turnId?: string;
}

export interface SessionProviderChangedPayload {
	readonly sessionId: string;
	readonly oldProvider: string;
	readonly newProvider: string;
}

export interface PermissionAskedPayload {
	readonly id: string;
	readonly sessionId: string;
	readonly toolName: string;
	readonly input: unknown;
}

export interface PermissionResolvedPayload {
	readonly id: string;
	readonly decision: PermissionDecision;
}

export interface QuestionAskedPayload {
	readonly id: string;
	readonly sessionId: string;
	readonly questions: unknown;
}

export interface QuestionResolvedPayload {
	readonly id: string;
	readonly answers: Record<string, unknown>;
}

/**
 * Map from event type to its payload shape.
 */
export interface EventPayloadMap {
	"message.created": MessageCreatedPayload;
	"text.delta": TextDeltaPayload;
	"thinking.start": ThinkingStartPayload;
	"thinking.delta": ThinkingDeltaPayload;
	"thinking.end": ThinkingEndPayload;
	"tool.started": ToolStartedPayload;
	"tool.running": ToolRunningPayload;
	"tool.completed": ToolCompletedPayload;
	"tool.input_updated": ToolInputUpdatedPayload;
	"turn.completed": TurnCompletedPayload;
	"turn.error": TurnErrorPayload;
	"turn.interrupted": TurnInterruptedPayload;
	"session.created": SessionCreatedPayload;
	"session.renamed": SessionRenamedPayload;
	"session.status": SessionStatusPayload;
	"session.provider_changed": SessionProviderChangedPayload;
	"permission.asked": PermissionAskedPayload;
	"permission.resolved": PermissionResolvedPayload;
	"question.asked": QuestionAskedPayload;
	"question.resolved": QuestionResolvedPayload;
}

// ─── Event Metadata ─────────────────────────────────────────────────────────

export interface EventMetadata {
	readonly commandId?: string;
	readonly causationEventId?: string;
	readonly correlationId?: string;
	readonly adapterKey?: string;
	readonly providerTurnId?: string;
	readonly synthetic?: boolean;
	readonly source?: string;
	readonly sseBatchId?: string;
	readonly sseBatchSize?: number;
}

// ─── Event Envelopes ────────────────────────────────────────────────────────

export type CanonicalEvent = {
	[K in CanonicalEventType]: {
		readonly eventId: string;
		readonly sessionId: string;
		readonly type: K;
		readonly data: EventPayloadMap[K];
		readonly metadata: EventMetadata;
		readonly provider: string;
		readonly createdAt: number;
	};
}[CanonicalEventType];

export type StoredEvent = CanonicalEvent & {
	readonly sequence: number;
	readonly streamVersion: number;
};

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
	"session.status": ["sessionId", "status"],
	"session.provider_changed": ["sessionId", "oldProvider", "newProvider"],
	"message.created": ["messageId", "role", "sessionId"],
	"text.delta": ["messageId", "partId", "text"],
	"thinking.start": ["messageId", "partId"],
	"thinking.delta": ["messageId", "partId", "text"],
	"thinking.end": ["messageId", "partId"],
	"tool.started": ["messageId", "partId", "toolName", "callId"],
	"tool.running": ["messageId", "partId"],
	"tool.completed": ["messageId", "partId", "result", "duration"],
	"tool.input_updated": ["messageId", "partId", "input"],
	"turn.completed": ["messageId"],
	"turn.error": ["messageId", "error"],
	"turn.interrupted": ["messageId"],
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
		throw new PersistenceError(
			"SCHEMA_VALIDATION_FAILED",
			`Event ${event.type} missing required fields: ${missing.join(", ")}`,
			{
				eventId: event.eventId,
				sessionId: event.sessionId,
				type: event.type,
				missing,
			},
		);
	}
}
