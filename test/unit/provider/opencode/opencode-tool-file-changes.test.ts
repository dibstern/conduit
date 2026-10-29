import { describe, expect, it } from "vitest";
import { OpenCodeRuntimeEventTranslator } from "../../../../src/lib/provider/opencode/opencode-runtime-event-translator.js";
import { makeSSEEvent } from "../../../helpers/sse-factories.js";

describe("OpenCode tool file changes", () => {
	it.each([
		{
			metadata: {
				filediff: {
					file: "/src/main.ts",
					before: "whole before",
					after: "whole after",
					additions: 1,
					deletions: 1,
				},
				diff: "provider patch",
			},
			expected: [
				{
					path: "/src/main.ts",
					kind: "update",
					before: "whole before",
					after: "whole after",
					patch: "provider patch",
				},
			],
		},
		{
			metadata: {
				filediff: {
					path: "/src/main.ts",
					status: "deleted",
					patch: "delete patch",
					additions: 0,
					deletions: 1,
				},
			},
			expected: [
				{ path: "/src/main.ts", kind: "delete", patch: "delete patch" },
			],
		},
		{
			metadata: {
				files: [
					{
						filePath: "/src/old.ts",
						movePath: "/src/new.ts",
						type: "move",
						diff: "move patch",
					},
					{ filePath: "/src/add.ts", type: "add", diff: "add patch" },
				],
			},
			expected: [
				{
					path: "/src/new.ts",
					oldPath: "/src/old.ts",
					kind: "move",
					patch: "move patch",
				},
				{ path: "/src/add.ts", kind: "add", patch: "add patch" },
			],
		},
		{
			metadata: { filediff: "invalid" },
			expected: [
				{ path: "/src/main.ts", kind: "update", before: "old", after: "new" },
			],
		},
		{
			// OpenCode's edit with an empty oldString creates the file.
			oldString: "",
			metadata: {
				filediff: { file: "/src/main.ts", before: "", after: "new" },
			},
			expected: [
				{ path: "/src/main.ts", kind: "add", before: "", after: "new" },
			],
		},
	])("prefers provider metadata and falls back to canonical input", ({
		oldString = "old",
		metadata,
		expected,
	}) => {
		const translator = new OpenCodeRuntimeEventTranslator();
		const events = translator.translate(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				part: {
					id: "p1",
					messageID: "m1",
					type: "tool",
					tool: "edit",
					state: {
						status: "completed",
						input: {
							filePath: "/src/main.ts",
							oldString,
							newString: "new",
						},
						metadata,
						output: "done",
					},
				},
			}),
			"s1",
		);
		expect(
			events?.find((event) => event.type === "tool.completed")?.data,
		).toMatchObject({ fileChanges: expected });
	});

	it("does not report file changes for failed tools", () => {
		const events = new OpenCodeRuntimeEventTranslator().translate(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				part: {
					id: "p1",
					messageID: "m1",
					type: "tool",
					tool: "edit",
					state: {
						status: "error",
						input: {
							filePath: "/src/main.ts",
							oldString: "old",
							newString: "new",
						},
						error: "failed",
					},
				},
			}),
			"s1",
		);
		expect(
			events?.find((event) => event.type === "tool.completed")?.data,
		).not.toHaveProperty("fileChanges");
	});

	it.each([
		false,
		true,
	])("uses Write existence metadata to distinguish add from update (%s)", (exists) => {
		const events = new OpenCodeRuntimeEventTranslator().translate(
			makeSSEEvent("message.part.updated", {
				sessionID: "s1",
				part: {
					id: "p1",
					messageID: "m1",
					type: "tool",
					tool: "write",
					state: {
						status: "completed",
						input: { filePath: "/src/main.ts", content: "new" },
						metadata: { exists, diff: "provider patch" },
						output: "done",
					},
				},
			}),
			"s1",
		);
		expect(
			events?.find((event) => event.type === "tool.completed")?.data,
		).toMatchObject({
			fileChanges: [
				{
					path: "/src/main.ts",
					kind: exists ? "update" : "add",
					after: "new",
					patch: "provider patch",
				},
			],
		});
	});
});
