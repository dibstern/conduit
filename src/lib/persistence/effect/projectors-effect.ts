// Each projector's `project` method is an Effect program over @effect/sql SqlClient.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect } from "effect";
import { persistedTurnState } from "../../contracts/turn-phase.js";
import { isRecord } from "../../utils.js";
import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";
import {
	getSessionStatements,
	isSessionRemoval,
	REMOVE_SESSION_SQL,
	SESSION_HANDLED_TYPES,
	SESSION_SUBTREE_SQL,
} from "../projectors/session-handlers.js";
import { refreshSidebar, rerootSession } from "./sidebar-projection.js";

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
	readonly projector: string;
	readonly operation: string;
	readonly cause: unknown;
}> {}

export interface ProjectionContext {
	/**
	 * The read-model version every row this projection touches is stamped with.
	 * It comes from the monotone read-model counter, never from the event: an
	 * event sequence goes backwards on replay, and a row that moves backwards is
	 * a row a subscriber never hears about again.
	 */
	readonly version: number;
	readonly replaying?: boolean;
}

/**
 * What one projection did, in the only two terms a subscriber can act on:
 * sessions to re-query, and sessions to drop.
 *
 * The split is decided by the database, not declared by the projector. Every
 * statement names the rows it wrote through `RETURNING`; the stamp pass then
 * separates them — a row still there takes the version and is `stamped`, and a
 * row the statement wrote but that is no longer there was removed underneath
 * it, by its own removal or by the cascade that followed one. So a projector
 * can neither stamp a row it did not write, nor stay quiet about one it
 * removed.
 */
export interface ProjectionTouch {
	readonly stamped: readonly string[];
	readonly removed: readonly string[];
}

/**
 * Collapse touches into the outcome each session actually ended the commit
 * with, later touches winning over earlier ones.
 *
 * Order is the whole point: a commit that deletes a session and recreates it
 * leaves a live row, and one that creates then deletes leaves nothing. Taking
 * the union and letting removal win would announce the surviving row as gone,
 * and a subscriber would drop a session that is still there. Folding in order
 * is also what keeps the two lists disjoint, so nobody downstream has to
 * reconcile them.
 */
export const mergeTouches = (
	touches: Iterable<ProjectionTouch>,
): ProjectionTouch => {
	const live = new Map<string, boolean>();
	for (const touch of touches) {
		for (const sessionId of touch.stamped) live.set(sessionId, true);
		for (const sessionId of touch.removed) live.set(sessionId, false);
	}
	return {
		stamped: [...live].filter(([, alive]) => alive).map(([id]) => id),
		removed: [...live].filter(([, alive]) => !alive).map(([id]) => id),
	};
};

export interface EffectProjector {
	readonly name: string;
	readonly handles: readonly CanonicalEventType[];
	/**
	 * Apply the event, then report what moved and what is gone. The projection
	 * runner needs nothing from the caller to know either.
	 */
	readonly project: (
		event: StoredEvent,
		ctx: ProjectionContext,
	) => Effect.Effect<
		ProjectionTouch,
		ProjectionError | SqlError,
		SqlClient.SqlClient
	>;
}

function isEventType<K extends CanonicalEventType>(
	event: StoredEvent,
	type: K,
): event is StoredEvent & { type: K; data: EventPayloadMap[K] } {
	return event.type === type;
}

// A child-table row naming the session row it belongs to. `turns`, `activities`,
// `pending_approvals` and `session_providers` move the session row that owns
// them (pending_approvals also has a version, for its own subscription), and
// the owner is whatever the write itself put in `session_id`, not what the
// event header says.
interface OwnedRow {
	readonly session_id: string;
}

const owners = (rows: readonly OwnedRow[]): readonly string[] =>
	rows.map((row) => row.session_id);

// A row a statement reports having written, via `RETURNING id`. An empty result
// is the whole point: a declined guard, an ignored conflict and an update that
// matched nothing all come back with no rows, and so announce nothing.
const ids = (rows: readonly { readonly id: string }[]): readonly string[] =>
	rows.map((row) => row.id);

// Stamping is unconditional. `version` is the read-model counter, not the event
// sequence, so a replayed write is still a write: it takes the next counter
// value and the row moves forward whatever it carried before. Under the old
// sequence stamp a replay could rewrite a row's payload and leave its version
// behind, and a subscriber holding that version never heard about the change.
//
// `RETURNING` reports only rows that were really there, so an UPDATE against a
// missing or already-deleted row announces nothing.
const stampSessions = (
	sessionIds: readonly string[],
	version: number,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		const removed: string[] = [];
		for (const sessionId of new Set(sessionIds)) {
			const rows = yield* sql<{ id: string }>`
				UPDATE sessions SET version = ${version}
				WHERE id = ${sessionId}
				RETURNING id`;
			// The row was written a moment ago and is not here now: it went under
			// this same event, by a removal statement or by the cascade one set off.
			// Nothing declares that — the UPDATE that matched nothing is the report.
			if (rows.length === 0) removed.push(sessionId);
			else stamped.push(...rows.map((row) => row.id));
		}
		return { stamped, removed };
	});

// Takes the messages the handler reported writing, not the id in the event
// header: a guard that declined and a conflict that was ignored both report
// nothing, and a row nobody wrote must not be announced as changed.
//
// Returns the owning session rather than the event's own, because a subagent
// message is stored against the subagent session and that is the row a
// subscriber must re-query. Message parts carry no version of their own, so a
// part write advances the message that owns it.
const stampMessage = (
	messageIds: readonly string[],
	version: number,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		for (const messageId of new Set(messageIds)) {
			const rows = yield* sql<OwnedRow>`
				UPDATE messages SET version = ${version}
				WHERE id = ${messageId}
				RETURNING session_id`;
			stamped.push(...owners(rows));
		}
		// A message row that vanished under its own event went with the session
		// that owned it, and the session projector reports that removal by name.
		// Nothing to add here: the missing id is a message id, and the advance
		// speaks in sessions.
		return { stamped, removed: [] };
	});

function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

/** Shallow-merge new tool metadata into the stored JSON object. Corrupt stored metadata is logged and kept as-is. */
function mergeMetadata(
	current: string | null,
	next: Record<string, unknown> | undefined,
	sessionId: string,
	partId: string,
): Effect.Effect<string | null> {
	if (next === undefined) return Effect.succeed(current);
	if (current == null) return Effect.succeed(encodeJson(next));
	const keepCorrupt = (reason: string) =>
		Effect.logError(
			`Unable to merge corrupt message part metadata for session ${sessionId}, part ${partId}; preserving stored metadata: ${reason}`,
		).pipe(Effect.as(current));
	try {
		const parsed: unknown = JSON.parse(current);
		return isRecord(parsed)
			? Effect.succeed(encodeJson({ ...parsed, ...next }))
			: keepCorrupt("Stored metadata must be a JSON object");
	} catch (error) {
		return keepCorrupt(error instanceof Error ? error.message : String(error));
	}
}

export const makeSessionProjector = (): EffectProjector => ({
	name: "session",
	handles: SESSION_HANDLED_TYPES,
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const written: string[] = [];
			// Families this event can take members from, which naming the
			// sessions it wrote does not reach.
			const formerRoots: string[] = [];

			if (event.type === "session.goal_changed" && event.data.goal) {
				const goal = event.data.goal;
				// Read the preceding fact before replacing it. Pauses and status
				// resyncs with unchanged iterations do not create another check.
				yield* sql`INSERT OR IGNORE INTO session_goal_checks
					(event_id, session_id, condition, set_at, iterations, reason, created_at)
					SELECT ${event.eventId}, id, ${goal.condition}, ${goal.setAt},
						${goal.iterations}, ${goal.lastReason ?? null}, ${event.createdAt}
					FROM sessions WHERE id = ${event.data.sessionId}
					AND ${goal.iterations} > CASE
						WHEN json_extract(goal_state, '$.goal.setAt') = ${goal.setAt}
							AND json_extract(goal_state, '$.goal.condition') = ${goal.condition}
						THEN COALESCE(json_extract(goal_state, '$.goal.iterations'), 0)
						ELSE 0 END`;
			}

			// Every session statement is a single-table write against `sessions`
			// keyed by id, so `RETURNING id` names exactly the rows it wrote: the
			// subagent row for a message filed under its parent, and nothing at
			// all when the auto-title guard declines the rename.
			//
			// A removal is named instead of written, because `RETURNING` cannot
			// report what the cascade takes: the subtree is read first, then the
			// session row goes and the cascade takes the rest. Both arms feed the
			// same list — the stamp pass is what tells a row that moved from one
			// that is gone.
			for (const stmt of getSessionStatements(event)) {
				if (isSessionRemoval(stmt)) {
					const subtree = yield* sql.unsafe<{ id: string }>(
						SESSION_SUBTREE_SQL,
						[stmt.removeSession],
					);
					const roots = yield* sql<{ root_id: string | null }>`
						SELECT root_id FROM sessions WHERE id = ${stmt.removeSession}`;
					formerRoots.push(...roots.flatMap((row) => row.root_id ?? []));
					yield* sql.unsafe(REMOVE_SESSION_SQL, [stmt.removeSession]);
					written.push(...subtree.map((row) => row.id));
					continue;
				}
				const rows = yield* sql.unsafe<{ id: string }>(
					`${stmt.sql} RETURNING id`,
					[...stmt.params],
				);
				written.push(...rows.map((row) => row.id));
			}
			// Only these two write a parent.
			if (event.type === "session.created" || event.type === "session.forked")
				formerRoots.push(...(yield* rerootSession(event.data.sessionId)));
			const touch = yield* stampSessions(written, ctx.version);
			yield* refreshSidebar(touch.stamped, ctx.version, formerRoots);
			return touch;
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "session",
							operation: "project",
							cause: e,
						}),
			),
		),
});

export const makeMessageProjector = (): EffectProjector => ({
	name: "message",
	handles: [
		"message.created",
		"message.removed",
		"message.part.removed",
		"message.snapshot",
		"text.delta",
		"thinking.start",
		"thinking.delta",
		"thinking.end",
		"tool.started",
		"tool.running",
		"tool.completed",
		"file.attached",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"session.compaction",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			// A turn that ends without thinking.end must not leave thinking open.
			const closeThinking = (messageId: string) =>
				Effect.map(
					sql<{
						message_id: string;
					}>`UPDATE message_parts SET status = 'completed'
						WHERE message_id = ${messageId} AND type = 'thinking' AND status = 'running'
						RETURNING message_id`,
					(rows) => [...new Set(rows.map((row) => row.message_id))],
				);
			if (isEventType(event, "message.removed")) {
				const { messageId } = event.data;
				yield* sql`UPDATE turns SET user_message_id = NULL
					WHERE session_id = ${event.sessionId} AND user_message_id = ${messageId}`;
				yield* sql`UPDATE turns SET assistant_message_id = NULL
					WHERE session_id = ${event.sessionId} AND assistant_message_id = ${messageId}`;
				yield* sql`DELETE FROM messages
					WHERE id = ${messageId} AND session_id = ${event.sessionId}`;
				yield* sql`INSERT INTO message_tombstones (session_id, message_id, version)
					VALUES (${event.sessionId}, ${messageId}, ${ctx.version})
					ON CONFLICT (message_id) DO UPDATE SET
					session_id = excluded.session_id, version = excluded.version`;
				return [];
			}
			if (
				"messageId" in event.data &&
				event.type !== "message.part.removed" &&
				event.metadata.rawSource !== "opencode.rest"
			) {
				const rows = yield* sql<{
					rest_digest: string | null;
					session_id: string;
				}>`
						SELECT rest_digest, session_id FROM messages WHERE id = ${event.data.messageId}`;
				if (rows[0]?.rest_digest != null) {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${rows[0].session_id}`;
					return [];
				}
			}

			if (isEventType(event, "message.snapshot")) {
				const { message, digest } = event.data;
				const created = message.time?.created ?? event.createdAt;
				const completed = message.time?.completed ?? created;
				const text = message.parts
					.filter(
						(part) => part.type === "text" && typeof part["text"] === "string",
					)
					.map((part) => part["text"])
					.join("");
				const existing = yield* sql<{ is_backfilled: number }>`
					SELECT is_backfilled FROM messages WHERE id = ${message.id}`;
				const written = yield* sql<{ id: string }>`
					INSERT INTO messages
					(id, session_id, role, text, cost, tokens_in, tokens_out,
					 tokens_cache_read, tokens_cache_write, context_window,
					 is_streaming, is_backfilled, created_at, updated_at,
					 rest_digest, rest_event_id, rest_payload, finish, error)
					VALUES (${message.id}, ${event.sessionId}, ${message.role}, ${text},
					 ${message.cost ?? null}, ${message.tokens?.input ?? null},
					 ${message.tokens?.output ?? null}, ${message.tokens?.cache?.read ?? null},
					 ${message.tokens?.cache?.write ?? null}, ${message.tokens?.contextWindow ?? null},
					 0, ${existing.length === 0 ? 1 : (existing[0]?.is_backfilled ?? 0)},
					 ${created}, ${completed}, ${digest}, ${event.eventId}, ${encodeJson(message)},
					 ${message.finish ?? null},
					 ${message.error === undefined ? null : encodeJson(message.error)})
					ON CONFLICT (id) DO UPDATE SET
					 role = excluded.role, text = excluded.text, cost = excluded.cost,
					 tokens_in = excluded.tokens_in, tokens_out = excluded.tokens_out,
					 tokens_cache_read = excluded.tokens_cache_read,
					 tokens_cache_write = excluded.tokens_cache_write,
					 context_window = excluded.context_window, is_streaming = 0,
					 created_at = excluded.created_at, updated_at = excluded.updated_at,
					 rest_digest = excluded.rest_digest, rest_event_id = excluded.rest_event_id,
					 rest_payload = excluded.rest_payload,
					 finish = excluded.finish, error = excluded.error
				RETURNING id`;
				yield* sql`DELETE FROM message_parts WHERE message_id = ${message.id}`;
				for (const [index, part] of message.parts.entries()) {
					const partTime = part["time"];
					const time =
						typeof partTime === "object" &&
						partTime !== null &&
						!Array.isArray(partTime)
							? partTime
							: undefined;
					const start =
						time && "start" in time && typeof time.start === "number"
							? time.start
							: created;
					const end =
						time && "end" in time && typeof time.end === "number"
							? time.end
							: start;
					const state = part["state"];
					const toolState =
						typeof state === "object" && state !== null && !Array.isArray(state)
							? state
							: undefined;
					yield* sql`
						INSERT INTO message_parts
						(id, message_id, type, text, tool_name, call_id, input, result,
						 status, sort_order, created_at, updated_at, metadata, rest_payload)
						VALUES (${part.id}, ${message.id}, ${part.type},
						 ${typeof part["text"] === "string" ? part["text"] : ""},
						 ${typeof part["tool"] === "string" ? part["tool"] : null},
						 ${typeof part["callID"] === "string" ? part["callID"] : null},
						 ${toolState && "input" in toolState ? encodeJson(toolState.input) : null},
						 ${toolState && "output" in toolState ? encodeJson(toolState.output) : null},
						 ${toolState && "status" in toolState && typeof toolState.status === "string" ? toolState.status : null},
						 ${index}, ${start}, ${end},
						 ${toolState && "metadata" in toolState ? encodeJson(toolState.metadata) : null},
						 ${encodeJson(part)})`;
				}
				return written.map((row) => row.id);
			}

			if (isEventType(event, "message.part.removed")) {
				const removed = yield* sql<{ id: string }>`DELETE FROM message_parts
					WHERE id = ${event.data.partId} AND message_id = ${event.data.messageId}
					RETURNING id`;
				if (removed.length === 0) return [];
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET text = COALESCE((SELECT group_concat(text, '') FROM (
						SELECT text FROM message_parts WHERE message_id = ${event.data.messageId}
						AND type = 'text' ORDER BY sort_order
					)), ''), rest_payload = NULL, rest_digest = NULL,
					updated_at = ${event.createdAt}
					WHERE id = ${event.data.messageId} AND session_id = ${event.sessionId}
					RETURNING id`,
				);
			}

			if (isEventType(event, "message.created")) {
				if (event.metadata.rawSource !== "opencode.rest") {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${event.sessionId}`;
				}
				// A backfilled message is settled history: it never streams here.
				const isBackfilled = event.data.backfilled ? 1 : 0;
				const isStreaming =
					event.data.role === "assistant" && !isBackfilled ? 1 : 0;
				return ids(
					yield* sql<{ id: string }>`
						INSERT INTO messages
						(id, session_id, role, text, is_streaming, is_backfilled, created_at, updated_at, parent_id)
						VALUES (${event.data.messageId}, ${event.data.sessionId}, ${event.data.role}, '', ${isStreaming}, ${isBackfilled}, ${event.createdAt}, ${event.createdAt}, ${event.data.parentID ?? null})
						ON CONFLICT (id) DO UPDATE SET
							role = excluded.role,
							is_streaming = CASE WHEN excluded.role = 'user' THEN 0 ELSE messages.is_streaming END
						WHERE messages.role <> excluded.role
						RETURNING id`,
				);
			}

			if (isEventType(event, "text.delta")) {
				if (ctx?.replaying) {
					const msgRows = yield* sql<{
						last_applied_seq: number | null;
					}>`SELECT last_applied_seq FROM messages WHERE id = ${event.data.messageId}`;
					const row = msgRows[0];
					if (
						row?.last_applied_seq != null &&
						event.sequence <= row.last_applied_seq
					)
						return [];
				}

				// Defensive: ensure the messages row exists
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'text', ${event.data.text},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						updated_at = excluded.updated_at`;

				return ids(
					yield* sql<{ id: string }>`
						UPDATE messages SET text = text || ${event.data.text}, last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}
						RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.start")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, status, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', '', 'running',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.delta")) {
				if (ctx?.replaying) {
					const msgRows = yield* sql<{
						last_applied_seq: number | null;
					}>`SELECT last_applied_seq FROM messages WHERE id = ${event.data.messageId}`;
					const row = msgRows[0];
					if (
						row?.last_applied_seq != null &&
						event.sequence <= row.last_applied_seq
					)
						return [];
				}

				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				yield* sql`
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', ${event.data.text},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						updated_at = excluded.updated_at`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.end")) {
				// The part's own span ends here, not at its last delta.
				yield* sql`UPDATE message_parts
					SET status = 'completed', updated_at = ${event.createdAt}
					WHERE id = ${event.data.partId} AND type = 'thinking'`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "tool.started")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				const inputJson = encodeJson(event.data.input);
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'tool', ${event.data.toolName}, ${event.data.callId}, ${inputJson}, 'started',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "tool.running")) {
				const rows = yield* sql<{ metadata: string | null }>`
					SELECT metadata FROM message_parts WHERE id = ${event.data.partId}`;
				const metadata = yield* mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
					event.sessionId,
					event.data.partId,
				);
				yield* sql`
					UPDATE message_parts
					SET status = CASE
							WHEN status IN ('completed', 'error') THEN status
							ELSE 'running'
						END,
						input = COALESCE(${event.data.input === undefined ? null : encodeJson(event.data.input)}, input),
						metadata = ${metadata},
						updated_at = ${event.createdAt}
					WHERE id = ${event.data.partId}`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "tool.completed")) {
				const resultJson = encodeJson(event.data.result);
				const rows = yield* sql<{ metadata: string | null }>`
					SELECT metadata FROM message_parts WHERE id = ${event.data.partId}`;
				const metadata = yield* mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
					event.sessionId,
					event.data.partId,
				);
				yield* sql`
					UPDATE message_parts
					SET result = ${resultJson}, duration = ${event.data.duration}, status = 'completed', metadata = ${metadata}, updated_at = ${event.createdAt},
						input = COALESCE(${event.data.input === undefined ? null : encodeJson(event.data.input)}, input)
					WHERE id = ${event.data.partId}`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "file.attached")) {
				yield* sql`
					INSERT OR IGNORE INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.sessionId}, 'assistant', '', 1, ${event.createdAt}, ${event.createdAt})`;

				const metadata = encodeJson({
					mime: event.data.mime,
					...(event.data.filename != null
						? { filename: event.data.filename }
						: {}),
					url: event.data.url,
				});
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, metadata, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'file', ${metadata},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "turn.completed")) {
				// Cost and tokens are counted differently by the provider, which
				// reads like a bug and is not: cost is cumulative for the whole
				// SDK session (two completions in one turn read 38.53 then 39.84),
				// so the latest value wins. Tokens are per-execution, so a turn
				// that ran twice sums them.
				const tokens = event.data.tokens;
				yield* closeThinking(event.data.messageId);
				return ids(
					yield* sql<{ id: string }>`
					UPDATE messages SET
					cost = ${event.data.cost ?? null},
					tokens_in = ${tokens?.input ?? null},
					tokens_out = ${tokens?.output ?? null},
					tokens_cache_read = ${tokens?.cacheRead ?? null},
					tokens_cache_write = ${tokens?.cacheWrite ?? null},
					context_window = ${tokens?.contextWindow ?? null},
					is_streaming = 0,
					updated_at = ${event.createdAt}
					WHERE id = ${event.data.messageId}
					RETURNING id`,
				);
			}

			if (isEventType(event, "turn.error")) {
				yield* closeThinking(event.data.messageId);
				// The error is the turn's last word, so it replays like any
				// content: a synthetic message after the turn's own, keyed on the
				// event sequence. A part on the turn's message would be lost when
				// a REST snapshot rewrites that message's parts.
				const errorMessageId = `turn-error-${event.sequence}`;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${errorMessageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at)
					VALUES (${`turn-error-part-${event.sequence}`}, ${errorMessageId}, 'error', ${event.data.error},
						${event.data.code === undefined ? null : encodeJson({ code: event.data.code })},
						0, ${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				return [
					errorMessageId,
					...ids(
						yield* sql<{
							id: string;
						}>`UPDATE messages SET is_streaming = 0, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
					),
				];
			}

			if (isEventType(event, "turn.interrupted")) {
				const closed = yield* closeThinking(event.data.messageId);
				const interrupted = yield* sql<{ id: string }>`UPDATE messages
					SET finish = 'interrupted' WHERE id = ${event.data.messageId}
						OR id IN (SELECT user_message_id FROM turns
							WHERE session_id = ${event.sessionId} AND state IN ('pending', 'running'))
					RETURNING id`;
				return [...new Set([...closed, ...ids(interrupted)])];
			}

			if (isEventType(event, "session.compaction")) {
				// Only the outcomes reach persistence — ingestion drops the transient
				// "started" before the append — but the guard stays because a replay
				// or backfill can hand us one. A failed outcome is kept as status.
				// The `compaction` part keeps the divider and the reduced context gauge
				// across a reload. An auto-compaction lands mid-message, so it joins
				// the in-flight assistant message as its next part: a standalone
				// message would sort by its own time, after that message's result,
				// and split the turn on reload. Between turns it gets a synthetic
				// message. Ids keyed on the event sequence plus DO NOTHING make
				// replay a no-op.
				if (event.data.state === "started") return [];
				const status = event.data.state === "failed" ? "failed" : null;
				const partId = `compaction-part-${event.sequence}`;
				const [latest] = yield* sql<{
					id: string;
					role: string;
					is_streaming: number;
				}>`SELECT id, role, is_streaming FROM messages
					WHERE session_id = ${event.data.sessionId}
					ORDER BY created_at DESC, id DESC LIMIT 1`;
				const metadata = encodeJson({
					...(typeof event.data.preTokens === "number"
						? { preTokens: event.data.preTokens }
						: {}),
					...(typeof event.data.postTokens === "number"
						? { postTokens: event.data.postTokens }
						: {}),
				});
				if (latest?.role === "assistant" && latest.is_streaming === 1) {
					yield* sql`
						INSERT INTO message_parts
						(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at)
						VALUES (${partId}, ${latest.id}, 'compaction', ${event.data.detail}, ${metadata}, ${status},
							COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${latest.id}), 0),
							${event.createdAt}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING`;
					return [latest.id];
				}
				const messageId = `compaction-${event.sequence}`;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.data.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at)
					VALUES (${partId}, ${messageId}, 'compaction', ${event.data.detail}, ${metadata}, ${status}, 0, ${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				return [messageId];
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "message",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				isEventType(event, "message.removed")
					? stampSessions([event.sessionId], ctx.version)
					: Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							for (const messageId of new Set(written)) {
								yield* sql`DELETE FROM message_tombstones WHERE message_id = ${messageId}`;
							}
							return yield* stampMessage(written, ctx.version);
						}),
			),
		),
});

export const makeTurnProjector = (): EffectProjector => ({
	name: "turn",
	handles: [
		"message.created",
		"message.snapshot",
		"tool.started",
		"session.status",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"turn.model_resolved",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			if (
				event.metadata.rawSource !== "opencode.rest" &&
				"messageId" in event.data
			) {
				const rows = yield* sql<{
					rest_digest: string | null;
					session_id: string;
				}>`
						SELECT rest_digest, session_id FROM messages WHERE id = ${event.data.messageId}`;
				if (rows[0]?.rest_digest != null) {
					yield* sql`UPDATE sessions SET history_complete = 0 WHERE id = ${rows[0].session_id}`;
					return { sessions: [], messages: [] };
				}
			}

			if (isEventType(event, "message.snapshot")) {
				const { message } = event.data;
				const parentId = message.parentID;
				// The message projector leaves the previous ownership in this row
				// until it can be captured here, before applying the new parent.
				const [previous] = yield* sql<{
					turn_id: string | null;
					parent_id: string | null;
				}>`SELECT turn_id, parent_id FROM messages WHERE id = ${message.id}`;
				const affected = new Set(
					[previous?.turn_id, previous?.parent_id].filter(
						(owner): owner is string => owner != null,
					),
				);
				const messageIds: string[] = [];
				const displayOwners = yield* sql<{ id: string }>`
					SELECT id FROM turns WHERE assistant_message_id = ${message.id}
					AND session_id = ${event.sessionId}`;
				for (const owner of displayOwners) affected.add(owner.id);
				if (message.role === "user") {
					yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
					VALUES (${message.id}, ${event.sessionId}, 'pending', ${message.id}, ${message.time?.created ?? event.createdAt})
					ON CONFLICT (id) DO UPDATE SET requested_at = excluded.requested_at`;
					const children = yield* sql<{ turn_id: string | null }>`
						SELECT DISTINCT turn_id FROM messages WHERE session_id = ${event.sessionId}
						AND parent_id = ${message.id}
						AND role = 'assistant'`;
					for (const child of children) {
						if (child.turn_id) affected.add(child.turn_id);
					}
					yield* sql`UPDATE messages SET turn_id = ${message.id}
						WHERE session_id = ${event.sessionId} AND parent_id = ${message.id}
						AND role = 'assistant'`;
				} else if (parentId) {
					yield* sql`INSERT INTO turns (id, session_id, state, user_message_id, requested_at)
					SELECT id, session_id, 'pending', id, created_at FROM messages
					WHERE id = ${parentId} AND session_id = ${event.sessionId} AND role = 'user'
					ON CONFLICT (id) DO NOTHING`;
				}
				const turn = parentId
					? yield* sql<{
							id: string;
						}>`SELECT id FROM turns WHERE id = ${parentId} AND session_id = ${event.sessionId}`
					: [];
				if (message.role === "assistant") {
					yield* sql`UPDATE messages SET parent_id = ${parentId ?? null},
						turn_id = ${turn.length ? parentId : null} WHERE id = ${message.id}`;
				}
				if (message.role === "user") affected.add(message.id);
				if (turn.length && parentId) affected.add(parentId);
				for (const turnId of affected) {
					const [totals] = yield* sql<{
						cost: number | null;
						tokens_in: number | null;
						tokens_out: number | null;
						started_at: number | null;
						completed_at: number | null;
					}>`SELECT SUM(cost) AS cost, SUM(tokens_in) AS tokens_in,
						SUM(tokens_out) AS tokens_out, MIN(created_at) AS started_at,
						MAX(updated_at) AS completed_at FROM messages
						WHERE session_id = ${event.sessionId} AND turn_id = ${turnId}
						AND role = 'assistant'`;
					const [latest] = yield* sql<{ id: string; is_streaming: number }>`
						SELECT id, is_streaming FROM messages
						WHERE session_id = ${event.sessionId} AND turn_id = ${turnId}
						AND role = 'assistant'
						ORDER BY created_at DESC, id DESC LIMIT 1`;
					if (latest) {
						const rows = yield* sql<{
							id: string;
						}>`UPDATE turns SET assistant_message_id = ${latest.id},
							state = ${latest.is_streaming ? "running" : "completed"},
							started_at = ${totals?.started_at ?? null},
							completed_at = ${latest.is_streaming ? null : (totals?.completed_at ?? null)},
							cost = ${totals?.cost ?? null}, tokens_in = ${totals?.tokens_in ?? null},
							tokens_out = ${totals?.tokens_out ?? null} WHERE id = ${turnId}
							RETURNING id`;
						messageIds.push(...ids(rows));
					} else {
						const rows = yield* sql<{
							id: string;
						}>`UPDATE turns SET assistant_message_id = NULL, state = 'pending',
							started_at = NULL, completed_at = NULL, cost = NULL,
							tokens_in = NULL, tokens_out = NULL WHERE id = ${turnId}
							AND assistant_message_id IS NOT NULL RETURNING id`;
						messageIds.push(...ids(rows));
					}
				}
				return {
					sessions: affected.size > 0 ? [event.sessionId] : [],
					messages: messageIds,
				};
			}

			if (isEventType(event, "message.created")) {
				if (event.data.role === "user") {
					return {
						sessions: owners(
							yield* sql<OwnedRow>`
								INSERT OR REPLACE INTO turns
								(id, session_id, state, user_message_id, requested_at)
								VALUES (${event.data.messageId}, ${event.data.sessionId}, ${persistedTurnState("prompt")}, ${event.data.messageId}, ${event.createdAt})
								RETURNING session_id`,
						),
						messages: [],
					};
				}
			}

			// A result may arrive before the provider continues the same turn.
			if (
				(isEventType(event, "session.status") &&
					event.data.status === "busy") ||
				(isEventType(event, "message.created") &&
					event.data.role === "assistant") ||
				isEventType(event, "tool.started")
			) {
				const parentTurn =
					isEventType(event, "message.created") && event.data.parentID
						? yield* sql<{
								id: string;
								state: string;
								assistant_message_id: string | null;
							}>`SELECT id, state, assistant_message_id FROM turns
							WHERE id = ${event.data.parentID} AND session_id = ${event.sessionId}`
						: isEventType(event, "tool.started")
							? yield* sql<{
									id: string;
									state: string;
									assistant_message_id: string | null;
								}>`SELECT turns.id, turns.state, turns.assistant_message_id
								FROM turns JOIN messages ON messages.turn_id = turns.id
								WHERE messages.id = ${event.data.messageId}
								AND turns.session_id = ${event.sessionId}`
							: [];
				// Without a key, a signal belongs to the newest turn, except that
				// a prompt queued behind a running turn must not take over that
				// turn's busy and tool signals. A new reply is what starts the
				// queued turn. A turn still running from before a later one
				// settled is a crash leftover, so it never wins.
				const [turn] = parentTurn.length
					? parentTurn
					: yield* sql<{
							id: string;
							state: string;
							assistant_message_id: string | null;
						}>`
					SELECT id, state, assistant_message_id FROM turns
					WHERE session_id = ${event.sessionId}
					AND requested_at <= ${event.createdAt}
					ORDER BY (${isEventType(event, "message.created") ? 0 : 1}
						AND state = 'running'
						AND requested_at >= (SELECT COALESCE(MAX(requested_at), 0) FROM turns
							WHERE session_id = ${event.sessionId}
							AND state NOT IN ('pending', 'running'))) DESC,
						requested_at DESC, rowid DESC LIMIT 1`;
				if (!turn) return { sessions: [], messages: [] };
				// Turns run one at a time, so a reply starting ends every earlier
				// turn. Claude never closes a turn whose queued successor took
				// over its streaming SDK turn.
				const superseded = isEventType(event, "message.created")
					? yield* sql<OwnedRow & { id: string }>`
						UPDATE turns SET state = 'completed', completed_at = ${event.createdAt}
						WHERE session_id = ${event.sessionId} AND state = 'running'
						AND requested_at < (SELECT requested_at FROM turns WHERE id = ${turn.id})
						RETURNING id, session_id`
					: [];
				if (isEventType(event, "message.created")) {
					yield* sql`UPDATE messages SET turn_id = ${turn.id},
						parent_id = COALESCE(parent_id, ${turn.id})
						WHERE id = ${event.data.messageId}`;
				}
				const reopening = turn.state !== "pending" && turn.state !== "running";
				const assistantMessageId = reopening ? null : turn.assistant_message_id;
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns
						SET state = ${persistedTurnState(event.type === "session.status" ? "busy" : "activity")},
							started_at = COALESCE(started_at, ${event.createdAt}),
							completed_at = NULL,
							assistant_message_id = ${isEventType(event, "message.created") ? (assistantMessageId ?? event.data.messageId) : assistantMessageId}
						WHERE id = ${turn.id}
						RETURNING id, session_id`;
				return {
					sessions: owners([...written, ...superseded]),
					messages: ids([...written, ...superseded]),
				};
			}

			// These three find their turn by assistant message id, so the owning
			// session is nowhere in the statement — `RETURNING session_id` is the
			// only thing that knows which session row actually moved.
			if (isEventType(event, "turn.completed")) {
				// Cost and tokens are counted differently by the provider, which
				// reads like a bug and is not: cost is cumulative for the whole
				// SDK session (two completions in one turn read 38.53 then 39.84),
				// so the latest value wins. Tokens are per-execution, so a turn
				// that ran twice sums them.
				const tokens = event.data.tokens;
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns
						SET state = 'completed',
							cost = COALESCE(${event.data.cost ?? null}, cost),
							tokens_in = COALESCE(tokens_in + ${tokens?.input ?? null}, tokens_in, ${tokens?.input ?? null}),
							tokens_out = COALESCE(tokens_out + ${tokens?.output ?? null}, tokens_out, ${tokens?.output ?? null}),
							completed_at = ${event.createdAt}
						WHERE assistant_message_id = ${event.data.messageId}
						RETURNING id, session_id`;
				return { sessions: owners(written), messages: ids(written) };
			}

			if (isEventType(event, "turn.error")) {
				// Runner startup and queued sends can fail before an assistant
				// message identifies the owning turn. Prefer the persisted user ID.
				if (event.data.userMessageId) {
					const written = yield* sql<OwnedRow & { id: string }>`UPDATE turns
							SET state = 'error', completed_at = ${event.createdAt}
							WHERE id = ${event.data.userMessageId}
							AND session_id = ${event.sessionId}
							RETURNING id, session_id`;
					return { sessions: owners(written), messages: ids(written) };
				}
				// An error before the reply is named carries no id a turn owns, so
				// it ends the running turn. Queued prompts stay pending: after an
				// error result the SDK goes on to send them.
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns
						SET state = 'error', completed_at = ${event.createdAt}
						WHERE session_id = ${event.sessionId}
						AND (assistant_message_id = ${event.data.messageId}
							OR state = 'running')
						RETURNING id, session_id`;
				return { sessions: owners(written), messages: ids(written) };
			}

			if (isEventType(event, "turn.interrupted")) {
				// Stop ends the session's work, so whatever is still running stops
				// with the named turn. That also covers an empty id (stopped before
				// naming its reply) and an id no turn owns. Prompts queued behind it
				// stop too: Stop closes the Claude query, which drops them unsent.
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns
						SET state = 'interrupted', completed_at = ${event.createdAt}
						WHERE session_id = ${event.sessionId}
						AND (assistant_message_id = ${event.data.messageId}
							OR state IN ('running', 'pending'))
						RETURNING id, session_id`;
				return { sessions: owners(written), messages: ids(written) };
			}

			// Attributed to the newest open turn rather than by id, because the
			// event carries no key that reaches a turns row: turns.id is the user
			// message id, while the provider's turnId is a per-send uuid. This is
			// exact only while a session has at most one turn in flight. The
			// Claude translator is the sole emitter and its runtime serializes
			// turn admission, so a turn's model_resolved always lands before the
			// next turn's row exists. A second emitter, or concurrent turns,
			// needs a real key first (tracked in conduit-test-7i3).
			if (isEventType(event, "turn.model_resolved")) {
				return {
					sessions: owners(
						yield* sql<OwnedRow>`
							UPDATE turns
							SET requested_model = ${event.data.requestedModel ?? null},
								expected_model = ${event.data.expectedModel ?? null},
								actual_model = ${event.data.actualModel}
							WHERE id = (
								SELECT id FROM turns
								WHERE session_id = ${event.sessionId}
									AND state IN ('pending', 'running')
								ORDER BY requested_at DESC
								LIMIT 1
							)
							RETURNING session_id`,
					),
					messages: [],
				};
			}
			return { sessions: [], messages: [] };
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "turn",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				Effect.gen(function* () {
					return mergeTouches([
						yield* stampMessage(written.messages, ctx.version),
						yield* stampSessions(written.sessions, ctx.version),
					]);
				}),
			),
		),
});

export const makeActivityProjector = (): EffectProjector => ({
	name: "activity",
	handles: [
		"tool.started",
		"tool.running",
		"tool.completed",
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
		"turn.error",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// OR IGNORE returns no row when the activity is already there, so a
			// re-applied event announces nothing it did not actually write.
			const insert = (
				tone: string,
				kind: string,
				summary: string,
				payload: unknown,
			) => {
				const id = `${event.sessionId}:${event.sequence}:${kind}`;
				const payloadJson = encodeJson(payload);
				return sql<OwnedRow>`
					INSERT OR IGNORE INTO activities
					(id, session_id, tone, kind, summary, payload, sequence, created_at)
					VALUES (${id}, ${event.sessionId}, ${tone}, ${kind}, ${summary}, ${payloadJson}, ${event.sequence}, ${event.createdAt})
					RETURNING session_id`;
			};

			if (isEventType(event, "tool.started")) {
				return owners(
					yield* insert(
						"tool",
						"tool.started",
						event.data.toolName,
						event.data,
					),
				);
			}
			if (isEventType(event, "tool.running")) {
				return owners(
					yield* insert("tool", "tool.running", event.data.partId, event.data),
				);
			}
			if (isEventType(event, "tool.completed")) {
				const summary = `${event.data.partId} (${event.data.duration}ms)`;
				return owners(
					yield* insert("tool", "tool.completed", summary, event.data),
				);
			}
			if (isEventType(event, "permission.asked")) {
				return owners(
					yield* insert(
						"approval",
						"permission.asked",
						event.data.toolName,
						event.data,
					),
				);
			}
			if (isEventType(event, "permission.resolved")) {
				return owners(
					yield* insert(
						"approval",
						"permission.resolved",
						event.data.decision,
						event.data,
					),
				);
			}
			if (isEventType(event, "question.asked")) {
				return owners(
					yield* insert("info", "question.asked", "Question asked", event.data),
				);
			}
			if (isEventType(event, "question.resolved")) {
				return owners(
					yield* insert(
						"info",
						"question.resolved",
						"Question answered",
						event.data,
					),
				);
			}
			if (isEventType(event, "turn.error")) {
				return owners(
					yield* insert("error", "turn.error", event.data.error, event.data),
				);
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "activity",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
});

export const makeApprovalProjector = (): EffectProjector => ({
	name: "approval",
	handles: [
		"permission.asked",
		"permission.resolved",
		"question.asked",
		"question.resolved",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			// The resolve statements find their approval by id and never name a
			// session, so only the row can say whose it was.
			// `version` is what the approvals subscription windows on (ni8.9);
			// `details` keeps the rest of the asked payload for the card.
			if (isEventType(event, "permission.asked")) {
				const { id, sessionId, toolName, input, ...details } = event.data;
				return yield* sql<OwnedRow & { created_at: number }>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, tool_name, input, details, version, created_at)
						VALUES (${id}, ${sessionId}, 'permission', 'pending', ${toolName}, ${encodeJson(input)}, ${encodeJson(details)}, ${ctx.version}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "permission.resolved")) {
				return yield* sql<OwnedRow & { created_at: number }>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${event.data.decision}, resolved_at = ${event.createdAt}, version = ${ctx.version}
						WHERE id = ${event.data.id}
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "question.asked")) {
				const { id, sessionId, questions, ...details } = event.data;
				return yield* sql<OwnedRow & { created_at: number }>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, input, details, version, created_at)
						VALUES (${id}, ${sessionId}, 'question', 'pending', ${encodeJson(questions)}, ${encodeJson(details)}, ${ctx.version}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING
						RETURNING session_id, created_at`;
			}

			if (isEventType(event, "question.resolved")) {
				const answersJson = encodeJson(event.data.answers);
				return yield* sql<OwnedRow & { created_at: number }>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${answersJson}, resolved_at = ${event.createdAt}, version = ${ctx.version}
						WHERE id = ${event.data.id}
						RETURNING session_id, created_at`;
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "approval",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) =>
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					const messageIds: string[] = [];
					for (const approval of written) {
						// Every turn open across the wait reads it (see turnTimingColumns),
						// so a prompt queued behind a running one needs both re-sent.
						const turns = yield* sql<{ id: string }>`
							SELECT id FROM turns
							WHERE session_id = ${approval.session_id}
							AND requested_at <= ${approval.created_at}
							AND (completed_at IS NULL OR completed_at >= ${approval.created_at})`;
						messageIds.push(...ids(turns));
					}
					const sessions = yield* stampSessions(owners(written), ctx.version);
					// The pending counts roll up into the family's row.
					yield* refreshSidebar(sessions.stamped, ctx.version);
					return mergeTouches([
						yield* stampMessage(messageIds, ctx.version),
						sessions,
					]);
				}),
			),
		),
});

export const makeProviderProjector = (): EffectProjector => ({
	name: "provider",
	handles: ["session.created", "session.provider_changed"],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "session.created")) {
				return owners(
					yield* sql<OwnedRow>`
						INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
						VALUES (${`${event.data.sessionId}:initial`}, ${event.data.sessionId}, ${event.data.provider}, 'active', ${event.createdAt})
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "session.provider_changed")) {
				const stopped = yield* sql<OwnedRow>`
					UPDATE session_providers
					SET status = 'stopped', deactivated_at = ${event.createdAt}
					WHERE session_id = ${event.data.sessionId} AND status = 'active'
					RETURNING session_id`;

				const started = yield* sql<OwnedRow>`
					INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
					VALUES (${`${event.data.sessionId}:${event.sequence}`}, ${event.data.sessionId}, ${event.data.newProvider}, 'active', ${event.createdAt})
					RETURNING session_id`;
				return [...owners(stopped), ...owners(started)];
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "provider",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
});

/**
 * Canonical event types that deliberately reach no projector.
 *
 * An unclaimed type is indistinguishable from a handled one at runtime: the
 * dispatch map simply finds nothing, and the cursor advances anyway. That is
 * how session.compaction stayed unprojected for three months behind a green
 * suite. Anything absent here and absent from every projector's `handles` is a
 * bug, and projector-coverage.test.ts fails on it.
 */
export const UNPROJECTED_CANONICAL_EVENT_TYPES: readonly string[] = [
	// Superseded by tool.started carrying the complete input; kept in the
	// canonical vocabulary only so historical stores still decode.
	"tool.input_updated",
	"session.provider_cleanup_failed",
	"session.handoff_delivered", // Delivery receipt needs no materialized projection.
	// Retired read state (hk9m.7): SessionAttention writes seen_version instead.
	// Kept so historical stores still decode.
	"session.read",
	"session.unread",
];

/**
 * Creates all 6 Effect-based projectors in the correct order.
 * Order matters for FK compliance: SessionProjector first.
 */
export function createAllEffectProjectors(): EffectProjector[] {
	return [
		makeSessionProjector(),
		makeMessageProjector(),
		makeTurnProjector(),
		makeProviderProjector(),
		makeApprovalProjector(),
		makeActivityProjector(),
	];
}
