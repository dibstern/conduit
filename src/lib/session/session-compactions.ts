import type { CanonicalEvent } from "../persistence/events.js";

/**
 * Which sessions are compacting right now. A compaction's start is transient
 * status (C1): it is never appended, so it lives here in memory, rides the
 * shell row, and is gone after a restart. Its outcome is projected into the
 * transcript. The outcome, a turn ending or the session going idle clears it,
 * so a lost outcome cannot leave a session compacting.
 */
export function makeSessionCompactions() {
	const live = new Map<string, string>();
	return {
		/** Follow the ingested events; returns the sessions whose state moved. */
		observe(events: readonly CanonicalEvent[]): string[] {
			const moved = new Set<string>();
			for (const event of events) {
				const { sessionId } = event;
				if (
					event.type === "session.compaction" &&
					event.data.state === "started"
				) {
					if (live.get(sessionId) === event.data.detail) continue;
					live.set(sessionId, event.data.detail);
					moved.add(sessionId);
				} else if (
					(event.type === "session.compaction" ||
						event.type === "turn.completed" ||
						event.type === "turn.error" ||
						event.type === "turn.interrupted" ||
						(event.type === "session.status" &&
							(event.data.status === "idle" ||
								event.data.status === "error"))) &&
					live.delete(sessionId)
				)
					moved.add(sessionId);
			}
			return [...moved];
		},
		compactingOf: (sessionId: string): string | undefined =>
			live.get(sessionId),
	};
}
