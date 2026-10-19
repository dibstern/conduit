import { Effect, Schema } from "effect";

export const WorktreeCleanupSchema = Schema.Struct({
	onSettle: Schema.Literals(["off", "merged", "any"]).pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => "merged" as const)),
		Schema.withConstructorDefault(Effect.sync(() => "merged" as const)),
	),
	onDelete: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => false)),
		Schema.withConstructorDefault(Effect.sync(() => false)),
	),
	afterInactiveDays: Schema.NullOr(
		Schema.Number.pipe(
			Schema.check(Schema.isInt()),
			Schema.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
		),
	).pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => null)),
		Schema.withConstructorDefault(Effect.sync(() => null)),
	),
	whenMerged: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => false)),
		Schema.withConstructorDefault(Effect.sync(() => false)),
	),
	noCommitsBeyondDefault: Schema.Boolean.pipe(
		Schema.withDecodingDefaultType(Effect.sync(() => false)),
		Schema.withConstructorDefault(Effect.sync(() => false)),
	),
	keepWhen: Schema.Literals([
		"any-local-files",
		"uncommitted-changes",
		"tracked-changes",
	]).pipe(
		Schema.withDecodingDefaultType(
			Effect.sync(() => "uncommitted-changes" as const),
		),
		Schema.withConstructorDefault(
			Effect.sync(() => "uncommitted-changes" as const),
		),
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
		reason: Schema.Literals([
			"not-owned",
			"invalid-name",
			"already-exists",
			"worktree-missing",
			"head-mismatch",
			"git-failed",
		]),
		message: Schema.String,
	},
) {}

export class WorktreeCreationError extends Schema.TaggedError<WorktreeCreationError>()(
	"WorktreeCreationError",
	{
		reason: Schema.Literals([
			"branch-exists",
			"invalid-branch",
			"detached-head",
			"target-exists",
			"git-failed",
			"unsupported-project",
		]),
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
		Schema.Literals([
			"branch-missing",
			"branch-unknown",
			"branch-in-use",
			"git-failed",
			"not-owned",
		]),
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
	{
		path: Schema.String,
		message: Schema.String,
	},
) {}

export class WorktreeRecoveryError extends Schema.TaggedError<WorktreeRecoveryError>()(
	"WorktreeRecoveryError",
	{
		reason: Schema.Literals([
			"branch-missing",
			"branch-unknown",
			"branch-in-use",
			"target-exists",
			"git-failed",
			"not-owned",
		]),
		path: Schema.String,
		message: Schema.String,
	},
) {}
