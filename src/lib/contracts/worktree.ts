import { Schema } from "effect";

export const WorktreeCleanupSchema = Schema.Struct({
	onSettle: Schema.optionalWith(Schema.Literal("off", "merged", "any"), {
		default: () => "merged" as const,
	}),
	onDelete: Schema.optionalWith(Schema.Boolean, { default: () => false }),
	afterInactiveDays: Schema.optionalWith(
		Schema.NullOr(Schema.Number.pipe(Schema.int(), Schema.between(1, 3650))),
		{ default: () => null },
	),
	whenMerged: Schema.optionalWith(Schema.Boolean, { default: () => false }),
	noCommitsBeyondDefault: Schema.optionalWith(Schema.Boolean, {
		default: () => false,
	}),
	keepWhen: Schema.optionalWith(
		Schema.Literal("any-local-files", "uncommitted-changes", "tracked-changes"),
		{ default: () => "uncommitted-changes" as const },
	),
});
export type WorktreeCleanup = typeof WorktreeCleanupSchema.Type;

export const DEFAULT_WORKTREE_CLEANUP: WorktreeCleanup = {
	onSettle: "merged",
	onDelete: false,
	afterInactiveDays: null,
	whenMerged: false,
	noCommitsBeyondDefault: false,
	keepWhen: "uncommitted-changes",
};

const WorktreeCleanupEntrySchema = Schema.Struct({
	projectSlug: Schema.String,
	sessionId: Schema.String,
	path: Schema.String,
	reason: Schema.String,
});
export type WorktreeCleanupEntry = typeof WorktreeCleanupEntrySchema.Type;

export const WorktreeCleanupReportSchema = Schema.Struct({
	removed: Schema.Array(WorktreeCleanupEntrySchema),
	kept: Schema.Array(WorktreeCleanupEntrySchema),
	failed: Schema.Array(WorktreeCleanupEntrySchema),
});
export type WorktreeCleanupReport = typeof WorktreeCleanupReportSchema.Type;

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
