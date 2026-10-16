import type { BackgroundTask, BackgroundWork } from "../shared-types.js";

export type SessionBackground = {
	readonly work: BackgroundWork;
	readonly tasks: readonly BackgroundTask[];
};

/**
 * Daemon-owned state for Claude background tasks that outlive their foreground
 * turn. Driven by the SDK's level signal (`background_tasks_changed`, the full
 * live set) rather than start/finish pairs, so a missed finish can't leave a
 * session stuck on "working".
 */
export type BackgroundTaskTransition =
	| {
			readonly sessionId: string;
			readonly kind: "snapshot";
			// firstSeenAt is stamped by the runner; absent from runners that
			// predate it.
			readonly tasks: readonly (Omit<BackgroundTask, "firstSeenAt"> & {
				readonly firstSeenAt?: number;
			})[];
	  }
	| {
			// The SDK process ended: the SDK sends no snapshot at startup, so its
			// tasks must be dropped here rather than waiting for one.
			readonly sessionId: string;
			readonly kind: "session-ended";
	  };

// Shells, watch loops and background agents run on their own after the turn,
// so the session reads as monitoring them; anything else (a workflow) is
// still doing the session's work. local_bash covers the Monitor tool too.
const WATCH_TASK_TYPES = new Set([
	"local_bash",
	"local_agent",
	"monitor_mcp",
	"monitor_ws",
]);

const classify = (tasks: readonly BackgroundTask[]): BackgroundWork => {
	return tasks.every((task) => WATCH_TASK_TYPES.has(task.type))
		? "monitoring"
		: "working";
};

export function makeSessionBackgroundLiveness(
	onChange?: (sessionId: string) => void,
	now: () => number = Date.now,
) {
	const live = new Map<string, BackgroundTask[]>();
	// When each runtime's current list took effect. A runtime absent here has
	// sent nothing since the daemon started, which is not the same as empty:
	// runners replay only non-empty lists after a reconnect.
	const listSince = new Map<string, number>();
	return {
		record(input: BackgroundTaskTransition): void {
			if (input.kind === "session-ended" || input.tasks.length === 0) {
				const emptied = live.delete(input.sessionId);
				if (emptied || !listSince.has(input.sessionId))
					listSince.set(input.sessionId, now());
				if (emptied) onChange?.(input.sessionId);
				return;
			}
			const previous = live.get(input.sessionId) ?? [];
			const previousById = new Map(previous.map((task) => [task.id, task]));
			const tasks = input.tasks
				.map((task) => ({
					...task,
					firstSeenAt:
						task.firstSeenAt ?? previousById.get(task.id)?.firstSeenAt ?? now(),
				}))
				.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
			if (
				previous.length === tasks.length &&
				tasks.every((task) => {
					const before = previousById.get(task.id);
					return (
						before?.type === task.type &&
						before.description === task.description &&
						before.detail === task.detail &&
						before.firstSeenAt === task.firstSeenAt &&
						before.childSessionId === task.childSessionId &&
						before.parentTaskId === task.parentTaskId &&
						before.ancestorTaskIds?.length === task.ancestorTaskIds?.length &&
						(task.ancestorTaskIds?.every(
							(id, i) => id === before.ancestorTaskIds?.[i],
						) ??
							true)
					);
				})
			)
				return;
			live.set(input.sessionId, tasks);
			listSince.set(input.sessionId, now());
			onChange?.(input.sessionId);
		},
		backgroundOf(sessionId: string): SessionBackground | undefined {
			const tasks = live.get(sessionId);
			return tasks ? { work: classify(tasks), tasks } : undefined;
		},
		hasLiveWork(sessionId: string): boolean {
			return live.has(sessionId);
		},
		/** The runtime's live task ids and since when that list has held;
		 * undefined until the runtime reports anything. */
		liveListOf(
			sessionId: string,
		):
			| { readonly taskIds: ReadonlySet<string>; readonly since: number }
			| undefined {
			const since = listSince.get(sessionId);
			if (since === undefined) return undefined;
			const taskIds = new Set(live.get(sessionId)?.map((task) => task.id));
			return { taskIds, since };
		},
	};
}
