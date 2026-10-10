// The ownership core decides which session owns each Claude SDK message.
// Fed slices of the concurrent background work capture (and messages cloned
// from it) and asserted on the decisions returned. The failure modes it
// guards against are listed on conduit-test-i7fy.3; each test names its own.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeClaudeSDKMessage } from "../../../../src/lib/contracts/providers/claude-agent-sdk.js";
import {
	type ClaudeOwnershipDecision,
	createClaudeMessageOwnership,
} from "../../../../src/lib/provider/claude/claude-message-ownership.js";
import type {
	SDKMessage,
	SessionMessage,
} from "../../../../src/lib/provider/claude/types.js";

type Raw = Record<string, unknown>;

const RAW: readonly Raw[] = readFileSync(
	join(
		import.meta.dirname,
		"../../../fixtures/claude-sdk-traces/concurrent-background-work-turn.jsonl",
	),
	"utf8",
)
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as Raw);

const decode = (raw: Raw): SDKMessage =>
	decodeClaudeSDKMessage(raw) as SDKMessage;
// Trace line n (1-based), optionally with fields replaced.
const line = (n: number, patch: Raw = {}): SDKMessage =>
	decode({ ...structuredClone(RAW[n - 1]), ...patch });
const lines = (from: number, to: number): SDKMessage[] =>
	Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const field = (n: number, key: string): string => String(RAW[n - 1]?.[key]);

const AGENT_A_TOOL = field(46, "tool_use_id");
const CHILD_A = `child:${field(46, "task_id")}`;
const CHILD_B = `child:${field(63, "task_id")}`;
const TASK_A = field(46, "task_id");
const TASK_B = field(63, "task_id");
const READS = JSON.parse(
	readFileSync(
		join(
			import.meta.dirname,
			"../../../fixtures/claude-sdk-traces/concurrent-background-work-turn.subagent-reads.json",
		),
		"utf8",
	),
) as readonly {
	readonly afterMessage: number;
	readonly agentId: string;
	readonly messages: readonly SessionMessage[];
}[];

const core = () =>
	createClaudeMessageOwnership({
		childSessionIdFor: (taskId) => `child:${taskId}`,
	});

const feed = (
	ownership: ReturnType<typeof core>,
	messages: readonly SDKMessage[],
): ClaudeOwnershipDecision[] =>
	messages.flatMap((message) => [
		...(message.type === "system" &&
		message.subtype === "background_tasks_changed"
			? ownership.decide({
					kind: "live-tasks",
					taskIds: message.tasks.map((task) => task.task_id),
				})
			: []),
		...ownership.decide({ kind: "sdk", message }),
	]);

// Where each routed message went: "parent" or the Child Session id.
const routedTo = (decisions: readonly ClaudeOwnershipDecision[]) =>
	decisions.flatMap((decision) =>
		decision.kind === "route"
			? [
					{
						uuid: decision.message.uuid,
						to:
							decision.owner.kind === "parent"
								? "parent"
								: decision.owner.childSessionId,
					},
				]
			: [],
	);
const ofKind = <K extends ClaudeOwnershipDecision["kind"]>(
	decisions: readonly ClaudeOwnershipDecision[],
	kind: K,
) =>
	decisions.filter(
		(decision): decision is Extract<ClaudeOwnershipDecision, { kind: K }> =>
			decision.kind === kind,
	);

describe("Claude message ownership", () => {
	it("starts each agent feed immediately after opening its child, never a shell feed", () => {
		const decisions = feed(core(), lines(1, RAW.length));
		expect(ofKind(decisions, "start-feed")).toEqual([
			{ kind: "start-feed", taskId: TASK_A, childSessionId: CHILD_A },
			{ kind: "start-feed", taskId: TASK_B, childSessionId: CHILD_B },
		]);
		for (const [index, decision] of decisions.entries()) {
			if (decision.kind !== "open-child") continue;
			expect(decisions[index + 1]).toEqual({
				kind: "start-feed",
				taskId: decision.taskId,
				childSessionId: decision.childSessionId,
			});
		}
	});

	it("keeps agent A feeding past result 85 and list removal 112, then final-reads only A at finish 113", () => {
		const ownership = core();
		feed(ownership, lines(1, 84));
		expect(ofKind(feed(ownership, lines(85, 112)), "final-read")).toEqual([]);
		expect(ofKind(feed(ownership, lines(113, 114)), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
		expect(ofKind(feed(ownership, lines(115, 128)), "final-read")).toEqual([]);
		expect(
			ofKind(feed(ownership, lines(129, RAW.length)), "final-read"),
		).toEqual([
			{ kind: "final-read", taskId: TASK_B, childSessionId: CHILD_B },
		]);
		expect(ownership.decide({ kind: "end" })).toEqual([]);
	});

	it("final-reads a missing task without a finish at the next result while keeping the listed task", () => {
		const ownership = core();
		feed(ownership, lines(1, 85));
		expect(ownership.decide({ kind: "live-tasks", taskIds: [TASK_B] })).toEqual(
			[],
		);
		expect(ofKind(feed(ownership, [line(124)]), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
		expect(ofKind(ownership.decide({ kind: "end" }), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_B, childSessionId: CHILD_B },
		]);
		expect(ownership.decide({ kind: "end" })).toEqual([]);
	});

	it("final-reads every remaining feed at end, including a missing task without a finish", () => {
		const ownership = core();
		feed(ownership, lines(1, 85));
		ownership.decide({ kind: "live-tasks", taskIds: [TASK_B] });
		expect(ofKind(ownership.decide({ kind: "end" }), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
			{ kind: "final-read", taskId: TASK_B, childSessionId: CHILD_B },
		]);
	});

	it.each([
		"completed",
		"failed",
		"killed",
	])("stops on terminal task_updated %s even while the SDK still lists the task", (status) => {
		const ownership = core();
		feed(ownership, lines(1, 85));
		expect(
			ofKind(feed(ownership, [line(113, { patch: { status } })]), "final-read"),
		).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
		expect(
			ofKind(feed(ownership, [line(114), line(46)]), "start-feed"),
		).toEqual([]);
		expect(ofKind(ownership.decide({ kind: "end" }), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_B, childSessionId: CHILD_B },
		]);
	});

	it("keeps feeding through nonterminal updates and ends on task_notification alone", () => {
		const ownership = core();
		feed(ownership, lines(1, 85));
		for (const status of ["pending", "running", "paused"]) {
			expect(
				ofKind(
					feed(ownership, [line(113, { patch: { status } })]),
					"final-read",
				),
			).toEqual([]);
		}
		expect(ofKind(feed(ownership, [line(114)]), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
	});

	it.each([
		"finish",
		"end",
	])("keeps a never-listed agent past its parent's result until %s and ignores duplicate starts", (ending) => {
		const ownership = core();
		feed(ownership, [line(43), line(46)]);
		ownership.decide({ kind: "live-tasks", taskIds: [] });
		expect(ofKind(feed(ownership, [line(46)]), "start-feed")).toEqual([]);
		expect(ofKind(feed(ownership, [line(85)]), "final-read")).toEqual([]);
		expect(
			ofKind(
				ending === "finish"
					? feed(ownership, [line(114)])
					: ownership.decide({ kind: "end" }),
				"final-read",
			),
		).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
	});

	it("keeps a feed when task_started precedes its live-list entry with a parent result between them", () => {
		const ownership = core();
		feed(ownership, [line(43), line(46)]);
		expect(ofKind(feed(ownership, [line(85)]), "final-read")).toEqual([]);
		ownership.decide({ kind: "live-tasks", taskIds: [TASK_A] });
		expect(ofKind(feed(ownership, [line(124)]), "final-read")).toEqual([]);
		ownership.decide({ kind: "live-tasks", taskIds: [] });
		expect(ofKind(feed(ownership, [line(124)]), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
	});

	it("remembers a live-list entry even when it arrives before task_started", () => {
		const ownership = core();
		ownership.decide({ kind: "live-tasks", taskIds: [TASK_A] });
		ownership.decide({ kind: "live-tasks", taskIds: [] });
		feed(ownership, [line(43), line(46)]);
		expect(ofKind(feed(ownership, [line(85)]), "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
	});

	it("releases a held nested-shell start when its issuer arrives only in a transcript", () => {
		const ownership = core();
		feed(ownership, lines(1, 74));
		expect(ofKind(feed(ownership, [line(78)]), "hold")).toHaveLength(1);
		const messages = READS.find(
			(read) => read.agentId === TASK_A && read.afterMessage === 79,
		)?.messages;
		if (!messages) throw new Error("missing captured agent A transcript");
		const decisions = ownership.decide({
			kind: "transcript",
			taskId: TASK_A,
			messages,
		});
		expect(decisions[0]).toEqual({
			kind: "route-transcript",
			childSessionId: CHILD_A,
			messages,
		});
		expect(ofKind(decisions, "route-transcript")).toHaveLength(1);
		expect(routedTo(decisions)).toEqual([
			{ uuid: field(78, "uuid"), to: CHILD_A },
		]);
		expect(ofKind(decisions, "route").at(-1)?.tool).toEqual({
			toolUseId: field(78, "tool_use_id"),
			issuingMessageId: field(75, "uuid"),
		});
		expect(ofKind(decisions, "open-child")).toEqual([]);
		expect(ofKind(decisions, "start-feed")).toEqual([]);
		// Snapshots deliberately route again: the runtime's shared cursor stages
		// transcript and SDK copies once. Ownership must not reopen/re-release tasks.
		const repeated = ownership.decide({
			kind: "transcript",
			taskId: TASK_A,
			messages,
		});
		expect(repeated).toEqual([
			{
				kind: "route-transcript",
				childSessionId: CHILD_A,
				messages,
			},
		]);
		expect(ofKind(repeated, "start-feed")).toEqual([]);
	});

	it("final-reads a feed when a terminal update held before task_started is released", () => {
		const ownership = core();
		feed(ownership, lines(1, 44));
		expect(ofKind(feed(ownership, [line(113)]), "hold")).toHaveLength(1);
		const decisions = feed(ownership, [line(46)]);
		expect(ofKind(decisions, "start-feed")).toHaveLength(1);
		expect(ofKind(decisions, "final-read")).toEqual([
			{ kind: "final-read", taskId: TASK_A, childSessionId: CHILD_A },
		]);
	});

	it("does not resume feeds on a fresh runner or route unknown/shell transcripts", () => {
		const messages = READS[0]?.messages ?? [];
		const ownership = core();
		feed(ownership, lines(1, 27));
		for (const taskId of [TASK_A, field(27, "task_id")]) {
			expect(
				ownership.decide({ kind: "transcript", taskId, messages }),
			).toEqual([]);
		}
		ownership.decide({ kind: "live-tasks", taskIds: [TASK_A] });
		expect(ownership.decide({ kind: "end" })).toEqual([]);
	});

	it("routes every message of the capture to the session that issued its tool call", () => {
		const childA = [
			75, 79, 82, 84, 86, 87, 89, 91, 95, 96, 97, 99, 100, 101, 107, 111,
		];
		// Shells agent A started: their start, update and finish.
		const childAShells = [78, 94, 105, 106, 109, 110];
		const childB = [80, 126, 127];
		// Agent B's foreground Bash, a task only after the parent's result (10).
		const childBShells = [90, 125];
		const expected = RAW.map((_, i) => {
			const n = i + 1;
			if (childA.includes(n) || childAShells.includes(n)) return CHILD_A;
			if (childB.includes(n) || childBShells.includes(n)) return CHILD_B;
			return "parent";
		});

		const decisions = feed(core(), lines(1, RAW.length));

		expect(routedTo(decisions)).toEqual(
			RAW.map((raw, i) => ({ uuid: raw["uuid"], to: expected[i] })),
		);
		expect(ofKind(decisions, "hold")).toEqual([]);
		expect(ofKind(decisions, "drop")).toEqual([]);
		expect(
			ofKind(decisions, "open-child").map((open) => ({
				taskId: open.taskId,
				childSessionId: open.childSessionId,
				issuer:
					open.issuer.kind === "parent" ? "parent" : open.issuer.childSessionId,
			})),
		).toEqual([
			// Background shells (local_bash) get no Child Session: their output is
			// not a transcript (conduit-test-i7fy.9).
			{
				taskId: field(46, "task_id"),
				childSessionId: CHILD_A,
				issuer: "parent",
			},
			{
				taskId: field(63, "task_id"),
				childSessionId: CHILD_B,
				issuer: "parent",
			},
		]);
	});

	it("names the tool call a task message is about and the message that issued it", () => {
		const decisions = feed(core(), lines(1, 78));
		const nestedStart = routedTo(decisions).length - 1;
		const route = ofKind(decisions, "route")[nestedStart];

		expect(route?.tool).toEqual({
			toolUseId: field(78, "tool_use_id"),
			issuingMessageId: field(75, "uuid"),
		});
		expect(
			ofKind(decisions, "open-child").find(
				(open) => open.taskId === field(46, "task_id"),
			),
		).toMatchObject({
			toolUseId: AGENT_A_TOOL,
			issuingMessageId: field(43, "uuid"),
			description: field(46, "description"),
			taskType: field(46, "task_type"),
		});
	});

	// Failure 1.
	it("holds a task message that arrives before its tool call, then routes it to the issuer", () => {
		const ownership = core();
		// Line 10 already announces this tool in a stream block. Omit it so
		// this failure case really reaches task_started before the issuer.
		feed(ownership, [...lines(1, 9), ...lines(11, 21)]);
		const early = feed(ownership, [line(27)]);
		const after = feed(ownership, [line(22)]);

		expect(early).toEqual([
			{ kind: "hold", message: line(27), awaiting: field(27, "tool_use_id") },
		]);
		expect(after.map((decision) => decision.kind)).toEqual(["route", "route"]);
		expect(routedTo(after)).toEqual([
			{ uuid: field(22, "uuid"), to: "parent" },
			{ uuid: field(27, "uuid"), to: "parent" },
		]);
	});

	// Failure 2.
	it("routes a shell started two agents down to the agent that started it", () => {
		const ownership = core();
		feed(ownership, lines(1, 79));
		const startAgentY = line(87, {
			uuid: "a-issues-y",
			message: {
				...(RAW[86]?.["message"] as Raw),
				content: [
					{ type: "tool_use", id: "toolu_Y", name: "Agent", input: {} },
				],
			},
		});
		const yStarted = line(46, {
			uuid: "y-started",
			task_id: "agentY",
			tool_use_id: "toolu_Y",
			spawn_depth: 2,
		});
		const yIssuesZ = line(75, {
			uuid: "y-issues-z",
			parent_tool_use_id: "toolu_Y",
			message: {
				...(RAW[74]?.["message"] as Raw),
				content: [
					{
						type: "tool_use",
						id: "toolu_Z",
						name: "Bash",
						input: { command: "sleep 1" },
					},
				],
			},
		});
		const zStarted = line(78, {
			uuid: "z-started",
			task_id: "shellZ",
			tool_use_id: "toolu_Z",
		});
		const zFinished = line(106, {
			uuid: "z-finished",
			task_id: "shellZ",
			tool_use_id: "toolu_Z",
		});

		const decisions = feed(ownership, [
			startAgentY,
			yStarted,
			yIssuesZ,
			zStarted,
			zFinished,
		]);

		expect(routedTo(decisions)).toEqual([
			{ uuid: "a-issues-y", to: CHILD_A },
			{ uuid: "y-started", to: CHILD_A },
			{ uuid: "y-issues-z", to: "child:agentY" },
			{ uuid: "z-started", to: "child:agentY" },
			{ uuid: "z-finished", to: "child:agentY" },
		]);
		expect(
			ofKind(decisions, "open-child").map((open) => [open.taskId, open.issuer]),
		).toEqual([["agentY", { kind: "child", childSessionId: CHILD_A }]]);
	});

	// Failure 3.
	it("drops messages whose owner never becomes known when the stream ends", () => {
		const ownership = core();
		feed(ownership, lines(1, 8));
		const orphanTask = line(27, { tool_use_id: "toolu_never_seen" });
		const orphanStep = line(75, { parent_tool_use_id: "toolu_never_agent" });

		const held = feed(ownership, [orphanTask, orphanStep]);
		const ended = ownership.decide({ kind: "end" });

		expect(held.map((decision) => decision.kind)).toEqual(["hold", "hold"]);
		expect(ended.map((decision) => decision.kind)).toEqual(["drop", "drop"]);
		expect(ofKind([...ended], "drop").map((drop) => drop.message.uuid)).toEqual(
			[orphanTask.uuid, orphanStep.uuid],
		);
		expect(ownership.decide({ kind: "end" })).toEqual([]);
	});

	// Failure 4.
	it("forgets held messages and owners when the Claude process restarts", () => {
		const before = core();
		feed(before, lines(1, 79));
		feed(before, [line(27, { uuid: "held", tool_use_id: "toolu_later" })]);
		expect(ofKind(before.decide({ kind: "end" }), "drop")).toHaveLength(1);

		// The restarted process gets a fresh core: a shell finish for a tool
		// it never saw issued waits rather than landing in the parent.
		const after = core();
		feed(after, lines(1, 8));
		expect(feed(after, [line(106)])).toEqual([
			{ kind: "hold", message: line(106), awaiting: field(106, "tool_use_id") },
		]);
	});

	// Failure 5.
	it("opens a Child Session once for a duplicate task_started and still routes both", () => {
		const decisions = feed(core(), [...lines(1, 46), line(46)]);

		expect(
			ofKind(decisions, "open-child").filter(
				(open) => open.taskId === field(46, "task_id"),
			),
		).toHaveLength(1);
		expect(
			routedTo(decisions).filter((route) => route.uuid === field(46, "uuid")),
		).toEqual([
			{ uuid: field(46, "uuid"), to: "parent" },
			{ uuid: field(46, "uuid"), to: "parent" },
		]);
	});

	// Failure 6.
	it("keeps routing a task's messages after it leaves the live list", () => {
		const ownership = core();
		feed(ownership, lines(1, 103));
		const emptied = line(104, { uuid: "emptied", tasks: [] });

		const decisions = feed(ownership, [emptied, line(107), line(110)]);

		expect(routedTo(decisions)).toEqual([
			{ uuid: "emptied", to: "parent" },
			{ uuid: field(107, "uuid"), to: CHILD_A },
			{ uuid: field(110, "uuid"), to: CHILD_A },
		]);
	});

	// Failure 7.
	it("holds a task_updated until its task is known, then routes it by the task's tool", () => {
		const ownership = core();
		feed(ownership, lines(1, 21));
		const update = line(105, { uuid: "update", task_id: "b66c4l9s4" });

		const early = feed(ownership, [update]);
		const decisions = feed(ownership, lines(22, 27));

		expect(early).toEqual([
			{ kind: "hold", message: update, awaiting: "b66c4l9s4" },
		]);
		expect(routedTo(decisions).at(-1)).toEqual({
			uuid: "update",
			to: "parent",
		});
		expect(ofKind(decisions, "route").at(-1)?.tool).toEqual({
			toolUseId: field(27, "tool_use_id"),
			issuingMessageId: field(22, "uuid"),
		});
	});

	// Failure 8.
	it("routes tool progress by the agent tool call it reports on", () => {
		const ownership = core();
		feed(ownership, lines(1, 79));
		const progress = (uuid: string, parentToolUseId: string) =>
			decode({
				type: "tool_progress",
				tool_use_id: `inner-${uuid}`,
				tool_name: "Bash",
				parent_tool_use_id: parentToolUseId,
				elapsed_time_seconds: 3,
				uuid,
				session_id: field(1, "session_id"),
			});

		const decisions = feed(ownership, [
			progress("on-agent-a", AGENT_A_TOOL),
			progress("on-nested-shell", field(78, "tool_use_id")),
		]);

		expect(routedTo(decisions)).toEqual([
			{ uuid: "on-agent-a", to: "parent" },
			{ uuid: "on-nested-shell", to: CHILD_A },
		]);
		expect(ofKind(decisions, "route")[0]?.tool?.toolUseId).toBe(AGENT_A_TOOL);
	});

	// Failure 9.
	it("drops a task message with no tool call and an unknown task", () => {
		const ownership = core();
		feed(ownership, lines(1, 8));
		const { tool_use_id: _dropped, ...rest } = structuredClone(RAW[75] as Raw);
		const loose = decode({ ...rest, task_id: "unknown-task" });

		const decisions = feed(ownership, [loose]);

		expect(decisions.map((decision) => decision.kind)).toEqual(["drop"]);
		expect(ownership.decide({ kind: "end" })).toEqual([]);
	});

	// Failure 11.
	it("releases held messages in arrival order and re-checks each", () => {
		const ownership = core();
		feed(ownership, lines(1, 8));
		const step = line(75, { uuid: "step", parent_tool_use_id: "toolu_X" });
		const started = line(46, {
			uuid: "started",
			task_id: "tX",
			tool_use_id: "toolu_X",
		});
		const issued = line(43, {
			uuid: "issued",
			message: {
				...(RAW[42]?.["message"] as Raw),
				content: [
					{ type: "tool_use", id: "toolu_X", name: "Agent", input: {} },
				],
			},
		});

		const held = feed(ownership, [step, started]);
		const decisions = feed(ownership, [issued]);

		expect(held.map((decision) => decision.kind)).toEqual(["hold", "hold"]);
		expect(routedTo(decisions)).toEqual([
			{ uuid: "issued", to: "parent" },
			{ uuid: "started", to: "parent" },
			{ uuid: "step", to: "child:tX" },
		]);
		expect(ofKind(decisions, "open-child").map((open) => open.taskId)).toEqual([
			"tX",
		]);
		expect(ownership.decide({ kind: "end" })).toEqual([
			{ kind: "final-read", taskId: "tX", childSessionId: "child:tX" },
		]);
	});
});
