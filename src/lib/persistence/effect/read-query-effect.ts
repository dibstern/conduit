import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	PendingApprovalCountRow,
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
		limit?: number;
		titleQuery?: string;
		before?: { updatedAt: number; id: string };
	}) => Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError>;

	readonly countPendingApprovalsBySession: () => Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionMessagesWithParts: (
		sessionId: string,
	) => Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError>;

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
		limit?: number;
		titleQuery?: string;
		before?: { updatedAt: number; id: string };
	}): Effect.Effect<readonly SessionRow[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const predicates = [];
			if (opts?.roots) predicates.push(sql`parent_id IS NULL`);
			if (opts?.titleQuery !== undefined) {
				const escapedQuery = opts.titleQuery.replace(/[\\%_]/g, "\\$&");
				const pattern = `%${escapedQuery}%`;
				// SQLite LIKE is ASCII-case-insensitive; we accept non-ASCII case sensitivity until deep search adds a collation.
				predicates.push(sql`title LIKE ${pattern} ESCAPE '\\'`);
			}
			if (opts?.before !== undefined) {
				predicates.push(
					sql`(updated_at < ${opts.before.updatedAt} OR (updated_at = ${opts.before.updatedAt} AND id < ${opts.before.id}))`,
				);
			}
			const limit =
				opts?.limit === undefined ? sql.literal("") : sql`LIMIT ${opts.limit}`;

			// The id DESC tiebreaker makes equal timestamps deterministic. This
			// deliberately replaces the previous arbitrary per-query tie ordering and
			// is required so keyset pages neither duplicate nor skip rows.
			return yield* sql<SessionRow>`
				SELECT * FROM sessions
				WHERE ${sql.and(predicates)}
				ORDER BY updated_at DESC, id DESC
				${limit}`;
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

	const countPendingApprovalsBySession = (): Effect.Effect<
		readonly PendingApprovalCountRow[],
		ReadQueryEffectError | SqlError
	> =>
		Effect.gen(function* () {
			return yield* sql<PendingApprovalCountRow>`
				SELECT session_id, type, COUNT(*) AS pending_count
				FROM pending_approvals
				WHERE status = 'pending'
				GROUP BY session_id, type`;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ReadQueryEffectError
					? e
					: new ReadQueryEffectError({
							operation: "countPendingApprovalsBySession",
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
		countPendingApprovalsBySession,
		getSessionMessagesWithParts,
		getLatestTurnModelExecution,
	} satisfies ReadQueryEffect;
});
