import { Schema } from "effect";

/** Per-project terminal environment settings, persisted in daemon.json. */
export const ProjectShellEnvConfigSchema = Schema.Struct({
	interactive: Schema.optional(Schema.Boolean),
	overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

export type ProjectShellEnvConfig = typeof ProjectShellEnvConfigSchema.Type;
