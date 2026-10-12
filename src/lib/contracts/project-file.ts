import { Schema } from "effect";

export const SessionModeSchema = Schema.Literal("local", "worktree");
export type SessionMode = typeof SessionModeSchema.Type;

/** Settings read from conduit.json in the primary Project Folder. */
export const ProjectFileSchema = Schema.Struct({
	setupScript: Schema.optional(Schema.String),
	sessionMode: Schema.optional(SessionModeSchema),
});
export type ProjectFile = typeof ProjectFileSchema.Type;

export type ProjectFileResult =
	| { readonly _tag: "absent" }
	| { readonly _tag: "parsed"; readonly file: ProjectFile }
	| { readonly _tag: "invalid"; readonly message: string };
