import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";
import type { FolderIssue } from "../project-folders.js";
import {
	ApprovalSchema,
	SessionGitSchema,
	type SessionInfo,
	SessionInfoSchema,
	SessionPermissionModeSchema,
	SessionStatusSchema,
} from "../shared-types.js";

// The single session type (ni8.5 T-1) is declared once, in shared-types, and
// re-exported here so contract consumers never reach past the contract module.
export { SessionInfoSchema, SessionStatusSchema };
export type { SessionInfo };

import {
	ClaudeSettingsOverridesSchema,
	ClaudeSettingsResolveError,
	ClaudeSettingsTrustBoundaryError,
	ResolvedClaudeSettingsSchema,
} from "./claude-settings.js";
import { ProviderDriverKindSchema } from "./provider-instance.js";
import {
	INPUT_DELIVERIES,
	InputRequestSchema,
	STEER_BLOCKERS,
	StoredEventSchema,
} from "./stored-event.js";

const NonEmptyString = Schema.NonEmptyString;

export const EnvelopeSchema = <A, I, R>(itemSchema: Schema.Schema<A, I, R>) =>
	Schema.Union(
		Schema.Struct({
			_tag: Schema.Literal("snapshot"),
			rows: Schema.Array(itemSchema),
			sequence: Schema.Number,
			hasMore: Schema.optional(Schema.Boolean),
			cursor: Schema.optional(NonEmptyString),
		}),
		Schema.Struct({ _tag: Schema.Literal("synchronized") }),
		Schema.Struct({
			_tag: Schema.Literal("upsert"),
			item: itemSchema,
			sequence: Schema.Number,
		}),
		Schema.Struct({
			_tag: Schema.Literal("remove"),
			id: Schema.String,
			sequence: Schema.Number,
		}),
	);

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
	routingOptions: Schema.optional(Schema.Array(ContextWindowOptionSchema)),
});

export const ProviderInfoSchema = Schema.Struct({
	id: Schema.String,
	instanceId: Schema.optional(Schema.String),
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

export const ModelExecutionSchema = Schema.Struct({
	requestedModel: Schema.optional(Schema.String),
	expectedModel: Schema.optional(Schema.String),
	actualModel: Schema.String,
	drifted: Schema.optional(Schema.Boolean),
}).pipe(
	Schema.filter(
		(execution) =>
			execution.drifted === undefined ||
			(execution.expectedModel !== undefined &&
				(execution.drifted === false ||
					execution.actualModel !== execution.expectedModel)),
		{
			// Not a biconditional: two ids that differ only by the `[1m]`
			// context-window suffix name the same model, so equal-identity /
			// unequal-string is a legitimate `drifted: false`. Claiming drift
			// between two identical ids is still nonsense.
			message: () =>
				"drifted requires expectedModel, and drifted=true requires actualModel to differ from expectedModel",
		},
	),
);

export const AgentInfoSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	description: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
});

export const AgentProviderScopeSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
});

export const CommandInfoSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	args: Schema.optional(Schema.String),
	/** The provider's own command or bundled skill; the composer offers these under `$`. */
	builtin: Schema.optional(Schema.Boolean),
});

export const ProjectInfoSchema = Schema.Struct({
	slug: Schema.String,
	title: Schema.String,
	folders: Schema.NonEmptyArray(Schema.String),
	missing: Schema.optional(Schema.Boolean),
	git: Schema.optional(SessionGitSchema),
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
	driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
	configDir: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
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

export const HistoryMessageSchema = Schema.Struct({
	id: Schema.String,
	role: Schema.Literal("user", "assistant"),
	isBackfilled: Schema.optional(Schema.Boolean),
	inputId: Schema.optional(Schema.String),
	steered: Schema.optional(Schema.Boolean),
	text: Schema.optional(Schema.String),
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
	modelExecution: Schema.optional(ModelExecutionSchema),
	turnTiming: Schema.optional(
		Schema.Struct({
			startedAt: Schema.Number,
			endedAt: Schema.optional(Schema.Number),
			waits: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					from: Schema.Number,
					to: Schema.optional(Schema.Number),
				}),
			),
		}),
	),
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

export const SessionDetailItemSchema = Schema.Union(
	Schema.Struct({
		_tag: Schema.Literal("transcriptMessage"),
		message: HistoryMessageSchema,
	}),
	Schema.Struct({
		_tag: Schema.Literal("event"),
		event: StoredEventSchema,
	}),
	// One input conduit is holding for the session: queued behind a running
	// turn, or sent as a steer and not yet placed. Its row id is
	// `input:<inputId>`, so a `remove` never collides with a message id.
	Schema.Struct({
		_tag: Schema.Literal("pendingInput"),
		input: Schema.Struct({
			inputId: Schema.String,
			state: Schema.Literal("queued", "steering"),
			request: InputRequestSchema,
			admittedAt: Schema.Number,
		}),
	}),
	// The session's inbox state, computed on read. Paused: inputs wait behind
	// a turn that was stopped or failed, until Resume or a normal turn. Steer:
	// why no draft could be steered now (capability or open prompt), or null.
	Schema.Struct({
		_tag: Schema.Literal("inbox"),
		inbox: Schema.Struct({
			paused: Schema.Boolean,
			steer: Schema.NullOr(Schema.Literal("no_steering", "prompt_open")),
		}),
	}),
);

// Lengths are JavaScript string lengths (UTF-16 code units), not wire bytes.
const TextSuffixSchema = Schema.Struct({
	partId: Schema.optional(Schema.String),
	from: Schema.NonNegativeInt,
	total: Schema.NonNegativeInt,
});
const DetailEnvelope = EnvelopeSchema(SessionDetailItemSchema);
export const SessionDetailEnvelopeSchema = Schema.Union(
	DetailEnvelope.members[0],
	DetailEnvelope.members[1],
	DetailEnvelope.members[2].pipe(
		Schema.extend(
			Schema.Struct({
				textSuffixes: Schema.optional(Schema.Array(TextSuffixSchema)),
			}),
		),
	),
	DetailEnvelope.members[3],
);
export type SessionDetailEnvelope = typeof SessionDetailEnvelopeSchema.Type;

export const GetModelsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	instanceId: Schema.optional(Schema.String),
	providers: Schema.Array(ProviderInfoSchema),
	active: Schema.optional(ModelSelectionSchema),
	variant: Schema.optional(VariantInfoSchema),
	contextWindow: Schema.optional(ContextWindowInfoSchema),
	permissionMode: Schema.optional(SessionPermissionModeSchema),
	hiddenModels: Schema.optional(Schema.Array(Schema.String)),
	modelExecution: Schema.optional(ModelExecutionSchema),
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

export const SetDefaultPermissionModeResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	mode: SessionPermissionModeSchema,
});

export const SetHiddenEntriesResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	hiddenModels: Schema.Array(Schema.String),
	hiddenAgents: Schema.Array(Schema.String),
});

export const ClaudeSettingsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	overrides: ClaudeSettingsOverridesSchema,
});

export const ResolveClaudeSettingsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	instanceId: Schema.String,
	resolved: ResolvedClaudeSettingsSchema,
});

export const ReloadProviderSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const SwitchVariantResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	variant: Schema.String,
	variants: Schema.Array(Schema.String),
});

export const SwitchPermissionModeResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	mode: SessionPermissionModeSchema,
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

export const ProjectSessionAvailabilitySchema = Schema.Union(
	Schema.Struct({
		projectSlug: Schema.String,
		available: Schema.Literal(true),
	}),
	Schema.Struct({
		projectSlug: Schema.String,
		available: Schema.Literal(false),
		error: Schema.String,
	}),
);

export const DaemonSessionCursorSchema = Schema.Struct({
	updatedAt: Schema.Number,
	id: Schema.String,
});

export const ListDaemonSessionsResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	sessions: Schema.Array(SessionInfoSchema),
	availability: Schema.Array(ProjectSessionAvailabilitySchema),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(DaemonSessionCursorSchema),
});

export const CreateSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const ViewSessionResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	draft: Schema.optional(Schema.String),
});

const SteerRefusedSchema = Schema.Struct({
	ok: Schema.Literal(false),
	reason: Schema.Literal(...STEER_BLOCKERS),
});

/** Ok, or a refused steer: nothing was admitted, so the browser keeps the text. */
export const SubmitInputResponseSchema = Schema.Union(
	Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.String }),
	SteerRefusedSchema,
);

/** Ok; or the input already started (or never existed) and cannot be changed;
 *  or Send now could not steer it, so it stays queued. */
export const InboxCommandResponseSchema = Schema.Union(
	Schema.Struct({ ok: Schema.Literal(true) }),
	Schema.Struct({
		ok: Schema.Literal(false),
		reason: Schema.Literal("already_started"),
	}),
	SteerRefusedSchema,
);

export const LoadMoreHistoryResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
	messages: Schema.Array(HistoryMessageSchema),
	hasMore: Schema.Boolean,
});

export const ForkSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const GetAgentsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	instanceId: Schema.optional(Schema.String),
	providerScope: AgentProviderScopeSchema,
	agents: Schema.Array(AgentInfoSchema),
	activeAgentId: Schema.optional(Schema.String),
	hiddenAgents: Schema.optional(Schema.Array(Schema.String)),
});

export const GetCommandsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	commands: Schema.Array(CommandInfoSchema),
});

export const GetProjectsResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	projects: Schema.Array(ProjectInfoSchema),
	current: Schema.optional(Schema.String),
});

export const ProjectMutationResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	projects: Schema.Array(ProjectInfoSchema),
	current: Schema.optional(Schema.String),
});

export const FolderIssueSchema: Schema.Schema<FolderIssue> = Schema.Union(
	Schema.Struct({ kind: Schema.Literal("empty") }),
	Schema.Struct({ kind: Schema.Literal("duplicate"), path: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("main-taken"),
		path: Schema.String,
		slug: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("nested"),
		path: Schema.String,
		parent: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("unknown-project"),
		slug: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("missing"), path: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("not-a-folder"), path: Schema.String }),
	Schema.Struct({ kind: Schema.Literal("create-exists"), path: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("mkdir-failed"),
		path: Schema.String,
		message: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("git-init-failed"),
		path: Schema.String,
		message: Schema.String,
	}),
	Schema.Struct({
		kind: Schema.Literal("sessions-running"),
		count: Schema.Number,
	}),
);

export const ProjectFolderInputSchema = Schema.Union(
	NonEmptyString,
	Schema.Struct({
		path: NonEmptyString,
		create: Schema.Struct({ gitInit: Schema.Boolean }),
	}),
);

export type ProjectFolderInput = typeof ProjectFolderInputSchema.Type;
export interface SaveProjectInput {
	readonly slug?: string | undefined;
	readonly title?: string | undefined;
	readonly folders: readonly ProjectFolderInput[];
	readonly instanceId?: string | undefined;
}

export class ProjectSaveRejected extends Schema.TaggedError<ProjectSaveRejected>()(
	"ProjectSaveRejected",
	{ issues: Schema.Array(FolderIssueSchema) },
) {
	get message(): string {
		return this.issues
			.map((issue) => {
				if ("message" in issue)
					return `${issue.kind}: ${issue.path}: ${issue.message}`;
				if ("path" in issue) return `${issue.kind}: ${issue.path}`;
				if ("slug" in issue) return `${issue.kind}: ${issue.slug}`;
				if ("count" in issue) return `${issue.kind}: ${issue.count}`;
				return issue.kind;
			})
			.join("; ");
	}
}

export const SaveProjectResponseSchema = Schema.Struct({
	...ProjectMutationResponseSchema.fields,
	savedSlug: Schema.String,
	warnings: Schema.Array(FolderIssueSchema),
});

export const InstanceListResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	instances: Schema.Array(OpenCodeInstanceSchema),
	addedInstanceId: Schema.optional(Schema.String),
});

export const GetInstanceStatusResponseSchema = Schema.Struct({
	instance: OpenCodeInstanceSchema,
});

export const GetStatusResponseSchema = Schema.Struct({
	uptime: Schema.Number,
	port: Schema.Number,
	host: Schema.String,
	tailscaleIP: Schema.optional(Schema.String),
	lanIP: Schema.optional(Schema.String),
	projectCount: Schema.Number,
	sessionCount: Schema.Number,
	processingCount: Schema.optional(Schema.Number),
	clientCount: Schema.Number,
	pinEnabled: Schema.Boolean,
	tlsEnabled: Schema.Boolean,
	tailscaleServe: Schema.optional(
		Schema.Union(
			Schema.Struct({ url: Schema.String }),
			Schema.Struct({ error: Schema.String }),
		),
	),
	keepAwake: Schema.Boolean,
	projects: Schema.Array(
		Schema.Struct({
			slug: Schema.String,
			folders: Schema.NonEmptyArray(Schema.String),
			title: Schema.String,
			status: Schema.optional(Schema.String),
			lastUsed: Schema.optional(Schema.Number),
			sse: Schema.optional(
				Schema.Struct({
					connected: Schema.Boolean,
					lastEventAt: Schema.NullOr(Schema.Number),
					reconnectCount: Schema.Number,
					stale: Schema.Boolean,
				}),
			),
		}),
	),
});

export const SetKeepAwakeResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	supported: Schema.Boolean,
	active: Schema.Boolean,
});

export const ScanNowResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	discovered: Schema.Array(Schema.Number),
	lost: Schema.Array(Schema.Number),
	active: Schema.Array(Schema.Number),
});

export const DetectProxyResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	found: Schema.Boolean,
	port: Schema.Number,
});

export const PtyListResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	ptys: Schema.Array(PtyInfoSchema),
});

export const FindFoldersResponseSchema = Schema.Struct({
	/** The server's home folder, so paths can be shown as ~/... */
	home: Schema.String,
	entries: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			isGitRepo: Schema.Boolean,
			reason: Schema.Literal("recent", "sibling", "match"),
			exists: Schema.Boolean,
		}),
	),
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

export const GetSkillContentResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	name: Schema.String,
	path: Schema.String,
	content: Schema.String,
});

export const GetSessionSkillsResponseSchema = Schema.Struct({
	loads: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			invokedBy: Schema.Literal("user", "agent"),
			turnOrdinal: Schema.Number,
			at: Schema.Number,
			anchor: Schema.Struct({
				messageId: Schema.String,
				partId: Schema.optional(Schema.String),
			}),
			running: Schema.Boolean,
		}),
	),
});

export type AgentInfo = typeof AgentInfoSchema.Type;
export type AgentProviderScope = typeof AgentProviderScopeSchema.Type;
export type GetAgentsResponse = typeof GetAgentsResponseSchema.Type;
export type CommandInfo = typeof CommandInfoSchema.Type;
export type GetCommandsResponse = typeof GetCommandsResponseSchema.Type;
export type ProjectInfo = typeof ProjectInfoSchema.Type;
export type GetProjectsResponse = typeof GetProjectsResponseSchema.Type;
export type ProjectMutationResponse = typeof ProjectMutationResponseSchema.Type;
export type SaveProjectResponse = typeof SaveProjectResponseSchema.Type;
export type OpenCodeInstance = typeof OpenCodeInstanceSchema.Type;
export type InstanceListResponse = typeof InstanceListResponseSchema.Type;
export type GetInstanceStatusResponse =
	typeof GetInstanceStatusResponseSchema.Type;
export type GetStatusResponse = typeof GetStatusResponseSchema.Type;
export type SetKeepAwakeResponse = typeof SetKeepAwakeResponseSchema.Type;
export type ScanNowResponse = typeof ScanNowResponseSchema.Type;
export type DetectProxyResponse = typeof DetectProxyResponseSchema.Type;
export type PtyInfo = typeof PtyInfoSchema.Type;
export type PtyListResponse = typeof PtyListResponseSchema.Type;
export type FindFoldersResponse = typeof FindFoldersResponseSchema.Type;
export type TodoItem = typeof TodoItemSchema.Type;
export type GetFileTreeResponse = typeof GetFileTreeResponseSchema.Type;
export type FileEntry = typeof FileEntrySchema.Type;
export type GetFileListResponse = typeof GetFileListResponseSchema.Type;
export type GetFileContentResponse = typeof GetFileContentResponseSchema.Type;
export type GetToolContentResponse = typeof GetToolContentResponseSchema.Type;
export type GetSkillContentResponse = typeof GetSkillContentResponseSchema.Type;
export type GetSessionSkillsResponse =
	typeof GetSessionSkillsResponseSchema.Type;
export type ContextWindowOption = typeof ContextWindowOptionSchema.Type;
export type ModelInfo = typeof ModelInfoSchema.Type;
export type ProviderInfo = typeof ProviderInfoSchema.Type;
export type GetModelsResponse = typeof GetModelsResponseSchema.Type;
export type SwitchContextWindowResponse =
	typeof SwitchContextWindowResponseSchema.Type;
export type SwitchModelResponse = typeof SwitchModelResponseSchema.Type;
export type SetDefaultModelResponse = typeof SetDefaultModelResponseSchema.Type;
export type SetDefaultPermissionModeResponse =
	typeof SetDefaultPermissionModeResponseSchema.Type;
export type SetHiddenEntriesResponse =
	typeof SetHiddenEntriesResponseSchema.Type;
export type ClaudeSettingsResponse = typeof ClaudeSettingsResponseSchema.Type;
export type ResolveClaudeSettingsResponse =
	typeof ResolveClaudeSettingsResponseSchema.Type;
export type ReloadProviderSessionResponse =
	typeof ReloadProviderSessionResponseSchema.Type;
export type SwitchVariantResponse = typeof SwitchVariantResponseSchema.Type;
export type SwitchPermissionModeResponse =
	typeof SwitchPermissionModeResponseSchema.Type;
export type ProjectSessionAvailability =
	typeof ProjectSessionAvailabilitySchema.Type;
export type ListDaemonSessionsResponse =
	typeof ListDaemonSessionsResponseSchema.Type;
export type CreateSessionResponse = typeof CreateSessionResponseSchema.Type;
export type ViewSessionResponse = typeof ViewSessionResponseSchema.Type;
export type SubmitInputResponse = typeof SubmitInputResponseSchema.Type;
export type InboxCommandResponse = typeof InboxCommandResponseSchema.Type;
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

export class GetStatus extends Schema.TaggedRequest<GetStatus>()("GetStatus", {
	failure: WsRpcError,
	success: GetStatusResponseSchema,
	payload: {},
}) {}

export class SetPin extends Schema.TaggedRequest<SetPin>()("SetPin", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: {
		pin: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^\d{4,8}$/))),
	},
}) {}

export class SetKeepAwake extends Schema.TaggedRequest<SetKeepAwake>()(
	"SetKeepAwake",
	{
		failure: WsRpcError,
		success: SetKeepAwakeResponseSchema,
		payload: { enabled: Schema.Boolean },
	},
) {}

export class SetKeepAwakeCommand extends Schema.TaggedRequest<SetKeepAwakeCommand>()(
	"SetKeepAwakeCommand",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			command: NonEmptyString,
			args: Schema.optionalWith(Schema.Array(Schema.String), {
				default: () => [],
			}),
		},
	},
) {}

export class Shutdown extends Schema.TaggedRequest<Shutdown>()("Shutdown", {
	payload: {},
	failure: WsRpcError,
	success: OkResponseSchema,
}) {}

export class SetAgent extends Schema.TaggedRequest<SetAgent>()("SetAgent", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: { slug: Schema.String, agent: Schema.String },
}) {}

export class RestartWithConfig extends Schema.TaggedRequest<RestartWithConfig>()(
	"RestartWithConfig",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			config: Schema.optional(
				Schema.Record({ key: Schema.String, value: Schema.Unknown }),
			),
		},
	},
) {}

export class GetInstances extends Schema.TaggedRequest<GetInstances>()(
	"GetInstances",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {},
	},
) {}

export class GetInstanceStatus extends Schema.TaggedRequest<GetInstanceStatus>()(
	"GetInstanceStatus",
	{
		failure: WsRpcError,
		success: GetInstanceStatusResponseSchema,
		payload: { instanceId: NonEmptyString },
	},
) {}

export class GetAgents extends Schema.TaggedRequest<GetAgents>()("GetAgents", {
	failure: WsRpcError,
	success: GetAgentsResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		sessionId: Schema.optional(Schema.String),
		instanceId: Schema.optional(Schema.String),
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
			projectSlug: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SaveProject extends Schema.TaggedRequest<SaveProject>()(
	"SaveProject",
	{
		failure: Schema.Union(WsRpcError, ProjectSaveRejected),
		success: SaveProjectResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			slug: Schema.optional(NonEmptyString),
			title: Schema.optional(NonEmptyString),
			folders: Schema.Array(ProjectFolderInputSchema),
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
			projectSlug: Schema.optional(NonEmptyString),
			slug: NonEmptyString,
		},
	},
) {}

export class SetProjectInstance extends Schema.TaggedRequest<SetProjectInstance>()(
	"SetProjectInstance",
	{
		failure: WsRpcError,
		success: ProjectMutationResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
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
			projectSlug: Schema.optional(NonEmptyString),
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
			projectSlug: Schema.optional(NonEmptyString),
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
			projectSlug: Schema.optional(NonEmptyString),
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
			projectSlug: Schema.optional(NonEmptyString),
			instanceId: NonEmptyString,
			name: NonEmptyString,
		},
	},
) {}

export class AddInstance extends Schema.TaggedRequest<AddInstance>()(
	"AddInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			name: NonEmptyString,
			driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
			managed: Schema.optional(Schema.Boolean),
			port: Schema.optional(Schema.Number),
			url: Schema.optional(Schema.String),
			env: Schema.optional(
				Schema.Record({ key: Schema.String, value: Schema.String }),
			),
			configDir: Schema.optional(Schema.String),
		},
	},
) {}

export class UpdateInstance extends Schema.TaggedRequest<UpdateInstance>()(
	"UpdateInstance",
	{
		failure: WsRpcError,
		success: InstanceListResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			instanceId: NonEmptyString,
			driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
			name: Schema.optional(Schema.String),
			port: Schema.optional(Schema.Number),
			env: Schema.optional(
				Schema.Record({ key: Schema.String, value: Schema.String }),
			),
			configDir: Schema.optional(Schema.String),
		},
	},
) {}

const AutoSettleSettingResponseSchema = Schema.Struct({
	autoSettleAfterDays: Schema.NullOr(Schema.Number),
});

export class GetAutoSettleSetting extends Schema.TaggedRequest<GetAutoSettleSetting>()(
	"GetAutoSettleSetting",
	{
		failure: WsRpcError,
		success: AutoSettleSettingResponseSchema,
		payload: {},
	},
) {}

export class SetAutoSettleSetting extends Schema.TaggedRequest<SetAutoSettleSetting>()(
	"SetAutoSettleSetting",
	{
		failure: WsRpcError,
		success: AutoSettleSettingResponseSchema,
		payload: { autoSettleAfterDays: Schema.NullOr(Schema.Number) },
	},
) {}

export class ScanNow extends Schema.TaggedRequest<ScanNow>()("ScanNow", {
	failure: WsRpcError,
	success: ScanNowResponseSchema,
	payload: {
		projectSlug: Schema.optional(NonEmptyString),
	},
}) {}

export class DetectProxy extends Schema.TaggedRequest<DetectProxy>()(
	"DetectProxy",
	{
		failure: WsRpcError,
		success: DetectProxyResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
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

/** Keystrokes for one terminal. Unary and never coalesced: input latency is
 *  the user's typing, so each call carries what was typed since the last ack. */
export class PtyInput extends Schema.TaggedRequest<PtyInput>()("PtyInput", {
	failure: WsRpcError,
	success: OkResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
		data: Schema.String,
	},
}) {}

export class FindFolders extends Schema.TaggedRequest<FindFolders>()(
	"FindFolders",
	{
		failure: WsRpcError,
		success: FindFoldersResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			query: Schema.String,
		},
	},
) {}

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

export class SetDefaultPermissionMode extends Schema.TaggedRequest<SetDefaultPermissionMode>()(
	"SetDefaultPermissionMode",
	{
		failure: WsRpcError,
		success: SetDefaultPermissionModeResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			mode: SessionPermissionModeSchema,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SetHiddenEntries extends Schema.TaggedRequest<SetHiddenEntries>()(
	"SetHiddenEntries",
	{
		failure: WsRpcError,
		success: SetHiddenEntriesResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			hiddenModels: Schema.optional(Schema.Array(Schema.String)),
			hiddenAgents: Schema.optional(Schema.Array(Schema.String)),
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class GetClaudeSettings extends Schema.TaggedRequest<GetClaudeSettings>()(
	"GetClaudeSettings",
	{
		failure: WsRpcError,
		success: ClaudeSettingsResponseSchema,
		payload: { projectSlug: NonEmptyString },
	},
) {}

export class SetClaudeSettings extends Schema.TaggedRequest<SetClaudeSettings>()(
	"SetClaudeSettings",
	{
		failure: Schema.Union(WsRpcError, ClaudeSettingsTrustBoundaryError),
		success: ClaudeSettingsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			overrides: ClaudeSettingsOverridesSchema,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class ResolveClaudeSettings extends Schema.TaggedRequest<ResolveClaudeSettings>()(
	"ResolveClaudeSettings",
	{
		failure: Schema.Union(WsRpcError, ClaudeSettingsResolveError),
		success: ResolveClaudeSettingsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			instanceId: NonEmptyString,
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
			commandId: NonEmptyString,
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

export class MarkSessionUnread extends Schema.TaggedRequest<MarkSessionUnread>()(
	"MarkSessionUnread",
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

/**
 * `session.mark_seen`: the user picked the session in the sidebar, having seen
 * it up to stream version `upTo`. The server caps `upTo` at the latest turn
 * end, so a report can never mark a turn that has not happened yet as seen.
 */
export class MarkSessionSeen extends Schema.TaggedRequest<MarkSessionSeen>()(
	"MarkSessionSeen",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			upTo: Schema.NonNegativeInt,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class MarkSessionRead extends Schema.TaggedRequest<MarkSessionRead>()(
	"MarkSessionRead",
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

export class SetSessionSettled extends Schema.TaggedRequest<SetSessionSettled>()(
	"SetSessionSettled",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			settled: Schema.Boolean,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SetSessionPinned extends Schema.TaggedRequest<SetSessionPinned>()(
	"SetSessionPinned",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			pinned: Schema.Boolean,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SetSessionAutoSettle extends Schema.TaggedRequest<SetSessionAutoSettle>()(
	"SetSessionAutoSettle",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			disabled: Schema.Boolean,
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class SnoozeSession extends Schema.TaggedRequest<SnoozeSession>()(
	"SnoozeSession",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			until: Schema.NullOr(Schema.Number),
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

export class UnsnoozeSession extends Schema.TaggedRequest<UnsnoozeSession>()(
	"UnsnoozeSession",
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

export class SwitchPermissionMode extends Schema.TaggedRequest<SwitchPermissionMode>()(
	"SwitchPermissionMode",
	{
		failure: WsRpcError,
		success: SwitchPermissionModeResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			mode: SessionPermissionModeSchema,
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

export class GetSkillContent extends Schema.TaggedRequest<GetSkillContent>()(
	"GetSkillContent",
	{
		failure: WsRpcError,
		success: GetSkillContentResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			name: NonEmptyString,
		},
	},
) {}

export class GetSessionSkills extends Schema.TaggedRequest<GetSessionSkills>()(
	"GetSessionSkills",
	{
		failure: WsRpcError,
		success: GetSessionSkillsResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
		},
	},
) {}

export class GetModels extends Schema.TaggedRequest<GetModels>()("GetModels", {
	failure: WsRpcError,
	success: GetModelsResponseSchema,
	payload: {
		projectSlug: NonEmptyString,
		sessionId: Schema.optional(Schema.String),
		instanceId: Schema.optional(Schema.String),
	},
}) {}

export class ListDaemonSessions extends Schema.TaggedRequest<ListDaemonSessions>()(
	"ListDaemonSessions",
	{
		failure: WsRpcError,
		success: ListDaemonSessionsResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			limit: Schema.optional(Schema.Number),
			roots: Schema.optional(Schema.Boolean),
			search: Schema.optional(Schema.String),
			cursor: Schema.optional(DaemonSessionCursorSchema),
			scope: Schema.optional(NonEmptyString),
			exclude: Schema.optional(NonEmptyString),
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
			instanceId: Schema.optional(
				Schema.String.pipe(Schema.brand("ProviderInstanceId")),
			),
			providerId: Schema.optional(Schema.String),
			// The draft composer's model, and its effort if one was picked.
			// Recorded as the session's own choice so the first turn runs them
			// instead of the relay default.
			model: Schema.optional(
				Schema.Struct({
					modelId: NonEmptyString,
					providerId: NonEmptyString,
					variant: Schema.optional(Schema.String),
				}),
			),
		},
	},
) {}

export class ViewSession extends Schema.TaggedRequest<ViewSession>()(
	"ViewSession",
	{
		failure: WsRpcError,
		success: ViewSessionResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			originId: NonEmptyString,
		},
	},
) {}

export class PreWarmSession extends Schema.TaggedRequest<PreWarmSession>()(
	"PreWarmSession",
	{
		failure: WsRpcError,
		success: Schema.Void,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
		},
	},
) {}

export class AttachProject extends Schema.TaggedRequest<AttachProject>()(
	"AttachProject",
	{
		failure: WsRpcError,
		// The project this tab is now attached to; null when none is registered.
		success: Schema.Struct({ projectSlug: Schema.NullOr(Schema.String) }),
		payload: {
			// Hints, in priority order: the session's project, then projectSlug.
			// The server falls back to its default project when neither resolves.
			sessionId: Schema.optional(NonEmptyString),
			projectSlug: Schema.optional(NonEmptyString),
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

export class StartSideThread extends Schema.TaggedRequest<StartSideThread>()(
	"StartSideThread",
	{
		failure: WsRpcError,
		success: Schema.Struct({ sessionId: Schema.String }),
		payload: {
			projectSlug: NonEmptyString,
			parentSessionId: NonEmptyString,
			title: NonEmptyString,
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
			commandId: NonEmptyString,
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
			commandId: NonEmptyString,
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
			commandId: NonEmptyString,
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
			before: Schema.optional(NonEmptyString),
		},
	},
) {}

export const RewindSessionResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	sessionId: NonEmptyString,
	messageId: NonEmptyString,
});

export type RewindSessionResponse = typeof RewindSessionResponseSchema.Type;

export class RewindSession extends Schema.TaggedRequest<RewindSession>()(
	"RewindSession",
	{
		failure: WsRpcError,
		success: RewindSessionResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			messageId: NonEmptyString,
		},
	},
) {}

/** The composer's only send. The inbox hands it off when the session is idle
 *  and queues it otherwise, or with delivery "steer" hands it into the running
 *  turn; a refused steer admits nothing. A retry with the same input id is a
 *  no-op. */
export class SubmitInput extends Schema.TaggedRequest<SubmitInput>()(
	"input.submit",
	{
		failure: WsRpcError,
		success: SubmitInputResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			inputId: NonEmptyString,
			text: Schema.String,
			images: Schema.optional(Schema.Array(Schema.String)),
			delivery: Schema.Literal(...INPUT_DELIVERIES),
			originId: Schema.optional(NonEmptyString),
		},
	},
) {}

/** Remove a queued input (the tray's Remove, and Edit before refilling). */
export class CancelInput extends Schema.TaggedRequest<CancelInput>()(
	"input.cancel",
	{
		failure: WsRpcError,
		success: InboxCommandResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			inputId: NonEmptyString,
		},
	},
) {}

/** Hand a queued input off now; Resume calls it on the oldest row. */
export class SendInputNow extends Schema.TaggedRequest<SendInputNow>()(
	"input.sendNow",
	{
		failure: WsRpcError,
		success: InboxCommandResponseSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
			inputId: NonEmptyString,
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
			commandId: NonEmptyString,
		},
	},
) {}

export class SetLogLevel extends Schema.TaggedRequest<SetLogLevel>()(
	"SetLogLevel",
	{
		failure: WsRpcError,
		success: OkResponseSchema,
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			level: RpcLogLevelSchema,
		},
	},
) {}

export class ResolveSession extends Schema.TaggedRequest<ResolveSession>()(
	"ResolveSession",
	{
		failure: WsRpcError,
		success: Schema.Struct({ projectSlug: Schema.NullOr(Schema.String) }),
		payload: {
			projectSlug: Schema.optional(NonEmptyString),
			sessionId: NonEmptyString,
		},
	},
) {}

export const GoalDetailsSchema = Schema.Struct({
	checks: Schema.Array(
		Schema.Struct({
			iteration: Schema.NonNegativeInt,
			at: Schema.Number,
			reason: Schema.NullOr(Schema.String),
		}),
	),
	tokensSinceStart: Schema.NullOr(Schema.Number),
});
export type GoalDetails = typeof GoalDetailsSchema.Type;

export class GetGoalDetails extends Schema.TaggedRequest<GetGoalDetails>()(
	"GetGoalDetails",
	{
		failure: WsRpcError,
		success: GoalDetailsSchema,
		payload: {
			projectSlug: NonEmptyString,
			sessionId: NonEmptyString,
		},
	},
) {}

export const WsRpcRequest = Schema.Union(
	GetStatus,
	SetPin,
	SetKeepAwake,
	SetKeepAwakeCommand,
	Shutdown,
	SetAgent,
	RestartWithConfig,
	GetInstances,
	GetInstanceStatus,
	AttachProject,
	ResolveSession,
	GetGoalDetails,
	GetAgents,
	GetCommands,
	GetProjects,
	FindFolders,
	SwitchAgent,
	SwitchContextWindow,
	SwitchModel,
	SetDefaultModel,
	SetDefaultPermissionMode,
	SetHiddenEntries,
	GetClaudeSettings,
	SetClaudeSettings,
	ResolveClaudeSettings,
	ReloadProviderSession,
	RenameSession,
	MarkSessionUnread,
	MarkSessionRead,
	MarkSessionSeen,
	SetSessionSettled,
	SetSessionPinned,
	SetSessionAutoSettle,
	SnoozeSession,
	UnsnoozeSession,
	SwitchVariant,
	SwitchPermissionMode,
	GetFileTree,
	GetFileList,
	GetFileContent,
	GetToolContent,
	GetSkillContent,
	GetSessionSkills,
	GetModels,
	SaveProject,
	RemoveProject,
	SetProjectInstance,
	StartInstance,
	StopInstance,
	RemoveInstance,
	RenameInstance,
	AddInstance,
	UpdateInstance,
	GetAutoSettleSetting,
	SetAutoSettleSetting,
	ScanNow,
	DetectProxy,
	ListPtys,
	CreatePty,
	ResizePty,
	ClosePty,
	PtyInput,
	ListDaemonSessions,
	CreateSession,
	ViewSession,
	PreWarmSession,
	DeleteSession,
	ForkSession,
	StartSideThread,
	RespondPermission,
	AnswerQuestion,
	RejectQuestion,
	LoadMoreHistory,
	RewindSession,
	SubmitInput,
	CancelInput,
	SendInputNow,
	SyncInputDraft,
	CancelSession,
	SetLogLevel,
);

export type WsRpcRequest = typeof WsRpcRequest.Type;

export const SubscribeShell = Rpc.make("SubscribeShell", {
	payload: {
		projectSlug: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
	},
	success: EnvelopeSchema(SessionInfoSchema),
	error: WsRpcError,
	stream: true,
});

export const SubscribeSessionDetail = Rpc.make("SubscribeSessionDetail", {
	payload: {
		projectSlug: NonEmptyString,
		sessionId: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
		// Only clients that decode textSuffixes may opt into compressed live rows.
		textSuffixes: Schema.optional(Schema.Boolean),
	},
	success: SessionDetailEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/** One session's todo list: the items its newest TodoWrite left behind. */
export const SessionTodosSchema = Schema.Struct({
	sessionId: Schema.String,
	items: Schema.Array(TodoItemSchema),
});
export type SessionTodos = typeof SessionTodosSchema.Type;
const SessionTodosEnvelopeSchema = EnvelopeSchema(SessionTodosSchema);
export type SessionTodosEnvelope = typeof SessionTodosEnvelopeSchema.Type;

export const SubscribeSessionTodos = Rpc.make("SubscribeSessionTodos", {
	payload: {
		projectSlug: NonEmptyString,
		sessionId: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
	},
	success: SessionTodosEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/**
 * A project's terminals (conduit-test-ni8.11). Not the read-model `Envelope`:
 * PTYs live in memory, not the event store, so nothing carries a sequence and
 * every (re)subscribe is a cold snapshot — each row with its scrollback ring.
 * `output` appends to a terminal's buffer, or replaces it when `replace` is set.
 */
const PtyUpsertSchema = Schema.Struct({
	_tag: Schema.Literal("upsert"),
	item: PtyInfoSchema,
});
const PtyOutputSchema = Schema.Struct({
	_tag: Schema.Literal("output"),
	ptyId: Schema.String,
	data: Schema.String,
	replace: Schema.optional(Schema.Boolean),
});
const PtyRemoveSchema = Schema.Struct({
	_tag: Schema.Literal("remove"),
	id: Schema.String,
});
/** What a live terminal says between snapshots. */
export type PtyEvent =
	| typeof PtyUpsertSchema.Type
	| typeof PtyOutputSchema.Type
	| typeof PtyRemoveSchema.Type;
export const PtyRowSchema = Schema.Struct({
	pty: PtyInfoSchema,
	scrollback: Schema.String,
});
export type PtyRow = typeof PtyRowSchema.Type;
const PtyEnvelopeSchema = Schema.Union(
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		rows: Schema.Array(PtyRowSchema),
	}),
	Schema.Struct({ _tag: Schema.Literal("synchronized") }),
	PtyUpsertSchema,
	PtyOutputSchema,
	PtyRemoveSchema,
);
export type PtyEnvelope = typeof PtyEnvelopeSchema.Type;

export const SubscribePtys = Rpc.make("SubscribePtys", {
	payload: { projectSlug: NonEmptyString },
	success: PtyEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/**
 * Every pending permission request and question in the project (ni8.9). The
 * scope is the project, not a session: a subagent's approval renders inline in
 * its parent, and another session's in the attention banner. Removal ids are
 * the requestId or toolId the item carries.
 */
export const SubscribeApprovals = Rpc.make("SubscribeApprovals", {
	payload: {
		projectSlug: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
	},
	success: EnvelopeSchema(ApprovalSchema),
	error: WsRpcError,
	stream: true,
});

/**
 * The daemon's instance and project lists (conduit-test-ni8.14). Both are
 * daemon-global, so neither takes a project: the scope is the daemon itself.
 * Each emits the current list on subscribe, then a fresh full list per change.
 */
export const SubscribeInstances = Rpc.make("SubscribeInstances", {
	payload: {},
	success: Schema.Struct({ instances: Schema.Array(OpenCodeInstanceSchema) }),
	error: WsRpcError,
	stream: true,
});

export const SubscribeProjects = Rpc.make("SubscribeProjects", {
	payload: {},
	success: Schema.Struct({ projects: Schema.Array(ProjectInfoSchema) }),
	error: WsRpcError,
	stream: true,
});

/**
 * One project-global setting, whole. Each member owns one slot, keyed by its
 * `_tag`, so a duplicate or late delivery is idempotent and a new fact is a new
 * member rather than a reshape.
 */
export const ProjectSettingSchema = Schema.Union(
	Schema.TaggedStruct("defaultModel", {
		model: Schema.optional(Schema.String),
		provider: Schema.optional(Schema.String),
		variant: Schema.String,
	}),
	Schema.TaggedStruct("visibility", {
		hiddenModels: Schema.Array(Schema.String),
		hiddenAgents: Schema.Array(Schema.String),
	}),
	Schema.TaggedStruct("defaultPermissionMode", {
		mode: SessionPermissionModeSchema,
	}),
	Schema.TaggedStruct("claudeSettings", {
		overrides: ClaudeSettingsOverridesSchema,
	}),
	// Live facts the relay publishes as they change, not settings anyone writes.
	/** Browser sockets attached to this project. */
	Schema.TaggedStruct("clientCount", { count: Schema.Number }),
	/** The relay's SSE stream from OpenCode, not the browser's own socket. */
	Schema.TaggedStruct("opencodeConnection", {
		status: Schema.Literal("disconnected", "reconnecting", "connected"),
	}),
);
export type ProjectSetting = typeof ProjectSettingSchema.Type;
const ProjectSettingsEnvelopeSchema = EnvelopeSchema(ProjectSettingSchema);
export type ProjectSettingsEnvelope = typeof ProjectSettingsEnvelopeSchema.Type;

/** Settings are not in the read model: every subscribe opens with a snapshot. */
export const SubscribeProjectSettings = Rpc.make("SubscribeProjectSettings", {
	payload: { projectSlug: NonEmptyString },
	success: ProjectSettingsEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/** A session finished or failed in this project while no tab was viewing it. */
export const AlertSchema = Schema.TaggedStruct("alert", {
	kind: Schema.Literal("done", "error"),
	alertId: NonEmptyString,
	sessionId: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
});
export type Alert = typeof AlertSchema.Type;
const AlertsEnvelopeSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("synchronized") }),
	AlertSchema,
);
export type AlertsEnvelope = typeof AlertsEnvelopeSchema.Type;

/**
 * Live-only: opens with `synchronized` and has no snapshot, so a reconnect or
 * reload never re-fires a ding. Cross-tab dedupe rides the alertId.
 */
export const SubscribeAlerts = Rpc.make("SubscribeAlerts", {
	payload: { projectSlug: NonEmptyString },
	success: AlertsEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

const InputDraftEnvelopeSchema = Schema.Union(
	Schema.Struct({ _tag: Schema.Literal("synchronized") }),
	Schema.TaggedStruct("draft", {
		text: Schema.String,
		/** The writer's SyncInputDraft originId; that tab drops its own echo. */
		from: Schema.optional(Schema.String),
	}),
);
export type InputDraftEnvelope = typeof InputDraftEnvelopeSchema.Type;

/**
 * Live-only: a session's composer draft as other tabs type it. The draft at
 * session switch rides the ViewSession response, so resubscribing after a
 * reconnect never clobbers text typed while offline.
 */
export const SubscribeInputDraft = Rpc.make("SubscribeInputDraft", {
	payload: { projectSlug: NonEmptyString, sessionId: NonEmptyString },
	success: InputDraftEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

export const WsRpcGroup = RpcGroup.make(
	SubscribeShell,
	SubscribeSessionDetail,
	SubscribeSessionTodos,
	SubscribePtys,
	SubscribeApprovals,
	SubscribeProjectSettings,
	SubscribeAlerts,
	SubscribeInputDraft,
	SubscribeInstances,
	SubscribeProjects,
	Rpc.fromTaggedRequest(GetStatus),
	Rpc.fromTaggedRequest(SetPin),
	Rpc.fromTaggedRequest(SetKeepAwake),
	Rpc.fromTaggedRequest(SetKeepAwakeCommand),
	Rpc.fromTaggedRequest(Shutdown),
	Rpc.fromTaggedRequest(SetAgent),
	Rpc.fromTaggedRequest(RestartWithConfig),
	Rpc.fromTaggedRequest(GetInstances),
	Rpc.fromTaggedRequest(GetInstanceStatus),
	Rpc.fromTaggedRequest(AttachProject),
	Rpc.fromTaggedRequest(ResolveSession),
	Rpc.fromTaggedRequest(GetGoalDetails),
	Rpc.fromTaggedRequest(GetAgents),
	Rpc.fromTaggedRequest(GetCommands),
	Rpc.fromTaggedRequest(GetProjects),
	Rpc.fromTaggedRequest(FindFolders),
	Rpc.fromTaggedRequest(SwitchAgent),
	Rpc.fromTaggedRequest(SwitchContextWindow),
	Rpc.fromTaggedRequest(SwitchModel),
	Rpc.fromTaggedRequest(SetDefaultModel),
	Rpc.fromTaggedRequest(SetDefaultPermissionMode),
	Rpc.fromTaggedRequest(SetHiddenEntries),
	Rpc.fromTaggedRequest(GetClaudeSettings),
	Rpc.fromTaggedRequest(SetClaudeSettings),
	Rpc.fromTaggedRequest(ResolveClaudeSettings),
	Rpc.fromTaggedRequest(ReloadProviderSession),
	Rpc.fromTaggedRequest(RenameSession),
	Rpc.fromTaggedRequest(MarkSessionUnread),
	Rpc.fromTaggedRequest(MarkSessionRead),
	Rpc.fromTaggedRequest(MarkSessionSeen),
	Rpc.fromTaggedRequest(SetSessionSettled),
	Rpc.fromTaggedRequest(SetSessionPinned),
	Rpc.fromTaggedRequest(SetSessionAutoSettle),
	Rpc.fromTaggedRequest(SnoozeSession),
	Rpc.fromTaggedRequest(UnsnoozeSession),
	Rpc.fromTaggedRequest(SwitchVariant),
	Rpc.fromTaggedRequest(SwitchPermissionMode),
	Rpc.fromTaggedRequest(GetFileTree),
	Rpc.fromTaggedRequest(GetFileList),
	Rpc.fromTaggedRequest(GetFileContent),
	Rpc.fromTaggedRequest(GetToolContent),
	Rpc.fromTaggedRequest(GetSkillContent),
	Rpc.fromTaggedRequest(GetSessionSkills),
	Rpc.fromTaggedRequest(GetModels),
	Rpc.fromTaggedRequest(SaveProject),
	Rpc.fromTaggedRequest(RemoveProject),
	Rpc.fromTaggedRequest(SetProjectInstance),
	Rpc.fromTaggedRequest(StartInstance),
	Rpc.fromTaggedRequest(StopInstance),
	Rpc.fromTaggedRequest(RemoveInstance),
	Rpc.fromTaggedRequest(RenameInstance),
	Rpc.fromTaggedRequest(AddInstance),
	Rpc.fromTaggedRequest(UpdateInstance),
	Rpc.fromTaggedRequest(GetAutoSettleSetting),
	Rpc.fromTaggedRequest(SetAutoSettleSetting),
	Rpc.fromTaggedRequest(ScanNow),
	Rpc.fromTaggedRequest(DetectProxy),
	Rpc.fromTaggedRequest(ListPtys),
	Rpc.fromTaggedRequest(CreatePty),
	Rpc.fromTaggedRequest(ResizePty),
	Rpc.fromTaggedRequest(ClosePty),
	Rpc.fromTaggedRequest(PtyInput),
	Rpc.fromTaggedRequest(ListDaemonSessions),
	Rpc.fromTaggedRequest(CreateSession),
	Rpc.fromTaggedRequest(ViewSession),
	Rpc.fromTaggedRequest(PreWarmSession),
	Rpc.fromTaggedRequest(DeleteSession),
	Rpc.fromTaggedRequest(ForkSession),
	Rpc.fromTaggedRequest(StartSideThread),
	Rpc.fromTaggedRequest(RespondPermission),
	Rpc.fromTaggedRequest(AnswerQuestion),
	Rpc.fromTaggedRequest(RejectQuestion),
	Rpc.fromTaggedRequest(LoadMoreHistory),
	Rpc.fromTaggedRequest(RewindSession),
	Rpc.fromTaggedRequest(SubmitInput),
	Rpc.fromTaggedRequest(CancelInput),
	Rpc.fromTaggedRequest(SendInputNow),
	Rpc.fromTaggedRequest(SyncInputDraft),
	Rpc.fromTaggedRequest(CancelSession),
	Rpc.fromTaggedRequest(SetLogLevel),
);

export type WsRpcGroup = typeof WsRpcGroup;
