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
			readonly taskIds: readonly string[];
	  }
	| {
			// The SDK process ended: the SDK sends no snapshot at startup, so its
			// tasks must be dropped here rather than waiting for one.
			readonly sessionId: string;
			readonly kind: "session-ended";
	  };

export function makeSessionBackgroundLiveness(
	onChange?: (sessionId: string) => void,
) {
	const live = new Set<string>();
	return {
		record(input: BackgroundTaskTransition): void {
			const isLive = input.kind === "snapshot" && input.taskIds.length > 0;
			if (live.has(input.sessionId) === isLive) return;
			if (isLive) live.add(input.sessionId);
			else live.delete(input.sessionId);
			onChange?.(input.sessionId);
		},
		hasLiveWork(sessionId: string): boolean {
			return live.has(sessionId);
		},
	};
}
