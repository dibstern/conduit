import { Schema } from "effect";

/** Which change set a Session Diff shows. Branch and tool-call scopes extend this union. */
export const SessionDiffScopeSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("unstaged") }),
	/** One finished turn's captured changes; `turnId` is the durable turns.id. */
	Schema.Struct({ kind: Schema.Literal("turn"), turnId: Schema.String }),
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

/** `folder` is the Project Folder root, as in the file RPCs. */
export const SessionDiffFolderSchema = Schema.Union([
	Schema.Struct({
		folder: Schema.String,
		files: Schema.Array(SessionDiffFileSchema),
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
