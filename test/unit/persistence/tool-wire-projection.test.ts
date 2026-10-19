// The tool wire projection (conduit-test-y7eo.6): the one rule for how a tool
// part's input and output travel to the browser, whether from a transcript
// page, a live re-read, a REST snapshot or the full-detail request.
//
// Ways it can fail, written before the module:
// 1. A never-cut kind gets cut: a question's input (its options) or a
//    subagent's output arrives as a preview, so the user answers or reads a
//    truncated thing with no way to tell.
// 2. The boundary is off by one: a field of 1,999 or 2,000 code points is cut,
//    or one of 2,001 is not.
// 3. The budget is counted in UTF-16 units or bytes instead of code points, so
//    an emoji outside the BMP sitting on the cut is split into a lone
//    surrogate, or 2,000 emoji (4,000 units) get cut.
// 4. The reported full size is in the wrong unit: code points or UTF-16 units
//    instead of UTF-8 bytes.
// 5. A cut input loses what the collapsed row shows: the file path or the
//    command's head is dropped or replaced, so the summary goes blank.
// 6. A running tool's state wins over its final result: the completed part
//    still shows the running preview, or the final result's size is stale.
// 7. The SQL cut in the transcript query and the module's own cut disagree,
//    so a page and a snapshot show different previews of the same field.
// 8. The full-detail form differs from the stored part: input re-shaped,
//    output re-decoded or cut, an emoji mangled.
// 9. The full-detail read finds the wrong tool or none: a fork's copy of the
//    same call id from another session, or nothing for a part stored without
//    a call id, which the browser names by its part id.

import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect, it } from "vitest";
import type {
	EventPayloadMap,
	LiveEventType,
	ToolStartedPayload,
} from "../../../src/lib/contracts/stored-event.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { makeReadQueryEffect } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	NEVER_CUT_TOOL_NAMES,
	PREVIEW_CODE_POINTS,
	projectTool,
	toolDetail,
} from "../../../src/lib/persistence/tool-wire-projection.js";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const codePoints = (text: string) => [...text].length;
const json = (value: unknown) => JSON.stringify(value);

describe("projectTool", () => {
	it("never cuts a question's input or a subagent's output (1)", () => {
		const options = Array.from({ length: 60 }, (_, index) => ({
			label: `Option ${index} ${"x".repeat(60)}`,
			description: "y".repeat(40),
		}));
		const longText = "z".repeat(5_000);
		for (const name of NEVER_CUT_TOOL_NAMES) {
			const input = { tool: name, questions: [{ question: "Pick", options }] };
			expect(json(input).length).toBeGreaterThan(PREVIEW_CODE_POINTS);
			expect(
				projectTool({ name, input: json(input), output: longText }),
			).toEqual({
				input: { _tag: "whole", value: input },
				output: { _tag: "whole", text: longText },
			});
		}
		expect(NEVER_CUT_TOOL_NAMES).toEqual(
			expect.arrayContaining(["AskUserQuestion", "Task", "Agent"]),
		);
	});

	it("cuts only fields over 2,000 code points (2)", () => {
		const at = (length: number) =>
			projectTool({ name: "Bash", output: "a".repeat(length) }).output;
		expect(at(1_999)).toEqual({ _tag: "whole", text: "a".repeat(1_999) });
		expect(at(2_000)).toEqual({ _tag: "whole", text: "a".repeat(2_000) });
		expect(at(2_001)).toEqual({
			_tag: "preview",
			text: "a".repeat(2_000),
			fullBytes: 2_001,
		});
	});

	it("cuts on code points, keeping an emoji whole at the cut (3, 4)", () => {
		const text = `${"a".repeat(1_999)}😀${"b".repeat(10)}`;
		const output = projectTool({ name: "Read", output: text }).output;
		expect(output).toEqual({
			_tag: "preview",
			text: `${"a".repeat(1_999)}😀`,
			fullBytes: 1_999 + 4 + 10,
		});
		expect(codePoints(output?.text ?? "")).toBe(2_000);
		expect(output?.text.at(-1)).toBe("😀".at(-1));

		// 2,000 emoji are 4,000 UTF-16 units but within budget.
		const emoji = "😀".repeat(2_000);
		expect(projectTool({ name: "Read", output: emoji }).output).toEqual({
			_tag: "whole",
			text: emoji,
		});
		const over = `${emoji}é`;
		expect(projectTool({ name: "Read", output: over }).output).toEqual({
			_tag: "preview",
			text: emoji,
			fullBytes: bytes(over),
		});
	});

	it("keeps the path and the command head of a cut input (5)", () => {
		const command = `pnpm vitest run ${"--flag ".repeat(400)}`;
		const input = {
			tool: "Bash",
			command,
			description: "Run the suite",
		};
		expect(projectTool({ name: "Bash", input: json(input) }).input).toEqual({
			_tag: "preview",
			value: { ...input, command: [...command].slice(0, 2_000).join("") },
			cuts: [{ path: ["command"], fullBytes: bytes(command) }],
		});

		const content = `// 😀 ${"x".repeat(3_000)}`;
		const write = { tool: "Write", filePath: "src/a.ts", content };
		const projected = projectTool({ name: "Write", input: json(write) }).input;
		expect(projected?._tag).toBe("preview");
		expect(projected?.value).toMatchObject({ filePath: "src/a.ts" });
		expect(projected?._tag === "preview" && projected.cuts).toEqual([
			{ path: ["content"], fullBytes: bytes(content) },
		]);

		const short = { tool: "Read", filePath: "src/a.ts" };
		expect(projectTool({ name: "Read", input: json(short) }).input).toEqual({
			_tag: "whole",
			value: short,
		});
	});

	it("trusts an output the transcript query already cut", () => {
		expect(
			projectTool({
				name: "Bash",
				output: "a".repeat(2_000),
				outputBytes: 9_000,
			}).output,
		).toEqual({ _tag: "preview", text: "a".repeat(2_000), fullBytes: 9_000 });
	});
});

describe("toolDetail", () => {
	it("returns the stored part whole (8)", () => {
		const input = {
			tool: "Write",
			filePath: "a.ts",
			content: "😀".repeat(3_000),
		};
		const output = `${"o".repeat(4_000)}😀`;
		expect(
			toolDetail({
				toolId: "call-1",
				version: 7,
				settled: true,
				input: json(input),
				output,
			}),
		).toEqual({
			toolId: "call-1",
			version: 7,
			settled: true,
			input: { _tag: "whole", value: input },
			output: { _tag: "whole", text: output },
		});
	});
});

// Through real SQLite: the transcript query's cut, the adapter and the
// detail read, against what the projectors stored.
describe("transcript query and detail read", () => {
	const SESSION = "s-wire";
	const event = <T extends LiveEventType>(type: T, data: EventPayloadMap[T]) =>
		canonicalEvent(type, SESSION, data, { provider: "claude", createdAt: 1 });
	const toolEvents = (
		messageId: string,
		callId: string,
		name: string,
		input: ToolStartedPayload["input"],
	) => [
		event("tool.started", {
			messageId,
			partId: callId,
			toolName: name,
			callId,
			input,
		}),
		event("tool.running", { messageId, partId: callId }),
	];
	const completed = (messageId: string, callId: string, result: unknown) =>
		event("tool.completed", {
			messageId,
			partId: callId,
			result,
			duration: 5,
		});

	const run = <A>(
		body: (deps: {
			readonly commit: Effect.Success<typeof makeCommitAndSignal>;
			readonly readQuery: Effect.Success<typeof makeReadQueryEffect>;
			readonly sql: SqlClient.SqlClient;
		}) => Effect.Effect<A, unknown>,
	) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const commit = yield* makeCommitAndSignal;
				const readQuery = yield* makeReadQueryEffect;
				const sql = yield* SqlClient.SqlClient;
				return yield* body({ commit, readQuery, sql });
			}).pipe(
				Effect.scoped,
				Effect.provide(makePersistenceEffectLayer(":memory:", "test-project")),
			),
		);

	const toolParts = (readQuery: Effect.Success<typeof makeReadQueryEffect>) =>
		readQuery
			.readSessionTranscriptPage(SESSION, { limit: 50, previewTools: true })
			.pipe(
				Effect.map((page) =>
					messageRowsToHistory(page.messages, {
						pageSize: page.messages.length,
					}).messages.flatMap((message) =>
						(message.parts ?? []).filter((part) => part.type === "tool"),
					),
				),
			);

	it("replaces a running tool with its final result's preview (6), and the SQL cut matches the module (7)", async () => {
		const final = `${"r".repeat(1_999)}😀${"tail".repeat(1_000)}`;
		const question = {
			tool: "AskUserQuestion" as const,
			questions: [
				{
					question: "Which?",
					options: Array.from({ length: 50 }, (_, index) => ({
						label: `${index} ${"q".repeat(60)}`,
					})),
				},
			],
		};
		const subagentReply = "s".repeat(6_000);
		const parts = await run(({ commit, readQuery }) =>
			Effect.gen(function* () {
				yield* commit([
					event("session.created", {
						sessionId: SESSION,
						title: "wire",
						provider: "claude",
						providerSessionId: SESSION,
					}),
					event("message.created", {
						messageId: "m1",
						role: "assistant",
						sessionId: SESSION,
					}),
					...toolEvents("m1", "bash-1", "Bash", {
						tool: "Bash",
						command: "make",
					}),
					...toolEvents("m1", "ask-1", "AskUserQuestion", question),
					...toolEvents("m1", "task-1", "Task", {
						tool: "Task",
						description: "Explore",
						prompt: "Look around",
					}),
					completed("m1", "task-1", subagentReply),
				]);
				const running = yield* toolParts(readQuery);
				yield* commit([completed("m1", "bash-1", final)]);
				const done = yield* toolParts(readQuery);
				return { running, done };
			}),
		);
		const byId = (list: typeof parts.done, id: string) =>
			list.find((part) => part.callID === id)?.state;
		expect(byId(parts.running, "bash-1")?.output).toBeUndefined();
		expect(byId(parts.done, "bash-1")?.output).toEqual(
			projectTool({ name: "Bash", output: final }).output,
		);
		expect(byId(parts.done, "bash-1")?.output).toEqual({
			_tag: "preview",
			text: `${"r".repeat(1_999)}😀`,
			fullBytes: bytes(final),
		});
		expect(byId(parts.done, "ask-1")?.input).toEqual({
			_tag: "whole",
			value: question,
		});
		expect(byId(parts.done, "task-1")?.output).toEqual({
			_tag: "whole",
			text: subagentReply,
		});
	});

	it("serves each requested tool as stored (8)", async () => {
		const content = `${"c".repeat(2_500)}😀`;
		const result = `${"o".repeat(3_000)}😀`;
		const { details, stored } = await run(({ commit, readQuery, sql }) =>
			Effect.gen(function* () {
				yield* commit([
					event("session.created", {
						sessionId: SESSION,
						title: "wire",
						provider: "claude",
						providerSessionId: SESSION,
					}),
					event("message.created", {
						messageId: "m1",
						role: "assistant",
						sessionId: SESSION,
					}),
					...toolEvents("m1", "write-1", "Write", {
						tool: "Write",
						filePath: "a.ts",
						content,
					}),
					completed("m1", "write-1", result),
				]);
				const details = yield* readQuery.readToolDetails(SESSION, [
					"write-1",
					"nope",
				]);
				const stored = yield* sql<{
					input: string;
				}>`SELECT input FROM message_parts WHERE call_id = 'write-1'`;
				return { details, stored };
			}),
		);
		expect(details).toEqual([
			{
				toolId: "write-1",
				version: expect.any(Number),
				settled: true,
				input: { _tag: "whole", value: JSON.parse(stored[0]?.input ?? "") },
				output: { _tag: "whole", text: result },
			},
		]);
		expect(details[0]?.input?.value).toMatchObject({ content });
	});

	it("serves the tool of the session asking, by part id when it has no call id (9)", async () => {
		const FORK = "s-fork";
		const inFork = <T extends LiveEventType>(
			type: T,
			data: EventPayloadMap[T],
		) => canonicalEvent(type, FORK, data, { provider: "claude", createdAt: 1 });
		const { parent, fork } = await run(({ commit, readQuery, sql }) =>
			Effect.gen(function* () {
				yield* commit([
					event("session.created", {
						sessionId: SESSION,
						title: "parent",
						provider: "claude",
						providerSessionId: SESSION,
					}),
					event("message.created", {
						messageId: "m1",
						role: "assistant",
						sessionId: SESSION,
					}),
					...toolEvents("m1", "dup-1", "Bash", {
						tool: "Bash",
						command: "in parent",
					}),
					inFork("session.created", {
						sessionId: FORK,
						title: "fork",
						provider: "claude",
						providerSessionId: FORK,
					}),
					inFork("message.created", {
						messageId: "m2",
						role: "assistant",
						sessionId: FORK,
					}),
					inFork("tool.started", {
						messageId: "m2",
						partId: "dup-1-fork",
						toolName: "Bash",
						callId: "dup-1",
						input: { tool: "Bash", command: "in fork" },
					}),
				]);
				// A backfilled OpenCode part may carry no callID; the browser
				// then names the tool by its part id.
				yield* sql`INSERT INTO message_parts
					(id, message_id, type, tool_name, call_id, input, result, sort_order, created_at, updated_at)
					VALUES ('legacy-1', 'm1', 'tool', 'bash', NULL, '{"command":"legacy"}', '"legacy out"', 9, 1, 1)`;
				return {
					parent: yield* readQuery.readToolDetails(SESSION, [
						"dup-1",
						"legacy-1",
					]),
					fork: yield* readQuery.readToolDetails(FORK, ["dup-1", "legacy-1"]),
				};
			}),
		);
		expect(
			parent.map(({ toolId, input }) => ({ toolId, value: input?.value })),
		).toEqual([
			{ toolId: "dup-1", value: { tool: "Bash", command: "in parent" } },
			{ toolId: "legacy-1", value: { command: "legacy" } },
		]);
		expect(parent[1]?.output).toEqual({ _tag: "whole", text: "legacy out" });
		// Started but never finished: not final.
		expect(parent[0]?.settled).toBe(false);
		expect(fork.map(({ toolId, input }) => [toolId, input?.value])).toEqual([
			["dup-1", { tool: "Bash", command: "in fork" }],
		]);
	});
});
