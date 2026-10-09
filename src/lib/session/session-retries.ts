import type { CanonicalEvent } from "../persistence/events.js";

/**
 * Which sessions are waiting on a provider retry, and why. A retry is
 * transient status (C1): it is never appended, so it lives here in memory,
 * rides the shell row, and is gone after a restart. Whatever the session
 * streams next means the retry is over, so any other event clears it.
 */
export function makeSessionRetries() {
	const live = new Map<string, string>();
	return {
		/** Follow the ingested events; returns the sessions whose state moved. */
		observe(events: readonly CanonicalEvent[]): string[] {
			const moved = new Set<string>();
			for (const event of events) {
				const { sessionId } = event;
				if (event.type === "session.status" && event.data.status === "retry") {
					const reason = event.data.message ?? "Retrying";
					if (live.get(sessionId) === reason) continue;
					live.set(sessionId, reason);
					moved.add(sessionId);
				} else if (live.delete(sessionId)) moved.add(sessionId);
			}
			return [...moved];
		},
		retryingOf: (sessionId: string): string | undefined => live.get(sessionId),
	};
}
