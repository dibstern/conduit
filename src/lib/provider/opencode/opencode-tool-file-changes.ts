import { Option, Schema } from "effect";
import { OpenCodeToolFileDiffSchema } from "../../contracts/providers/opencode-sdk.js";
import type {
	CanonicalToolInput,
	ToolFileChange,
} from "../../contracts/stored-event.js";
import { deriveToolFileChanges } from "../../tool-file-changes.js";

const decodeFileDiff = Schema.decodeUnknownOption(OpenCodeToolFileDiffSchema);
type OpenCodeToolFileDiff = typeof OpenCodeToolFileDiffSchema.Type;

/** Preserve tool-local provider evidence; session-wide diffs cannot attribute a tool. */
export function openCodeToolFileChanges(
	input: CanonicalToolInput,
	metadata: Readonly<Record<string, unknown>> | undefined,
): readonly ToolFileChange[] {
	const patch =
		typeof metadata?.["diff"] === "string" ? metadata["diff"] : undefined;
	// OpenCode's edit with an empty oldString creates the file; its filediff says no kind.
	const created = input.tool === "Edit" && input.oldString === "";
	const changes = providerFileDiffs(metadata).flatMap((diff) =>
		fileChange(diff, patch, created),
	);
	return changes.length > 0
		? changes
		: canonicalChanges(input, metadata, patch);
}

function providerFileDiffs(
	metadata: Readonly<Record<string, unknown>> | undefined,
): readonly OpenCodeToolFileDiff[] {
	const candidates = Array.isArray(metadata?.["files"])
		? metadata["files"]
		: [metadata?.["filediff"] ?? metadata?.["diff"]];
	return candidates.flatMap((candidate) =>
		Option.match(decodeFileDiff(candidate), {
			onNone: () => [],
			onSome: (diff) => [diff],
		}),
	);
}

function changeKind(
	diff: OpenCodeToolFileDiff,
	created: boolean,
): ToolFileChange["kind"] {
	if (diff.movePath) return "move";
	if (diff.type) return diff.type;
	switch (diff.status) {
		case "added":
			return "add";
		case "deleted":
			return "delete";
		default:
			return created ? "add" : "update";
	}
}

function diffText(
	diff: OpenCodeToolFileDiff,
	defaultPatch: string | undefined,
) {
	const patch = diff.patch ?? diff.diff ?? defaultPatch;
	return {
		...(patch !== undefined ? { patch } : {}),
		...(diff.before !== undefined ? { before: diff.before } : {}),
		...(diff.after !== undefined ? { after: diff.after } : {}),
	};
}

function fileChange(
	diff: OpenCodeToolFileDiff,
	patch: string | undefined,
	created: boolean,
): readonly ToolFileChange[] {
	const oldPath = diff.filePath ?? diff.path ?? diff.file;
	const path = diff.movePath ?? oldPath;
	if (!path) return [];
	const kind = changeKind(diff, created);
	const change = { path, ...diffText(diff, patch) };
	if (kind !== "move") return [{ ...change, kind }];
	return oldPath ? [{ ...change, kind, oldPath }] : [];
}

function canonicalChanges(
	input: CanonicalToolInput,
	metadata: Readonly<Record<string, unknown>> | undefined,
	patch: string | undefined,
): readonly ToolFileChange[] {
	const fallback: readonly ToolFileChange[] =
		input.tool === "Write" && metadata?.["exists"] === true
			? [{ path: input.filePath, kind: "update", after: input.content }]
			: deriveToolFileChanges(input);
	return fallback.map((change) => ({
		...change,
		...(patch !== undefined ? { patch } : {}),
	}));
}
