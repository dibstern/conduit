/**
 * A tool row's place on the Run Ledger (82tn.45): the Run it started under, the folder it ran in,
 * its parent tool, and its end when its Run ends. Main's message projector owns the row, its own
 * start and completion (CONTRACT.md 5972), and stamps it at insert from the ledger's active Run;
 * the ledger's arm, last in the write, ends a Run's open rows.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { TasksView } from "../../provider/run-ledger/run-ledger-model.js";
import type { StoredEvent } from "../events.js";
import type { ProjectionContext } from "./projectors-effect.js";

/**
 * Stamps a row just inserted with the ledger's active Run (a subagent's row with no Run of its
 * own takes its parent Task row's), the folder its Run was launched in (else the session's
 * latest launch, else the parent row's) and its parent Task row. The arm is last in each write,
 * so its active Run is the one before this event, on a live write and a replay alike. Gap: the
 * contract names no tool folder; CONTEXT.md 200, 411 read it as the Run's Effective Working
 * Directory.
 */
export const stampToolRow = (
	event: Extract<StoredEvent, { type: "tool.started" }>,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const [ledger] = yield* sql<{ active_run_id: string | null }>`
			SELECT active_run_id FROM run_ledger_sessions WHERE session_id = ${event.sessionId}`;
		const runId = ledger?.active_run_id ?? undefined;
		const [parent] = yield* sql<{
			id: string;
			run_id: string | null;
			folder: string | null;
		}>`SELECT p.id, p.run_id, p.folder FROM sessions s
			JOIN messages m ON m.session_id = s.parent_id
			JOIN message_parts p ON p.message_id = m.id
			WHERE s.id = ${event.sessionId} AND p.type = 'tool' AND json_valid(p.metadata)
				AND json_extract(p.metadata, '$.childSessionId') = ${event.sessionId}
			ORDER BY p.created_at DESC LIMIT 1`;
		const [launch] = yield* sql<{ folder: string | null }>`
			SELECT json_extract(payload_json, '$.workspaceRoot') AS folder
			FROM provider_command_outbox
			WHERE session_id = ${event.sessionId} AND effect_type = 'send_turn'
				AND json_valid(payload_json) AND requested_at <= ${event.createdAt}
			ORDER BY run_id IS ${runId ?? null} DESC, request_sequence DESC LIMIT 1`;
		yield* sql`UPDATE message_parts
			SET run_id = ${runId ?? parent?.run_id ?? null},
				folder = ${launch?.folder ?? parent?.folder ?? null},
				parent_tool_id = ${parent?.id ?? null}
			WHERE id = ${event.data.partId}`;
	});

/**
 * The ledger ended `runId`: its rows still open are ended by the run, not failed, unless they are
 * background work, or under it (their message ids are returned). A row is background while the ledger lists its task live, while
 * the ledger cannot tell (8.3, CONTRACT.md 2812-2817), or while Claude marks its agent
 * backgrounded; it then closes only on its own completion.
 */
export const endRunToolRows = (
	runId: string,
	tasks: TasksView,
	at: number,
	ctx: ProjectionContext,
) =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const live = JSON.stringify(
			tasks.tag === "live" ? tasks.tasks.map(({ key }) => key.taskId) : [],
		);
		const background = sql`COALESCE(json_valid(p.metadata) AND (
			COALESCE(json_extract(p.metadata, '$.backgrounded'), 0) = 1
			OR json_extract(p.metadata, '$.providerTaskId') IN (SELECT value FROM json_each(${live}))
			OR (${tasks.tag === "unknown" ? 1 : 0} = 1
				AND json_extract(p.metadata, '$.providerTaskId') IS NOT NULL)), 0)`;
		const ended = yield* sql<{ message_id: string }>`
			UPDATE message_parts SET status = 'completed', ended_at = ${at}, ended_by = 'run',
				updated_at = ${at}, version = ${ctx.version}
			WHERE id IN (
				WITH RECURSIVE tree(id, background) AS (
					SELECT p.id, ${background} FROM message_parts p
					WHERE p.run_id = ${runId} AND p.parent_tool_id IS NULL AND p.type = 'tool'
					UNION
					SELECT p.id, tree.background OR ${background} FROM tree
					JOIN message_parts p ON p.parent_tool_id = tree.id
				)
				SELECT tree.id FROM tree JOIN message_parts p ON p.id = tree.id
				WHERE NOT tree.background AND p.status IN ('started', 'running'))
			RETURNING message_id`;
		return [...new Set(ended.map(({ message_id }) => message_id))];
	});
