import { Schema } from "effect";

export class WorktreeBranchRenameError extends Schema.TaggedError<WorktreeBranchRenameError>()(
	"WorktreeBranchRenameError",
	{
		folder: Schema.String,
		reason: Schema.Literal(
			"not-owned",
			"invalid-name",
			"already-exists",
			"worktree-missing",
			"head-mismatch",
			"git-failed",
		),
		message: Schema.String,
	},
) {}

export class WorktreeCreationError extends Schema.TaggedError<WorktreeCreationError>()(
	"WorktreeCreationError",
	{
		reason: Schema.Literal(
			"branch-exists",
			"invalid-branch",
			"detached-head",
			"target-exists",
			"git-failed",
			"unsupported-project",
		),
		path: Schema.String,
		message: Schema.String,
	},
) {}

/** Filesystem availability is derived, never recorded as a workspace move. */
const WorktreeMissingFields = {
	path: Schema.String,
	branch: Schema.optional(Schema.String),
	canRecreate: Schema.Boolean,
	reason: Schema.optional(
		Schema.Literal(
			"branch-missing",
			"branch-unknown",
			"branch-in-use",
			"git-failed",
			"not-owned",
		),
	),
};
export const WorkspaceMissingSchema = Schema.Struct({
	...WorktreeMissingFields,
	/** Missing checkouts by Project Folder; absent for legacy single-folder state. */
	folders: Schema.optional(
		Schema.Array(
			Schema.Struct({
				folder: Schema.String,
				...WorktreeMissingFields,
			}),
		),
	),
});
export type WorkspaceMissing = typeof WorkspaceMissingSchema.Type;

export class MissingWorktreeError extends Schema.TaggedError<MissingWorktreeError>()(
	"MissingWorktreeError",
	{ path: Schema.String, message: Schema.String },
) {}

export class WorktreeRecoveryError extends Schema.TaggedError<WorktreeRecoveryError>()(
	"WorktreeRecoveryError",
	{
		reason: Schema.Literal(
			"branch-missing",
			"branch-unknown",
			"branch-in-use",
			"target-exists",
			"git-failed",
			"not-owned",
		),
		path: Schema.String,
		message: Schema.String,
	},
) {}
