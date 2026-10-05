import type { BackgroundTask, BackgroundWork } from "../shared-types.js";

export type SessionBackground = {
	readonly work: BackgroundWork;
	readonly tasks: readonly BackgroundTask[];
};

/**
 * Relay-owned state for Claude background tasks that outlive their foreground
 * turn. Driven by the SDK's level signal (`background_tasks_changed`, the full
 * live set) rather than start/finish pairs, so a missed finish can't leave a
 * session stuck on "working".
 */
export type BackgroundTaskTransition =
	| {
			readonly sessionId: string;
			readonly kind: "snapshot";
			readonly tasks: readonly {
				id: string;
				type: string;
				description: string;
				// Stamped by the runner; absent from runners that predate it.
				readonly firstSeenAt?: number;
			}[];
	  }
	| {
			// The SDK process ended: the SDK sends no snapshot at startup, so its
			// tasks must be dropped here rather than waiting for one.
			readonly sessionId: string;
			readonly kind: "session-ended";
	  };

// Watch loops wait for something to happen; anything else is doing work.
// local_bash covers the Monitor tool too: the SDK does not tell them apart.
const WATCH_TASK_TYPES = new Set(["local_bash", "monitor_mcp", "monitor_ws"]);

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
	return {
		record(input: BackgroundTaskTransition): void {
			if (input.kind === "session-ended" || input.tasks.length === 0) {
				if (live.delete(input.sessionId)) onChange?.(input.sessionId);
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
						before.firstSeenAt === task.firstSeenAt
					);
				})
			)
				return;
			live.set(input.sessionId, tasks);
			onChange?.(input.sessionId);
		},
		backgroundOf(sessionId: string): SessionBackground | undefined {
			const tasks = live.get(sessionId);
			return tasks ? { work: classify(tasks), tasks } : undefined;
		},
		hasLiveWork(sessionId: string): boolean {
			return live.has(sessionId);
		},
	};
}
