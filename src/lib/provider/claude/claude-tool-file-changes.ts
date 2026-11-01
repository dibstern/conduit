import { Option, Schema } from "effect";
import type {
	CanonicalToolInput,
	ToolFileChange,
} from "../../contracts/stored-event.js";
import { deriveToolFileChanges } from "../../tool-file-changes.js";
import { isRecord } from "../../utils.js";

const decodePatchHunks = Schema.decodeUnknownOption(
	Schema.Array(
		Schema.Struct({
			oldStart: Schema.Number,
			oldLines: Schema.Number,
			newStart: Schema.Number,
			newLines: Schema.Number,
			lines: Schema.Array(Schema.String),
		}),
	),
);

export function claudeToolFileChanges(
	input: CanonicalToolInput,
	result?: unknown,
): readonly ToolFileChange[] {
	const fallback = deriveToolFileChanges(input);
	if (!isRecord(result) || (input.tool !== "Write" && input.tool !== "Edit"))
		return fallback;
	const path =
		typeof result["filePath"] === "string"
			? result["filePath"]
			: input.filePath;
	if (!path) return fallback;
	const text = resultText(result, path);
	if (Object.keys(text).length === 0) return fallback;
	return [
		{ path, kind: result["type"] === "create" ? "add" : "update", ...text },
	];
}

function resultText(result: Record<string, unknown>, path: string) {
	const before =
		typeof result["originalFile"] === "string"
			? result["originalFile"]
			: undefined;
	const after =
		typeof result["content"] === "string" ? result["content"] : undefined;
	const patch = resultPatch(result, path);
	return {
		...(before !== undefined ? { before } : {}),
		...(after !== undefined ? { after } : {}),
		...(patch !== undefined ? { patch } : {}),
	};
}

function resultPatch(
	result: Record<string, unknown>,
	path: string,
): string | undefined {
	if (typeof result["patch"] === "string") return result["patch"];
	const hunks = decodePatchHunks(result["structuredPatch"]);
	if (Option.isNone(hunks) || hunks.value.length === 0) return undefined;
	return `--- ${result["type"] === "create" ? "/dev/null" : path}\n+++ ${path}\n${hunks.value.map((hunk) => `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}\n`).join("")}`;
}
