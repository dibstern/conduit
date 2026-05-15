import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

const NonEmptyString = Schema.NonEmptyString;

export const ContextWindowOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	isDefault: Schema.optional(Schema.Boolean),
});

export const ModelInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	provider: Schema.String,
	cost: Schema.optional(
		Schema.Struct({
			input: Schema.optional(Schema.Number),
			output: Schema.optional(Schema.Number),
		}),
	),
	limit: Schema.optional(
		Schema.Struct({
			context: Schema.optional(Schema.Number),
			output: Schema.optional(Schema.Number),
		}),
	),
	variants: Schema.optional(Schema.Array(Schema.String)),
	contextWindowOptions: Schema.optional(
		Schema.Array(ContextWindowOptionSchema),
	),
});

export const ProviderInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	configured: Schema.Boolean,
	models: Schema.Array(ModelInfoSchema),
});

export const ModelSelectionSchema = Schema.Struct({
	model: Schema.String,
	provider: Schema.String,
});

export const VariantInfoSchema = Schema.Struct({
	variant: Schema.optional(Schema.String),
	variants: Schema.optional(Schema.Array(Schema.String)),
});

export const ContextWindowInfoSchema = Schema.Struct({
	contextWindow: Schema.String,
	options: Schema.Array(ContextWindowOptionSchema),
});

export const AgentInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
});

export const CommandInfoSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	args: Schema.optional(Schema.String),
});

export const ProjectInfoSchema = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	directory: Schema.String,
	clientCount: Schema.optional(Schema.Number),
	instanceId: Schema.optional(Schema.String),
});

export const InstanceStatusSchema = Schema.Literal(
	"starting",
	"healthy",
	"unhealthy",
	"stopped",
);

export const OpenCodeInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	port: Schema.Number,
	managed: Schema.Boolean,
	status: InstanceStatusSchema,
	pid: Schema.optional(Schema.Number),
	env: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
	needsRestart: Schema.optional(Schema.Boolean),
	exitCode: Schema.optional(Schema.Number),
	lastHealthCheck: Schema.optional(Schema.Number),
	restartCount: Schema.Number,
	createdAt: Schema.Number,
});

export const FileEntrySchema = Schema.Struct({
	name: Schema.String,
	type: Schema.Literal("file", "directory"),
	size: Schema.optional(Schema.Number),
});

export const TodoItemSchema = Schema.Struct({
	id: Schema.String,
	subject: Schema.String,
	description: Schema.optional(Schema.String),
	status: Schema.Literal("pending", "in_progress", "completed", "cancelled"),
});

export const PtyInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.Literal("running", "exited"),
	pid: Schema.Number,
});

const HistoryMessagePartSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	text: Schema.optional(Schema.String),
	renderedHtml: Schema.optional(Schema.String),
	state: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	callID: Schema.optional(Schema.String),
	tool: Schema.optional(Schema.String),
	time: Schema.optional(Schema.Unknown),
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

const HistoryMessageSchema = Schema.Struct({
	id: Schema.String,
	role: Schema.Literal("user", "assistant"),
	parts: Schema.optional(Schema.Array(HistoryMessagePartSchema)),
	time: Schema.optional(
		Schema.Struct({
			created: Schema.optional(Schema.Number),
			completed: Schema.optional(Schema.Number),
		}),
	),
	cost: Schema.optional(Schema.Number),
	tokens: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

export const GetModelsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	providers: Schema.Array(ProviderInfoSchema),
	active: Schema.optional(ModelSelectionSchema),
	variant: Schema.optional(VariantInfoSchema),
	contextWindow: Schema.optional(ContextWindowInfoSchema),
});

export const SwitchContextWindowResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	contextWindow: Schema.String,
	options: Schema.Array(ContextWindowOptionSchema),
});

export const SwitchModelResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	model: Schema.String,
	provider: Schema.String,
	variant: Schema.String,
	variants: Schema.Array(Schema.String),
});

export const SetDefaultModelResponseSchema = SwitchModelResponseSchema;

export const ReloadProviderSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const SwitchVariantResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	variant: Schema.String,
	variants: Schema.Array(Schema.String),
});

export const OkResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
});

export const PermissionDecisionSchema = Schema.Literal(
	"allow",
	"allow_always",
	"deny",
);

export const PermissionPersistScopeSchema = Schema.Literal("tool", "pattern");
export const PermissionUpdateDestinationSchema = Schema.Literal(
	"userSettings",
	"projectSettings",
	"localSettings",
	"session",
	"cliArg",
);
export const RpcLogLevelSchema = Schema.Literal(
	"debug",
	"verbose",
	"info",
	"warn",
	"error",
);

export const SessionInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	createdAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	updatedAt: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
	messageCount: Schema.optional(Schema.Number),
	processing: Schema.optional(Schema.Boolean),
	parentID: Schema.optional(Schema.String),
	forkMessageId: Schema.optional(Schema.String),
	forkPointTimestamp: Schema.optional(Schema.Number),
	pendingQuestionCount: Schema.optional(Schema.Number),
});

export const ListSessionsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessions: Schema.Array(SessionInfoSchema),
	roots: Schema.Boolean,
	search: Schema.optional(Schema.Boolean),
});

export const CreateSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const LoadMoreHistoryResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
	messages: Schema.Array(HistoryMessageSchema),
	hasMore: Schema.Boolean,
	total: Schema.optional(Schema.Number),
});

export const ForkSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const GetAgentsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	agents: Schema.Array(AgentInfoSchema),
	activeAgentId: Schema.optional(Schema.String),
});

export const GetCommandsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	commands: Schema.Array(CommandInfoSchema),
});

export const GetProjectsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	projects: Schema.Array(ProjectInfoSchema),
	current: Schema.optional(Schema.String),
});

export const ProjectMutationResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	projects: Schema.Array(ProjectInfoSchema),
	current: Schema.optional(Schema.String),
	addedSlug: Schema.optional(Schema.String),
});

export const InstanceListResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	instances: Schema.Array(OpenCodeInstanceSchema),
});

export const ScanNowResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	discovered: Schema.Array(Schema.Number),
	lost: Schema.Array(Schema.Number),
	active: Schema.Array(Schema.Number),
});

export const DetectProxyResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	found: Schema.Boolean,
	port: Schema.Number,
});

export const PtyListResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	ptys: Schema.Array(PtyInfoSchema),
});

export const ListDirectoriesResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	path: Schema.String,
	entries: Schema.Array(Schema.String),
});

export const GetTodoResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	items: Schema.Array(TodoItemSchema),
});

export const GetFileTreeResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	entries: Schema.Array(Schema.String),
});

export const GetFileListResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	path: Schema.String,
	entries: Schema.Array(FileEntrySchema),
});

export const GetFileContentResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	path: Schema.String,
	content: Schema.String,
	binary: Schema.optional(Schema.Boolean),
});

export const GetToolContentResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	toolId: Schema.String,
	content: Schema.String,
});

export type AgentInfo = typeof AgentInfoSchema.Type;
export type GetAgentsResponse = typeof GetAgentsResponseSchema.Type;
export type CommandInfo = typeof CommandInfoSchema.Type;
export type GetCommandsResponse = typeof GetCommandsResponseSchema.Type;
export type ProjectInfo = typeof ProjectInfoSchema.Type;
export type GetProjectsResponse = typeof GetProjectsResponseSchema.Type;
export type ProjectMutationResponse = typeof ProjectMutationResponseSchema.Type;
export type OpenCodeInstance = typeof OpenCodeInstanceSchema.Type;
export type InstanceListResponse = typeof InstanceListResponseSchema.Type;
export type ScanNowResponse = typeof ScanNowResponseSchema.Type;
export type DetectProxyResponse = typeof DetectProxyResponseSchema.Type;
export type PtyInfo = typeof PtyInfoSchema.Type;
export type PtyListResponse = typeof PtyListResponseSchema.Type;
export type ListDirectoriesResponse = typeof ListDirectoriesResponseSchema.Type;
export type TodoItem = typeof TodoItemSchema.Type;
export type GetTodoResponse = typeof GetTodoResponseSchema.Type;
export type GetFileTreeResponse = typeof GetFileTreeResponseSchema.Type;
export type FileEntry = typeof FileEntrySchema.Type;
export type GetFileListResponse = typeof GetFileListResponseSchema.Type;
export type GetFileContentResponse = typeof GetFileContentResponseSchema.Type;
export type GetToolContentResponse = typeof GetToolContentResponseSchema.Type;
export type ContextWindowOption = typeof ContextWindowOptionSchema.Type;
export type ModelInfo = typeof ModelInfoSchema.Type;
export type ProviderInfo = typeof ProviderInfoSchema.Type;
export type GetModelsResponse = typeof GetModelsResponseSchema.Type;
export type SwitchContextWindowResponse =
	typeof SwitchContextWindowResponseSchema.Type;
export type SwitchModelResponse = typeof SwitchModelResponseSchema.Type;
export type SetDefaultModelResponse = typeof SetDefaultModelResponseSchema.Type;
export type ReloadProviderSessionResponse =
	typeof ReloadProviderSessionResponseSchema.Type;
export type SwitchVariantResponse = typeof SwitchVariantResponseSchema.Type;
export type SessionInfo = typeof SessionInfoSchema.Type;
export type ListSessionsResponse = typeof ListSessionsResponseSchema.Type;
export type CreateSessionResponse = typeof CreateSessionResponseSchema.Type;
export type LoadMoreHistoryResponse = typeof LoadMoreHistoryResponseSchema.Type;
export type ForkSessionResponse = typeof ForkSessionResponseSchema.Type;
export type PermissionDecision = typeof PermissionDecisionSchema.Type;
export type PermissionPersistScope = typeof PermissionPersistScopeSchema.Type;
export type PermissionUpdateDestination =
	typeof PermissionUpdateDestinationSchema.Type;
export type RpcLogLevel = typeof RpcLogLevelSchema.Type;

export class WsRpcError extends Schema.TaggedError<WsRpcError>()("WsRpcError", {
	message: Schema.String,
}) {}

export class GetAgents extends Schema.TaggedRequest<GetAgents>()("GetAgents", {
	failure: WsRpcError,
	success: GetAgentsResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		sessionId: Schema.optional(Schema.String),
	},
}) {}

export class GetCommands extends Schema.TaggedRequest<GetCommands>()(
	"GetCommands",
	{
		failure: WsRpcError,
		success: GetCommandsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: Schema.optional(Schema.String),
		},
	},
) {}

export class GetProjects extends Schema.TaggedRequest<GetProjects>()(
	"GetProjects",
	{
		failure: WsRpcError,
		success: GetProjectsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
		},
	},
) {}

export class AddProject extends Schema.TaggedRequest<AddProject>()(
	"AddProject",
	{
		failure: WsRpcError,
		success: ProjectMutationResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			directory: NonEmptyString,
			instanceId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class RemoveProject extends Schema.TaggedRequest<RemoveProject>()(
	"RemoveProject",
	{
		failure: WsRpcError,
		success: ProjectMutationResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			slug: NonEmptyString,
		},
	},
) {}

export class RenameProject extends Schema.TaggedRequest<RenameProject>()(
	"RenameProject",
	{
		failure: WsRpcError,
		success: ProjectMutationResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			slug: NonEmptyString,
			title: NonEmptyString,
		},
	},
) {}

export class SetProjectInstance extends Schema.TaggedRequest<SetProjectInstance>()(
	"SetProjectInstance",
	{
		failure: WsRpcError,
		success: ProjectMutationResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			slug: NonEmptyString,
			instanceId: NonEmptyString,
		},
	},
) {}

export class StartInstance extends Schema.TaggedRequest<StartInstance>()(
	"StartInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			instanceId: NonEmptyString,
		},
	},
) {}

export class StopInstance extends Schema.TaggedRequest<StopInstance>()(
	"StopInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			instanceId: NonEmptyString,
		},
	},
) {}

export class RemoveInstance extends Schema.TaggedRequest<RemoveInstance>()(
	"RemoveInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			instanceId: NonEmptyString,
		},
	},
) {}

export class RenameInstance extends Schema.TaggedRequest<RenameInstance>()(
	"RenameInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			instanceId: NonEmptyString,
			name: NonEmptyString,
		},
	},
) {}

export class ScanNow extends Schema.TaggedRequest<ScanNow>()("ScanNow", {
	failure: WsRpcError,
	success: ScanNowResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
	},
}) {}

export class DetectProxy extends Schema.TaggedRequest<DetectProxy>()(
	"DetectProxy",
	{
		failure: WsRpcError,
		success: DetectProxyResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
		},
	},
) {}

export class ListPtys extends Schema.TaggedRequest<ListPtys>()("ListPtys", {
	failure: WsRpcError,
	success: PtyListResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
	},
}) {}

export class CreatePty extends Schema.TaggedRequest<CreatePty>()("CreatePty", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
	},
}) {}

export class ResizePty extends Schema.TaggedRequest<ResizePty>()("ResizePty", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
		cols: Schema.optional(Schema.Number),
		rows: Schema.optional(Schema.Number),
	},
}) {}

export class ClosePty extends Schema.TaggedRequest<ClosePty>()("ClosePty", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
	},
}) {}

export class ListDirectories extends Schema.TaggedRequest<ListDirectories>()(
	"ListDirectories",
	{
		failure: WsRpcError,
		success: ListDirectoriesResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			path: Schema.String,
		},
	},
) {}

export class GetTodo extends Schema.TaggedRequest<GetTodo>()("GetTodo", {
	failure: WsRpcError,
	success: GetTodoResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
	},
}) {}

export class SwitchAgent extends Schema.TaggedRequest<SwitchAgent>()(
	"SwitchAgent",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			agentId: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SwitchContextWindow extends Schema.TaggedRequest<SwitchContextWindow>()(
	"SwitchContextWindow",
	{
		failure: WsRpcError,
		success: SwitchContextWindowResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			contextWindow: Schema.String,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SwitchModel extends Schema.TaggedRequest<SwitchModel>()(
	"SwitchModel",
	{
		failure: WsRpcError,
		success: SwitchModelResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			modelId: NonEmptyString,
			providerId: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SetDefaultModel extends Schema.TaggedRequest<SetDefaultModel>()(
	"SetDefaultModel",
	{
		failure: WsRpcError,
		success: SetDefaultModelResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			model: NonEmptyString,
			provider: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class ReloadProviderSession extends Schema.TaggedRequest<ReloadProviderSession>()(
	"ReloadProviderSession",
	{
		failure: WsRpcError,
		success: ReloadProviderSessionResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class RenameSession extends Schema.TaggedRequest<RenameSession>()(
	"RenameSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			title: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SwitchVariant extends Schema.TaggedRequest<SwitchVariant>()(
	"SwitchVariant",
	{
		failure: WsRpcError,
		success: SwitchVariantResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			variant: Schema.String,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class GetFileTree extends Schema.TaggedRequest<GetFileTree>()(
	"GetFileTree",
	{
		failure: WsRpcError,
		success: GetFileTreeResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
		},
	},
) {}

export class GetFileList extends Schema.TaggedRequest<GetFileList>()(
	"GetFileList",
	{
		failure: WsRpcError,
		success: GetFileListResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			path: Schema.optional(Schema.String),
		},
	},
) {}

export class GetFileContent extends Schema.TaggedRequest<GetFileContent>()(
	"GetFileContent",
	{
		failure: WsRpcError,
		success: GetFileContentResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			path: NonEmptyString,
		},
	},
) {}

export class GetToolContent extends Schema.TaggedRequest<GetToolContent>()(
	"GetToolContent",
	{
		failure: WsRpcError,
		success: GetToolContentResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			toolId: NonEmptyString,
		},
	},
) {}

export class GetModels extends Schema.TaggedRequest<GetModels>()("GetModels", {
	failure: WsRpcError,
	success: GetModelsResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		sessionId: Schema.optional(Schema.String),
	},
}) {}

export class ListSessions extends Schema.TaggedRequest<ListSessions>()(
	"ListSessions",
	{
		failure: WsRpcError,
		success: ListSessionsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			roots: Schema.optional(Schema.Boolean),
			query: Schema.optional(Schema.String),
		},
	},
) {}

export class CreateSession extends Schema.TaggedRequest<CreateSession>()(
	"CreateSession",
	{
		failure: WsRpcError,
		success: CreateSessionResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			originId: NonEmptyString,
			title: Schema.optional(Schema.String),
			requestId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class ViewSession extends Schema.TaggedRequest<ViewSession>()(
	"ViewSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			originId: NonEmptyString,
		},
	},
) {}

export class DeleteSession extends Schema.TaggedRequest<DeleteSession>()(
	"DeleteSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class ForkSession extends Schema.TaggedRequest<ForkSession>()(
	"ForkSession",
	{
		failure: WsRpcError,
		success: ForkSessionResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			originId: NonEmptyString,
			sessionId: Schema.optional(NonEmptyString),
			messageId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class RespondPermission extends Schema.TaggedRequest<RespondPermission>()(
	"RespondPermission",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			originId: NonEmptyString,
			requestId: NonEmptyString,
			decision: PermissionDecisionSchema,
			persistScope: Schema.optional(PermissionPersistScopeSchema),
			persistPattern: Schema.optional(Schema.String),
			permissionDestination: Schema.optional(PermissionUpdateDestinationSchema),
		},
	},
) {}

export class AnswerQuestion extends Schema.TaggedRequest<AnswerQuestion>()(
	"AnswerQuestion",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			originId: NonEmptyString,
			toolId: NonEmptyString,
			answers: Schema.Record({ key: Schema.String, value: Schema.String }),
		},
	},
) {}

export class RejectQuestion extends Schema.TaggedRequest<RejectQuestion>()(
	"RejectQuestion",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			originId: NonEmptyString,
			toolId: NonEmptyString,
		},
	},
) {}

export class LoadMoreHistory extends Schema.TaggedRequest<LoadMoreHistory>()(
	"LoadMoreHistory",
	{
		failure: WsRpcError,
		success: LoadMoreHistoryResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			offset: Schema.Number,
		},
	},
) {}

export class RewindSession extends Schema.TaggedRequest<RewindSession>()(
	"RewindSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			messageId: NonEmptyString,
		},
	},
) {}

export class SendMessage extends Schema.TaggedRequest<SendMessage>()(
	"SendMessage",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			text: Schema.String,
			images: Schema.optional(Schema.Array(Schema.String)),
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SyncInputDraft extends Schema.TaggedRequest<SyncInputDraft>()(
	"SyncInputDraft",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			text: Schema.String,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class CancelSession extends Schema.TaggedRequest<CancelSession>()(
	"CancelSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
		},
	},
) {}

export class SetLogLevel extends Schema.TaggedRequest<SetLogLevel>()(
	"SetLogLevel",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			level: RpcLogLevelSchema,
		},
	},
) {}

export const WsRpcRequest = Schema.Union(
	GetAgents,
	GetCommands,
	GetProjects,
	ListDirectories,
	GetTodo,
	SwitchAgent,
	SwitchContextWindow,
	SwitchModel,
	SetDefaultModel,
	ReloadProviderSession,
	RenameSession,
	SwitchVariant,
	GetFileTree,
	GetFileList,
	GetFileContent,
	GetToolContent,
	GetModels,
	AddProject,
	RemoveProject,
	RenameProject,
	SetProjectInstance,
	StartInstance,
	StopInstance,
	RemoveInstance,
	RenameInstance,
	ScanNow,
	DetectProxy,
	ListPtys,
	CreatePty,
	ResizePty,
	ClosePty,
	ListSessions,
	CreateSession,
	ViewSession,
	DeleteSession,
	ForkSession,
	RespondPermission,
	AnswerQuestion,
	RejectQuestion,
	LoadMoreHistory,
	RewindSession,
	SendMessage,
	SyncInputDraft,
	CancelSession,
	SetLogLevel,
);

export type WsRpcRequest = typeof WsRpcRequest.Type;

export const WsRpcGroup = RpcGroup.make(
	Rpc.fromTaggedRequest(GetAgents),
	Rpc.fromTaggedRequest(GetCommands),
	Rpc.fromTaggedRequest(GetProjects),
	Rpc.fromTaggedRequest(ListDirectories),
	Rpc.fromTaggedRequest(GetTodo),
	Rpc.fromTaggedRequest(SwitchAgent),
	Rpc.fromTaggedRequest(SwitchContextWindow),
	Rpc.fromTaggedRequest(SwitchModel),
	Rpc.fromTaggedRequest(SetDefaultModel),
	Rpc.fromTaggedRequest(ReloadProviderSession),
	Rpc.fromTaggedRequest(RenameSession),
	Rpc.fromTaggedRequest(SwitchVariant),
	Rpc.fromTaggedRequest(GetFileTree),
	Rpc.fromTaggedRequest(GetFileList),
	Rpc.fromTaggedRequest(GetFileContent),
	Rpc.fromTaggedRequest(GetToolContent),
	Rpc.fromTaggedRequest(GetModels),
	Rpc.fromTaggedRequest(AddProject),
	Rpc.fromTaggedRequest(RemoveProject),
	Rpc.fromTaggedRequest(RenameProject),
	Rpc.fromTaggedRequest(SetProjectInstance),
	Rpc.fromTaggedRequest(StartInstance),
	Rpc.fromTaggedRequest(StopInstance),
	Rpc.fromTaggedRequest(RemoveInstance),
	Rpc.fromTaggedRequest(RenameInstance),
	Rpc.fromTaggedRequest(ScanNow),
	Rpc.fromTaggedRequest(DetectProxy),
	Rpc.fromTaggedRequest(ListPtys),
	Rpc.fromTaggedRequest(CreatePty),
	Rpc.fromTaggedRequest(ResizePty),
	Rpc.fromTaggedRequest(ClosePty),
	Rpc.fromTaggedRequest(ListSessions),
	Rpc.fromTaggedRequest(CreateSession),
	Rpc.fromTaggedRequest(ViewSession),
	Rpc.fromTaggedRequest(DeleteSession),
	Rpc.fromTaggedRequest(ForkSession),
	Rpc.fromTaggedRequest(RespondPermission),
	Rpc.fromTaggedRequest(AnswerQuestion),
	Rpc.fromTaggedRequest(RejectQuestion),
	Rpc.fromTaggedRequest(LoadMoreHistory),
	Rpc.fromTaggedRequest(RewindSession),
	Rpc.fromTaggedRequest(SendMessage),
	Rpc.fromTaggedRequest(SyncInputDraft),
	Rpc.fromTaggedRequest(CancelSession),
	Rpc.fromTaggedRequest(SetLogLevel),
);

export type WsRpcGroup = typeof WsRpcGroup;
