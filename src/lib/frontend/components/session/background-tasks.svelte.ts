import { Schema } from "effect";
import { tick } from "svelte";
import { DeleteNeedsConfirm } from "../../../contracts/ws-rpc.js";
import {
	type BackgroundTask,
	backgroundTaskText,
} from "../../../shared-types.js";
import { reveal } from "../../stores/reveal.svelte.js";
import { selection } from "../../stores/selection.svelte.js";
import {
	findSession,
	rootBackgroundTasks,
	sessionState,
} from "../../stores/session.svelte.js";
import { sessionViewState } from "../../stores/session-view.svelte.js";
import { confirm } from "../../stores/ui.svelte.js";
import { toastFailure } from "../../transport/rpc-errors.js";
import { rpc } from "../../transport/ws-rpc-client.js";

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
	selection.open(task.sessionId);
}

/** Back from a task opened on a phone, to the pull-down or launching step it
 *  was opened from. False when the open session was not opened from a task. */
export function returnFromTask(): boolean {
	const back = taskReturns.pop();
	if (!back || back.childId !== sessionState.currentId) {
		taskReturns.length = 0;
		return false;
	}
	selection.open(back.parentId);
	// The header closes its pull-downs as the session changes; reopen after.
	void tick().then(() => {
		if (sessionState.currentId !== back.parentId) return;
		if (back.step) void reveal(back.step);
		else tasksPanel.open = rootBackgroundTasks(back.parentId).length > 0;
	});
	return true;
}

/** `hue` colours the header pills: one per kind, from the theme's category palette. */
const KINDS: Record<string, { icon: string; label: string; hue: string }> = {
	local_bash: {
		icon: "terminal",
		label: "shell",
		hue: "var(--color-cat-replan)",
	},
	local_agent: {
		icon: "bot",
		label: "subagent",
		hue: "var(--color-cat-scope)",
	},
	remote_agent: {
		icon: "bot",
		label: "remote agent",
		hue: "var(--color-cat-scope)",
	},
	in_process_teammate: {
		icon: "bot",
		label: "teammate",
		hue: "var(--color-cat-scope)",
	},
	local_workflow: {
		icon: "workflow",
		label: "workflow",
		hue: "var(--color-cat-decision)",
	},
	// 8.2 (CONTRACT.md 2778-2781): only `monitor` is a monitoring kind; monitor_mcp and
	// monitor_ws are work, so they show under their raw names (the contract is silent on them).
	monitor: {
		icon: "radar",
		label: "monitor",
		hue: "var(--color-status-green)",
	},
	dream: { icon: "moon", label: "dream", hue: "var(--color-cat-scope)" },
};

export function taskKind(task: BackgroundTask): {
	icon: string;
	label: string;
	hue: string;
} {
	return (
		KINDS[task.type] ?? {
			icon: "zap",
			// 8.2 (CONTRACT.md 2778-2779): a kind conduit does not know is its raw task_type.
			label: task.kind ?? task.type,
			hue: "var(--color-text-dimmer)",
		}
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

/**
 * Stop tasks (CONTRACT.md 8.4): the selected task's live subtree, or "all", which the server reads
 * from its own latest snapshot. Rows leave only when the provider's next snapshot drops them; a
 * rejection shows the server's reason, and a stop the provider fails arrives as a timeline notice.
 */
export async function stopBackgroundTasks(
	sessionId: string | null,
	taskId?: string,
): Promise<void> {
	if (!sessionId) return;
	// An id the list no longer shows is still sent, so the server says it has finished.
	const [first = taskId, ...rest] =
		taskId === undefined
			? []
			: taskStopIds(findSession(sessionId)?.backgroundTasks ?? [], taskId);
	try {
		await rpc("StopTasks", {
			sessionId,
			tasks: first === undefined ? "all" : [first, ...rest],
		});
	} catch (error) {
		toastFailure(
			taskId
				? "Failed to stop background task"
				: "Failed to stop background tasks",
		)(error);
	}
}

/** Resolves true once the session's ask names another snapshot entry (or ends), false after `ms`. */
const askMoved = (sessionId: string, entry: number, ms: number) =>
	new Promise<boolean>((resolve) => {
		const stop = $effect.root(() => {
			$effect(() => {
				if (findSession(sessionId)?.stopConfirm?.snapshotEntry === entry)
					return;
				settle(true);
			});
		});
		const timer = setTimeout(() => settle(false), ms);
		function settle(moved: boolean) {
			clearTimeout(timer);
			queueMicrotask(stop);
			resolve(moved);
		}
	});

/** 8.4: the ask before a step ends background tasks; no list means the state is unknown. */
const endAsk = (
	step: "Stopping now" | "Closing" | "Deleting",
	tasks: readonly BackgroundTask[] | undefined,
) =>
	tasks
		? `${step} will end: ${tasks.map((task) => backgroundTaskText({ ...task, kind: taskKind(task).label })).join(", ")}. Continue?`
		: `Background state unknown. ${step} may end background work. Continue?`;

/** One delete ask at a time: a second confirm() replaces the open dialog, which then never settles. */
let deleteAsks: Promise<boolean> = Promise.resolve(true);

/**
 * Delete a session (CONTRACT.md 8.4, 2870-2899). The row goes away, so the ask comes before the
 * step is sent: while tasks are live or unknown the server refuses with the latest snapshot entry,
 * the same ask shows the row's tasks, and the resend carries that entry. A newer snapshot refuses
 * again with its own entry, so the ask comes again. Resolves undefined when the ask is dismissed;
 * nothing is sent then (the gate itself has no cancel).
 */
export async function deleteAsking(
	target: Omit<Parameters<typeof rpc<"DeleteSession">>[1], "_tag">,
): Promise<Awaited<ReturnType<typeof rpc<"DeleteSession">>> | undefined> {
	for (let entry: number | undefined; ; ) {
		try {
			return await rpc(
				"DeleteSession",
				entry === undefined ? target : { ...target, confirm: entry },
			);
		} catch (error) {
			if (!Schema.is(DeleteNeedsConfirm)(error)) throw error;
			const ask = deleteAsks.then(() => {
				const row = findSession(target.sessionId);
				return confirm(
					endAsk(
						"Deleting",
						row?.tasksChecking || !row?.backgroundTasks?.length
							? undefined
							: row.backgroundTasks,
					),
					"Delete",
				);
			});
			deleteAsks = ask;
			if (!(await ask)) return undefined;
			entry = error.snapshotEntry;
		}
	}
}

/**
 * Confirm a stuck Stop (CONTRACT.md 8.4, 2873-2877): ask with the tasks closing would end, then
 * send the snapshot entry the ask showed. A newer snapshot refuses it (D45, 2886-2890), so the
 * ask comes again with the current list; cancelling leaves the Stop waiting.
 */
export async function confirmStuckStop(sessionId: string): Promise<void> {
	for (;;) {
		const ask = findSession(sessionId)?.stopConfirm;
		if (!ask) return;
		// A held close (a refresh, 2897) confirms through the same gate; cancelling leaves it held.
		const closing = ask.step === "end_session";
		const text = endAsk(closing ? "Closing" : "Stopping now", ask.tasks);
		if (!(await confirm(text, closing ? "Close now" : "Stop now"))) return;
		try {
			await rpc("ConfirmEscalation", {
				sessionId,
				snapshotEntry: ask.snapshotEntry,
			});
			return;
		} catch (error) {
			// The refusal can reach the page before the row naming the newer snapshot.
			if (!(await askMoved(sessionId, ask.snapshotEntry, 2_000)))
				return toastFailure("Failed to stop")(error);
		}
	}
}

/** Compact age: 40s, 6m, 1h 5m. The SDK gives no start time, so this counts from when conduit first saw the task. */
export function taskAge(
	task: Pick<BackgroundTask, "firstSeenAt">,
	now: number,
): string {
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
