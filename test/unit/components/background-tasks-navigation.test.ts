import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundTask } from "../../../src/lib/shared-types.js";

const navigation = vi.hoisted(() => ({ tasks: [] as BackgroundTask[] }));
const revealStep = vi.hoisted(() =>
	vi.fn(
		async (_anchor: { messageId: string; partId?: string | undefined }) =>
			"landed" as const,
	),
);
vi.mock("../../../src/lib/frontend/stores/reveal.svelte.js", () => ({
	reveal: revealStep,
}));
vi.mock(
	"../../../src/lib/frontend/stores/session.svelte.js",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../src/lib/frontend/stores/session.svelte.js")
			>();
		return {
			...actual,
			rootBackgroundTasks: () => navigation.tasks,
			switchToSession: (id: string) => {
				actual.sessionState.currentId = id;
			},
		};
	},
);

import {
	openTask,
	returnFromTask,
	taskStopIds,
	tasksPanel,
} from "../../../src/lib/frontend/components/session/background-tasks.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";
import { sessionViewState } from "../../../src/lib/frontend/stores/session-view.svelte.js";

beforeEach(() => {
	sessionState.currentId = null;
	returnFromTask();
	sessionState.currentId = "parent";
	sessionViewState.compact = true;
	tasksPanel.open = true;
	navigation.tasks = [
		{ id: "agent", type: "local_agent", description: "Agent", firstSeenAt: 0 },
	];
	vi.clearAllMocks();
});

describe("Background task stop selection", () => {
	const task = (id: string, parentTaskId?: string): BackgroundTask => ({
		id,
		type: "local_bash",
		description: id,
		firstSeenAt: 0,
		...(parentTaskId ? { parentTaskId } : {}),
	});
	const tasks = [
		task("other"),
		task("nested", "agent"),
		task("agent"),
		task("deep", "nested"),
	];

	it("stops one shell and an agent's descendants before their parent", () => {
		expect(taskStopIds(tasks, "other")).toEqual(["other"]);
		expect(taskStopIds(tasks, "agent")).toEqual(["deep", "nested", "agent"]);
		expect(taskStopIds(tasks, "finished")).toEqual([]);
	});

	it("stops every live id once, even with missing ancestors or cycles", () => {
		expect(taskStopIds(tasks).sort()).toEqual([
			"agent",
			"deep",
			"nested",
			"other",
		]);
		expect(taskStopIds([])).toEqual([]);
		expect(taskStopIds([task("a", "b"), task("b", "a")]).sort()).toEqual([
			"a",
			"b",
		]);
		expect(
			taskStopIds(
				[
					task("agent"),
					{ ...task("child", "gone"), ancestorTaskIds: ["gone", "agent"] },
				],
				"agent",
			),
		).toEqual(["child", "agent"]);
	});
});
afterEach(() => {
	sessionState.currentId = null;
	returnFromTask();
	sessionViewState.compact = false;
	tasksPanel.open = false;
});

describe("Phone task origins", () => {
	it("returns through nested child sessions to the original pull-down", async () => {
		openTask({ id: "agent", sessionId: "child-a", description: "Agent A" });
		openTask(
			{ id: "nested", sessionId: "child-b", description: "Agent B" },
			{ messageId: "a-message", partId: "nested-launch" },
		);
		expect(returnFromTask()).toBe(true);
		await tick();
		expect(sessionState.currentId).toBe("child-a");
		expect(revealStep).toHaveBeenCalledWith({
			messageId: "a-message",
			partId: "nested-launch",
		});
		expect(returnFromTask()).toBe(true);
		await tick();
		expect(sessionState.currentId).toBe("parent");
		expect(tasksPanel.open).toBe(true);
	});

	it("leaves the pull-down closed if the last task ended while its child was open", async () => {
		openTask({ id: "agent", sessionId: "child-a", description: "Agent A" });
		navigation.tasks = [];
		expect(returnFromTask()).toBe(true);
		await tick();
		expect(sessionState.currentId).toBe("parent");
		expect(tasksPanel.open).toBe(false);
	});

	it("does not reuse an old origin after unrelated navigation", async () => {
		openTask({ id: "agent", sessionId: "child-a", description: "Agent A" });
		sessionState.currentId = "other-parent";
		openTask({ id: "other", sessionId: "child-c", description: "Agent C" });
		expect(returnFromTask()).toBe(true);
		await tick();
		expect(sessionState.currentId).toBe("other-parent");
		expect(returnFromTask()).toBe(false);
	});
});
