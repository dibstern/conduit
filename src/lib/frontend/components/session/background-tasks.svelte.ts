import type { BackgroundTask } from "../../../shared-types.js";

/** Whether the header's background-task pull-down is open. One per page, like goalDetails. */
export const tasksPanel = $state({ open: false });

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
