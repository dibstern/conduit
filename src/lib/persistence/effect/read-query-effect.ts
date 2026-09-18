import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type { SessionInfo } from "../../shared-types.js";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
	SessionRow,
	TurnModelExecutionRow,
} from "../read-model-types.js";

/**
 * What `sessionColumns` selects: the single session type with SQLite's NULLs
 * still in place for the two nullable columns.
 */
type SessionSelection = Omit<
	SessionInfo,
	"parentID" | "forkMessageId" | "messageCount" | "forkPointTimestamp"
> & {
	readonly parentID: string | null;
	readonly forkMessageId: string | null;
	readonly version: number;
};

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
	 * The session-list rows that moved inside `range`, each with the version it
	 * moved at, and the read-model version the answer is current through.
	 *
	 * `range` omitted is the same read over every version: a cold-start base and
	 * a live window are one query, not two mechanisms that can disagree. Rows
	 * and version are read in ONE transaction, so the version never claims a row
	 * the read could not see.
	 *
	 * `through` is what keeps a slow read honest. Without it the answer is
	 * whatever the read model holds when the query happens to run, which can be
	 * a commit whose advance is still queued — and a subscriber that treats
	 * those rows as seen will then discard that advance, taking its removals
	 * with it. No later query can recover them (§8).
	 */
	readonly readSessionList: (range?: {
		readonly after?: number;
		readonly through?: number;
	}) => Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionInfo;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	>;

	/**
	 * As {@link readSessionList}, for one session's projected transcript. A
	 * message part carries no version of its own, so a part write advances the
	 * message that owns it and the whole message comes back. Each row carries
	 * its own `version`.
	 */
	readonly readSessionTranscript: (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	) => Effect.Effect<
		{ readonly messages: MessageWithParts[]; readonly version: number },
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

	// ─── The session list reads ───────────────────────────────────────────
	// `readSessionList` is the only producer of the single session type (ni8.5
	// T-1) — what the shell subscription streams and what the browser holds.
	// The per-row re-query it replaced is gone: a subscriber asks for what moved
	// past a version, never for one row by id. These column aliases do the
	// renaming,
	// so no caller bridges a row into a session; the only step left in code is
	// NULL-to-absent, which SQL cannot express. `listSessions` stays a row read
	// for the server-internal callers that need columns the wire never carries
	// (the status poller's `updated_at`, permission-mode restore).
	const sessionColumns = sql.literal(
		`id, title, status, version,
		 created_at AS createdAt, updated_at AS updatedAt,
		 parent_id AS parentID, fork_point_event AS forkMessageId`,
	);

	// The version stays beside the session rather than on it: it is a fact about
	// the read model, not a field the wire carries.
	const toSession = ({
		version,
		parentID,
		forkMessageId,
		...session
	}: SessionSelection): { item: SessionInfo; version: number } => ({
		item: {
			...session,
			...(parentID !== null && { parentID }),
			...(forkMessageId !== null && { forkMessageId }),
		},
		version,
	});

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

	// ─── The versioned subscription reads ─────────────────────────────────
	// One query per source serves cold start, resume catch-up and every live
	// advance. `version` is the read-model counter, read FIRST inside the
	// transaction so the rows that follow are from the same consistent state:
	// the number handed to a subscriber never claims a row the read missed.
	//
	// A base read is a catch-up from before the first version. The 0012 backfill
	// left undatable rows at 0, so the floor is -1 rather than 0 — otherwise a
	// cold start would silently skip them.
	const BEFORE_FIRST_VERSION = -1;
	// An unbounded read is bounded by a number the counter cannot reach, which
	// keeps one query shape for both the base and a windowed live read.
	const AFTER_LAST_VERSION = Number.MAX_SAFE_INTEGER;

	const readModelVersion = Effect.gen(function* () {
		const rows = yield* sql<{ value: number }>`
			SELECT value FROM read_model_counter WHERE id = 1`;
		return rows[0]?.value ?? 0;
	});

	const readSessionList = (range?: {
		readonly after?: number;
		readonly through?: number;
	}): Effect.Effect<
		{
			readonly rows: readonly {
				readonly item: SessionInfo;
				readonly version: number;
			}[];
			readonly version: number;
		},
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const rows = yield* sql<SessionSelection>`
						SELECT ${sessionColumns} FROM sessions
						WHERE version > ${range?.after ?? BEFORE_FIRST_VERSION}
							AND version <= ${range?.through ?? AFTER_LAST_VERSION}
						ORDER BY updated_at DESC`;
					return { rows: rows.map(toSession), version };
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionList",
								cause: e,
							}),
				),
			);

	const readSessionTranscript = (
		sessionId: string,
		range?: { readonly after?: number; readonly through?: number },
	): Effect.Effect<
		{ readonly messages: MessageWithParts[]; readonly version: number },
		ReadQueryEffectError | SqlError
	> =>
		sql
			.withTransaction(
				Effect.gen(function* () {
					const version = yield* readModelVersion;
					const floor = range?.after ?? BEFORE_FIRST_VERSION;
					const ceiling = range?.through ?? AFTER_LAST_VERSION;
					const messages = yield* sql<MessageRow>`
						SELECT * FROM messages
						WHERE session_id = ${sessionId}
							AND version > ${floor} AND version <= ${ceiling}
						ORDER BY created_at ASC, id ASC`;

					let parts: readonly MessagePartRow[] = [];
					if (messages.length > 0) {
						parts = yield* sql<MessagePartRow>`
							WITH target_messages AS (
								SELECT id FROM messages
								WHERE session_id = ${sessionId}
									AND version > ${floor} AND version <= ${ceiling}
							)
							SELECT mp.* FROM message_parts mp
							JOIN target_messages tm ON mp.message_id = tm.id
							ORDER BY mp.message_id, mp.sort_order`;
					}

					return {
						messages: groupMessagesWithParts(messages, parts),
						version,
					};
				}),
			)
			.pipe(
				Effect.mapError((e) =>
					e instanceof ReadQueryEffectError
						? e
						: new ReadQueryEffectError({
								operation: "readSessionTranscript",
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
		readSessionList,
		readSessionTranscript,
		getLatestTurnModelExecution,
	} satisfies ReadQueryEffect;
});
