import type {
	CanonicalToolInput,
	ToolFileChange,
} from "./contracts/stored-event.js";

/** Legacy fallback. These are tool declarations, never disk observations. */
export function deriveToolFileChanges(
	input: CanonicalToolInput,
): readonly ToolFileChange[] {
	switch (input.tool) {
		case "Edit":
			return [
				{
					path: input.filePath,
					kind: "update",
					before: input.oldString,
					after: input.newString,
				},
			];
		case "Write":
			return [
				{ path: input.filePath, kind: "add", before: "", after: input.content },
			];
		case "Patch":
			return patchChanges(input.patch, input.filePaths);
		case "Unknown": {
			if (!/^(delete|delete_file)$/i.test(input.name)) return [];
			const path = ["filePath", "file_path", "path"]
				.map((key) => input.raw[key])
				.find((value) => typeof value === "string" && value.length > 0);
			return typeof path === "string" ? [{ path, kind: "delete" }] : [];
		}
		default:
			return [];
	}
}

function patchChanges(
	patch: string,
	paths: readonly string[],
): readonly ToolFileChange[] {
	const apply = [
		...patch.matchAll(
			/^\*\*\* (Add|Update|Delete) File: (.+)\r?\n?([\s\S]*?)(?=^\*\*\* (?:Add|Update|Delete) File:|^\*\*\* End Patch|$(?![\s\S]))/gm,
		),
	];
	if (apply.length) return apply.map(applyPatchChange);
	const unified = patch
		.split(/(?=^diff --git )/m)
		.filter((part) => part.startsWith("diff --git "));
	if (unified.length) return unified.flatMap(unifiedPatchChange);
	if (/^--- /m.test(patch) && /^\+\+\+ /m.test(patch))
		return unifiedPatchChange(patch);
	return paths.map((path) => ({
		path,
		kind: "update",
		...(paths.length === 1 ? { patch } : {}),
	}));
}

function applyPatchChange(match: RegExpMatchArray): ToolFileChange {
	const oldPath = (match[2] ?? "").trim();
	const body = (match[3] ?? "").replace(/\r?\n$/, "");
	if (match[1] === "Delete") return { path: oldPath, kind: "delete" };
	if (match[1] === "Add") {
		const lines = body
			.split("\n")
			.filter((line) => line.startsWith("+"))
			.map((line) => line.slice(1));
		return {
			path: oldPath,
			kind: "add",
			before: "",
			after: lines.map((line) => `${line}\n`).join(""),
		};
	}
	const move = /^\*\*\* Move to: (.+)\r?\n?/m.exec(body)?.[1];
	const text = body.replace(/^\*\*\* Move to: .+\r?\n?/m, "");
	return move
		? {
				path: move.trim(),
				oldPath,
				kind: "move",
				...(text ? { patch: text } : {}),
			}
		: { path: oldPath, kind: "update", ...(text ? { patch: text } : {}) };
}

function unifiedPatchChange(patch: string): ToolFileChange[] {
	const oldPath = /^--- (.+?)(?:\t.*)?\r?$/m
		.exec(patch)?.[1]
		?.replace(/^a\//, "");
	const path = /^\+\+\+ (.+?)(?:\t.*)?\r?$/m
		.exec(patch)?.[1]
		?.replace(/^b\//, "");
	const renamedFrom = /^rename from (.+)\r?$/m.exec(patch)?.[1];
	const renamedTo = /^rename to (.+)\r?$/m.exec(patch)?.[1];
	return patchPaths(patch, renamedFrom ?? oldPath, renamedTo ?? path);
}

function patchPaths(
	patch: string,
	oldPath: string | undefined,
	path: string | undefined,
): ToolFileChange[] {
	if (!oldPath || !path) return [];
	if (path === "/dev/null") return [{ path: oldPath, kind: "delete", patch }];
	if (oldPath === "/dev/null") return [{ path, kind: "add", patch }];
	return [
		oldPath === path
			? { path, kind: "update", patch }
			: { path, oldPath, kind: "move", patch },
	];
}
