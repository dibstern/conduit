// src/lib/persistence/events.ts
import { randomUUID } from "node:crypto";
import { Schema } from "effect";

// ─── Branded ID Types ───────────────────────────────────────────────────────

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

// ─── ID Generators ──────────────────────────────────────────────────────────

export function createEventId(): EventId {
	return Schema.decodeSync(EventId)(`evt_${randomUUID()}`);
}

export function createCommandId(): CommandId {
	return Schema.decodeSync(CommandId)(`cmd_${randomUUID()}`);
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
	"tool.input_updated", // Retained for historical event compatibility — no longer emitted after Phase 2
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
	readonly input: CanonicalToolInput | unknown;
}

export interface ToolRunningPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly metadata?: Record<string, unknown>;
}

export interface ToolCompletedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly result: unknown;
	readonly duration: number;
}

// ─── Canonical Tool Input ───────────────────────────────────────────────────
// Provider-agnostic tool input shape. Each adapter's normalizeToolInput()
// maps raw provider casing (snake_case, camelCase) into this canonical form.
// Unknown tools collapse to { tool: "Unknown" } — never lost, always renderable.

export type CanonicalToolInput =
	| { tool: "Read"; filePath: string; offset?: number; limit?: number }
	| {
			tool: "Edit";
			filePath: string;
			oldString: string;
			newString: string;
			replaceAll?: boolean;
	  }
	| { tool: "Write"; filePath: string; content: string }
	| {
			tool: "Bash";
			command: string;
			description?: string;
			timeoutMs?: number;
	  }
	| {
			tool: "Grep";
			pattern: string;
			path?: string;
			include?: string;
			fileType?: string;
	  }
	| { tool: "Glob"; pattern: string; path?: string }
	| { tool: "WebFetch"; url: string; prompt?: string }
	| { tool: "WebSearch"; query: string }
	| {
			tool: "Task";
			description: string;
			prompt: string;
			subagentType?: string;
	  }
	| { tool: "LSP"; operation: string; filePath?: string }
	| { tool: "Skill"; name: string }
	| { tool: "AskUserQuestion"; questions: unknown }
	| { tool: "Unknown"; name: string; raw: Record<string, unknown> };

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
	"tool.input_updated": {
		readonly messageId: string;
		readonly partId: string;
		readonly [key: string]: unknown;
	};
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
	/** Schema version for event data shape migration. Events without this
	 *  field (or < 2) use raw provider-specific input shapes and need
	 *  normalizeToolInput() upcast at replay time. */
	readonly schemaVersion?: number;
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

// ─── Event Metadata Schema ─────────────────────────────────────────────────

export const EventMetadataSchema = Schema.Struct({
	commandId: Schema.optionalWith(Schema.String, { exact: true }),
	causationEventId: Schema.optionalWith(Schema.String, { exact: true }),
	correlationId: Schema.optionalWith(Schema.String, { exact: true }),
	adapterKey: Schema.optionalWith(Schema.String, { exact: true }),
	providerTurnId: Schema.optionalWith(Schema.String, { exact: true }),
	synthetic: Schema.optionalWith(Schema.Boolean, { exact: true }),
	source: Schema.optionalWith(Schema.String, { exact: true }),
	sseBatchId: Schema.optionalWith(Schema.String, { exact: true }),
	sseBatchSize: Schema.optionalWith(Schema.Number, { exact: true }),
	schemaVersion: Schema.optionalWith(Schema.Number, { exact: true }),
});

// ─── Payload Schemas ───────────────────────────────────────────────────────

const MessageRoleSchema = Schema.Literal("user", "assistant");
const SessionStatusSchema = Schema.Literal("idle", "busy", "retry", "error");
const PermissionDecisionSchema = Schema.Literal("once", "always", "reject");

const TokensSchema = Schema.Struct({
	input: Schema.optionalWith(Schema.Number, { exact: true }),
	output: Schema.optionalWith(Schema.Number, { exact: true }),
	cacheRead: Schema.optionalWith(Schema.Number, { exact: true }),
	cacheWrite: Schema.optionalWith(Schema.Number, { exact: true }),
});

const MessageCreatedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	role: MessageRoleSchema,
	sessionId: Schema.String,
	turnId: Schema.optionalWith(Schema.String, { exact: true }),
});

const TextDeltaPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	text: Schema.String,
});

const ThinkingStartPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
});

const ThinkingDeltaPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	text: Schema.String,
});

const ThinkingEndPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
});

// CanonicalToolInput is a complex discriminated union with 13 variants.
// Use Schema.Unknown as a temporary escape hatch per task instructions.
const ToolStartedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	toolName: Schema.String,
	callId: Schema.String,
	input: Schema.Unknown,
});

const ToolRunningPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	metadata: Schema.optionalWith(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		{ exact: true },
	),
});

const ToolCompletedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	result: Schema.Unknown,
	duration: Schema.Number,
});

// Historical compat — open record with required messageId and partId
const ToolInputUpdatedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

const TurnCompletedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	cost: Schema.optionalWith(Schema.Number, { exact: true }),
	tokens: Schema.optionalWith(TokensSchema, { exact: true }),
	duration: Schema.optionalWith(Schema.Number, { exact: true }),
});

const TurnErrorPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	error: Schema.String,
	code: Schema.optionalWith(Schema.String, { exact: true }),
});

const TurnInterruptedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
});

const SessionCreatedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	title: Schema.String,
	provider: Schema.String,
});

const SessionRenamedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	title: Schema.String,
});

const SessionStatusPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	status: SessionStatusSchema,
	turnId: Schema.optionalWith(Schema.String, { exact: true }),
});

const SessionProviderChangedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	oldProvider: Schema.String,
	newProvider: Schema.String,
});

const PermissionAskedPayloadSchema = Schema.Struct({
	id: Schema.String,
	sessionId: Schema.String,
	toolName: Schema.String,
	input: Schema.Unknown,
});

const PermissionResolvedPayloadSchema = Schema.Struct({
	id: Schema.String,
	decision: PermissionDecisionSchema,
});

const QuestionAskedPayloadSchema = Schema.Struct({
	id: Schema.String,
	sessionId: Schema.String,
	questions: Schema.Unknown,
});

const QuestionResolvedPayloadSchema = Schema.Struct({
	id: Schema.String,
	answers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

// ─── Per-event-type Envelope Schemas ───────────────────────────────────────

function eventEnvelope<
	T extends CanonicalEventType,
	S extends Schema.Schema.Any,
>(type: T, dataSchema: S) {
	return Schema.Struct({
		eventId: Schema.String,
		sessionId: Schema.String,
		type: Schema.Literal(type),
		data: dataSchema,
		metadata: EventMetadataSchema,
		provider: Schema.String,
		createdAt: Schema.Number,
	});
}

const MessageCreatedEventSchema = eventEnvelope(
	"message.created",
	MessageCreatedPayloadSchema,
);
const TextDeltaEventSchema = eventEnvelope(
	"text.delta",
	TextDeltaPayloadSchema,
);
const ThinkingStartEventSchema = eventEnvelope(
	"thinking.start",
	ThinkingStartPayloadSchema,
);
const ThinkingDeltaEventSchema = eventEnvelope(
	"thinking.delta",
	ThinkingDeltaPayloadSchema,
);
const ThinkingEndEventSchema = eventEnvelope(
	"thinking.end",
	ThinkingEndPayloadSchema,
);
const ToolStartedEventSchema = eventEnvelope(
	"tool.started",
	ToolStartedPayloadSchema,
);
const ToolRunningEventSchema = eventEnvelope(
	"tool.running",
	ToolRunningPayloadSchema,
);
const ToolCompletedEventSchema = eventEnvelope(
	"tool.completed",
	ToolCompletedPayloadSchema,
);
const ToolInputUpdatedEventSchema = eventEnvelope(
	"tool.input_updated",
	ToolInputUpdatedPayloadSchema,
);
const TurnCompletedEventSchema = eventEnvelope(
	"turn.completed",
	TurnCompletedPayloadSchema,
);
const TurnErrorEventSchema = eventEnvelope(
	"turn.error",
	TurnErrorPayloadSchema,
);
const TurnInterruptedEventSchema = eventEnvelope(
	"turn.interrupted",
	TurnInterruptedPayloadSchema,
);
const SessionCreatedEventSchema = eventEnvelope(
	"session.created",
	SessionCreatedPayloadSchema,
);
const SessionRenamedEventSchema = eventEnvelope(
	"session.renamed",
	SessionRenamedPayloadSchema,
);
const SessionStatusEventSchema = eventEnvelope(
	"session.status",
	SessionStatusPayloadSchema,
);
const SessionProviderChangedEventSchema = eventEnvelope(
	"session.provider_changed",
	SessionProviderChangedPayloadSchema,
);
const PermissionAskedEventSchema = eventEnvelope(
	"permission.asked",
	PermissionAskedPayloadSchema,
);
const PermissionResolvedEventSchema = eventEnvelope(
	"permission.resolved",
	PermissionResolvedPayloadSchema,
);
const QuestionAskedEventSchema = eventEnvelope(
	"question.asked",
	QuestionAskedPayloadSchema,
);
const QuestionResolvedEventSchema = eventEnvelope(
	"question.resolved",
	QuestionResolvedPayloadSchema,
);

// ─── Canonical Event Schema (Union of all 20 event types) ──────────────────

export const CanonicalEventSchema = Schema.Union(
	MessageCreatedEventSchema,
	TextDeltaEventSchema,
	ThinkingStartEventSchema,
	ThinkingDeltaEventSchema,
	ThinkingEndEventSchema,
	ToolStartedEventSchema,
	ToolRunningEventSchema,
	ToolCompletedEventSchema,
	ToolInputUpdatedEventSchema,
	TurnCompletedEventSchema,
	TurnErrorEventSchema,
	TurnInterruptedEventSchema,
	SessionCreatedEventSchema,
	SessionRenamedEventSchema,
	SessionStatusEventSchema,
	SessionProviderChangedEventSchema,
	PermissionAskedEventSchema,
	PermissionResolvedEventSchema,
	QuestionAskedEventSchema,
	QuestionResolvedEventSchema,
);

// ─── Stored Event Schema ───────────────────────────────────────────────────

export const StoredEventSchema = Schema.extend(
	CanonicalEventSchema,
	Schema.Struct({
		sequence: Schema.Number,
		streamVersion: Schema.Number,
	}),
);

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
	"tool.input_updated": ["messageId", "partId"], // Historical compat
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
