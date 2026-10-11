import { tick } from "svelte";
import type { BackgroundTask } from "../../../shared-types.js";
import { reveal } from "../../stores/reveal.svelte.js";
import {
	rootBackgroundTasks,
	sessionState,
	switchToSession,
} from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";

/** Whether the header's background-task pull-down is open. One per page, like goalDetails. */
export const tasksPanel = $state({ open: false });

/** A task that can be opened: its Child Session is what the drawer or phone view shows. */
export type OpenedTask = { id: string; sessionId: string; description: string };

/** The desktop task drawer's selected task. It holds the Child Session itself,
 *  so a task that finishes while open stays readable after it leaves the list. */
export const taskDrawer = $state<{ task: OpenedTask | null }>({ task: null });

/** Keep each phone drill-in's origin until it returns, including nested agents. */
const taskReturns: {
	parentId: string;
	childId: string;
	step: Parameters<typeof reveal>[0] | undefined;
}[] = [];

/** Shells have no Child Session (conduit-test-i7fy.9); every other task drills in once it has one. */
export function taskChildSession(task: BackgroundTask): string | undefined {
	return task.type === "local_bash" ? undefined : task.childSessionId;
}

/** Open a task: in the drawer beside the transcript on desktop, as the
 *  full-screen Child Session on phones, remembering where to come back to. */
export function openTask(
	task: OpenedTask,
	step?: Parameters<typeof reveal>[0],
): void {
	tasksPanel.open = false;
	if (!sessionViewState.compact) {
		taskDrawer.task = task;
		return;
	}
	const parentId = sessionState.currentId;
	if (taskReturns.at(-1)?.childId !== parentId) taskReturns.length = 0;
	if (parentId) taskReturns.push({ parentId, childId: task.sessionId, step });
	switchToSession(task.sessionId);
}

/** Back from a task opened on a phone, to the pull-down or launching step it
 *  was opened from. False when the open session was not opened from a task. */
export function returnFromTask(): boolean {
	const back = taskReturns.pop();
	if (!back || back.childId !== sessionState.currentId) {
		taskReturns.length = 0;
		return false;
	}
	switchToSession(back.parentId);
	// The header closes its pull-downs as the session changes; reopen after.
	void tick().then(() => {
		if (sessionState.currentId !== back.parentId) return;
		if (back.step) void reveal(back.step);
		else tasksPanel.open = rootBackgroundTasks(back.parentId).length > 0;
	});
	return true;
}

const KINDS: Record<string, { icon: string; label: string }> = {
	local_bash: { icon: "terminal", label: "shell" },
	local_agent: { icon: "bot", label: "subagent" },
	remote_agent: { icon: "bot", label: "remote agent" },
	in_process_teammate: { icon: "bot", label: "teammate" },
	local_workflow: { icon: "workflow", label: "workflow" },
	monitor_mcp: { icon: "radar", label: "monitor" },
	monitor_ws: { icon: "radar", label: "monitor" },
	dream: { icon: "moon", label: "dream" },
};

export function taskKind(task: BackgroundTask): {
	icon: string;
	label: string;
} {
	return (
		KINDS[task.type] ?? { icon: "zap", label: task.type.replaceAll("_", " ") }
	);
}

/**
 * Tasks in list order with each nested task right under the agent that started
 * it, one level deeper. A task whose parent is off the list stands on its own.
 */
export function nestTasks(
	tasks: readonly BackgroundTask[],
): { task: BackgroundTask; depth: number }[] {
	const listed = new Set(tasks.map((task) => task.id));
	const placed = new Set<string>();
	const nested: { task: BackgroundTask; depth: number }[] = [];
	const place = (task: BackgroundTask, depth: number): void => {
		if (placed.has(task.id)) return;
		placed.add(task.id);
		nested.push({ task, depth });
		for (const child of tasks) {
			if (child.parentTaskId === task.id) place(child, depth + 1);
		}
	};
	for (const task of tasks) {
		if (!task.parentTaskId || !listed.has(task.parentTaskId)) place(task, 0);
	}
	// A parent cycle has no root; still list every task once.
	for (const task of tasks) place(task, 0);
	return nested;
}

/** Snapshot the selected task's subtree, or every live task, children first. */
export function taskStopIds(
	tasks: readonly BackgroundTask[],
	taskId?: string,
): string[] {
	const ordered = [...tasks].reverse();
	const visited = new Set<string>();
	const ids: string[] = [];
	const stop = (task: BackgroundTask): void => {
		if (visited.has(task.id)) return;
		visited.add(task.id);
		for (const child of ordered) {
			if (
				child.parentTaskId === task.id ||
				child.ancestorTaskIds?.includes(task.id)
			)
				stop(child);
		}
		ids.push(task.id);
	};
	for (const task of ordered) {
		if (taskId === undefined || task.id === taskId) stop(task);
	}
	return ids;
}

/** Compact age: 40s, 6m, 1h 5m. The SDK gives no start time, so this counts from when conduit first saw the task. */
export function taskAge(task: BackgroundTask, now: number): string {
	const seconds = Math.max(0, Math.floor((now - task.firstSeenAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const rest = minutes % 60;
	return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
}

/** A clock for ages that ticks every second while there are tasks. */
export function taskClock(tasks: () => readonly BackgroundTask[]): {
	readonly now: number;
} {
	let now = $state(Date.now());
	$effect(() => {
		if (tasks().length === 0) return;
		now = Date.now();
		const timer = setInterval(() => {
			now = Date.now();
		}, 1_000);
		return () => clearInterval(timer);
	});
	return {
		get now() {
			return now;
		},
	};
}
