/** Relay-owned state for Claude tasks that can outlive their foreground turn. */
export type BackgroundTaskTransition =
	| {
			readonly sessionId: string;
			readonly taskId: string;
			readonly kind: "started" | "progress" | "completed";
			readonly status?: string;
			readonly taskType?: string;
	  }
	| {
			readonly sessionId: string;
			readonly kind: "session-ended";
	  };

const terminalStatuses = new Set([
	"completed",
	"failed",
	"stopped",
	"cancelled",
	"interrupted",
	"idle",
]);
const inertTaskTypes = new Set(["plan", "plan_mode"]);

export function makeSessionBackgroundLiveness(
	onChange?: (sessionId: string) => void,
) {
	const live = new Map<string, Set<string>>();
	const clear = (sessionId: string): void => {
		if (live.delete(sessionId)) onChange?.(sessionId);
	};
	return {
		record(input: BackgroundTaskTransition): void {
			if (input.kind === "session-ended") {
				clear(input.sessionId);
				return;
			}
			const tasks = live.get(input.sessionId) ?? new Set<string>();
			const wasLive = tasks.size > 0;
			if (
				input.kind === "completed" ||
				terminalStatuses.has(input.status ?? "") ||
				inertTaskTypes.has(input.taskType ?? "")
			) {
				tasks.delete(input.taskId);
				if (tasks.size === 0) live.delete(input.sessionId);
				if (wasLive && tasks.size === 0) onChange?.(input.sessionId);
				return;
			}
			// Metadata-only progress cannot revive a task that already completed.
			if (input.kind === "progress" && !tasks.has(input.taskId)) return;
			tasks.add(input.taskId);
			live.set(input.sessionId, tasks);
			if (!wasLive) onChange?.(input.sessionId);
		},
		hasLiveWork(sessionId: string): boolean {
			return (live.get(sessionId)?.size ?? 0) > 0;
		},
		clear,
	};
}
