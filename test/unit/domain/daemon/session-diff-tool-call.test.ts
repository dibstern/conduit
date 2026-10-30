import { describe, expect, it } from "vitest";
import {
	SESSION_DIFF_AUTO_LINES,
	SESSION_DIFF_TOO_LARGE_BYTES,
} from "../../../../src/lib/contracts/session-diff.js";
import type {
	RunChangesCaptured,
	ToolFileChange,
} from "../../../../src/lib/contracts/stored-event.js";
import { listToolCall } from "../../../../src/lib/domain/daemon/Layers/session-diff-tool-call.js";

// Failure modes the replayed Claude trace (session-diff-tool-call integration
// test) does not reach: apply_patch hunks without numbers lose their running
// line numbers, or an empty context line drops out of its hunk; a numbered
// header for an empty side is not git's `-0,0`/`+0,0`; a patch whose first
// line is `@@` is discarded; the tier boundaries are off by one or count
// insertions minus deletions; a move loses its old path, or another status
// grows one; a relative or outside path joins the wrong folder; content ids
// key on patch text instead of the recorded file content; a Write add is
// called new when the run's start saw the file.

const side = { mode: "100644", blob: "b" };
const capture: RunChangesCaptured = {
	runId: "run",
	folders: [
		{
			directory: "/r",
			before: "t0",
			after: "t1",
			shared: false,
			changes: [
				{ path: "old.ts", before: side, after: side },
				{ path: "new.ts", before: null, after: side },
			],
		},
	],
};
const folder = { root: "/r", directory: "/r", present: true };
// `null` means the run has no capture.
const one = (
	change: ToolFileChange,
	at: RunChangesCaptured | null = capture,
) => {
	const [listed] = listToolCall([folder], [change], at ?? undefined);
	if (!listed) throw new Error("nothing listed");
	const [file] = listed.files;
	return { file, patch: listed.patches.get(file?.path ?? "") };
};
const lines = (count: number, text: string) =>
	`${Array.from({ length: count }, () => text).join("\n")}\n`;

describe("listToolCall", () => {
	it("renumbers apply_patch hunks from the lines before them and keeps empty context lines", () => {
		const { file, patch } = one({
			kind: "update",
			path: "/r/a.ts",
			patch: "@@\n a\n-b\n+c\n@@ fn\n d\n\n+e\n",
		});
		expect(patch).toStrictEqual({
			patch: [
				"diff --git a/a.ts b/a.ts",
				"--- a/a.ts",
				"+++ b/a.ts",
				"@@ -1,2 +1,2 @@",
				" a",
				"-b",
				"+c",
				"@@ -3,2 +3,3 @@ fn",
				" d",
				" ",
				"+e",
				"",
			].join("\n"),
		});
		expect(file).toMatchObject({ insertions: 2, deletions: 1 });
	});

	it("numbers an empty side from the line before it, as git does", () => {
		const added = one({
			kind: "add",
			path: "/r/new.ts",
			patch: "--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n",
		});
		const deleted = one({
			kind: "delete",
			path: "/r/gone.ts",
			patch: "@@ -1,2 +0,0 @@\n-x\n-y\n",
		});
		expect(added.patch?.patch).toContain("\n@@ -0,0 +1,2 @@\n");
		expect(deleted.patch?.patch).toBe(
			"diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n",
		);
	});

	it("tiers by total changed lines and by size, never binary", () => {
		const update = (before: string, after: string) =>
			one({ kind: "update", path: "/r/a.ts", before, after }).file;
		const atLimit = SESSION_DIFF_AUTO_LINES / 2;
		expect(update(lines(atLimit, "o"), lines(atLimit, "n"))).toMatchObject({
			tier: "auto",
			binary: false,
		});
		expect(
			update(lines(atLimit + 1, "o"), lines(atLimit + 1, "n")),
		).toMatchObject({ tier: "onDemand", binary: false });

		const head =
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-a\n+";
		const sized = (bytes: number) =>
			one({
				kind: "update",
				path: "/r/a.ts",
				patch: `@@ -1 +1 @@\n-a\n+${"b".repeat(bytes - head.length - 1)}\n`,
			}).file;
		expect(sized(SESSION_DIFF_TOO_LARGE_BYTES)).toMatchObject({
			bytes: SESSION_DIFF_TOO_LARGE_BYTES,
			tier: "auto",
		});
		expect(sized(SESSION_DIFF_TOO_LARGE_BYTES + 1)?.tier).toBe("tooLarge");
	});

	it("gives only a move its old path, relative to the folder", () => {
		const { file } = one({
			kind: "move",
			path: "/r/b.ts",
			oldPath: "/r/a.ts",
			patch: "",
		});
		expect(file).toStrictEqual({
			path: "b.ts",
			oldPath: "a.ts",
			status: "renamed",
			before: expect.any(String),
			after: expect.any(String),
			bytes: expect.any(Number),
			tier: "auto",
			insertions: 0,
			deletions: 0,
			binary: false,
		});
		expect(
			one({ kind: "update", path: "/r/a.ts", patch: "@@\n-a\n+b" }).file,
		).not.toHaveProperty("oldPath");
	});

	it("puts a relative or outside path in the first folder as the tool named it", () => {
		const here = { root: "here", directory: process.cwd(), present: true };
		const listed = listToolCall(
			[{ root: "first", directory: "/elsewhere", present: true }, here],
			[
				{ kind: "update", path: "rel.ts", patch: "@@\n-a\n+b" },
				{ kind: "update", path: "/outside/x.ts", patch: "@@\n-a\n+b" },
			],
			undefined,
		);
		expect(
			listed.map(({ folder, files }) => [folder, files.map((f) => f.path)]),
		).toStrictEqual([["first", ["rel.ts", "/outside/x.ts"]]]);
	});

	it("keys content ids on the recorded file content, even when it is empty", () => {
		const [listed] = listToolCall(
			[folder],
			[
				{
					kind: "update",
					path: "/r/a.ts",
					before: "",
					after: "",
					patch: "@@\n-a\n+b",
				},
				{
					kind: "update",
					path: "/r/b.ts",
					before: "",
					after: "",
					patch: "@@\n-c\n+d",
				},
			],
			undefined,
		);
		const [a, b] = listed?.files ?? [];
		expect(a?.before).toBe(b?.before);
		expect(a?.after).toBe(b?.after);
	});

	it("checks a Write add against the run's start", () => {
		const write = (path: string, at: RunChangesCaptured | null = capture) =>
			one({ kind: "add", path, after: "x\n" }, at);
		expect(write("/r/old.ts")).toMatchObject({
			file: { status: "modified" },
			patch: { notes: ["replaced"] },
		});
		const fresh = write("/r/new.ts");
		expect(fresh.file?.status).toBe("added");
		expect(fresh.patch).not.toHaveProperty("notes");
		expect(write("/r/new.ts", null)).toMatchObject({
			file: { status: "added" },
			patch: { notes: ["unchecked"] },
		});
	});
});
