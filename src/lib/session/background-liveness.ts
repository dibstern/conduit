/** Relay-owned state for Claude tasks that can outlive their foreground turn. */
export interface BackgroundTaskTransition {
	readonly sessionId: string;
	readonly taskId: string;
	readonly kind: "started" | "progress" | "completed";
	readonly status?: string;
	readonly taskType?: string;
}

const terminalStatuses = new Set([
	"completed",
	"failed",
	"stopped",
	"cancelled",
	"interrupted",
	"idle",
]);
const inertTaskTypes = new Set(["plan", "plan_mode"]);

export function makeSessionBackgroundLiveness() {
	const live = new Map<string, Set<string>>();
	return {
		record(input: BackgroundTaskTransition): void {
			const tasks = live.get(input.sessionId) ?? new Set<string>();
			if (
				input.kind === "completed" ||
				terminalStatuses.has(input.status ?? "") ||
				inertTaskTypes.has(input.taskType ?? "")
			) {
				tasks.delete(input.taskId);
				if (tasks.size === 0) live.delete(input.sessionId);
				return;
			}
			// Metadata-only progress cannot revive a task that already completed.
			if (input.kind === "progress" && !tasks.has(input.taskId)) return;
			tasks.add(input.taskId);
			live.set(input.sessionId, tasks);
		},
		hasLiveWork(sessionId: string): boolean {
			return (live.get(sessionId)?.size ?? 0) > 0;
		},
		clear(sessionId: string): void {
			live.delete(sessionId);
		},
	};
}
