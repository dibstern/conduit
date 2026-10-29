import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ToolFileChangeSchema } from "../../src/lib/contracts/stored-event.js";
import { deriveToolFileChanges } from "../../src/lib/tool-file-changes.js";

describe("Tool File Change", () => {
	it("retains empty creations and content-free patch declarations", () => {
		const patch =
			"*** Begin Patch\n*** Add File: empty\n*** Update File: unchanged\n*** Update File: old\n*** Move to: renamed\n*** End Patch";
		expect(
			deriveToolFileChanges({ tool: "Patch", patch, filePaths: [] }),
		).toEqual([
			{ path: "empty", kind: "add", before: "", after: "" },
			{ path: "unchanged", kind: "update" },
			{ path: "renamed", oldPath: "old", kind: "move" },
		]);
	});
	it("keeps one-character delete paths and ignores missing paths", () => {
		expect(
			deriveToolFileChanges({
				tool: "Unknown",
				name: "Delete",
				raw: { path: "a" },
			}),
		).toEqual([{ path: "a", kind: "delete" }]);
		expect(
			deriveToolFileChanges({
				tool: "Unknown",
				name: "Delete",
				raw: { path: "" },
			}),
		).toEqual([]);
		expect(
			deriveToolFileChanges({
				tool: "Unknown",
				name: "Delete",
				raw: { filePath: 1 },
			}),
		).toEqual([]);
		expect(
			deriveToolFileChanges({
				tool: "Unknown",
				name: "other",
				raw: { path: "a" },
			}),
		).toEqual([]);
	});
	it.each([
		{
			patch: "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-a\n+b",
			expected: [{ path: "a", kind: "update" }],
		},
		{
			patch: "--- a/a\n+++ b/b\n@@ -1 +1 @@\n-a\n+b",
			expected: [{ path: "b", oldPath: "a", kind: "move" }],
		},
		{
			patch: "diff --git a/a b/b\nrename from a\nrename to b\n",
			expected: [{ path: "b", oldPath: "a", kind: "move" }],
		},
		{ patch: "diff --git a/a b/a\n--- a/a\n", expected: [] },
		{ patch: "diff --git a/a b/a\n+++ b/a\n", expected: [] },
		{ patch: "--- a/a\n", expected: [{ path: "fallback", kind: "update" }] },
		{ patch: "+++ b/a\n", expected: [{ path: "fallback", kind: "update" }] },
	])("handles unified patch paths in $patch", ({ patch, expected }) => {
		expect(
			deriveToolFileChanges({ tool: "Patch", patch, filePaths: ["fallback"] }),
		).toEqual(expected.map((change) => ({ ...change, patch })));
	});
	it("keeps replacement text, including empty strings", () => {
		expect(
			deriveToolFileChanges({
				tool: "Edit",
				filePath: "a.ts",
				oldString: "old",
				newString: "",
			}),
		).toEqual([{ path: "a.ts", kind: "update", before: "old", after: "" }]);
		expect(
			deriveToolFileChanges({
				tool: "Write",
				filePath: "empty.ts",
				content: "",
			}),
		).toEqual([{ path: "empty.ts", kind: "add", before: "", after: "" }]);
	});
	it("splits apply_patch input into additions, edits, deletions and moves", () => {
		const patch =
			"*** Begin Patch\n*** Add File: new.ts\n+new\n*** Update File: a.ts\n@@\n-old\n+new\n*** Delete File: gone.ts\n*** Update File: old.ts\n*** Move to: moved.ts\n@@\n-a\n+b\n*** End Patch";
		expect(
			deriveToolFileChanges({ tool: "Patch", filePaths: [], patch }),
		).toEqual([
			{ path: "new.ts", kind: "add", before: "", after: "new\n" },
			{ path: "a.ts", kind: "update", patch: "@@\n-old\n+new" },
			{ path: "gone.ts", kind: "delete" },
			{
				path: "moved.ts",
				oldPath: "old.ts",
				kind: "move",
				patch: "@@\n-a\n+b",
			},
		]);
	});
	it("splits unified patches by file and retains provider text", () => {
		const add =
			"diff --git a/new.ts b/new.ts\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+new\n";
		const remove =
			"diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
		expect(
			deriveToolFileChanges({
				tool: "Patch",
				filePaths: ["new.ts", "gone.ts"],
				patch: add + remove,
			}),
		).toEqual([
			{ path: "new.ts", kind: "add", patch: add },
			{ path: "gone.ts", kind: "delete", patch: remove },
		]);
	});
	it("does not copy a combined opaque patch onto every path", () => {
		expect(
			deriveToolFileChanges({
				tool: "Patch",
				filePaths: ["a", "b"],
				patch: "unrecognized",
			}),
		).toEqual([
			{ path: "a", kind: "update" },
			{ path: "b", kind: "update" },
		]);
		expect(
			deriveToolFileChanges({
				tool: "Patch",
				filePaths: ["a"],
				patch: "opaque",
			}),
		).toEqual([{ path: "a", kind: "update", patch: "opaque" }]);
	});
	it("recognizes canonical delete tools without inferring shell writes", () => {
		expect(
			deriveToolFileChanges({
				tool: "Unknown",
				name: "Delete",
				raw: { path: "gone.ts" },
			}),
		).toEqual([{ path: "gone.ts", kind: "delete" }]);
		expect(deriveToolFileChanges({ tool: "Bash", command: "rm a" })).toEqual(
			[],
		);
		expect(deriveToolFileChanges({ tool: "Read", filePath: "a" })).toEqual([]);
	});
	it("requires a source path for moves and rejects unknown kinds", () => {
		const decode = Schema.decodeUnknownSync(ToolFileChangeSchema);
		expect(() => decode({ path: "a", kind: "move" })).toThrow();
		expect(() => decode({ path: "a", kind: "replace" })).toThrow();
		expect(
			decode({ path: "a", oldPath: "b", kind: "move", patch: "" }),
		).toEqual({ path: "a", oldPath: "b", kind: "move", patch: "" });
	});
});
