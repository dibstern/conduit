import { Schema } from "effect";
import { AccountRefSchema } from "./account.js";

export const TitleGenerationSelectionSchema = Schema.Struct({
	account: AccountRefSchema,
	providerId: Schema.String,
	modelId: Schema.String,
	effort: Schema.String,
});
export type TitleGenerationSelection =
	typeof TitleGenerationSelectionSchema.Type;

export const TitleGenerationStateSchema = Schema.Struct({
	selection: Schema.NullOr(TitleGenerationSelectionSchema),
	status: Schema.Literals(["ok", "missing", "invalid", "unverified"]),
	problem: Schema.optional(Schema.String),
});
export type TitleGenerationState = typeof TitleGenerationStateSchema.Type;

export const BUILTIN_TITLE_GENERATION: TitleGenerationSelection = {
	account: { _tag: "DriverDefault", driver: "claude" },
	providerId: "claude",
	modelId: "opus",
	effort: "",
};
