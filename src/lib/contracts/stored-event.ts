import { Schema } from "effect";
import { ContinuationReasonSchema } from "./limit-recovery.js";
import {
	SessionSetupFinishedPayloadSchema,
	SessionSetupOutputPayloadSchema,
	SessionSetupStartedPayloadSchema,
} from "./project-setup.js";
import {
	SessionWorkspaceSchema,
	SessionWorktreeOwnershipSchema,
} from "./session-workspace.js";

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

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

export type MessageCreatedPayload = PayloadOf<"message.created">;

export type MessageRemovedPayload = PayloadOf<"message.removed">;

export type MessagePartRemovedPayload = PayloadOf<"message.part.removed">;

/** A settled OpenCode REST message, including its ordered provider parts. */
export type MessageSnapshotPayload = PayloadOf<"message.snapshot">;

export type TextDeltaPayload = PayloadOf<"text.delta">;

export type ThinkingStartPayload = PayloadOf<"thinking.start">;

export type ThinkingDeltaPayload = PayloadOf<"thinking.delta">;

export type ThinkingEndPayload = PayloadOf<"thinking.end">;

export type ToolStartedPayload = PayloadOf<"tool.started">;

export type ToolRunningPayload = PayloadOf<"tool.running">;

export type ToolCompletedPayload = PayloadOf<"tool.completed">;

export type FileAttachedPayload = PayloadOf<"file.attached">;

// Provider-agnostic tool input shape. Each adapter's normalizeToolInput()
// maps raw provider casing (snake_case, camelCase) into this canonical form.
// Unknown tools collapse to { tool: "Unknown" } — never lost, always renderable.

export type CanonicalToolInput = Schema.SimplifyMutable<
	typeof CanonicalToolInputSchema.Type
>;

export type TurnCompletedPayload = PayloadOf<"turn.completed">;

export type TurnErrorPayload = PayloadOf<"turn.error">;

export type TurnInterruptedPayload = PayloadOf<"turn.interrupted">;

export const INPUT_DELIVERIES = ["queue", "steer"] as const;
export type InputDelivery = (typeof INPUT_DELIVERIES)[number];

/** Why an input cannot be steered into the running turn. */
export const STEER_BLOCKERS = [
	"no_steering",
	"prompt_open",
	"model_differs",
	"agent_differs",
	"variant_differs",
	"slash_command", // Historical RPC refusal; retained to decode older servers' replies.
] as const;
export type SteerBlocker = (typeof STEER_BLOCKERS)[number];

/** The send request captured when an input is admitted; its handoff uses it. */
export type InputRequest = typeof InputRequestSchema.Type;

export type InputAdmittedPayload = PayloadOf<"input.admitted">;

export type InputSentPayload = PayloadOf<"input.sent">;

export type InputRequeuedPayload = PayloadOf<"input.requeued">;

export type InputCancelledPayload = PayloadOf<"input.cancelled">;

export type InputInterruptRequestedPayload =
	PayloadOf<"input.interrupt_requested">;

export type TurnModelResolvedPayload = PayloadOf<"turn.model_resolved">;

export type SessionCreatedPayload = PayloadOf<"session.created">;

export type SessionReadPayload = PayloadOf<"session.read">;

export type SessionUnreadPayload = PayloadOf<"session.unread">;

export type SessionSettledPayload = PayloadOf<"session.settled">;

export type SessionAutoSettleSetPayload = PayloadOf<"session.auto_settle_set">;

export type SessionUnsettledPayload = PayloadOf<"session.unsettled">;

export type SessionPinnedPayload = PayloadOf<"session.pinned">;

export type SessionUnpinnedPayload = PayloadOf<"session.unpinned">;

export type SessionSnoozedPayload = PayloadOf<"session.snoozed">;

export type SessionUnsnoozedPayload = PayloadOf<"session.unsnoozed">;

export type SessionRenamedPayload = PayloadOf<"session.renamed">;

export type SessionWorkspaceChangedPayload =
	PayloadOf<"session.workspace_changed">;

export type SessionWorkspaceHintChangedPayload =
	PayloadOf<"session.workspace_hint_changed">;

/** The runner's reported startup folder, independent of recorded workspace moves. */
export type SessionWorkspaceStartedPayload =
	PayloadOf<"session.workspace_started">;

export type SessionDeletedPayload = PayloadOf<"session.deleted">;

/**
 * Lineage for a session that was forked from another.
 *
 * Separate from `session.created` because Conduit learns the two facts from
 * different places: the forked session's existence arrives on the provider
 * event stream, its fork point comes back from the fork call. Keeping lineage
 * its own event is what lets `setForkEntry` record it without having to know
 * the session's title or provider.
 *
 * Legacy producers may include a display timestamp. Session subscriptions use
 * the durable parent and fork message IDs.
 */
export type SessionForkedPayload = PayloadOf<"session.forked">;

export type SessionStatusPayload = PayloadOf<"session.status">;

export type SessionCompactionPayload = PayloadOf<"session.compaction">;

export type SessionProviderChangedPayload =
	PayloadOf<"session.provider_changed">;

export type SessionProviderCleanupFailedPayload =
	PayloadOf<"session.provider_cleanup_failed">;

export type SessionPermissionModeChangedPayload =
	PayloadOf<"session.permission_mode_changed">;

/** The explicit model stored for the session. */
export type SessionModelChangedPayload = PayloadOf<"session.model_changed">;

/** The session's effort variant; "" means the session follows the default. */
export type SessionVariantChangedPayload = PayloadOf<"session.variant_changed">;

/** The session's context window; "" means the session follows the default. */
export type SessionContextWindowChangedPayload =
	PayloadOf<"session.context_window_changed">;

const SessionGoalSchema = Schema.Struct({
	condition: Schema.String,
	iterations: Schema.NonNegativeInt,
	setAt: Schema.Number,
	tokensAtStart: Schema.Number,
	lastReason: Schema.optional(Schema.String),
});

export type SessionGoalChangedPayload = PayloadOf<"session.goal_changed">;

export type SessionHandoffDeliveredPayload =
	PayloadOf<"session.handoff_delivered">;

export type SessionUsageLimitedPayload = PayloadOf<"session.usage_limited">;

export type SessionCutOffDismissedPayload =
	PayloadOf<"session.cut_off_dismissed">;

export type SessionResumedPayload = PayloadOf<"session.resumed">;

export type SessionResumeScheduledPayload =
	PayloadOf<"session.resume_scheduled">;

export type SessionResumeCancelledPayload =
	PayloadOf<"session.resume_cancelled">;

/**
 * Everything the approval card shows rides the asked event: the approvals
 * subscription serves the card from the pending_approvals row, which keeps
 * these as its `details` (ni8.9).
 */
export type PermissionAskedPayload = PayloadOf<"permission.asked">;

export type PermissionResolvedPayload = PayloadOf<"permission.resolved">;

export type QuestionAskedPayload = PayloadOf<"question.asked">;

export type QuestionResolvedPayload = PayloadOf<"question.resolved">;

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

export type StoredEvent = CanonicalEvent<CanonicalEventType> & {
	readonly projectId: string;
	readonly sequence: number;
	readonly streamVersion: number;
};

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
		tool: Schema.Literal("Patch"),
		patch: Schema.String,
		filePaths: Schema.Array(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("Bash"),
		command: Schema.String,
		workingDirectory: Schema.optionalWith(Schema.String, { exact: true }),
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

const NonEmptyStringSchema = Schema.String.pipe(Schema.minLength(1));

export const InputRequestSchema = Schema.Struct({
	text: Schema.String,
	images: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
	model: Schema.optionalWith(
		Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
		{ exact: true },
	),
	agent: Schema.optionalWith(Schema.String, { exact: true }),
	variant: Schema.optionalWith(Schema.String, { exact: true }),
	contextWindow: Schema.optionalWith(Schema.String, { exact: true }),
});

const optionalString = Schema.optionalWith(Schema.String, { exact: true });

/** The optional card fields of a permission.asked payload (ni8.9). */
export const PermissionAskedDetailsSchema = Schema.Struct({
	toolUseId: optionalString,
	always: Schema.optionalWith(Schema.Array(Schema.String), { exact: true }),
	permissionSuggestions: Schema.optionalWith(Schema.Array(Schema.Unknown), {
		exact: true,
	}),
	permissionTitle: optionalString,
	permissionDisplayName: optionalString,
	permissionDescription: optionalString,
	permissionReason: optionalString,
});

/** The optional card fields of a question.asked payload (ni8.9). */
export const QuestionAskedDetailsSchema = Schema.Struct({
	toolUseId: optionalString,
	providerId: optionalString,
});

// The snapshot decoder deliberately validates only identity, role and part
// identity. Keep the richer provider data typed without tightening old stores.
type SnapshotMessage = {
	readonly id: string;
	readonly sessionID: string;
	readonly role: string;
	readonly parentID?: string;
	readonly summary?: boolean;
	readonly time?: { readonly created?: number; readonly completed?: number };
	readonly cost?: number;
	readonly tokens?: {
		readonly input?: number;
		readonly output?: number;
		readonly cache?: { readonly read?: number; readonly write?: number };
		readonly contextWindow?: number;
	};
	readonly finish?: string;
	readonly error?: unknown;
	readonly parts: readonly {
		readonly id: string;
		readonly type: string;
		readonly [key: string]: unknown;
	}[];
	readonly [key: string]: unknown;
};

function live<S extends Schema.Schema.Any>(payload: S) {
	return { status: "live", payload } as const;
}

function retired<S extends Schema.Schema.Any>(reason: string, payload: S) {
	return { status: "retired", reason, payload } as const;
}

export const CanonicalEvents = {
	"message.created": live(
		Schema.Struct({
			messageId: Schema.String,
			role: MessageRoleSchema,
			sessionId: Schema.String,
			parentID: Schema.optionalWith(Schema.String, { exact: true }),
			turnId: Schema.optionalWith(Schema.String, { exact: true }),
			/** The browser send this user message was placed for. */
			inputId: Schema.optionalWith(Schema.String, { exact: true }),
			/** Imported from the provider's own record rather than observed streaming
			 *  (OpenCode history backfill, conduit-test-iea). */
			backfilled: Schema.optionalWith(Schema.Literal(true), { exact: true }),
		}),
	),
	"message.removed": live(
		Schema.Struct({
			messageId: Schema.String,
		}),
	),
	"message.part.removed": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
		}),
	),
	"message.snapshot": live(
		Schema.Struct({
			messageId: Schema.String,
			digest: Schema.String,
			supersedesEventId: Schema.optionalWith(Schema.String, { exact: true }),
			message: Schema.Unknown.pipe(
				Schema.filter(
					(value): value is SnapshotMessage =>
						typeof value === "object" &&
						value !== null &&
						"id" in value &&
						typeof value.id === "string" &&
						"sessionID" in value &&
						typeof value.sessionID === "string" &&
						"role" in value &&
						(value.role === "user" || value.role === "assistant") &&
						"parts" in value &&
						Array.isArray(value.parts) &&
						value.parts.every(
							(part: unknown) =>
								typeof part === "object" &&
								part !== null &&
								"id" in part &&
								typeof part.id === "string" &&
								"type" in part &&
								typeof part.type === "string",
						),
				),
			),
		}),
	),
	"text.delta": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			text: Schema.String,
		}),
	),
	"thinking.start": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
		}),
	),
	"thinking.delta": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			text: Schema.String,
		}),
	),
	"thinking.end": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
		}),
	),
	"tool.started": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			toolName: Schema.String,
			callId: Schema.String,
			input: CanonicalToolInputSchema,
		}),
	),
	"tool.running": live(
		Schema.Struct({
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
		}),
	),
	"tool.completed": live(
		Schema.Struct({
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
		}),
	),
	"file.attached": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			mime: Schema.String,
			filename: Schema.optionalWith(Schema.String, { exact: true }),
			url: Schema.String,
		}),
	),
	"tool.input_updated": retired(
		"Tool input refreshes use tool.running and tool.completed",
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
		}).pipe(
			Schema.extend(
				Schema.Record({ key: Schema.String, value: Schema.Unknown }),
			),
		),
	),
	"turn.completed": live(
		Schema.Struct({
			messageId: Schema.String,
			/** Names the turn when no assistant message of its own answered it. */
			userMessageId: Schema.optionalWith(Schema.String, { exact: true }),
			cost: Schema.optionalWith(Schema.Number, { exact: true }),
			/** Claude's session running total; cost is its delta at persistence time. */
			providerCostTotalUsd: Schema.optionalWith(Schema.Number, { exact: true }),
			providerSessionId: Schema.optionalWith(Schema.String, { exact: true }),
			/** Input and cache tokens in the final main request, excluding output. */
			contextTokens: Schema.optionalWith(Schema.Number, { exact: true }),
			tokens: Schema.optionalWith(TokensSchema, { exact: true }),
			duration: Schema.optionalWith(Schema.Number, { exact: true }),
		}),
	),
	"turn.error": live(
		Schema.Struct({
			messageId: Schema.String,
			/** Durable turn owner when a process fails before or between messages. */
			userMessageId: Schema.optionalWith(Schema.String, { exact: true }),
			error: Schema.String,
			code: Schema.optionalWith(Schema.String, { exact: true }),
		}),
	),
	"turn.interrupted": live(
		Schema.Struct({
			messageId: Schema.String,
		}),
	),
	"turn.model_resolved": live(
		Schema.Struct({
			requestedModel: Schema.optionalWith(NonEmptyStringSchema, {
				exact: true,
			}),
			expectedModel: Schema.optionalWith(NonEmptyStringSchema, { exact: true }),
			actualModel: NonEmptyStringSchema,
		}),
	),
	"input.admitted": live(
		Schema.Struct({
			sessionId: Schema.String,
			inputId: Schema.String,
			delivery: Schema.Literal(...INPUT_DELIVERIES),
			request: InputRequestSchema,
		}),
	),
	"input.sent": live(
		Schema.Struct({
			sessionId: Schema.String,
			inputId: Schema.String,
			/** Handed into the running turn rather than starting one. */
			steer: Schema.optionalWith(Schema.Literal(true), { exact: true }),
			/** The user workspace move whose directive was included in this handoff. */
			workspaceMoveSequence: Schema.optionalWith(Schema.Number, {
				exact: true,
			}),
		}),
	),
	"input.requeued": live(
		Schema.Struct({
			sessionId: Schema.String,
			inputId: Schema.String,
			sentSequence: Schema.Number,
			reason: Schema.Literal("declined", "failed"),
		}),
	),
	"input.cancelled": live(
		Schema.Struct({
			sessionId: Schema.String,
			inputId: Schema.String,
		}),
	),
	"input.interrupt_requested": live(
		Schema.Struct({
			sessionId: Schema.String,
			inputId: Schema.String,
		}),
	),
	"session.created": live(
		Schema.Struct({
			sessionId: Schema.String,
			title: Schema.String,
			provider: Schema.String,
			parentId: Schema.optionalWith(Schema.String, { exact: true }),
			forkPointEvent: Schema.optionalWith(Schema.String, { exact: true }),
			forkPointTimestamp: Schema.optionalWith(Schema.Number, { exact: true }),
			forkPointMessageId: Schema.optionalWith(Schema.String, { exact: true }),
			providerSessionId: Schema.optionalWith(Schema.String, { exact: true }),
			sideThread: Schema.optionalWith(Schema.Boolean, { exact: true }),
			/** The input a Side Thread was started with, so a retried start finds it. */
			startInputId: Schema.optionalWith(Schema.String, { exact: true }),
			permissionMode: Schema.optionalWith(
				Schema.Literal(...SESSION_PERMISSION_MODES),
				{
					exact: true,
				},
			),
		}),
	),
	"session.renamed": live(
		Schema.Struct({
			sessionId: Schema.String,
			title: Schema.String,
		}),
	),
	"session.rewound": live(
		Schema.Struct({
			messageId: Schema.String,
			previousMessageId: Schema.optionalWith(Schema.NullOr(Schema.String), {
				exact: true,
			}),
		}),
	),
	"session.rewind_undone": live(
		Schema.Struct({
			previousMessageId: Schema.optionalWith(Schema.NullOr(Schema.String), {
				exact: true,
			}),
		}),
	),
	"session.rewind_committed": live(Schema.Struct({ messageId: Schema.String })),
	"session.workspace_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			/** Effective cwd after applying the mapping, including a reset to main. */
			path: Schema.optionalWith(Schema.String, { exact: true }),
			/** Launch ownership, or its branch-name update. Forks never copy this metadata. */
			ownership: Schema.optionalWith(
				Schema.Array(SessionWorktreeOwnershipSchema),
				{ exact: true },
			),
			...SessionWorkspaceSchema.fields,
			/** A branch rename updates ownership without moving the workspace. */
			cause: Schema.Union(
				SessionWorkspaceSchema.fields.cause,
				Schema.Literal("branch-rename"),
			),
		}),
	),
	"session.workspace_hint_changed": live(
		Schema.Struct({
			path: Schema.NullOr(Schema.String),
		}),
	),
	"session.workspace_started": live(
		Schema.Struct({
			sessionId: Schema.String,
			path: Schema.String,
		}),
	),
	"session.setup_started": live(SessionSetupStartedPayloadSchema),
	"session.setup_output": live(SessionSetupOutputPayloadSchema),
	"session.setup_finished": live(SessionSetupFinishedPayloadSchema),
	"session.read": retired(
		"SessionAttention writes seen_version",
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.unread": retired(
		"SessionAttention writes seen_version",
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.settled": live(
		Schema.Struct({
			sessionId: Schema.String,
			automatic: Schema.optionalWith(Schema.Boolean, { exact: true }),
			mergedHead: Schema.optionalWith(Schema.String, { exact: true }),
		}),
	),
	"session.unsettled": live(
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.pinned": live(
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.unpinned": live(
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.snoozed": live(
		Schema.Struct({
			sessionId: Schema.String,
			until: Schema.NullOr(Schema.Number),
		}),
	),
	"session.auto_settle_set": live(
		Schema.Struct({
			sessionId: Schema.String,
			disabled: Schema.Boolean,
		}),
	),
	"session.unsnoozed": live(
		Schema.Struct({
			sessionId: Schema.String,
		}),
	),
	"session.deleted": live(
		Schema.Struct({
			sessionId: Schema.String,
			/**
			 * Descendant sessions deleted by the schema cascade, captured BEFORE the
			 * tombstone persists (afterwards they can no longer be found by parent).
			 * Optional: historical
			 * tombstones lack it, and it is omitted when the session has no children.
			 */
			childSessionIds: Schema.optionalWith(Schema.Array(Schema.String), {
				exact: true,
			}),
		}),
	),
	"session.forked": live(
		Schema.Struct({
			sessionId: Schema.String,
			parentId: Schema.String,
			forkPointEvent: Schema.optionalWith(Schema.String, { exact: true }),
			forkPointTimestamp: Schema.optionalWith(Schema.Number, { exact: true }),
		}),
	),
	"session.status": live(
		Schema.Struct({
			sessionId: Schema.String,
			status: SessionStatusSchema,
			turnId: Schema.optionalWith(Schema.String, { exact: true }),
			/** A retry's reason, for the shell row while the provider waits. */
			message: Schema.optionalWith(Schema.String, { exact: true }),
		}),
	),
	"session.compaction": live(
		Schema.Struct({
			sessionId: Schema.String,
			state: Schema.Literal("started", "completed", "failed"),
			detail: Schema.String,
			preTokens: Schema.optionalWith(Schema.Number, { exact: true }),
			postTokens: Schema.optionalWith(Schema.Number, { exact: true }),
		}),
	),
	"session.provider_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			oldProvider: Schema.String,
			newProvider: Schema.String,
			reason: Schema.optionalWith(
				Schema.suspend(() => ContinuationReasonSchema),
				{ exact: true },
			),
		}),
	),
	"session.provider_cleanup_failed": live(
		Schema.Struct({
			sessionId: Schema.String,
			provider: Schema.String,
			instanceId: Schema.optionalWith(Schema.String, { exact: true }),
			reason: Schema.String,
		}),
	),
	"session.permission_mode_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			mode: Schema.Literal(...SESSION_PERMISSION_MODES),
		}),
	),
	"session.model_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			modelId: Schema.String,
			providerId: Schema.String,
		}),
	),
	"session.variant_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			variant: Schema.String,
		}),
	),
	"session.context_window_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			contextWindow: Schema.String,
		}),
	),
	"session.goal_changed": live(
		Schema.Struct({
			sessionId: Schema.String,
			goal: Schema.NullOr(SessionGoalSchema),
			ended: Schema.optional(Schema.Literal("met", "cleared")),
			endedGoal: Schema.optional(SessionGoalSchema),
			endedAt: Schema.optional(Schema.Number),
			pausedReason: Schema.optional(Schema.String),
		}),
	),
	"session.handoff_delivered": live(
		Schema.Struct({
			included: Schema.NonNegativeInt,
			omitted: Schema.NonNegativeInt,
			tokens: Schema.NonNegativeInt,
			firstMessageIncluded: Schema.optionalWith(Schema.Boolean, {
				exact: true,
			}),
			instanceId: Schema.optionalWith(Schema.String, { exact: true }),
		}),
	),
	"session.usage_limited": live(
		Schema.Struct({
			instanceId: Schema.String,
			rateLimitType: Schema.String,
			/** SDK reset time, in Unix seconds. */
			resetsAt: Schema.optionalWith(Schema.Number, { exact: true }),
			cutOffMessageId: Schema.String,
		}),
	),
	"session.cut_off_dismissed": live(
		Schema.Struct({
			cutOffMessageId: Schema.String,
		}),
	),
	"session.resumed": live(
		Schema.Struct({
			reason: Schema.suspend(() => ContinuationReasonSchema),
			instanceId: Schema.String,
			/** The previous account, when the continuation switched accounts. */
			from: Schema.optionalWith(Schema.String, { exact: true }),
		}),
	),
	"session.resume_scheduled": live(
		Schema.Struct({
			instanceId: Schema.String,
			/** Unix seconds, matching the SDK's reset time. */
			at: Schema.Number.pipe(Schema.finite()),
		}),
	),
	// Preserve the empty payload type while accepting historical extra fields.
	"session.resume_cancelled": live(
		Schema.Struct({}) as Schema.Schema<Record<string, never>>,
	),
	"permission.asked": live(
		Schema.Struct({
			id: Schema.String,
			sessionId: Schema.String,
			toolName: Schema.String,
			input: Schema.Unknown,
			...PermissionAskedDetailsSchema.fields,
		}),
	),
	"permission.resolved": live(
		Schema.Struct({
			id: Schema.String,
			decision: PermissionDecisionSchema,
			resolvedBy: Schema.optionalWith(Schema.Literal("auto"), { exact: true }),
		}),
	),
	"question.asked": live(
		Schema.Struct({
			id: Schema.String,
			sessionId: Schema.String,
			questions: Schema.Unknown,
			...QuestionAskedDetailsSchema.fields,
		}),
	),
	"question.resolved": live(
		Schema.Struct({
			id: Schema.String,
			answers: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		}),
	),
} as const;

export type CanonicalEventType = keyof typeof CanonicalEvents;
export type LiveEventType = {
	[K in CanonicalEventType]: (typeof CanonicalEvents)[K]["status"] extends "live"
		? K
		: never;
}[CanonicalEventType];
export type PayloadOf<T extends CanonicalEventType> = Schema.Schema.Type<
	(typeof CanonicalEvents)[T]["payload"]
>;
export type EventPayloadMap = { [K in CanonicalEventType]: PayloadOf<K> };

export const CANONICAL_EVENT_TYPES = Object.keys(
	CanonicalEvents,
) as readonly CanonicalEventType[];

export const SessionGoalChangedPayloadSchema =
	CanonicalEvents["session.goal_changed"].payload;
export const SessionWorkspaceChangedPayloadSchema =
	CanonicalEvents["session.workspace_changed"].payload;
export const SessionWorkspaceHintChangedPayloadSchema =
	CanonicalEvents["session.workspace_hint_changed"].payload;
export const SessionHandoffDeliveredPayloadSchema =
	CanonicalEvents["session.handoff_delivered"].payload;
export const SessionUsageLimitedPayloadSchema =
	CanonicalEvents["session.usage_limited"].payload;

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

// Newly produced events are live; stored history can still contain retired types.
export type CanonicalEvent<T extends CanonicalEventType = LiveEventType> = {
	[K in T]: {
		readonly eventId: string;
		readonly sessionId: string;
		readonly type: K;
		readonly data: PayloadOf<K>;
		readonly metadata: EventMetadata;
		readonly provider: string;
		readonly createdAt: number;
	};
}[T];

// Array.map loses the correlation between each key and its payload schema.
// The mapped type above restates the discriminated union of those envelopes.
export const CanonicalEventSchema = Schema.Union(
	...CANONICAL_EVENT_TYPES.map((type) =>
		eventEnvelope(type, CanonicalEvents[type].payload),
	),
) as Schema.Schema<CanonicalEvent<CanonicalEventType>>;

export const StoredEventSchema = Schema.extend(
	CanonicalEventSchema,
	Schema.Struct({
		projectId: Schema.NonEmptyString,
		sequence: Schema.Number,
		streamVersion: Schema.Number,
	}),
);
