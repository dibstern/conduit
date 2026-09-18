import type { ForkEntry } from "../daemon/fork-metadata.js";
import type { SessionDetail, SessionStatus } from "../instance/sdk-types.js";
import type { SessionInfo } from "../types.js";

/**
 * Convert OpenCode SessionDetail[] -> sorted SessionInfo[] for the frontend.
 *
 * Sorting priority: last message timestamp, falling back to session creation
 * time for sessions with no messages. This keeps session order tied to actual
 * conversation activity, not metadata updates such as renames.
 */
export function toSessionInfoList(
	sessions: SessionDetail[],
	statuses?: Record<string, SessionStatus>,
	lastMessageAt?: ReadonlyMap<string, number>,
	forkMeta?: ReadonlyMap<string, ForkEntry>,
): SessionInfo[] {
	return sessions
		.map((s) => {
			const lastMsgTime = lastMessageAt?.get(s.id);
			const displayTime = lastMsgTime ?? s.time?.created ?? 0;
			const forkEntry = forkMeta?.get(s.id);
			const parentID = s.parentID ?? forkEntry?.parentID;
			// OpenCode has no `sessions` row to read a status off, so the poller's
			// live view stands in for one. Its vocabulary is wider than the row's:
			// anything the projection could not have stored reads as idle.
			const status = statuses?.[s.id]?.type;

			return {
				id: s.id,
				title: s.title ?? "Untitled",
				status: status === "busy" || status === "retry" ? status : "idle",
				updatedAt: displayTime,
				...(parentID != null && { parentID }),
				...(forkEntry != null && { forkMessageId: forkEntry.forkMessageId }),
				...(forkEntry?.forkPointTimestamp != null && {
					forkPointTimestamp: forkEntry.forkPointTimestamp,
				}),
			} satisfies SessionInfo;
		})
		.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
