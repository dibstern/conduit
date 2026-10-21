import { Schema } from "effect";
import { SessionRef } from "./session-ref-schema.js";

export const ProjectSetupSourceSchema = Schema.Literals(["daemon", "file"]);
export const ProjectSetupOutcomeSchema = Schema.Literals([
	"succeeded",
	"failed",
	"timed_out",
	"skipped",
]);
export const ProjectSetupStateSchema = Schema.Struct({
	source: ProjectSetupSourceSchema,
	status: Schema.Union([Schema.Literal("running"), ProjectSetupOutcomeSchema]),
	exitCode: Schema.optional(Schema.Int),
	message: Schema.optional(Schema.String),
});
export type ProjectSetupState = typeof ProjectSetupStateSchema.Type;

export const SessionSetupStartedPayloadSchema = Schema.Struct({
	sessionId: Schema.String.pipe(SessionRef(false)),
	source: ProjectSetupSourceSchema,
});
export const SessionSetupOutputPayloadSchema = Schema.Struct({
	sessionId: Schema.String.pipe(SessionRef(false)),
	output: Schema.String,
});
export const SessionSetupFinishedPayloadSchema = Schema.Struct({
	sessionId: Schema.String.pipe(SessionRef(false)),
	status: ProjectSetupOutcomeSchema,
	exitCode: Schema.optional(Schema.Int),
	message: Schema.optional(Schema.String),
});
