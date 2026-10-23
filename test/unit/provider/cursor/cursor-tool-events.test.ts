// Failure modes: MCP errors hidden by success envelopes, protobuf shell variants
// misclassified, internal/unknown steps ending a turn, and stale inline media.
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	CursorToolResults,
	cursorToolOutcome,
	fromConversationStep,
} from "../../../../src/lib/provider/cursor/cursor-tool-events.js";
import type { CursorToolKind } from "../../../../src/lib/provider/cursor/sdk-real.js";
import { sdkToolFromConversationStep } from "../../../helpers/cursor-sdk-tool-converter.js";

describe("Cursor tool outcomes", () => {
	it.each([
		["success", { exitCode: 0, stdout: "hi", stderr: "" }, "Succeeded"],
		["success", { exitCode: 2, stdout: "", stderr: "failed" }, "Failed"],
		["error", { message: "Command rejected" }, "Failed"],
	] as const)("classifies shell %s %j", (status, value, tag) => {
		const completed = cursorToolOutcome({
			_tag: "Known",
			kind: "shell",
			call: {
				type: "shell",
				args: { command: "echo hi" },
				result:
					status === "success" ? { status, value } : { status, error: value },
			},
		});
		expect(completed.outcome._tag).toBe(tag);
		expect(completed.metadata).not.toHaveProperty("isError");
		expect(completed.metadata).not.toHaveProperty("outcome");
	});

	it("classifies MCP's success envelope with isError as failed", () => {
		expect(
			cursorToolOutcome({
				_tag: "Known",
				kind: "mcp",
				call: {
					type: "mcp",
					args: { providerIdentifier: "spike", toolName: "echo_hi" },
					result: { status: "success", value: { isError: true, content: [] } },
				},
			}),
		).toMatchObject({
			toolName: "mcp__spike__echo_hi",
			outcome: { _tag: "Failed", reason: expect.any(String) },
		});
	});

	it("keeps unknown public kinds generic", () => {
		expect(
			cursorToolOutcome({
				_tag: "Unknown",
				type: "future-tool",
				raw: {
					type: "future-tool",
					args: { command: "echo hi" },
					result: { status: "success", value: {} },
				},
			}),
		).toMatchObject({
			toolName: "future-tool",
			input: {
				tool: "Unknown",
				name: "future-tool",
				raw: { command: "echo hi" },
			},
			outcome: { _tag: "Succeeded" },
		});
	});

	it.each([
		["failure", { exitCode: 7, stdout: "hi", stderr: "bad" }, "hibad"],
		[
			"timeout",
			{ timeoutMs: 30_000, command: "echo hi" },
			"Command timed out after 30000ms",
		],
		["rejected", { reason: "denied" }, "denied"],
		["spawnError", { error: "cannot spawn" }, "cannot spawn"],
	] as const)("mirrors SDK shell %s conversion", (kind, value, result) => {
		const call = fromConversationStep({
			toolCall: {
				toolCallId: "shell",
				shellToolCall: {
					args: { command: "echo hi", toolCallId: "shell" },
					result: { [kind]: value },
				},
			},
		});
		expect(call).not.toBeNull();
		if (!call) throw new Error("Missing shell call");
		expect(cursorToolOutcome(call)).toMatchObject({
			toolName: "Bash",
			outcome: { _tag: "Failed" },
			result,
		});
	});

	it("defaults omitted protobuf shell exit code to zero, like the SDK", () => {
		const call = fromConversationStep({
			toolCall: {
				shellToolCall: {
					args: { command: "echo hi" },
					result: { success: { stdout: "hi\n" } },
				},
			},
		});
		if (!call) throw new Error("Missing shell call");
		expect(cursorToolOutcome(call)).toMatchObject({
			result: "hi\n",
			outcome: { _tag: "Succeeded" },
			metadata: { exitCode: 0 },
		});
	});

	it("converts snapshot MCP errors and generate-image's filePath-only result", () => {
		const mcp = fromConversationStep({
			toolCall: {
				mcpToolCall: {
					args: { providerIdentifier: "spike", toolName: "echo_hi" },
					result: { success: { isError: true, content: [] } },
				},
			},
		});
		const image = fromConversationStep({
			toolCall: {
				generateImageToolCall: {
					args: { description: "dot" },
					result: {
						success: { filePath: "generated.png", imageData: "stale" },
					},
				},
			},
		});
		if (!mcp || !image) throw new Error("Missing public tool");
		expect(cursorToolOutcome(mcp).outcome._tag).toBe("Failed");
		expect(cursorToolOutcome(image)).toMatchObject({
			toolName: "generateImage",
			result: { status: "success", value: { filePath: "generated.png" } },
		});
		expect(JSON.stringify(image)).not.toContain("imageData");
	});

	it.each([
		"getMcpToolsToolCall",
		"futureToolCall",
	])("skips non-public snapshot %s", (kind) => {
		expect(
			fromConversationStep({
				toolCall: { [kind]: { args: {}, result: { success: {} } } },
			}),
		).toBeNull();
	});

	it("ignores stale inline imageData instead of attaching uncaptured bytes", async () => {
		const completed = await Effect.runPromise(
			new CursorToolResults(process.cwd()).complete({
				type: "generateImage",
				args: {},
				result: {
					status: "success",
					value: { filePath: "c4-does-not-exist.png", imageData: "c3RhbGU=" },
				},
			}),
		);
		expect(completed.metadata).not.toHaveProperty("media");
		expect(completed.metadata).toHaveProperty("mediaUnavailable");
	});

	it("uses every captured public snapshot tool's public name", () => {
		const rows: Array<{
			kind?: string;
			data?: {
				type?: string;
				toolCall?: {
					result?: {
						value?: { conversationSteps?: Record<string, unknown>[] };
					};
				};
			};
		}> = readFileSync(
			"test/fixtures/cursor-sdk-traces/subagent-reconcile.jsonl",
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const steps = rows.find(
			({ kind, data }) =>
				kind === "delta" && data?.type === "tool-call-completed",
		)?.data?.toolCall?.result?.value?.conversationSteps;
		expect(steps).toBeDefined();
		expect(
			steps?.flatMap((step) => {
				const call = fromConversationStep(step);
				return call ? [cursorToolOutcome(call).toolName] : [];
			}),
		).toEqual([
			"Read",
			"Bash",
			"mcp__spike__echo_hi",
			"Edit",
			"Delete",
			"Edit",
			"mcp__custom-user-tools__human",
		]);
	});
});

describe("Cursor conversation-step SDK conversions", () => {
	type Example = {
		name: string;
		args: Record<string, unknown>;
		result?: Record<string, unknown>;
	};
	const examples: Record<CursorToolKind, Example[]> = {
		shell: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{ name: "failure", args: {}, result: { failure: { exitCode: 7 } } },
			{ name: "timeout", args: {}, result: { timeout: {} } },
			{ name: "rejected", args: {}, result: { rejected: {} } },
			{ name: "spawn error", args: {}, result: { spawnError: {} } },
		],
		read: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{ name: "error defaults", args: {}, result: { error: {} } },
		],
		edit: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{ name: "denied", args: {}, result: { writePermissionDenied: {} } },
		],
		// SDK 1.0.40's public union includes write, but its protobuf ToolCall has
		// no writeToolCall variant. Its own snapshot converter therefore skips it.
		write: [
			{
				name: "unsupported snapshot variant",
				args: {},
				result: { success: {} },
			},
		],
		delete: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{ name: "missing file", args: {}, result: { fileNotFound: {} } },
		],
		glob: [{ name: "defaults", args: {}, result: { success: {} } }],
		grep: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "nested outputs and omitted match fields",
				args: { pattern: "hi", context: 0, caseInsensitive: false },
				result: {
					success: {
						workspaceResults: {
							content: { content: { matches: [{ file: "a" }] } },
							files: { files: { files: ["a"] } },
							count: { count: { counts: [{ file: "a" }] } },
						},
						activeEditorResult: { content: {} },
					},
				},
			},
		],
		ls: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "recursive defaults",
				args: { ignore: [] },
				result: {
					success: {
						directoryTreeRoot: {
							absPath: "/workspace",
							childrenDirs: [{}],
							childrenFiles: [{ name: "a" }],
						},
					},
				},
			},
		],
		readLints: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "diagnostic defaults",
				args: { paths: ["a"] },
				result: {
					success: {
						fileDiagnostics: [
							{
								path: "a",
								diagnostics: [
									{
										severity: "DIAGNOSTIC_SEVERITY_WARNING",
										range: { start: {}, end: { line: 2 } },
									},
									{},
								],
							},
						],
					},
				},
			},
		],
		mcp: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{ name: "error defaults", args: {}, result: { error: {} } },
			{
				name: "content defaults",
				args: {},
				result: {
					success: {
						isError: true,
						content: [{ text: {} }, { image: { data: "aGk=" } }, {}],
					},
				},
			},
		],
		semSearch: [{ name: "defaults", args: {}, result: { success: {} } }],
		generateImage: [{ name: "defaults", args: {}, result: { success: {} } }],
		recordScreen: [
			{
				name: "start defaults",
				args: { mode: "RECORDING_MODE_START_RECORDING" },
				result: { startSuccess: {} },
			},
			{
				name: "save defaults",
				args: { mode: "RECORDING_MODE_SAVE_RECORDING" },
				result: { saveSuccess: {} },
			},
			{
				name: "discard defaults",
				args: { mode: "RECORDING_MODE_DISCARD_RECORDING" },
				result: { discardSuccess: {} },
			},
			{
				name: "failure defaults",
				args: { mode: "RECORDING_MODE_START_RECORDING" },
				result: { failure: {} },
			},
		],
		createPlan: [{ name: "defaults", args: {}, result: { success: {} } }],
		updateTodos: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "todo defaults and enums",
				args: {
					todos: [{ content: "work", status: "TODO_STATUS_IN_PROGRESS" }, {}],
				},
				result: {
					success: {
						todos: [{ content: "done", status: "TODO_STATUS_COMPLETED" }, {}],
					},
				},
			},
		],
		computerUse: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "all actions with omitted optionals",
				args: {
					actions: [
						{ mouseMove: { coordinate: {} } },
						{ click: { button: "MOUSE_BUTTON_LEFT" } },
						{ mouseDown: {} },
						{ mouseUp: { button: 2 } },
						{ drag: { path: [{}] } },
						{ scroll: { direction: "SCROLL_DIRECTION_DOWN" } },
						{ type: {} },
						{ key: { stroke: "KEY_STROKE_UP" } },
						{ wait: {} },
						{ screenshot: {} },
						{ cursorPosition: {} },
					],
				},
				result: { success: { cursorPosition: {} } },
			},
			{
				name: "explicit optional fields",
				args: {
					description: "actions",
					actions: [
						{ click: { coordinate: { x: 1, y: 2 }, modifierKeys: "shift" } },
						{ drag: { path: [], modifierKeys: "ctrl" } },
						{ scroll: { modifierKeys: "alt" } },
						{ key: { key: "Enter", holdDurationMs: 0 } },
					],
				},
				result: {
					success: { settleMs: 0, screenshotPath: "screen.png", log: "done" },
				},
			},
			{
				name: "error defaults",
				args: {},
				result: { error: { error: "denied" } },
			},
		],
		task: [
			{ name: "defaults", args: {}, result: { success: {} } },
			{
				name: "optional arrays and enums",
				args: {
					model: "",
					attachments: [],
					respondingToMessageIds: [],
					mode: "TASK_MODE_PLAN",
					subagentType: { custom: { name: "reviewer" } },
				},
				result: {
					success: {
						backgroundReason: "SUBAGENT_BACKGROUND_REASON_AGENT_REQUEST",
						durationMs: "42",
						conversationSteps: [],
					},
				},
			},
			{ name: "error defaults", args: {}, result: { error: {} } },
		],
	};

	it.each(
		Object.entries(examples).flatMap(([kind, rows]) => [
			...rows.map((row) => ({ kind, ...row })),
			{
				kind,
				name: "empty result",
				result: {},
				args:
					kind === "recordScreen"
						? { mode: "RECORDING_MODE_START_RECORDING" }
						: {},
			},
			{
				kind,
				name: "no result",
				args:
					kind === "recordScreen"
						? { mode: "RECORDING_MODE_START_RECORDING" }
						: {},
			},
		]),
	)("matches the installed SDK for $kind: $name", ({ kind, args, ...row }) => {
		const step = {
			toolCall: {
				[`${kind}ToolCall`]: {
					args,
					...("result" in row ? { result: row.result } : {}),
				},
			},
		};
		const call = fromConversationStep(step);
		expect(call?._tag === "Known" ? call.call : null).toStrictEqual(
			sdkToolFromConversationStep(step),
		);
	});
});
