import { Schema } from "effect";

export const WorkspaceMoveCauseSchema = Schema.Literal(
	"launch",
	"agent",
	"user",
	"missing",
);
export type WorkspaceMoveCause = typeof WorkspaceMoveCauseSchema.Type;

export const SessionWorkspaceSchema = Schema.Struct({
	cause: WorkspaceMoveCauseSchema,
	worktrees: Schema.Record({ key: Schema.String, value: Schema.String }),
	origin: Schema.Literal("existing", "conduit"),
});
export type SessionWorkspace = typeof SessionWorkspaceSchema.Type;

/** Claude's native workspace and the latest unconfirmed user intent. */
export const ClaudeWorktreeStateSchema = Schema.Struct({
	entered: Schema.Boolean,
	observed: Schema.optional(Schema.String),
	pending: Schema.optional(
		Schema.Struct({
			sequence: Schema.Number,
			path: Schema.String,
			needsDirective: Schema.Boolean,
			directiveSent: Schema.Boolean,
			turnEnded: Schema.Boolean,
		}),
	),
});
export type ClaudeWorktreeState = typeof ClaudeWorktreeStateSchema.Type;

export const WorktreeInfoSchema = Schema.Struct({
	path: Schema.String,
	branch: Schema.optional(Schema.String),
	main: Schema.Boolean,
});
export type WorktreeInfo = typeof WorktreeInfoSchema.Type;

/** Immutable launch ownership. `head` is the chosen committed launch base. */
export const SessionWorktreeOwnershipSchema = Schema.Struct({
	folder: Schema.String,
	path: Schema.String,
	branchName: Schema.String,
	head: Schema.String,
});
export type SessionWorktreeOwnership =
	typeof SessionWorktreeOwnershipSchema.Type;

export const SessionWorktreeInspectionSchema = Schema.Struct({
	folder: Schema.String,
	path: Schema.String,
	reasons: Schema.Array(Schema.String),
	inUse: Schema.Boolean,
});
export type SessionWorktreeInspection =
	typeof SessionWorktreeInspectionSchema.Type;

export class WorkspaceMoveError extends Schema.TaggedError<WorkspaceMoveError>()(
	"WorkspaceMoveError",
	{
		path: Schema.String,
		reason: Schema.Literal(
			"missing",
			"not-a-worktree",
			"other-repository",
			"unsupported-provider",
		),
	},
) {}
