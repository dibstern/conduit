import { Effect, Schema, type Types } from "effect";
import {
	AttachmentRefSchema,
	AttachmentSourceSchema,
} from "./attachment-ref.js";
import { ContinuationReasonSchema } from "./limit-recovery.js";
import {
	SessionSetupFinishedPayloadSchema,
	SessionSetupOutputPayloadSchema,
	SessionSetupStartedPayloadSchema,
} from "./project-setup.js";
import { holdingSessionRefs, SessionRef } from "./session-ref-schema.js";
import {
	SessionWorkspaceSchema,
	SessionWorktreeOwnershipSchema,
	SessionWorktreeOwnershipSnapshotSchema,
} from "./session-workspace.js";

export const EventId = Schema.String.pipe(Schema.brand("EventId"));
export type EventId = typeof EventId.Type;

export const CommandId = Schema.String.pipe(Schema.brand("CommandId"));
export type CommandId = typeof CommandId.Type;

export const PROVIDER_TYPES = ["opencode", "claude"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const SESSION_STATUSES = ["idle", "busy", "retry", "error"] as const;
export type SessionStatusValue = (typeof SESSION_STATUSES)[number];

/** Immutable Stop cohort and deadline, committed with its control intent. */
export const ProviderStopSnapshotSchema = Schema.Struct({
	deadlineAt: Schema.Number,
	owners: Schema.Array(Schema.Struct({ runId: Schema.String })),
	turnIds: Schema.Array(Schema.String),
	runnerBacked: Schema.Boolean,
	retainedSteers: Schema.Boolean,
});
export type ProviderStopSnapshot = typeof ProviderStopSnapshotSchema.Type;

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

export type TextSurfacedPayload = PayloadOf<"text.surfaced">;

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

export type CanonicalToolInput = Types.Mutable<
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
export type SessionJevSetPayload = PayloadOf<"session.jev_set">;

export type SessionUnsettledPayload = PayloadOf<"session.unsettled">;
export type SessionArchivedPayload = PayloadOf<"session.archived">;
export type SessionUnarchivedPayload = PayloadOf<"session.unarchived">;

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
	iterations: Schema.Number.check(
		Schema.isInt(),
		Schema.isGreaterThanOrEqualTo(0),
	),
	setAt: Schema.Number,
	tokensAtStart: Schema.Number,
	lastReason: Schema.optional(Schema.String),
	/** Explicit provider report only; absence means the judge is unknown. */
	judgeModel: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty())),
	/** Durable turns overlapping this goal's lifetime, frozen on completion. */
	turnCount: Schema.optional(
		Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
	),
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
	/** Conduit run ownership; only this run's terminal event can settle its turns. */
	readonly runId?: string;
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
	readonly inherited?: boolean;
	readonly providerCreatedAt?: number;
	/** First observed OpenCode directory before an explicit workspace move. */
	readonly nativeDirectory?: string;
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
	runId: Schema.optionalKey(Schema.String),
	commandId: Schema.optionalKey(Schema.String),
	causationEventId: Schema.optionalKey(Schema.String),
	correlationId: Schema.optionalKey(Schema.String),
	adapterKey: Schema.optionalKey(Schema.String),
	providerTurnId: Schema.optionalKey(Schema.String),
	providerRuntimeEventId: Schema.optionalKey(Schema.String),
	rawSource: Schema.optionalKey(Schema.String),
	providerRefs: Schema.optionalKey(
		Schema.Struct({
			providerTurnId: Schema.optionalKey(Schema.String),
			providerItemId: Schema.optionalKey(Schema.String),
			providerMessageId: Schema.optionalKey(Schema.String),
			providerToolUseId: Schema.optionalKey(Schema.String),
			providerRequestId: Schema.optionalKey(Schema.String),
			providerSessionId: Schema.optionalKey(Schema.String).pipe(
				SessionRef(false),
			),
			providerTaskId: Schema.optionalKey(Schema.String),
			parentProviderTaskId: Schema.optionalKey(Schema.String),
		}),
	),
	synthetic: Schema.optionalKey(Schema.Boolean),
	inherited: Schema.optionalKey(Schema.Boolean),
	providerCreatedAt: Schema.optionalKey(Schema.Number),
	nativeDirectory: Schema.optionalKey(Schema.String),
	source: Schema.optionalKey(Schema.String),
	sseBatchId: Schema.optionalKey(Schema.String),
	sseBatchSize: Schema.optionalKey(Schema.Number),
	schemaVersion: Schema.optionalKey(Schema.Number),
});

const MessageRoleSchema = Schema.Literals(["user", "assistant"]);
const SessionStatusSchema = Schema.Literals(["idle", "busy", "retry", "error"]);
const PermissionDecisionSchema = Schema.Literals(["once", "always", "reject"]);

const TokensSchema = Schema.Struct({
	input: Schema.optionalKey(Schema.Number),
	output: Schema.optionalKey(Schema.Number),
	cacheRead: Schema.optionalKey(Schema.Number),
	cacheWrite: Schema.optionalKey(Schema.Number),
	/** Omission means capacity unknown; readers also treat legacy zero values as unknown. */
	contextWindow: Schema.optionalKey(Schema.Number),
});

const CompletionPayloadSchema = Schema.Struct({
	messageId: Schema.String,
	providerStateUpdates: Schema.optionalKey(
		Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.String })),
	),
	/** Names the turn when no assistant message of its own answered it. */
	userMessageId: Schema.optionalKey(Schema.String),
	cost: Schema.optionalKey(Schema.Number),
	/** Claude's session running total; cost is its delta at persistence time. */
	providerCostTotalUsd: Schema.optionalKey(Schema.Number),
	providerSessionId: Schema.optionalKey(Schema.String).pipe(SessionRef(false)),
	/** Input and cache tokens in the final main request, excluding output. */
	contextTokens: Schema.optionalKey(Schema.Number),
	tokens: Schema.optionalKey(TokensSchema),
	duration: Schema.optionalKey(Schema.Number),
});

const CanonicalToolInputSchema = Schema.Union([
	Schema.Struct({
		tool: Schema.Literal("Read"),
		filePath: Schema.String,
		offset: Schema.optionalKey(Schema.Number),
		limit: Schema.optionalKey(Schema.Number),
	}),
	Schema.Struct({
		tool: Schema.Literal("Edit"),
		filePath: Schema.String,
		oldString: Schema.String,
		newString: Schema.String,
		replaceAll: Schema.optionalKey(Schema.Boolean),
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
		workingDirectory: Schema.optionalKey(Schema.String),
		description: Schema.optionalKey(Schema.String),
		timeoutMs: Schema.optionalKey(Schema.Number),
	}),
	Schema.Struct({
		tool: Schema.Literal("Grep"),
		pattern: Schema.String,
		path: Schema.optionalKey(Schema.String),
		include: Schema.optionalKey(Schema.String),
		fileType: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("Glob"),
		pattern: Schema.String,
		path: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("WebFetch"),
		url: Schema.String,
		prompt: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("WebSearch"),
		query: Schema.String,
	}),
	Schema.Struct({
		tool: Schema.Literal("Task"),
		description: Schema.String,
		prompt: Schema.String,
		subagentType: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("LSP"),
		operation: Schema.String,
		filePath: Schema.optionalKey(Schema.String),
	}),
	Schema.Struct({
		tool: Schema.Literal("Skill"),
		name: Schema.String,
	}),
	Schema.Struct({
		tool: Schema.Literal("AskUserQuestion"),
		delivery: Schema.optionalKey(Schema.Literal("async")),
		questions: Schema.Unknown.pipe(
			Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
		),
	}),
	Schema.Struct({
		tool: Schema.Literal("Unknown"),
		name: Schema.String,
		raw: Schema.Record(Schema.String, Schema.Unknown),
	}),
]);

const NonEmptyStringSchema = Schema.String.pipe(
	Schema.check(Schema.isMinLength(1)),
);

export const InputRequestSchema = Schema.Struct({
	text: Schema.String,
	images: Schema.optionalKey(Schema.Array(AttachmentRefSchema)),
	model: Schema.optionalKey(
		Schema.Struct({ providerID: Schema.String, modelID: Schema.String }),
	),
	agent: Schema.optionalKey(Schema.String),
	variant: Schema.optionalKey(Schema.String),
	contextWindow: Schema.optionalKey(Schema.String),
});

const optionalString = Schema.optionalKey(Schema.String);

/** The optional card fields of a permission.asked payload (ni8.9). */
export const PermissionAskedDetailsSchema = Schema.Struct({
	toolUseId: optionalString,
	always: Schema.optionalKey(Schema.Array(Schema.String)),
	permissionSuggestions: Schema.optionalKey(Schema.Array(Schema.Unknown)),
	permissionTitle: optionalString,
	permissionDisplayName: optionalString,
	permissionDescription: optionalString,
	permissionReason: optionalString,
});

/** The optional card fields of a question.asked payload (ni8.9). */
export const QuestionAskedDetailsSchema = Schema.Struct({
	toolUseId: optionalString,
	providerId: optionalString,
	delivery: Schema.optionalKey(Schema.Literal("async")),
	messageId: optionalString,
	partId: optionalString,
});

// Validate identity and file sources while retaining provider-specific fields.
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

function live<S extends Schema.Top>(payload: S) {
	return { status: "live", payload } as const;
}

function retired<S extends Schema.Top>(reason: string, payload: S) {
	return { status: "retired", reason, payload } as const;
}

export const CanonicalEvents = {
	"message.created": live(
		Schema.Struct({
			messageId: Schema.String,
			role: MessageRoleSchema,
			sessionId: Schema.String.pipe(SessionRef(false)),
			parentID: Schema.optionalKey(Schema.String),
			turnId: Schema.optionalKey(Schema.String),
			/** The browser send this user message was placed for. */
			inputId: Schema.optionalKey(Schema.String),
			/** Imported from the provider's own record rather than observed streaming
			 *  (OpenCode history backfill, conduit-test-iea). */
			backfilled: Schema.optionalKey(Schema.Literal(true)),
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
			supersedesEventId: Schema.optionalKey(Schema.String),
			message: Schema.Unknown.pipe(
				Schema.refine(
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
								typeof part.type === "string" &&
								(part.type !== "file" ||
									(!("url" in part) &&
										"source" in part &&
										Schema.is(AttachmentSourceSchema)(part.source))),
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
	"text.surfaced": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			/** Stable 1-based position among all of the turn's mid-turn text parts. */
			ordinal: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
			/** Provenance only; consumers use the current category set for levels. */
			categorySetVersion: Schema.Number,
			model: Schema.String,
			/** Null records a failed judgment, distinct from no verdict yet. */
			probabilities: Schema.NullOr(Schema.Record(Schema.String, Schema.Number)),
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
			metadata: Schema.optionalKey(
				Schema.Record(Schema.String, Schema.Unknown),
			),
			/** Refreshed tool input when the provider streamed args after tool.started. */
			input: Schema.optionalKey(CanonicalToolInputSchema),
			/** Anchors the input refresh to the tool_start id in live clients; only set alongside input. */
			callId: Schema.optionalKey(Schema.String),
			toolName: Schema.optionalKey(Schema.String),
		}),
	),
	"tool.completed": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			result: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			duration: Schema.Number,
			metadata: Schema.optionalKey(
				Schema.Record(Schema.String, Schema.Unknown),
			),
			/** Final tool input when the provider streamed args after tool.started. */
			input: Schema.optionalKey(CanonicalToolInputSchema),
		}),
	),
	"file.attached": live(
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
			mime: Schema.String,
			filename: Schema.optionalKey(Schema.String),
			source: AttachmentSourceSchema,
		}),
	),
	"tool.input_updated": retired(
		"Tool input refreshes use tool.running and tool.completed",
		Schema.Struct({
			messageId: Schema.String,
			partId: Schema.String,
		}).pipe((schema) =>
			Schema.StructWithRest(schema, [
				Schema.Record(Schema.String, Schema.Unknown),
			]),
		),
	),
	"run.requested": live(
		Schema.Struct({ runId: Schema.String, inputId: Schema.String }),
	),
	"run.started": live(
		Schema.Struct({
			inputId: Schema.String,
			requestedRunId: Schema.String,
			userMessageId: Schema.optionalKey(Schema.String),
		}),
	),
	"turn.completed": live(
		Schema.Struct({
			...CompletionPayloadSchema.fields,
			continuationKind: Schema.optionalKey(
				Schema.Literals(["native-thread", "transcript-digest"]),
			),
		}),
	),
	/** Accounting for a background message after its run's terminal. */
	"message.completed": live(CompletionPayloadSchema),
	"turn.notice": live(Schema.Struct({ text: Schema.String })),
	"turn.error": live(
		Schema.Struct({
			messageId: Schema.String,
			error: Schema.String,
			code: Schema.optionalKey(Schema.String),
			retryable: Schema.optionalKey(Schema.Boolean),
			retryHandled: Schema.optionalKey(Schema.Boolean),
			retryAt: Schema.optionalKey(Schema.Number),
		}),
	),
	"turn.interrupted": live(
		Schema.Struct({
			messageId: Schema.String,
			code: Schema.optionalKey(Schema.String),
			reason: Schema.optionalKey(Schema.String),
		}),
	),
	"turn.model_resolved": live(
		Schema.Struct({
			messageId: Schema.optionalKey(Schema.String),
			requestedModel: Schema.optionalKey(NonEmptyStringSchema),
			expectedModel: Schema.optionalKey(NonEmptyStringSchema),
			actualModel: NonEmptyStringSchema,
		}),
	),
	"input.admitted": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			inputId: Schema.String,
			delivery: Schema.Literals([...INPUT_DELIVERIES]),
			request: InputRequestSchema,
		}),
	),
	"input.sent": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			inputId: Schema.String,
			/** Handed into the running turn rather than starting one. */
			steer: Schema.optionalKey(Schema.Literal(true)),
			/** The user workspace move whose directive was included in this handoff. */
			workspaceMoveSequence: Schema.optionalKey(Schema.Number),
		}),
	),
	"input.requeued": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			inputId: Schema.String,
			sentSequence: Schema.Number,
			reason: Schema.Literals(["declined", "failed"]),
		}),
	),
	"input.cancelled": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			inputId: Schema.String,
		}),
	),
	"input.interrupt_requested": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			inputId: Schema.String,
		}),
	),
	"session.created": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			title: Schema.String,
			provider: Schema.String,
			parentId: Schema.optionalKey(Schema.String).pipe(SessionRef(true)),
			forkedFrom: Schema.optionalKey(Schema.String).pipe(SessionRef(true)),
			forkPointEvent: Schema.optionalKey(Schema.String),
			forkPointTimestamp: Schema.optionalKey(Schema.Number),
			forkPointMessageId: Schema.optionalKey(Schema.String),
			inheritsHistory: Schema.optionalKey(Schema.Boolean),
			providerSessionId: Schema.optionalKey(Schema.String).pipe(
				SessionRef(false),
			),
			sideThread: Schema.optionalKey(Schema.Boolean),
			/** The input a Side Thread was started with, so a retried start finds it. */
			startInputId: Schema.optionalKey(Schema.String),
			permissionMode: Schema.optionalKey(
				Schema.Literals([...SESSION_PERMISSION_MODES]),
			),
		}),
	),
	"session.renamed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			title: Schema.String,
		}),
	),
	"session.rewound": live(
		Schema.Struct({
			messageId: Schema.String,
			previousMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	"session.rewind_undone": live(
		Schema.Struct({
			previousMessageId: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	"session.rewind_committed": live(Schema.Struct({ messageId: Schema.String })),
	"session.workspace_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			/** Effective cwd after applying the mapping, including a reset to main. */
			path: Schema.optionalKey(Schema.String),
			/** Launch ownership, or its branch-name update. Forks never copy this metadata. */
			ownership: Schema.optionalKey(
				Schema.Array(SessionWorktreeOwnershipSchema),
			),
			...SessionWorkspaceSchema.fields,
			/** A branch rename updates ownership without moving the workspace. */
			cause: Schema.Union([
				SessionWorkspaceSchema.fields.cause,
				Schema.Literal("branch-rename"),
			]),
		}),
	),
	"session.workspace_hint_changed": live(
		Schema.Struct({
			path: Schema.NullOr(Schema.String),
		}),
	),
	"session.workspace_started": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			path: Schema.String,
		}),
	),
	"session.setup_started": live(SessionSetupStartedPayloadSchema),
	"session.setup_output": live(SessionSetupOutputPayloadSchema),
	"session.setup_finished": live(SessionSetupFinishedPayloadSchema),
	"session.read": retired(
		"SessionAttention writes seen_version",
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.unread": retired(
		"SessionAttention writes seen_version",
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.settled": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			automatic: Schema.optionalKey(Schema.Boolean),
			mergedHead: Schema.optionalKey(Schema.String),
		}),
	),
	"session.unsettled": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.archived": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			automatic: Schema.Boolean,
		}),
	),
	"session.unarchived": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			cause: Schema.Literals(["manual", "send"]),
		}),
	),
	"session.pinned": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.unpinned": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.snoozed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			until: Schema.NullOr(Schema.Number),
		}),
	),
	"session.auto_settle_set": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			disabled: Schema.Boolean,
		}),
	),
	"session.jev_set": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			jev: Schema.NullOr(Schema.Literals(["on", "off"])),
		}),
	),
	"session.unsnoozed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
		}),
	),
	"session.deleted": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			worktreeOwnership: Schema.optionalKey(
				SessionWorktreeOwnershipSnapshotSchema,
			),
			/**
			 * Descendant sessions deleted by the schema cascade, captured BEFORE the
			 * tombstone persists (afterwards they can no longer be found by parent).
			 * Optional: historical
			 * tombstones lack it, and it is omitted when the session has no children.
			 */
			childSessionIds: Schema.optionalKey(Schema.Array(Schema.String)).pipe(
				SessionRef(false),
			),
		}),
	),
	"session.forked": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			parentId: Schema.String.pipe(SessionRef(true)),
			forkPointEvent: Schema.optionalKey(Schema.String),
			forkPointTimestamp: Schema.optionalKey(Schema.Number),
		}),
	),
	"session.status": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			status: SessionStatusSchema,
			turnId: Schema.optionalKey(Schema.String),
			/** A retry's reason, for the shell row while the provider waits. */
			message: Schema.optionalKey(Schema.String),
		}),
	),
	"session.compaction": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			state: Schema.Literals(["started", "completed", "failed"]),
			detail: Schema.String,
			preTokens: Schema.optionalKey(Schema.Number),
			postTokens: Schema.optionalKey(Schema.Number),
		}),
	),
	"session.provider_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			oldProvider: Schema.String,
			newProvider: Schema.String,
			reason: Schema.optionalKey(
				Schema.suspend(() => ContinuationReasonSchema),
			),
		}),
	),
	"session.provider_cleanup_failed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			provider: Schema.String,
			instanceId: Schema.optionalKey(Schema.String),
			reason: Schema.String,
		}),
	),
	"session.permission_mode_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			mode: Schema.Literals([...SESSION_PERMISSION_MODES]),
		}),
	),
	"session.model_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			modelId: Schema.String,
			providerId: Schema.String,
		}),
	),
	"session.variant_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			variant: Schema.String,
		}),
	),
	"session.context_window_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			contextWindow: Schema.String,
		}),
	),
	"session.goal_changed": live(
		Schema.Struct({
			sessionId: Schema.String.pipe(SessionRef(false)),
			goal: Schema.NullOr(SessionGoalSchema),
			ended: Schema.optional(Schema.Literals(["met", "cleared"])),
			endedGoal: Schema.optional(SessionGoalSchema),
			endedAt: Schema.optional(Schema.Number),
			pausedReason: Schema.optional(Schema.String),
		}),
	),
	"session.handoff_delivered": live(
		Schema.Struct({
			continuationKind: Schema.optional(
				Schema.Literals(["native-thread", "transcript-digest"]),
			),
			included: Schema.Number.check(
				Schema.isInt(),
				Schema.isGreaterThanOrEqualTo(0),
			),
			omitted: Schema.Number.check(
				Schema.isInt(),
				Schema.isGreaterThanOrEqualTo(0),
			),
			tokens: Schema.Number.check(
				Schema.isInt(),
				Schema.isGreaterThanOrEqualTo(0),
			),
			firstMessageIncluded: Schema.optionalKey(Schema.Boolean),
			instanceId: Schema.optionalKey(Schema.String),
		}),
	),
	"session.usage_limited": live(
		Schema.Struct({
			instanceId: Schema.String,
			rateLimitType: Schema.String,
			/** SDK reset time, in Unix seconds. */
			resetsAt: Schema.optionalKey(Schema.Number),
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
			from: Schema.optionalKey(Schema.String),
		}),
	),
	"session.resume_scheduled": live(
		Schema.Struct({
			instanceId: Schema.String,
			by: Schema.optionalKey(Schema.Literals(["user", "policy", "sweep"])),
			/** Unix seconds, matching the SDK's reset time. */
			at: Schema.Number.pipe(Schema.check(Schema.isFinite())),
		}),
	),
	// Preserve the empty payload type while accepting historical extra fields.
	"session.resume_cancelled": live(
		Schema.Struct({}) as Schema.Codec<Record<string, never>>,
	),
	"interrupt.requested": live(
		Schema.Struct({
			providerProcessId: Schema.String,
			turnIds: Schema.optionalKey(Schema.Array(Schema.String)),
			stop: Schema.optionalKey(ProviderStopSnapshotSchema),
		}),
	),
	"session.end_requested": live(
		Schema.Struct({
			providerProcessId: Schema.String,
			stop: Schema.optionalKey(ProviderStopSnapshotSchema),
			retireRunIds: Schema.optionalKey(Schema.Array(Schema.String)),
		}),
	),
	"permission.asked": live(
		Schema.Struct({
			id: Schema.String,
			providerProcessId: Schema.optionalKey(Schema.String),
			providerRequestId: Schema.optionalKey(Schema.String),
			sessionId: Schema.String.pipe(SessionRef(false)),
			toolName: Schema.String,
			input: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			...PermissionAskedDetailsSchema.fields,
		}),
	),
	"permission.resolved": live(
		Schema.Struct({
			id: Schema.String,
			providerProcessId: Schema.optionalKey(Schema.String),
			providerRequestId: Schema.optionalKey(Schema.String),
			decision: PermissionDecisionSchema,
			resolvedBy: Schema.optionalKey(Schema.Literal("auto")),
		}),
	),
	"question.asked": live(
		Schema.Struct({
			id: Schema.String,
			providerProcessId: Schema.optionalKey(Schema.String),
			providerRequestId: Schema.optionalKey(Schema.String),
			sessionId: Schema.String.pipe(SessionRef(false)),
			questions: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			...QuestionAskedDetailsSchema.fields,
		}),
	),
	"question.resolved": live(
		Schema.Struct({
			id: Schema.String,
			providerProcessId: Schema.optionalKey(Schema.String),
			providerRequestId: Schema.optionalKey(Schema.String),
			answers: Schema.Record(Schema.String, Schema.Unknown),
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

export const TextSurfacedPayloadSchema =
	CanonicalEvents["text.surfaced"].payload;

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

function eventEnvelope<T extends CanonicalEventType, S extends Schema.Top>(
	type: T,
	dataSchema: S,
) {
	return Schema.Struct({
		eventId: Schema.String,
		sessionId: Schema.String.pipe(SessionRef(false)),
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
function canonicalEventSchema<
	const Fields extends Readonly<Record<string, Schema.Codec<unknown>>>,
>(fields: Fields) {
	return Schema.Union(
		CANONICAL_EVENT_TYPES.map((type) =>
			eventEnvelope(type, CanonicalEvents[type].payload).pipe(
				Schema.fieldsAssign(fields),
			),
		),
	) as Schema.Codec<
		CanonicalEvent<CanonicalEventType> & Schema.Struct.Type<Fields>
	>;
}

export const CanonicalEventSchema = canonicalEventSchema({});
export const StoredEventSchema = canonicalEventSchema({
	projectId: Schema.NonEmptyString,
	sequence: Schema.Number,
	streamVersion: Schema.Number,
});

/** Payload JSON paths held by retained lineage events. Drain SQL stays explicit. */
export const STORED_EVENT_HOLDING_FIELDS = holdingSessionRefs(
	StoredEventSchema.ast,
);
