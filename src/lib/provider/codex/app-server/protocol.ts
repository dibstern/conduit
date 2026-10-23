import { Result, Schema, SchemaGetter, type SchemaIssue } from "effect";

export const CODEX_MIN_VERSION = "0.160.0";

// These helpers describe vocabulary we understand; wire schemas remain open.
export const KNOWN_REASONING_EFFORTS = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"ultra",
] as const;
export const KNOWN_TURN_STATUSES = [
	"completed",
	"interrupted",
	"failed",
	"inProgress",
] as const;
export const KNOWN_ITEM_TYPES = [
	"agentMessage",
	"reasoning",
	"userMessage",
	"plan",
	"commandExecution",
	"fileChange",
	"mcpToolCall",
	"webSearch",
	"imageView",
	"collabAgentToolCall",
	"subAgentActivity",
	"contextCompaction",
] as const;
export const KNOWN_INPUT_MODALITIES = ["text", "image", "audio"] as const;
export const KNOWN_INPUT_TYPES = ["text", "image", "skill"] as const;
export const KNOWN_SKILL_SCOPES = ["user", "repo", "system", "admin"] as const;

export const isKnownReasoningEffort = (
	value: string,
): value is (typeof KNOWN_REASONING_EFFORTS)[number] =>
	KNOWN_REASONING_EFFORTS.some((known) => known === value);
export const isKnownTurnStatus = (
	value: string,
): value is (typeof KNOWN_TURN_STATUSES)[number] =>
	KNOWN_TURN_STATUSES.some((known) => known === value);
export const isKnownItemType = (
	value: string,
): value is (typeof KNOWN_ITEM_TYPES)[number] =>
	KNOWN_ITEM_TYPES.some((known) => known === value);
export const isKnownInputModality = (
	value: string,
): value is (typeof KNOWN_INPUT_MODALITIES)[number] =>
	KNOWN_INPUT_MODALITIES.some((known) => known === value);
export const isKnownInputType = (
	value: string,
): value is (typeof KNOWN_INPUT_TYPES)[number] =>
	KNOWN_INPUT_TYPES.some((known) => known === value);

export const InitializeResponseSchema = Schema.Struct({
	userAgent: Schema.String,
});
export const AccountSchema = Schema.Struct({
	type: Schema.String,
	email: Schema.optional(Schema.NullOr(Schema.String)),
});
export const AccountReadResponseSchema = Schema.Struct({
	account: Schema.optional(Schema.NullOr(AccountSchema)),
});
export const GetAccountParamsSchema = Schema.Struct({
	refreshToken: Schema.optional(Schema.Boolean),
});
export const BrowserLoginAccountParamsSchema = Schema.Struct({
	type: Schema.Literal("chatgpt"),
});
export const DeviceCodeLoginAccountParamsSchema = Schema.Struct({
	type: Schema.Literal("chatgptDeviceCode"),
});
export const LoginAccountParamsSchema = Schema.Union([
	BrowserLoginAccountParamsSchema,
	DeviceCodeLoginAccountParamsSchema,
]);
export const BrowserLoginAccountResponseSchema = Schema.Struct({
	type: Schema.Literal("chatgpt"),
	loginId: Schema.String,
	authUrl: Schema.String,
});
export const DeviceCodeLoginAccountResponseSchema = Schema.Struct({
	type: Schema.Literal("chatgptDeviceCode"),
	loginId: Schema.String,
	userCode: Schema.String,
	verificationUrl: Schema.String,
});
export const LoginAccountResponseSchema = Schema.Union([
	BrowserLoginAccountResponseSchema,
	DeviceCodeLoginAccountResponseSchema,
]);
export const CancelLoginAccountParamsSchema = Schema.Struct({
	loginId: Schema.String,
});
export const CancelLoginAccountResponseSchema = Schema.Struct({
	status: Schema.Literals(["canceled", "notFound"]),
});
export const LogoutAccountResponseSchema = Schema.Struct({});
export const AccountLoginCompletedNotificationSchema = Schema.Struct({
	loginId: Schema.optional(Schema.NullOr(Schema.String)),
	success: Schema.Boolean,
	error: Schema.optional(Schema.NullOr(Schema.String)),
});
export const AccountUpdatedNotificationSchema = Schema.Struct({
	authMode: Schema.optional(Schema.NullOr(Schema.String)),
	planType: Schema.optional(Schema.NullOr(Schema.String)),
});
export const RateLimitWindowSchema = Schema.Struct({
	usedPercent: Schema.Number,
	windowDurationMins: Schema.optional(Schema.NullOr(Schema.Number)),
	resetsAt: Schema.optional(Schema.NullOr(Schema.Number)),
});
export const RateLimitSnapshotSchema = Schema.Struct({
	limitId: Schema.optional(Schema.NullOr(Schema.String)),
	limitName: Schema.optional(Schema.NullOr(Schema.String)),
	normalModelSlug: Schema.optional(Schema.NullOr(Schema.String)),
	planType: Schema.optional(Schema.NullOr(Schema.String)),
	primary: Schema.optional(Schema.NullOr(RateLimitWindowSchema)),
	secondary: Schema.optional(Schema.NullOr(RateLimitWindowSchema)),
});
export const GetAccountRateLimitsResponseSchema = Schema.Struct({
	rateLimits: RateLimitSnapshotSchema,
	rateLimitsByLimitId: Schema.optional(
		Schema.NullOr(Schema.Record(Schema.String, RateLimitSnapshotSchema)),
	),
});
export const AccountRateLimitsUpdatedNotificationSchema = Schema.Struct({
	rateLimits: RateLimitSnapshotSchema,
});
export const ModelListParamsSchema = Schema.Struct({
	cursor: Schema.optional(Schema.NullOr(Schema.String)),
	limit: Schema.optional(Schema.NullOr(Schema.Number)),
	includeHidden: Schema.optional(Schema.NullOr(Schema.Boolean)),
});
export const ReasoningEffortOptionSchema = Schema.Struct({
	reasoningEffort: Schema.String,
	description: Schema.String,
});
export const ModelSchema = Schema.Struct({
	id: Schema.String,
	model: Schema.String,
	displayName: Schema.String,
	hidden: Schema.Boolean,
	isDefault: Schema.Boolean,
	supportedReasoningEfforts: Schema.Array(ReasoningEffortOptionSchema),
	defaultReasoningEffort: Schema.String,
	inputModalities: Schema.Array(Schema.String),
});
export const ModelListResponseSchema = Schema.Struct({
	data: Schema.Array(ModelSchema),
	nextCursor: Schema.NullOr(Schema.String),
});
export const SkillsListParamsSchema = Schema.Struct({
	cwds: Schema.optional(Schema.Array(Schema.String)),
	forceReload: Schema.optional(Schema.Boolean),
});
export const SkillScopeSchema = Schema.Literals(KNOWN_SKILL_SCOPES);
export const SkillMetadataSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.String,
	enabled: Schema.Boolean,
	path: Schema.optional(Schema.NullOr(Schema.String)),
	scope: SkillScopeSchema,
});
export const SkillErrorInfoSchema = Schema.Struct({
	message: Schema.String,
	path: Schema.String,
});
export const SkillsListEntrySchema = Schema.Struct({
	cwd: Schema.String,
	errors: Schema.Array(SkillErrorInfoSchema),
	// Decode descriptors independently so one malformed skill cannot hide the rest.
	skills: Schema.Array(Schema.Unknown),
});
export const SkillsListResponseSchema = Schema.Struct({
	data: Schema.Array(SkillsListEntrySchema),
});

export const ThreadSpawnSubAgentSourceSchema = Schema.Struct({
	parent_thread_id: Schema.String,
	depth: Schema.Number,
	agent_nickname: Schema.optional(Schema.NullOr(Schema.String)),
	agent_path: Schema.optional(Schema.NullOr(Schema.String)),
	agent_role: Schema.optional(Schema.NullOr(Schema.String)),
});
export const SubAgentSourceSchema = Schema.Union([
	Schema.Literals(["review", "compact", "memory_consolidation"]),
	Schema.Struct({ thread_spawn: ThreadSpawnSubAgentSourceSchema }),
	Schema.Struct({ other: Schema.String }),
]);
export const ThreadSchema = Schema.Struct({
	id: Schema.String,
	model: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.String,
	source: Schema.optional(
		Schema.Union([
			Schema.String,
			Schema.Struct({ subAgent: SubAgentSourceSchema }),
		]),
	),
});
export const ThreadStartParamsSchema = Schema.Struct({
	model: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ThreadStartResponseSchema = Schema.Struct({
	thread: ThreadSchema,
	model: Schema.String,
	cwd: Schema.String,
});
export const ThreadResumeParamsSchema = Schema.Struct({
	threadId: Schema.String,
	model: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.optional(Schema.NullOr(Schema.String)),
	excludeTurns: Schema.optional(Schema.Boolean),
});
export const ThreadResumeResponseSchema = Schema.Struct({
	thread: ThreadSchema,
	model: Schema.String,
	cwd: Schema.String,
});
export const ThreadForkParamsSchema = Schema.Struct({
	threadId: Schema.String,
	lastTurnId: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.optional(Schema.NullOr(Schema.String)),
	model: Schema.optional(Schema.NullOr(Schema.String)),
	excludeTurns: Schema.optional(Schema.Boolean),
});
export const ThreadForkResponseSchema = ThreadResumeResponseSchema;
export const ThreadRevertParamsSchema = Schema.Struct({
	threadId: Schema.String,
	beforeTurnId: Schema.String,
});
export const ThreadRevertResponseSchema = Schema.Struct({
	thread: ThreadSchema,
});
export const ThreadRevertedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
});
export const ThreadUnarchiveParamsSchema = Schema.Struct({
	threadId: Schema.String,
});
export const ThreadUnarchiveResponseSchema = Schema.Struct({
	thread: ThreadSchema,
});
export const ThreadCompactStartParamsSchema = Schema.Struct({
	threadId: Schema.String,
});
export const ThreadCompactStartResponseSchema = Schema.Struct({});
export const ContextCompactedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
});

export const KNOWN_GOAL_STATUSES = [
	"active",
	"paused",
	"blocked",
	"usageLimited",
	"budgetLimited",
	"complete",
] as const;
export const ThreadGoalSchema = Schema.Struct({
	threadId: Schema.String,
	objective: Schema.String,
	status: Schema.String,
	tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
	tokensUsed: Schema.Number,
	timeUsedSeconds: Schema.Number,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export const ThreadGoalGetParamsSchema = Schema.Struct({
	threadId: Schema.String,
});
export const ThreadGoalGetResponseSchema = Schema.Struct({
	goal: Schema.optional(Schema.NullOr(ThreadGoalSchema)),
});
export const ThreadGoalSetParamsSchema = Schema.Struct({
	threadId: Schema.String,
	objective: Schema.optional(Schema.NullOr(Schema.String)),
	status: Schema.optional(Schema.NullOr(Schema.String)),
	tokenBudget: Schema.optional(Schema.NullOr(Schema.Number)),
	origin: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ThreadGoalSetResponseSchema = Schema.Struct({
	goal: ThreadGoalSchema,
});
export const ThreadGoalClearParamsSchema = Schema.Struct({
	threadId: Schema.String,
	origin: Schema.optional(Schema.NullOr(Schema.String)),
});
export const ThreadGoalClearResponseSchema = Schema.Struct({
	cleared: Schema.Boolean,
});
export const ThreadGoalUpdatedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.optional(Schema.NullOr(Schema.String)),
	goal: ThreadGoalSchema,
});
export const ThreadGoalClearedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
});

export const TextInputSchema = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
	text_elements: Schema.optional(Schema.Array(Schema.Unknown)),
});
export const ImageUrlInputSchema = Schema.Struct({
	type: Schema.Literal("image"),
	url: Schema.String,
});
export const ImageFileInputSchema = Schema.Struct({
	type: Schema.Literal("image"),
	fileId: Schema.String,
});
export const SkillInputSchema = Schema.Struct({
	type: Schema.Literal("skill"),
	name: Schema.String,
	path: Schema.String,
});
export const UserInputSchema = Schema.Union([
	TextInputSchema,
	ImageUrlInputSchema,
	ImageFileInputSchema,
	SkillInputSchema,
]);
export const SandboxPolicySchema = Schema.Struct({
	type: Schema.String,
	writableRoots: Schema.optional(Schema.Array(Schema.String)),
});
export const CollaborationSettingsSchema = Schema.Struct({
	model: Schema.String,
	reasoning_effort: Schema.optional(Schema.NullOr(Schema.String)),
	developer_instructions: Schema.optional(Schema.NullOr(Schema.String)),
});
export const CollaborationModeSchema = Schema.Struct({
	mode: Schema.String,
	settings: CollaborationSettingsSchema,
});
export const TurnStartParamsSchema = Schema.Struct({
	threadId: Schema.String,
	clientUserMessageId: Schema.optional(Schema.NullOr(Schema.String)),
	input: Schema.Array(UserInputSchema),
	model: Schema.optional(Schema.NullOr(Schema.String)),
	effort: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.optional(Schema.NullOr(Schema.String)),
	approvalPolicy: Schema.optional(Schema.NullOr(Schema.String)),
	sandboxPolicy: Schema.optional(Schema.NullOr(SandboxPolicySchema)),
	approvalsReviewer: Schema.optional(Schema.NullOr(Schema.String)),
	collaborationMode: Schema.optional(Schema.NullOr(CollaborationModeSchema)),
	summary: Schema.optional(Schema.NullOr(Schema.String)),
});
export const TurnErrorSchema = Schema.Struct({
	message: Schema.String,
	codexErrorInfo: Schema.optional(Schema.NullOr(Schema.Unknown)),
	additionalDetails: Schema.optional(Schema.NullOr(Schema.String)),
});
export const TurnSchema = Schema.Struct({
	id: Schema.String,
	status: Schema.String,
	error: Schema.NullOr(TurnErrorSchema),
	startedAt: Schema.optional(Schema.NullOr(Schema.Number)),
});
export const TurnStartResponseSchema = Schema.Struct({ turn: TurnSchema });
export const TurnSteerParamsSchema = Schema.Struct({
	threadId: Schema.String,
	expectedTurnId: Schema.String,
	input: Schema.Array(UserInputSchema),
	clientUserMessageId: Schema.optional(Schema.NullOr(Schema.String)),
});
export const TurnSteerResponseSchema = Schema.Struct({ turnId: Schema.String });
export const TurnInterruptParamsSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
});
export const TurnInterruptResponseSchema = Schema.Struct({});

const ApprovalIdentityFields = {
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	reason: Schema.optional(Schema.NullOr(Schema.String)),
};
export const CommandExecutionRequestApprovalParamsSchema = Schema.Struct({
	...ApprovalIdentityFields,
	approvalId: Schema.optional(Schema.NullOr(Schema.String)),
	command: Schema.optional(Schema.NullOr(Schema.String)),
	cwd: Schema.optional(Schema.NullOr(Schema.String)),
	availableDecisions: Schema.optional(
		Schema.NullOr(Schema.Array(Schema.Unknown)),
	),
});
export const FileChangeRequestApprovalParamsSchema = Schema.Struct({
	...ApprovalIdentityFields,
});
export const PermissionsRequestApprovalParamsSchema = Schema.Struct({
	...ApprovalIdentityFields,
	cwd: Schema.String,
	// Keep the requested profile intact, including filesystem entries and globs.
	permissions: Schema.Record(Schema.String, Schema.Unknown),
});
export const ToolRequestUserInputQuestionSchema = Schema.Struct({
	id: Schema.String,
	header: Schema.String,
	question: Schema.String,
	options: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({ label: Schema.String, description: Schema.String }),
			),
		),
	),
	isOther: Schema.optional(Schema.Boolean),
	isSecret: Schema.optional(Schema.Boolean),
});
export const ToolRequestUserInputParamsSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	isBlocking: Schema.Boolean,
	questions: Schema.Array(ToolRequestUserInputQuestionSchema),
});
export const ServerRequestResolvedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	requestId: Schema.Union([Schema.String, Schema.Number]),
});
// Keep the form opaque here so unsupported schema variants get a diagnosed
// decline rather than a JSON-RPC decoding error.
export const McpServerElicitationRequestParamsSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.optional(Schema.NullOr(Schema.String)),
	serverName: Schema.String,
	mode: Schema.String,
	message: Schema.String,
	requestedSchema: Schema.optional(Schema.Unknown),
});
export const McpServerElicitationRequestResponseSchema = Schema.Struct({
	action: Schema.Literals(["accept", "decline", "cancel"]),
	content: Schema.optional(Schema.Unknown),
});

export const ContextCompactionItemSchema = Schema.Struct({
	type: Schema.Literal("contextCompaction"),
	id: Schema.String,
});

export const AgentMessageItemSchema = Schema.Struct({
	type: Schema.Literal("agentMessage"),
	id: Schema.String,
	text: Schema.String,
	delivery: Schema.optional(Schema.NullOr(Schema.Literal("async"))),
	questions: Schema.optional(
		Schema.NullOr(
			Schema.Array(
				Schema.Struct({
					title: Schema.String,
					options: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
				}),
			),
		),
	),
});
export const ReasoningItemSchema = Schema.Struct({
	type: Schema.Literal("reasoning"),
	id: Schema.String,
	summary: Schema.Array(Schema.String),
	content: Schema.Array(Schema.String),
});
export const UserMessageItemSchema = Schema.Struct({
	type: Schema.Literal("userMessage"),
	id: Schema.String,
	clientId: Schema.optional(Schema.NullOr(Schema.String)),
	content: Schema.Array(UserInputSchema),
});
export const PlanItemSchema = Schema.Struct({
	type: Schema.Literal("plan"),
	id: Schema.String,
	text: Schema.String,
});
export const CommandExecutionItemSchema = Schema.Struct({
	type: Schema.Literal("commandExecution"),
	id: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.String,
	aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
	exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
	durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
});
export const FileUpdateChangeSchema = Schema.Struct({
	path: Schema.String,
	diff: Schema.String,
});
export const FileChangeItemSchema = Schema.Struct({
	type: Schema.Literal("fileChange"),
	id: Schema.String,
	changes: Schema.Array(FileUpdateChangeSchema),
	status: Schema.String,
});
export const McpToolCallItemSchema = Schema.Struct({
	type: Schema.Literal("mcpToolCall"),
	id: Schema.String,
	server: Schema.String,
	tool: Schema.String,
	arguments: Schema.Unknown,
	status: Schema.String,
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(
		Schema.NullOr(Schema.Struct({ message: Schema.String })),
	),
	durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
});
export const WebSearchItemSchema = Schema.Struct({
	type: Schema.Literal("webSearch"),
	id: Schema.String,
	query: Schema.String,
	results: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
});
export const ImageViewItemSchema = Schema.Struct({
	type: Schema.Literal("imageView"),
	id: Schema.String,
	path: Schema.String,
});
export const CollabAgentToolCallItemSchema = Schema.Struct({
	type: Schema.Literal("collabAgentToolCall"),
	id: Schema.String,
	tool: Schema.String,
	status: Schema.String,
	prompt: Schema.optional(Schema.NullOr(Schema.String)),
	senderThreadId: Schema.String,
	receiverThreadIds: Schema.Array(Schema.String),
	agentsStates: Schema.Record(
		Schema.String,
		Schema.Struct({
			status: Schema.Literals([
				"pendingInit",
				"running",
				"interrupted",
				"completed",
				"errored",
				"shutdown",
				"notFound",
			]),
			message: Schema.optional(Schema.NullOr(Schema.String)),
		}),
	),
	model: Schema.optional(Schema.NullOr(Schema.String)),
	reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
});
export const SubAgentActivityItemSchema = Schema.Struct({
	type: Schema.Literal("subAgentActivity"),
	id: Schema.String,
	agentPath: Schema.String,
	agentThreadId: Schema.String,
	kind: Schema.Literals(["started", "interacted", "interrupted", "completed"]),
	model: Schema.optional(Schema.NullOr(Schema.String)),
	reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
});

const UnknownItemWireSchema = Schema.StructWithRest(
	Schema.Struct({
		// Also accept a known discriminator when its narrow schema fails.
		type: Schema.String,
		id: Schema.String,
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
);
export const UnknownItemSchema = UnknownItemWireSchema.pipe(
	Schema.decodeTo(
		Schema.Struct({
			type: Schema.String,
			id: Schema.String,
			raw: Schema.Unknown,
		}),
		{
			decode: SchemaGetter.transform((item) => ({
				type: item.type,
				id: item.id,
				raw: item,
			})),
			encode: SchemaGetter.transform((item) => ({
				...(typeof item.raw === "object" && item.raw !== null ? item.raw : {}),
				type: item.type,
				id: item.id,
			})),
		},
	),
);
export const ThreadItemSchema = Schema.Union([
	ContextCompactionItemSchema,
	AgentMessageItemSchema,
	ReasoningItemSchema,
	UserMessageItemSchema,
	PlanItemSchema,
	CommandExecutionItemSchema,
	FileChangeItemSchema,
	McpToolCallItemSchema,
	WebSearchItemSchema,
	ImageViewItemSchema,
	CollabAgentToolCallItemSchema,
	SubAgentActivityItemSchema,
	UnknownItemSchema,
]);

export const ThreadStartedNotificationSchema = Schema.Struct({
	thread: ThreadSchema,
});
export const TurnStartedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turn: TurnSchema,
});
export const TurnCompletedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turn: TurnSchema,
});
export const ItemStartedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	item: ThreadItemSchema,
});
export const ItemCompletedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	item: ThreadItemSchema,
});
export const AgentMessageDeltaNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	delta: Schema.String,
});
export const CommandExecutionOutputDeltaNotificationSchema = Schema.Struct({
	...AgentMessageDeltaNotificationSchema.fields,
});
export const FileChangeOutputDeltaNotificationSchema = Schema.Struct({
	...AgentMessageDeltaNotificationSchema.fields,
});
export const PlanDeltaNotificationSchema = Schema.Struct({
	...AgentMessageDeltaNotificationSchema.fields,
});
export const TurnPlanStepSchema = Schema.Struct({
	step: Schema.String,
	status: Schema.String,
});
export const TurnPlanUpdatedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	plan: Schema.Array(TurnPlanStepSchema),
});
export const ReasoningSummaryTextDeltaNotificationSchema = Schema.Struct({
	...AgentMessageDeltaNotificationSchema.fields,
	summaryIndex: Schema.Number,
});
export const ReasoningSummaryPartAddedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	itemId: Schema.String,
	summaryIndex: Schema.Number,
});
export const ReasoningTextDeltaNotificationSchema = Schema.Struct({
	...AgentMessageDeltaNotificationSchema.fields,
	contentIndex: Schema.Number,
});
export const TokenUsageBreakdownSchema = Schema.Struct({
	totalTokens: Schema.Number,
	inputTokens: Schema.Number,
	cachedInputTokens: Schema.Number,
	cacheWriteInputTokens: Schema.Number,
	outputTokens: Schema.Number,
	reasoningOutputTokens: Schema.Number,
});
export const ThreadTokenUsageSchema = Schema.Struct({
	total: TokenUsageBreakdownSchema,
	last: TokenUsageBreakdownSchema,
	modelContextWindow: Schema.NullOr(Schema.Number),
});
export const ThreadTokenUsageUpdatedNotificationSchema = Schema.Struct({
	threadId: Schema.String,
	turnId: Schema.String,
	tokenUsage: ThreadTokenUsageSchema,
});
export const ErrorNotificationSchema = Schema.Struct({
	error: TurnErrorSchema,
	willRetry: Schema.Boolean,
	threadId: Schema.String,
	turnId: Schema.String,
});
export const WarningNotificationSchema = Schema.Struct({
	threadId: Schema.NullOr(Schema.String),
	message: Schema.String,
});

export const NOTIFICATION_SCHEMAS = {
	"account/login/completed": AccountLoginCompletedNotificationSchema,
	"account/updated": AccountUpdatedNotificationSchema,
	"account/rateLimits/updated": AccountRateLimitsUpdatedNotificationSchema,
	"thread/compacted": ContextCompactedNotificationSchema,
	"thread/goal/updated": ThreadGoalUpdatedNotificationSchema,
	"thread/goal/cleared": ThreadGoalClearedNotificationSchema,
	"serverRequest/resolved": ServerRequestResolvedNotificationSchema,
	"thread/started": ThreadStartedNotificationSchema,
	"thread/reverted": ThreadRevertedNotificationSchema,
	"turn/started": TurnStartedNotificationSchema,
	"turn/completed": TurnCompletedNotificationSchema,
	"item/started": ItemStartedNotificationSchema,
	"item/completed": ItemCompletedNotificationSchema,
	"item/agentMessage/delta": AgentMessageDeltaNotificationSchema,
	"item/commandExecution/outputDelta":
		CommandExecutionOutputDeltaNotificationSchema,
	"item/fileChange/outputDelta": FileChangeOutputDeltaNotificationSchema,
	"turn/plan/updated": TurnPlanUpdatedNotificationSchema,
	"item/plan/delta": PlanDeltaNotificationSchema,
	"item/reasoning/summaryTextDelta":
		ReasoningSummaryTextDeltaNotificationSchema,
	"item/reasoning/summaryPartAdded":
		ReasoningSummaryPartAddedNotificationSchema,
	"item/reasoning/textDelta": ReasoningTextDeltaNotificationSchema,
	"thread/tokenUsage/updated": ThreadTokenUsageUpdatedNotificationSchema,
	error: ErrorNotificationSchema,
	warning: WarningNotificationSchema,
};

type NotificationMethod = keyof typeof NOTIFICATION_SCHEMAS;
export type KnownNotification = {
	[M in NotificationMethod]: {
		readonly _tag: "known";
		readonly method: M;
		readonly params: (typeof NOTIFICATION_SCHEMAS)[M]["Type"];
	};
}[NotificationMethod];
export type DecodedNotification =
	| KnownNotification
	| { readonly _tag: "unknown"; readonly method: string }
	| {
			readonly _tag: "malformed";
			readonly method: NotificationMethod;
			readonly issue: SchemaIssue.Issue;
	  };

/** A malformed payload is a value, so one frame cannot terminate its stream. */
export function decodeNotification(message: {
	readonly method: string;
	readonly params: unknown;
}): DecodedNotification {
	const method = message.method;
	if (!Object.hasOwn(NOTIFICATION_SCHEMAS, method)) {
		return { _tag: "unknown", method };
	}
	// Object.hasOwn cannot narrow a string key. The same lookup chooses the
	// schema and method, preserving their relationship in KnownNotification.
	const knownMethod = method as NotificationMethod;
	const result = Schema.decodeUnknownResult(NOTIFICATION_SCHEMAS[knownMethod])(
		message.params,
	);
	return Result.isFailure(result)
		? { _tag: "malformed", method: knownMethod, issue: result.failure.issue }
		: ({
				_tag: "known",
				method: knownMethod,
				params: result.success,
			} as KnownNotification);
}

export interface ConsumedDefinition {
	readonly schemas?: readonly {
		readonly fields: Readonly<Record<string, Schema.Constraint>>;
	}[];
	readonly literals?: readonly string[];
	readonly discriminator?: string;
}

/** The drift check reads actual struct fields; consumed field lists live once. */
export const CONSUMED_DEFINITIONS = {
	ThreadCompactStartParams: { schemas: [ThreadCompactStartParamsSchema] },
	ThreadCompactStartResponse: { schemas: [ThreadCompactStartResponseSchema] },
	ContextCompactedNotification: {
		schemas: [ContextCompactedNotificationSchema],
	},
	McpServerElicitationRequestParams: {
		schemas: [McpServerElicitationRequestParamsSchema],
	},
	McpServerElicitationRequestResponse: {
		schemas: [McpServerElicitationRequestResponseSchema],
	},
	ThreadGoal: { schemas: [ThreadGoalSchema] },
	ThreadGoalStatus: { literals: KNOWN_GOAL_STATUSES },
	ThreadGoalGetParams: { schemas: [ThreadGoalGetParamsSchema] },
	ThreadGoalGetResponse: { schemas: [ThreadGoalGetResponseSchema] },
	ThreadGoalSetParams: { schemas: [ThreadGoalSetParamsSchema] },
	ThreadGoalSetResponse: { schemas: [ThreadGoalSetResponseSchema] },
	ThreadGoalClearParams: { schemas: [ThreadGoalClearParamsSchema] },
	ThreadGoalClearResponse: { schemas: [ThreadGoalClearResponseSchema] },
	ThreadGoalUpdatedNotification: {
		schemas: [ThreadGoalUpdatedNotificationSchema],
	},
	ThreadGoalClearedNotification: {
		schemas: [ThreadGoalClearedNotificationSchema],
	},
	InitializeResponse: { schemas: [InitializeResponseSchema] },
	GetAccountResponse: { schemas: [AccountReadResponseSchema] },
	GetAccountParams: { schemas: [GetAccountParamsSchema] },
	LoginAccountParams: {
		schemas: [
			BrowserLoginAccountParamsSchema,
			DeviceCodeLoginAccountParamsSchema,
		],
		discriminator: "type",
	},
	LoginAccountResponse: {
		schemas: [
			BrowserLoginAccountResponseSchema,
			DeviceCodeLoginAccountResponseSchema,
		],
		discriminator: "type",
	},
	CancelLoginAccountParams: { schemas: [CancelLoginAccountParamsSchema] },
	CancelLoginAccountResponse: { schemas: [CancelLoginAccountResponseSchema] },
	LogoutAccountResponse: { schemas: [LogoutAccountResponseSchema] },
	AccountLoginCompletedNotification: {
		schemas: [AccountLoginCompletedNotificationSchema],
	},
	AccountUpdatedNotification: { schemas: [AccountUpdatedNotificationSchema] },
	Account: { schemas: [AccountSchema] },
	SandboxPolicy: { schemas: [SandboxPolicySchema] },
	ModelListParams: { schemas: [ModelListParamsSchema] },
	ModelListResponse: { schemas: [ModelListResponseSchema] },
	SkillsListParams: { schemas: [SkillsListParamsSchema] },
	SkillsListResponse: { schemas: [SkillsListResponseSchema] },
	SkillsListEntry: { schemas: [SkillsListEntrySchema] },
	SkillMetadata: { schemas: [SkillMetadataSchema] },
	SkillErrorInfo: { schemas: [SkillErrorInfoSchema] },
	SkillScope: { literals: KNOWN_SKILL_SCOPES },
	Model: { schemas: [ModelSchema] },
	ReasoningEffortOption: { schemas: [ReasoningEffortOptionSchema] },
	ReasoningEffort: { literals: KNOWN_REASONING_EFFORTS },
	InputModality: { literals: KNOWN_INPUT_MODALITIES },
	Thread: { schemas: [ThreadSchema] },
	ThreadStartParams: { schemas: [ThreadStartParamsSchema] },
	ThreadStartResponse: { schemas: [ThreadStartResponseSchema] },
	ThreadResumeParams: { schemas: [ThreadResumeParamsSchema] },
	ThreadResumeResponse: { schemas: [ThreadResumeResponseSchema] },
	ThreadForkParams: { schemas: [ThreadForkParamsSchema] },
	ThreadForkResponse: { schemas: [ThreadForkResponseSchema] },
	ThreadRevertParams: { schemas: [ThreadRevertParamsSchema] },
	ThreadRevertResponse: { schemas: [ThreadRevertResponseSchema] },
	ThreadRevertedNotification: { schemas: [ThreadRevertedNotificationSchema] },
	UserInput: {
		schemas: [
			TextInputSchema,
			ImageUrlInputSchema,
			ImageFileInputSchema,
			SkillInputSchema,
		],
		literals: KNOWN_INPUT_TYPES,
		discriminator: "type",
	},
	TurnStartParams: { schemas: [TurnStartParamsSchema] },
	CollaborationMode: { schemas: [CollaborationModeSchema] },
	Settings: { schemas: [CollaborationSettingsSchema] },
	CommandExecutionRequestApprovalParams: {
		schemas: [CommandExecutionRequestApprovalParamsSchema],
	},
	FileChangeRequestApprovalParams: {
		schemas: [FileChangeRequestApprovalParamsSchema],
	},
	PermissionsRequestApprovalParams: {
		schemas: [PermissionsRequestApprovalParamsSchema],
	},
	ToolRequestUserInputParams: { schemas: [ToolRequestUserInputParamsSchema] },
	ToolRequestUserInputQuestion: {
		schemas: [ToolRequestUserInputQuestionSchema],
	},
	ServerRequestResolvedNotification: {
		schemas: [ServerRequestResolvedNotificationSchema],
	},
	TurnStartResponse: { schemas: [TurnStartResponseSchema] },
	TurnSteerParams: { schemas: [TurnSteerParamsSchema] },
	TurnSteerResponse: { schemas: [TurnSteerResponseSchema] },
	ThreadUnarchiveParams: { schemas: [ThreadUnarchiveParamsSchema] },
	ThreadUnarchiveResponse: { schemas: [ThreadUnarchiveResponseSchema] },
	TurnInterruptParams: { schemas: [TurnInterruptParamsSchema] },
	TurnInterruptResponse: { schemas: [TurnInterruptResponseSchema] },
	Turn: { schemas: [TurnSchema] },
	TurnError: { schemas: [TurnErrorSchema] },
	TurnStatus: { literals: KNOWN_TURN_STATUSES },
	ThreadItem: {
		schemas: [
			ContextCompactionItemSchema,
			AgentMessageItemSchema,
			ReasoningItemSchema,
			UserMessageItemSchema,
			PlanItemSchema,
			CommandExecutionItemSchema,
			FileChangeItemSchema,
			McpToolCallItemSchema,
			WebSearchItemSchema,
			ImageViewItemSchema,
			CollabAgentToolCallItemSchema,
			SubAgentActivityItemSchema,
		],
		literals: KNOWN_ITEM_TYPES,
		discriminator: "type",
	},
	ThreadStartedNotification: { schemas: [ThreadStartedNotificationSchema] },
	TurnStartedNotification: { schemas: [TurnStartedNotificationSchema] },
	TurnCompletedNotification: { schemas: [TurnCompletedNotificationSchema] },
	ItemStartedNotification: { schemas: [ItemStartedNotificationSchema] },
	ItemCompletedNotification: { schemas: [ItemCompletedNotificationSchema] },
	AgentMessageDeltaNotification: {
		schemas: [AgentMessageDeltaNotificationSchema],
	},
	CommandExecutionOutputDeltaNotification: {
		schemas: [CommandExecutionOutputDeltaNotificationSchema],
	},
	FileChangeOutputDeltaNotification: {
		schemas: [FileChangeOutputDeltaNotificationSchema],
	},
	PlanDeltaNotification: { schemas: [PlanDeltaNotificationSchema] },
	TurnPlanUpdatedNotification: { schemas: [TurnPlanUpdatedNotificationSchema] },
	TurnPlanStep: { schemas: [TurnPlanStepSchema] },
	FileUpdateChange: { schemas: [FileUpdateChangeSchema] },
	ReasoningSummaryTextDeltaNotification: {
		schemas: [ReasoningSummaryTextDeltaNotificationSchema],
	},
	ReasoningSummaryPartAddedNotification: {
		schemas: [ReasoningSummaryPartAddedNotificationSchema],
	},
	ReasoningTextDeltaNotification: {
		schemas: [ReasoningTextDeltaNotificationSchema],
	},
	ThreadTokenUsage: { schemas: [ThreadTokenUsageSchema] },
	RateLimitWindow: { schemas: [RateLimitWindowSchema] },
	RateLimitSnapshot: { schemas: [RateLimitSnapshotSchema] },
	GetAccountRateLimitsResponse: {
		schemas: [GetAccountRateLimitsResponseSchema],
	},
	AccountRateLimitsUpdatedNotification: {
		schemas: [AccountRateLimitsUpdatedNotificationSchema],
	},
	TokenUsageBreakdown: { schemas: [TokenUsageBreakdownSchema] },
	ThreadTokenUsageUpdatedNotification: {
		schemas: [ThreadTokenUsageUpdatedNotificationSchema],
	},
	ErrorNotification: { schemas: [ErrorNotificationSchema] },
	WarningNotification: { schemas: [WarningNotificationSchema] },
} satisfies Record<string, ConsumedDefinition>;
