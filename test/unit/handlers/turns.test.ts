// Tests segmentTurns, turnStats/countsPhrase, step durations and economics.

import { assert, describe, expect, it } from "vitest";
import { segmentAppearance } from "../../../src/lib/frontend/components/chat/activity-style.js";
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
	type ActivityPart,
	appendActivity,
	type ClosedSegment,
	type CompactionPart,
	countsPhrase,
	economics,
	fmtTokens,
	forkMessageIdAtReply,
	isSoloTool,
	LAUNCH_SETTLE_MS,
	lastResult,
	launchMeta,
	launchRow,
	launchUsage,
	liveLaunchedTasks,
	partLabel,
	segmentTurns,
	skillChapters,
	skillName,
	stepDurations,
	stepWeights,
	type Turn,
	turnStats,
	workingTime,
} from "../../../src/lib/frontend/utils/turns.js";

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
		outcome?: ToolMessage["outcome"];
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
		...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
		...(opts.result !== undefined ? { result: opts.result } : {}),
	};
}

function result(fields: Partial<ResultMessage> = {}): ResultMessage {
	return { type: "result", uuid: id(), ...fields };
}

const system = (): SystemMessage => ({ type: "system", uuid: id(), text: "!" });

function compaction(
	state: NonNullable<SystemMessage["compaction"]> = "completed",
	fields: Partial<SystemMessage> = {},
): SystemMessage {
	return {
		type: "system",
		uuid: id(),
		text: "Context compacted",
		compaction: state,
		...fields,
	};
}

/** A completed compaction, typed as the activity part it becomes. */
function compacted(): CompactionPart {
	return { ...compaction(), compaction: "completed" };
}

// Tool inputs are stored canonically (the provider normalizes at the boundary),
// so fixtures use the canonical discriminated shape rather than raw SDK keys.
const read = (path: string, createdAt?: number) =>
	tool(
		"Read",
		{ tool: "Read", filePath: path },
		createdAt !== undefined ? { createdAt } : {},
	);

describe("forkMessageIdAtReply", () => {
	it.each([
		"tool",
		"thinking",
		"text",
	] as const)("uses the preceding %s part when the reply has no id", (kind) => {
		const previous =
			kind === "tool"
				? read("/a.ts")
				: kind === "thinking"
					? think()
					: say("Working");
		previous.messageId = `${kind}-id`;
		const reply = say();
		const between = kind === "text" ? read("/a.ts") : undefined;
		const [turn] = segmentTurns(
			[user(), previous, ...(between ? [between] : []), reply],
			false,
		);
		assert.exists(turn, "expected turn");
		expect(forkMessageIdAtReply(turn, reply)).toBe(`${kind}-id`);
	});

	it("does not use ids after an earlier segment's reply", () => {
		const reply = say();
		const end = result({ messageId: "end-id" });
		const later = say("Later");
		later.messageId = "later-id";
		const [turn] = segmentTurns([user(), reply, end, later], false);
		assert.exists(turn, "expected turn");
		expect(forkMessageIdAtReply(turn, reply)).toBeUndefined();
		expect(forkMessageIdAtReply(turn, later)).toBe("later-id");
	});

	it("uses an earlier segment end and returns undefined when no id exists", () => {
		const first = say("First");
		const second = say("Second");
		const [withEnd] = segmentTurns(
			[user(), first, result({ messageId: "end-id" }), second],
			false,
		);
		assert.exists(withEnd, "expected turn");
		expect(forkMessageIdAtReply(withEnd, second)).toBe("end-id");
		const noId = say();
		const [turnWithoutId] = segmentTurns([user(), noId], false);
		assert.exists(turnWithoutId, "expected turn");
		expect(forkMessageIdAtReply(turnWithoutId, noId)).toBeUndefined();
	});

	it("uses a hand-back id from an earlier segment", () => {
		const question = tool("AskUserQuestion", { questions: [] });
		question.messageId = "hand-back-id";
		const reply = say();
		const [turn] = segmentTurns(
			[user(), say("Question"), question, reply],
			false,
		);
		assert.exists(turn, "expected turn");
		expect(forkMessageIdAtReply(turn, reply)).toBe("hand-back-id");
	});
});

describe("segmentTurns", () => {
	it.each([
		"assistant",
		"tool",
		"thinking",
	])("reopens liveness for new %s activity after a result", (kind) => {
		const next =
			kind === "assistant" ? say() : kind === "tool" ? read("/b.ts") : think();
		const [turn] = segmentTurns([user(), read("/a.ts"), result(), next], true);
		assert.exists(turn, "expected turn");
		expect(turn.live).toBe(true);
		expect(turn.segments).toHaveLength(2);
	});

	it("keeps a finished segment closed without an empty trailing segment", () => {
		const end = result();
		const [turn] = segmentTurns(
			[user(), read("/a.ts"), say(), end, system()],
			true,
		);
		assert.exists(turn, "expected turn");
		expect(turn.live).toBe(false);
		expect(turn.segments).toHaveLength(1);
		expect(turn.segments[0]?.end).toBe(end);
	});

	it("keeps a closed segment's reply separate from later work", () => {
		const reply = say();
		const end = result({ cost: 0.02, duration: 100, createdAt: 200 });
		const next = read("/b.ts", 300);
		const [turn] = segmentTurns([user(undefined, 0), reply, end, next], true);
		assert.exists(turn, "expected turn");
		expect(turn.segments[0]?.reply).toEqual([reply]);
		expect(turn.segments[1]?.activity).toEqual([next]);
		expect(lastResult(turn)).toBe(end);
		expect(economics(turn, 500).cost).toBe(0.02);
		expect(workingTime(turn, 500)).toBe(400);
	});

	it("settles again after resumed work finishes", () => {
		const end = result();
		const [turn] = segmentTurns(
			[user(), read("/a.ts"), result(), read("/b.ts"), end],
			true,
		);
		assert.exists(turn, "expected turn");
		expect(turn.live).toBe(false);
		expect(turn.segments).toHaveLength(2);
		expect(turn.segments[1]?.end).toBe(end);
	});

	it("does not open a segment for consecutive result metadata", () => {
		const end = result({ duration: 100 });
		const [turn] = segmentTurns([user(), read("/a.ts"), result(), end], true);
		assert.exists(turn, "expected turn");
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

	it("counts failures from the typed outcome regardless of status", () => {
		const s = turnStats({
			activity: [
				tool(
					"Bash",
					{ tool: "Bash", command: "false" },
					{ status: "error", outcome: "failed" },
				),
				tool("Bash", { tool: "Bash", command: "nope" }, { outcome: "failed" }),
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

	it("leaves skills to their own control", () => {
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
		).toBe("1 fetch · 1 subagent");
		expect(
			countsPhrase(
				turnStats({
					activity: [tool("Skill", { tool: "Skill", name: "tdd" })],
					reply: [],
				}),
			),
		).toBe("");
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
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 0)).toEqual([2_000, 5_000]);
	});

	it("runs the last step until now while the turn is live", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000)],
			true,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 6_000)).toEqual([5_000]);
	});

	it("reports unknown rather than guessing when a timestamp is missing", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts"), say("done", 5_000)],
			false,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 0)).toBeUndefined();
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
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 0)?.every((d) => d >= 0)).toBe(
			true,
		);
	});

	it("stops the last step at the reply, not at now, once the reply streams", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), say("streaming…", 3_000)],
			true,
		);
		// The tool finished when the reply began; it must not keep growing.
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 10_000)).toEqual([2_000]);
	});

	it("ends a non-final segment's last step at its hand-back", () => {
		const question = tool("AskUserQuestion", {}, { createdAt: 4_000 });
		const [turn] = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), question, say("done", 8_000)],
			false,
		);
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");

		expect(stepDurations(segment, turn, false, 10_000)).toEqual([3_000]);
	});
});

describe("stepWeights", () => {
	it("falls back to equal widths when durations are unknown", () => {
		const turns = segmentTurns([user(), read("/a.ts"), read("/b.ts")], false);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepWeights(segment, turn, true, 0)).toEqual([1, 1]);
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
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepWeights(segment, turn, true, 0)).toEqual([300, 7_990]);
	});
});

describe("workingTime", () => {
	it("excludes every idle gap, starting after the result rather than the reply", () => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				read("/a.ts", 1_000),
				say("First reply", 3_000),
				result({ createdAt: 4_000 }),
				think(20_000),
				read("/b.ts", 21_000),
				say("Second reply", 24_000),
				result({ createdAt: 25_000 }),
				read("/c.ts", 40_000),
				result({ createdAt: 44_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 100_000)).toBe(13_000);
		expect(workingTime(turn, 200_000)).toBe(13_000);
	});

	it.each([
		["activity", [think(8_000), read("/b.ts", 9_000)], 4_000],
		["reply", [say("Awake", 8_000)], 4_000],
		["hand-back", [tool("AskUserQuestion", {}, { createdAt: 8_000 })], 4_000],
		["compaction", [compaction("completed", { createdAt: 8_000 })], 4_000],
		["later stamped activity", [think(), read("/b.ts", 8_000)], 4_000],
	] satisfies [
		string,
		ChatMessage[],
		number,
	][])("finds the wake-up's first stamp in %s", (_name, wakeUp, expected) => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				result({ createdAt: 2_000 }),
				...wakeUp,
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(expected);
	});

	it("keeps the result boundary when a background task completes after it", () => {
		const launch = read("/a.ts", 1_000);
		launch.metadata = {
			backgrounded: true,
			providerTaskId: "task-shell",
			outcome: "completed",
		};
		launch.endedAt = 9_000;
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				launch,
				result({ createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(4_000);
		expect(economics(turn, 50_000).duration).toBe(4_000);
	});

	it("uses a tool's completion when the preceding result has no stamp", () => {
		const work = read("/a.ts", 1_000);
		work.endedAt = 4_000;
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				work,
				result(),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(6_000);
	});

	it.each([
		["contained approval", [{ from: 3_000, to: 7_000 }], 4_000],
		["containing approval", [{ from: 1_000, to: 9_000 }], 2_000],
		["overlapping approval", [{ from: 1_000, to: 4_000 }], 3_000],
		["open approval", [{ from: 4_000 }], 2_000],
		[
			"adjacent approvals",
			[
				{ from: 8_000, to: 9_000 },
				{ from: 1_000, to: 2_000 },
			],
			2_000,
		],
		[
			"out-of-range approvals",
			[
				{ from: -2_000, to: 1_000 },
				{ from: 9_000, to: 12_000 },
			],
			2_000,
		],
	] satisfies [
		string,
		{ from: number; to?: number }[],
		number,
	][])("subtracts the union of the gap and %s without mutating waits", (_name, waits, expected) => {
		const prompt = user(undefined, 0);
		const approvals = waits.map((wait, index) => ({
			...wait,
			id: `approval-${index}`,
		}));
		prompt.turnTiming = { startedAt: 0, endedAt: 10_000, waits: approvals };
		const original = structuredClone(prompt.turnTiming);
		Object.freeze(approvals);
		const [turn] = segmentTurns(
			[
				prompt,
				read("/a.ts", 1_000),
				result({ createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(expected);
		expect(prompt.turnTiming).toEqual(original);
	});

	it("clips an open wait spanning several gaps only once", () => {
		const prompt = user(undefined, 0);
		prompt.turnTiming = {
			startedAt: 0,
			waits: [{ id: "approval", from: 1_000 }],
		};
		const [turn] = segmentTurns(
			[
				prompt,
				result({ createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
				read("/c.ts", 12_000),
			],
			true,
		);
		assert.exists(turn);
		expect(workingTime(turn, 15_000)).toBe(1_000);
		expect(workingTime(turn, 15_000, 5_000)).toBe(1_000);
	});

	it.each([
		[0, 0],
		[1_000, 1_000],
		[2_000, 2_000],
		[5_000, 2_000],
		[8_000, 2_000],
		[9_000, 3_000],
		[20_000, 4_000],
	])("clips working time at %i, including inside a gap", (until, expected) => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				result({ createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000, until)).toBe(expected);
	});

	it("keeps the open final segment working after excluding its preceding gap", () => {
		const [turn] = segmentTurns(
			[user(undefined, 0), result({ createdAt: 2_000 }), read("/b.ts", 8_000)],
			true,
		);
		assert.exists(turn);
		expect(workingTime(turn, 10_000)).toBe(4_000);
		expect(workingTime(turn, 12_000)).toBe(6_000);
	});

	it.each([
		"AskUserQuestion",
		"ExitPlanMode",
	])("excludes the gap following %s", (name) => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				tool(name, {}, { createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(4_000);
	});

	it.each([
		0, 1_000, 2_000,
	])("ignores zero or overlapping gaps starting at %i", (createdAt) => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				result({ createdAt: 2_000 }),
				read("/b.ts", createdAt),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(10_000);
	});

	it("does not invent a gap across an entirely unstamped segment", () => {
		const [turn] = segmentTurns(
			[
				user(undefined, 0),
				result({ createdAt: 2_000 }),
				read("/b.ts"),
				result(),
				read("/c.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(10_000);
	});

	it("clips gaps to the persisted turn bounds", () => {
		const prompt = user(undefined, 0);
		prompt.turnTiming = { startedAt: 4_000, endedAt: 9_000, waits: [] };
		const [turn] = segmentTurns(
			[
				prompt,
				result({ createdAt: 2_000 }),
				read("/b.ts", 8_000),
				result({ createdAt: 10_000 }),
			],
			false,
		);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBe(1_000);
	});

	it("keeps an empty turn's duration unknown", () => {
		const [turn] = segmentTurns([user(undefined, 0)], false);
		assert.exists(turn);
		expect(workingTime(turn, 50_000)).toBeUndefined();
	});

	it("uses stamped work instead of the duration the provider reported", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), result({ duration: 42_300 })],
			false,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		expect(workingTime(turn, 0)).toBe(1_000);
	});

	it("measures against now while live", () => {
		const turns = segmentTurns(
			[user(undefined, 1_000), read("/a.ts", 2_000)],
			true,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		expect(workingTime(turn, 6_000)).toBe(5_000);
	});

	it("is unknown when nothing carries a timestamp", () => {
		const turns = segmentTurns([user(), read("/a.ts")], false);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		expect(workingTime(turn, 0)).toBeUndefined();
	});

	it("does not replace stamped work with a provider duration of zero", () => {
		const turns = segmentTurns(
			[user(undefined, 0), read("/a.ts", 1_000), result({ duration: 0 })],
			false,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		expect(workingTime(turn, 0)).toBe(1_000);
	});

	it("uses the latest stamp when messages arrive out of order", () => {
		const turns = segmentTurns(
			[user(undefined, 5_000), read("/a.ts", 6_000), say("d", 1_000)],
			false,
		);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		expect(workingTime(turn, 0)).toBe(1_000);
	});
});

describe("economics", () => {
	const withResult = (fields: Partial<ResultMessage>) => {
		const [turn] = segmentTurns([user(), read("/a.ts"), result(fields)], false);
		assert.exists(turn, "expected turn");
		return economics(turn, 0);
	};

	it("sums tokens across segments while using only the last result's context", () => {
		const [turn] = segmentTurns(
			[
				user(),
				read("/a.ts"),
				result({
					inputTokens: 100,
					outputTokens: 200,
					cacheRead: 5_000,
					cacheWrite: 1_000,
					context_window: 100_000,
				}),
				read("/b.ts"),
				tool("AskUserQuestion"),
				read("/c.ts"),
				result({
					inputTokens: 20,
					outputTokens: 30,
					cacheRead: 2_000,
					cacheWrite: 300,
					context_window: 10_000,
				}),
			],
			false,
		);
		assert.exists(turn);
		expect(economics(turn, 0)).toMatchObject({
			tokensIn: 120,
			tokensOut: 230,
			context: { used: 2_320, window: 10_000, pct: 23 },
		});
	});

	it.each([
		[
			"input only",
			[{ inputTokens: 10 }, {}, { inputTokens: 0 }],
			10,
			undefined,
		],
		[
			"output only",
			[{ outputTokens: 20 }, {}, { outputTokens: 0 }],
			undefined,
			20,
		],
		[
			"separate counters",
			[{ inputTokens: 10 }, { outputTokens: 20 }, {}],
			10,
			20,
		],
		["reported zeros", [{ inputTokens: 0, outputTokens: 0 }, {}], 0, 0],
		["no usage", [{}, {}], undefined, undefined],
	] satisfies [
		string,
		Partial<ResultMessage>[],
		number | undefined,
		number | undefined,
	][])("preserves missing and zero token counts for %s", (_name, results, tokensIn, tokensOut) => {
		const [turn] = segmentTurns(
			[user(), ...results.flatMap((fields) => [read("/a.ts"), result(fields)])],
			false,
		);
		assert.exists(turn);
		const bill = economics(turn, 0);
		expect(bill.tokensIn).toBe(tokensIn);
		expect(bill.tokensOut).toBe(tokensOut);
		expect(bill.context).toBeUndefined();
	});

	it("retains previous segment totals and context while a wake-up is live", () => {
		const [turn] = segmentTurns(
			[
				user(),
				read("/a.ts"),
				result({ inputTokens: 10, outputTokens: 20 }),
				read("/b.ts"),
				result({ inputTokens: 30, outputTokens: 40, context_window: 100 }),
				read("/c.ts"),
			],
			true,
		);
		assert.exists(turn);
		expect(economics(turn, 0)).toMatchObject({
			tokensIn: 40,
			tokensOut: 60,
			context: { used: 30, window: 100, pct: 30 },
		});
	});

	it.each([
		{},
		{ inputTokens: 2 },
		{ inputTokens: 2, context_window: 0 },
	])("does not reuse an earlier context when the last result lacks a reading: %j", (last) => {
		const [turn] = segmentTurns(
			[
				user(),
				read("/a.ts"),
				result({ inputTokens: 10, outputTokens: 20, context_window: 100 }),
				read("/b.ts"),
				result(last),
			],
			false,
		);
		assert.exists(turn);
		expect(economics(turn, 0).context).toBeUndefined();
	});

	it("keeps token totals scoped to one user turn", () => {
		const turns = segmentTurns(
			[
				user(),
				read("/a.ts"),
				result({ inputTokens: 10, outputTokens: 20 }),
				user(),
				read("/b.ts"),
				result({ inputTokens: 30, outputTokens: 40 }),
			],
			false,
		);
		expect(turns.map((turn) => economics(turn, 0))).toEqual([
			{ tokensIn: 10, tokensOut: 20 },
			{ tokensIn: 30, tokensOut: 40 },
		]);
	});

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

	it("sums result usage across segments but takes only the final explicit context", () => {
		const [turn] = segmentTurns(
			[
				user(),
				read("/a.ts"),
				result({
					inputTokens: 500,
					outputTokens: 20_000,
					contextTokens: 111_530,
					context_window: 200_000,
				}),
				read("/b.ts"),
				result({
					inputTokens: 10,
					outputTokens: 50,
					cacheRead: 900_000,
					cacheWrite: 20_000,
					contextTokens: 40_000,
					context_window: 200_000,
				}),
			],
			false,
		);
		assert.exists(turn);
		expect(economics(turn, 0)).toMatchObject({
			tokensIn: 510,
			tokensOut: 20_050,
			context: { used: 40_000, window: 200_000, pct: 20 },
		});
	});

	it.each([
		0, 40_000,
	])("uses explicit context %s even without usage counts", (contextTokens) => {
		expect(
			withResult({ contextTokens, context_window: 200_000 }).context,
		).toEqual({
			used: contextTokens,
			window: 200_000,
			pct: Math.round((contextTokens / 200_000) * 100),
		});
	});

	it("omits the context reading when neither occupancy nor a window is reported", () => {
		const e = withResult({ inputTokens: 2_311, cacheRead: 41_900 });
		expect(e.context).toBeUndefined();
		expect(e.contextWithoutCapacity).toBeUndefined();
		expect(e.tokensIn).toBe(2_311);
	});

	it("omits the context reading when no token counts are reported", () => {
		expect(withResult({ context_window: 200_000 }).context).toBeUndefined();
	});

	it.each([
		{},
		{ context_window: 0 },
		{ context_window: -1 },
	])("shows only positive explicit occupancy when capacity is unknown: %j", (window) => {
		const e = withResult({
			inputTokens: 10,
			contextTokens: 40_000,
			...window,
		});
		expect(e.context).toBeUndefined();
		expect(e.contextWithoutCapacity).toBe(40_000);
		expect(
			withResult({ contextTokens: 0, ...window }).contextWithoutCapacity,
		).toBeUndefined();
	});

	it("caps the percentage at 100 when context overflows the window", () => {
		const e = withResult({ inputTokens: 250_000, context_window: 200_000 });
		expect(e.context?.pct).toBe(100);
	});

	it("is empty for a turn that never produced a result", () => {
		const turns = segmentTurns([user(), read("/a.ts")], true);
		const [turn] = turns;
		assert.exists(turn, "expected turn");
		const e = economics(turn, 0);
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

describe("launchRow", () => {
	const T = 1_800_000_000_000;
	// The Task call that launched agent A, with the task info the provider
	// saved on it.
	const agent = (metadata: Record<string, unknown>) => ({
		...tool("Task", {
			tool: "Task",
			description: "agent A",
			prompt: "go",
		}),
		metadata: { providerTaskId: "taskA", ...metadata },
	});
	const started = { backgrounded: true, taskStartedAt: T };
	const listed = [{ id: "taskA" }];

	it("ignores tool calls that started no task", () => {
		expect(launchRow(read("a.ts"), listed, T)).toBeUndefined();
	});

	it("leaves a task that was never backgrounded a foreground step", () => {
		const row = launchRow(
			agent({ taskStartedAt: T, outcome: "completed" }),
			listed,
			T,
		);
		expect(row?.state).toEqual({ kind: "foreground" });
	});

	it("runs on a live clock from task_started, less paused time", () => {
		const row = launchRow(
			agent({
				...started,
				pausedMs: 2_000,
				currentStep: "Running pnpm test",
				totalTokens: 18_506,
				toolUses: 2,
			}),
			listed,
			T + 65_000,
		);
		expect(row).toEqual({
			state: { kind: "running" },
			step: "Running pnpm test",
			time: 63_000,
			tokens: 18_506,
			toolCalls: 2,
			nested: 0,
		});
		expect(row && launchMeta(row)).toBe("1m 3s");
		expect(row && launchUsage(row)).toBe("19k tokens · 2 tools");
	});

	it("freezes elapsed time throughout an active pause and resumes afterwards", () => {
		const paused = agent({ ...started, pausedMs: 2_000, pausedAt: T + 10_000 });
		expect(launchRow(paused, listed, T + 20_000)?.time).toBe(8_000);
		expect(launchRow(paused, listed, T + 60_000)?.time).toBe(8_000);
		const resumed = agent({ ...started, pausedMs: 62_000, pausedAt: null });
		expect(launchRow(resumed, listed, T + 72_000)?.time).toBe(10_000);
	});

	it("names the last tool when the step only repeats the task", () => {
		const row = launchRow(
			agent({ ...started, currentStep: "agent A", lastToolName: "Read" }),
			listed,
			T,
		);
		expect(row?.step).toBe("Read");
	});

	it("shows the active tool before any task progress supplies a step", () => {
		expect(
			launchRow(agent({ ...started, activeToolName: "Bash" }), listed, T)?.step,
		).toBe("Bash");
	});

	it("becomes a background row once task_updated moves it there", () => {
		const foreground = agent({ taskStartedAt: T });
		expect(launchRow(foreground, listed, T)?.state.kind).toBe("foreground");
		const moved = {
			...foreground,
			metadata: { ...foreground.metadata, backgrounded: true },
		};
		expect(launchRow(moved, listed, T)?.state.kind).toBe("running");
	});

	it("folds to the finish message's own duration, not a progress reading", () => {
		const row = launchRow(
			agent({
				...started,
				outcome: "completed",
				durationMs: 18_177,
				taskDurationMs: 18_177,
				endTime: T + 99_000,
				totalTokens: 23_551,
				toolUses: 6,
			}),
			[],
			T + 120_000,
		);
		expect(row?.state).toEqual({ kind: "finished", outcome: "completed" });
		expect(row?.time).toBe(18_177);
		expect(row?.step).toBeUndefined();
		expect(row && launchMeta(row)).toBe("done · 18s");
		expect(row && launchUsage(row)).toBe("24k tokens · 6 tools");
	});

	it("times a shell with no usage from task_updated end, less paused time", () => {
		const shell: ToolMessage = {
			...tool("Bash", { tool: "Bash", command: "sleep 40" }),
			metadata: {
				providerTaskId: "shell",
				...started,
				durationMs: 3_000, // a stale progress reading, never final
				outcome: "completed",
				endTime: T + 41_000,
				pausedMs: 1_000,
			},
		};
		const row = launchRow(shell, [], T + 600_000);
		expect(row?.time).toBe(40_000);
		expect(row && launchMeta(row)).toBe("done · 40s");
	});

	it("tells failed from stopped, and an outcome wins over the live list", () => {
		const failed = launchRow(
			agent({ ...started, outcome: "failed" }),
			listed,
			T,
		);
		const stopped = launchRow(
			agent({ ...started, outcome: "stopped" }),
			listed,
			T,
		);
		expect(failed?.state).toEqual({ kind: "finished", outcome: "failed" });
		expect(stopped?.state).toEqual({ kind: "finished", outcome: "stopped" });
		expect(stopped && launchMeta(stopped)).toBe("stopped");
	});

	it("keeps running just off the list while its outcome is on the way", () => {
		// The SDK drops a task one message before its outcome, and the two
		// reach the browser on different feeds.
		const justDropped = (now: number) =>
			launchRow(agent(started), [], now, T + 10_000)?.state;
		expect(justDropped(T + 10_000)).toEqual({ kind: "running" });
		expect(justDropped(T + 10_000 + LAUNCH_SETTLE_MS - 1)).toEqual({
			kind: "running",
		});
		expect(justDropped(T + 10_000 + LAUNCH_SETTLE_MS)).toEqual({
			kind: "gone",
		});
		// An outcome landing in the window wins at once.
		expect(
			launchRow(
				agent({ ...started, outcome: "completed" }),
				[],
				T + 10_001,
				T + 10_000,
			)?.state,
		).toEqual({ kind: "finished", outcome: "completed" });
	});

	it("is no longer running once off the list with no outcome", () => {
		// A restart empties the list and the row never saw it listed.
		const row = launchRow(
			agent({ ...started, totalTokens: 900 }),
			[],
			T + 5_000,
		);
		expect(row?.state).toEqual({ kind: "gone" });
		expect(row?.time).toBeUndefined();
		expect(row && launchMeta(row)).toBe("no longer running");
		expect(row && launchUsage(row)).toBe("900 tokens");
	});

	it("never shows a negative time across clocks", () => {
		const row = launchRow(
			agent({ ...started, outcome: "completed", endTime: T - 5_000 }),
			[],
			T,
		);
		expect(row?.time).toBe(0);
	});

	it("counts live tasks the agent started, not the agent's siblings", () => {
		const row = launchRow(
			agent(started),
			[
				{ id: "taskA" },
				{ id: "shell1", parentTaskId: "taskA" },
				{ id: "shell2", parentTaskId: "taskA" },
				{ id: "other", parentTaskId: "taskB" },
				{ id: "top" },
			],
			T,
		);
		expect(row?.nested).toBe(2);
	});
});

describe("liveLaunchedTasks", () => {
	const T = 1_800_000_000_000;
	const launch = (taskId: string, metadata: Record<string, unknown> = {}) => ({
		...tool("Task", { tool: "Task", description: taskId, prompt: "go" }),
		metadata: { providerTaskId: taskId, backgrounded: true, ...metadata },
	});
	const turnOf = (...segments: ActivityPart[][]): Turn => ({
		id: id(),
		segments: segments.map((activity) => ({ activity, reply: [] })),
		notices: [],
		live: false,
	});
	const ids = (set: ReadonlySet<string>) => [...set].sort();

	it("counts the turn's running launches across segments, not another turn's", () => {
		const turn = turnOf([launch("shell"), read("a.ts")], [launch("agentA")]);
		const live = [{ id: "shell" }, { id: "agentA" }, { id: "elsewhere" }];
		expect(ids(liveLaunchedTasks(turn, live, T))).toEqual(["agentA", "shell"]);
	});

	it("counts each nested task once, however deep and however often reached", () => {
		const turn = turnOf([launch("agentA"), launch("agentB")]);
		const live = [
			{ id: "agentA" },
			{ id: "agentB" },
			{ id: "inner", parentTaskId: "agentA" },
			{ id: "deeper", parentTaskId: "inner" },
			{ id: "foreign", parentTaskId: "agentX" },
		];
		expect(ids(liveLaunchedTasks(turn, live, T))).toEqual([
			"agentA",
			"agentB",
			"deeper",
			"inner",
		]);
	});

	it("keeps a nested task after its agent finished, and a foreground agent's", () => {
		const turn = turnOf([
			launch("agentA", { outcome: "completed" }),
			launch("fg", { backgrounded: false }),
		]);
		const live = [
			{ id: "agentA" },
			{ id: "fg" },
			{ id: "inner", parentTaskId: "agentA" },
			{ id: "fgShell", parentTaskId: "fg" },
		];
		expect(ids(liveLaunchedTasks(turn, live, T))).toEqual(["fgShell", "inner"]);
	});

	it("does not invent liveness after a reload or restart with an empty list", () => {
		const turn = turnOf([launch("shell")]);
		expect(liveLaunchedTasks(turn, [], T).size).toBe(0);
	});

	it("uses the launching row's settle window and lets an outcome end it immediately", () => {
		const pending = launch("shell");
		const turn = turnOf([pending]);
		const listedAt = new Map([["shell", T]]);
		for (const now of [T + 1, T + LAUNCH_SETTLE_MS - 1]) {
			expect(
				launchRow(pending, [], now, listedAt.get("shell"))?.state.kind,
			).toBe("running");
			expect(ids(liveLaunchedTasks(turn, [], now, listedAt))).toEqual([
				"shell",
			]);
		}
		expect(
			liveLaunchedTasks(turn, [], T + LAUNCH_SETTLE_MS, listedAt).size,
		).toBe(0);
		const finished = turnOf([launch("shell", { outcome: "completed" })]);
		expect(liveLaunchedTasks(finished, [], T + 1, listedAt).size).toBe(0);
	});

	it("does not count a finished launch again through its live parent", () => {
		const turn = turnOf([
			launch("agentA"),
			launch("inner", { outcome: "completed" }),
		]);
		const live = [{ id: "agentA" }, { id: "inner", parentTaskId: "agentA" }];
		expect(ids(liveLaunchedTasks(turn, live, T))).toEqual(["agentA"]);
	});

	it("keeps a deeper task when its middle parent has left the live list", () => {
		const turn = turnOf([launch("agentA", { outcome: "completed" })]);
		const live = [
			{
				id: "deeper",
				parentTaskId: "middle",
				ancestorTaskIds: ["middle", "agentA"],
			},
			{
				id: "elsewhere",
				parentTaskId: "foreign",
				ancestorTaskIds: ["foreign", "agentX"],
			},
		];
		expect(ids(liveLaunchedTasks(turn, live, T))).toEqual(["deeper"]);
	});

	it("stops a finished launching step breathing even if its tool status is stale", () => {
		const finished: ToolMessage = {
			...launch("agentA", { outcome: "completed" }),
			status: "running",
		};
		const turn = turnOf([finished]);
		const running = liveLaunchedTasks(turn, [{ id: "agentA" }], T);
		expect(segmentAppearance(finished, running).running).toBe(false);
	});

	it("survives a parent cycle", () => {
		const turn = turnOf([read("a.ts")]);
		const live = [
			{ id: "x", parentTaskId: "y" },
			{ id: "y", parentTaskId: "x" },
			{ id: "z", parentTaskId: "z" },
		];
		expect(liveLaunchedTasks(turn, live, T).size).toBe(0);
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

describe("compaction", () => {
	it("puts a completed compaction in the activity log where it happened", () => {
		const before = read("a.ts");
		const boundary = compaction();
		const after = read("b.ts");
		const [turn] = segmentTurns(
			[user(), before, boundary, after, say()],
			false,
		);
		expect(turn?.segments[0]?.activity).toEqual([before, boundary, after]);
		expect(turn?.notices).toEqual([]);
	});

	it("keeps started and failed compactions as notices", () => {
		const started = compaction("started");
		const failed = compaction("failed", { variant: "error" });
		const [turn] = segmentTurns([user(), started, read("a.ts"), failed], true);
		expect(turn?.notices).toEqual([started, failed]);
		expect(turn?.segments[0]?.activity.map((p) => p.type)).toEqual(["tool"]);
	});

	it("keeps several compactions in order and folds narration before them", () => {
		const first = compaction("completed", { preTokens: 1 });
		const narration = say("squeezing");
		const second = compaction("completed", { preTokens: 2 });
		const [turn] = segmentTurns(
			[user(), read("a.ts"), first, narration, second, say()],
			false,
		);
		expect(turn?.segments[0]?.activity.slice(1)).toEqual([
			first,
			narration,
			second,
		]);
	});

	it("counts compactions apart from tools", () => {
		const segment = {
			activity: [read("a.ts"), compacted(), compacted()],
			reply: [],
		};
		const stats = turnStats(segment);
		expect(stats).toMatchObject({ tools: 1, compactions: 2, others: 0 });
		expect(countsPhrase(stats)).toBe("1 read");
	});

	it("leaves the phrase to the marker when a compaction is all the ledger holds", () => {
		const stats = turnStats({ activity: [compacted()], reply: [] });
		expect(countsPhrase(stats)).toBe("");
	});

	it("takes no time, and the step before it ends where it began", () => {
		const [turn] = segmentTurns(
			[
				user(),
				read("a.ts", 1000),
				compaction("completed", { createdAt: 4000 }),
				read("b.ts", 5000),
				say("ok", 6000),
			],
			false,
		);
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 0)).toEqual([3000, 0, 1000]);
	});

	it("does not void the timings when it carries no stamp", () => {
		const [turn] = segmentTurns(
			[
				user(),
				read("a.ts", 1000),
				compaction(),
				read("b.ts", 5000),
				say("ok", 6000),
			],
			false,
		);
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		expect(stepDurations(segment, turn, true, 0)).toEqual([4000, 0, 1000]);
	});

	it("labels the saving when both sizes are known", () => {
		const label = (fields: Partial<SystemMessage>) => {
			const [turn] = segmentTurns(
				[user(), compaction("completed", fields)],
				false,
			);
			const part = turn?.segments[0]?.activity[0];
			return part && partLabel(part);
		};
		expect(label({ preTokens: 180_000, postTokens: 42_000 })).toBe(
			"Compacted context · 180k → 42k, 138k saved",
		);
		expect(label({})).toBe("Compacted context");
	});
});

describe("skillChapters", () => {
	const skill = (name: string, createdAt?: number) =>
		tool(
			"Skill",
			{ tool: "Skill", name },
			createdAt !== undefined ? { createdAt } : {},
		);
	const chapters = (messages: ChatMessage[], live: boolean, now: number) => {
		const [turn] = segmentTurns(messages, live);
		assert.exists(turn, "expected turn");
		const [segment] = turn.segments;
		assert.exists(segment, "expected segment");
		return skillChapters(segment, turn, true, now);
	};

	it("runs each skill until the next one loads, and the last until the reply", () => {
		expect(
			chapters(
				[
					user(undefined, 0),
					skill("tdd", 2_000),
					read("/a.ts", 3_000),
					skill("debugging", 10_000),
					read("/b.ts", 11_000),
					say("done", 20_000),
				],
				false,
				0,
			),
		).toEqual([
			{ index: 0, name: "tdd", offset: 2_000, duration: 8_000, running: false },
			{
				index: 2,
				name: "debugging",
				offset: 10_000,
				duration: 10_000,
				running: false,
			},
		]);
	});

	it("leaves the last skill of a live turn open rather than guessing its end", () => {
		expect(
			chapters(
				[
					user(undefined, 0),
					skill("tdd", 1_000),
					read("/a.ts", 2_000),
					skill("debugging", 5_000),
				],
				true,
				9_000,
			),
		).toEqual([
			{ index: 0, name: "tdd", offset: 1_000, duration: 4_000, running: false },
			{ index: 2, name: "debugging", offset: 5_000, running: true },
		]);
	});

	it("omits whatever a missing stamp would have measured", () => {
		expect(
			chapters(
				[
					user(undefined, 0),
					skill("tdd"),
					skill("debugging", 4_000),
					say("done", 6_000),
				],
				false,
				0,
			),
		).toEqual([
			{ index: 0, name: "tdd", running: false },
			{
				index: 1,
				name: "debugging",
				offset: 4_000,
				duration: 2_000,
				running: false,
			},
		]);
	});

	it("is empty when no skill ran", () => {
		expect(chapters([user(), read("/a.ts"), say()], false, 0)).toEqual([]);
	});

	it("recovers the name of a skill recorded before inputs were normalized", () => {
		expect(
			skillName(
				tool("Skill", {}, { result: "Launching skill: brainstorming" }),
			),
		).toBe("brainstorming");
	});
});
