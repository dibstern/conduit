import { Effect, Record, Schema, SchemaGetter, SchemaIssue } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { accountRefFromSelection } from "../account-directory.js";
import type { FolderIssue } from "../project-folders.js";
import {
	ApprovalSchema,
	RepositoryIdentitySchema,
	SessionGitSchema,
	type SessionInfo,
	SessionInfoSchema,
	SessionPermissionModeSchema,
	SessionStatusSchema,
} from "../shared-types.js";
import { AccountChangeRejected } from "./account.js";
import { AccountColorSlotSchema } from "./account-color.js";
import {
	CategorySetContentsSchema,
	CategorySetRejected,
	CategorySetSchema,
	SurfacingFeedbackEntrySchema,
	SurfacingMarkSchema,
} from "./category-set.js";
import {
	CategoryTuningHunkSchema,
	CategoryTuningProposalSchema,
	CategoryTuningScoreSchema,
} from "./category-tuning.js";
import { AvatarChoiceSchema, AvatarSchema } from "./user-avatar.js";
import {
	ProjectWorktreeCleanupSchema,
	WorktreeBranchRenameError,
	WorktreeCleanupReportSchema,
	WorktreeCleanupSchema,
	WorktreeCreationError,
	WorktreeRecoveryError,
} from "./worktree.js";

// The single session type (ni8.5 T-1) is declared once, in shared-types, and
// re-exported here so contract consumers never reach past the contract module.
export { SessionInfoSchema, SessionStatusSchema };
export type { SessionInfo };
export { type GoalStuck, GoalStuckSchema } from "../shared-types.js";

import { AccountRefSchema } from "./account.js";
import { AskExplanationSchema } from "./ask-explanation.js";
import {
	ClaudeSettingsOverridesSchema,
	ClaudeSettingsResolveError,
	ClaudeSettingsTrustBoundaryError,
	ResolvedClaudeSettingsSchema,
} from "./claude-settings.js";
import {
	AccountUnroutable,
	ContinuationErrorSchema,
	HandoffSummarySchema,
	UsageLimitsSettingSchema,
	UsageReadingSchema,
} from "./limit-recovery.js";
import {
	MessageSurfacingPatchSchema,
	MessageSurfacingStatusSchema,
} from "./message-surfacing.js";
import {
	DefaultSessionModeSchema,
	type SessionMode,
	SessionModeSchema,
} from "./project-file.js";
import {
	AccountIdSchema,
	BrowserDriverTraitsSchema,
	KnownProviderDriverKindSchema,
	PROVIDER_DRIVERS,
	ProviderDriverKindSchema,
	ProviderSessionCapabilitiesSchema,
} from "./provider-instance.js";
import {
	SessionWorktreeInspectionSchema,
	WorkspaceMoveError,
	WorktreeInfoSchema,
} from "./session-workspace.js";
import {
	INPUT_DELIVERIES,
	InputRequestSchema,
	STEER_BLOCKERS,
	TextSurfacedPayloadSchema,
} from "./stored-event.js";
import { TerminalKeysSetting } from "./terminal-keys.js";
import {
	TitleGenerationSelectionSchema,
	TitleGenerationStateSchema,
} from "./title-generation.js";
import { ToolCallId, ToolDetail, ToolInput, ToolText } from "./tool-wire.js";
import {
	RecapScopeSchema,
	RecapSnapshotSchema,
	TurnRecapSchema,
} from "./turn-recap.js";

const NonEmptyString = Schema.NonEmptyString;

/**
 * What a resuming client's changes were applied on top of: its last snapshot's
 * version and, for a paged source, that page's cursor (conduit-test-y7eo.9).
 */
export const ResumeBase = Schema.Struct({
	sequence: Schema.Number,
	cursor: Schema.optional(NonEmptyString),
});
export type ResumeBase = typeof ResumeBase.Type;

/**
 * Where a saved snapshot can resume from, named by its store and subscription scope
 * sent it (conduit-test-y7eo.14). Opaque to the browser, which only keeps it
 * and hands it back; it is not tamper-proof. The server validates it, refusing
 * one from another store or scope with a fresh snapshot, and the resume
 * checksum backs whatever it accepts.
 */
export const ResumePoint = NonEmptyString.pipe(Schema.brand("ResumePoint"));
export type ResumePoint = typeof ResumePoint.Type;

/**
 * A subscription's base set after a catch-up, as {@link digestRows} of the ids
 * and versions it holds, and how many rows that is. Only the server
 * subscription helper makes one; a client checks it against its own digest of
 * what it applied.
 */
export const ResumeChecksum = Schema.Struct({
	hash: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	rows: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
}).pipe(Schema.brand("ResumeChecksum"));
export type ResumeChecksum = typeof ResumeChecksum.Type;

/**
 * The digest both ends compute over `[id, version]` rows: a sum of 32-bit
 * FNV-1a hashes, so row order does not matter. A row that has not moved since
 * the base counts at the base's version, which is all a snapshot tells the
 * client.
 */
export const digestRows = (
	rows: Iterable<readonly [id: string, version: number]>,
	base: number,
): { readonly hash: number; readonly rows: number } => {
	let hash = 0;
	let count = 0;
	for (const [id, version] of rows) {
		const key = `${id}\u0000${Math.max(version, base)}`;
		let row = 0x811c9dc5;
		for (let index = 0; index < key.length; index++)
			row = Math.imul(row ^ key.charCodeAt(index), 0x01000193);
		hash = (hash + (row >>> 0)) >>> 0;
		count += 1;
	}
	return { hash, rows: count };
};

export const EnvelopeSchema = <A, I = A, RD = never, RE = RD>(
	itemSchema: Schema.Codec<A, I, RD, RE>,
) =>
	Schema.Union([
		Schema.Struct({
			_tag: Schema.Literal("snapshot"),
			rows: Schema.Array(itemSchema),
			sequence: Schema.Number,
			hasMore: Schema.optional(Schema.Boolean),
			cursor: Schema.optional(NonEmptyString),
			/** The opaque store and scope identity this snapshot resumes from. */
			resumePoint: Schema.optional(ResumePoint),
		}),
		Schema.Struct({
			_tag: Schema.Literal("synchronized"),
			/** After a catch-up against the client's `resumeBase`. */
			checksum: Schema.optional(ResumeChecksum),
		}),
		Schema.Struct({
			_tag: Schema.Literal("upsert"),
			item: itemSchema,
			sequence: Schema.Number,
		}),
		Schema.Struct({
			_tag: Schema.Literal("remove"),
			id: Schema.String,
			sequence: Schema.Number,
			/** The item itself is gone, not only out of this collection. */
			deleted: Schema.optional(Schema.Boolean),
		}),
	]);

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
	parameters: Schema.optional(
		Schema.Struct({
			rows: Schema.Array(
				Schema.Struct({
					id: Schema.String,
					label: Schema.String,
					values: Schema.Array(
						Schema.Struct({ value: Schema.String, label: Schema.String }),
					),
				}),
			),
			combinations: Schema.Array(
				Schema.Struct({
					variant: Schema.String,
					values: Schema.Record(Schema.String, Schema.String),
					isDefault: Schema.optional(Schema.Boolean),
				}),
			),
		}),
	),
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
	Schema.check(
		Schema.makeFilter(
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
				message:
					"drifted requires expectedModel, and drifted=true requires actualModel to differ from expectedModel",
			},
		),
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
	addedAt: Schema.optional(Schema.Number),
	folders: Schema.NonEmptyArray(Schema.String),
	setupScript: Schema.optional(Schema.String),
	sessionMode: Schema.optional(SessionModeSchema),
	/** Keyed by Project Folder path; non-git folders have no entry. */
	repositoryIdentities: Schema.optional(
		Schema.Record(Schema.String, RepositoryIdentitySchema),
	),
	missing: Schema.optional(Schema.Boolean),
	unavailableReason: Schema.optional(Schema.String),
	git: Schema.optional(SessionGitSchema),
	clientCount: Schema.optional(Schema.Number),
});

export const InstanceStatusSchema = Schema.Literals([
	"starting",
	"healthy",
	"unhealthy",
	"stopped",
]);

export const OpenCodeInstanceSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	colorSlot: Schema.optional(AccountColorSlotSchema),
	port: Schema.Number,
	managed: Schema.Boolean,
	driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
	isDefault: Schema.optional(Schema.Boolean),
	usageEligible: Schema.optional(Schema.Boolean),
	cursorUsageSource: Schema.optional(
		Schema.Literals(["token", "keychain", "can_enable", "unsupported"]),
	),
	available: Schema.optional(Schema.Boolean),
	unavailableReason: Schema.optional(Schema.String),
	unavailableCode: Schema.optional(
		Schema.Literals(["auth_required", "codex_version_unsupported"]),
	),
	capabilities: Schema.optional(
		Schema.suspend(() => ProviderSessionCapabilitiesSchema),
	),
	configDir: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	status: InstanceStatusSchema,
	pid: Schema.optional(Schema.Number),
	env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
	needsRestart: Schema.optional(Schema.Boolean),
	exitCode: Schema.optional(Schema.Number),
	lastHealthCheck: Schema.optional(Schema.Number),
	restartCount: Schema.Number,
	createdAt: Schema.Number,
});

export const FileEntrySchema = Schema.Struct({
	name: Schema.String,
	type: Schema.Literals(["file", "directory"]),
	size: Schema.optional(Schema.Number),
});

export const TodoItemSchema = Schema.Struct({
	id: Schema.String,
	subject: Schema.String,
	description: Schema.optional(Schema.String),
	status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]),
});

export const PtyInfoSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	command: Schema.String,
	cwd: Schema.String,
	status: Schema.Literals(["running", "exited"]),
	pid: Schema.Number,
});

export const HistoryMessagePartSchema = Schema.Struct({
	id: Schema.String,
	type: Schema.String,
	surfacingMark: Schema.optional(Schema.NullOr(SurfacingMarkSchema)),
	surfacingRead: Schema.optionalKey(Schema.Boolean),
	surfacingOrdinal: Schema.optionalKey(
		TextSurfacedPayloadSchema.fields.ordinal,
	),
	surfacingProbabilities: Schema.optionalKey(
		TextSurfacedPayloadSchema.fields.probabilities,
	),
	surfacingSetVersion: Schema.optionalKey(
		TextSurfacedPayloadSchema.fields.categorySetVersion,
	),
	surfacingModel: Schema.optionalKey(TextSurfacedPayloadSchema.fields.model),
	text: Schema.optional(Schema.String),
	renderedHtml: Schema.optional(Schema.String),
	state: Schema.optional(
		Schema.StructWithRest(
			Schema.Struct({
				input: Schema.optionalKey(ToolInput),
				output: Schema.optionalKey(ToolText),
			}),
			[Schema.Record(Schema.String, Schema.Unknown)],
		),
	),
	callID: Schema.optional(Schema.String),
	tool: Schema.optional(Schema.String),
	time: Schema.optional(Schema.Unknown),
}).pipe((schema) =>
	Schema.StructWithRest(schema, [Schema.Record(Schema.String, Schema.Unknown)]),
);

export const HistoryMessageSchema = Schema.Struct({
	id: Schema.String,
	turnId: Schema.optionalKey(Schema.String),
	role: Schema.Literals(["user", "assistant"]),
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
	turnCost: Schema.optionalKey(Schema.Number),
	contextTokens: Schema.optionalKey(Schema.Number),
	tokens: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
}).pipe((schema) =>
	Schema.StructWithRest(schema, [Schema.Record(Schema.String, Schema.Unknown)]),
);

/**
 * A transcript row: a message, or one of its parts. Each moves on its own, so
 * a live update carries only what changed.
 * - `message`: a message without `parts` or `text`; its parts are rows of
 *   their own, and a message row leaves the parts already held in place.
 * - `part`: one part of the message `messageId`, placed among that message's
 *   parts by `sortOrder`.
 */
export const SessionDetailItemSchema = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("message"),
		message: HistoryMessageSchema,
	}),
	Schema.Struct({
		_tag: Schema.Literal("part"),
		messageId: Schema.String,
		sortOrder: Schema.Int,
		part: HistoryMessagePartSchema,
	}),
	Schema.Struct({
		_tag: Schema.Literal("rewind"),
		messageId: Schema.NullOr(Schema.String),
	}),
	Schema.Struct({
		_tag: Schema.Literal("pendingInput"),
		input: Schema.Struct({
			inputId: Schema.String,
			state: Schema.Literals(["queued", "steering"]),
			request: InputRequestSchema,
			admittedAt: Schema.Number,
		}),
	}),
	Schema.Struct({
		_tag: Schema.Literal("inbox"),
		inbox: Schema.Struct({
			paused: Schema.Boolean,
			steer: Schema.NullOr(Schema.Literals(["no_steering", "prompt_open"])),
		}),
	}),
]);

/**
 * A detail `remove` names a message by its id, and a part by this JSON pair of
 * its message's id and its own: a part may share its message's id.
 */
export const PartRemovalId = Schema.fromJsonString(
	Schema.Tuple([Schema.String, Schema.String]),
);

/**
 * How many parts' last text each end of a detail subscription keeps, least
 * recently written first out. Both ends see the same part writes in the same
 * order, so the decoder still holds every part the encoder sends a suffix of.
 * Usually only the streaming part grows; eight slots keep it plus seven nearby
 * interleaved parts warm. An evicted part goes whole, so eviction only costs
 * compression.
 */
export const SENT_PART_LIMIT = 8;

// Lengths are JavaScript string lengths (UTF-16 code units), not wire bytes.
const TextSuffixSchema = Schema.Struct({
	from: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
	total: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
const DetailEnvelope = EnvelopeSchema(SessionDetailItemSchema);
export const SessionDetailEnvelopeSchema = Schema.Union([
	DetailEnvelope.members[0],
	DetailEnvelope.members[1],
	DetailEnvelope.members[2].pipe(
		Schema.fieldsAssign({
			// On a part row: its text is the suffix past what was last sent.
			textSuffix: Schema.optional(TextSuffixSchema),
		}),
	),
	DetailEnvelope.members[3],
]);
export type SessionDetailEnvelope = typeof SessionDetailEnvelopeSchema.Type;

export const GetModelsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	instanceId: Schema.optional(Schema.String),
	defaultOpenCodeInstanceId: Schema.optional(Schema.String),
	/** Explicit account reads include its discovered catalog; other discovery catalogs follow providerModels. */
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
	contextWindow: Schema.optional(ContextWindowInfoSchema),
});

export const SetDefaultModelResponseSchema = SwitchModelResponseSchema;

export const HarnessDefaultStateSchema = Schema.Struct({
	pick: Schema.optional(
		Schema.Struct({
			providerId: Schema.String,
			modelId: Schema.String,
			effort: Schema.String,
			contextWindow: Schema.String,
		}),
	),
	status: Schema.Literals(["ok", "missing", "invalid", "unverified"]),
	problem: Schema.optional(Schema.String),
});
export type HarnessDefaultState = typeof HarnessDefaultStateSchema.Type;

export const SetHarnessDefaultResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	harness: Schema.suspend(() => KnownProviderDriverKindSchema),
	state: HarnessDefaultStateSchema,
});
export type SetHarnessDefaultResponse =
	typeof SetHarnessDefaultResponseSchema.Type;

export const TitleGenerationResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	...TitleGenerationStateSchema.fields,
});
export type TitleGenerationResponse = typeof TitleGenerationResponseSchema.Type;

export const SetDefaultPermissionModeResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	mode: SessionPermissionModeSchema,
});

export const SetDefaultSessionModeResponseSchema = Schema.Struct({
	mode: DefaultSessionModeSchema,
});
export type SetDefaultSessionModeResponse =
	typeof SetDefaultSessionModeResponseSchema.Type;

export const ResolveSessionModeResponseSchema = Schema.Struct({
	mode: SessionModeSchema,
	source: Schema.Literals(["project", "file", "global"]),
	warning: Schema.optional(Schema.String),
});
export type ResolveSessionModeResponse =
	typeof ResolveSessionModeResponseSchema.Type;

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

export const PermissionDecisionSchema = Schema.Literals([
	"allow",
	"allow_always",
	"deny",
]);

export const PermissionPersistScopeSchema = Schema.Literals([
	"tool",
	"pattern",
]);
export const PermissionUpdateDestinationSchema = Schema.Literals([
	"userSettings",
	"projectSettings",
	"localSettings",
	"session",
	"cliArg",
]);
export const RpcLogLevelSchema = Schema.Literals([
	"debug",
	"verbose",
	"info",
	"warn",
	"error",
]);

export const ProjectSessionAvailabilitySchema = Schema.Union([
	Schema.Struct({
		projectSlug: Schema.String,
		available: Schema.Literal(true),
	}),
	Schema.Struct({
		projectSlug: Schema.String,
		available: Schema.Literal(false),
		error: Schema.String,
	}),
]);

export const DaemonSessionCursorSchema = Schema.Struct({
	updatedAt: Schema.Number,
	id: Schema.String,
});

export const ListDaemonSessionsResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	sessions: Schema.Array(SessionInfoSchema),
	/** Full shelf counts per available project, unaffected by page/cursor. */
	settledCounts: Schema.optional(
		Schema.Array(
			Schema.Struct({
				projectSlug: Schema.String,
				count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			}),
		),
	),
	availability: Schema.Array(ProjectSessionAvailabilitySchema),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(DaemonSessionCursorSchema),
});

export const ArchivedSessionCursorSchema = Schema.Struct({
	archivedAt: Schema.Number,
	id: Schema.String,
});

export const ListArchivedSessionsResponseSchema = Schema.Struct({
	sessions: Schema.Array(SessionInfoSchema),
	availability: Schema.Array(ProjectSessionAvailabilitySchema),
	hasMore: Schema.Boolean,
	nextCursor: Schema.NullOr(ArchivedSessionCursorSchema),
});

export const CreateSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
});

export const ViewSessionResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
});

const SteerRefusedSchema = Schema.Struct({
	ok: Schema.Literal(false),
	reason: Schema.Literals([...STEER_BLOCKERS]),
});

/** Ok, or a refused steer: nothing was admitted, so the browser keeps the text. */
export const SubmitInputResponseSchema = Schema.Union([
	Schema.Struct({
		ok: Schema.Literal(true),
		sessionId: Schema.String,
		handedOff: Schema.Boolean,
	}),
	SteerRefusedSchema,
]);

/** Ok; or the input already started (or never existed) and cannot be changed;
 *  or Send now could not steer it, so it stays queued. */
export const InboxCommandResponseSchema = Schema.Union([
	Schema.Struct({ ok: Schema.Literal(true) }),
	Schema.Struct({
		ok: Schema.Literal(false),
		reason: Schema.Literal("already_started"),
	}),
	SteerRefusedSchema,
]);

export const LoadMoreHistoryResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
	messages: Schema.Array(HistoryMessageSchema),
	hasMore: Schema.Boolean,
	cursor: Schema.optional(NonEmptyString),
});

export const ForkSessionResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
	/** Lineage for the forking tab until the fork's family row arrives. */
	forkedFrom: Schema.String,
	forkMessageId: Schema.optional(Schema.String),
	forkPointTimestamp: Schema.optional(Schema.Number),
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

export const FolderIssueSchema: Schema.Codec<FolderIssue> = Schema.Union([
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
	Schema.Struct({
		kind: Schema.Literal("permission-denied"),
		path: Schema.String,
	}),
	Schema.Struct({ kind: Schema.Literal("not-a-folder"), path: Schema.String }),
	Schema.Struct({
		kind: Schema.Literal("conduit-worktree"),
		path: Schema.String,
	}),
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
]);

export const ProjectFolderInputSchema = Schema.Union([
	NonEmptyString,
	Schema.Struct({
		path: NonEmptyString,
		create: Schema.Struct({ gitInit: Schema.Boolean }),
	}),
]);

export type ProjectFolderInput = typeof ProjectFolderInputSchema.Type;
export interface SaveProjectInput {
	readonly slug?: string | undefined;
	readonly title?: string | undefined;
	readonly folders: readonly ProjectFolderInput[];
	readonly setupScript?: string | undefined;
	readonly sessionMode?: SessionMode | null | undefined;
}

export class ProjectSaveRejected extends Schema.TaggedError<ProjectSaveRejected>()(
	"ProjectSaveRejected",
	{
		issues: Schema.Array(FolderIssueSchema),
	},
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
	kind: Schema.optional(Schema.Literal("existing")),
	savedSlug: Schema.String,
	warnings: Schema.Array(FolderIssueSchema),
});

const ProviderCapabilityMapSchema = Schema.Record(
	Schema.String,
	Schema.suspend(() => ProviderSessionCapabilitiesSchema),
);

const ProviderTraitsMapSchema = Schema.Record(
	Schema.String,
	Schema.suspend(() => BrowserDriverTraitsSchema),
);

export const InstanceListResponseSchema = Schema.Struct({
	projectSlug: Schema.optional(Schema.String),
	instances: Schema.Array(OpenCodeInstanceSchema),
	providerCapabilities: Schema.optional(ProviderCapabilityMapSchema),
	providerTraits: Schema.optional(ProviderTraitsMapSchema),
	addedInstanceId: Schema.optional(Schema.String),
});

export const GetInstanceStatusResponseSchema = Schema.Struct({
	instance: OpenCodeInstanceSchema,
});

export const GetStatusResponseSchema = Schema.Struct({
	uptime: Schema.Number,
	version: Schema.String,
	logLevel: RpcLogLevelSchema,
	supervised: Schema.Boolean,
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
	tailscaleServeEnabled: Schema.optional(Schema.Boolean),
	tailscaleServeAvailable: Schema.optional(Schema.Boolean),
	tailscaleServe: Schema.optional(
		Schema.Union([
			Schema.Struct({ url: Schema.String }),
			Schema.Struct({ error: Schema.String }),
		]),
	),
	keepAwake: Schema.Boolean,
	keepAwakeCommand: Schema.NullOr(Schema.String),
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
			reason: Schema.Literals(["recent", "sibling", "match"]),
			exists: Schema.Boolean,
		}),
	),
});

export const GetFileTreeResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	entries: Schema.Array(Schema.String),
	/** Present only for projects with several folders, primary first. */
	roots: Schema.optional(
		Schema.Array(
			Schema.Struct({
				/** Stable Project Folder identity, independent of its mapped worktree. */
				root: NonEmptyString,
				label: NonEmptyString,
				shared: Schema.optional(Schema.Boolean),
			}),
		),
	),
});

export const GetFileListResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	root: Schema.optional(NonEmptyString),
	path: Schema.String,
	entries: Schema.Array(FileEntrySchema),
});

export const GetFileContentResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	root: Schema.optional(NonEmptyString),
	path: Schema.String,
	content: Schema.String,
	binary: Schema.optional(Schema.Boolean),
});

export const GetToolDetailsResponseSchema = Schema.Struct({
	projectSlug: Schema.String,
	tools: Schema.Array(ToolDetail),
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
			invokedBy: Schema.Literals(["user", "agent"]),
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
export type GetToolDetailsResponse = typeof GetToolDetailsResponseSchema.Type;
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
export type ListArchivedSessionsResponse =
	typeof ListArchivedSessionsResponseSchema.Type;
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
	code: Schema.optional(Schema.Literals(["unknown-session", "unknown-turn"])),
}) {}

export class DraftAlreadySent extends Schema.TaggedError<DraftAlreadySent>()(
	"DraftAlreadySent",
	{ draftId: Schema.String },
) {
	override get message() {
		return "This draft was already sent";
	}
}

export const GetStatus = Rpc.make("GetStatus", {
	payload: Schema.TaggedStruct("GetStatus", {}),
	success: GetStatusResponseSchema,
	error: WsRpcError,
});

export class SetPinRejected extends Schema.TaggedError<SetPinRejected>()(
	"SetPinRejected",
	{
		reason: Schema.Literals(["wrong_pin", "locked_out"]),
		retryAfterSeconds: Schema.optional(Schema.Number),
	},
) {}

export const SetPin = Rpc.make("SetPin", {
	payload: Schema.TaggedStruct("SetPin", {
		pin: Schema.NullOr(
			Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4,8}$/))),
		),
		currentPin: Schema.optional(
			Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4,8}$/))),
		),
	}),
	success: OkResponseSchema,
	error: Schema.Union([WsRpcError, SetPinRejected]),
});

export const SetKeepAwake = Rpc.make("SetKeepAwake", {
	payload: Schema.TaggedStruct("SetKeepAwake", { enabled: Schema.Boolean }),
	success: SetKeepAwakeResponseSchema,
	error: WsRpcError,
});

export const SetKeepAwakeCommand = Rpc.make("SetKeepAwakeCommand", {
	payload: Schema.TaggedStruct("SetKeepAwakeCommand", {
		command: NonEmptyString,
		args: Schema.Array(Schema.String).pipe(
			Schema.withDecodingDefaultType(Effect.sync(() => [])),
			Schema.withConstructorDefault(Effect.sync(() => [])),
		),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetTailscaleServe = Rpc.make("SetTailscaleServe", {
	payload: Schema.TaggedStruct("SetTailscaleServe", {
		enabled: Schema.Boolean,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const Shutdown = Rpc.make("Shutdown", {
	payload: Schema.TaggedStruct("Shutdown", {}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetAgent = Rpc.make("SetAgent", {
	payload: Schema.TaggedStruct("SetAgent", {
		slug: Schema.String,
		agent: Schema.String,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const RestartWithConfig = Rpc.make("RestartWithConfig", {
	payload: Schema.TaggedStruct("RestartWithConfig", {}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const CursorAuthStateSchema = Schema.Struct({
	source: Schema.Literals(["environment", "sdk-login", "none"]),
	status: Schema.Literals(["logged-in", "logged-out", "error"]),
	email: Schema.optional(Schema.String),
	apiKeyExpiresAtMs: Schema.optional(Schema.Number),
	expiresSoon: Schema.Boolean,
	error: Schema.optional(Schema.String),
	login: Schema.Struct({
		state: Schema.Literals([
			"idle",
			"pending",
			"complete",
			"cancelled",
			"timed-out",
			"error",
		]),
		url: Schema.optional(Schema.String),
		deadlineAtMs: Schema.optional(Schema.Number),
		error: Schema.optional(Schema.String),
	}),
});
export type CursorAuthState = typeof CursorAuthStateSchema.Type;

export const GetCursorAuth = Rpc.make("GetCursorAuth", {
	payload: Schema.TaggedStruct("GetCursorAuth", {
		accountId: Schema.optional(Schema.String),
	}),
	success: CursorAuthStateSchema,
	error: WsRpcError,
});

export const StartCursorLogin = Rpc.make("StartCursorLogin", {
	payload: Schema.TaggedStruct("StartCursorLogin", {
		accountId: Schema.optional(Schema.String),
	}),
	success: CursorAuthStateSchema,
	error: WsRpcError,
});

export const CancelCursorLogin = Rpc.make("CancelCursorLogin", {
	payload: Schema.TaggedStruct("CancelCursorLogin", {
		accountId: Schema.optional(Schema.String),
	}),
	success: CursorAuthStateSchema,
	error: WsRpcError,
});

export const LogoutCursor = Rpc.make("LogoutCursor", {
	payload: Schema.TaggedStruct("LogoutCursor", {
		accountId: Schema.optional(Schema.String),
	}),
	success: CursorAuthStateSchema,
	error: WsRpcError,
});

export const CodexAuthStateSchema = Schema.Struct({
	accountId: Schema.String,
	source: Schema.Literals(["environment", "codex-login", "none"]),
	status: Schema.Literals(["logged-in", "logged-out", "error"]),
	email: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
	login: Schema.Struct({
		state: Schema.Literals([
			"idle",
			"pending",
			"complete",
			"cancelled",
			"timed-out",
			"error",
		]),
		method: Schema.optional(Schema.Literals(["browser", "device-code"])),
		url: Schema.optional(Schema.String),
		verificationUrl: Schema.optional(Schema.String),
		userCode: Schema.optional(Schema.String),
		loginId: Schema.optional(Schema.String),
		deadlineAtMs: Schema.optional(Schema.Number),
		error: Schema.optional(Schema.String),
	}),
});
export type CodexAuthState = typeof CodexAuthStateSchema.Type;

export const GetCodexAuth = Rpc.make("GetCodexAuth", {
	payload: Schema.TaggedStruct("GetCodexAuth", { accountId: NonEmptyString }),
	success: CodexAuthStateSchema,
	error: WsRpcError,
});
export const StartCodexLogin = Rpc.make("StartCodexLogin", {
	payload: Schema.TaggedStruct("StartCodexLogin", {
		accountId: NonEmptyString,
		method: Schema.Literals(["browser", "device-code"]),
	}),
	success: CodexAuthStateSchema,
	error: WsRpcError,
});
export const CancelCodexLogin = Rpc.make("CancelCodexLogin", {
	payload: Schema.TaggedStruct("CancelCodexLogin", {
		accountId: NonEmptyString,
	}),
	success: CodexAuthStateSchema,
	error: WsRpcError,
});
export const LogoutCodex = Rpc.make("LogoutCodex", {
	payload: Schema.TaggedStruct("LogoutCodex", { accountId: NonEmptyString }),
	success: CodexAuthStateSchema,
	error: WsRpcError,
});

export const GetInstances = Rpc.make("GetInstances", {
	payload: Schema.TaggedStruct("GetInstances", {}),
	success: InstanceListResponseSchema,
	error: WsRpcError,
});

export const GetInstanceStatus = Rpc.make("GetInstanceStatus", {
	payload: Schema.TaggedStruct("GetInstanceStatus", {
		instanceId: NonEmptyString,
	}),
	success: GetInstanceStatusResponseSchema,
	error: WsRpcError,
});

export const GetAgents = Rpc.make("GetAgents", {
	payload: Schema.TaggedStruct("GetAgents", {
		projectSlug: NonEmptyString,

		instanceId: Schema.optional(Schema.String),
	}),
	success: GetAgentsResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetAgents; its owner supplies the project. */
export const GetAgentsForSession = Rpc.make(GetAgents._tag, {
	payload: Schema.TaggedStruct(GetAgents._tag, {
		sessionId: NonEmptyString,
		instanceId: Schema.optional(Schema.String),
	}),
	success: GetAgents.successSchema,
	error: GetAgents.errorSchema,
});

export const GetCommands = Rpc.make("GetCommands", {
	payload: Schema.TaggedStruct("GetCommands", {
		projectSlug: NonEmptyString,
		instanceId: Schema.optional(Schema.String),
	}),
	success: GetCommandsResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetCommands; its owner supplies the project. */
export const GetCommandsForSession = Rpc.make(GetCommands._tag, {
	payload: Schema.TaggedStruct(GetCommands._tag, {
		sessionId: NonEmptyString,
		instanceId: Schema.optional(Schema.String),
	}),
	success: GetCommands.successSchema,
	error: GetCommands.errorSchema,
});

export const GetProjects = Rpc.make("GetProjects", {
	payload: Schema.TaggedStruct("GetProjects", {
		projectSlug: Schema.optional(NonEmptyString),
	}),
	success: GetProjectsResponseSchema,
	error: WsRpcError,
});

export const SaveProject = Rpc.make("SaveProject", {
	payload: Schema.TaggedStruct("SaveProject", {
		projectSlug: Schema.optional(NonEmptyString),
		slug: Schema.optional(NonEmptyString),
		title: Schema.optional(NonEmptyString),
		folders: Schema.Array(ProjectFolderInputSchema),
		setupScript: Schema.optional(Schema.String),
		sessionMode: Schema.optional(Schema.NullOr(SessionModeSchema)),
	}),
	success: SaveProjectResponseSchema,
	error: Schema.Union([WsRpcError, ProjectSaveRejected]),
});

export const SetProjectOrder = Rpc.make("SetProjectOrder", {
	payload: Schema.TaggedStruct("SetProjectOrder", {
		projectOrder: Schema.Array(Schema.String),
	}),
	success: Schema.Void,
	error: WsRpcError,
});

export const RemoveProject = Rpc.make("RemoveProject", {
	payload: Schema.TaggedStruct("RemoveProject", {
		projectSlug: Schema.optional(NonEmptyString),
		slug: NonEmptyString,
	}),
	success: ProjectMutationResponseSchema,
	error: WsRpcError,
});

export const StartInstance = Rpc.make("StartInstance", {
	payload: Schema.TaggedStruct("StartInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		instanceId: NonEmptyString,
	}),
	success: InstanceListResponseSchema,
	error: WsRpcError,
});

export const StopInstance = Rpc.make("StopInstance", {
	payload: Schema.TaggedStruct("StopInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		instanceId: NonEmptyString,
	}),
	success: InstanceListResponseSchema,
	error: WsRpcError,
});

export const RemoveInstance = Rpc.make("RemoveInstance", {
	payload: Schema.TaggedStruct("RemoveInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		instanceId: NonEmptyString,
	}),
	success: InstanceListResponseSchema,
	error: Schema.Union([
		WsRpcError,
		Schema.suspend(() => AccountChangeRejected),
	]),
});

export const RenameInstance = Rpc.make("RenameInstance", {
	payload: Schema.TaggedStruct("RenameInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		instanceId: NonEmptyString,
		name: NonEmptyString,
	}),
	success: InstanceListResponseSchema,
	error: Schema.Union([
		WsRpcError,
		Schema.suspend(() => AccountChangeRejected),
	]),
});

export const AddInstance = Rpc.make("AddInstance", {
	payload: Schema.TaggedStruct("AddInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		name: NonEmptyString,
		driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
		managed: Schema.optional(Schema.Boolean),
		port: Schema.optional(Schema.Number),
		url: Schema.optional(Schema.String),
		env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
		configDir: Schema.optional(Schema.String),
	}),
	success: InstanceListResponseSchema,
	error: Schema.Union([
		WsRpcError,
		Schema.suspend(() => AccountChangeRejected),
	]),
});

export const UpdateInstance = Rpc.make("UpdateInstance", {
	payload: Schema.TaggedStruct("UpdateInstance", {
		projectSlug: Schema.optional(NonEmptyString),
		instanceId: NonEmptyString,
		driver: Schema.optional(Schema.suspend(() => ProviderDriverKindSchema)),
		name: Schema.optional(Schema.String),
		port: Schema.optional(Schema.Number),
		env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
		configDir: Schema.optional(Schema.String),
	}),
	success: InstanceListResponseSchema,
	error: Schema.Union([
		WsRpcError,
		Schema.suspend(() => AccountChangeRejected),
	]),
});

export const SetDefault = Rpc.make("SetDefault", {
	payload: Schema.TaggedStruct("SetDefault", {
		instanceId: NonEmptyString,
	}),
	success: InstanceListResponseSchema,
	error: Schema.Union([
		WsRpcError,
		Schema.suspend(() => AccountChangeRejected),
	]),
});

const WorktreeCleanupSettingResponseSchema = Schema.Struct({
	global: WorktreeCleanupSchema,
	project: Schema.optional(Schema.NullOr(ProjectWorktreeCleanupSchema)),
});

export const GetWorktreeCleanupSetting = Rpc.make("GetWorktreeCleanupSetting", {
	payload: Schema.TaggedStruct("GetWorktreeCleanupSetting", {
		projectSlug: Schema.optional(NonEmptyString),
	}),
	success: WorktreeCleanupSettingResponseSchema,
	error: WsRpcError,
});

export const SetWorktreeCleanupSetting = Rpc.make("SetWorktreeCleanupSetting", {
	payload: Schema.TaggedStruct("SetWorktreeCleanupSetting", {
		scope: Schema.Literal("global"),
		rules: WorktreeCleanupSchema,
	}),
	success: WorktreeCleanupSettingResponseSchema,
	error: WsRpcError,
});

export const SetProjectWorktreeCleanupSetting = Rpc.make(
	SetWorktreeCleanupSetting._tag,
	{
		payload: Schema.TaggedStruct(SetWorktreeCleanupSetting._tag, {
			scope: Schema.Literal("project"),
			projectSlug: NonEmptyString,
			override: Schema.NullOr(ProjectWorktreeCleanupSchema),
		}),
		success: SetWorktreeCleanupSetting.successSchema,
		error: SetWorktreeCleanupSetting.errorSchema,
	},
);

export const CleanUpWorktreesNow = Rpc.make("CleanUpWorktreesNow", {
	payload: Schema.TaggedStruct("CleanUpWorktreesNow", {
		projectSlug: Schema.optional(NonEmptyString),
	}),
	success: WorktreeCleanupReportSchema,
	error: WsRpcError,
});

export const GetAvatar = Rpc.make("GetAvatar", {
	payload: Schema.TaggedStruct("GetAvatar", {}),
	success: AvatarSchema,
	error: WsRpcError,
});

export const SetAvatar = Rpc.make("SetAvatar", {
	payload: Schema.TaggedStruct("SetAvatar", { choice: AvatarChoiceSchema }),
	success: AvatarSchema,
	error: WsRpcError,
});

const AutoSettleSettingResponseSchema = Schema.Struct({
	autoSettleAfterDays: Schema.NullOr(Schema.Number),
});

export const GetAutoSettleSetting = Rpc.make("GetAutoSettleSetting", {
	payload: Schema.TaggedStruct("GetAutoSettleSetting", {}),
	success: AutoSettleSettingResponseSchema,
	error: WsRpcError,
});

export const SetAutoSettleSetting = Rpc.make("SetAutoSettleSetting", {
	payload: Schema.TaggedStruct("SetAutoSettleSetting", {
		autoSettleAfterDays: Schema.NullOr(Schema.Number),
	}),
	success: AutoSettleSettingResponseSchema,
	error: WsRpcError,
});

const UsageLimitsSettingResponseSchema = Schema.Struct({
	usageLimits: UsageLimitsSettingSchema,
});

const AutoArchiveSettingResponseSchema = Schema.Struct({
	autoArchiveAfterDays: Schema.NullOr(Schema.Number),
});

export const GetAutoArchiveSetting = Rpc.make("GetAutoArchiveSetting", {
	payload: Schema.TaggedStruct("GetAutoArchiveSetting", {}),
	success: AutoArchiveSettingResponseSchema,
	error: WsRpcError,
});

export const SetAutoArchiveSetting = Rpc.make("SetAutoArchiveSetting", {
	payload: Schema.TaggedStruct("SetAutoArchiveSetting", {
		autoArchiveAfterDays: Schema.NullOr(Schema.Number),
	}),
	success: AutoArchiveSettingResponseSchema,
	error: WsRpcError,
});

const AutoDeleteArchivedSettingResponseSchema = Schema.Struct({
	autoDeleteArchivedAfterDays: Schema.NullOr(Schema.Number),
});

export const GetAutoDeleteArchivedSetting = Rpc.make(
	"GetAutoDeleteArchivedSetting",
	{
		payload: Schema.TaggedStruct("GetAutoDeleteArchivedSetting", {}),
		success: AutoDeleteArchivedSettingResponseSchema,
		error: WsRpcError,
	},
);

export const SetAutoDeleteArchivedSetting = Rpc.make(
	"SetAutoDeleteArchivedSetting",
	{
		payload: Schema.TaggedStruct("SetAutoDeleteArchivedSetting", {
			autoDeleteArchivedAfterDays: Schema.NullOr(Schema.Number),
		}),
		success: AutoDeleteArchivedSettingResponseSchema,
		error: WsRpcError,
	},
);

export const GetUsageLimitsSetting = Rpc.make("GetUsageLimitsSetting", {
	payload: Schema.TaggedStruct("GetUsageLimitsSetting", {}),
	success: UsageLimitsSettingResponseSchema,
	error: WsRpcError,
});

export const SetUsageLimitsSetting = Rpc.make("SetUsageLimitsSetting", {
	payload: Schema.TaggedStruct("SetUsageLimitsSetting", {
		usageLimits: UsageLimitsSettingSchema,
	}),
	success: UsageLimitsSettingResponseSchema,
	error: WsRpcError,
});

export const SetCursorUsageKeychain = Rpc.make("SetCursorUsageKeychain", {
	payload: Schema.TaggedStruct("SetCursorUsageKeychain", {
		accountId: NonEmptyString,
		enabled: Schema.Boolean,
	}),
	success: Schema.Struct({
		enabled: Schema.Boolean,
		reason: Schema.optional(Schema.String),
	}),
	error: WsRpcError,
});

export const ScanNow = Rpc.make("ScanNow", {
	payload: Schema.TaggedStruct("ScanNow", {
		projectSlug: Schema.optional(NonEmptyString),
	}),
	success: ScanNowResponseSchema,
	error: WsRpcError,
});

export const DetectProxy = Rpc.make("DetectProxy", {
	payload: Schema.TaggedStruct("DetectProxy", {
		projectSlug: Schema.optional(NonEmptyString),
	}),
	success: DetectProxyResponseSchema,
	error: WsRpcError,
});

export const ListPtys = Rpc.make("ListPtys", {
	payload: Schema.TaggedStruct("ListPtys", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
	}),
	success: PtyListResponseSchema,
	error: WsRpcError,
});

export const CreatePty = Rpc.make("CreatePty", {
	payload: Schema.TaggedStruct("CreatePty", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,

		accountId: Schema.optional(NonEmptyString),
		root: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of CreatePty; its owner supplies the project. */
export const CreatePtyForSession = Rpc.make(CreatePty._tag, {
	payload: Schema.TaggedStruct(CreatePty._tag, {
		originId: NonEmptyString,
		sessionId: NonEmptyString,
		accountId: Schema.optional(NonEmptyString),
		root: Schema.optional(NonEmptyString),
	}),
	success: CreatePty.successSchema,
	error: CreatePty.errorSchema,
});

export const ResizePty = Rpc.make("ResizePty", {
	payload: Schema.TaggedStruct("ResizePty", {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
		cols: Schema.optional(Schema.Number),
		rows: Schema.optional(Schema.Number),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const ClosePty = Rpc.make("ClosePty", {
	payload: Schema.TaggedStruct("ClosePty", {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/** Keystrokes for one terminal. Unary and never coalesced: input latency is
 *  the user's typing, so each call carries what was typed since the last ack. */
export const PtyInput = Rpc.make("PtyInput", {
	payload: Schema.TaggedStruct("PtyInput", {
		projectSlug: NonEmptyString,
		ptyId: NonEmptyString,
		data: Schema.String,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const FindFolders = Rpc.make("FindFolders", {
	payload: Schema.TaggedStruct("FindFolders", {
		projectSlug: Schema.optional(NonEmptyString),
		query: Schema.String,
	}),
	success: FindFoldersResponseSchema,
	error: Schema.Union([WsRpcError, ProjectSaveRejected]),
});

export const SwitchAgent = Rpc.make("SwitchAgent", {
	payload: Schema.TaggedStruct("SwitchAgent", {
		sessionId: NonEmptyString,
		agentId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SwitchContextWindow = Rpc.make("SwitchContextWindow", {
	payload: Schema.TaggedStruct("SwitchContextWindow", {
		sessionId: NonEmptyString,
		contextWindow: Schema.String,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SwitchContextWindowResponseSchema,
	error: WsRpcError,
});

export const SwitchModel = Rpc.make("SwitchModel", {
	payload: Schema.TaggedStruct("SwitchModel", {
		sessionId: NonEmptyString,
		modelId: NonEmptyString,
		providerId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SwitchModelResponseSchema,
	error: WsRpcError,
});

export const SetDefaultModel = Rpc.make("SetDefaultModel", {
	payload: Schema.TaggedStruct("SetDefaultModel", {
		projectSlug: NonEmptyString,
		model: NonEmptyString,
		provider: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SetDefaultModelResponseSchema,
	error: WsRpcError,
});

export const SetHarnessDefault = Rpc.make("SetHarnessDefault", {
	payload: Schema.TaggedStruct("SetHarnessDefault", {
		projectSlug: NonEmptyString,
		harness: Schema.suspend(() => KnownProviderDriverKindSchema),
		providerId: NonEmptyString,
		modelId: NonEmptyString,
		/** Omitted: the effort last saved for this model, if still offered. */
		effort: Schema.optional(Schema.String),
		contextWindow: Schema.String,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SetHarnessDefaultResponseSchema,
	error: WsRpcError,
});

export const GetTitleGeneration = Rpc.make("GetTitleGeneration", {
	payload: Schema.TaggedStruct("GetTitleGeneration", {
		projectSlug: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: TitleGenerationResponseSchema,
	error: WsRpcError,
});

export const SetTitleGeneration = Rpc.make("SetTitleGeneration", {
	payload: Schema.TaggedStruct("SetTitleGeneration", {
		projectSlug: NonEmptyString,
		selection: Schema.NullOr(TitleGenerationSelectionSchema),
		originId: Schema.optional(NonEmptyString),
	}),
	success: TitleGenerationResponseSchema,
	error: WsRpcError,
});

export const SetDefaultPermissionMode = Rpc.make("SetDefaultPermissionMode", {
	payload: Schema.TaggedStruct("SetDefaultPermissionMode", {
		projectSlug: NonEmptyString,
		mode: SessionPermissionModeSchema,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SetDefaultPermissionModeResponseSchema,
	error: WsRpcError,
});

export const SetDefaultSessionMode = Rpc.make("SetDefaultSessionMode", {
	payload: Schema.TaggedStruct("SetDefaultSessionMode", {
		projectSlug: NonEmptyString,
		mode: DefaultSessionModeSchema,
	}),
	success: SetDefaultSessionModeResponseSchema,
	error: WsRpcError,
});

/** Resolve draft defaults without attaching or starting a project relay. */
export const ResolveSessionMode = Rpc.make("ResolveSessionMode", {
	payload: Schema.TaggedStruct("ResolveSessionMode", {
		projectSlug: NonEmptyString,
	}),
	success: ResolveSessionModeResponseSchema,
	error: WsRpcError,
});

export const SetTerminalKeys = Rpc.make("SetTerminalKeys", {
	payload: Schema.TaggedStruct("SetTerminalKeys", {
		terminalKeys: TerminalKeysSetting,
	}),
	success: Schema.Struct({ terminalKeys: TerminalKeysSetting }),
	error: WsRpcError,
});

export const GetTerminalKeys = Rpc.make("GetTerminalKeys", {
	payload: Schema.TaggedStruct("GetTerminalKeys", {}),
	success: Schema.Struct({ terminalKeys: TerminalKeysSetting }),
	error: WsRpcError,
});

export const GetMessageSurfacing = Rpc.make("GetMessageSurfacing", {
	payload: Schema.TaggedStruct("GetMessageSurfacing", {}),
	success: MessageSurfacingStatusSchema,
	error: WsRpcError,
});

export const UpdateMessageSurfacing = Rpc.make("UpdateMessageSurfacing", {
	payload: Schema.TaggedStruct(
		"UpdateMessageSurfacing",
		MessageSurfacingPatchSchema.fields,
	).pipe(
		Schema.middlewareDecoding((effect) =>
			Effect.mapError(
				effect,
				() =>
					new SchemaIssue.InvalidValue({
						message: "Invalid message surfacing settings",
					}),
			),
		),
	),
	success: MessageSurfacingStatusSchema,
	error: WsRpcError,
});

export const GetCategorySet = Rpc.make("GetCategorySet", {
	payload: Schema.TaggedStruct("GetCategorySet", {}),
	success: CategorySetSchema,
	error: WsRpcError,
});

export const SetSurfacingMark = Rpc.make("SetSurfacingMark", {
	payload: Schema.TaggedStruct("SetSurfacingMark", {
		sessionId: NonEmptyString,
		partId: NonEmptyString,
		mark: Schema.NullOr(SurfacingMarkSchema),
	}),
	success: Schema.Struct({ ok: Schema.Literal(true) }),
	error: WsRpcError,
});

export const GetSurfacingFeedback = Rpc.make("GetSurfacingFeedback", {
	payload: Schema.TaggedStruct("GetSurfacingFeedback", {}),
	success: Schema.Array(SurfacingFeedbackEntrySchema),
	error: WsRpcError,
});

export const GetSurfacingLedger = Rpc.make("GetSurfacingLedger", {
	payload: Schema.TaggedStruct("GetSurfacingLedger", {}),
	success: Schema.Array(SurfacingFeedbackEntrySchema),
	error: WsRpcError,
});

export const ScoreCategorySet = Rpc.make("ScoreCategorySet", {
	payload: Schema.TaggedStruct("ScoreCategorySet", {
		set: CategorySetContentsSchema,
		estimateOnly: Schema.optional(Schema.Boolean),
	}),
	success: CategoryTuningScoreSchema,
	error: WsRpcError,
});

export const ProposeCategoryTuning = Rpc.make("ProposeCategoryTuning", {
	payload: Schema.TaggedStruct("ProposeCategoryTuning", {
		avoid: Schema.optional(Schema.Array(CategoryTuningHunkSchema)),
	}),
	success: CategoryTuningProposalSchema,
	error: WsRpcError,
});

export const ListRecaps = Rpc.make("ListRecaps", {
	payload: Schema.TaggedStruct("ListRecaps", {
		sessionId: NonEmptyString,
		turnId: NonEmptyString,
	}),
	success: Schema.Array(TurnRecapSchema),
	error: WsRpcError,
});

export const GenerateRecap = Rpc.make("GenerateRecap", {
	payload: Schema.TaggedStruct("GenerateRecap", {
		sessionId: NonEmptyString,
		turnId: NonEmptyString,
		scope: RecapScopeSchema,
		sourceVersion: Schema.optional(
			Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
		),
	}),
	success: TurnRecapSchema,
	error: WsRpcError,
});

export const ExplainAsk = Rpc.make("ExplainAsk", {
	payload: Schema.TaggedStruct("ExplainAsk", {
		sessionId: NonEmptyString,
		turnId: NonEmptyString,
		partId: NonEmptyString,
	}),
	success: AskExplanationSchema,
	error: WsRpcError,
});

export const ReplaceCategorySet = Rpc.make("ReplaceCategorySet", {
	payload: Schema.TaggedStruct("ReplaceCategorySet", {
		expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		nextSet: CategorySetContentsSchema,
	}),
	success: CategorySetSchema,
	error: Schema.Union([WsRpcError, CategorySetRejected]),
});

export const SetHiddenEntries = Rpc.make("SetHiddenEntries", {
	payload: Schema.TaggedStruct("SetHiddenEntries", {
		projectSlug: NonEmptyString,
		hiddenModels: Schema.optional(Schema.Array(Schema.String)),
		hiddenAgents: Schema.optional(Schema.Array(Schema.String)),
		originId: Schema.optional(NonEmptyString),
	}),
	success: SetHiddenEntriesResponseSchema,
	error: WsRpcError,
});

export const GetClaudeSettings = Rpc.make("GetClaudeSettings", {
	payload: Schema.TaggedStruct("GetClaudeSettings", {
		projectSlug: NonEmptyString,
	}),
	success: ClaudeSettingsResponseSchema,
	error: WsRpcError,
});

export const SetClaudeSettings = Rpc.make("SetClaudeSettings", {
	payload: Schema.TaggedStruct("SetClaudeSettings", {
		projectSlug: NonEmptyString,
		overrides: ClaudeSettingsOverridesSchema,
		originId: Schema.optional(NonEmptyString),
	}),
	success: ClaudeSettingsResponseSchema,
	error: Schema.Union([WsRpcError, ClaudeSettingsTrustBoundaryError]),
});

const ResolveClaudeSettingsWire = Rpc.make("ResolveClaudeSettings", {
	payload: Schema.TaggedStruct("ResolveClaudeSettings", {
		projectSlug: NonEmptyString,
		instanceId: NonEmptyString,
	}),
	success: ResolveClaudeSettingsResponseSchema,
	error: Schema.Union([
		WsRpcError,
		ClaudeSettingsResolveError,
		Schema.suspend(() => AccountUnroutable),
	]),
});

export const ResolveClaudeSettings = Rpc.make(ResolveClaudeSettingsWire._tag, {
	payload: ResolveClaudeSettingsWire.payloadSchema.pipe(
		Schema.decodeTo(
			Schema.Struct({
				...ResolveClaudeSettingsWire.payloadSchema.fields,
				accountRef: Schema.optional(Schema.suspend(() => AccountRefSchema)),
			}),
			{
				decode: SchemaGetter.transformEffect((wire) =>
					Effect.succeed({
						...wire,
						accountRef: { _tag: "Id" as const, id: wire.instanceId },
					}),
				),
				encode: SchemaGetter.transformEffect(({ accountRef, ...wire }) =>
					accountRef?._tag === "DriverDefault"
						? Effect.fail(
								new SchemaIssue.InvalidValue(
									{
										message:
											"ResolveClaudeSettings requires an explicit account Id",
									},
									accountRef,
								),
							)
						: Effect.succeed({
								...wire,
								instanceId: accountRef?.id ?? wire.instanceId,
							}),
				),
			},
		),
	),
	success: ResolveClaudeSettingsWire.successSchema,
	error: ResolveClaudeSettingsWire.errorSchema,
});

/** Session-scoped form of ResolveClaudeSettings; its owner supplies the project. */
export const ResolveClaudeSettingsForSession = Rpc.make(
	ResolveClaudeSettings._tag,
	{
		payload: Schema.TaggedStruct(ResolveClaudeSettings._tag, {
			instanceId: NonEmptyString,
			sessionId: NonEmptyString,
		}),
		success: ResolveClaudeSettings.successSchema,
		error: ResolveClaudeSettings.errorSchema,
	},
);

export const ReloadProviderSession = Rpc.make("ReloadProviderSession", {
	payload: Schema.TaggedStruct("ReloadProviderSession", {
		sessionId: NonEmptyString,
		commandId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: ReloadProviderSessionResponseSchema,
	error: WsRpcError,
});

export const ListBranches = Rpc.make("ListBranches", {
	payload: Schema.TaggedStruct("ListBranches", { projectSlug: NonEmptyString }),
	success: Schema.Struct({
		current: Schema.optional(Schema.String),
		branches: Schema.Array(Schema.String),
	}),
	error: WsRpcError,
});

export const ListWorktrees = Rpc.make("ListWorktrees", {
	payload: Schema.TaggedStruct("ListWorktrees", {
		projectSlug: NonEmptyString,
	}),
	success: Schema.Struct({
		worktrees: Schema.Array(WorktreeInfoSchema),
		directory: Schema.optional(Schema.String),
	}),
	error: WsRpcError,
});

/** Session-scoped form of ListWorktrees; its owner supplies the project. */
export const ListWorktreesForSession = Rpc.make(ListWorktrees._tag, {
	payload: Schema.TaggedStruct(ListWorktrees._tag, {
		sessionId: NonEmptyString,
	}),
	success: ListWorktrees.successSchema,
	error: ListWorktrees.errorSchema,
});

export const MoveSessionWorkspace = Rpc.make("MoveSessionWorkspace", {
	payload: Schema.TaggedStruct("MoveSessionWorkspace", {
		sessionId: NonEmptyString,
		path: NonEmptyString,
	}),
	success: Schema.Struct({ directory: Schema.String }),
	error: Schema.Union([WsRpcError, WorkspaceMoveError]),
});

export const InspectSessionWorktrees = Rpc.make("InspectSessionWorktrees", {
	payload: Schema.TaggedStruct("InspectSessionWorktrees", {
		sessionId: NonEmptyString,
	}),
	success: Schema.Struct({
		worktrees: Schema.Array(SessionWorktreeInspectionSchema),
		removeWorktrees: Schema.Boolean,
		onDelete: Schema.Literals(["ask", "remove"]),
	}),
	error: WsRpcError,
});

export const RenameSessionBranch = Rpc.make("RenameSessionBranch", {
	payload: Schema.TaggedStruct("RenameSessionBranch", {
		sessionId: NonEmptyString,
		branchName: Schema.String,
	}),
	success: Schema.Struct({ ok: Schema.Literal(true) }),
	error: Schema.Union([WsRpcError, WorktreeBranchRenameError]),
});

export const RecreateSessionWorktree = Rpc.make("RecreateSessionWorktree", {
	payload: Schema.TaggedStruct("RecreateSessionWorktree", {
		sessionId: NonEmptyString,
	}),
	success: Schema.Struct({ directory: Schema.String }),
	error: Schema.Union([WsRpcError, WorktreeRecoveryError]),
});

export const ContinueSessionInMainFolder = Rpc.make(
	"ContinueSessionInMainFolder",
	{
		payload: Schema.TaggedStruct("ContinueSessionInMainFolder", {
			sessionId: NonEmptyString,
		}),
		success: Schema.Struct({ directory: Schema.String }),
		error: Schema.Union([WsRpcError, WorkspaceMoveError]),
	},
);

export const DismissWorkspaceHint = Rpc.make("DismissWorkspaceHint", {
	payload: Schema.TaggedStruct("DismissWorkspaceHint", {
		sessionId: NonEmptyString,
		path: NonEmptyString,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/** The managed OpenCode plugin attributes the declaration using ToolContext.sessionID. */
export const OpenCodeUseWorktree = Rpc.make("OpenCodeUseWorktree", {
	payload: Schema.TaggedStruct("OpenCodeUseWorktree", {
		instanceId: NonEmptyString,
		providerSessionId: NonEmptyString,
		path: NonEmptyString,
	}),
	success: Schema.Struct({ directory: Schema.String }),
	error: Schema.Union([WsRpcError, WorkspaceMoveError]),
});

export const RenameSession = Rpc.make("RenameSession", {
	payload: Schema.TaggedStruct("RenameSession", {
		sessionId: NonEmptyString,
		title: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const MarkSessionUnread = Rpc.make("MarkSessionUnread", {
	payload: Schema.TaggedStruct("MarkSessionUnread", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/**
 * `session.mark_seen`: the user picked the session in the sidebar, having seen
 * it up to stream version `upTo`. The server caps `upTo` at the latest turn
 * end, so a report can never mark a turn that has not happened yet as seen.
 */
export const MarkSessionSeen = Rpc.make("MarkSessionSeen", {
	payload: Schema.TaggedStruct("MarkSessionSeen", {
		sessionId: NonEmptyString,
		upTo: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const MarkSessionRead = Rpc.make("MarkSessionRead", {
	payload: Schema.TaggedStruct("MarkSessionRead", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetMessagesRead = Rpc.make("SetMessagesRead", {
	payload: Schema.TaggedStruct("SetMessagesRead", {
		sessionId: NonEmptyString,
		partIds: Schema.Array(NonEmptyString).pipe(
			Schema.check(Schema.isMinLength(1)),
		),
		read: Schema.Boolean,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetSessionSettled = Rpc.make("SetSessionSettled", {
	payload: Schema.TaggedStruct("SetSessionSettled", {
		sessionId: NonEmptyString,
		settled: Schema.Boolean,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetSessionPinned = Rpc.make("SetSessionPinned", {
	payload: Schema.TaggedStruct("SetSessionPinned", {
		sessionId: NonEmptyString,
		pinned: Schema.Boolean,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/** What automatic settlement will do with a session. */
export const AutoSettleOutlookSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literals(["off", "never", "settled", "due"]) }),
	Schema.Struct({
		kind: Schema.Literal("paused"),
		reason: Schema.Literals([
			"pinned",
			"snoozed",
			"unread",
			"working",
			"awaiting-activity",
		]),
	}),
	Schema.Struct({ kind: Schema.Literal("scheduled"), at: Schema.Number }),
]);
export type AutoSettleOutlook = typeof AutoSettleOutlookSchema.Type;

/** The outlook as once the asking viewer leaves: an open viewer never pauses it. */
export const GetSessionAutoSettleOutlook = Rpc.make(
	"GetSessionAutoSettleOutlook",
	{
		payload: Schema.TaggedStruct("GetSessionAutoSettleOutlook", {
			sessionId: NonEmptyString,
		}),
		success: AutoSettleOutlookSchema,
		error: WsRpcError,
	},
);

export const SetSessionArchived = Rpc.make("SetSessionArchived", {
	payload: Schema.TaggedStruct("SetSessionArchived", {
		sessionId: NonEmptyString,
		archived: Schema.Boolean,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

/** Replies with the outlook after the change. */
export const SetSessionAutoSettle = Rpc.make("SetSessionAutoSettle", {
	payload: Schema.TaggedStruct("SetSessionAutoSettle", {
		sessionId: NonEmptyString,
		disabled: Schema.Boolean,
		originId: Schema.optional(NonEmptyString),
	}),
	success: AutoSettleOutlookSchema,
	error: WsRpcError,
});

export const SnoozeSession = Rpc.make("SnoozeSession", {
	payload: Schema.TaggedStruct("SnoozeSession", {
		sessionId: NonEmptyString,
		until: Schema.NullOr(Schema.Number),
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const DismissCutOff = Rpc.make("DismissCutOff", {
	payload: Schema.TaggedStruct("DismissCutOff", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

const ContinueSessionWire = Rpc.make("ContinueSession", {
	payload: Schema.TaggedStruct("ContinueSession", {
		sessionId: NonEmptyString,
		instanceId: NonEmptyString,
		expectedInstanceId: NonEmptyString,
		/** Unix seconds. */
		at: Schema.optional(Schema.Number.pipe(Schema.check(Schema.isFinite()))),
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: Schema.Union([WsRpcError, ContinuationErrorSchema]),
});

export const ContinueSession = Rpc.make(ContinueSessionWire._tag, {
	payload: ContinueSessionWire.payloadSchema.pipe(
		Schema.decodeTo(
			Schema.Struct({
				...ContinueSessionWire.payloadSchema.fields,
				accountRef: Schema.optional(Schema.suspend(() => AccountRefSchema)),
			}),
			{
				decode: SchemaGetter.transformEffect((wire) =>
					Effect.succeed({
						...wire,
						accountRef: { _tag: "Id" as const, id: wire.instanceId },
					}),
				),
				encode: SchemaGetter.transformEffect(({ accountRef, ...wire }) =>
					accountRef?._tag === "DriverDefault"
						? Effect.fail(
								new SchemaIssue.InvalidValue(
									{
										message: "ContinueSession requires an explicit account Id",
									},
									accountRef,
								),
							)
						: Effect.succeed({
								...wire,
								instanceId: accountRef?.id ?? wire.instanceId,
							}),
				),
			},
		),
	),
	success: ContinueSessionWire.successSchema,
	error: ContinueSessionWire.errorSchema,
});

export const CancelContinuation = Rpc.make("CancelContinuation", {
	payload: Schema.TaggedStruct("CancelContinuation", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export type PreviewContinuationResponse = typeof HandoffSummarySchema.Type;

const PreviewContinuationWire = Rpc.make("PreviewContinuation", {
	payload: Schema.TaggedStruct("PreviewContinuation", {
		sessionId: NonEmptyString,
		instanceId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: HandoffSummarySchema,
	error: Schema.Union([WsRpcError, ContinuationErrorSchema]),
});

export const PreviewContinuation = Rpc.make(PreviewContinuationWire._tag, {
	payload: PreviewContinuationWire.payloadSchema.pipe(
		Schema.decodeTo(
			Schema.Struct({
				...PreviewContinuationWire.payloadSchema.fields,
				accountRef: Schema.optional(Schema.suspend(() => AccountRefSchema)),
			}),
			{
				decode: SchemaGetter.transformEffect((wire) =>
					Effect.succeed({
						...wire,
						accountRef: { _tag: "Id" as const, id: wire.instanceId },
					}),
				),
				encode: SchemaGetter.transformEffect(({ accountRef, ...wire }) =>
					accountRef?._tag === "DriverDefault"
						? Effect.fail(
								new SchemaIssue.InvalidValue(
									{
										message:
											"PreviewContinuation requires an explicit account Id",
									},
									accountRef,
								),
							)
						: Effect.succeed({
								...wire,
								instanceId: accountRef?.id ?? wire.instanceId,
							}),
				),
			},
		),
	),
	success: PreviewContinuationWire.successSchema,
	error: PreviewContinuationWire.errorSchema,
});

export const QuotaForAccountsResponseSchema = Schema.Array(UsageReadingSchema);
export type QuotaForAccountsResponse =
	typeof QuotaForAccountsResponseSchema.Type;

export const QuotaForAccounts = Rpc.make("QuotaForAccounts", {
	payload: Schema.TaggedStruct("QuotaForAccounts", {
		projectSlug: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: QuotaForAccountsResponseSchema,
	error: WsRpcError,
});

export const ContinuationHandoffResponseSchema = Schema.Struct({
	handoff: Schema.NullOr(
		Schema.Struct({
			...HandoffSummarySchema.fields,
			eventId: NonEmptyString,
			instanceId: NonEmptyString,
			at: Schema.Number,
		}),
	),
});
export type ContinuationHandoffResponse =
	typeof ContinuationHandoffResponseSchema.Type;

/** Link the first completed handoff to a durable resumes entry, including reload. */
export const GetContinuationHandoff = Rpc.make("GetContinuationHandoff", {
	payload: Schema.TaggedStruct("GetContinuationHandoff", {
		sessionId: NonEmptyString,
		instanceId: NonEmptyString,
		at: Schema.Number,
		originId: Schema.optional(NonEmptyString),
	}),
	success: ContinuationHandoffResponseSchema,
	error: WsRpcError,
});

export const UnsnoozeSession = Rpc.make("UnsnoozeSession", {
	payload: Schema.TaggedStruct("UnsnoozeSession", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SwitchVariant = Rpc.make("SwitchVariant", {
	payload: Schema.TaggedStruct("SwitchVariant", {
		sessionId: NonEmptyString,
		variant: Schema.String,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SwitchVariantResponseSchema,
	error: WsRpcError,
});

export const SwitchPermissionMode = Rpc.make("SwitchPermissionMode", {
	payload: Schema.TaggedStruct("SwitchPermissionMode", {
		sessionId: NonEmptyString,
		mode: SessionPermissionModeSchema,
		originId: Schema.optional(NonEmptyString),
	}),
	success: SwitchPermissionModeResponseSchema,
	error: WsRpcError,
});

export const GetFileTree = Rpc.make("GetFileTree", {
	payload: Schema.TaggedStruct("GetFileTree", {
		projectSlug: NonEmptyString,
	}),
	success: GetFileTreeResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetFileTree; its owner supplies the project. */
export const GetFileTreeForSession = Rpc.make(GetFileTree._tag, {
	payload: Schema.TaggedStruct(GetFileTree._tag, { sessionId: NonEmptyString }),
	success: GetFileTree.successSchema,
	error: GetFileTree.errorSchema,
});

export const GetFileList = Rpc.make("GetFileList", {
	payload: Schema.TaggedStruct("GetFileList", {
		projectSlug: NonEmptyString,

		root: Schema.optional(NonEmptyString),
		path: Schema.optional(Schema.String),
	}),
	success: GetFileListResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetFileList; its owner supplies the project. */
export const GetFileListForSession = Rpc.make(GetFileList._tag, {
	payload: Schema.TaggedStruct(GetFileList._tag, {
		sessionId: NonEmptyString,
		root: Schema.optional(NonEmptyString),
		path: Schema.optional(Schema.String),
	}),
	success: GetFileList.successSchema,
	error: GetFileList.errorSchema,
});

export const GetFileContent = Rpc.make("GetFileContent", {
	payload: Schema.TaggedStruct("GetFileContent", {
		projectSlug: NonEmptyString,

		root: Schema.optional(NonEmptyString),
		path: NonEmptyString,
	}),
	success: GetFileContentResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetFileContent; its owner supplies the project. */
export const GetFileContentForSession = Rpc.make(GetFileContent._tag, {
	payload: Schema.TaggedStruct(GetFileContent._tag, {
		sessionId: NonEmptyString,
		root: Schema.optional(NonEmptyString),
		path: NonEmptyString,
	}),
	success: GetFileContent.successSchema,
	error: GetFileContent.errorSchema,
});

export const GetToolDetails = Rpc.make("GetToolDetails", {
	payload: Schema.TaggedStruct("GetToolDetails", {
		sessionId: NonEmptyString,
		toolIds: Schema.NonEmptyArray(ToolCallId),
	}),
	success: GetToolDetailsResponseSchema,
	error: WsRpcError,
});

export const GetSkillContent = Rpc.make("GetSkillContent", {
	payload: Schema.TaggedStruct("GetSkillContent", {
		projectSlug: NonEmptyString,
		name: NonEmptyString,
	}),
	success: GetSkillContentResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetSkillContent; its owner supplies the project. */
export const GetSkillContentForSession = Rpc.make(GetSkillContent._tag, {
	payload: Schema.TaggedStruct(GetSkillContent._tag, {
		name: NonEmptyString,
		sessionId: NonEmptyString,
	}),
	success: GetSkillContent.successSchema,
	error: GetSkillContent.errorSchema,
});

export const GetSessionSkills = Rpc.make("GetSessionSkills", {
	payload: Schema.TaggedStruct("GetSessionSkills", {
		sessionId: NonEmptyString,
	}),
	success: GetSessionSkillsResponseSchema,
	error: WsRpcError,
});

export const GetModels = Rpc.make("GetModels", {
	payload: Schema.TaggedStruct("GetModels", {
		projectSlug: NonEmptyString,

		instanceId: Schema.optional(Schema.String),
	}),
	success: GetModelsResponseSchema,
	error: WsRpcError,
});

/** Session-scoped form of GetModels; its owner supplies the project. */
export const GetModelsForSession = Rpc.make(GetModels._tag, {
	payload: Schema.TaggedStruct(GetModels._tag, {
		sessionId: NonEmptyString,
		instanceId: Schema.optional(Schema.String),
	}),
	success: GetModels.successSchema,
	error: GetModels.errorSchema,
});

export const ListDaemonSessions = Rpc.make("ListDaemonSessions", {
	payload: Schema.TaggedStruct("ListDaemonSessions", {
		projectSlug: Schema.optional(NonEmptyString),
		limit: Schema.optional(Schema.Number),
		roots: Schema.optional(Schema.Boolean),
		search: Schema.optional(Schema.String),
		includeArchived: Schema.optional(Schema.Boolean),
		cursor: Schema.optional(DaemonSessionCursorSchema),
		// A registered project slug.
		scope: Schema.optional(NonEmptyString),
		exclude: Schema.optional(NonEmptyString),
	}),
	success: ListDaemonSessionsResponseSchema,
	error: WsRpcError,
});

export const ListArchivedSessions = Rpc.make("ListArchivedSessions", {
	payload: Schema.TaggedStruct("ListArchivedSessions", {
		limit: Schema.optional(Schema.Number),
		cursor: Schema.optional(ArchivedSessionCursorSchema),
	}),
	success: ListArchivedSessionsResponseSchema,
	error: WsRpcError,
});

const draftSessionPayload = {
	projectSlug: NonEmptyString,
	originId: NonEmptyString,
	instanceId: Schema.optional(Schema.String.pipe(Schema.brand("AccountId"))),
	providerId: Schema.optional(Schema.String),
	worktreePath: Schema.optional(NonEmptyString),
	worktreeBase: Schema.optional(NonEmptyString),
	permissionMode: SessionPermissionModeSchema,
	model: Schema.optional(
		Schema.Struct({
			modelId: Schema.String,
			providerId: Schema.String,
			variant: Schema.optional(Schema.String),
			contextWindow: Schema.optional(Schema.String),
		}),
	),
};

const CreateSessionWire = Rpc.make("CreateSession", {
	payload: Schema.TaggedStruct("CreateSession", {
		...draftSessionPayload,
		draftId: Schema.optional(NonEmptyString),
		draftText: Schema.optional(Schema.String),
		title: Schema.optional(Schema.String),
		newWorktree: Schema.optional(Schema.Boolean),
	}),
	success: CreateSessionResponseSchema,
	error: Schema.Union([
		WsRpcError,
		DraftAlreadySent,
		Schema.suspend(() => AccountUnroutable),
		WorkspaceMoveError,
		WorktreeCreationError,
	]),
});

export const CreateSession = Rpc.make(CreateSessionWire._tag, {
	payload: CreateSessionWire.payloadSchema.pipe(
		Schema.decodeTo(
			Schema.Struct({
				...CreateSessionWire.payloadSchema.fields,
				instanceId: Schema.toType(
					CreateSessionWire.payloadSchema.fields.instanceId,
				),
				accountRef: Schema.optional(Schema.suspend(() => AccountRefSchema)),
			}),
			{
				decode: SchemaGetter.transformEffect((wire) =>
					Effect.succeed({
						...wire,
						accountRef: accountRefFromSelection({
							instanceId: wire.instanceId,
							providerId: wire.providerId,
							model:
								wire.model === undefined
									? undefined
									: { providerID: wire.model.providerId },
						}),
					}),
				),
				encode: SchemaGetter.transformEffect(
					({
						accountRef,
						...wire
					}): Effect.Effect<typeof CreateSessionWire.payloadSchema.Type> => {
						if (accountRef?._tag === "DriverDefault") {
							const { instanceId: _instanceId, ...payload } = wire;
							return Effect.succeed({
								...payload,
								providerId: accountRef.driver,
							});
						}
						return Effect.succeed({
							...wire,
							...(accountRef?._tag === "Id"
								? { instanceId: AccountIdSchema.make(accountRef.id) }
								: {}),
						});
					},
				),
			},
		),
	),
	success: CreateSessionWire.successSchema,
	error: CreateSessionWire.errorSchema,
});

export const ViewSession = Rpc.make("ViewSession", {
	payload: Schema.TaggedStruct("ViewSession", {
		sessionId: NonEmptyString,
		originId: NonEmptyString,
	}),
	success: ViewSessionResponseSchema,
	error: WsRpcError,
});

export const PreWarmSession = Rpc.make("PreWarmSession", {
	payload: Schema.TaggedStruct("PreWarmSession", {
		sessionId: NonEmptyString,
	}),
	success: Schema.Void,
	error: WsRpcError,
});

export const PreWarmDraft = Rpc.make("PreWarmDraft", {
	payload: Schema.TaggedStruct("PreWarmDraft", {
		...draftSessionPayload,
		draftId: NonEmptyString,
	}),
	success: Schema.Void,
	error: WsRpcError,
});

export const AttachProject = Rpc.make("AttachProject", {
	payload: Schema.TaggedStruct("AttachProject", {
		// Omission attaches the daemon's default project.

		projectSlug: Schema.optional(NonEmptyString),
		originId: NonEmptyString,
	}),
	success: Schema.Struct({
		projectSlug: Schema.NullOr(Schema.String),
		// Project-only attaches have no session location.
		sessionSlug: Schema.NullOr(Schema.String),
	}),
	error: WsRpcError,
});

/** Session-scoped form of AttachProject; its owner supplies the project. */
export const AttachProjectForSession = Rpc.make(AttachProject._tag, {
	payload: Schema.TaggedStruct(AttachProject._tag, {
		sessionId: NonEmptyString,
		originId: NonEmptyString,
	}),
	success: AttachProject.successSchema,
	error: AttachProject.errorSchema,
});

export const DeleteSession = Rpc.make("DeleteSession", {
	payload: Schema.TaggedStruct("DeleteSession", {
		sessionId: NonEmptyString,
		originId: Schema.optional(NonEmptyString),
		removeWorktrees: Schema.optional(Schema.Boolean),
	}),
	success: Schema.Struct({
		ok: Schema.Literal(true),
		worktreeWarnings: Schema.optional(Schema.Array(Schema.String)),
	}),
	error: WsRpcError,
});

export const ForkSession = Rpc.make("ForkSession", {
	payload: Schema.TaggedStruct("ForkSession", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
		/** Destination account; defaults to the parent's account. */
		instanceId: Schema.optional(NonEmptyString),

		messageId: Schema.optional(NonEmptyString),
	}),
	success: ForkSessionResponseSchema,
	error: Schema.Union([WsRpcError, Schema.suspend(() => AccountUnroutable)]),
});

/** Session-scoped form of ForkSession; its owner supplies the project. */
export const ForkSessionForSession = Rpc.make(ForkSession._tag, {
	payload: Schema.TaggedStruct(ForkSession._tag, {
		originId: NonEmptyString,
		sessionId: NonEmptyString,
		/** Destination account; defaults to the parent's account. */
		instanceId: Schema.optional(NonEmptyString),
		messageId: Schema.optional(NonEmptyString),
	}),
	success: ForkSession.successSchema,
	error: ForkSession.errorSchema,
});

/** Fork a Side Thread and submit its first input there, so a reply lost to a
 *  dropped socket cannot lose the prompt. A retry with the same input id
 *  returns the Side Thread that input already reached. */
export const StartSideThread = Rpc.make("StartSideThread", {
	payload: Schema.TaggedStruct("StartSideThread", {
		sessionId: NonEmptyString,
		title: NonEmptyString,
		inputId: NonEmptyString,
		text: NonEmptyString,
		images: Schema.optional(Schema.Array(Schema.String)),
		originId: Schema.optional(NonEmptyString),
	}),
	success: Schema.Struct({ sessionId: Schema.String }),
	error: Schema.Union([WsRpcError, Schema.suspend(() => AccountUnroutable)]),
});

export const RespondPermission = Rpc.make("RespondPermission", {
	payload: Schema.TaggedStruct("RespondPermission", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
		commandId: NonEmptyString,
		requestId: NonEmptyString,
		decision: PermissionDecisionSchema,
		persistScope: Schema.optional(PermissionPersistScopeSchema),
		persistPattern: Schema.optional(Schema.String),
		permissionDestination: Schema.optional(PermissionUpdateDestinationSchema),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const AnswerQuestion = Rpc.make("AnswerQuestion", {
	payload: Schema.TaggedStruct("AnswerQuestion", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
		commandId: NonEmptyString,
		toolId: NonEmptyString,
		answers: Schema.Record(Schema.String, Schema.String),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const RejectQuestion = Rpc.make("RejectQuestion", {
	payload: Schema.TaggedStruct("RejectQuestion", {
		projectSlug: NonEmptyString,
		originId: NonEmptyString,
		commandId: NonEmptyString,
		toolId: NonEmptyString,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const LoadMoreHistory = Rpc.make("LoadMoreHistory", {
	payload: Schema.TaggedStruct("LoadMoreHistory", {
		sessionId: NonEmptyString,
		before: Schema.optional(NonEmptyString),
	}),
	success: LoadMoreHistoryResponseSchema,
	error: WsRpcError,
});

export const RewindSessionResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	sessionId: NonEmptyString,
	messageId: NonEmptyString,
});

export type RewindSessionResponse = typeof RewindSessionResponseSchema.Type;

export const RewindSession = Rpc.make("RewindSession", {
	payload: Schema.TaggedStruct("RewindSession", {
		sessionId: NonEmptyString,
		messageId: NonEmptyString,
	}),
	success: RewindSessionResponseSchema,
	error: WsRpcError,
});

export const UndoRewindResponseSchema = Schema.Struct({
	ok: Schema.Literal(true),
	sessionId: NonEmptyString,
});
export type UndoRewindResponse = typeof UndoRewindResponseSchema.Type;

export const UndoRewind = Rpc.make("UndoRewind", {
	payload: Schema.TaggedStruct("UndoRewind", {
		sessionId: NonEmptyString,
	}),
	success: UndoRewindResponseSchema,
	error: WsRpcError,
});

/** The composer's only send. The inbox hands it off when the session is idle
 *  and queues it otherwise, or with delivery "steer" hands it into the running
 *  turn; a refused steer admits nothing. A retry with the same input id is a
 *  no-op. */
export const SubmitInput = Rpc.make("input.submit", {
	payload: Schema.TaggedStruct("input.submit", {
		sessionId: NonEmptyString,
		inputId: NonEmptyString,
		text: Schema.String,
		images: Schema.optional(Schema.Array(Schema.String)),
		delivery: Schema.Literals([...INPUT_DELIVERIES]),
		originId: Schema.optional(NonEmptyString),
	}),
	success: SubmitInputResponseSchema,
	error: Schema.Union([WsRpcError, Schema.suspend(() => AccountUnroutable)]),
});

/** Remove a queued input (the tray's Remove, and Edit before refilling). */
export const CancelInput = Rpc.make("input.cancel", {
	payload: Schema.TaggedStruct("input.cancel", {
		sessionId: NonEmptyString,
		inputId: NonEmptyString,
	}),
	success: InboxCommandResponseSchema,
	error: WsRpcError,
});

/** Hand a queued input off now; interrupt starts a new turn instead of steering.
 *  Resume calls it on the oldest row without interrupt. */
export const SendInputNow = Rpc.make("input.sendNow", {
	payload: Schema.TaggedStruct("input.sendNow", {
		sessionId: NonEmptyString,
		inputId: NonEmptyString,
		interrupt: Schema.optional(Schema.Boolean),
		originId: Schema.optional(NonEmptyString),
	}),
	success: InboxCommandResponseSchema,
	error: WsRpcError,
});

export const InputDraftKeySchema = Schema.Union([
	Schema.Struct({ session: NonEmptyString }),
	Schema.Struct({ draft: NonEmptyString }),
]);
export type InputDraftKey = typeof InputDraftKeySchema.Type;

export const SyncInputDraft = Rpc.make("SyncInputDraft", {
	payload: Schema.TaggedStruct("SyncInputDraft", {
		key: InputDraftKeySchema,
		text: Schema.String,
		projectSlug: Schema.optional(NonEmptyString),
		originId: Schema.optional(NonEmptyString),
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const CancelSession = Rpc.make("CancelSession", {
	payload: Schema.TaggedStruct("CancelSession", {
		sessionId: NonEmptyString,
		commandId: NonEmptyString,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const StopBackgroundTask = Rpc.make("StopBackgroundTask", {
	payload: Schema.TaggedStruct("StopBackgroundTask", {
		sessionId: NonEmptyString,
		taskId: NonEmptyString,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const SetLogLevel = Rpc.make("SetLogLevel", {
	payload: Schema.TaggedStruct("SetLogLevel", {
		projectSlug: Schema.optional(NonEmptyString),
		level: RpcLogLevelSchema,
	}),
	success: OkResponseSchema,
	error: WsRpcError,
});

export const ResolveSession = Rpc.make("ResolveSession", {
	payload: Schema.TaggedStruct("ResolveSession", {
		sessionId: NonEmptyString,
	}),
	success: Schema.Struct({ projectSlug: Schema.NullOr(Schema.String) }),
	error: WsRpcError,
});

/** A short model-written account of where the goal stands, written only when the goal sheet opens. */
export const GoalSummarySchema = Schema.Struct({
	text: Schema.Trimmed.check(Schema.isNonEmpty()),
	generatedAt: Schema.Number,
	/** True when the goal changed since this was written: a new blocker, a progress check, or a pause, resume or finish. More checks on the same blocker never make it stale. */
	stale: Schema.Boolean,
});
export type GoalSummary = typeof GoalSummarySchema.Type;

export const GoalDetailsSchema = Schema.Struct({
	/** The cached summary, or null when none has been written for this goal yet. Never generated by this request. */
	summary: Schema.optional(Schema.NullOr(GoalSummarySchema)),
	/** False when goal summaries are switched off; the sheet then shows the latest check's reason instead. */
	summaryEnabled: Schema.optional(Schema.Boolean),
	judgeModel: Schema.optional(
		Schema.NullOr(Schema.Trimmed.check(Schema.isNonEmpty())),
	),
	setAt: Schema.optional(Schema.NullOr(Schema.Number)),
	metAt: Schema.optional(Schema.NullOr(Schema.Number)),
	turnCount: Schema.optional(
		Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
	),
	checks: Schema.Array(
		Schema.Struct({
			iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
			/** One-based session turn index, independent of the check iteration. */
			turnIndex: Schema.optional(
				Schema.NullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
			),
			judgeModel: Schema.optional(
				Schema.NullOr(Schema.Trimmed.check(Schema.isNonEmpty())),
			),
			at: Schema.Number,
			reason: Schema.NullOr(Schema.String),
		}),
	),
	tokensSinceStart: Schema.NullOr(Schema.Number),
});
export type GoalDetails = typeof GoalDetailsSchema.Type;

export const GetGoalDetails = Rpc.make("GetGoalDetails", {
	payload: Schema.TaggedStruct("GetGoalDetails", {
		sessionId: NonEmptyString,
	}),
	success: GoalDetailsSchema,
	error: WsRpcError,
});

/** Writes a fresh summary for the session's current goal, or returns the cached one when nothing changed since it was written. */
export const GenerateGoalSummary = Rpc.make("GenerateGoalSummary", {
	payload: Schema.TaggedStruct("GenerateGoalSummary", {
		sessionId: NonEmptyString,
	}),
	success: GoalSummarySchema,
	error: WsRpcError,
});

// Paired forms let callers omit the tag, but the wire always carries it so
// every encoded request still decodes as WsRpcRequest.
const wireTag = <Tag extends string>(tag: Tag) =>
	Schema.Literal(tag).pipe(
		Schema.decodeTo(Schema.optionalKey(Schema.Literal(tag)), {
			decode: SchemaGetter.passthrough(),
			encode: SchemaGetter.withDefault(Effect.succeed(tag)),
		}),
	);

// Preserve excess keys until the check, then expose only the declared fields.
const closedPayload = <const Fields extends Schema.Struct.Fields>(
	fields: Fields,
) => {
	const schema = Schema.Struct(fields);
	const closed = Schema.StructWithRest(schema, [
		Schema.Record(Schema.Union([Schema.String, Schema.Symbol]), Schema.Unknown),
	]).check(
		Schema.makeFilter(
			(value) =>
				Reflect.ownKeys(value).every((key) => Object.hasOwn(fields, key)),
			{ message: "Unexpected property" },
		),
	);
	// Validate encoding input without stripping its excess keys before the check.
	return closed.pipe(
		Schema.decodeTo(
			Schema.declare<Schema.Struct.Type<Fields>>(
				(value): value is Schema.Struct.Type<Fields> =>
					Schema.is(closed)(value),
			),
		),
	);
};

// One registration per RPC tag, shared by CLI/IPC decoding and browser RPC.
// Paired forms share one wire tag while keeping their request definitions.
const wsRpcRequests = [
	ListRecaps,
	GenerateRecap,
	ExplainAsk,
	GetMessageSurfacing,
	UpdateMessageSurfacing,
	GetStatus,
	SetPin,
	SetKeepAwake,
	SetKeepAwakeCommand,
	SetTailscaleServe,
	Shutdown,
	SetAgent,
	RestartWithConfig,
	GetInstances,
	GetCursorAuth,
	StartCursorLogin,
	CancelCursorLogin,
	LogoutCursor,
	GetCodexAuth,
	StartCodexLogin,
	CancelCodexLogin,
	LogoutCodex,
	GetInstanceStatus,
	{
		requests: [AttachProjectForSession, AttachProject],
		rpc: Rpc.make(AttachProject._tag, {
			payload: Schema.Union([
				closedPayload({
					...AttachProjectForSession.payloadSchema.fields,
					_tag: wireTag(AttachProjectForSession._tag),
				}),
				closedPayload({
					...AttachProject.payloadSchema.fields,
					_tag: wireTag(AttachProject._tag),
				}),
			]),
			success: AttachProject.successSchema,
			error: AttachProject.errorSchema,
		}),
	},
	ResolveSession,
	GetGoalDetails,
	GenerateGoalSummary,
	{
		requests: [GetAgentsForSession, GetAgents],
		rpc: Rpc.make(GetAgents._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetAgentsForSession.payloadSchema.fields,
					_tag: wireTag(GetAgentsForSession._tag),
				}),
				closedPayload({
					...GetAgents.payloadSchema.fields,
					_tag: wireTag(GetAgents._tag),
				}),
			]),
			success: GetAgents.successSchema,
			error: GetAgents.errorSchema,
		}),
	},
	{
		requests: [GetCommandsForSession, GetCommands],
		rpc: Rpc.make(GetCommands._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetCommandsForSession.payloadSchema.fields,
					_tag: wireTag(GetCommandsForSession._tag),
				}),
				closedPayload({
					...GetCommands.payloadSchema.fields,
					_tag: wireTag(GetCommands._tag),
				}),
			]),
			success: GetCommands.successSchema,
			error: GetCommands.errorSchema,
		}),
	},
	GetProjects,
	FindFolders,
	SwitchAgent,
	SwitchContextWindow,
	SwitchModel,
	SetDefaultModel,
	SetHarnessDefault,
	GetTitleGeneration,
	SetTitleGeneration,
	SetDefaultPermissionMode,
	SetDefaultSessionMode,
	ResolveSessionMode,
	SetTerminalKeys,
	GetTerminalKeys,
	GetCategorySet,
	SetSurfacingMark,
	GetSurfacingFeedback,
	GetSurfacingLedger,
	ScoreCategorySet,
	ProposeCategoryTuning,
	ReplaceCategorySet,
	SetHiddenEntries,
	GetClaudeSettings,
	SetClaudeSettings,
	{
		requests: [ResolveClaudeSettingsForSession, ResolveClaudeSettings],
		rpc: Rpc.make(ResolveClaudeSettings._tag, {
			payload: Schema.Union([
				closedPayload({
					...ResolveClaudeSettingsForSession.payloadSchema.fields,
					_tag: wireTag(ResolveClaudeSettingsForSession._tag),
				}),
				closedPayload({
					...ResolveClaudeSettingsWire.payloadSchema.fields,
					_tag: wireTag(ResolveClaudeSettingsWire._tag),
				}).pipe(
					Schema.decodeTo(
						closedPayload({
							...ResolveClaudeSettings.payloadSchema.to.fields,
							accountRef: Schema.optional(
								Schema.Union([
									closedPayload(AccountRefSchema.members[0].fields),
									closedPayload(AccountRefSchema.members[1].fields),
								]),
							),
							_tag: Schema.optionalKey(
								Schema.Literal(ResolveClaudeSettings._tag),
							),
						}),
						{
							decode: SchemaGetter.transformEffect((wire) =>
								Effect.succeed({
									...wire,
									accountRef: { _tag: "Id" as const, id: wire.instanceId },
								}),
							),
							encode: SchemaGetter.transformEffect(({ accountRef, ...wire }) =>
								accountRef?._tag === "DriverDefault"
									? Effect.fail(
											new SchemaIssue.InvalidValue(
												{
													message:
														"ResolveClaudeSettings requires an explicit account Id",
												},
												accountRef,
											),
										)
									: Effect.succeed({
											...wire,
											instanceId: accountRef?.id ?? wire.instanceId,
										}),
							),
						},
					),
				),
			]),
			success: ResolveClaudeSettings.successSchema,
			error: ResolveClaudeSettings.errorSchema,
		}),
	},
	ReloadProviderSession,
	RenameSession,
	ListBranches,
	{
		requests: [ListWorktreesForSession, ListWorktrees],
		rpc: Rpc.make(ListWorktrees._tag, {
			payload: Schema.Union([
				closedPayload({
					...ListWorktreesForSession.payloadSchema.fields,
					_tag: wireTag(ListWorktreesForSession._tag),
				}),
				closedPayload({
					...ListWorktrees.payloadSchema.fields,
					_tag: wireTag(ListWorktrees._tag),
				}),
			]),
			success: ListWorktrees.successSchema,
			error: ListWorktrees.errorSchema,
		}),
	},
	InspectSessionWorktrees,
	RenameSessionBranch,
	MoveSessionWorkspace,
	RecreateSessionWorktree,
	ContinueSessionInMainFolder,
	DismissWorkspaceHint,
	OpenCodeUseWorktree,
	MarkSessionUnread,
	MarkSessionRead,
	SetMessagesRead,
	MarkSessionSeen,
	SetSessionSettled,
	SetSessionArchived,
	SetSessionPinned,
	SetSessionAutoSettle,
	GetSessionAutoSettleOutlook,
	SnoozeSession,
	UnsnoozeSession,
	DismissCutOff,
	ContinueSession,
	CancelContinuation,
	PreviewContinuation,
	QuotaForAccounts,
	GetContinuationHandoff,
	SwitchVariant,
	SwitchPermissionMode,
	{
		requests: [GetFileTreeForSession, GetFileTree],
		rpc: Rpc.make(GetFileTree._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetFileTreeForSession.payloadSchema.fields,
					_tag: wireTag(GetFileTreeForSession._tag),
				}),
				closedPayload({
					...GetFileTree.payloadSchema.fields,
					_tag: wireTag(GetFileTree._tag),
				}),
			]),
			success: GetFileTree.successSchema,
			error: GetFileTree.errorSchema,
		}),
	},
	{
		requests: [GetFileListForSession, GetFileList],
		rpc: Rpc.make(GetFileList._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetFileListForSession.payloadSchema.fields,
					_tag: wireTag(GetFileListForSession._tag),
				}),
				closedPayload({
					...GetFileList.payloadSchema.fields,
					_tag: wireTag(GetFileList._tag),
				}),
			]),
			success: GetFileList.successSchema,
			error: GetFileList.errorSchema,
		}),
	},
	{
		requests: [GetFileContentForSession, GetFileContent],
		rpc: Rpc.make(GetFileContent._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetFileContentForSession.payloadSchema.fields,
					_tag: wireTag(GetFileContentForSession._tag),
				}),
				closedPayload({
					...GetFileContent.payloadSchema.fields,
					_tag: wireTag(GetFileContent._tag),
				}),
			]),
			success: GetFileContent.successSchema,
			error: GetFileContent.errorSchema,
		}),
	},
	GetToolDetails,
	{
		requests: [GetSkillContentForSession, GetSkillContent],
		rpc: Rpc.make(GetSkillContent._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetSkillContentForSession.payloadSchema.fields,
					_tag: wireTag(GetSkillContentForSession._tag),
				}),
				closedPayload({
					...GetSkillContent.payloadSchema.fields,
					_tag: wireTag(GetSkillContent._tag),
				}),
			]),
			success: GetSkillContent.successSchema,
			error: GetSkillContent.errorSchema,
		}),
	},
	GetSessionSkills,
	{
		requests: [GetModelsForSession, GetModels],
		rpc: Rpc.make(GetModels._tag, {
			payload: Schema.Union([
				closedPayload({
					...GetModelsForSession.payloadSchema.fields,
					_tag: wireTag(GetModelsForSession._tag),
				}),
				closedPayload({
					...GetModels.payloadSchema.fields,
					_tag: wireTag(GetModels._tag),
				}),
			]),
			success: GetModels.successSchema,
			error: GetModels.errorSchema,
		}),
	},
	SaveProject,
	SetProjectOrder,
	RemoveProject,
	StartInstance,
	StopInstance,
	RemoveInstance,
	RenameInstance,
	AddInstance,
	UpdateInstance,
	SetDefault,
	GetAutoSettleSetting,
	SetAutoSettleSetting,
	GetAvatar,
	SetAvatar,
	GetAutoArchiveSetting,
	SetAutoArchiveSetting,
	GetAutoDeleteArchivedSetting,
	SetAutoDeleteArchivedSetting,
	GetWorktreeCleanupSetting,
	{
		requests: [SetProjectWorktreeCleanupSetting, SetWorktreeCleanupSetting],
		rpc: Rpc.make(SetWorktreeCleanupSetting._tag, {
			payload: Schema.Union([
				closedPayload({
					...SetProjectWorktreeCleanupSetting.payloadSchema.fields,
					_tag: wireTag(SetProjectWorktreeCleanupSetting._tag),
				}),
				closedPayload({
					...SetWorktreeCleanupSetting.payloadSchema.fields,
					_tag: wireTag(SetWorktreeCleanupSetting._tag),
				}),
			]),
			success: SetWorktreeCleanupSetting.successSchema,
			error: SetWorktreeCleanupSetting.errorSchema,
		}),
	},
	CleanUpWorktreesNow,
	GetUsageLimitsSetting,
	SetUsageLimitsSetting,
	SetCursorUsageKeychain,
	ScanNow,
	DetectProxy,
	ListPtys,
	{
		requests: [CreatePtyForSession, CreatePty],
		rpc: Rpc.make(CreatePty._tag, {
			payload: Schema.Union([
				closedPayload({
					...CreatePtyForSession.payloadSchema.fields,
					_tag: wireTag(CreatePtyForSession._tag),
				}),
				closedPayload({
					...CreatePty.payloadSchema.fields,
					_tag: wireTag(CreatePty._tag),
				}),
			]),
			success: CreatePty.successSchema,
			error: CreatePty.errorSchema,
		}),
	},
	ResizePty,
	ClosePty,
	PtyInput,
	ListDaemonSessions,
	ListArchivedSessions,
	CreateSession,
	ViewSession,
	PreWarmSession,
	PreWarmDraft,
	DeleteSession,
	{
		requests: [ForkSessionForSession, ForkSession],
		rpc: Rpc.make(ForkSession._tag, {
			payload: Schema.Union([
				closedPayload({
					...ForkSessionForSession.payloadSchema.fields,
					_tag: wireTag(ForkSessionForSession._tag),
				}),
				closedPayload({
					...ForkSession.payloadSchema.fields,
					_tag: wireTag(ForkSession._tag),
				}),
			]),
			success: ForkSession.successSchema,
			error: ForkSession.errorSchema,
		}),
	},
	StartSideThread,
	RespondPermission,
	AnswerQuestion,
	RejectQuestion,
	LoadMoreHistory,
	RewindSession,
	UndoRewind,
	SubmitInput,
	CancelInput,
	SendInputNow,
	SyncInputDraft,
	CancelSession,
	StopBackgroundTask,
	SetLogLevel,
] as const;

type WsRpcRequestEntry = (typeof wsRpcRequests)[number];
type WsRpcRequestSchema<Entry = WsRpcRequestEntry> = Entry extends {
	readonly requests: readonly (infer Request)[];
}
	? Request
	: Entry;

const wsRpcRequestSchemas = wsRpcRequests.flatMap(
	(entry): readonly WsRpcRequestSchema["payloadSchema"][] =>
		"requests" in entry
			? entry.requests.map((request) => request.payloadSchema)
			: [entry.payloadSchema],
);

export const WsRpcRequest = Schema.Union([...wsRpcRequestSchemas]);

export type WsRpcRequest = typeof WsRpcRequest.Type;

export const ShellProjectsFrameSchema = Schema.Struct({
	_tag: Schema.Literal("projects"),
	projects: Schema.Array(ProjectInfoSchema),
	/** The project a new session prefills, on every client. */
	newSessionProject: Schema.optional(Schema.String),
	projectOrder: Schema.optional(Schema.Array(Schema.String)),
});
export type ShellProjectsFrame = typeof ShellProjectsFrameSchema.Type;

export const ShellEnvelopeSchema = Schema.Union([
	EnvelopeSchema(SessionInfoSchema),
	ShellProjectsFrameSchema,
]);
export type ShellEnvelope = typeof ShellEnvelopeSchema.Type;

export const SubscribeShell = Rpc.make("SubscribeShell", {
	payload: {
		resumeFromSequence: Schema.optional(Schema.Number),
		resumeBase: Schema.optional(ResumeBase),
		resumePoint: Schema.optional(ResumePoint),
	},
	success: ShellEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

export const SubscribeSessionDetail = Rpc.make("SubscribeSessionDetail", {
	payload: {
		sessionId: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
		resumeBase: Schema.optional(ResumeBase),
		// From a saved snapshot: the server resumes from this, not resumeBase.
		resumePoint: Schema.optional(ResumePoint),
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
		sessionId: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
	},
	success: SessionTodosEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/**
 * One session family: the root a session descends from and every descendant
 * (subagent and fork rows), as versioned rows (conduit-test-ni8.28). A
 * low-rate, family-scoped feed, so it rides the control socket beside the shell.
 */
export const SubscribeSessionFamily = Rpc.make("SubscribeSessionFamily", {
	payload: {
		sessionId: NonEmptyString,
		resumeFromSequence: Schema.optional(Schema.Number),
	},
	success: EnvelopeSchema(SessionInfoSchema),
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
const PtyEnvelopeSchema = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("snapshot"),
		rows: Schema.Array(PtyRowSchema),
	}),
	Schema.Struct({ _tag: Schema.Literal("synchronized") }),
	PtyUpsertSchema,
	PtyOutputSchema,
	PtyRemoveSchema,
]);
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
	success: Schema.Struct({
		instances: Schema.Array(OpenCodeInstanceSchema),
		providerCapabilities: Schema.optional(ProviderCapabilityMapSchema),
		providerTraits: Schema.optional(ProviderTraitsMapSchema),
	}),
	error: WsRpcError,
	stream: true,
});

export const SubscribeUsage = Rpc.make("SubscribeUsage", {
	payload: {},
	success: Schema.Struct({ readings: Schema.Array(UsageReadingSchema) }),
	error: WsRpcError,
	stream: true,
});

/**
 * The daemon's own facts (conduit-test-ni8.16.2), daemon-global like the
 * lists above: its protocol and build, whether a newer build is ready to
 * restart into, and a revision that moves whenever the cross-project session
 * lists went stale. One value on subscribe, then one per change.
 */
export const ServerStatusSchema = Schema.Struct({
	protocolVersion: Schema.Number,
	buildId: Schema.String,
	restartAvailable: Schema.Boolean,
	sessionsRevision: Schema.Number,
});
export type ServerStatus = typeof ServerStatusSchema.Type;

export const SubscribeServerStatus = Rpc.make("SubscribeServerStatus", {
	payload: {},
	success: ServerStatusSchema,
	error: WsRpcError,
	stream: true,
});

export const OpenCodeConnectionStatusSchema = Schema.Literals([
	"stopped",
	"starting",
	"connected",
	"reconnecting",
	"failed",
]);
export type OpenCodeConnectionStatus =
	typeof OpenCodeConnectionStatusSchema.Type;

/**
 * One project-global setting, whole. Each member owns one slot, keyed by its
 * `_tag`, so a duplicate or late delivery is idempotent and a new fact is a new
 * member rather than a reshape.
 */
export const ProjectSettingSchema = Schema.Union([
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
	Schema.TaggedStruct("defaultSessionMode", {
		mode: DefaultSessionModeSchema,
	}),
	Schema.TaggedStruct("terminalKeys", {
		terminalKeys: TerminalKeysSetting,
	}),
	Schema.TaggedStruct("titleGeneration", {
		...TitleGenerationStateSchema.fields,
	}),
	Schema.TaggedStruct("claudeSettings", {
		overrides: ClaudeSettingsOverridesSchema,
	}),
	Schema.TaggedStruct("clientCount", { count: Schema.Number }),
	Schema.TaggedStruct("opencodeConnection", {
		instanceId: Schema.String,
		status: OpenCodeConnectionStatusSchema,
	}),
	Schema.TaggedStruct("providerModels", {
		providers: Schema.Array(ProviderInfoSchema),
		accountId: Schema.optional(Schema.String),
	}),
	Schema.suspend(() =>
		Schema.TaggedStruct(
			"harnessDefaults",
			Record.map(PROVIDER_DRIVERS, () =>
				Schema.optionalKey(HarnessDefaultStateSchema),
			),
		),
	),
]);
export type ProjectSetting = typeof ProjectSettingSchema.Type;
/** Persisted settings shared by all projects; live facts stay per relay. */
export type GlobalProjectSetting = Extract<
	ProjectSetting,
	{
		readonly _tag:
			| "defaultModel"
			| "defaultPermissionMode"
			| "defaultSessionMode"
			| "terminalKeys"
			| "visibility"
			| "claudeSettings"
			| "titleGeneration";
	}
>;
/** Global writes signal each relay to compute catalog-dependent facts locally. */
export type GlobalSettingTag = GlobalProjectSetting["_tag"] | "harnessDefaults";
const ProjectSettingsEnvelopeSchema = EnvelopeSchema(ProjectSettingSchema);
export type ProjectSettingsEnvelope = typeof ProjectSettingsEnvelopeSchema.Type;

/** Settings are not in the read model: every subscribe opens with a snapshot. */
export const SubscribeProjectSettings = Rpc.make("SubscribeProjectSettings", {
	payload: { projectSlug: NonEmptyString },
	success: ProjectSettingsEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

/** Borrow OpenCode while this browser has its draft open; never binds it. */
export const SubscribeDraftModels = Rpc.make("SubscribeDraftModels", {
	payload: { projectSlug: NonEmptyString, instanceId: NonEmptyString },
	success: GetModelsResponseSchema,
	error: WsRpcError,
	stream: true,
});

/** A session finished or failed in this project while no tab was viewing it. */
export const AlertSchema = Schema.TaggedStruct("alert", {
	/** `warning`: a launch went ahead degraded; the user is told, not dinged. */
	kind: Schema.Literals(["done", "error", "warning"]),
	alertId: NonEmptyString,
	sessionId: Schema.optional(Schema.String),
	message: Schema.optional(Schema.String),
});
export type Alert = typeof AlertSchema.Type;
const AlertsEnvelopeSchema = Schema.Union([
	Schema.Struct({ _tag: Schema.Literal("synchronized") }),
	AlertSchema,
]);
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

const InputDraftEnvelopeSchema = Schema.Union([
	Schema.Struct({
		_tag: Schema.Literal("synchronized"),
		text: Schema.optional(Schema.String),
		projectId: Schema.optional(Schema.String),
		/** A durable retirement marker; promoted draft text is never replayed. */
		promotedSessionId: Schema.optional(NonEmptyString),
	}),
	Schema.TaggedStruct("draft", {
		text: Schema.String,
		projectId: Schema.optional(Schema.String),
		/** The writer's SyncInputDraft originId; that tab drops its own echo. */
		from: Schema.optional(Schema.String),
	}),
	Schema.TaggedStruct("promoted", {
		sessionId: NonEmptyString,
		text: Schema.String,
	}),
]);
export type InputDraftEnvelope = typeof InputDraftEnvelopeSchema.Type;

/**
 * Opens with the stored composer draft, then follows live changes. The browser
 * merges snapshots with local edits, including text typed while disconnected.
 */
export const SubscribeInputDraft = Rpc.make("SubscribeInputDraft", {
	payload: { key: InputDraftKeySchema },
	success: InputDraftEnvelopeSchema,
	error: WsRpcError,
	stream: true,
});

export const DraftListItemSchema = Schema.Struct({
	draftId: NonEmptyString,
	projectSlug: NonEmptyString,
	firstLine: Schema.String,
	updatedAt: Schema.Number,
});
export type DraftListItem = typeof DraftListItemSchema.Type;

/** The daemon's full non-empty draft list, initially and once per change batch. */
export const SubscribeDrafts = Rpc.make("SubscribeDrafts", {
	payload: {},
	success: Schema.Array(DraftListItemSchema),
	error: WsRpcError,
	stream: true,
});

/** Each snapshot is persisted; subscribing and reloading never invokes a model. */
export const SubscribeRecaps = Rpc.make("SubscribeRecaps", {
	payload: { sessionId: NonEmptyString, turnId: NonEmptyString },
	success: RecapSnapshotSchema,
	error: WsRpcError,
	stream: true,
});

export const WsRpcGroup = RpcGroup.make(
	SubscribeRecaps,
	SubscribeShell,
	SubscribeSessionDetail,
	SubscribeSessionTodos,
	SubscribeSessionFamily,
	SubscribePtys,
	SubscribeApprovals,
	SubscribeProjectSettings,
	SubscribeDraftModels,
	SubscribeAlerts,
	SubscribeInputDraft,
	SubscribeDrafts,
	SubscribeInstances,
	SubscribeUsage,
	SubscribeServerStatus,
	...wsRpcRequests.map((entry) => ("rpc" in entry ? entry.rpc : entry)),
);

export type WsRpcGroup = typeof WsRpcGroup;
