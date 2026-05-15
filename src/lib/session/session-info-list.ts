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
	pendingQuestionCounts?: ReadonlyMap<string, number>,
): SessionInfo[] {
	return sessions
		.map((s) => {
			const lastMsgTime = lastMessageAt?.get(s.id);
			const displayTime = lastMsgTime ?? s.time?.created ?? 0;
			const forkEntry = forkMeta?.get(s.id);
			const parentID = s.parentID ?? forkEntry?.parentID;

			const info: SessionInfo = {
				id: s.id,
				title: s.title ?? "Untitled",
				updatedAt: displayTime,
				messageCount: 0,
				...(parentID != null && { parentID }),
				...(forkEntry != null && { forkMessageId: forkEntry.forkMessageId }),
				...(forkEntry?.forkPointTimestamp != null && {
					forkPointTimestamp: forkEntry.forkPointTimestamp,
				}),
			};

			const status = statuses?.[s.id];
			if (status && (status.type === "busy" || status.type === "retry")) {
				info.processing = true;
			}

			const qCount = pendingQuestionCounts?.get(s.id);
			if (qCount != null && qCount > 0) {
				info.pendingQuestionCount = qCount;
			}

			return info;
		})
		.sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));
}
