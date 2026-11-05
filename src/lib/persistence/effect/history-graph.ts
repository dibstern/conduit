/**
 * The History Graph (ADR-0014, 82tn.50): one node per Ended Run, parent edges, and one Head per
 * session. `messages`, `message_parts` and `turns` hold exactly the head path, so their readers
 * never compute it; rows leaving the head path move to `history_off_head`, kept with their node.
 * Only projectors call this module: the Run Ledger arm builds a node at each Run end and moves
 * the Head to it, and the message projector moves the Head at a rewind, an undo and a commit.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/**
 * The ledger ended `runId`: the session's untagged rows become its node, a child of the Head,
 * and the Head moves to it. A Run that wrote no row (cancelled while queued, or a Run whose steer
 * joined another) gets no node. A subagent session with no Run of its own (a child that is not a
 * Side Thread) keeps its own graph: its untagged rows become its own node for the same Run.
 */
export const sealHistoryNode = (sessionId: string, runId: string, at: number) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const sessions = yield* sql<{ id: string }>`
			WITH RECURSIVE family(id) AS (
				SELECT ${sessionId}
				UNION ALL
				SELECT s.id FROM sessions s JOIN family f ON s.parent_id = f.id
				WHERE s.side_thread = 0
					AND NOT EXISTS (SELECT 1 FROM run_ledger_sessions l WHERE l.session_id = s.id)
			)
			SELECT id FROM family`;
		let sealed = false;
		for (const { id } of sessions) {
			const [untagged] = yield* sql<{ n: number }>`
				SELECT count(*) AS n FROM messages
				WHERE session_id = ${id} AND history_node_id IS NULL`;
			if (!untagged?.n) continue;
			yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
				VALUES (${id}, ${runId}, (SELECT node_id FROM history_heads WHERE session_id = ${id}),
					${runId}, 1, ${at})
				ON CONFLICT (session_id, id) DO NOTHING`;
			yield* sql`UPDATE messages SET history_node_id = ${runId}
				WHERE session_id = ${id} AND history_node_id IS NULL`;
			yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES (${id}, ${runId})
				ON CONFLICT (session_id) DO UPDATE SET node_id = excluded.node_id`;
			sealed = true;
		}
		return sealed;
	});

/**
 * A row written while no Run is open (a lost Run's error, a late notice) is the last word of
 * the Run before it, so it joins the Head's node. A row written while a Run is open waits for
 * that Run's end, which tags it.
 */
export const joinHeadWhileIdle = (
	sessionId: string,
	messageIds: readonly string[],
) =>
	Effect.gen(function* () {
		if (messageIds.length === 0) return;
		const sql = yield* SqlClient.SqlClient;
		yield* sql`UPDATE messages
			SET history_node_id = (SELECT node_id FROM history_heads WHERE session_id = ${sessionId})
			WHERE session_id = ${sessionId} AND id IN ${sql.in(messageIds)} AND history_node_id IS NULL
				AND NOT EXISTS (SELECT 1 FROM run_ledger_sessions
					WHERE session_id = ${sessionId} AND active_run_id IS NOT NULL)`;
	});

/**
 * The Head is the node of the newest tagged row on the head path: before `cutId` while a rewind
 * to it is pending, else the newest. A rewind to a node's first row (a steer snaps there) lands
 * on its parent, a cut at a reply stays on the reply's node, and an undo lands back where it was.
 */
export const refreshHistoryHead = (sessionId: string, cutId: string | null) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO history_heads (session_id, node_id)
			SELECT ${sessionId}, (
				SELECT m.history_node_id FROM messages m
				LEFT JOIN messages cut ON cut.id = ${cutId} AND cut.session_id = m.session_id
				WHERE m.session_id = ${sessionId} AND m.history_node_id IS NOT NULL
					AND (cut.id IS NULL OR (m.ordinal, m.created_at, m.id) < (cut.ordinal, cut.created_at, cut.id))
				ORDER BY m.ordinal DESC, m.created_at DESC, m.id DESC LIMIT 1)
			WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId})
			ON CONFLICT (session_id) DO UPDATE SET node_id = excluded.node_id`;
	});

/** A row of `table` as one JSON object over all its columns, so a later column is kept too. */
const rowJson = (table: "messages" | "message_parts", alias: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const columns = yield* sql.unsafe<{ name: string }>(
			`PRAGMA table_info(${table})`,
		);
		return `json_object(${columns.map(({ name }) => `'${name}', ${alias}."${name}"`).join(", ")})`;
	});

/**
 * Moves `messageIds` and their parts off the head path into `history_off_head`, each with its
 * node, before their removal from the head-path tables. Nothing of a branch is lost.
 */
export const keepOffHead = (sessionId: string, messageIds: readonly string[]) =>
	Effect.gen(function* () {
		if (messageIds.length === 0) return;
		const sql = yield* SqlClient.SqlClient;
		const list = JSON.stringify(messageIds);
		const message = yield* rowJson("messages", "m");
		const part = yield* rowJson("message_parts", "p");
		yield* sql.unsafe(
			`INSERT OR REPLACE INTO history_off_head (session_id, node_id, source_table, row_key, row_json)
			SELECT m.session_id, m.history_node_id, 'messages', m.id, ${message} FROM messages m
			WHERE m.session_id = ? AND m.id IN (SELECT value FROM json_each(?))`,
			[sessionId, list],
		);
		yield* sql.unsafe(
			`INSERT OR REPLACE INTO history_off_head (session_id, node_id, source_table, row_key, row_json)
			SELECT m.session_id, m.history_node_id, 'message_parts', p.id, ${part}
			FROM message_parts p JOIN messages m ON m.id = p.message_id
			WHERE m.session_id = ? AND m.id IN (SELECT value FROM json_each(?))`,
			[sessionId, list],
		);
	});
