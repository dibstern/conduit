import { Schema } from "effect";

/** Which change set a Session Diff shows. */
export const SessionDiffScopeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unstaged") }),
	/** The merge-base of base and HEAD against the live working tree; null base is the launch base. */
	Schema.Struct({
		kind: Schema.Literal("branch"),
		base: Schema.NullOr(Schema.String),
	}),
	/** One finished turn's captured changes; `turnId` is the durable turns.id. */
	Schema.Struct({ kind: Schema.Literal("turn"), turnId: Schema.String }),
	/** One tool call's Tool File Changes; `toolId` is the tool part's call id. */
	Schema.Struct({ kind: Schema.Literal("toolCall"), toolId: Schema.String }),
]);
export type SessionDiffScope = typeof SessionDiffScopeSchema.Type;

/** Bytes above which a file only shows its size and links to the Files pane. */
export const SESSION_DIFF_TOO_LARGE_BYTES = 1024 * 1024;
/** Changed lines up to which a file's patch loads as it scrolls into view. */
export const SESSION_DIFF_AUTO_LINES = 500;

const bytesSchema = Schema.Number.pipe(
	Schema.check(Schema.isInt()),
	Schema.check(
		Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	),
);
/**
 * Daemon Settings: past `budgetBytes` of captures, Folder Timeline evicts
 * eligible sessions down to 90% of it; past `alertBytes` with nothing eligible
 * left, it warns.
 */
export const SnapshotBudgetSchema = Schema.Struct({
	budgetBytes: bytesSchema,
	alertBytes: bytesSchema,
});
export type SnapshotBudget = typeof SnapshotBudgetSchema.Type;
export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
	budgetBytes: 5 * 1024 ** 3,
	alertBytes: 5 * 1024 ** 3,
};

const fileFields = {
	path: Schema.String,
	oldPath: Schema.optional(Schema.String),
	status: Schema.Literals([
		"added",
		"modified",
		"deleted",
		"renamed",
		"typeChanged",
	]),
	/** Blob ids; null is the side where the file does not exist. */
	before: Schema.NullOr(Schema.String),
	after: Schema.NullOr(Schema.String),
	/** The larger side's size. */
	bytes: Schema.Number,
	/** A path that holds a Git LFS file, a submodule's commit or a symlink's target, not text. */
	kind: Schema.optional(Schema.Literals(["lfs", "submodule", "symlink"])),
	/** Git file modes, when both sides exist and they differ. */
	mode: Schema.optional(
		Schema.Struct({ before: Schema.String, after: Schema.String }),
	),
};

const { bytes: _bytes, ...prunedFields } = fileFields;

/**
 * A tooLarge file carries no line counts: git never diffs it. A pruned file's
 * content was evicted: it keeps the counts its capture recorded, if any.
 */
export const SessionDiffFileSchema = Schema.Union([
	Schema.Struct({ ...fileFields, tier: Schema.Literal("tooLarge") }),
	Schema.Struct({
		...prunedFields,
		tier: Schema.Literal("pruned"),
		insertions: Schema.optional(Schema.Number),
		deletions: Schema.optional(Schema.Number),
	}),
	Schema.Struct({
		...fileFields,
		tier: Schema.Literals(["auto", "onDemand"]),
		insertions: Schema.Number,
		deletions: Schema.Number,
		binary: Schema.Boolean,
	}),
]);
export type SessionDiffFile = typeof SessionDiffFileSchema.Type;

/** The base a branch scope compared against; fallback names the preferred base it could not use. */
export const SessionDiffBaseSchema = Schema.Struct({
	/** A ref, the launch commit, or HEAD. */
	ref: Schema.String,
	source: Schema.Literals(["override", "launch", "default", "head"]),
	fallback: Schema.optional(
		Schema.Struct({
			wanted: Schema.String,
			reason: Schema.Literals(["missing", "shallow", "unrelated"]),
		}),
	),
});
export type SessionDiffBase = typeof SessionDiffBaseSchema.Type;

/** `folder` is the Project Folder root, as in the file RPCs. */
export const SessionDiffFolderSchema = Schema.Union([
	Schema.Struct({
		folder: Schema.String,
		files: Schema.Array(SessionDiffFileSchema),
		/** Branch scope only. */
		base: Schema.optional(SessionDiffBaseSchema),
		/** Turn scope: another session ran in this folder during the turn. */
		shared: Schema.optionalKey(Schema.Literal(true)),
	}),
	Schema.Struct({
		folder: Schema.String,
		error: Schema.Literals(["unavailable", "timeout"]),
		message: Schema.String,
	}),
]);
export type SessionDiffFolder = typeof SessionDiffFolderSchema.Type;

export const SessionDiffListingSchema = Schema.Struct({
	revision: Schema.String,
	folders: Schema.Array(SessionDiffFolderSchema),
	/** Turn scope: the turn's run has no capture, so it lists no folders. */
	notCaptured: Schema.optionalKey(Schema.Literal(true)),
	/** Turn scope: the turn's run is still being captured; a new revision follows once it lands or fails. */
	pending: Schema.optionalKey(Schema.Literal(true)),
	/** Turn scope: Folder Timeline evicted the turn's content; files and counts remain. */
	pruned: Schema.optionalKey(Schema.Literal(true)),
	/** Tool-call scope: the provider reported the changes, or they were read from the tool's input. */
	source: Schema.optionalKey(Schema.Literals(["provider", "toolInput"])),
});
export type SessionDiffListing = typeof SessionDiffListingSchema.Type;

/**
 * One file's patch. `crlf`: its lines end in CRLF, which renders invisibly.
 * `latin1`: it is not UTF-8, so each byte was decoded as one Latin-1 character.
 * `replaced`: a tool reported a new file where the run started with one.
 * `unchecked`: a tool reported a new file the run's capture cannot confirm.
 */
export const SessionDiffPatchSchema = Schema.Struct({
	patch: Schema.String,
	notes: Schema.optional(
		Schema.Array(Schema.Literals(["crlf", "latin1", "replaced", "unchecked"])),
	),
});
export type SessionDiffPatch = typeof SessionDiffPatchSchema.Type;

/** Gone means the listing's snapshot was forgotten or collected: re-list. */
export class SessionDiffError extends Schema.TaggedError<SessionDiffError>()(
	"SessionDiffError",
	{
		reason: Schema.Literals([
			"gone",
			"not-listed",
			"too-large",
			"timeout",
			"unavailable",
		]),
		message: Schema.String,
	},
) {}

/**
 * Discards or stages one listed file of the unstaged scope, or one hunk of its
 * patch. `expected` is the working-tree blob the user saw (null when deleted);
 * a hunk names the listing its patch came from and its position in it.
 */
export const SessionDiffEditSchema = Schema.Struct({
	sessionId: Schema.String,
	folder: Schema.String,
	path: Schema.String,
	oldPath: Schema.optional(Schema.String),
	expected: Schema.NullOr(Schema.String),
	hunk: Schema.optional(
		Schema.Struct({
			revision: Schema.String,
			before: Schema.String,
			index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
		}),
	),
});
export type SessionDiffEdit = typeof SessionDiffEditSchema.Type;

/**
 * Stale: the file is no longer what the user saw, so re-list. Busy: the
 * session's agent is running. Conflict: git refused, and nothing was written.
 */
export class SessionDiffEditError extends Schema.TaggedError<SessionDiffEditError>()(
	"SessionDiffEditError",
	{
		reason: Schema.Literals([
			"stale",
			"busy",
			"conflict",
			"unavailable",
			"timeout",
		]),
		message: Schema.String,
	},
) {}
