// A tool part's input and output as they travel to the browser: whole, or a
// preview of each long field plus that field's full size. The rule that picks
// one lives in persistence/tool-wire-projection.ts; a preview's partial state
// is its tag, so it cannot disagree with the sizes it carries.

import { Schema } from "effect";

/** A length in Unicode code points: the unit the preview budget counts. */
export const CodePoints = Schema.NonNegativeInt.pipe(
	Schema.brand("CodePoints"),
);
export type CodePoints = typeof CodePoints.Type;

/** A size in UTF-8 bytes: the unit a cut field's full size is reported in. */
export const Utf8Bytes = Schema.NonNegativeInt.pipe(Schema.brand("Utf8Bytes"));
export type Utf8Bytes = typeof Utf8Bytes.Type;

/** A tool call's id: `callID` on the transcript part, `id` on the browser's tool. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

/** The read-model version the message owning a tool part was last written at. */
export const MessageVersion = Schema.NonNegativeInt.pipe(
	Schema.brand("MessageVersion"),
);
export type MessageVersion = typeof MessageVersion.Type;

export const WholeText = Schema.TaggedStruct("whole", { text: Schema.String });
export type WholeText = typeof WholeText.Type;

export const ToolText = Schema.Union(
	WholeText,
	Schema.TaggedStruct("preview", { text: Schema.String, fullBytes: Utf8Bytes }),
);
export type ToolText = typeof ToolText.Type;

export const WholeInput = Schema.TaggedStruct("whole", {
	value: Schema.Unknown,
});
export type WholeInput = typeof WholeInput.Type;

/** One cut string inside a tool's input: where it sits and its full size. */
export const InputCut = Schema.Struct({
	path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
	fullBytes: Utf8Bytes,
});
export type InputCut = typeof InputCut.Type;

export const ToolInput = Schema.Union(
	WholeInput,
	Schema.TaggedStruct("preview", {
		value: Schema.Unknown,
		cuts: Schema.NonEmptyArray(InputCut),
	}),
);
export type ToolInput = typeof ToolInput.Type;

/** A tool exactly as stored: what expanding a previewed tool shows. */
export const ToolDetail = Schema.Struct({
	toolId: ToolCallId,
	version: MessageVersion,
	input: Schema.optionalWith(WholeInput, { exact: true }),
	output: Schema.optionalWith(WholeText, { exact: true }),
});
export type ToolDetail = typeof ToolDetail.Type;
