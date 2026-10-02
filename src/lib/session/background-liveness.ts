import type { BackgroundWork } from "../shared-types.js";

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
			readonly taskTypes: readonly string[];
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

const classify = (taskTypes: readonly string[]): BackgroundWork | undefined => {
	if (taskTypes.length === 0) return undefined;
	return taskTypes.every((type) => WATCH_TASK_TYPES.has(type))
		? "monitoring"
		: "working";
};

export function makeSessionBackgroundLiveness(
	onChange?: (sessionId: string) => void,
) {
	const live = new Map<string, BackgroundWork>();
	return {
		record(input: BackgroundTaskTransition): void {
			const work =
				input.kind === "snapshot" ? classify(input.taskTypes) : undefined;
			if (live.get(input.sessionId) === work) return;
			if (work) live.set(input.sessionId, work);
			else live.delete(input.sessionId);
			onChange?.(input.sessionId);
		},
		backgroundWork(sessionId: string): BackgroundWork | undefined {
			return live.get(sessionId);
		},
		hasLiveWork(sessionId: string): boolean {
			return live.has(sessionId);
		},
	};
}
