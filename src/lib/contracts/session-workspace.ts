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

export const WorktreeInfoSchema = Schema.Struct({
	path: Schema.String,
	branch: Schema.optional(Schema.String),
	main: Schema.Boolean,
});
export type WorktreeInfo = typeof WorktreeInfoSchema.Type;

export class WorkspaceMoveError extends Schema.TaggedError<WorkspaceMoveError>()(
	"WorkspaceMoveError",
	{
		path: Schema.String,
		reason: Schema.Literal("missing", "not-a-worktree", "other-repository"),
	},
) {}
