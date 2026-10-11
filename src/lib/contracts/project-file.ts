import { Schema } from "effect";

/** Settings read from conduit.json in the primary Project Folder. */
export const ProjectFileSchema = Schema.Struct({
	setupScript: Schema.optional(Schema.String),
});
export type ProjectFile = typeof ProjectFileSchema.Type;

export type ProjectFileResult =
	| { readonly _tag: "absent" }
	| { readonly _tag: "parsed"; readonly file: ProjectFile }
	| { readonly _tag: "invalid"; readonly message: string };
