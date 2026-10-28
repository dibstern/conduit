import type {
	Agent as SdkAgent,
	Command as SdkCommand,
	Config as SdkConfig,
	Event as SdkEvent,
	FileContent as SdkFileContent,
	FileNode as SdkFileNode,
	FindFilesResponse as SdkFindFilesResponse,
	Message as SdkMessage,
	Part as SdkPart,
	Path as SdkPath,
	Project as SdkProject,
	Pty as SdkPty,
	Session as SdkSession,
	SessionMessageResponse as SdkSessionMessageResponse,
	SessionStatus as SdkSessionStatus,
} from "@opencode-ai/sdk/v2/types";
import { Effect, Schema } from "effect";

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
	file: Schema.optional(Schema.String),
	before: Schema.optional(Schema.String),
	after: Schema.optional(Schema.String),
	patch: Schema.optional(Schema.String),
	additions: Schema.Number,
	deletions: Schema.Number,
	status: Schema.optional(Schema.Literals(["added", "deleted", "modified"])),
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
	Omit<SdkSession, "slug">
>;

export const OpenCodeSessionDetailSchema = Schema.Struct({
	...OpenCodeSessionSchema.fields,
	modelID: Schema.optional(Schema.String),
	providerID: Schema.optional(Schema.String),
	agentID: Schema.optional(Schema.String),
	slug: Schema.optional(Schema.String),
	archived: Schema.optional(Schema.Boolean),
	permission: Schema.optional(
		Schema.Array(
			Schema.Struct({
				permission: Schema.String,
				pattern: Schema.String,
				action: Schema.Literals(["allow", "deny", "ask"]),
			}),
		),
	),
});

export type OpenCodeSessionDetail = Schema.Schema.Type<
	typeof OpenCodeSessionDetailSchema
>;
export type SessionDetail = OpenCodeSessionDetail;

export const OpenCodeSessionDetailResponseSchema = OpenCodeSessionDetailSchema;
export const OpenCodeSessionDetailListResponseSchema = Schema.Array(
	OpenCodeSessionDetailSchema,
);

export const OpenCodeSessionStatusSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("idle") }),
	Schema.Struct({ type: Schema.Literal("busy") }),
	Schema.Struct({
		type: Schema.Literal("retry"),
		attempt: Schema.Number,
		message: Schema.String,
		next: Schema.Number,
	}),
]);

export type OpenCodeSessionStatus = Schema.Schema.Type<
	typeof OpenCodeSessionStatusSchema
>;
export type SessionStatus = OpenCodeSessionStatus;

export const OpenCodeSessionStatusMapSchema = Schema.Record(
	Schema.String,
	OpenCodeSessionStatusSchema,
);

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
	Pick<SdkPath, keyof OpenCodePath>
>;

export const OpenCodePtySchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	args: Schema.Array(Schema.String),
	cwd: Schema.String,
	status: Schema.Literals(["running", "exited"]),
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
	type: Schema.Literals(["file", "directory"]),
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
	type: Schema.Literals(["text", "binary"]),
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

export const OpenCodeFindFilesArrayResponseSchema =
	OpenCodeFindFilesResponseSchema;

export const OpenCodeConfigResponseSchema = Schema.Record(
	Schema.String,
	Schema.Unknown,
);

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
	mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
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
	tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
	options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
	source: Schema.optional(Schema.Literals(["command", "mcp", "skill"])),
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
	Pick<SdkCommand, keyof OpenCodeCommand>
>;

export const OpenCodeAgentListResponseSchema =
	Schema.Array(OpenCodeAgentSchema);
export const OpenCodeCommandListResponseSchema = Schema.Array(
	OpenCodeCommandSchema,
);

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
	Pick<SdkProject, "id" | "worktree" | "vcs"> & {
		time: Pick<SdkProject["time"], "created" | "initialized">;
	}
>;

export const OpenCodeProjectListResponseSchema = Schema.Array(
	OpenCodeProjectSchema,
);
export const OpenCodeCurrentProjectResponseSchema = OpenCodeProjectSchema;

const OpenCodeOpaquePropertiesSchema = Schema.Record(
	Schema.String,
	Schema.Unknown,
);

const OpenCodeProviderModelSchema = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		name: Schema.String,
		limit: Schema.Struct({
			context: Schema.Number,
			output: Schema.Number,
		}),
		variants: Schema.optional(
			Schema.Record(
				Schema.String,
				Schema.Record(Schema.String, Schema.Unknown),
			),
		),
	}),
	[OpenCodeOpaquePropertiesSchema],
);

const OpenCodeProviderListEntrySchema = Schema.StructWithRest(
	Schema.Struct({
		name: Schema.String,
		id: Schema.String,
		models: Schema.Record(Schema.String, OpenCodeProviderModelSchema),
	}),
	[OpenCodeOpaquePropertiesSchema],
);

export const OpenCodeProviderListResponseSchema = Schema.Struct({
	all: Schema.Array(OpenCodeProviderListEntrySchema),
	default: Schema.Record(Schema.String, Schema.String),
	connected: Schema.Array(Schema.String),
});
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
	data: Schema.Record(Schema.String, Schema.Unknown),
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
			Schema.Record(Schema.String, Schema.String),
		),
		responseBody: Schema.optional(Schema.String),
	}),
});

const OpenCodeMessageErrorSchema = Schema.Union([
	OpenCodeProviderAuthErrorSchema,
	OpenCodeUnknownErrorSchema,
	OpenCodeMessageOutputLengthErrorSchema,
	OpenCodeMessageAbortedErrorSchema,
	OpenCodeApiErrorSchema,
	Schema.Struct({
		name: Schema.Literal("StructuredOutputError"),
		data: Schema.Struct({ message: Schema.String, retries: Schema.Number }),
	}),
	Schema.Struct({
		name: Schema.Literal("ContextOverflowError"),
		data: Schema.Struct({
			message: Schema.String,
			responseBody: Schema.optional(Schema.String),
		}),
	}),
	Schema.Struct({
		name: Schema.Literal("ContentFilterError"),
		data: Schema.Struct({ message: Schema.String }),
	}),
]);

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
	tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
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

export const OpenCodeMessageSchema = Schema.Union([
	OpenCodeUserMessageSchema,
	OpenCodeAssistantMessageSchema,
]);

export type OpenCodeMessage = Schema.Schema.Type<typeof OpenCodeMessageSchema>;

type _OpenCodeSdkMessageCoversSchema = AssertExtends<
	SdkMessage,
	OpenCodeMessage
>;
type _OpenCodeMessageCoversSdkMessage = AssertExtends<
	NormalizeSchemaType<OpenCodeMessage>,
	| Extract<SdkMessage, { role: "user" }>
	| Omit<Extract<SdkMessage, { role: "assistant" }>, "agent">
>;

export const OpenCodePartSchema = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		type: Schema.String,
	}),
	[Schema.Record(Schema.String, Schema.Unknown)],
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
);

type OpenCodeSdkEventType = SdkEvent["type"];
// v2 includes the consumed permission/question/delta event shapes. The legacy
// message.created event remains a wire-compatible extension of the SDK union.
type OpenCodeGapEventType = "message.created";

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
	"pty.updated",
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

const OpenCodeEventBasePropertiesSchema = Schema.StructWithRest(
	Schema.Struct({}),
	[OpenCodeOpaquePropertiesSchema],
);

const OpenCodeMessageCreatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.created"),
	properties: OpenCodeEventBasePropertiesSchema,
});

const OpenCodePartDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.delta"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.optional(Schema.String),
			messageID: Schema.optional(Schema.String),
			partID: Schema.String,
			field: Schema.String,
			delta: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePartUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			partID: Schema.optional(Schema.String),
			messageID: Schema.optional(Schema.String),
			part: OpenCodePartSchema,
			delta: Schema.optional(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePartRemovedEventSchema = Schema.Struct({
	type: Schema.Literal("message.part.removed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			partID: Schema.String,
			messageID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeMessageUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("message.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({ info: OpenCodeMessageSchema }),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeMessageRemovedEventSchema = Schema.Struct({
	type: Schema.Literal("message.removed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			messageID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionStatusEventSchema = Schema.Struct({
	type: Schema.Literal("session.status"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			status: OpenCodeSessionStatusSchema,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeEventErrorSchema = Schema.StructWithRest(
	Schema.Struct({
		name: Schema.String,
		data: Schema.StructWithRest(
			Schema.Struct({
				message: Schema.optional(Schema.String),
			}),
			[OpenCodeOpaquePropertiesSchema],
		),
	}),
	[OpenCodeOpaquePropertiesSchema],
);

const OpenCodeSessionErrorEventSchema = Schema.Struct({
	type: Schema.Literal("session.error"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.optional(Schema.String),
			error: Schema.optional(OpenCodeEventErrorSchema),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePermissionAskedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.asked"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			permission: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePermissionRepliedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.replied"),
	// The v2 event matches the wire: { sessionID, requestID, reply }.
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
			reply: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionAskedEventSchema = Schema.Struct({
	type: Schema.Literal("question.asked"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			questions: Schema.Array(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("session.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({ info: OpenCodeSessionSchema }),
		[OpenCodeOpaquePropertiesSchema],
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
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			todos: Schema.Array(OpenCodeTodoSchema),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePtyCreatedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.created"),
	properties: Schema.StructWithRest(
		Schema.Struct({ info: OpenCodePtySchema }),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePtyExitedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.exited"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			exitCode: Schema.Number,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePtyDeletedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.deleted"),
	properties: Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeFileEditedEventSchema = Schema.Struct({
	type: Schema.Literal("file.edited"),
	properties: Schema.StructWithRest(Schema.Struct({ file: Schema.String }), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeFileWatcherUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("file.watcher.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			// Conduit reads only `file`; `event` is provider-owned and unread, kept
			// optional so a new watcher event kind cannot fail-close (grill #10).
			file: Schema.String,
			event: Schema.optional(Schema.Literals(["add", "change", "unlink"])),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeInstallationUpdateAvailableEventSchema = Schema.Struct({
	type: Schema.Literal("installation.update-available"),
	properties: Schema.StructWithRest(Schema.Struct({ version: Schema.String }), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

// Documentation-modeled from the live server /doc. Most of these events are
// not consumed by conduit today; they are modeled so the available event
// data surface is explicit and discoverable.
const OpenCodeCatalogUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("catalog.updated"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeCommandExecutedEventSchema = Schema.Struct({
	type: Schema.Literal("command.executed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			name: Schema.String,
			sessionID: Schema.String,
			arguments: Schema.String,
			messageID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeGlobalDisposedEventSchema = Schema.Struct({
	type: Schema.Literal("global.disposed"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeInstallationUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("installation.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			version: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeIntegrationConnectionUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("integration.connection.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			integrationID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeIntegrationUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("integration.updated"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeLspUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("lsp.updated"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeMcpBrowserOpenFailedEventSchema = Schema.Struct({
	type: Schema.Literal("mcp.browser.open.failed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			mcpName: Schema.String,
			url: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeMcpToolsChangedEventSchema = Schema.Struct({
	type: Schema.Literal("mcp.tools.changed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			server: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeModelsDevRefreshedEventSchema = Schema.Struct({
	type: Schema.Literal("models-dev.refreshed"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodePermissionV2AskedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.v2.asked"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			sessionID: Schema.String,
			action: Schema.String,
			resources: Schema.Array(Schema.String),
			save: Schema.optional(Schema.Array(Schema.String)),
			metadata: Schema.optional(Schema.Unknown),
			source: Schema.optional(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePermissionV2RepliedEventSchema = Schema.Struct({
	type: Schema.Literal("permission.v2.replied"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
			reply: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePluginAddedEventSchema = Schema.Struct({
	type: Schema.Literal("plugin.added"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeProjectDirectoriesUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("project.directories.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			projectID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeProjectUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("project.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			worktree: Schema.String,
			vcs: Schema.optional(Schema.Unknown),
			name: Schema.optional(Schema.String),
			icon: Schema.optional(Schema.Unknown),
			commands: Schema.optional(Schema.Unknown),
			time: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			sandboxes: Schema.Array(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodePtyUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("pty.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			info: OpenCodePtySchema,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionRejectedEventSchema = Schema.Struct({
	type: Schema.Literal("question.rejected"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionRepliedEventSchema = Schema.Struct({
	type: Schema.Literal("question.replied"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
			answers: Schema.Array(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionV2AskedEventSchema = Schema.Struct({
	type: Schema.Literal("question.v2.asked"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			id: Schema.String,
			sessionID: Schema.String,
			questions: Schema.Array(Schema.Unknown),
			tool: Schema.optional(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionV2RejectedEventSchema = Schema.Struct({
	type: Schema.Literal("question.v2.rejected"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeQuestionV2RepliedEventSchema = Schema.Struct({
	type: Schema.Literal("question.v2.replied"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			requestID: Schema.String,
			answers: Schema.Array(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeReferenceUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("reference.updated"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeServerConnectedEventSchema = Schema.Struct({
	type: Schema.Literal("server.connected"),
	properties: Schema.StructWithRest(Schema.Struct({}), [
		OpenCodeOpaquePropertiesSchema,
	]),
});

const OpenCodeServerInstanceDisposedEventSchema = Schema.Struct({
	type: Schema.Literal("server.instance.disposed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			directory: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionCompactedEventSchema = Schema.Struct({
	type: Schema.Literal("session.compacted"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionCreatedEventSchema = Schema.Struct({
	type: Schema.Literal("session.created"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			info: OpenCodeSessionSchema,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionDeletedEventSchema = Schema.Struct({
	type: Schema.Literal("session.deleted"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			info: OpenCodeSessionSchema,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionDiffEventSchema = Schema.Struct({
	type: Schema.Literal("session.diff"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
			diff: Schema.Array(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionIdleEventSchema = Schema.Struct({
	type: Schema.Literal("session.idle"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextAgentSwitchedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.agent.switched"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			agent: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextCompactionDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.compaction.delta"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextCompactionEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.compaction.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			reason: Schema.Literals(["auto", "manual"]),
			text: Schema.String,
			recent: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextCompactionStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.compaction.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			reason: Schema.Literals(["auto", "manual"]),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextContextUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.context.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextModelSwitchedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.model.switched"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			model: OpenCodeModelRefSchema,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextMovedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.moved"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			location: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			subdirectory: Schema.optional(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextPromptAdmittedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.prompt.admitted"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			prompt: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			delivery: Schema.Literals(["steer", "queue"]),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextPromptedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.prompted"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			prompt: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			delivery: Schema.Literals(["steer", "queue"]),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextReasoningDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.reasoning.delta"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			reasoningID: Schema.String,
			delta: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextReasoningEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.reasoning.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			reasoningID: Schema.String,
			text: Schema.String,
			providerMetadata: Schema.optional(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextReasoningStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.reasoning.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			reasoningID: Schema.String,
			providerMetadata: Schema.optional(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextRetriedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.retried"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			attempt: Schema.Number,
			error: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextRevertClearedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.revert.cleared"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextRevertCommittedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.revert.committed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextRevertStagedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.revert.staged"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			revert: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextShellEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.shell.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			callID: Schema.String,
			output: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextShellStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.shell.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			callID: Schema.String,
			command: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextStepEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.step.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			finish: Schema.String,
			cost: Schema.Number,
			tokens: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			snapshot: Schema.optional(Schema.String),
			files: Schema.optional(Schema.Array(Schema.String)),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextStepFailedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.step.failed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			error: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextStepStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.step.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			agent: Schema.String,
			model: OpenCodeModelRefSchema,
			snapshot: Schema.optional(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextSyntheticEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.synthetic"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			messageID: Schema.String,
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextTextDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.text.delta"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			textID: Schema.String,
			delta: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextTextEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.text.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			textID: Schema.String,
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextTextStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.text.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			textID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolCalledEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.called"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			tool: Schema.String,
			input: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			provider: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolFailedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.failed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			error: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			result: Schema.optional(Schema.Unknown),
			provider: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolInputDeltaEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.input.delta"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			delta: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolInputEndedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.input.ended"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolInputStartedEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.input.started"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			name: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolProgressEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.progress"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			structured: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			content: Schema.Array(Schema.Unknown),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeSessionNextToolSuccessEventSchema = Schema.Struct({
	type: Schema.Literal("session.next.tool.success"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			timestamp: Schema.Number,
			sessionID: Schema.String,
			assistantMessageID: Schema.String,
			callID: Schema.String,
			structured: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
			content: Schema.Array(Schema.Unknown),
			outputPaths: Schema.optional(Schema.Array(Schema.String)),
			result: Schema.optional(Schema.Unknown),
			provider: Schema.Unknown.pipe(
				Schema.withDecodingDefaultTypeKey(Effect.succeed(undefined)),
			),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeTuiCommandExecuteEventSchema = Schema.Struct({
	type: Schema.Literal("tui.command.execute"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			command: Schema.Union([
				Schema.Literals([
					"session.list",
					"session.new",
					"session.share",
					"session.interrupt",
					"session.compact",
					"session.page.up",
					"session.page.down",
					"session.line.up",
					"session.line.down",
					"session.half.page.up",
					"session.half.page.down",
					"session.first",
					"session.last",
					"prompt.clear",
					"prompt.submit",
					"agent.cycle",
				]),
				Schema.String,
			]),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeTuiPromptAppendEventSchema = Schema.Struct({
	type: Schema.Literal("tui.prompt.append"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			text: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeTuiSessionSelectEventSchema = Schema.Struct({
	type: Schema.Literal("tui.session.select"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			sessionID: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeTuiToastShowEventSchema = Schema.Struct({
	type: Schema.Literal("tui.toast.show"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			title: Schema.optional(Schema.String),
			message: Schema.String,
			variant: Schema.Literals(["info", "success", "warning", "error"]),
			duration: Schema.optional(Schema.Number),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeVcsBranchUpdatedEventSchema = Schema.Struct({
	type: Schema.Literal("vcs.branch.updated"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			branch: Schema.optional(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeWorkspaceFailedEventSchema = Schema.Struct({
	type: Schema.Literal("workspace.failed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			message: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeWorkspaceReadyEventSchema = Schema.Struct({
	type: Schema.Literal("workspace.ready"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			name: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeWorkspaceStatusEventSchema = Schema.Struct({
	type: Schema.Literal("workspace.status"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			workspaceID: Schema.String,
			status: Schema.Literals([
				"connected",
				"connecting",
				"disconnected",
				"error",
			]),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeWorktreeFailedEventSchema = Schema.Struct({
	type: Schema.Literal("worktree.failed"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			message: Schema.String,
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

const OpenCodeWorktreeReadyEventSchema = Schema.Struct({
	type: Schema.Literal("worktree.ready"),
	properties: Schema.StructWithRest(
		Schema.Struct({
			name: Schema.String,
			branch: Schema.optional(Schema.String),
		}),
		[OpenCodeOpaquePropertiesSchema],
	),
});

export const OpenCodeEventSchema = Schema.Union([
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
	OpenCodeCatalogUpdatedEventSchema,
	OpenCodeCommandExecutedEventSchema,
	OpenCodeGlobalDisposedEventSchema,
	OpenCodeInstallationUpdatedEventSchema,
	OpenCodeIntegrationConnectionUpdatedEventSchema,
	OpenCodeIntegrationUpdatedEventSchema,
	OpenCodeLspUpdatedEventSchema,
	OpenCodeMcpBrowserOpenFailedEventSchema,
	OpenCodeMcpToolsChangedEventSchema,
	OpenCodeModelsDevRefreshedEventSchema,
	OpenCodePermissionV2AskedEventSchema,
	OpenCodePermissionV2RepliedEventSchema,
	OpenCodePluginAddedEventSchema,
	OpenCodeProjectDirectoriesUpdatedEventSchema,
	OpenCodeProjectUpdatedEventSchema,
	OpenCodePtyUpdatedEventSchema,
	OpenCodeQuestionRejectedEventSchema,
	OpenCodeQuestionRepliedEventSchema,
	OpenCodeQuestionV2AskedEventSchema,
	OpenCodeQuestionV2RejectedEventSchema,
	OpenCodeQuestionV2RepliedEventSchema,
	OpenCodeReferenceUpdatedEventSchema,
	OpenCodeServerConnectedEventSchema,
	OpenCodeServerInstanceDisposedEventSchema,
	OpenCodeSessionCompactedEventSchema,
	OpenCodeSessionCreatedEventSchema,
	OpenCodeSessionDeletedEventSchema,
	OpenCodeSessionDiffEventSchema,
	OpenCodeSessionIdleEventSchema,
	OpenCodeSessionNextAgentSwitchedEventSchema,
	OpenCodeSessionNextCompactionDeltaEventSchema,
	OpenCodeSessionNextCompactionEndedEventSchema,
	OpenCodeSessionNextCompactionStartedEventSchema,
	OpenCodeSessionNextContextUpdatedEventSchema,
	OpenCodeSessionNextModelSwitchedEventSchema,
	OpenCodeSessionNextMovedEventSchema,
	OpenCodeSessionNextPromptAdmittedEventSchema,
	OpenCodeSessionNextPromptedEventSchema,
	OpenCodeSessionNextReasoningDeltaEventSchema,
	OpenCodeSessionNextReasoningEndedEventSchema,
	OpenCodeSessionNextReasoningStartedEventSchema,
	OpenCodeSessionNextRetriedEventSchema,
	OpenCodeSessionNextRevertClearedEventSchema,
	OpenCodeSessionNextRevertCommittedEventSchema,
	OpenCodeSessionNextRevertStagedEventSchema,
	OpenCodeSessionNextShellEndedEventSchema,
	OpenCodeSessionNextShellStartedEventSchema,
	OpenCodeSessionNextStepEndedEventSchema,
	OpenCodeSessionNextStepFailedEventSchema,
	OpenCodeSessionNextStepStartedEventSchema,
	OpenCodeSessionNextSyntheticEventSchema,
	OpenCodeSessionNextTextDeltaEventSchema,
	OpenCodeSessionNextTextEndedEventSchema,
	OpenCodeSessionNextTextStartedEventSchema,
	OpenCodeSessionNextToolCalledEventSchema,
	OpenCodeSessionNextToolFailedEventSchema,
	OpenCodeSessionNextToolInputDeltaEventSchema,
	OpenCodeSessionNextToolInputEndedEventSchema,
	OpenCodeSessionNextToolInputStartedEventSchema,
	OpenCodeSessionNextToolProgressEventSchema,
	OpenCodeSessionNextToolSuccessEventSchema,
	OpenCodeTuiCommandExecuteEventSchema,
	OpenCodeTuiPromptAppendEventSchema,
	OpenCodeTuiSessionSelectEventSchema,
	OpenCodeTuiToastShowEventSchema,
	OpenCodeVcsBranchUpdatedEventSchema,
	OpenCodeWorkspaceFailedEventSchema,
	OpenCodeWorkspaceReadyEventSchema,
	OpenCodeWorkspaceStatusEventSchema,
	OpenCodeWorktreeFailedEventSchema,
	OpenCodeWorktreeReadyEventSchema,
]);

export type OpenCodeEvent = Schema.Schema.Type<typeof OpenCodeEventSchema>;

type _OpenCodeSdkConsumedEventsCoverSchemaEnvelopes = AssertExtends<
	Extract<SdkEvent, { type: OpenCodeSdkConsumedEventType }>,
	OpenCodeEvent
>;

export const OpenCodeQuestionReplyRequestSchema = Schema.Struct({
	answers: Schema.Array(Schema.Array(Schema.String)),
});

export const OpenCodeBooleanResponseSchema = Schema.Boolean;
const OpenCodeEmptyObjectResponseSchema = Schema.Struct({}).pipe(
	Schema.check(
		Schema.makeFilter((value) =>
			Object.keys(value).length === 0
				? undefined
				: "expected empty object for void OpenCode response",
		),
	),
);

export const OpenCodeUndefinedResponseSchema = Schema.Union([
	Schema.Undefined,
	OpenCodeEmptyObjectResponseSchema,
]);

// v2 documents boolean replies; older servers also return void envelopes.
export const decodeOpenCodeQuestionActionResponse = Schema.decodeUnknownSync(
	Schema.Union([Schema.Boolean, OpenCodeUndefinedResponseSchema]),
);

export const OpenCodeFileEntryListResponseSchema = Schema.Array(
	OpenCodeFileNodeSchema,
);

export const OpenCodeFileReadResponseSchema = OpenCodeFileContentSchema;

export const OpenCodeVcsResponseSchema = Schema.Struct({
	branch: Schema.optional(Schema.String),
	dirty: Schema.optional(Schema.Boolean),
});

export const OpenCodePtyListResponseSchema = Schema.Array(OpenCodePtySchema);

const OpenCodeSkillSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
	location: Schema.optional(Schema.String),
});
export const OpenCodeSkillListResponseSchema =
	Schema.Array(OpenCodeSkillSchema);

export const OpenCodePendingPermissionSchema = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		sessionID: Schema.String,
		permission: Schema.String,
		patterns: Schema.optional(Schema.Array(Schema.String)),
		metadata: Schema.optional(OpenCodeOpaquePropertiesSchema),
		always: Schema.optional(Schema.Array(Schema.String)),
	}),
	[OpenCodeOpaquePropertiesSchema],
);

export type OpenCodePendingPermission = Schema.Schema.Type<
	typeof OpenCodePendingPermissionSchema
>;

export const OpenCodePendingPermissionListResponseSchema = Schema.Array(
	OpenCodePendingPermissionSchema,
);

export const OpenCodePendingQuestionSchema = Schema.StructWithRest(
	Schema.Struct({
		id: Schema.String,
		sessionID: Schema.String,
		questions: Schema.Array(Schema.Unknown),
	}),
	[OpenCodeOpaquePropertiesSchema],
);

export const OpenCodePendingQuestionListResponseSchema = Schema.Array(
	OpenCodePendingQuestionSchema,
);

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
export const decodeOpenCodeFindFilesResponse = Schema.decodeUnknownSync(
	OpenCodeFindFilesArrayResponseSchema,
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
export const decodeOpenCodeQuestionReplyBody = Schema.decodeUnknownSync(
	OpenCodeQuestionReplyRequestSchema,
);
