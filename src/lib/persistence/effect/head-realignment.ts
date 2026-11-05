import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { canonicalEvent } from "../events.js";
import { pathToRoot, readHead } from "./history-graph.js";

/**
 * 82tn.51: a head move lands without calling the provider (3c7y); the next send tells it. The
 * provider still holds the path it last saw: the Head before the first move since the last
 * confirmation. What it must drop starts at the first node of that path off the Head now, and
 * it resumes at the Head's last message. A provider that cannot resume there (a branch it never
 * saw) falls back as it does for a failed cut. Read inside the send's write boundary; with
 * `upstreamRemovedId`, only that removal confirms.
 */
export const readOwedRealignment = (
	sql: SqlClient.SqlClient,
	sessionId: string,
	upstreamRemovedId?: string,
) =>
	Effect.gen(function* () {
		const moves = yield* sql<{
			move_id: string;
			from_node: string | null;
			started_at: number;
		}>`
			SELECT json_extract(moved.data, '$.moveId') AS move_id, started.sequence AS started_at,
				json_extract(started.data, '$.from') AS from_node
			FROM events moved JOIN events started ON started.session_id = moved.session_id
				AND started.type = 'head.move_started'
				AND json_extract(started.data, '$.moveId') = json_extract(moved.data, '$.moveId')
			WHERE moved.session_id = ${sessionId} AND moved.type = 'head.moved'
				AND json_type(moved.data, '$.to') IS NOT NULL
				AND moved.sequence > COALESCE((SELECT MAX(sequence) FROM events
					WHERE session_id = ${sessionId} AND type = 'session.rewind_committed'
					AND json_extract(data, '$.moveId') IS NOT NULL), 0)
			ORDER BY moved.sequence`;
		const first = moves[0];
		const last = moves.at(-1);
		if (!first || !last) return undefined;
		const head = yield* readHead(sessionId);
		const onHead = new Set(yield* pathToRoot(sessionId, head));
		const lost = (yield* pathToRoot(sessionId, first.from_node))
			.filter((id) => !onHead.has(id))
			.reverse();
		const removed =
			lost.length === 0
				? []
				: yield* sql<{ id: string; node: string }>`
					SELECT row_key AS id, node_id AS node FROM history_off_head
					WHERE session_id = ${sessionId} AND source_table = 'messages'
						AND node_id IN ${sql.in(lost)}
					ORDER BY json_extract(row_json, '$.ordinal'), json_extract(row_json, '$.created_at'), row_key`;
		const target = removed.find(({ node }) => node === lost[0])?.id;
		if (upstreamRemovedId !== undefined && upstreamRemovedId !== target)
			return undefined;
		// The provider resumes at the newest row it holds. Conduit's own notices (an error, a
		// compaction marker) never reach it (as inherit-fork-history skips them), and nothing written
		// since the first move did either: a send that reached it would have confirmed the move.
		const [resume] = yield* sql<{ id: string }>`SELECT id FROM messages
			WHERE session_id = ${sessionId}
				AND id NOT GLOB 'compaction-[0-9]*' AND id NOT GLOB 'turn-error-[0-9]*'
				AND id NOT IN (SELECT COALESCE(json_extract(data, '$.messageId'), '') FROM events
					WHERE session_id = ${sessionId} AND sequence > ${first.started_at}
						AND type = 'message.created')
			ORDER BY ordinal DESC, created_at DESC, id DESC LIMIT 1`;
		const [session] = yield* sql<{ provider: string }>`
			SELECT provider FROM sessions WHERE id = ${sessionId}`;
		return {
			removedMessageIds: removed.map(({ id }) => id),
			// Nothing the provider holds left the Head (a move and its undo): it only confirms.
			rewind:
				target === undefined
					? undefined
					: { resumeSessionAt: resume?.id ?? null, targetMessageId: target },
			events: [
				canonicalEvent(
					"session.rewind_committed",
					sessionId,
					{ messageId: target ?? resume?.id ?? "", moveId: last.move_id },
					{ provider: session?.provider ?? "" },
				),
			],
		};
	}).pipe(Effect.provideService(SqlClient.SqlClient, sql));
