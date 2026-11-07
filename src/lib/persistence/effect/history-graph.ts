/**
 * The History Graph (ADR-0014, 82tn.50): one node per Ended Run, parent edges, and one Head per
 * session. `messages`, `message_parts` and `turns` hold exactly the head path, so their readers
 * never compute it; rows leaving the head path move to `history_off_head`, kept with their node.
 * Only projectors call this module: the Run Ledger arm builds a node at each Run end and moves
 * the Head to it, and the message projector moves it at a head move (82tn.51).
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
 * A fork whose provider copied the transcript (OpenCode, `inheritsHistory: false`) imports the
 * copy as inherited rows. They are the fork point's node, the root of the fork's graph, so the
 * fork's Runs follow it and a rewind of its first Run keeps the copy. A copy landing after a
 * Run sealed still comes first.
 */
export const joinForkPoint = (
	sessionId: string,
	messageIds: readonly string[],
	at: number,
) =>
	Effect.gen(function* () {
		if (messageIds.length === 0) return;
		const sql = yield* SqlClient.SqlClient;
		const tagged = yield* sql<{
			id: string;
		}>`UPDATE messages SET history_node_id = 'fork-point'
			WHERE session_id = ${sessionId} AND id IN ${sql.in(messageIds)}
				AND is_inherited = 1 AND history_node_id IS NULL
			RETURNING id`;
		if (tagged.length === 0) return;
		yield* sql`INSERT INTO history_nodes (session_id, id, parent_id, run_id, available, created_at)
			VALUES (${sessionId}, 'fork-point', NULL, NULL, 1, ${at})
			ON CONFLICT (session_id, id) DO NOTHING`;
		yield* sql`UPDATE history_nodes SET parent_id = 'fork-point'
			WHERE session_id = ${sessionId} AND parent_id IS NULL AND id != 'fork-point'`;
		yield* sql`INSERT INTO history_heads (session_id, node_id) VALUES (${sessionId}, 'fork-point')
			ON CONFLICT (session_id) DO UPDATE SET node_id = COALESCE(history_heads.node_id, excluded.node_id)`;
	});

/** The Head is the node of the newest tagged row on the head path (82tn.51: no pending cut). */
export const refreshHistoryHead = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO history_heads (session_id, node_id)
			SELECT ${sessionId}, (
				SELECT history_node_id FROM messages
				WHERE session_id = ${sessionId} AND history_node_id IS NOT NULL
				ORDER BY ordinal DESC, created_at DESC, id DESC LIMIT 1)
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
 * node, before their removal from the head-path tables, with the turn links that name them,
 * which their removal clears. Nothing of a branch is lost.
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
		yield* sql.unsafe(
			`INSERT OR REPLACE INTO history_off_head (session_id, node_id, source_table, row_key, row_json)
			SELECT m.session_id, m.history_node_id, 'turn_links', m.id, json_object('turnId', t.id,
				'link', CASE WHEN t.user_message_id = m.id THEN 'user' ELSE 'assistant' END)
			FROM messages m JOIN turns t ON t.session_id = m.session_id
				AND (t.user_message_id = m.id OR t.assistant_message_id = m.id)
			WHERE m.session_id = ? AND m.id IN (SELECT value FROM json_each(?))`,
			[sessionId, list],
		);
	});

/** The nodes from `nodeId` up to the root, nearest first; empty for the root (null). */
export const pathToRoot = (sessionId: string, nodeId: string | null) =>
	Effect.gen(function* () {
		if (nodeId === null) return [];
		const sql = yield* SqlClient.SqlClient;
		const rows = yield* sql<{ id: string }>`
			WITH RECURSIVE path(id, depth) AS (
				SELECT id, 0 FROM history_nodes WHERE session_id = ${sessionId} AND id = ${nodeId}
				UNION ALL
				SELECT n.parent_id, p.depth + 1 FROM history_nodes n JOIN path p ON n.id = p.id
				WHERE n.session_id = ${sessionId} AND n.parent_id IS NOT NULL
			)
			SELECT id FROM path ORDER BY depth`;
		return rows.map(({ id }) => id);
	});

export const readHead = (sessionId: string) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [row] = yield* sql<{ node_id: string | null }>`
			SELECT node_id FROM history_heads WHERE session_id = ${sessionId}`;
		return row?.node_id ?? null;
	});

/**
 * 82tn.51: the Head moves to `to`. Returns the head-path rows of the nodes leaving the path, for
 * the caller to keep off the Head and remove, and the nodes joining it, whose kept rows
 * `restoreToHead` puts back. A row with no node (written before any Run ended) stays.
 */
export const headMoveDiff = (sessionId: string, to: string | null) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const from = new Set(
			yield* pathToRoot(sessionId, yield* readHead(sessionId)),
		);
		const target = new Set(yield* pathToRoot(sessionId, to));
		const leavingNodes = [...from].filter((id) => !target.has(id));
		const joining = [...target].filter((id) => !from.has(id));
		const leaving =
			leavingNodes.length === 0
				? []
				: (yield* sql<{ id: string }>`SELECT id FROM messages
					WHERE session_id = ${sessionId} AND history_node_id IN ${sql.in(leavingNodes)}
					ORDER BY ordinal, created_at, id`).map(({ id }) => id);
		return { leaving, joining };
	});

/** A kept row's columns back out of its JSON, over the table's columns now. */
const fromRowJson = (table: "messages" | "message_parts") =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const columns = (yield* sql.unsafe<{ name: string }>(
			`PRAGMA table_info(${table})`,
		)).map(({ name }) => name);
		return {
			names: columns.map((name) => `"${name}"`).join(", "),
			values: columns
				.map((name) =>
					name === "version" ? "?" : `json_extract(row_json, '$."${name}"')`,
				)
				.join(", "),
		};
	});

/**
 * Puts the kept rows of `nodeIds` back on the head path at `version`, so subscribers receive
 * them again, links their turns to them again, and clears their tombstones. Rows kept before
 * links were kept come back unlinked. Returns the restored message ids.
 */
export const restoreToHead = (
	sessionId: string,
	nodeIds: readonly string[],
	version: number,
) =>
	Effect.gen(function* () {
		if (nodeIds.length === 0) return [];
		const sql = yield* SqlClient.SqlClient;
		const nodes = JSON.stringify(nodeIds);
		const kept = (table: string) =>
			`FROM history_off_head WHERE session_id = ? AND source_table = '${table}' AND row_json IS NOT NULL
				AND node_id IN (SELECT value FROM json_each(?))`;
		const restored = (yield* sql.unsafe<{ id: string }>(
			`SELECT row_key AS id ${kept("messages")}`,
			[sessionId, nodes],
		)).map(({ id }) => id);
		const message = yield* fromRowJson("messages");
		const part = yield* fromRowJson("message_parts");
		yield* sql.unsafe(
			`INSERT OR IGNORE INTO messages (${message.names}) SELECT ${message.values} ${kept("messages")}`,
			[version, sessionId, nodes],
		);
		yield* sql.unsafe(
			`INSERT OR IGNORE INTO message_parts (${part.names}) SELECT ${part.values} ${kept("message_parts")}`,
			[version, sessionId, nodes],
		);
		const links = yield* sql.unsafe<{
			turn: string;
			message: string;
			link: "user" | "assistant";
		}>(
			`SELECT json_extract(row_json, '$.turnId') AS turn, row_key AS message,
				json_extract(row_json, '$.link') AS link ${kept("turn_links")}`,
			[sessionId, nodes],
		);
		for (const { turn, message, link } of links)
			yield* link === "user"
				? sql`UPDATE turns SET user_message_id = ${message} WHERE session_id = ${sessionId} AND id = ${turn}`
				: sql`UPDATE turns SET assistant_message_id = ${message} WHERE session_id = ${sessionId} AND id = ${turn}`;
		yield* sql.unsafe(
			`DELETE FROM history_off_head WHERE session_id = ? AND node_id IN (SELECT value FROM json_each(?))`,
			[sessionId, nodes],
		);
		if (restored.length > 0) {
			yield* sql`DELETE FROM message_tombstones WHERE session_id = ${sessionId}
				AND message_id IN ${sql.in(restored)}`;
			yield* sql`DELETE FROM message_part_tombstones WHERE session_id = ${sessionId}
				AND message_id IN ${sql.in(restored)}`;
		}
		return restored;
	});

export const setHead = (sessionId: string, nodeId: string | null) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`INSERT INTO history_heads (session_id, node_id)
			SELECT ${sessionId}, ${nodeId} WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ${sessionId})
			ON CONFLICT (session_id) DO UPDATE SET node_id = excluded.node_id`;
	});
