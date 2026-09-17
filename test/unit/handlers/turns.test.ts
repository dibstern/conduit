// ─── Turns — Unit Tests ───────────────────────────────────────────────────────
// Tests segmentTurns, turnStats/countsPhrase, step durations and economics.

import { describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	ChatMessage,
	ResultMessage,
	SystemMessage,
	ThinkingMessage,
	ToolMessage,
	UserMessage,
} from "../../../src/lib/frontend/types.js";
import {
	appendActivity,
	type ClosedSegment,
	countsPhrase,
	economics,
	fmtTokens,
	isSoloTool,
	lastResult,
	segmentTurns,
	stepDurations,
	stepWeights,
	turnDuration,
	turnStats,
} from "../../../src/lib/frontend/utils/turns.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

let seq = 0;
const id = () => `m${++seq}`;

function user(text = "do the thing", createdAt?: number): UserMessage {
	return {
		type: "user",
		uuid: id(),
		text,
		...(createdAt !== undefined ? { createdAt } : {}),
	};
}

function say(rawText = "done", createdAt?: number): AssistantMessage {
	return {
		type: "assistant",
		uuid: id(),
		rawText,
		html: `<p>${rawText}</p>`,
		finalized: true,
		...(createdAt !== undefined ? { createdAt } : {}),
	};
}

function think(createdAt?: number): ThinkingMessage {
	return {
		type: "thinking",
		uuid: id(),
		text: "hmm",
		done: true,
		...(createdAt !== undefined ? { createdAt } : {}),
	};
}

function tool(
	name: string,
	input: Record<string, unknown> = {},
	opts: {
		createdAt?: number;
		status?: ToolMessage["status"];
		isError?: boolean;
		result?: string;
	} = {},
): ToolMessage {
	const uuid = id();
	return {
		type: "tool",
		uuid,
		id: uuid,
		name,
		input,
		status: opts.status ?? "completed",
		...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
		...(opts.isError !== undefined ? { isError: opts.isError } : {}),
		...(opts.result !== undefined ? { result: opts.result } : {}),
	};
}

function result(fields: Partial<ResultMessage> = {}): ResultMessage {
	return { type: "result", uuid: id(), ...fields };
}

const system = (): SystemMessage => ({ type: "system", uuid: id(), text: "!" });

// Tool inputs are stored canonically (the provider normalizes at the boundary),
// so fixtures use the canonical discriminated shape rather than raw SDK keys.
const read = (path: string, createdAt?: number) =>
	tool(
		"Read",
		{ tool: "Read", filePath: path },
		createdAt !== undefined ? { createdAt } : {},
	);

// ─── segmentTurns ────────────────────────────────────────────────────────────

describe("segmentTurns", () => {
	it.each([
		"assistant",
		"tool",
		"thinking",
	])("reopens liveness for new %s activity after a result", (kind) => {
		const next =
			kind === "assistant" ? say() : kind === "tool" ? read("/b.ts") : think();
		const turn = segmentTurns(
			[user(), read("/a.ts"), result(), next],
			true,
		)[0]!;
		expect(turn.live).toBe(true);
		expect(turn.segments).toHaveLength(2);
	});

	it("keeps a finished segment closed without an empty trailing segment", () => {
		const end = result();
		const turn = segmentTurns(
			[user(), read("/a.ts"), say(), end, system()],
			true,
		)[0]!;
		expect(turn.live).toBe(false);
		expect(turn.segments).toHaveLength(1);
		expect(turn.segments[0]?.end).toBe(end);
	});

	it("keeps a closed segment's reply separate from later work", () => {
		const reply = say();
		const end = result({ cost: 0.02, duration: 100, createdAt: 200 });
		const next = read("/b.ts", 300);
		const turn = segmentTurns([user(undefined, 0), reply, end, next], true)[0]!;
		expect(turn.segments[0]?.reply).toEqual([reply]);
		expect(turn.segments[1]?.activity).toEqual([next]);
		expect(lastResult(turn)).toBe(end);
		expect(economics(turn, 500).cost).toBe(0.02);
		expect(turnDuration(turn, 500)).toBe(500);
	});

	it("settles again after resumed work finishes", () => {
		const end = result();
		const turn = segmentTurns(
			[user(), read("/a.ts"), result(), read("/b.ts"), end],
			true,
		)[0]!;
		expect(turn.live).toBe(false);
		expect(turn.segments).toHaveLength(2);
		expect(turn.segments[1]?.end).toBe(end);
	});

	it("does not open a segment for consecutive result metadata", () => {
		const end = result({ duration: 100 });
		const turn = segmentTurns([user(), read("/a.ts"), result(), end], true)[0]!;
		expect(turn.segments).toHaveLength(1);
		expect(lastResult(turn)).toBe(end);
		expect(turn.live).toBe(false);
	});

	it("refuses to append activity to a closed segment at compile time", () => {
		const segment: ClosedSegment = { activity: [], reply: [], end: result() };
		// This branch is checked by pnpm check, but never mutates the fixture.
		// biome-ignore lint/correctness/noConstantCondition: compile-fail assertions must not execute.
		if (false) {
			// @ts-expect-error A closed segment cannot enter the append path.
			appendActivity(segment, read("/a.ts"));
			// @ts-expect-error Closed activity cannot be appended directly either.
			segment.activity.push(read("/a.ts"));
			// @ts-expect-error Closing a segment cannot be undone by replacing activity.
			segment.activity = [];
		}
		expect(segment.activity).toEqual([]);
	});

	it("closes a live segment at a pending question", () => {
		const text = say("Which option?");
		const question = tool(
			"AskUserQuestion",
			{ questions: [] },
			{ status: "running" },
		);
		const turn = segmentTurns([user(), text, question], true)[0];

		expect(turn?.segments).toEqual([
			{ activity: [], reply: [text], handBack: question, end: question },
		]);
		expect(turn?.live).toBe(false);
	});

	it("keeps system messages out of the activity log, as turn notices", () => {
		const u = user();
		const note = system();
		const turn = segmentTurns([u, read("/a.ts"), note], false)[0];
		expect(turn?.segments[0]?.activity).toHaveLength(1);
		expect(turn?.notices).toEqual([note]);
	});

	it("splits a prompt, its work and its trailing reply into one turn", () => {
		const u = user();
		const r = read("/a.ts");
		const reply = say("all done");
		const res = result({ cost: 0.01 });
		const turns = segmentTurns([u, r, reply, res], false);

		expect(turns).toHaveLength(1);
		expect(turns[0]?.user).toBe(u);
		expect(turns[0]?.segments[0]?.activity).toEqual([r]);
		expect(turns[0]?.segments[0]?.reply).toEqual([reply]);
		expect(turns[0]?.segments[0]?.end).toBe(res);
	});

	it("starts a new turn at every user message", () => {
		const messages: ChatMessage[] = [
			user("one"),
			say("a"),
			user("two"),
			say("b"),
		];
		const turns = segmentTurns(messages, false);
		expect(turns).toHaveLength(2);
		expect(turns.map((t) => t.user?.text)).toEqual(["one", "two"]);
		expect(turns.map((t) => t.segments[0]?.reply[0]?.rawText)).toEqual([
			"a",
			"b",
		]);
	});

	it("keeps narration before work in activity and the trailing text in reply", () => {
		const narration = say("let me look at this first");
		const reply = say("here is what I found");
		const turns = segmentTurns(
			[user(), narration, read("/a.ts"), reply],
			false,
		);
		expect(turns[0]?.segments[0]?.reply).toEqual([reply]);
		expect(turns[0]?.segments[0]?.activity.map((p) => p.uuid)).toContain(
			narration.uuid,
		);
	});

	it("folds trailing text back into activity once a tool follows it", () => {
		const text = say("checking the config");
		const before = segmentTurns([user(), text], true);
		expect(before[0]?.segments[0]?.reply).toEqual([text]);
		expect(before[0]?.segments[0]?.activity).toEqual([]);

		const after = segmentTurns([user(), text, read("/config.ts")], true);
		expect(after[0]?.segments[0]?.reply).toEqual([]);
		expect(after[0]?.segments[0]?.activity.map((p) => p.uuid)).toEqual([
			text.uuid,
			after[0]?.segments[0]?.activity[1]?.uuid,
		]);
	});

	it("keeps the same pending question shape when the turn is historical", () => {
		const text = say("Which option?");
		const question = tool(
			"AskUserQuestion",
			{ questions: [] },
			{ status: "completed", result: "Option A" },
		);
		const turn = segmentTurns([user(), text, question], false)[0];

		expect(turn?.segments).toEqual([
			{ activity: [], reply: [text], handBack: question, end: question },
		]);
		expect(turn?.live).toBe(false);
	});

	it("continues in a new segment after an answered question", () => {
		const a = say("I need a choice");
		const question = tool("AskUserQuestion", { questions: [] });
		const file = read("/a.ts");
		const b = say("Done");
		const turn = segmentTurns([user(), a, question, file, b], false)[0];

		expect(turn?.segments).toEqual([
			{ activity: [], reply: [a], handBack: question, end: question },
			{ activity: [file], reply: [b] },
		]);
	});

	it("folds narration before a tool into activity before handing back", () => {
		const text = say("I will check first");
		const file = read("/a.ts");
		const question = tool("AskUserQuestion", { questions: [] });
		const turn = segmentTurns([user(), text, file, question], false)[0];

		expect(turn?.segments[0]).toEqual({
			activity: [text, file],
			reply: [],
			handBack: question,
			end: question,
		});
	});

	it("demotes text followed by thinking before a hand-back", () => {
		const text = say("Let me reason about that");
		const thought = think();
		const question = tool("AskUserQuestion", { questions: [] });
		const turn = segmentTurns([user(), text, thought, question], false)[0];

		// Thinking after text deliberately makes that text narration, not a reply.
		expect(turn?.segments[0]).toEqual({
			activity: [text, thought],
			reply: [],
			handBack: question,
			end: question,
		});
	});

	it("keeps a trailing run of assistant text in order", () => {
		const a = say("A");
		const b = say("B");
		const turn = segmentTurns([user(), a, b], false)[0];

		expect(turn?.segments[0]?.reply).toEqual([a, b]);
	});

	it("treats ExitPlanMode as a hand-back", () => {
		const text = say("The plan is ready");
		const exit = tool("ExitPlanMode");
		const turn = segmentTurns([user(), text, exit], false)[0];

		expect(turn?.segments).toEqual([
			{ activity: [], reply: [text], handBack: exit, end: exit },
		]);
	});

	it("opens a new segment after every question", () => {
		const a = say("First");
		const first = tool("AskUserQuestion");
		const b = say("Second");
		const second = tool("AskUserQuestion");
		const turn = segmentTurns([user(), a, first, b, second], false)[0];

		expect(turn?.segments).toEqual([
			{ activity: [], reply: [a], handBack: first, end: first },
			{ activity: [], reply: [b], handBack: second, end: second },
		]);
	});

	it("opens a synthetic turn when the transcript starts mid-turn", () => {
		const r = read("/a.ts");
		const turns = segmentTurns([r, say("done")], false);
		expect(turns).toHaveLength(1);
		expect(turns[0]?.user).toBeUndefined();
		expect(turns[0]?.id).toBe(`turn-${r.uuid}`);
		expect(turns[0]?.segments[0]?.activity).toEqual([r]);
	});

	it("closes the segment with its result, not activity", () => {
		const res = result({ cost: 0.02 });
		const turns = segmentTurns([user(), read("/a.ts"), res], false);
		expect(turns[0]?.segments[0]?.end).toBe(res);
		expect(turns[0]?.segments[0]?.activity).toHaveLength(1);
	});

	it("marks only the last turn live, and only while processing", () => {
		const messages: ChatMessage[] = [
			user("one"),
			say("a"),
			user("two"),
			read("/a.ts"),
		];
		expect(segmentTurns(messages, true).map((t) => t.live)).toEqual([
			false,
			true,
		]);
		expect(segmentTurns(messages, false).map((t) => t.live)).toEqual([
			false,
			false,
		]);
	});

	it("does not mark a turn live once its result has landed", () => {
		const turns = segmentTurns([user(), read("/a.ts"), result()], true);
		expect(turns[0]?.live).toBe(false);
	});

	it("returns no turns for an empty transcript", () => {
		expect(segmentTurns([], true)).toEqual([]);
	});
});

// ─── turnStats / countsPhrase ────────────────────────────────────────────────

describe("turnStats", () => {
	it("counts files uniquely and buckets tools by what they do", () => {
		const s = turnStats({
			activity: [
				read("/a.ts"),
				read("/a.ts"),
				read("/b.ts"),
				tool("Edit", {
					tool: "Edit",
					filePath: "/a.ts",
					oldString: "x",
					newString: "y",
				}),
				tool("Write", { tool: "Write", filePath: "/a.ts", content: "z" }),
				tool("Grep", { tool: "Grep", pattern: "foo" }),
				tool("Bash", { tool: "Bash", command: "ls" }),
				tool("WebFetch", { tool: "WebFetch", url: "https://example.com" }),
				think(),
			],
			reply: [],
		});
		expect(s.reads).toBe(2); // /a.ts read twice, counted once
		expect(s.edits).toBe(1); // Edit + Write on the same file
		expect(s.searches).toBe(1);
		expect(s.commands).toBe(1);
		expect(s.fetches).toBe(1);
		expect(s.thinking).toBe(1);
		expect(s.tools).toBe(8);
	});

	it("names skills instead of lumping them into 'other'", () => {
		const s = turnStats({
			activity: [
				tool("Skill", { tool: "Skill", name: "brainstorm" }),
				tool("Skill", { tool: "Skill", name: "tdd" }),
			],
			reply: [],
		});
		expect(s.skills).toBe(2);
		expect(s.others).toBe(0);
	});

	it("counts failures from either the status or the error flag", () => {
		const s = turnStats({
			activity: [
				tool("Bash", { tool: "Bash", command: "false" }, { status: "error" }),
				tool("Bash", { tool: "Bash", command: "nope" }, { isError: true }),
				tool("Bash", { tool: "Bash", command: "ls" }),
			],
			reply: [],
		});
		expect(s.failed).toBe(2);
	});
});

describe("countsPhrase", () => {
	it("reads as a sentence fragment in a fixed order", () => {
		const phrase = countsPhrase(
			turnStats({
				activity: [
					read("/a.ts"),
					read("/b.ts"),
					tool("Grep", { tool: "Grep", pattern: "x" }),
					tool("Edit", {
						tool: "Edit",
						filePath: "/a.ts",
						oldString: "x",
						newString: "y",
					}),
					tool("Bash", { tool: "Bash", command: "ls" }),
				],
				reply: [],
			}),
		);
		expect(phrase).toBe("2 reads · 1 search · 1 edit · 1 command");
	});

	it("places skills between fetches and subagents", () => {
		expect(
			countsPhrase(
				turnStats({
					activity: [
						tool("WebFetch", { tool: "WebFetch", url: "https://example.com" }),
						tool("Skill", { tool: "Skill", name: "tdd" }),
						tool("Task", { tool: "Task", description: "go", prompt: "p" }),
					],
					reply: [],
				}),
			),
		).toBe("1 fetch · 1 skill · 1 subagent");
	});

	it("falls back to thoughts, then to 'no tools'", () => {
		expect(
			countsPhrase(turnStats({ activity: [think(), think()], reply: [] })),
		).toBe("2 thoughts");
		expect(countsPhrase(turnStats({ activity: [], reply: [] }))).toBe(
			"no tools",
		);
	});
});

// ─── Timing ──────────────────────────────────────────────────────────────────

describe("stepDurations", () => {
	it("runs each step until the next starts, and the last until the reply", () => {
		const turns = segmentTurns(
			[
				user(undefined, 0),
				read("/a.ts", 1_000),
				read("/b.ts", 3_000),
				say("done", 8_000),
			],
			false,
		);
		const turn = turns[0]!;
		expect(stepDurations(turn.segments[0]!, turn, true, 0)).toEqual([
			2_000, 5_000,
		]);
	});

	it("runs the last step until now while the turn is live", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000)],
			true,
		);
		const turn = turns[0]!;
		expect(stepDurations(turn.segments[0]!, turn, true, 6_000)).toEqual([
			5_000,
		]);
	});

	it("reports unknown rather than guessing when a timestamp is missing", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts"), say("done", 5_000)],
			false,
		);
		const turn = turns[0]!;
		expect(stepDurations(turn.segments[0]!, turn, true, 0)).toBeUndefined();
	});

	it("never returns a negative duration for out-of-order stamps", () => {
		const turns = segmentTurns(
			[
				user(undefined, 0),
				read("/a.ts", 5_000),
				read("/b.ts", 1_000),
				say("d", 9_000),
			],
			false,
		);
		const turn = turns[0]!;
		expect(
			stepDurations(turn.segments[0]!, turn, true, 0)?.every((d) => d >= 0),
		).toBe(true);
	});

	it("stops the last step at the reply, not at now, once the reply streams", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), say("streaming…", 3_000)],
			true,
		);
		// The tool finished when the reply began; it must not keep growing.
		const turn = turns[0]!;
		expect(stepDurations(turn.segments[0]!, turn, true, 10_000)).toEqual([
			2_000,
		]);
	});

	it("ends a non-final segment's last step at its hand-back", () => {
		const question = tool("AskUserQuestion", {}, { createdAt: 4_000 });
		const turn = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), question, say("done", 8_000)],
			false,
		)[0]!;

		expect(stepDurations(turn.segments[0]!, turn, false, 10_000)).toEqual([
			3_000,
		]);
	});
});

describe("stepWeights", () => {
	it("falls back to equal widths when durations are unknown", () => {
		const turns = segmentTurns([user(), read("/a.ts"), read("/b.ts")], false);
		const turn = turns[0]!;
		expect(stepWeights(turn.segments[0]!, turn, true, 0)).toEqual([1, 1]);
	});

	it("gives every step a floor so brief steps stay visible", () => {
		const turns = segmentTurns(
			[
				user(undefined, 0),
				read("/a.ts", 1_000),
				read("/b.ts", 1_010),
				say("d", 9_000),
			],
			false,
		);
		const turn = turns[0]!;
		expect(stepWeights(turn.segments[0]!, turn, true, 0)).toEqual([300, 7_990]);
	});
});

describe("turnDuration", () => {
	it("prefers the duration the provider reported", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), result({ duration: 42_300 })],
			false,
		);
		expect(turnDuration(turns[0]!, 0)).toBe(42_300);
	});

	it("measures against now while live", () => {
		const turns = segmentTurns(
			[user(undefined, 1_000), read("/a.ts", 2_000)],
			true,
		);
		expect(turnDuration(turns[0]!, 6_000)).toBe(5_000);
	});

	it("is unknown when nothing carries a timestamp", () => {
		const turns = segmentTurns([user(), read("/a.ts")], false);
		expect(turnDuration(turns[0]!, 0)).toBeUndefined();
	});

	it("keeps a reported duration of zero instead of re-deriving one", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), result({ duration: 0 })],
			false,
		);
		expect(turnDuration(turns[0]!, 0)).toBe(0);
	});

	it("is unknown rather than negative when stamps arrive out of order", () => {
		const turns = segmentTurns(
			[user(undefined, 5_000), read("/a.ts", 6_000), say("d", 1_000)],
			false,
		);
		expect(turnDuration(turns[0]!, 0)).toBeUndefined();
	});
});

// ─── Economics ───────────────────────────────────────────────────────────────

describe("economics", () => {
	const withResult = (fields: Partial<ResultMessage>) =>
		economics(
			segmentTurns([user(), read("/a.ts"), result(fields)], false)[0]!,
			0,
		);

	it("sums fresh input, cache reads and cache writes into context used", () => {
		const e = withResult({
			inputTokens: 2_311,
			outputTokens: 1_311,
			cacheRead: 41_900,
			cacheWrite: 3_100,
			context_window: 200_000,
		});
		expect(e.context).toEqual({ used: 47_311, window: 200_000, pct: 24 });
		expect(e.tokensIn).toBe(2_311);
		expect(e.tokensOut).toBe(1_311);
	});

	it("omits the context reading entirely when no window is reported", () => {
		const e = withResult({ inputTokens: 2_311, cacheRead: 41_900 });
		expect(e.context).toBeUndefined();
		expect(e.tokensIn).toBe(2_311);
	});

	it("omits the context reading when no token counts are reported", () => {
		expect(withResult({ context_window: 200_000 }).context).toBeUndefined();
	});

	it("treats a zero window as unreported rather than dividing by it", () => {
		expect(
			withResult({ inputTokens: 10, context_window: 0 }).context,
		).toBeUndefined();
	});

	it("caps the percentage at 100 when context overflows the window", () => {
		const e = withResult({ inputTokens: 250_000, context_window: 200_000 });
		expect(e.context?.pct).toBe(100);
	});

	it("is empty for a turn that never produced a result", () => {
		const turns = segmentTurns([user(), read("/a.ts")], true);
		const e = economics(turns[0]!, 0);
		expect(e.cost).toBeUndefined();
		expect(e.context).toBeUndefined();
	});
});

describe("fmtTokens", () => {
	it("keeps small counts exact and abbreviates larger ones", () => {
		expect(fmtTokens(880)).toBe("880");
		expect(fmtTokens(1_311)).toBe("1.3k");
		expect(fmtTokens(47_311)).toBe("47k");
		expect(fmtTokens(1_200_000)).toBe("1.2M");
	});
});

describe("isSoloTool", () => {
	it("protects tools that own an interactive card", () => {
		expect(isSoloTool(tool("AskUserQuestion"))).toBe(false);
		expect(isSoloTool(tool("Skill"))).toBe(true);
		expect(isSoloTool(tool("Task"))).toBe(true);
		expect(isSoloTool(tool("Read"))).toBe(false);
	});
});
