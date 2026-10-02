import { Schema } from "effect";

/** Per-project terminal environment settings, persisted in daemon.json. */
export const ProjectShellEnvConfigSchema = Schema.Struct({
	interactive: Schema.optional(Schema.Boolean),
	overrides: Schema.optional(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
});

export type ProjectShellEnvConfig = typeof ProjectShellEnvConfigSchema.Type;
