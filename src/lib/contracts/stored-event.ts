import { Schema } from "effect";

// ─── Branded ID Types ───────────────────────────────────────────────────────

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

// ─── Constrained String Unions ──────────────────────────────────────────────

export const PROVIDER_TYPES = ["opencode", "claude"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const SESSION_STATUSES = ["idle", "busy", "retry", "error"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

// Keep in sync with SessionPermissionModeSchema in src/lib/shared-types.ts.
export const SESSION_PERMISSION_MODES = [
	"ask",
	"acceptEdits",
	"auto",
	"full",
	"plan",
	"dontAsk",
] as const;
export type SessionPermissionModeValue =
	(typeof SESSION_PERMISSION_MODES)[number];

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
	"file.attached",
	"tool.input_updated", // Retained for historical event compatibility — no longer emitted after Phase 2
	"turn.completed",
	"turn.error",
	"turn.interrupted",
	"turn.model_resolved",
	"session.created",
	"session.renamed",
	"session.deleted",
	"session.forked",
	"session.status",
	"session.compaction",
	"session.provider_changed",
	"session.provider_cleanup_failed",
	"session.permission_mode_changed",
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

export type ToolStartedPayload = Schema.Schema.Type<
	typeof ToolStartedPayloadSchema
>;

export type ToolRunningPayload = Schema.Schema.Type<
	typeof ToolRunningPayloadSchema
>;

export type ToolCompletedPayload = Schema.Schema.Type<
	typeof ToolCompletedPayloadSchema
>;

export interface FileAttachedPayload {
	readonly messageId: string;
	readonly partId: string;
	readonly mime: string;
	readonly filename?: string;
	readonly url: string;
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
		readonly contextWindow?: number;
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

export interface TurnModelResolvedPayload {
	readonly requestedModel?: string;
	readonly expectedModel?: string;
	readonly actualModel: string;
}

export interface SessionCreatedPayload {
	readonly sessionId: string;
	readonly title: string;
	readonly provider: string;
	readonly parentId?: string;
	readonly providerSessionId?: string;
}

export interface SessionRenamedPayload {
	readonly sessionId: string;
	readonly title: string;
}

export interface SessionDeletedPayload {
	readonly sessionId: string;
}

/**
 * Lineage for a session that was forked from another.
 *
 * Separate from `session.created` because Conduit learns the two facts from
 * different places: the forked session's existence arrives on the provider
 * event stream, its fork point comes back from the fork call. Keeping lineage
 * its own event is what lets `setForkEntry` record it without having to know
 * the session's title or provider.
 *
 * `forkPointTimestamp` has no column in `sessions` — it is display-only and
 * still served from the fork-metadata sidecar. It is recorded here anyway so
 * the sidecar stays reconstructible from the log.
 */
export interface SessionForkedPayload {
	readonly sessionId: string;
	readonly parentId: string;
	readonly forkPointEvent?: string;
	readonly forkPointTimestamp?: number;
}

export interface SessionStatusPayload {
	readonly sessionId: string;
	readonly status: SessionStatusValue;
	readonly turnId?: string;
}

export interface SessionCompactionPayload {
	readonly sessionId: string;
	readonly state: "started" | "completed" | "failed";
	readonly detail: string;
	readonly preTokens?: number;
	readonly postTokens?: number;
}

export interface SessionProviderChangedPayload {
	readonly sessionId: string;
	readonly oldProvider: string;
	readonly newProvider: string;
}

export interface SessionDeletedPayload {
	readonly sessionId: string;
	/**
	 * Descendant sessions deleted by the schema cascade, captured BEFORE the
	 * tombstone persists (afterwards they can no longer be found by parent).
	 * Optional: historical
	 * tombstones lack it, and it is omitted when the session has no children.
	 */
	readonly childSessionIds?: readonly string[];
}

export interface SessionProviderCleanupFailedPayload {
	readonly sessionId: string;
	readonly provider: string;
	readonly instanceId?: string;
	readonly reason: string;
}

export interface SessionPermissionModeChangedPayload {
	readonly sessionId: string;
	readonly mode: SessionPermissionModeValue;
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
	readonly resolvedBy?: "auto";
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
	"file.attached": FileAttachedPayload;
	"tool.input_updated": {
		readonly messageId: string;
		readonly partId: string;
		readonly [key: string]: unknown;
	};
	"turn.completed": TurnCompletedPayload;
	"turn.error": TurnErrorPayload;
	"turn.interrupted": TurnInterruptedPayload;
	"turn.model_resolved": TurnModelResolvedPayload;
	"session.created": SessionCreatedPayload;
	"session.renamed": SessionRenamedPayload;
	"session.deleted": SessionDeletedPayload;
	"session.forked": SessionForkedPayload;
	"session.status": SessionStatusPayload;
	"session.compaction": SessionCompactionPayload;
	"session.provider_changed": SessionProviderChangedPayload;
	"session.provider_cleanup_failed": SessionProviderCleanupFailedPayload;
	"session.permission_mode_changed": SessionPermissionModeChangedPayload;
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
	readonly providerRuntimeEventId?: string;
	readonly rawSource?: string;
	readonly providerRefs?: {
		readonly providerTurnId?: string;
		readonly providerItemId?: string;
		readonly providerMessageId?: string;
		readonly providerToolUseId?: string;
		readonly providerRequestId?: string;
		readonly providerSessionId?: string;
		readonly providerTaskId?: string;
		readonly parentProviderTaskId?: string;
	};
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

// ─── Event Metadata Schema ─────────────────────────────────────────────────

export const EventMetadataSchema = Schema.Struct({
	commandId: Schema.optionalWith(Schema.String, { exact: true }),
	causationEventId: Schema.optionalWith(Schema.String, { exact: true }),
	correlationId: Schema.optionalWith(Schema.String, { exact: true }),
	adapterKey: Schema.optionalWith(Schema.String, { exact: true }),
	providerTurnId: Schema.optionalWith(Schema.String, { exact: true }),
	providerRuntimeEventId: Schema.optionalWith(Schema.String, { exact: true }),
	rawSource: Schema.optionalWith(Schema.String, { exact: true }),
	providerRefs: Schema.optionalWith(
		Schema.Struct({
			providerTurnId: Schema.optionalWith(Schema.String, { exact: true }),
			providerItemId: Schema.optionalWith(Schema.String, { exact: true }),
			providerMessageId: Schema.optionalWith(Schema.String, { exact: true }),
			providerToolUseId: Schema.optionalWith(Schema.String, { exact: true }),
			providerRequestId: Schema.optionalWith(Schema.String, { exact: true }),
			providerSessionId: Schema.optionalWith(Schema.String, { exact: true }),
			providerTaskId: Schema.optionalWith(Schema.String, { exact: true }),
			parentProviderTaskId: Schema.optionalWith(Schema.String, {
				exact: true,
			}),
		}),
		{ exact: true },
	),
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
	contextWindow: Schema.optionalWith(Schema.Number, { exact: true }),
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

const CanonicalToolInputSchema = Schema.Union(
	Schema.Struct({
		tool: Schema.Literal("Read"),
		filePath: Schema.String,
		offset: Schema.optionalWith(Schema.Number, { exact: true }),
		limit: Schema.optionalWith(Schema.Number, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("Edit"),
		filePath: Schema.String,
		oldString: Schema.String,
		newString: Schema.String,
		replaceAll: Schema.optionalWith(Schema.Boolean, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("Write"),
		filePath: Schema.String,
		content: Schema.String,
	}),
	Schema.Struct({
		tool: Schema.Literal("Bash"),
		command: Schema.String,
		description: Schema.optionalWith(Schema.String, { exact: true }),
		timeoutMs: Schema.optionalWith(Schema.Number, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("Grep"),
		pattern: Schema.String,
		path: Schema.optionalWith(Schema.String, { exact: true }),
		include: Schema.optionalWith(Schema.String, { exact: true }),
		fileType: Schema.optionalWith(Schema.String, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("Glob"),
		pattern: Schema.String,
		path: Schema.optionalWith(Schema.String, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("WebFetch"),
		url: Schema.String,
		prompt: Schema.optionalWith(Schema.String, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("WebSearch"),
		query: Schema.String,
	}),
	Schema.Struct({
		tool: Schema.Literal("Task"),
		description: Schema.String,
		prompt: Schema.String,
		subagentType: Schema.optionalWith(Schema.String, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("LSP"),
		operation: Schema.String,
		filePath: Schema.optionalWith(Schema.String, { exact: true }),
	}),
	Schema.Struct({
		tool: Schema.Literal("Skill"),
		name: Schema.String,
	}),
	Schema.Struct({
		tool: Schema.Literal("AskUserQuestion"),
		questions: Schema.Unknown,
	}),
	Schema.Struct({
		tool: Schema.Literal("Unknown"),
		name: Schema.String,
		raw: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	}),
);

const ToolStartedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	toolName: Schema.String,
	callId: Schema.String,
	input: CanonicalToolInputSchema,
});

const ToolRunningPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	metadata: Schema.optionalWith(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		{ exact: true },
	),
	/** Refreshed tool input when the provider streamed args after tool.started. */
	input: Schema.optionalWith(CanonicalToolInputSchema, { exact: true }),
	/** Anchors the input refresh to the tool_start id in live clients; only set alongside input. */
	callId: Schema.optionalWith(Schema.String, { exact: true }),
	toolName: Schema.optionalWith(Schema.String, { exact: true }),
});

const ToolCompletedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	result: Schema.Unknown,
	duration: Schema.Number,
	metadata: Schema.optionalWith(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		{ exact: true },
	),
	/** Final tool input when the provider streamed args after tool.started. */
	input: Schema.optionalWith(CanonicalToolInputSchema, { exact: true }),
});

const FileAttachedPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	partId: Schema.String,
	mime: Schema.String,
	filename: Schema.optionalWith(Schema.String, { exact: true }),
	url: Schema.String,
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

const NonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1));

const TurnModelResolvedPayloadSchema = Schema.Struct({
	requestedModel: Schema.optionalWith(NonEmptyStringSchema, { exact: true }),
	expectedModel: Schema.optionalWith(NonEmptyStringSchema, { exact: true }),
	actualModel: NonEmptyStringSchema,
});

const SessionCreatedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	title: Schema.String,
	provider: Schema.String,
	parentId: Schema.optionalWith(Schema.String, { exact: true }),
	providerSessionId: Schema.optionalWith(Schema.String, { exact: true }),
});

const SessionRenamedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	title: Schema.String,
});

const SessionForkedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	parentId: Schema.String,
	forkPointEvent: Schema.optionalWith(Schema.String, { exact: true }),
	forkPointTimestamp: Schema.optionalWith(Schema.Number, { exact: true }),
});

const SessionStatusPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	status: SessionStatusSchema,
	turnId: Schema.optionalWith(Schema.String, { exact: true }),
});

const SessionCompactionPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	state: Schema.Literal("started", "completed", "failed"),
	detail: Schema.String,
	preTokens: Schema.optionalWith(Schema.Number, { exact: true }),
	postTokens: Schema.optionalWith(Schema.Number, { exact: true }),
});

const SessionProviderChangedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	oldProvider: Schema.String,
	newProvider: Schema.String,
});

const SessionDeletedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	childSessionIds: Schema.optionalWith(Schema.Array(Schema.String), {
		exact: true,
	}),
});

const SessionProviderCleanupFailedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	provider: Schema.String,
	instanceId: Schema.optionalWith(Schema.String, { exact: true }),
	reason: Schema.String,
});

const SessionPermissionModeChangedPayloadSchema = Schema.Struct({
	sessionId: Schema.String,
	mode: Schema.Literal(...SESSION_PERMISSION_MODES),
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
	resolvedBy: Schema.optionalWith(Schema.Literal("auto"), { exact: true }),
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
const FileAttachedEventSchema = eventEnvelope(
	"file.attached",
	FileAttachedPayloadSchema,
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
const TurnModelResolvedEventSchema = eventEnvelope(
	"turn.model_resolved",
	TurnModelResolvedPayloadSchema,
);
const SessionCreatedEventSchema = eventEnvelope(
	"session.created",
	SessionCreatedPayloadSchema,
);
const SessionRenamedEventSchema = eventEnvelope(
	"session.renamed",
	SessionRenamedPayloadSchema,
);
const SessionDeletedEventSchema = eventEnvelope(
	"session.deleted",
	SessionDeletedPayloadSchema,
);
const SessionForkedEventSchema = eventEnvelope(
	"session.forked",
	SessionForkedPayloadSchema,
);
const SessionStatusEventSchema = eventEnvelope(
	"session.status",
	SessionStatusPayloadSchema,
);
const SessionCompactionEventSchema = eventEnvelope(
	"session.compaction",
	SessionCompactionPayloadSchema,
);
const SessionProviderChangedEventSchema = eventEnvelope(
	"session.provider_changed",
	SessionProviderChangedPayloadSchema,
);
const SessionProviderCleanupFailedEventSchema = eventEnvelope(
	"session.provider_cleanup_failed",
	SessionProviderCleanupFailedPayloadSchema,
);
const SessionPermissionModeChangedEventSchema = eventEnvelope(
	"session.permission_mode_changed",
	SessionPermissionModeChangedPayloadSchema,
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

// ─── Canonical Event Schema (Union of all 27 event types) ──────────────────

export const CanonicalEventSchema = Schema.Union(
	MessageCreatedEventSchema,
	TextDeltaEventSchema,
	ThinkingStartEventSchema,
	ThinkingDeltaEventSchema,
	ThinkingEndEventSchema,
	ToolStartedEventSchema,
	ToolRunningEventSchema,
	ToolCompletedEventSchema,
	FileAttachedEventSchema,
	ToolInputUpdatedEventSchema,
	TurnCompletedEventSchema,
	TurnErrorEventSchema,
	TurnInterruptedEventSchema,
	TurnModelResolvedEventSchema,
	SessionCreatedEventSchema,
	SessionRenamedEventSchema,
	SessionDeletedEventSchema,
	SessionForkedEventSchema,
	SessionStatusEventSchema,
	SessionCompactionEventSchema,
	SessionProviderChangedEventSchema,
	SessionProviderCleanupFailedEventSchema,
	SessionPermissionModeChangedEventSchema,
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
