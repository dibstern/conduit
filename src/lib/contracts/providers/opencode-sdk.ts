import type {
	PostSessionIdPermissionsPermissionIdData,
	Agent as SdkAgent,
	Command as SdkCommand,
	Config as SdkConfig,
	Event as SdkEvent,
	File as SdkFile,
	FileContent as SdkFileContent,
	FileNode as SdkFileNode,
	FindFilesResponse as SdkFindFilesResponse,
	FindSymbolsResponse as SdkFindSymbolsResponse,
	FindTextResponse as SdkFindTextResponse,
	Message as SdkMessage,
	Part as SdkPart,
	Path as SdkPath,
	Project as SdkProject,
	ProviderListResponse as SdkProviderListResponse,
	Pty as SdkPty,
	Session as SdkSession,
	SessionMessageResponse as SdkSessionMessageResponse,
	SessionStatus as SdkSessionStatus,
	Symbol as SdkSymbol,
	SessionCreateData,
	SessionPromptAsyncData,
	SessionUpdateData,
} from "@opencode-ai/sdk/client";
import { Schema } from "effect";

type AssertExtends<_A extends B, B> = true;
type OptionalKeys<T> = {
	[K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;
type NormalizeSchemaType<T> =
	T extends ReadonlyArray<infer Item>
		? Array<NormalizeSchemaType<Item>>
		: T extends object
			? {
					-readonly [K in RequiredKeys<T>]: NormalizeSchemaType<T[K]>;
				} & {
					-readonly [K in OptionalKeys<T>]?: NormalizeSchemaType<
						Exclude<T[K], undefined>
					>;
				}
			: T;

const OpenCodeFileDiffSchema = Schema.Struct({
	file: Schema.String,
	before: Schema.String,
	after: Schema.String,
	additions: Schema.Number,
	deletions: Schema.Number,
});

const OpenCodeSessionTimeSchema = Schema.Struct({
	created: Schema.Number,
	updated: Schema.Number,
	compacting: Schema.optional(Schema.Number),
});

const OpenCodeSessionSummarySchema = Schema.Struct({
	additions: Schema.Number,
	deletions: Schema.Number,
	files: Schema.Number,
	diffs: Schema.optional(Schema.Array(OpenCodeFileDiffSchema)),
});

export const OpenCodeSessionSchema = Schema.Struct({
	id: Schema.String,
	projectID: Schema.String,
	directory: Schema.String,
	parentID: Schema.optional(Schema.String),
	summary: Schema.optional(OpenCodeSessionSummarySchema),
	share: Schema.optional(Schema.Struct({ url: Schema.String })),
	title: Schema.String,
	version: Schema.String,
	time: OpenCodeSessionTimeSchema,
	revert: Schema.optional(
		Schema.Struct({
			messageID: Schema.String,
			partID: Schema.optional(Schema.String),
			snapshot: Schema.optional(Schema.String),
			diff: Schema.optional(Schema.String),
		}),
	),
});

export type OpenCodeSession = Schema.Schema.Type<typeof OpenCodeSessionSchema>;

type _OpenCodeSdkSessionCoversSchema = AssertExtends<
	SdkSession,
	OpenCodeSession
>;
type _OpenCodeSessionCoversSdkSession = AssertExtends<
	NormalizeSchemaType<OpenCodeSession>,
	SdkSession
>;

export const OpenCodeSessionDetailSchema = Schema.Struct({
	...OpenCodeSessionSchema.fields,
	modelID: Schema.optional(Schema.String),
	providerID: Schema.optional(Schema.String),
	agentID: Schema.optional(Schema.String),
	slug: Schema.optional(Schema.String),
	archived: Schema.optional(Schema.Boolean),
});

export type OpenCodeSessionDetail = Schema.Schema.Type<
	typeof OpenCodeSessionDetailSchema
>;
export type SessionDetail = OpenCodeSessionDetail;

export const OpenCodeSessionDetailResponseSchema =
	OpenCodeSessionDetailSchema as unknown as Schema.Schema<OpenCodeSessionDetail>;
export const OpenCodeSessionDetailListResponseSchema = Schema.Array(
	OpenCodeSessionDetailSchema,
) as unknown as Schema.Schema<OpenCodeSessionDetail[]>;

export const OpenCodeSessionStatusSchema = Schema.Union(
	Schema.Struct({ type: Schema.Literal("idle") }),
	Schema.Struct({ type: Schema.Literal("busy") }),
	Schema.Struct({
		type: Schema.Literal("retry"),
		attempt: Schema.Number,
		message: Schema.String,
		next: Schema.Number,
	}),
);

export type OpenCodeSessionStatus = Schema.Schema.Type<
	typeof OpenCodeSessionStatusSchema
>;
export type SessionStatus = OpenCodeSessionStatus;

export const OpenCodeSessionStatusMapSchema = Schema.Record({
	key: Schema.String,
	value: OpenCodeSessionStatusSchema,
}) as unknown as Schema.Schema<Record<string, OpenCodeSessionStatus>>;

type _OpenCodeSdkSessionStatusCoversSchema = AssertExtends<
	SdkSessionStatus,
	OpenCodeSessionStatus
>;

export const OpenCodePathSchema = Schema.Struct({
	state: Schema.String,
	config: Schema.String,
	worktree: Schema.String,
	directory: Schema.String,
});

export type OpenCodePath = Schema.Schema.Type<typeof OpenCodePathSchema>;

type _OpenCodeSdkPathCoversSchema = AssertExtends<SdkPath, OpenCodePath>;
type _OpenCodePathCoversSdkPath = AssertExtends<
	NormalizeSchemaType<OpenCodePath>,
	SdkPath
>;

export const OpenCodeFileStatusEntrySchema = Schema.Struct({
	path: Schema.String,
	added: Schema.Number,
	removed: Schema.Number,
	status: Schema.Literal("added", "deleted", "modified"),
});

export type OpenCodeFileStatusEntry = Schema.Schema.Type<
	typeof OpenCodeFileStatusEntrySchema
>;

type _OpenCodeSdkFileCoversSchema = AssertExtends<
	SdkFile,
	OpenCodeFileStatusEntry
>;
type _OpenCodeFileStatusEntryCoversSdkFile = AssertExtends<
	NormalizeSchemaType<OpenCodeFileStatusEntry>,
	SdkFile
>;

export const OpenCodePtySchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	cwd: Schema.String,
	status: Schema.Literal("running", "exited"),
	pid: Schema.Number,
});

export type OpenCodePty = Schema.Schema.Type<typeof OpenCodePtySchema>;

type _OpenCodeSdkPtyCoversSchema = AssertExtends<SdkPty, OpenCodePty>;
type _OpenCodePtyCoversSdkPty = AssertExtends<
	NormalizeSchemaType<OpenCodePty>,
	SdkPty
>;

// Conduit reads only name/type from file nodes (see handlers/files.ts), so
// only those are strict; path/absolute/ignored are provider-owned fields the
// live 1.17.18 server sends but Conduit does not read, kept optional so their
// absence cannot fail-close (grill decision #10). No reverse (fully-normalized)
// assertion here — FileNode is a partially-read provider payload, not a shape
// Conduit fully normalizes.
export const OpenCodeFileNodeSchema = Schema.Struct({
	name: Schema.String,
	path: Schema.optional(Schema.String),
	absolute: Schema.optional(Schema.String),
	type: Schema.Literal("file", "directory"),
	ignored: Schema.optional(Schema.Boolean),
});

export type OpenCodeFileNode = Schema.Schema.Type<
	typeof OpenCodeFileNodeSchema
>;

// Every SDK file node is a valid OpenCodeFileNode (proves the read fields
// name/type exist in the installed SDK type with compatible shapes).
type _OpenCodeSdkFileNodeCoversSchema = AssertExtends<
	SdkFileNode,
	OpenCodeFileNode
>;

const OpenCodeFileContentPatchHunkSchema = Schema.Struct({
	oldStart: Schema.Number,
	oldLines: Schema.Number,
	newStart: Schema.Number,
	newLines: Schema.Number,
	lines: Schema.Array(Schema.String),
});

const OpenCodeFileContentPatchSchema = Schema.Struct({
	oldFileName: Schema.String,
	newFileName: Schema.String,
	oldHeader: Schema.optional(Schema.String),
	newHeader: Schema.optional(Schema.String),
	hunks: Schema.Array(OpenCodeFileContentPatchHunkSchema),
	index: Schema.optional(Schema.String),
});

export const OpenCodeFileContentSchema = Schema.Struct({
	type: Schema.Literal("text", "binary"),
	content: Schema.String,
	diff: Schema.optional(Schema.String),
	patch: Schema.optional(OpenCodeFileContentPatchSchema),
	encoding: Schema.optional(Schema.Literal("base64")),
	mimeType: Schema.optional(Schema.String),
});

export type OpenCodeFileContent = Schema.Schema.Type<
	typeof OpenCodeFileContentSchema
>;

type _OpenCodeSdkFileContentCoversSchema = AssertExtends<
	SdkFileContent,
	OpenCodeFileContent
>;
type _OpenCodeFileContentCoversSdkFileContent = AssertExtends<
	NormalizeSchemaType<OpenCodeFileContent>,
	SdkFileContent
>;

const OpenCodeRangePositionSchema = Schema.Struct({
	line: Schema.Number,
	character: Schema.Number,
});

const OpenCodeRangeSchema = Schema.Struct({
	start: OpenCodeRangePositionSchema,
	end: OpenCodeRangePositionSchema,
});

export const OpenCodeFindTextMatchSchema = Schema.Struct({
	path: Schema.Struct({ text: Schema.String }),
	lines: Schema.Struct({ text: Schema.String }),
	line_number: Schema.Number,
	absolute_offset: Schema.Number,
	submatches: Schema.Array(
		Schema.Struct({
			match: Schema.Struct({ text: Schema.String }),
			start: Schema.Number,
			end: Schema.Number,
		}),
	),
});

export type OpenCodeFindTextMatch = Schema.Schema.Type<
	typeof OpenCodeFindTextMatchSchema
>;

type _OpenCodeSdkFindTextMatchCoversSchema = AssertExtends<
	SdkFindTextResponse[number],
	OpenCodeFindTextMatch
>;
type _OpenCodeFindTextMatchCoversSdkFindTextMatch = AssertExtends<
	NormalizeSchemaType<OpenCodeFindTextMatch>,
	SdkFindTextResponse[number]
>;

export const OpenCodeFindSymbolSchema = Schema.Struct({
	name: Schema.String,
	kind: Schema.Number,
	location: Schema.Struct({
		uri: Schema.String,
		range: OpenCodeRangeSchema,
	}),
});

export type OpenCodeFindSymbol = Schema.Schema.Type<
	typeof OpenCodeFindSymbolSchema
>;

type _OpenCodeSdkFindSymbolCoversSchema = AssertExtends<
	SdkSymbol,
	OpenCodeFindSymbol
>;
type _OpenCodeFindSymbolCoversSdkFindSymbol = AssertExtends<
	NormalizeSchemaType<OpenCodeFindSymbol>,
	SdkSymbol
>;

export const OpenCodeFindFilesResponseSchema = Schema.Array(Schema.String);

export type OpenCodeFindFilesResponse = Schema.Schema.Type<
	typeof OpenCodeFindFilesResponseSchema
>;

type _OpenCodeSdkFindFilesCoversSchema = AssertExtends<
	SdkFindFilesResponse,
	OpenCodeFindFilesResponse
>;
type _OpenCodeFindFilesCoversSdkFindFiles = AssertExtends<
	NormalizeSchemaType<OpenCodeFindFilesResponse>,
	SdkFindFilesResponse
>;

type _OpenCodeSdkFindSymbolsCoversSchema = AssertExtends<
	SdkFindSymbolsResponse,
	Array<OpenCodeFindSymbol>
>;
type _OpenCodeFindSymbolsCoversSdkFindSymbols = AssertExtends<
	Array<NormalizeSchemaType<OpenCodeFindSymbol>>,
	SdkFindSymbolsResponse
>;

export const OpenCodeFindTextResponseSchema = Schema.Array(
	OpenCodeFindTextMatchSchema,
) as unknown as Schema.Schema<unknown[]>;
export const OpenCodeFindFilesArrayResponseSchema =
	OpenCodeFindFilesResponseSchema as unknown as Schema.Schema<unknown[]>;
export const OpenCodeFindSymbolsResponseSchema = Schema.Array(
	OpenCodeFindSymbolSchema,
) as unknown as Schema.Schema<unknown[]>;

export const OpenCodeConfigResponseSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
}) as unknown as Schema.Schema<Record<string, unknown>>;

export type OpenCodeConfigResponse = Schema.Schema.Type<
	typeof OpenCodeConfigResponseSchema
>;

type _OpenCodeSdkConfigIsRecordResponse = AssertExtends<
	SdkConfig,
	OpenCodeConfigResponse
>;

export const OpenCodeAgentSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.Literal("subagent", "primary", "all")),
	builtIn: Schema.optional(Schema.Boolean),
	native: Schema.optional(Schema.Boolean),
	hidden: Schema.optional(Schema.Boolean),
	topP: Schema.optional(Schema.NullOr(Schema.Number)),
	temperature: Schema.optional(Schema.NullOr(Schema.Number)),
	color: Schema.optional(Schema.NullOr(Schema.String)),
	permission: Schema.optional(Schema.Unknown),
	model: Schema.optional(
		Schema.Struct({
			modelID: Schema.String,
			providerID: Schema.String,
		}),
	),
	variant: Schema.optional(Schema.NullOr(Schema.String)),
	prompt: Schema.optional(Schema.String),
	tools: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Boolean }),
	),
	options: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Unknown }),
	),
	maxSteps: Schema.optional(Schema.Number),
	steps: Schema.optional(Schema.Number),
});

export type OpenCodeAgent = Schema.Schema.Type<typeof OpenCodeAgentSchema>;

type _OpenCodeSdkAgentCoversSchema = AssertExtends<SdkAgent, OpenCodeAgent>;

export const OpenCodeCommandSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	agent: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	template: Schema.String,
	subtask: Schema.optional(Schema.Boolean),
});

export type OpenCodeCommand = Schema.Schema.Type<typeof OpenCodeCommandSchema>;

type _OpenCodeSdkCommandCoversSchema = AssertExtends<
	SdkCommand,
	OpenCodeCommand
>;
type _OpenCodeCommandCoversSdkCommand = AssertExtends<
	NormalizeSchemaType<OpenCodeCommand>,
	SdkCommand
>;

export const OpenCodeAgentListResponseSchema =
	Schema.Array(OpenCodeAgentSchema);
export const OpenCodeCommandListResponseSchema = Schema.Array(
	OpenCodeCommandSchema,
) as unknown as Schema.Schema<Array<{ name: string; description?: string }>>;

export const OpenCodeProjectSchema = Schema.Struct({
	id: Schema.String,
	worktree: Schema.String,
	vcsDir: Schema.optional(Schema.String),
	vcs: Schema.optional(Schema.Literal("git")),
	time: Schema.Struct({
		created: Schema.Number,
		initialized: Schema.optional(Schema.Number),
	}),
});

export type OpenCodeProject = Schema.Schema.Type<typeof OpenCodeProjectSchema>;

type _OpenCodeSdkProjectCoversSchema = AssertExtends<
	SdkProject,
	OpenCodeProject
>;
type _OpenCodeProjectCoversSdkProject = AssertExtends<
	NormalizeSchemaType<OpenCodeProject>,
	SdkProject
>;

export const OpenCodeProjectListResponseSchema = Schema.Array(
	OpenCodeProjectSchema,
) as unknown as Schema.Schema<
	Array<{ id: string; worktree: string; time: { created: number } }>
>;
export const OpenCodeCurrentProjectResponseSchema =
	OpenCodeProjectSchema as unknown as Schema.Schema<{
		id: string;
		worktree: string;
		time: { created: number };
	}>;

const OpenCodeOpaquePropertiesSchema = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
});

type OpenCodeProviderModel = {
	id: string;
	name: string;
	limit: { context: number; output: number };
	variants?: Record<string, Record<string, unknown>>;
};

const OpenCodeProviderModelSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	limit: Schema.Struct({
		context: Schema.Number,
		output: Schema.Number,
	}),
	variants: Schema.optional(
		Schema.Record({
			key: Schema.String,
			value: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
		}),
	),
}).pipe(
	Schema.extend(OpenCodeOpaquePropertiesSchema),
) as unknown as Schema.Schema<OpenCodeProviderModel>;

type OpenCodeProviderListEntry = {
	name: string;
	id: string;
	models: Record<string, OpenCodeProviderModel>;
};

const OpenCodeProviderListEntrySchema = Schema.Struct({
	name: Schema.String,
	id: Schema.String,
	models: Schema.Record({
		key: Schema.String,
		value: OpenCodeProviderModelSchema,
	}),
}).pipe(
	Schema.extend(OpenCodeOpaquePropertiesSchema),
) as unknown as Schema.Schema<OpenCodeProviderListEntry>;

export type OpenCodeProviderListResponse = {
	all: OpenCodeProviderListEntry[];
	default: Record<string, string>;
	connected: string[];
};

export const OpenCodeProviderListResponseSchema = Schema.Struct({
	all: Schema.Array(OpenCodeProviderListEntrySchema),
	default: Schema.Record({ key: Schema.String, value: Schema.String }),
	connected: Schema.Array(Schema.String),
}) as unknown as Schema.Schema<OpenCodeProviderListResponse>;

type _OpenCodeSdkProviderListCoversSchema = AssertExtends<
	SdkProviderListResponse,
	OpenCodeProviderListResponse
>;

type SdkProviderListEntry = SdkProviderListResponse["all"][number];
type SdkProviderListModel = SdkProviderListEntry["models"][string];
type SdkProviderListReadView = {
	all: Array<{
		id: SdkProviderListEntry["id"];
		name: SdkProviderListEntry["name"];
		models: Record<string, Pick<SdkProviderListModel, "id" | "name" | "limit">>;
	}>;
	default: SdkProviderListResponse["default"];
	connected: SdkProviderListResponse["connected"];
};
type _OpenCodeProviderListCoversSdkReadView = AssertExtends<
	NormalizeSchemaType<OpenCodeProviderListResponse>,
	SdkProviderListReadView
>;
// SDK 1.17.18 also declares provider api/env/npm and model release_date,
// attachment, reasoning, temperature, tool_call, cost, modalities,
// experimental, status, options, headers, and provider. Live servers have also
// exposed capabilities, providerID, api, family, variants, and nested cache
// pricing. Conduit reads provider/model identity, limit, variants, defaults,
// and connected IDs only, so those fields are strict while all other provider-
// owned model catalog fields are preserved opaquely.

const OpenCodeModelRefSchema = Schema.Struct({
	providerID: Schema.String,
	modelID: Schema.String,
});

const OpenCodeProviderAuthErrorSchema = Schema.Struct({
	name: Schema.Literal("ProviderAuthError"),
	data: Schema.Struct({
		providerID: Schema.String,
		message: Schema.String,
	}),
});

const OpenCodeUnknownErrorSchema = Schema.Struct({
	name: Schema.Literal("UnknownError"),
	data: Schema.Struct({ message: Schema.String }),
});

const OpenCodeMessageOutputLengthErrorSchema = Schema.Struct({
	name: Schema.Literal("MessageOutputLengthError"),
	data: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const OpenCodeMessageAbortedErrorSchema = Schema.Struct({
	name: Schema.Literal("MessageAbortedError"),
	data: Schema.Struct({ message: Schema.String }),
});

const OpenCodeApiErrorSchema = Schema.Struct({
	name: Schema.Literal("APIError"),
	data: Schema.Struct({
		message: Schema.String,
		statusCode: Schema.optional(Schema.Number),
		isRetryable: Schema.Boolean,
		responseHeaders: Schema.optional(
			Schema.Record({ key: Schema.String, value: Schema.String }),
		),
		responseBody: Schema.optional(Schema.String),
	}),
});

const OpenCodeMessageErrorSchema = Schema.Union(
	OpenCodeProviderAuthErrorSchema,
	OpenCodeUnknownErrorSchema,
	OpenCodeMessageOutputLengthErrorSchema,
	OpenCodeMessageAbortedErrorSchema,
	OpenCodeApiErrorSchema,
);

const OpenCodeTokensSchema = Schema.Struct({
	input: Schema.Number,
	output: Schema.Number,
	reasoning: Schema.Number,
	cache: Schema.Struct({
		read: Schema.Number,
		write: Schema.Number,
	}),
});

const OpenCodeUserMessageSchema = Schema.Struct({
	id: Schema.String,
	sessionID: Schema.String,
	role: Schema.Literal("user"),
	time: Schema.Struct({ created: Schema.Number }),
	summary: Schema.optional(
		Schema.Struct({
			title: Schema.optional(Schema.String),
			body: Schema.optional(Schema.String),
			diffs: Schema.Array(OpenCodeFileDiffSchema),
		}),
	),
	agent: Schema.String,
	model: OpenCodeModelRefSchema,
	system: Schema.optional(Schema.String),
	tools: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Boolean }),
	),
});

const OpenCodeAssistantMessageSchema = Schema.Struct({
	id: Schema.String,
	sessionID: Schema.String,
	role: Schema.Literal("assistant"),
	time: Schema.Struct({
		created: Schema.Number,
		completed: Schema.optional(Schema.Number),
	}),
	error: Schema.optional(OpenCodeMessageErrorSchema),
	parentID: Schema.String,
	modelID: Schema.String,
	providerID: Schema.String,
	mode: Schema.String,
	path: Schema.Struct({
		cwd: Schema.String,
		root: Schema.String,
	}),
	summary: Schema.optional(Schema.Boolean),
	cost: Schema.Number,
	tokens: OpenCodeTokensSchema,
	finish: Schema.optional(Schema.String),
});

export const OpenCodeMessageSchema = Schema.Union(
	OpenCodeUserMessageSchema,
	OpenCodeAssistantMessageSchema,
);

export type OpenCodeMessage = Schema.Schema.Type<typeof OpenCodeMessageSchema>;

type _OpenCodeSdkMessageCoversSchema = AssertExtends<
	SdkMessage,
	OpenCodeMessage
>;
type _OpenCodeMessageCoversSdkMessage = AssertExtends<
	NormalizeSchemaType<OpenCodeMessage>,
	SdkMessage
>;

export const OpenCodePartSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
}).pipe(
	Schema.extend(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

export type OpenCodePart = Schema.Schema.Type<typeof OpenCodePartSchema>;

// Envelope-only: Conduit validates shared part identity/type and preserves
// provider-owned payload fields opaquely.
type _OpenCodeSdkPartCoversSchemaEnvelope = AssertExtends<
	SdkPart,
	OpenCodePart
>;

export const OpenCodeMessageWithPartsSchema = Schema.Struct({
	info: OpenCodeMessageSchema,
	parts: Schema.Array(OpenCodePartSchema),
});

export type OpenCodeMessageWithParts = Schema.Schema.Type<
	typeof OpenCodeMessageWithPartsSchema
>;

// Envelope-only: part payloads stay opaque, so only the SDK response must fit
// the schema envelope Conduit consumes.
type _OpenCodeSdkSessionMessageResponseCoversSchemaEnvelope = AssertExtends<
	SdkSessionMessageResponse,
	OpenCodeMessageWithParts
>;

export const OpenCodeMessageListResponseSchema = Schema.Array(
	OpenCodeMessageWithPartsSchema,
) as unknown as Schema.Schema<OpenCodeMessageWithParts[]>;

type OpenCodeSdkEventType = SdkEvent["type"];
// Gap events: the SDK's generated Event union either omits these entirely
// (message.created, message.part.delta, permission.asked, question.asked) or
// declares a shape that disagrees with the real server binary. permission.replied
// is the latter case — the npm SDK types say { sessionID, permissionID, response }
// but a live opencode 1.17.18 server emits { sessionID, requestID, reply } (wire
// verified). Excluding it here keeps our schema following the wire instead of the
// incorrect SDK type in the conformance check below.
type OpenCodeGapEventType =
	| "message.created"
	| "message.part.delta"
	| "permission.asked"
	| "permission.replied"
	| "question.asked";

export const OPEN_CODE_CONSUMED_EVENT_TYPES = [
	"message.created",
	"message.part.delta",
	"message.part.updated",
	"message.part.removed",
	"message.updated",
	"message.removed",
	"session.status",
	"session.error",
	"permission.asked",
	"permission.replied",
	"question.asked",
	"session.updated",
	"todo.updated",
	"pty.created",
	"pty.exited",
	"pty.deleted",
	"file.edited",
	"file.watcher.updated",
	"installation.update-available",
] as const;

type OpenCodeConsumedEventType =
	(typeof OPEN_CODE_CONSUMED_EVENT_TYPES)[number];
type OpenCodeSdkConsumedEventType = Exclude<
	OpenCodeConsumedEventType,
	OpenCodeGapEventType
>;
type _OpenCodeSdkContainsConsumedEventTypes = AssertExtends<
	OpenCodeSdkConsumedEventType,
	OpenCodeSdkEventType
>;

const OpenCodeEventBasePropertiesSchema = Schema.Struct({}).pipe(
	Schema.extend(OpenCodeOpaquePropertiesSchema),
);

const OpenCodeMessageCreatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.created"),
	properties: OpenCodeEventBasePropertiesSchema,
});

const OpenCodePartDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.delta"),
	properties: Schema.Struct({
		sessionID: Schema.optional(Schema.String),
		messageID: Schema.optional(Schema.String),
		partID: Schema.String,
		field: Schema.String,
		delta: Schema.String,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePartUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.updated"),
	properties: Schema.Struct({
		partID: Schema.optional(Schema.String),
		messageID: Schema.optional(Schema.String),
		part: OpenCodePartSchema,
		delta: Schema.optional(Schema.String),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePartRemovedEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.removed"),
	properties: Schema.Struct({
		sessionID: Schema.String,
		partID: Schema.String,
		messageID: Schema.String,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeMessageUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.updated"),
	properties: Schema.Struct({ info: OpenCodeMessageSchema }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

const OpenCodeMessageRemovedEventSchema = Schema.Struct({
	type: Schema.Literal("message.removed"),
	properties: Schema.Struct({
		sessionID: Schema.String,
		messageID: Schema.String,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeSessionStatusEventSchema = Schema.Struct({
	type: Schema.Literal("session.status"),
	properties: Schema.Struct({
		sessionID: Schema.String,
		status: OpenCodeSessionStatusSchema,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeEventErrorSchema = Schema.Struct({
	name: Schema.String,
	data: Schema.Struct({
		message: Schema.optional(Schema.String),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema));

const OpenCodeSessionErrorEventSchema = Schema.Struct({
	type: Schema.Literal("session.error"),
	properties: Schema.Struct({
		sessionID: Schema.optional(Schema.String),
		error: Schema.optional(OpenCodeEventErrorSchema),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePermissionAskedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.asked"),
	properties: Schema.Struct({
		id: Schema.String,
		permission: Schema.String,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePermissionRepliedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.replied"),
	// Wire-verified against opencode 1.17.18 (see OpenCodeGapEventType note):
	// the real event is { sessionID, requestID, reply }, not the SDK's
	// { sessionID, permissionID, response }.
	properties: Schema.Struct({
		sessionID: Schema.String,
		requestID: Schema.String,
		reply: Schema.String,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeQuestionAskedEventSchema = Schema.Struct({
	type: Schema.Literal("question.asked"),
	properties: Schema.Struct({
		id: Schema.String,
		questions: Schema.Array(Schema.Unknown),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeSessionUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("session.updated"),
	properties: Schema.Struct({ info: OpenCodeSessionSchema }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

// Conduit reads only content/status from todos and synthesizes its own id;
// priority/id are provider-owned and unread, kept optional so they cannot
// fail-close (grill #10).
const OpenCodeTodoSchema = Schema.Struct({
	content: Schema.String,
	status: Schema.String,
	priority: Schema.optional(Schema.String),
	id: Schema.optional(Schema.String),
});

const OpenCodeTodoUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("todo.updated"),
	properties: Schema.Struct({
		sessionID: Schema.String,
		todos: Schema.Array(OpenCodeTodoSchema),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePtyCreatedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.created"),
	properties: Schema.Struct({ info: OpenCodePtySchema }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

const OpenCodePtyExitedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.exited"),
	properties: Schema.Struct({
		id: Schema.String,
		exitCode: Schema.Number,
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodePtyDeletedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.deleted"),
	properties: Schema.Struct({ id: Schema.String }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

const OpenCodeFileEditedEventSchema = Schema.Struct({
	type: Schema.Literal("file.edited"),
	properties: Schema.Struct({ file: Schema.String }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

const OpenCodeFileWatcherUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("file.watcher.updated"),
	properties: Schema.Struct({
		// Conduit reads only `file`; `event` is provider-owned and unread, kept
		// optional so a new watcher event kind cannot fail-close (grill #10).
		file: Schema.String,
		event: Schema.optional(Schema.Literal("add", "change", "unlink")),
	}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema)),
});

const OpenCodeInstallationUpdateAvailableEventSchema = Schema.Struct({
	type: Schema.Literal("installation.update-available"),
	properties: Schema.Struct({ version: Schema.String }).pipe(
		Schema.extend(OpenCodeOpaquePropertiesSchema),
	),
});

export const OpenCodeEventSchema = Schema.Union(
	OpenCodeMessageCreatedEventSchema,
	OpenCodePartDeltaEventSchema,
	OpenCodePartUpdatedEventSchema,
	OpenCodePartRemovedEventSchema,
	OpenCodeMessageUpdatedEventSchema,
	OpenCodeMessageRemovedEventSchema,
	OpenCodeSessionStatusEventSchema,
	OpenCodeSessionErrorEventSchema,
	OpenCodePermissionAskedEventSchema,
	OpenCodePermissionRepliedEventSchema,
	OpenCodeQuestionAskedEventSchema,
	OpenCodeSessionUpdatedEventSchema,
	OpenCodeTodoUpdatedEventSchema,
	OpenCodePtyCreatedEventSchema,
	OpenCodePtyExitedEventSchema,
	OpenCodePtyDeletedEventSchema,
	OpenCodeFileEditedEventSchema,
	OpenCodeFileWatcherUpdatedEventSchema,
	OpenCodeInstallationUpdateAvailableEventSchema,
);

export type OpenCodeEvent = Schema.Schema.Type<typeof OpenCodeEventSchema>;

type _OpenCodeSdkConsumedEventsCoverSchemaEnvelopes = AssertExtends<
	Extract<SdkEvent, { type: OpenCodeSdkConsumedEventType }>,
	OpenCodeEvent
>;

export const OpenCodeSessionCreateRequestSchema = Schema.Struct({
	parentID: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
});

export type OpenCodeSessionCreateRequest = Schema.Schema.Type<
	typeof OpenCodeSessionCreateRequestSchema
>;

type _OpenCodeSdkSessionCreateRequestCoversSchema = AssertExtends<
	NonNullable<SessionCreateData["body"]>,
	OpenCodeSessionCreateRequest
>;
type _OpenCodeSessionCreateRequestCoversSdk = AssertExtends<
	NormalizeSchemaType<OpenCodeSessionCreateRequest>,
	NonNullable<SessionCreateData["body"]>
>;

export const OpenCodeSessionUpdateRequestSchema = Schema.Struct({
	title: Schema.optional(Schema.String),
});

export type OpenCodeSessionUpdateRequest = Schema.Schema.Type<
	typeof OpenCodeSessionUpdateRequestSchema
>;

type _OpenCodeSdkSessionUpdateRequestCoversSchema = AssertExtends<
	NonNullable<SessionUpdateData["body"]>,
	OpenCodeSessionUpdateRequest
>;
type _OpenCodeSessionUpdateRequestCoversSdk = AssertExtends<
	NormalizeSchemaType<OpenCodeSessionUpdateRequest>,
	NonNullable<SessionUpdateData["body"]>
>;

const OpenCodePartInputTimeSchema = Schema.Struct({
	start: Schema.Number,
	end: Schema.optional(Schema.Number),
});

const OpenCodeTextPartInputSchema = Schema.Struct({
	id: Schema.optional(Schema.String),
	type: Schema.Literal("text"),
	text: Schema.String,
	synthetic: Schema.optional(Schema.Boolean),
	ignored: Schema.optional(Schema.Boolean),
	time: Schema.optional(OpenCodePartInputTimeSchema),
	metadata: Schema.optional(OpenCodeOpaquePropertiesSchema),
});

const OpenCodeFilePartInputSchema = Schema.Struct({
	id: Schema.optional(Schema.String),
	type: Schema.Literal("file"),
	mime: Schema.String,
	filename: Schema.optional(Schema.String),
	url: Schema.String,
	source: Schema.optional(
		Schema.Union(
			Schema.Struct({
				text: Schema.Struct({
					value: Schema.String,
					start: Schema.Number,
					end: Schema.Number,
				}),
				type: Schema.Literal("file"),
				path: Schema.String,
			}),
			Schema.Struct({
				text: Schema.Struct({
					value: Schema.String,
					start: Schema.Number,
					end: Schema.Number,
				}),
				type: Schema.Literal("symbol"),
				path: Schema.String,
				range: OpenCodeRangeSchema,
				name: Schema.String,
				kind: Schema.Number,
			}),
		),
	),
});

const OpenCodeAgentPartInputSchema = Schema.Struct({
	id: Schema.optional(Schema.String),
	type: Schema.Literal("agent"),
	name: Schema.String,
	source: Schema.optional(
		Schema.Struct({
			value: Schema.String,
			start: Schema.Number,
			end: Schema.Number,
		}),
	),
});

const OpenCodeSubtaskPartInputSchema = Schema.Struct({
	id: Schema.optional(Schema.String),
	type: Schema.Literal("subtask"),
	prompt: Schema.String,
	description: Schema.String,
	agent: Schema.String,
});

const OpenCodePartInputSchema = Schema.Union(
	OpenCodeTextPartInputSchema,
	OpenCodeFilePartInputSchema,
	OpenCodeAgentPartInputSchema,
	OpenCodeSubtaskPartInputSchema,
);

export const OpenCodeSessionPromptRequestSchema = Schema.Struct({
	messageID: Schema.optional(Schema.String),
	model: Schema.optional(OpenCodeModelRefSchema),
	agent: Schema.optional(Schema.String),
	noReply: Schema.optional(Schema.Boolean),
	system: Schema.optional(Schema.String),
	tools: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.Boolean }),
	),
	parts: Schema.Array(OpenCodePartInputSchema),
});

export type OpenCodeSessionPromptRequest = Schema.Schema.Type<
	typeof OpenCodeSessionPromptRequestSchema
>;

type _OpenCodeSdkSessionPromptRequestCoversSchema = AssertExtends<
	NonNullable<SessionPromptAsyncData["body"]>,
	OpenCodeSessionPromptRequest
>;
type _OpenCodeSessionPromptRequestCoversSdk = AssertExtends<
	NormalizeSchemaType<OpenCodeSessionPromptRequest>,
	NonNullable<SessionPromptAsyncData["body"]>
>;

export const OpenCodePermissionReplyRequestSchema = Schema.Struct({
	response: Schema.Literal("once", "always", "reject"),
});

export type OpenCodePermissionReplyRequest = Schema.Schema.Type<
	typeof OpenCodePermissionReplyRequestSchema
>;

type _OpenCodeSdkPermissionReplyRequestCoversSchema = AssertExtends<
	NonNullable<PostSessionIdPermissionsPermissionIdData["body"]>,
	OpenCodePermissionReplyRequest
>;
type _OpenCodePermissionReplyRequestCoversSdk = AssertExtends<
	NormalizeSchemaType<OpenCodePermissionReplyRequest>,
	NonNullable<PostSessionIdPermissionsPermissionIdData["body"]>
>;

export const OpenCodeQuestionReplyRequestSchema = Schema.Struct({
	answers: Schema.Array(Schema.Array(Schema.String)),
});

export type OpenCodeQuestionReplyRequest = Schema.Schema.Type<
	typeof OpenCodeQuestionReplyRequestSchema
>;

export const OpenCodeQuestionRejectRequestSchema = Schema.Struct({});

export type OpenCodeQuestionRejectRequest = Schema.Schema.Type<
	typeof OpenCodeQuestionRejectRequestSchema
>;

export const OpenCodeBooleanResponseSchema = Schema.Boolean;
const OpenCodeEmptyObjectResponseSchema = Schema.Struct({}).pipe(
	Schema.filter((value) =>
		Object.keys(value).length === 0
			? undefined
			: "expected empty object for void OpenCode response",
	),
);

export const OpenCodeUndefinedResponseSchema = Schema.Union(
	Schema.Undefined,
	OpenCodeEmptyObjectResponseSchema,
);

export const OpenCodeShareResponseSchema = Schema.Struct({
	url: Schema.String,
});

export const OpenCodeDiffResponseSchema = Schema.Struct({
	diffs: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			diff: Schema.String,
		}),
	),
}) as unknown as Schema.Schema<{
	diffs: Array<{ path: string; diff: string }>;
}>;

export const OpenCodeFileEntryListResponseSchema = Schema.Array(
	OpenCodeFileNodeSchema,
) as unknown as Schema.Schema<
	Array<{
		name: string;
		path: string;
		absolute: string;
		type: "file" | "directory";
		ignored: boolean;
	}>
>;

export const OpenCodeFileReadResponseSchema =
	OpenCodeFileContentSchema as unknown as Schema.Schema<{
		type: "text" | "binary";
		content: string;
		diff?: string;
		encoding?: "base64";
		mimeType?: string;
	}>;

export const OpenCodeFileStatusListResponseSchema = Schema.Array(
	OpenCodeFileStatusEntrySchema,
) as unknown as Schema.Schema<
	Array<{
		path: string;
		added: number;
		removed: number;
		status: "added" | "deleted" | "modified";
	}>
>;

export const OpenCodeVcsResponseSchema = Schema.Struct({
	branch: Schema.optional(Schema.String),
	dirty: Schema.optional(Schema.Boolean),
}) as unknown as Schema.Schema<{ branch?: string; dirty?: boolean }>;

export const OpenCodePtyListResponseSchema = Schema.Array(
	OpenCodePtySchema,
) as unknown as Schema.Schema<
	Array<{
		id: string;
		title: string;
		command: string;
		args: string[];
		cwd: string;
		status: "running" | "exited";
		pid: number;
	}>
>;

const OpenCodeSkillSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
});
export const OpenCodeSkillListResponseSchema = Schema.Array(
	OpenCodeSkillSchema,
) as unknown as Schema.Schema<Array<{ name: string; description?: string }>>;

export const OpenCodePendingPermissionSchema = Schema.Struct({
	id: Schema.String,
	sessionID: Schema.String,
	permission: Schema.String,
	patterns: Schema.optional(Schema.Array(Schema.String)),
	metadata: Schema.optional(OpenCodeOpaquePropertiesSchema),
	always: Schema.optional(Schema.Array(Schema.String)),
}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema));

export type OpenCodePendingPermission = Schema.Schema.Type<
	typeof OpenCodePendingPermissionSchema
>;

export const OpenCodePendingPermissionListResponseSchema = Schema.Array(
	OpenCodePendingPermissionSchema,
) as unknown as Schema.Schema<unknown[]>;

export const OpenCodePendingQuestionSchema = Schema.Struct({
	id: Schema.String,
	sessionID: Schema.String,
	questions: Schema.Array(Schema.Unknown),
}).pipe(Schema.extend(OpenCodeOpaquePropertiesSchema));

export type OpenCodePendingQuestion = Schema.Schema.Type<
	typeof OpenCodePendingQuestionSchema
>;

export const OpenCodePendingQuestionListResponseSchema = Schema.Array(
	OpenCodePendingQuestionSchema,
) as unknown as Schema.Schema<unknown[]>;

export const decodeOpenCodeSessionDetailResponse = Schema.decodeUnknownSync(
	OpenCodeSessionDetailResponseSchema,
);
export const decodeOpenCodeSessionListResponse = Schema.decodeUnknownSync(
	OpenCodeSessionDetailListResponseSchema,
);
export const decodeOpenCodeSessionStatusMap = Schema.decodeUnknownSync(
	OpenCodeSessionStatusMapSchema,
);
export const decodeOpenCodeMessageWithPartsResponse = Schema.decodeUnknownSync(
	OpenCodeMessageWithPartsSchema,
);
export const decodeOpenCodeMessageListResponse = Schema.decodeUnknownSync(
	OpenCodeMessageListResponseSchema,
);
export const decodeOpenCodeSessionResponse = Schema.decodeUnknownSync(
	OpenCodeSessionSchema,
);
export const decodeOpenCodeBooleanResponse = Schema.decodeUnknownSync(
	OpenCodeBooleanResponseSchema,
);
export const decodeOpenCodeUndefinedResponse = Schema.decodeUnknownSync(
	OpenCodeUndefinedResponseSchema,
);
export const decodeOpenCodeShareResponse = Schema.decodeUnknownSync(
	OpenCodeShareResponseSchema,
);
export const decodeOpenCodeDiffResponse = Schema.decodeUnknownSync(
	OpenCodeDiffResponseSchema,
);
export const decodeOpenCodeConfigResponse = Schema.decodeUnknownSync(
	OpenCodeConfigResponseSchema,
);
export const decodeOpenCodeProviderListResponse = Schema.decodeUnknownSync(
	OpenCodeProviderListResponseSchema,
);
export const decodeOpenCodePtyResponse =
	Schema.decodeUnknownSync(OpenCodePtySchema);
export const decodeOpenCodePtyListResponse = Schema.decodeUnknownSync(
	OpenCodePtyListResponseSchema,
);
export const decodeOpenCodeFileEntryListResponse = Schema.decodeUnknownSync(
	OpenCodeFileEntryListResponseSchema,
);
export const decodeOpenCodeFileReadResponse = Schema.decodeUnknownSync(
	OpenCodeFileReadResponseSchema,
);
export const decodeOpenCodeFileStatusListResponse = Schema.decodeUnknownSync(
	OpenCodeFileStatusListResponseSchema,
);
export const decodeOpenCodeFindTextResponse = Schema.decodeUnknownSync(
	OpenCodeFindTextResponseSchema,
);
export const decodeOpenCodeFindFilesResponse = Schema.decodeUnknownSync(
	OpenCodeFindFilesArrayResponseSchema,
);
export const decodeOpenCodeFindSymbolsResponse = Schema.decodeUnknownSync(
	OpenCodeFindSymbolsResponseSchema,
);
export const decodeOpenCodeAgentListResponse = Schema.decodeUnknownSync(
	OpenCodeAgentListResponseSchema,
);
export const decodeOpenCodeCommandListResponse = Schema.decodeUnknownSync(
	OpenCodeCommandListResponseSchema,
);
export const decodeOpenCodePathResponse =
	Schema.decodeUnknownSync(OpenCodePathSchema);
export const decodeOpenCodeVcsResponse = Schema.decodeUnknownSync(
	OpenCodeVcsResponseSchema,
);
export const decodeOpenCodeProjectListResponse = Schema.decodeUnknownSync(
	OpenCodeProjectListResponseSchema,
);
export const decodeOpenCodeCurrentProjectResponse = Schema.decodeUnknownSync(
	OpenCodeCurrentProjectResponseSchema,
);
export const decodeOpenCodePendingPermissionListResponse =
	Schema.decodeUnknownSync(OpenCodePendingPermissionListResponseSchema);
export const decodeOpenCodePendingQuestionListResponse =
	Schema.decodeUnknownSync(OpenCodePendingQuestionListResponseSchema);
export const decodeOpenCodeSkillListResponse = Schema.decodeUnknownSync(
	OpenCodeSkillListResponseSchema,
);
export const decodeOpenCodePermissionReplyBody = Schema.decodeUnknownSync(
	OpenCodePermissionReplyRequestSchema,
);
export const encodeOpenCodePermissionReplyBody = Schema.encodeUnknownSync(
	OpenCodePermissionReplyRequestSchema,
);
export const decodeOpenCodeQuestionReplyBody = Schema.decodeUnknownSync(
	OpenCodeQuestionReplyRequestSchema,
);
export const encodeOpenCodeQuestionReplyBody = Schema.encodeUnknownSync(
	OpenCodeQuestionReplyRequestSchema,
);
export const decodeOpenCodeQuestionRejectBody = Schema.decodeUnknownSync(
	OpenCodeQuestionRejectRequestSchema,
);
export const encodeOpenCodeQuestionRejectBody = Schema.encodeUnknownSync(
	OpenCodeQuestionRejectRequestSchema,
);
