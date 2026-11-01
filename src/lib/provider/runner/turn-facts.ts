import { Schema } from "effect";

/** What prepare decided for one turn; the runner never re-derives it. */
export const TurnFacts = Schema.TaggedUnion({
	Cursor: {
		model: Schema.Union([
			Schema.TaggedStruct("Resolved", {
				params: Schema.Array(
					Schema.Struct({ id: Schema.String, value: Schema.String }),
				),
			}),
			// The runner owns the auth error and its durable turn terminal.
			Schema.TaggedStruct("SignedOut", {}),
		]),
		forkDigest: Schema.optionalKey(Schema.String),
	},
	Codex: {
		effort: Schema.optionalKey(Schema.String),
		skill: Schema.Union([
			Schema.TaggedStruct("None", {}),
			Schema.TaggedStruct("Skill", {
				name: Schema.String,
				path: Schema.String,
			}),
		]),
		truncate: Schema.Union([
			Schema.TaggedStruct("None", {}),
			Schema.TaggedStruct("Before", { turnId: Schema.String }),
		]),
		forkDigest: Schema.optionalKey(Schema.String),
	},
	Claude: {},
});
export type TurnFacts = typeof TurnFacts.Type;
