// A tool part's input and output as they travel to the browser: whole, or a
// preview of each long field plus that field's full size. The rule that picks
// one lives in persistence/tool-wire-projection.ts; a preview's partial state
// is its tag, so it cannot disagree with the sizes it carries.

import { Schema } from "effect";

/** Tools that hand work to a subagent (Claude's Task and Agent, OpenCode's
 *  task): their reply is the point, and their run outlives the turn. */
export const SUBAGENT_TOOL_NAMES = ["Task", "task", "Agent"] as const;

/** A length in Unicode code points: the unit the preview budget counts. */
export const CodePoints = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("CodePoints"));
export type CodePoints = typeof CodePoints.Type;

/** A size in UTF-8 bytes: the unit a cut field's full size is reported in. */
export const Utf8Bytes = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("Utf8Bytes"));
export type Utf8Bytes = typeof Utf8Bytes.Type;

/** A tool call's id: `callID` on the transcript part, `id` on the browser's tool. */
export const ToolCallId = Schema.String.pipe(Schema.brand("ToolCallId"));
export type ToolCallId = typeof ToolCallId.Type;

/** The read-model version the message owning a tool part was last written at. */
export const MessageVersion = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("MessageVersion"));
export type MessageVersion = typeof MessageVersion.Type;

/** The read-model version a message part was last written at. A part moves on
 *  its own, so its version is never borrowed from the message that owns it. */
export const PartVersion = Schema.Number.check(
	Schema.isInt(),
	Schema.isGreaterThanOrEqualTo(0),
).pipe(Schema.brand("PartVersion"));
export type PartVersion = typeof PartVersion.Type;

export const WholeText = Schema.TaggedStruct("whole", { text: Schema.String });
export type WholeText = typeof WholeText.Type;

export const ToolText = Schema.Union([
	WholeText,
	Schema.TaggedStruct("preview", { text: Schema.String, fullBytes: Utf8Bytes }),
]);
export type ToolText = typeof ToolText.Type;

export const WholeInput = Schema.TaggedStruct("whole", {
	value: Schema.optionalKey(Schema.Unknown),
});
export type WholeInput = typeof WholeInput.Type;

/** One cut string inside a tool's input: where it sits and its full size. */
export const InputCut = Schema.Struct({
	path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
	fullBytes: Utf8Bytes,
});
export type InputCut = typeof InputCut.Type;

export const ToolInput = Schema.Union([
	WholeInput,
	Schema.TaggedStruct("preview", {
		value: Schema.optionalKey(Schema.Unknown),
		cuts: Schema.NonEmptyArray(InputCut),
	}),
]);
export type ToolInput = typeof ToolInput.Type;

/** A tool exactly as stored: what expanding a previewed tool shows. */
export const ToolDetail = Schema.Struct({
	toolId: ToolCallId,
	version: PartVersion,
	/** The tool has finished (completed or failed), so this detail is final. */
	settled: Schema.Boolean,
	input: Schema.optionalKey(WholeInput),
	output: Schema.optionalKey(WholeText),
});
export type ToolDetail = typeof ToolDetail.Type;
