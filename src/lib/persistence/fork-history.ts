import { Data, Effect } from "effect";
import { SqlClient } from "effect/sql";

export class ForkRefusal extends Data.TaggedError("ForkRefusal")<{
	readonly reason:
		| "no_completed_turn"
		| "no_transcript"
		| "message_not_found"
		| "point_not_found";
	readonly messageId?: string;
}> {}

export interface ForkSource {
	readonly boundary: {
		readonly messageId: string;
		readonly createdAt: number;
		readonly sequence: number;
	};
	readonly historyMessageId?: string;
	readonly lastRewindCommitSequence: number;
	readonly instanceIds: ReadonlySet<string>;
	readonly retained: readonly {
		readonly id: string;
		readonly role: string;
		readonly created_at: number;
	}[];
}

const FORK_BOUNDARY_TYPES = [
	"session.created",
	"session.provider_changed",
	"session.status",
	"session.rewind_committed",
	"message.created",
	"message.removed",
	"turn.completed",
];

interface BoundaryRow {
	readonly sequence: number;
	readonly type: string;
	readonly message_id: string | null;
	readonly status: string | null;
	readonly provider: string | null;
	readonly old_provider: string | null;
	readonly new_provider: string | null;
	readonly stream_end: number;
}

const readBoundaryRows = Effect.fn("fork.readBoundaryRows")(function* (
	parentId: string,
) {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql<BoundaryRow>`
		SELECT sequence, type,
			json_extract(data, '$.messageId') AS message_id,
			json_extract(data, '$.status') AS status,
			json_extract(data, '$.provider') AS provider,
			json_extract(data, '$.oldProvider') AS old_provider,
			json_extract(data, '$.newProvider') AS new_provider,
			(SELECT MAX(sequence) FROM events WHERE session_id = ${parentId}) AS stream_end
		FROM events INDEXED BY idx_events_session_type
		WHERE session_id = ${parentId} AND type IN ${sql.in(FORK_BOUNDARY_TYPES)}
		ORDER BY sequence`;
});

// OpenCode emits intermediate turn.completed events. Only status idle closes a
// whole turn; a prompt after that idle is already queued before busy arrives.
const midTurnForkBoundary = (rows: readonly BoundaryRow[]) =>
	Effect.gen(function* () {
		let busy = false;
		let idle = -1;
		for (const row of rows) {
			if (row.type !== "session.status") continue;
			busy = row.status !== "idle";
			if (!busy) idle = row.sequence;
		}
		if (
			!busy &&
			(idle < 0 ||
				!rows.some(
					(row) => row.type === "message.created" && row.sequence > idle,
				))
		)
			return undefined;
		const completed = rows.reduce<BoundaryRow | undefined>(
			(completed, row) =>
				row.type === "turn.completed" && row.sequence < idle ? row : completed,
			undefined,
		);
		if (!completed?.message_id)
			return yield* new ForkRefusal({ reason: "no_completed_turn" });
		return completed.message_id;
	});

/** OpenCode needs only the mid-turn decision; its native API owns the copy. */
export const readSideThreadForkBoundary = Effect.fn(
	"fork.readSideThreadForkBoundary",
)(function* (parentId: string) {
	return yield* midTurnForkBoundary(yield* readBoundaryRows(parentId));
});

/** Resolve visible rows without reading or decoding transcript events. */
export const readForkSource = Effect.fn("fork.readForkSource")(function* (
	parentId: string,
	at: { readonly messageId?: string; readonly sideThread: boolean },
) {
	const sql = yield* SqlClient.SqlClient;
	return yield* sql.withTransaction(
		Effect.gen(function* () {
			const messages = yield* sql<{
				readonly id: string;
				readonly role: string;
				readonly created_at: number;
				readonly last_applied_seq: number | null;
				readonly is_inherited: number;
				readonly current_provider: string;
				readonly pending_rewind_message_id: string | null;
				readonly completed_turn: number;
				readonly assistant_message_id: string | null;
				readonly removed: number;
			}>`
				SELECT m.id, m.role, m.created_at, m.last_applied_seq, m.is_inherited,
					s.provider AS current_provider, s.pending_rewind_message_id,
					COALESCE(t.state = 'completed', 0) AS completed_turn, t.assistant_message_id,
					EXISTS (SELECT 1 FROM message_tombstones removed
						WHERE removed.session_id = m.session_id AND removed.message_id = m.id) AS removed
				FROM messages m JOIN sessions s ON s.id = m.session_id
				LEFT JOIN turns t ON t.id = COALESCE(m.turn_id, m.id)
					AND t.session_id = m.session_id
				WHERE m.session_id = ${parentId}
					AND NOT EXISTS (
						SELECT 1 FROM messages cut
						WHERE cut.id = s.pending_rewind_message_id AND cut.session_id = s.id
							AND (m.created_at > cut.created_at
								OR (m.created_at = cut.created_at AND m.id >= cut.id))
					)
				ORDER BY m.created_at, m.id`;
			if (
				at.messageId !== undefined &&
				messages.some(
					(message) => message.id === at.messageId && message.removed === 1,
				)
			)
				return yield* new ForkRefusal({
					reason: "point_not_found",
					messageId: at.messageId,
				});
			const visible = messages.filter((message) => message.removed === 0);
			const point =
				at.messageId !== undefined
					? visible.find((message) => message.id === at.messageId)
					: at.sideThread
						? visible
								.filter(
									(message) =>
										(message.role === "assistant" ||
											message.assistant_message_id === null) &&
										message.completed_turn === 1,
								)
								.at(-1)
						: visible.at(-1);
			if (!point)
				return yield* new ForkRefusal({
					reason:
						at.messageId !== undefined
							? "message_not_found"
							: at.sideThread
								? "no_completed_turn"
								: "no_transcript",
					...(at.messageId !== undefined && { messageId: at.messageId }),
				});
			// Native Claude receipts are ordered by events. These two scalar keys
			// retain that contract without reading any history payloads to copy.
			const [keys] = yield* sql<{
				readonly creation: number | null;
				readonly rewind: number | null;
			}>`SELECT
				(SELECT MIN(sequence) FROM events
					WHERE session_id = ${parentId} AND type = 'message.created'
						AND json_extract(data, '$.messageId') = ${point.id}) AS creation,
				(SELECT MAX(sequence) FROM events
					WHERE session_id = ${parentId} AND type = 'session.rewind_committed') AS rewind`;
			const sequence =
				keys?.creation ??
				(point.is_inherited === 1 ? point.last_applied_seq : null);
			if (sequence == null)
				return yield* new ForkRefusal({
					reason: "point_not_found",
					messageId: point.id,
				});
			const providers = yield* sql<{ readonly provider: string }>`
				SELECT provider FROM session_providers WHERE session_id = ${parentId}
				ORDER BY activated_at,
					CASE WHEN id = ${`${parentId}:initial`} THEN 0
						ELSE CAST(substr(id, length(${parentId}) + 2) AS INTEGER) END`;
			const lastRewindCommitSequence = keys?.rewind ?? 0;
			const historyMessageId =
				at.messageId ??
				(at.sideThread ||
				point.pending_rewind_message_id !== null ||
				lastRewindCommitSequence > 0
					? point.id
					: undefined);
			const source: ForkSource = {
				boundary: {
					messageId: point.id,
					createdAt: point.created_at,
					sequence,
				},
				...(historyMessageId !== undefined && { historyMessageId }),
				lastRewindCommitSequence,
				instanceIds: new Set([
					point.current_provider,
					...providers.map(({ provider }) => provider),
				]),
				retained: visible.map(({ id, role, created_at }) => ({
					id,
					role,
					created_at,
				})),
			};
			return source;
		}),
	);
});
