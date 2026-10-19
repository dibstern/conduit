import { Schema } from "effect";

const ConfigDirPath = Schema.String.pipe(
	Schema.check(
		Schema.makeFilter((path) => path.trim().length > 0, {
			message: "Claude config directory must be non-empty",
		}),
	),
);

/** Portable wire shape; SDK launches also validate the default folder's basename. */
export const ClaudeConfigDirSchema = Schema.Union([
	Schema.TaggedStruct("SdkDefault", { path: ConfigDirPath }),
	Schema.TaggedStruct("Configured", { path: ConfigDirPath }),
]);
export type ClaudeConfigDir = typeof ClaudeConfigDirSchema.Type;
