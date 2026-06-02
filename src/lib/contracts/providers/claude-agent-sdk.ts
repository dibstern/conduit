import type {
	Options as ClaudeSDKOptions,
	SDKAPIRetryMessage,
	SDKAssistantMessage,
	SDKAuthStatusMessage,
	SDKCompactBoundaryMessage,
	SDKElicitationCompleteMessage,
	SDKFilesPersistedEvent,
	SDKHookProgressMessage,
	SDKHookResponseMessage,
	SDKHookStartedMessage,
	SDKLocalCommandOutputMessage,
	SDKMemoryRecallMessage,
	SDKMessage,
	SDKMirrorErrorMessage,
	SDKNotificationMessage,
	SDKPartialAssistantMessage,
	SDKPluginInstallMessage,
	SDKPromptSuggestionMessage,
	SDKRateLimitEvent,
	SDKResultError,
	SDKResultMessage,
	SDKResultSuccess,
	SDKSessionStateChangedMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKTaskNotificationMessage,
	SDKTaskProgressMessage,
	SDKTaskStartedMessage,
	SDKTaskUpdatedMessage,
	SDKToolProgressMessage,
	SDKToolUseSummaryMessage,
	SDKUserMessage,
	SDKUserMessageReplay,
} from "@anthropic-ai/claude-agent-sdk";
import { Schema } from "effect";

type AssertExtends<_A extends B, B> = true;

export const ClaudeOpaqueBetaMessageSchema = Schema.Unknown;
export const ClaudeOpaqueRawStreamEventSchema = Schema.Unknown;
export const ClaudeOpaqueDynamicToolInputSchema = Schema.Unknown;
export const ClaudeOpaqueStructuredOutputSchema = Schema.Unknown;
export const ClaudeOpaqueToolResultSchema = Schema.Unknown;

export const ClaudeSDKPermissionModeSchema = Schema.Literal(
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
);

export const ClaudeSDKStatusSchema = Schema.Literal(
	"compacting",
	"requesting",
	null,
);

export const ClaudeSDKResultSubtypeSchema = Schema.Literal(
	"success",
	"error_during_execution",
	"error_max_turns",
	"error_max_budget_usd",
	"error_max_structured_output_retries",
);

export const ClaudeSDKSystemSubtypeSchema = Schema.Literal(
	"api_retry",
	"compact_boundary",
	"elicitation_complete",
	"files_persisted",
	"hook_progress",
	"hook_response",
	"hook_started",
	"init",
	"local_command_output",
	"memory_recall",
	"mirror_error",
	"notification",
	"plugin_install",
	"session_state_changed",
	"status",
	"task_notification",
	"task_progress",
	"task_started",
	"task_updated",
);

export const CLAUDE_SDK_MESSAGE_VARIANTS = [
	"assistant",
	"user",
	"user_replay",
	"result_success",
	"result_error",
	"system_init",
	"stream_event",
	"system_compact_boundary",
	"system_status",
	"system_api_retry",
	"system_local_command_output",
	"system_hook_started",
	"system_hook_progress",
	"system_hook_response",
	"system_plugin_install",
	"tool_progress",
	"auth_status",
	"system_task_notification",
	"system_task_started",
	"system_task_updated",
	"system_task_progress",
	"system_session_state_changed",
	"system_notification",
	"system_files_persisted",
	"tool_use_summary",
	"system_memory_recall",
	"rate_limit_event",
	"system_elicitation_complete",
	"prompt_suggestion",
	"system_mirror_error",
] as const;

// No installed SDKMessage variants are omitted. Variants Conduit currently
// ignores are still decoded as strict envelopes with opaque nested payloads.
export const CLAUDE_SDK_OMITTED_MESSAGE_VARIANTS = [] as const;

export const ClaudeSDKMessageOriginSchema = Schema.Union(
	Schema.Struct({ kind: Schema.Literal("human") }),
	Schema.Struct({
		kind: Schema.Literal("channel"),
		server: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("peer"),
		from: Schema.String,
		name: Schema.optional(Schema.String),
	}),
	Schema.Struct({ kind: Schema.Literal("task-notification") }),
	Schema.Struct({ kind: Schema.Literal("coordinator") }),
);

export const ClaudeSDKUserMessageSchema = Schema.Struct({
	type: Schema.Literal("user"),
	message: Schema.Struct({
		role: Schema.Literal("user"),
		content: Schema.Unknown,
	}).pipe(
		Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
	),
	parent_tool_use_id: Schema.NullOr(Schema.String),
	isSynthetic: Schema.optional(Schema.Boolean),
	tool_use_result: Schema.optional(ClaudeOpaqueToolResultSchema),
	priority: Schema.optional(Schema.Literal("now", "next", "later")),
	origin: Schema.optional(ClaudeSDKMessageOriginSchema),
	shouldQuery: Schema.optional(Schema.Boolean),
	timestamp: Schema.optional(Schema.String),
	uuid: Schema.optional(Schema.String),
	session_id: Schema.optional(Schema.String),
	isReplay: Schema.optional(Schema.Literal(true)),
	file_attachments: Schema.optional(Schema.Array(Schema.Unknown)),
});

export type ClaudeSDKUserMessage = Schema.Schema.Type<
	typeof ClaudeSDKUserMessageSchema
>;

const ClaudeSDKInboundUserMessageSchema = Schema.Struct({
	...ClaudeSDKUserMessageSchema.fields,
	message: ClaudeOpaqueBetaMessageSchema,
});

type ClaudeSDKInboundUserMessage = Schema.Schema.Type<
	typeof ClaudeSDKInboundUserMessageSchema
>;

type _ClaudeSdkUserMessageFitsInboundSchema = AssertExtends<
	SDKUserMessage,
	ClaudeSDKInboundUserMessage
>;
type _ClaudeSdkUserReplayMessageFitsInboundSchema = AssertExtends<
	SDKUserMessageReplay,
	ClaudeSDKInboundUserMessage
>;

const ClaudeUuidSessionFields = {
	uuid: Schema.String,
	session_id: Schema.String,
};

const ClaudeSystemFields = {
	type: Schema.Literal("system"),
	...ClaudeUuidSessionFields,
};

export const ClaudeSDKAssistantMessageSchema = Schema.Struct({
	type: Schema.Literal("assistant"),
	message: ClaudeOpaqueBetaMessageSchema,
	parent_tool_use_id: Schema.NullOr(Schema.String),
	error: Schema.optional(
		Schema.Literal(
			"authentication_failed",
			"oauth_org_not_allowed",
			"billing_error",
			"rate_limit",
			"invalid_request",
			"server_error",
			"unknown",
			"max_output_tokens",
		),
	),
	...ClaudeUuidSessionFields,
});

export type ClaudeSDKAssistantMessage = Schema.Schema.Type<
	typeof ClaudeSDKAssistantMessageSchema
>;

type _ClaudeSdkAssistantMessageFitsSchema = AssertExtends<
	SDKAssistantMessage,
	ClaudeSDKAssistantMessage
>;

const ClaudeSDKUsageSchema = Schema.Struct({
	input_tokens: Schema.Number,
	output_tokens: Schema.Number,
	cache_creation_input_tokens: Schema.Number,
	cache_read_input_tokens: Schema.Number,
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

const ClaudeSDKPermissionDenialSchema = Schema.Struct({
	tool_name: Schema.String,
	tool_use_id: Schema.String,
	tool_input: Schema.Record({
		key: Schema.String,
		value: ClaudeOpaqueDynamicToolInputSchema,
	}),
});

const ClaudeSDKResultBaseFields = {
	type: Schema.Literal("result"),
	duration_ms: Schema.Number,
	duration_api_ms: Schema.Number,
	is_error: Schema.Boolean,
	num_turns: Schema.Number,
	stop_reason: Schema.NullOr(Schema.String),
	total_cost_usd: Schema.Number,
	usage: ClaudeSDKUsageSchema,
	modelUsage: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	permission_denials: Schema.Array(ClaudeSDKPermissionDenialSchema),
	terminal_reason: Schema.optional(Schema.String),
	fast_mode_state: Schema.optional(Schema.Literal("off", "cooldown", "on")),
	origin: Schema.optional(ClaudeSDKMessageOriginSchema),
	...ClaudeUuidSessionFields,
};

export const ClaudeSDKResultSuccessSchema = Schema.Struct({
	...ClaudeSDKResultBaseFields,
	subtype: Schema.Literal("success"),
	api_error_status: Schema.optional(Schema.NullOr(Schema.Number)),
	result: Schema.String,
	structured_output: Schema.optional(ClaudeOpaqueStructuredOutputSchema),
	deferred_tool_use: Schema.optional(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			input: Schema.Record({
				key: Schema.String,
				value: ClaudeOpaqueDynamicToolInputSchema,
			}),
		}),
	),
});

export const ClaudeSDKResultErrorSchema = Schema.Struct({
	...ClaudeSDKResultBaseFields,
	subtype: Schema.Literal(
		"error_during_execution",
		"error_max_turns",
		"error_max_budget_usd",
		"error_max_structured_output_retries",
	),
	errors: Schema.Array(Schema.String),
});

export const ClaudeSDKResultMessageSchema = Schema.Union(
	ClaudeSDKResultSuccessSchema,
	ClaudeSDKResultErrorSchema,
);

export type ClaudeSDKResultMessage = Schema.Schema.Type<
	typeof ClaudeSDKResultMessageSchema
>;

type _ClaudeSdkResultSuccessFitsSchema = AssertExtends<
	SDKResultSuccess,
	Schema.Schema.Type<typeof ClaudeSDKResultSuccessSchema>
>;
type _ClaudeSdkResultErrorFitsSchema = AssertExtends<
	SDKResultError,
	Schema.Schema.Type<typeof ClaudeSDKResultErrorSchema>
>;
type _ClaudeSdkResultMessageFitsSchema = AssertExtends<
	SDKResultMessage,
	ClaudeSDKResultMessage
>;

export const ClaudeSDKPartialAssistantMessageSchema = Schema.Struct({
	type: Schema.Literal("stream_event"),
	event: ClaudeOpaqueRawStreamEventSchema,
	parent_tool_use_id: Schema.NullOr(Schema.String),
	ttft_ms: Schema.optional(Schema.Number),
	...ClaudeUuidSessionFields,
});

type _ClaudeSdkPartialAssistantMessageFitsSchema = AssertExtends<
	SDKPartialAssistantMessage,
	Schema.Schema.Type<typeof ClaudeSDKPartialAssistantMessageSchema>
>;

export const ClaudeSDKAPIRetryMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("api_retry"),
	attempt: Schema.Number,
	max_retries: Schema.Number,
	retry_delay_ms: Schema.Number,
	error_status: Schema.NullOr(Schema.Number),
	error: Schema.String,
});

export const ClaudeSDKCompactBoundaryMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("compact_boundary"),
	compact_metadata: Schema.Unknown,
});

export const ClaudeSDKElicitationCompleteMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("elicitation_complete"),
	mcp_server_name: Schema.String,
	elicitation_id: Schema.String,
});

export const ClaudeSDKFilesPersistedEventSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("files_persisted"),
	files: Schema.Array(Schema.Unknown),
	failed: Schema.Array(Schema.Unknown),
	processed_at: Schema.String,
});

export const ClaudeSDKHookProgressMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("hook_progress"),
	hook_id: Schema.String,
	hook_name: Schema.String,
	hook_event: Schema.String,
	stdout: Schema.String,
	stderr: Schema.String,
	output: Schema.String,
});

export const ClaudeSDKHookResponseMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("hook_response"),
	hook_id: Schema.String,
	hook_name: Schema.String,
	hook_event: Schema.String,
	output: Schema.String,
	stdout: Schema.String,
	stderr: Schema.String,
	exit_code: Schema.optional(Schema.Number),
	outcome: Schema.Literal("success", "error", "cancelled"),
});

export const ClaudeSDKHookStartedMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("hook_started"),
	hook_id: Schema.String,
	hook_name: Schema.String,
	hook_event: Schema.String,
});

export const ClaudeSDKLocalCommandOutputMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("local_command_output"),
	content: Schema.String,
});

export const ClaudeSDKMemoryRecallMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("memory_recall"),
	mode: Schema.Literal("select", "synthesize"),
	memories: Schema.Array(Schema.Unknown),
});

export const ClaudeSDKMirrorErrorMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("mirror_error"),
	error: Schema.String,
	key: Schema.Struct({
		projectKey: Schema.String,
		sessionId: Schema.String,
		subpath: Schema.optional(Schema.String),
	}),
});

export const ClaudeSDKNotificationMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("notification"),
	key: Schema.String,
	text: Schema.String,
	priority: Schema.Literal("low", "medium", "high", "immediate"),
	color: Schema.optional(Schema.String),
	timeout_ms: Schema.optional(Schema.Number),
});

export const ClaudeSDKPluginInstallMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("plugin_install"),
	status: Schema.Literal("started", "installed", "failed", "completed"),
	name: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

export const ClaudeSDKSessionStateChangedMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("session_state_changed"),
	state: Schema.Literal("idle", "running", "requires_action"),
});

export const ClaudeSDKStatusMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("status"),
	status: ClaudeSDKStatusSchema,
	permissionMode: Schema.optional(ClaudeSDKPermissionModeSchema),
	compact_result: Schema.optional(Schema.Literal("success", "failed")),
	compact_error: Schema.optional(Schema.String),
});

export const ClaudeSDKSystemMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("init"),
	agents: Schema.optional(Schema.Array(Schema.String)),
	apiKeySource: Schema.String,
	betas: Schema.optional(Schema.Array(Schema.String)),
	claude_code_version: Schema.String,
	cwd: Schema.String,
	tools: Schema.Array(Schema.String),
	mcp_servers: Schema.Array(Schema.Unknown),
	model: Schema.String,
	permissionMode: ClaudeSDKPermissionModeSchema,
	slash_commands: Schema.Array(Schema.String),
	output_style: Schema.String,
	skills: Schema.Array(Schema.String),
	plugins: Schema.Array(Schema.Unknown),
	fast_mode_state: Schema.optional(Schema.Literal("off", "cooldown", "on")),
});

export const ClaudeSDKTaskNotificationMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("task_notification"),
	task_id: Schema.String,
	tool_use_id: Schema.optional(Schema.String),
	status: Schema.Literal("completed", "failed", "stopped"),
	output_file: Schema.String,
	summary: Schema.String,
	usage: Schema.optional(Schema.Unknown),
	skip_transcript: Schema.optional(Schema.Boolean),
});

export const ClaudeSDKTaskProgressMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("task_progress"),
	task_id: Schema.String,
	tool_use_id: Schema.optional(Schema.String),
	description: Schema.String,
	usage: Schema.Unknown,
	last_tool_name: Schema.optional(Schema.String),
	summary: Schema.optional(Schema.String),
});

export const ClaudeSDKTaskStartedMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("task_started"),
	task_id: Schema.String,
	tool_use_id: Schema.optional(Schema.String),
	description: Schema.String,
	task_type: Schema.optional(Schema.String),
	workflow_name: Schema.optional(Schema.String),
	prompt: Schema.optional(Schema.String),
	skip_transcript: Schema.optional(Schema.Boolean),
});

export const ClaudeSDKTaskUpdatedMessageSchema = Schema.Struct({
	...ClaudeSystemFields,
	subtype: Schema.Literal("task_updated"),
	task_id: Schema.String,
	patch: Schema.Struct({
		status: Schema.optional(
			Schema.Literal("pending", "running", "completed", "failed", "killed"),
		),
		description: Schema.optional(Schema.String),
		end_time: Schema.optional(Schema.Number),
		total_paused_ms: Schema.optional(Schema.Number),
		error: Schema.optional(Schema.String),
		is_backgrounded: Schema.optional(Schema.Boolean),
	}),
});

export const ClaudeSDKSystemLikeMessageSchema = Schema.Union(
	ClaudeSDKAPIRetryMessageSchema,
	ClaudeSDKCompactBoundaryMessageSchema,
	ClaudeSDKElicitationCompleteMessageSchema,
	ClaudeSDKFilesPersistedEventSchema,
	ClaudeSDKHookProgressMessageSchema,
	ClaudeSDKHookResponseMessageSchema,
	ClaudeSDKHookStartedMessageSchema,
	ClaudeSDKLocalCommandOutputMessageSchema,
	ClaudeSDKMemoryRecallMessageSchema,
	ClaudeSDKMirrorErrorMessageSchema,
	ClaudeSDKNotificationMessageSchema,
	ClaudeSDKPluginInstallMessageSchema,
	ClaudeSDKSessionStateChangedMessageSchema,
	ClaudeSDKStatusMessageSchema,
	ClaudeSDKSystemMessageSchema,
	ClaudeSDKTaskNotificationMessageSchema,
	ClaudeSDKTaskProgressMessageSchema,
	ClaudeSDKTaskStartedMessageSchema,
	ClaudeSDKTaskUpdatedMessageSchema,
);

export const ClaudeSDKToolProgressMessageSchema = Schema.Struct({
	type: Schema.Literal("tool_progress"),
	tool_use_id: Schema.String,
	tool_name: Schema.String,
	parent_tool_use_id: Schema.NullOr(Schema.String),
	elapsed_time_seconds: Schema.Number,
	task_id: Schema.optional(Schema.String),
	...ClaudeUuidSessionFields,
});

export const ClaudeSDKAuthStatusMessageSchema = Schema.Struct({
	type: Schema.Literal("auth_status"),
	isAuthenticating: Schema.Boolean,
	output: Schema.Array(Schema.String),
	error: Schema.optional(Schema.String),
	...ClaudeUuidSessionFields,
});

export const ClaudeSDKToolUseSummaryMessageSchema = Schema.Struct({
	type: Schema.Literal("tool_use_summary"),
	summary: Schema.String,
	preceding_tool_use_ids: Schema.Array(Schema.String),
	...ClaudeUuidSessionFields,
});

export const ClaudeSDKRateLimitEventSchema = Schema.Struct({
	type: Schema.Literal("rate_limit_event"),
	rate_limit_info: Schema.Unknown,
	...ClaudeUuidSessionFields,
});

export const ClaudeSDKPromptSuggestionMessageSchema = Schema.Struct({
	type: Schema.Literal("prompt_suggestion"),
	suggestion: Schema.String,
	...ClaudeUuidSessionFields,
});

export const ClaudeSDKMessageSchema = Schema.Union(
	ClaudeSDKAssistantMessageSchema,
	ClaudeSDKInboundUserMessageSchema,
	ClaudeSDKResultMessageSchema,
	ClaudeSDKSystemLikeMessageSchema,
	ClaudeSDKPartialAssistantMessageSchema,
	ClaudeSDKToolProgressMessageSchema,
	ClaudeSDKAuthStatusMessageSchema,
	ClaudeSDKToolUseSummaryMessageSchema,
	ClaudeSDKRateLimitEventSchema,
	ClaudeSDKPromptSuggestionMessageSchema,
);

export type ClaudeSDKMessage = Schema.Schema.Type<
	typeof ClaudeSDKMessageSchema
>;

type _ClaudeSdkMessageFitsSchema = AssertExtends<SDKMessage, ClaudeSDKMessage>;
type _ClaudeSdkApiRetryFitsSchema = AssertExtends<
	SDKAPIRetryMessage,
	Schema.Schema.Type<typeof ClaudeSDKAPIRetryMessageSchema>
>;
type _ClaudeSdkCompactBoundaryFitsSchema = AssertExtends<
	SDKCompactBoundaryMessage,
	Schema.Schema.Type<typeof ClaudeSDKCompactBoundaryMessageSchema>
>;
type _ClaudeSdkElicitationCompleteFitsSchema = AssertExtends<
	SDKElicitationCompleteMessage,
	Schema.Schema.Type<typeof ClaudeSDKElicitationCompleteMessageSchema>
>;
type _ClaudeSdkFilesPersistedFitsSchema = AssertExtends<
	SDKFilesPersistedEvent,
	Schema.Schema.Type<typeof ClaudeSDKFilesPersistedEventSchema>
>;
type _ClaudeSdkHookProgressFitsSchema = AssertExtends<
	SDKHookProgressMessage,
	Schema.Schema.Type<typeof ClaudeSDKHookProgressMessageSchema>
>;
type _ClaudeSdkHookResponseFitsSchema = AssertExtends<
	SDKHookResponseMessage,
	Schema.Schema.Type<typeof ClaudeSDKHookResponseMessageSchema>
>;
type _ClaudeSdkHookStartedFitsSchema = AssertExtends<
	SDKHookStartedMessage,
	Schema.Schema.Type<typeof ClaudeSDKHookStartedMessageSchema>
>;
type _ClaudeSdkLocalCommandOutputFitsSchema = AssertExtends<
	SDKLocalCommandOutputMessage,
	Schema.Schema.Type<typeof ClaudeSDKLocalCommandOutputMessageSchema>
>;
type _ClaudeSdkMemoryRecallFitsSchema = AssertExtends<
	SDKMemoryRecallMessage,
	Schema.Schema.Type<typeof ClaudeSDKMemoryRecallMessageSchema>
>;
type _ClaudeSdkMirrorErrorFitsSchema = AssertExtends<
	SDKMirrorErrorMessage,
	Schema.Schema.Type<typeof ClaudeSDKMirrorErrorMessageSchema>
>;
type _ClaudeSdkNotificationFitsSchema = AssertExtends<
	SDKNotificationMessage,
	Schema.Schema.Type<typeof ClaudeSDKNotificationMessageSchema>
>;
type _ClaudeSdkPluginInstallFitsSchema = AssertExtends<
	SDKPluginInstallMessage,
	Schema.Schema.Type<typeof ClaudeSDKPluginInstallMessageSchema>
>;
type _ClaudeSdkSessionStateChangedFitsSchema = AssertExtends<
	SDKSessionStateChangedMessage,
	Schema.Schema.Type<typeof ClaudeSDKSessionStateChangedMessageSchema>
>;
type _ClaudeSdkStatusFitsSchema = AssertExtends<
	SDKStatusMessage,
	Schema.Schema.Type<typeof ClaudeSDKStatusMessageSchema>
>;
type _ClaudeSdkSystemFitsSchema = AssertExtends<
	SDKSystemMessage,
	Schema.Schema.Type<typeof ClaudeSDKSystemMessageSchema>
>;
type _ClaudeSdkTaskNotificationFitsSchema = AssertExtends<
	SDKTaskNotificationMessage,
	Schema.Schema.Type<typeof ClaudeSDKTaskNotificationMessageSchema>
>;
type _ClaudeSdkTaskProgressFitsSchema = AssertExtends<
	SDKTaskProgressMessage,
	Schema.Schema.Type<typeof ClaudeSDKTaskProgressMessageSchema>
>;
type _ClaudeSdkTaskStartedFitsSchema = AssertExtends<
	SDKTaskStartedMessage,
	Schema.Schema.Type<typeof ClaudeSDKTaskStartedMessageSchema>
>;
type _ClaudeSdkTaskUpdatedFitsSchema = AssertExtends<
	SDKTaskUpdatedMessage,
	Schema.Schema.Type<typeof ClaudeSDKTaskUpdatedMessageSchema>
>;
type _ClaudeSdkToolProgressFitsSchema = AssertExtends<
	SDKToolProgressMessage,
	Schema.Schema.Type<typeof ClaudeSDKToolProgressMessageSchema>
>;
type _ClaudeSdkAuthStatusFitsSchema = AssertExtends<
	SDKAuthStatusMessage,
	Schema.Schema.Type<typeof ClaudeSDKAuthStatusMessageSchema>
>;
type _ClaudeSdkToolUseSummaryFitsSchema = AssertExtends<
	SDKToolUseSummaryMessage,
	Schema.Schema.Type<typeof ClaudeSDKToolUseSummaryMessageSchema>
>;
type _ClaudeSdkRateLimitFitsSchema = AssertExtends<
	SDKRateLimitEvent,
	Schema.Schema.Type<typeof ClaudeSDKRateLimitEventSchema>
>;
type _ClaudeSdkPromptSuggestionFitsSchema = AssertExtends<
	SDKPromptSuggestionMessage,
	Schema.Schema.Type<typeof ClaudeSDKPromptSuggestionMessageSchema>
>;

export const ClaudeSDKOptionsJsonShapeSchema = Schema.Struct({
	cwd: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	resume: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	includePartialMessages: Schema.optional(Schema.Boolean),
	settings: Schema.optional(
		Schema.Union(
			Schema.String,
			Schema.Struct({
				showThinkingSummaries: Schema.optional(Schema.Boolean),
			}).pipe(
				Schema.extend(
					Schema.Record({ key: Schema.String, value: Schema.Unknown }),
				),
			),
		),
	),
	settingSources: Schema.optional(
		Schema.Array(Schema.Literal("user", "project", "local")),
	),
	permissionMode: Schema.optional(ClaudeSDKPermissionModeSchema),
	allowedTools: Schema.optional(Schema.Array(Schema.String)),
	disallowedTools: Schema.optional(Schema.Array(Schema.String)),
	allowDangerouslySkipPermissions: Schema.optional(Schema.Boolean),
	env: Schema.optional(
		Schema.Record({
			key: Schema.String,
			value: Schema.Union(Schema.String, Schema.Undefined),
		}),
	),
	effort: Schema.optional(
		Schema.Union(
			Schema.Literal("low", "medium", "high", "xhigh", "max"),
			Schema.Number,
		),
	),
});

export type ClaudeSDKOptionsJsonShape = Schema.Schema.Type<
	typeof ClaudeSDKOptionsJsonShapeSchema
>;

type _ClaudeSdkOptionsOwnedFieldsFitSchema = AssertExtends<
	Pick<
		ClaudeSDKOptions,
		| "cwd"
		| "model"
		| "resume"
		| "agent"
		| "includePartialMessages"
		| "settingSources"
		| "permissionMode"
		| "allowedTools"
		| "disallowedTools"
		| "allowDangerouslySkipPermissions"
		| "env"
		| "effort"
	>,
	ClaudeSDKOptionsJsonShape
>;

const decodeClaudeSDKMessageEnvelope = Schema.decodeUnknownSync(
	ClaudeSDKMessageSchema,
);
const decodeClaudeSDKUserMessageEnvelope = Schema.decodeUnknownSync(
	ClaudeSDKUserMessageSchema,
);
const decodeClaudeSDKOptionsJsonShapeEnvelope = Schema.decodeUnknownSync(
	ClaudeSDKOptionsJsonShapeSchema,
);

export function decodeClaudeSDKMessage(raw: unknown): SDKMessage {
	// The schema validates the SDK envelope fields Conduit consumes while
	// intentionally leaving nested provider-owned payloads opaque.
	return decodeClaudeSDKMessageEnvelope(raw) as SDKMessage;
}

export function decodeClaudeSDKUserMessage(raw: unknown): SDKUserMessage {
	decodeClaudeSDKUserMessageEnvelope(raw);
	return raw as SDKUserMessage;
}

export function decodeClaudeSDKOptionsJsonShape(
	options: ClaudeSDKOptions,
): ClaudeSDKOptions {
	decodeClaudeSDKOptionsJsonShapeEnvelope(options);
	return options;
}
