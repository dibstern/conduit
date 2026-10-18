import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { canonicalEvent } from "../events.js";

/** Read inside the ingestion write boundary, immediately before appending. */
export const readPendingRewindCommit = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	upstreamRemovedId?: string,
) =>
	Effect.gen(function* () {
		const [session] = yield* sql<{
			pending_rewind_message_id: string | null;
			provider: string;
		}>`SELECT pending_rewind_message_id, provider FROM sessions WHERE id = ${sessionId}`;
		if (!session?.pending_rewind_message_id) return undefined;
		const messages = yield* sql<{ id: string }>`SELECT id FROM messages
			WHERE session_id = ${sessionId} ORDER BY created_at, id`;
		const cut = messages.findIndex(
			(message) => message.id === session.pending_rewind_message_id,
		);
		if (cut < 0) return undefined;
		const removed = messages.slice(cut);
		if (
			upstreamRemovedId !== undefined &&
			!removed.some((message) => message.id === upstreamRemovedId)
		)
			return undefined;
		const metadata = { provider: session.provider };
		return {
			rewind: {
				resumeSessionAt: messages[cut - 1]?.id ?? null,
				targetMessageId: session.pending_rewind_message_id,
			},
			events: [
				...removed.map((message) =>
					canonicalEvent(
						"message.removed",
						sessionId,
						{ messageId: message.id },
						metadata,
					),
				),
				canonicalEvent(
					"session.rewind_committed",
					sessionId,
					{
						messageId: session.pending_rewind_message_id,
					},
					metadata,
				),
			],
		};
	});
