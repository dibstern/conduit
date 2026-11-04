// One answer to what a session is doing (82tn.32.30; CONTRACT.md 8.1 "SessionActivity is a
// read-only view over both"): the ledger's Run, tasks and servers, the goal tracker's status and the
// open prompts, as a table. The goal phase rides along for the goal view but is never read as
// activity: CONTRACT.md 8.1 (2734) names no activity term for a goal, and 8.3 (2849) leaves goals out
// of anythingMayAct. Failure modes (lane audit 1-11, 14): a wake Run or a Queued Run reads
// idle; tasks after the turn make the foreground working; monitoring or serving reads working; an
// awaited server reads calm; unknown tasks read as none; needs-you hides behind working; a goal
// phase moves the foreground or is dropped; the label disagrees with its parts; a background agent child makes
// its root's foreground working.
import { describe, expect, it } from "vitest";
import type { GoalPhase } from "../../../src/lib/provider/goal-tracker.js";
import type { TasksView } from "../../../src/lib/provider/run-ledger/run-ledger-model.js";
import {
	deriveSessionActivity,
	rollUpActivity,
	type SessionActivityFacts,
} from "../../../src/lib/session/session-activity-view.js";

const task = (id: string, cls: "work" | "monitoring" | "serving") => ({
	key: { taskId: id },
	taskType: "local_bash",
	description: id,
	ambient: false,
	kind: "shell",
	class: cls,
});
const live = (...tasks: ReturnType<typeof task>[]): TasksView => ({
	tag: "live",
	label: "r1:1",
	tasks,
});
const none: TasksView = { tag: "none" };
const confirmed = (tag: "Active" | "Paused"): GoalPhase => ({
	tag: "Confirmed",
	status: { tag, condition: "tests pass" },
});
const facts = (
	over: Partial<SessionActivityFacts> = {},
): SessionActivityFacts => ({
	tasks: none,
	servers: [],
	prompts: { approvals: 0, questions: 0 },
	...over,
});

describe("deriveSessionActivity", () => {
	it.each([
		["nothing", facts(), "idle", "none", undefined, "idle"],
		[
			"an input Run",
			facts({ run: { origin: "input" } }),
			"working",
			"none",
			undefined,
			"working",
		],
		[
			"a wake Run (4ejl7)",
			facts({ run: { origin: "wake" } }),
			"working",
			"none",
			undefined,
			"working",
		],
		[
			"work tasks after the turn",
			facts({ tasks: live(task("a", "work")) }),
			"idle",
			"work",
			undefined,
			"working",
		],
		[
			"monitoring tasks only",
			facts({ tasks: live(task("m", "monitoring")) }),
			"idle",
			"monitoring",
			undefined,
			"background",
		],
		[
			"a serving task",
			facts({ tasks: live(task("s", "serving")) }),
			"idle",
			"serving",
			undefined,
			"background",
		],
		[
			"a session-level serving server with no Run",
			facts({ servers: [{ role: "serving" }] }),
			"idle",
			"serving",
			undefined,
			"background",
		],
		[
			"an awaited server",
			facts({ servers: [{ role: "awaited", taskId: "s" }] }),
			"idle",
			"work",
			undefined,
			"working",
		],
		[
			"unknown tasks while checking",
			facts({ tasks: { tag: "unknown", label: "r1:2" } }),
			"idle",
			"unknown",
			undefined,
			"background",
		],
		[
			"work beats monitoring",
			facts({ tasks: live(task("m", "monitoring"), task("a", "work")) }),
			"idle",
			"work",
			undefined,
			"working",
		],
		[
			"an active goal between turns",
			facts({ goal: confirmed("Active") }),
			"idle",
			"none",
			undefined,
			"idle",
		],
		[
			"a goal action in flight",
			facts({
				goal: {
					tag: "Pending",
					action: { kind: "pause" },
					send: "Sent",
				},
			}),
			"idle",
			"none",
			undefined,
			"idle",
		],
		[
			"an active goal during a wake Run",
			facts({ goal: confirmed("Active"), run: { origin: "wake" } }),
			"working",
			"none",
			undefined,
			"working",
		],
		[
			"an approval during a Run",
			facts({
				run: { origin: "input" },
				prompts: { approvals: 1, questions: 0 },
			}),
			"working",
			"none",
			"approval",
			"needs-you",
		],
		[
			"a question with tasks running",
			facts({
				tasks: live(task("a", "work")),
				prompts: { approvals: 0, questions: 2 },
			}),
			"idle",
			"work",
			"reply",
			"needs-you",
		],
	] as const)("%s", (_name, input, foreground, background, needsYou, label) => {
		const activity = deriveSessionActivity(input);
		expect(activity).toEqual({
			foreground,
			background,
			...(needsYou ? { needsYou } : {}),
			label,
			...(input.goal ? { goal: input.goal } : {}),
		});
	});
});

describe("rollUpActivity", () => {
	const idle = deriveSessionActivity(facts());
	const working = deriveSessionActivity(facts({ run: { origin: "input" } }));
	const calm = deriveSessionActivity(
		facts({ tasks: live(task("m", "monitoring")) }),
	);
	const asking = deriveSessionActivity(
		facts({ prompts: { approvals: 1, questions: 0 } }),
	);
	it.each([
		["no members", idle, [], "idle"],
		["a working child", idle, [{ activity: working }], "working"],
		[
			"a working background agent child reads calm",
			idle,
			[{ activity: working, backgroundChild: true }],
			"background",
		],
		// Prompts roll up as counts, so a prompt never hides a member's working turn.
		[
			"a prompt rolls up as what runs",
			asking,
			[{ activity: working }],
			"working",
		],
		["a prompt alone rolls up idle", asking, [], "idle"],
		["a calm child", idle, [{ activity: calm }], "background"],
		["own working over a calm child", working, [{ activity: calm }], "working"],
	] as const)("%s", (_name, own, members, label) => {
		expect(rollUpActivity(own, members)).toBe(label);
	});
});
