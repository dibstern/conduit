import { Schema } from "effect";

export const AskExplanationContentSchema = Schema.Struct({
	soFar: Schema.NonEmptyString,
	whatCameUp: Schema.NonEmptyString,
	options: Schema.Array(
		Schema.Struct({
			label: Schema.NonEmptyString,
			explanation: Schema.NonEmptyString,
			recommended: Schema.Boolean,
		}),
	),
	unanswered: Schema.String,
});

export const AskExplanationSchema = Schema.Struct({
	...AskExplanationContentSchema.fields,
	model: Schema.String,
});
export type AskExplanation = typeof AskExplanationSchema.Type;
