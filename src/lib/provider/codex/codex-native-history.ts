import { realpathSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { codexAccountHome } from "./codex-home.js";
import { readCodexSessionIdentity } from "./codex-session-store.js";

/** The session and the sessions its rows were copied from, each with the id suffix its copies
 *  carry here and the last event of it they hold. */
const ancestors = (sql: SqlClient.SqlClient, sessionId: string) =>
	sql`WITH RECURSIVE ancestors(session_id, suffix, through_sequence) AS (
		SELECT ${sessionId}, '', 9223372036854775807
		UNION ALL
		SELECT COALESCE(json_extract(e.data, '$.forkedFrom'), json_extract(e.data, '$.parentId')),
			'_' || a.session_id || a.suffix, e.sequence
		FROM ancestors a JOIN events e ON e.session_id = a.session_id
			AND e.type = 'session.created' AND e.sequence < a.through_sequence
		WHERE json_extract(e.data, '$.inheritsHistory') = 1
			AND COALESCE(json_extract(e.data, '$.forkedFrom'), json_extract(e.data, '$.parentId')) IS NOT NULL
	)`;

/** Resolve persisted refs, including messages copied through fork lineage. */
export const readCodexNativeTurns = Effect.fn("codex.readNativeTurns")(
	function* (sessionId: string) {
		const sql = yield* SqlClient.SqlClient;
		return yield* sql<{
			readonly turnId: string;
			readonly nativeTurnId: string;
			readonly threadId: string;
			readonly completed: number;
		}>`${ancestors(sql, sessionId)}
		SELECT t.id AS turnId,
			json_extract(e.metadata, '$.providerRefs.providerTurnId') AS nativeTurnId,
			json_extract(e.metadata, '$.providerRefs.providerSessionId') AS threadId,
			MAX(json_extract(e.metadata, '$.source') = 'codex.native-turn.completed') AS completed
		FROM ancestors a JOIN events e ON e.session_id = a.session_id
			AND e.sequence < a.through_sequence AND e.type = 'message.created'
		JOIN messages m ON m.id = json_extract(e.data, '$.messageId') || a.suffix
			AND m.session_id = ${sessionId}
		JOIN turns t ON t.id = COALESCE(m.turn_id, m.id) AND t.session_id = m.session_id
		WHERE json_type(e.metadata, '$.providerRefs.providerTurnId') = 'text'
			AND NOT EXISTS (SELECT 1 FROM message_tombstones removed
				WHERE removed.session_id = m.session_id AND removed.message_id = m.id)
		GROUP BY t.id, nativeTurnId, threadId
		ORDER BY t.requested_at, t.rowid, MIN(e.sequence)`;
	},
);

/** The native turns of rows a head move took off the Head, in the order given. A fork's copies
 *  carry the fork's id suffix, and their refs sit on the source's events. */
export const readCodexRemovedTurns = Effect.fn("codex.readRemovedTurns")(
	function* (sessionId: string, messageIds: readonly string[]) {
		if (messageIds.length === 0) return [];
		const sql = yield* SqlClient.SqlClient;
		const turns = yield* sql<{
			readonly messageId: string;
			readonly nativeTurnId: string;
			readonly threadId: string;
		}>`${ancestors(sql, sessionId)}
		SELECT json_extract(e.data, '$.messageId') || a.suffix AS messageId,
			json_extract(e.metadata, '$.providerRefs.providerTurnId') AS nativeTurnId,
			json_extract(e.metadata, '$.providerRefs.providerSessionId') AS threadId
		FROM ancestors a JOIN events e ON e.session_id = a.session_id
			AND e.sequence < a.through_sequence AND e.type = 'message.created'
		WHERE json_extract(e.data, '$.messageId') || a.suffix IN ${sql.in(messageIds)}
			AND json_type(e.metadata, '$.providerRefs.providerTurnId') = 'text'
		ORDER BY e.sequence`;
		return [...turns].sort(
			(a, b) =>
				messageIds.indexOf(a.messageId) - messageIds.indexOf(b.messageId),
		);
	},
);

/** Freeze eligibility at fork creation, while the parent may still be running. */
export const resolveCodexForkSource = Effect.fn("codex.resolveForkSource")(
	function* (
		parentId: string,
		messageId: string,
		home: string,
		configDir: string,
	) {
		const sql = yield* SqlClient.SqlClient;
		const parent = yield* Effect.try(() =>
			readCodexSessionIdentity(configDir, parentId),
		);
		if (!parent) return undefined;
		const parentHome =
			parent.codexHome ?? codexAccountHome(undefined, configDir);
		const shared = yield* Effect.try(
			() =>
				parentHome === home ||
				realpathSync(join(parentHome, "sessions")) ===
					realpathSync(join(home, "sessions")),
		).pipe(Effect.orElseSucceed(() => false));
		if (!shared) return undefined;
		const [point] = yield* sql<{
			turnId: string;
		}>`SELECT COALESCE(turn_id, id) AS turnId FROM messages
			WHERE session_id = ${parentId} AND id = ${messageId}`;
		const refs = (yield* readCodexNativeTurns(parentId)).filter(
			(ref) =>
				ref.threadId === parent.threadId ||
				parent.inheritedThreadIds?.includes(ref.threadId) ||
				ref.threadId === parent.forkSource?.threadId,
		);
		const end = refs.reduce(
			(last, ref, index) => (ref.turnId === point?.turnId ? index : last),
			-1,
		);
		if (end < 0) return undefined;
		const ref = refs
			.slice(0, end + 1)
			.filter((ref) => ref.completed === 1)
			.at(-1);
		return ref
			? {
					threadId: parent.threadId,
					lastTurnId: ref.nativeTurnId,
					inheritedThreadIds: [
						parent.threadId,
						...(parent.inheritedThreadIds ?? []),
					],
				}
			: undefined;
	},
);
