import { Schema } from "effect";

/** Which change set a Session Diff shows. Turn and tool-call scopes extend this union. */
export const SessionDiffScopeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unstaged") }),
	/** The merge-base of base and HEAD against the live working tree; null base is the launch base. */
	Schema.Struct({
		kind: Schema.Literal("branch"),
		base: Schema.NullOr(Schema.String),
	}),
]);
export type SessionDiffScope = typeof SessionDiffScopeSchema.Type;

/** Bytes above which a file only shows its size and links to the Files pane. */
export const SESSION_DIFF_TOO_LARGE_BYTES = 1024 * 1024;
/** Changed lines up to which a file's patch loads as it scrolls into view. */
export const SESSION_DIFF_AUTO_LINES = 500;

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
};

/** A tooLarge file carries no line counts: git never diffs it. */
export const SessionDiffFileSchema = Schema.Union([
	Schema.Struct({ ...fileFields, tier: Schema.Literal("tooLarge") }),
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
});
export type SessionDiffListing = typeof SessionDiffListingSchema.Type;

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
