// Failure modes: a large transcript hides its active goal; chunk boundaries split
// JSON or UTF-8; a clear exposes an older active goal; a cleared sentinel is
// mistaken for completion; an active sentinel incorrectly settles the goal.
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ClaudeGoalTracker,
	readClaudeGoalStatus,
} from "../../../../src/lib/provider/claude/claude-goal-tracker.js";
import { configuredClaudeConfigDir } from "../../../../src/lib/provider/claude/claude-sdk-env.js";
import type { SDKMessage } from "../../../../src/lib/provider/claude/types.js";
import { partialFake } from "../../../helpers/partial-fake.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function readTranscript(entries: readonly unknown[]) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-goal-status-")));
	roots.push(root);
	const configDir = configuredClaudeConfigDir(join(root, "account"));
	const directory = join(
		configDir.path,
		"projects",
		root.replace(/[^a-zA-Z0-9]/g, "-"),
	);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "sdk-session.jsonl"),
		entries.map((entry) => JSON.stringify(entry)).join("\n"),
	);
	return readClaudeGoalStatus({
		workspaceRoot: root,
		sdkSessionId: "sdk-session",
		configDir,
	});
}

const goal = {
	condition: "Ship the feature",
	iterations: 2,
	setAt: 1,
	tokensAtStart: 10,
};

const clearRecords = [
	{
		type: "user",
		message: {
			role: "user",
			content:
				"<command-name>/goal</command-name>\n <command-message>goal</command-message>\n <command-args>clear</command-args>",
		},
	},
	{
		type: "system",
		subtype: "local_command",
		content:
			"<local-command-stdout>Goal cleared: Ship the feature</local-command-stdout>",
		commandRun: { command: "goal", args: "clear" },
	},
] as const;

describe("readClaudeGoalStatus", () => {
	it("finds the latest goal before more than 64 KB of later transcript records", async () => {
		const status = { met: false, sentinel: true, condition: "Ship 🍌" };
		await expect(
			readTranscript([
				{ attachment: { type: "goal_status", met: true, condition: "Old" } },
				{ attachment: { type: "goal_status", ...status } },
				{ type: "assistant", message: { content: "🍌".repeat(40_000) } },
			]),
		).resolves.toEqual(status);
	});

	it("reads a goal record spanning several chunks without breaking UTF-8", async () => {
		const status = {
			met: false,
			condition: "Ship 🍌".repeat(16_000),
			reason: "Keep working",
			judgeModel: "  judge  ",
		};
		await expect(
			readTranscript([
				{ attachment: { type: "goal_status", ...status } },
				{ type: "assistant", message: { content: "later" } },
			]),
		).resolves.toEqual({ ...status, judgeModel: "judge" });
	});

	it.each(
		clearRecords,
	)("treats a $type goal clear record as no active goal", async (clear) => {
		await expect(
			readTranscript([
				{ attachment: { type: "goal_status", met: false, sentinel: true } },
				clear,
			]),
		).resolves.toEqual({ met: true, sentinel: true });
	});

	it("keeps a goal set after an earlier clear", async () => {
		const status = { met: false, sentinel: true, condition: "New goal" };
		await expect(
			readTranscript([
				...clearRecords,
				{ attachment: { type: "goal_status", ...status } },
			]),
		).resolves.toEqual(status);
	});

	it("keeps the clear sentinel instead of returning the prior active goal", async () => {
		const status = { met: true, sentinel: true, condition: goal.condition };
		await expect(
			readTranscript([
				{ attachment: { type: "goal_status", ...status, met: false } },
				{ attachment: { type: "goal_status", ...status } },
			]),
		).resolves.toEqual(status);
	});
});

describe("ClaudeGoalTracker", () => {
	it.each(
		clearRecords,
	)("clears inherited goal state for a $type goal clear record", (clear) => {
		const tracker = new ClaudeGoalTracker("fork", {
			sessionId: "source",
			goal,
		});
		const change = tracker.observe(
			partialFake<SDKMessage>({ ...clear, uuid: "clear" } as never),
			10,
		);
		expect(change).toMatchObject({
			goal: null,
			ended: "cleared",
			endedGoal: goal,
		});
		expect(tracker.goal).toBeNull();
		expect(tracker.unsettledGoal).toBeNull();
	});

	it("treats a met sentinel as clearing, without marking the goal met", () => {
		const tracker = new ClaudeGoalTracker("fork", {
			sessionId: "source",
			goal,
		});
		expect(
			tracker.settle({ met: true, sentinel: true, condition: goal.condition }),
		).toMatchObject({
			goal: null,
			ended: "cleared",
			endedGoal: goal,
		});
		expect(tracker.unsettledGoal).toBeNull();
	});

	it("does not settle an active sentinel", () => {
		const tracker = new ClaudeGoalTracker("session", {
			sessionId: "session",
			goal,
		});
		expect(tracker.settle({ met: false, sentinel: true })).toBeUndefined();
		expect(tracker.goal).toEqual(goal);
	});
});
