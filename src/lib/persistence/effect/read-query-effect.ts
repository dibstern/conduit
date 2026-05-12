import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Context, Data, Effect } from "effect";
import type {
	MessagePartRow,
	MessageRow,
	MessageWithParts,
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

	readonly getAllSessionStatuses: () => Effect.Effect<
		Record<string, string>,
		ReadQueryEffectError | SqlError
	>;

	readonly getSessionMessagesWithParts: (
		sessionId: string,
	) => Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError>;
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

	const getSessionMessagesWithParts = (
		sessionId: string,
	): Effect.Effect<MessageWithParts[], ReadQueryEffectError | SqlError> =>
		Effect.gen(function* () {
			const messages = yield* sql<MessageRow>`
				SELECT * FROM messages
				WHERE session_id = ${sessionId}
				ORDER BY created_at ASC, id ASC`;
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

			return messages.map((message) => ({
				...message,
				parts: partsByMessage.get(message.id) ?? [],
			}));
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

	return {
		getToolContent,
		getSessionStatus,
		getAllSessionStatuses,
		getSessionMessagesWithParts,
	} satisfies ReadQueryEffect;
});
