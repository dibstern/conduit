import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	SessionRow,
	TurnModelExecutionRow,
} from "../read-model-types.js";

export class ReadQueryEffectError extends Data.TaggedError(
	"ReadQueryEffectError",
)<{
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ReadQueryEffect {
	readonly getToolContent: (
		toolId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;

	readonly getSessionStatus: (
		sessionId: string,
	) => Effect.Effect<string | undefined, ReadQueryEffectError | SqlError>;

	readonly getSession: (
		sessionId: string,
	) => Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError>;

	readonly getAllSessionStatuses: () => Effect.Effect<
		Record<string, string>,
		ReadQueryEffectError | SqlError
	>;

	readonly listSessions: (opts?: {
		roots?: boolean;
	}) => Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError>;

	readonly getSessionMessagesWithParts: (
		sessionId: string,
	) => Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError>;

	/**
	 * Session-detail snapshot for a streaming subscription: the session's
	 * projected transcript rows plus the sequence high-water mark those rows
	 * reflect, read in ONE transaction so no append slips between the rows and
	 * the mark. The mark is `MAX(messages.last_applied_seq)` — the per-message
	 * watermark the message projector co-commits with every applied append-type
	 * delta — not `MAX(events.sequence)`, so it never claims deltas that are
	 * appended-but-not-yet-projected (which would gap live delivery).
	 */
	readonly getSessionDetailSnapshot: (
		sessionId: string,
	) => Effect.Effect<
		{ readonly messages: MessageWithParts[]; readonly sequence: number },
		ReadQueryEffectError | SqlError
	>;

	/**
	 * Shell (session-list) snapshot for a streaming subscription: every session
	 * row, recency-ordered, plus the sequence high-water mark those rows
	 * reflect, read in ONE transaction so no append slips between the mark and
	 * the rows. The mark is the session projector's cursor — the last sequence
	 * whose projection COMMITTED — not `MAX(events.sequence)`, which could
	 * claim an appended-but-not-yet-projected event and gap live delivery. The
	 * cursor is read before the rows: under-claiming is safe for whole-row
	 * upserts (idempotent re-emit); over-claiming would lose updates.
	 */
	readonly getSessionListSnapshot: () => Effect.Effect<
		{ readonly rows: readonly SessionRow[]; readonly sequence: number },
		ReadQueryEffectError | SqlError
	>;

	readonly getLatestTurnModelExecution: (
		sessionId: string,
	) => Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	>;
}

export class ReadQueryEffectTag extends Context.Tag("ReadQueryEffect")<
	ReadQueryEffectTag,
	ReadQueryEffect
>() {}

/** Attach each part to its message, preserving message and part order. */
function groupMessagesWithParts(
	messages: readonly MessageRow[],
	parts: readonly MessagePartRow[],
): MessageWithParts[] {
	const partsByMessage = new Map<string, MessagePartRow[]>();
	for (const part of parts) {
		let existing = partsByMessage.get(part.message_id);
		if (!existing) {
			existing = [];
			partsByMessage.set(part.message_id, existing);
		}
		existing.push(part);
	}
	return messages.map((message) => ({
		...message,
		parts: partsByMessage.get(message.id) ?? [],
	}));
}

export const makeReadQueryEffect = Effect.gen(function* () {
	const sql = yield* SqlClient.SqlClient;

	const getToolContent = (
		toolId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ content: string }>`
				SELECT content FROM tool_content WHERE tool_id = ${toolId}`;
			return rows[0]?.content;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getToolContent",
							cause: e,
						}),
			),
		);

	const getSessionStatus = (
		sessionId: string,
	): Effect.Effect<string | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ status: string }>`
				SELECT status FROM sessions WHERE id = ${sessionId}`;
			return rows[0]?.status;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionStatus",
							cause: e,
						}),
			),
		);

	const getSession = (
		sessionId: string,
	): Effect.Effect<SessionRow | undefined, ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const rows = yield* sql<SessionRow>`
				SELECT * FROM sessions WHERE id = ${sessionId}`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSession",
							cause: e,
						}),
			),
		);

	const getAllSessionStatuses = (): Effect.Effect<
		Record<string, string>,
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<{ id: string; status: string }>`
				SELECT id, status FROM sessions`;
			const result: Record<string, string> = {};
			for (const row of rows) {
				result[row.id] = row.status;
			}
			return result;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getAllSessionStatuses",
							cause: e,
						}),
			),
		);

	const listSessions = (opts?: {
		roots?: boolean;
	}): Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			if (opts?.roots) {
				return yield* sql<SessionRow>`
					SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC`;
			}
			return yield* sql<SessionRow>`
				SELECT * FROM sessions ORDER BY updated_at DESC`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "listSessions",
							cause: e,
						}),
			),
		);

	const getSessionMessagesWithParts = (
		sessionId: string,
	): Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const messages = yield* sql<
				MessageRow & {
					turn_requested_model: string | null;
					turn_expected_model: string | null;
					turn_actual_model: string | null;
				}
			>`
				SELECT messages.*,
					turns.requested_model AS turn_requested_model,
					turns.expected_model AS turn_expected_model,
					turns.actual_model AS turn_actual_model
				FROM messages
				LEFT JOIN turns ON turns.id = messages.turn_id
				WHERE messages.session_id = ${sessionId}
				ORDER BY messages.created_at ASC, messages.id ASC`;
			if (messages.length === 0) return [];

			const parts = yield* sql<MessagePartRow>`
				WITH target_messages AS (
					SELECT id FROM messages
					WHERE session_id = ${sessionId}
					ORDER BY created_at ASC, id ASC
				)
				SELECT mp.* FROM message_parts mp
				JOIN target_messages tm ON mp.message_id = tm.id
				ORDER BY mp.message_id, mp.sort_order`;

			const partsByMessage = new Map<string, MessagePartRow[]>();
			for (const part of parts) {
				let existing = partsByMessage.get(part.message_id);
				if (!existing) {
					existing = [];
					partsByMessage.set(part.message_id, existing);
				}
				existing.push(part);
			}

			return messages.map((message) => {
				const {
					turn_requested_model,
					turn_expected_model,
					turn_actual_model,
					...messageRow
				} = message;
				return {
					...messageRow,
					parts: partsByMessage.get(message.id) ?? [],
					...(turn_actual_model === null
						? {}
						: {
								modelExecution: {
									...(turn_requested_model === null
										? {}
										: { requestedModel: turn_requested_model }),
									...(turn_expected_model === null
										? {}
										: { expectedModel: turn_expected_model }),
									actualModel: turn_actual_model,
								},
							}),
				};
			});
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getSessionMessagesWithParts",
							cause: e,
						}),
			),
		);

	const getSessionDetailSnapshot = (
		sessionId: string,
	): Effect.Effect<
		{ readonly messages: MessageWithParts[]; readonly sequence: number },
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const messages = yield* sql<MessageRow>`
						SELECT * FROM messages
						WHERE session_id = ${sessionId}
						ORDER BY created_at ASC, id ASC`;

					let parts: readonly MessagePartRow[] = [];
					if (messages.length > 0) {
						parts = yield* sql<MessagePartRow>`
							WITH target_messages AS (
								SELECT id FROM messages
								WHERE session_id = ${sessionId}
								ORDER BY created_at ASC, id ASC
							)
							SELECT mp.* FROM message_parts mp
							JOIN target_messages tm ON mp.message_id = tm.id
							ORDER BY mp.message_id, mp.sort_order`;
					}

					const hwmRows = yield* sql<{ hwm: number | null }>`
						SELECT MAX(last_applied_seq) AS hwm FROM messages
						WHERE session_id = ${sessionId}`;

					return {
						messages: groupMessagesWithParts(messages, parts),
						sequence: hwmRows[0]?.hwm ?? 0,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "getSessionDetailSnapshot",
								cause: e,
							}),
				),
			);

	const getSessionListSnapshot = (): Effect.Effect<
		{ readonly rows: readonly SessionRow[]; readonly sequence: number },
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const cursorRows = yield* sql<{ hwm: number | null }>`
						SELECT last_applied_seq AS hwm FROM projector_cursors
						WHERE projector_name = 'session'`;
					const rows = yield* sql<SessionRow>`
						SELECT * FROM sessions ORDER BY updated_at DESC`;
					return { rows, sequence: cursorRows[0]?.hwm ?? 0 };
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "getSessionListSnapshot",
								cause: e,
							}),
				),
			);

	const getLatestTurnModelExecution = (
		sessionId: string,
	): Effect.Effect<
		TurnModelExecutionRow | undefined,
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			const rows = yield* sql<TurnModelExecutionRow>`
				SELECT requested_model, expected_model, actual_model
				FROM turns
				WHERE session_id = ${sessionId}
					AND actual_model IS NOT NULL
				ORDER BY requested_at DESC
				LIMIT 1`;
			return rows[0];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "getLatestTurnModelExecution",
							cause: e,
						}),
			),
		);

	return {
		getToolContent,
		getSessionStatus,
		getSession,
		getAllSessionStatuses,
		listSessions,
		getSessionMessagesWithParts,
		getSessionDetailSnapshot,
		getSessionListSnapshot,
		getLatestTurnModelExecution,
	} satisfies ReadQueryEffect;
});
