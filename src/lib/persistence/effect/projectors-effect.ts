// Each projector's `project` method is an Effect program over @effect/sql SqlClient.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect } from "effect";
import type { ReadModelCollection } from "../../contracts/read-model-advance.js";
import { persistedTurnState } from "../../contracts/turn-phase.js";
import { CLAUDE_WORKTREE_EVENTS } from "../../session/claude-worktree-state.js";
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
import { PAGE_MESSAGES } from "../session-history-adapter.js";
import { rerootSession } from "./sidebar-projection.js";

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
	readonly collections: readonly ReadModelCollection[];
	/**
	 * Sessions whose family's sidebar row this projection may have changed,
	 * or that held a row before it. The runner refreshes them all once per
	 * transaction, not once per projection.
	 */
	readonly sidebar?: readonly string[];
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
	const sidebar = new Set<string>();
	const collections = new Set<ReadModelCollection>();
	for (const touch of touches) {
		for (const sessionId of touch.stamped) live.set(sessionId, true);
		for (const sessionId of touch.removed) live.set(sessionId, false);
		for (const sessionId of touch.sidebar ?? []) sidebar.add(sessionId);
		for (const collection of touch.collections) collections.add(collection);
	}
	if (sidebar.size > 0) collections.add("sidebar");
	return {
		stamped: [...live].filter(([, alive]) => alive).map(([id]) => id),
		removed: [...live].filter(([, alive]) => !alive).map(([id]) => id),
		collections: [...collections],
		...(sidebar.size > 0 ? { sidebar: [...sidebar] } : {}),
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

// A child-table row naming the session row it belongs to. `turns`,
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
		return {
			stamped,
			removed,
			collections: stamped.length > 0 || removed.length > 0 ? ["sessions"] : [],
		};
	});

// Takes the messages the handler reported writing, not the id in the event
// header: a guard that declined and a conflict that was ignored both report
// nothing, and a row nobody wrote must not be announced as changed.
//
// Returns the owning session rather than the event's own, because a subagent
// message is stored against the subagent session and that is the row a
// subscriber must re-query. A part write stamps the part itself and also
// advances the message that owns it, whose updated_at moved with it.
const stampMessage = (
	messageIds: readonly string[],
	version: number,
): Effect.Effect<ProjectionTouch, SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		const changedSessions: string[] = [];
		for (const messageId of new Set(messageIds)) {
			const rows = yield* sql<OwnedRow & { readonly created_at: number }>`
				UPDATE messages SET version = ${version}
				WHERE id = ${messageId}
				RETURNING session_id, created_at`;
			// The fork split uses the copy's stored clock, including when a
			// snapshot replaces a streamed row with a provider timestamp.
			for (const row of rows) {
				changedSessions.push(
					...ids(
						yield* sql<{
							id: string;
						}>`UPDATE sessions SET fork_point_timestamp = ${row.created_at},
					version = ${version}
					WHERE id = ${row.session_id} AND fork_point_event = ${messageId}
					AND fork_point_timestamp IS NOT ${row.created_at} RETURNING id`,
					),
				);
			}
			stamped.push(...owners(rows));
		}
		// A message row that vanished under its own event went with the session
		// that owned it, and the session projector reports that removal by name.
		// Nothing to add here: the missing id is a message id, and the advance
		// speaks in sessions.
		const collections: ReadModelCollection[] = [];
		if (stamped.length > 0) collections.push("messages");
		if (changedSessions.length > 0) collections.push("sessions");
		return {
			stamped,
			removed: [],
			collections,
			...(changedSessions.length > 0 ? { sidebar: changedSessions } : {}),
		};
	});

interface RewindCut {
	readonly id: string;
	readonly created_at: number;
}

const restampRewind = (
	sessionId: string,
	previousCut: RewindCut | null | undefined,
	cut: RewindCut | null | undefined,
	version: number,
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		// Old events did not carry the preceding cut. A missing cut row also
		// leaves its ordering unknown, so preserve the full-restamp behavior.
		if (previousCut === undefined || cut === undefined) {
			yield* sql`UPDATE message_parts SET version = ${version}
				WHERE message_id IN (SELECT id FROM messages WHERE session_id = ${sessionId})`;
			return ids(
				yield* sql<{
					id: string;
				}>`SELECT id FROM messages WHERE session_id = ${sessionId}`,
			);
		}
		const boundary = previousCut ?? cut;
		// Either range starts at the earlier cut in SQLite's (created_at, id)
		// ordering. Null means no pending cut, i.e. no hidden messages.
		const affected =
			previousCut && cut
				? sql`(created_at, id) >= (${previousCut.created_at}, ${previousCut.id})
					OR (created_at, id) >= (${cut.created_at}, ${cut.id})`
				: boundary
					? sql`(created_at, id) >= (${boundary.created_at}, ${boundary.id})`
					: sql.literal("0");
		const visible = cut
			? sql`(created_at, id) < (${cut.created_at}, ${cut.id})`
			: sql.literal("1");
		const restored = previousCut
			? sql`(created_at, id) >= (${previousCut.created_at}, ${previousCut.id})`
			: sql.literal("0");
		const page = sql`SELECT id FROM messages WHERE session_id = ${sessionId}
			AND ${visible} ORDER BY created_at DESC, id DESC LIMIT ${PAGE_MESSAGES}`;
		// Hidden messages need only headers for removals. Restored messages and
		// the visible page before the new cut need their parts and headers whole.
		yield* sql`UPDATE message_parts SET version = ${version} WHERE message_id IN (
			SELECT id FROM messages WHERE session_id = ${sessionId} AND ${restored} AND ${visible}
			UNION SELECT id FROM (${page})
		)`;
		return ids(
			yield* sql<{ id: string }>`SELECT id FROM messages
				WHERE session_id = ${sessionId} AND (${affected})
				UNION SELECT id FROM (${page})`,
		);
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
			const left: string[] = [];

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
			const [worktree] = CLAUDE_WORKTREE_EVENTS.has(event.type)
				? yield* sql<{ claude_worktree_state: string | null }>`
					SELECT claude_worktree_state FROM sessions
					WHERE id = ${event.sessionId}`
				: [];
			for (const stmt of getSessionStatements(
				event,
				worktree?.claude_worktree_state,
			)) {
				if (isSessionRemoval(stmt)) {
					const subtree = yield* sql.unsafe<{ id: string }>(
						SESSION_SUBTREE_SQL,
						[stmt.removeSession],
					);
					const roots = yield* sql<{ root_id: string | null }>`
						SELECT root_id FROM sessions WHERE id = ${stmt.removeSession}`;
					left.push(...roots.flatMap((row) => row.root_id ?? []));
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
				left.push(...(yield* rerootSession(event.data.sessionId)));
			const touch = yield* stampSessions(written, ctx.version);
			// A removed session, child or root, leaves a deleted tombstone.
			return {
				...touch,
				collections:
					touch.removed.length > 0
						? ([
								...touch.collections,
								"messages",
								"approvals",
								"inputs",
							] as const)
						: touch.collections,
				sidebar: [...touch.stamped, ...touch.removed, ...left],
			};
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
		"session.rewound",
		"session.rewind_undone",
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
		"session.setup_started",
		"session.setup_output",
		"session.setup_finished",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			if (isEventType(event, "session.setup_started")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				// Like other daemon notices, this uses the transcript's existing
				// part storage. Typed metadata distinguishes it from agent text.
				yield* sql`INSERT INTO message_parts
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${`${messageId}-part`}, ${messageId}, 'text', '',
						${encodeJson({ setup: { source: event.data.source, status: "running" } })},
						0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				return [messageId];
			}
			if (isEventType(event, "session.setup_output")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`UPDATE message_parts SET text = text || ${event.data.output},
					updated_at = ${event.createdAt}, version = ${ctx.version} WHERE id = ${`${messageId}-part`}`;
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET updated_at = ${event.createdAt} WHERE id = ${messageId} RETURNING id`,
				);
			}
			if (isEventType(event, "session.setup_finished")) {
				const messageId = `setup-${event.sessionId}`;
				yield* sql`UPDATE message_parts SET
					metadata = json_set(metadata, '$.setup.status', ${event.data.status},
						'$.setup.exitCode', ${event.data.exitCode ?? null},
						'$.setup.message', ${event.data.message ?? null}),
					updated_at = ${event.createdAt}, version = ${ctx.version} WHERE id = ${`${messageId}-part`}`;
				return ids(
					yield* sql<{ id: string }>`UPDATE messages
					SET updated_at = ${event.createdAt}, completed_at = ${event.createdAt}
					WHERE id = ${messageId} RETURNING id`,
				);
			}
			if (
				isEventType(event, "session.rewound") ||
				isEventType(event, "session.rewind_undone")
			) {
				const previousId = event.data.previousMessageId;
				const cutId = isEventType(event, "session.rewound")
					? event.data.messageId
					: null;
				const cutIds = [previousId, cutId].filter(
					(id): id is string => typeof id === "string",
				);
				const cuts =
					previousId === undefined || cutIds.length === 0
						? []
						: yield* sql<RewindCut>`SELECT id, created_at FROM messages
							WHERE session_id = ${event.sessionId} AND id IN ${sql.in(cutIds)}`;
				return yield* restampRewind(
					event.sessionId,
					previousId === null ? null : cuts.find(({ id }) => id === previousId),
					cutId === null ? null : cuts.find(({ id }) => id === cutId),
					ctx.version,
				);
			}
			// A turn that ends without thinking.end must not leave thinking open.
			const closeThinking = (messageId: string) =>
				Effect.map(
					sql<{
						message_id: string;
					}>`UPDATE message_parts SET status = 'completed', version = ${ctx.version}
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
			// A result keyed by its prompt has no answer of its own. Its
			// messageId can name the previous answer, whose usage and time stay put.
			if (isEventType(event, "turn.completed") && event.data.userMessageId)
				return [];
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
					// A late provider echo still tags the snapshot row with its send.
					if (isEventType(event, "message.created") && event.data.inputId) {
						return ids(
							yield* sql<{
								id: string;
							}>`UPDATE messages SET input_id = ${event.data.inputId}
								WHERE id = ${event.data.messageId} AND input_id IS NULL
								RETURNING id`,
						);
					}
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
				// Only snapshots can change a stored message's ordering clock. Drive
				// the cut lookup from this message's primary key, never scan sessions
				// on ordinary writes or restamp siblings when the clock is unchanged.
				const existing = yield* sql<{
					is_backfilled: number;
					created_at: number;
					rewind_session_id: string | null;
				}>`SELECT m.is_backfilled, m.created_at, s.id AS rewind_session_id
					FROM messages m LEFT JOIN sessions s
						ON s.id = m.session_id AND s.pending_rewind_message_id = m.id
					WHERE m.id = ${message.id}`;
				const written = yield* sql<{ id: string }>`
					INSERT INTO messages
					(id, session_id, role, text, cost, tokens_in, tokens_out,
					 tokens_cache_read, tokens_cache_write, context_window, context_tokens,
					 is_streaming, is_backfilled, created_at, updated_at,
					 rest_digest, rest_event_id, rest_payload, finish, error)
					VALUES (${message.id}, ${event.sessionId}, ${message.role}, ${text},
					 ${message.cost ?? null}, ${message.tokens?.input ?? null},
					 ${message.tokens?.output ?? null}, ${message.tokens?.cache?.read ?? null},
					 ${message.tokens?.cache?.write ?? null}, ${message.tokens?.contextWindow ?? null},
					 ${message.role === "assistant" && message.summary === true && message.time?.completed != null && message.error == null ? 0 : null},
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
					 context_tokens = excluded.context_tokens,
					 completed_at = NULL,
					 created_at = excluded.created_at, updated_at = excluded.updated_at,
					 rest_digest = excluded.rest_digest, rest_event_id = excluded.rest_event_id,
					 rest_payload = excluded.rest_payload,
					 finish = excluded.finish, error = excluded.error
				RETURNING id`;
				// A provider snapshot replaces provider parts, while Conduit's own
				// compaction outcomes must survive reconciliation and reconnects.
				const replaced = yield* sql<{ id: string }>`
					DELETE FROM message_parts WHERE message_id = ${message.id}
					AND NOT (type = 'compaction' AND rest_payload IS NULL) RETURNING id`;
				const kept = new Set(message.parts.map((part) => part.id));
				for (const { id } of replaced) {
					if (kept.has(id)) continue;
					yield* sql`INSERT INTO message_part_tombstones (session_id, message_id, part_id, version)
						VALUES (${event.sessionId}, ${message.id}, ${id}, ${ctx.version})
						ON CONFLICT (part_id) DO UPDATE SET
						session_id = excluded.session_id, message_id = excluded.message_id,
						version = excluded.version`;
				}
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
						 status, sort_order, created_at, updated_at, metadata, rest_payload, version)
						VALUES (${part.id}, ${message.id}, ${part.type},
						 ${typeof part["text"] === "string" ? part["text"] : ""},
						 ${typeof part["tool"] === "string" ? part["tool"] : null},
						 ${typeof part["callID"] === "string" ? part["callID"] : null},
						 ${toolState && "input" in toolState ? encodeJson(toolState.input) : null},
						 ${toolState && "output" in toolState ? encodeJson(toolState.output) : null},
						 ${toolState && "status" in toolState && typeof toolState.status === "string" ? toolState.status : null},
						 ${index}, ${start}, ${end},
						 ${toolState && "metadata" in toolState ? encodeJson(toolState.metadata) : null},
						 ${encodeJson(part)}, ${ctx.version})`;
				}
				const previous = existing[0];
				const moved =
					previous?.rewind_session_id && previous.created_at !== created
						? yield* restampRewind(
								previous.rewind_session_id,
								{ id: message.id, created_at: previous.created_at },
								{ id: message.id, created_at: created },
								ctx.version,
							)
						: [];
				return [...ids(written), ...moved];
			}

			if (isEventType(event, "message.part.removed")) {
				const removed = yield* sql<{ id: string }>`DELETE FROM message_parts
					WHERE id = ${event.data.partId} AND message_id = ${event.data.messageId}
					RETURNING id`;
				if (removed.length === 0) return [];
				yield* sql`INSERT INTO message_part_tombstones (session_id, message_id, part_id, version)
					VALUES (${event.sessionId}, ${event.data.messageId}, ${event.data.partId}, ${ctx.version})
					ON CONFLICT (part_id) DO UPDATE SET
					session_id = excluded.session_id, message_id = excluded.message_id,
					version = excluded.version`;
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
				// A live user message whose input was sent as a steer, landing while
				// another turn is open, was read mid-turn; the turn projector closes
				// that turn. A steer landing after the turn ended ran as its own.
				const steers = event.data.role === "user" && !isBackfilled;
				return ids(
					yield* sql<{ id: string }>`
						INSERT INTO messages
						(id, session_id, role, text, is_streaming, is_backfilled, created_at, updated_at, parent_id, input_id, steered)
						VALUES (${event.data.messageId}, ${event.data.sessionId}, ${event.data.role}, '', ${isStreaming}, ${isBackfilled}, ${event.createdAt}, ${event.createdAt}, ${event.data.parentID ?? null}, ${event.data.inputId ?? null},
							${steers ? 1 : 0}
								AND EXISTS (SELECT 1 FROM pending_inputs
									WHERE input_id = ${event.data.inputId ?? null}
									AND state = 'steering')
								AND EXISTS (SELECT 1 FROM turns
									WHERE session_id = ${event.data.sessionId}
									AND state IN ('pending', 'running')
									AND id != ${event.data.messageId}))
						ON CONFLICT (id) DO UPDATE SET
							role = excluded.role,
							is_streaming = CASE WHEN excluded.role = 'user' THEN 0 ELSE messages.is_streaming END,
							input_id = COALESCE(messages.input_id, excluded.input_id)
						WHERE messages.role <> excluded.role
							OR (messages.input_id IS NULL AND excluded.input_id IS NOT NULL)
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
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'text', ${event.data.text},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						updated_at = excluded.updated_at, version = excluded.version`;

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
					INSERT INTO message_parts (id, message_id, type, text, status, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', '', 'running',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
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
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', ${event.data.text},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO UPDATE SET
						text = message_parts.text || excluded.text,
						updated_at = excluded.updated_at, version = excluded.version`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "thinking.end")) {
				// The part's own span ends here, not at its last delta.
				yield* sql`UPDATE message_parts
					SET status = 'completed', updated_at = ${event.createdAt}, version = ${ctx.version}
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
					(id, message_id, type, tool_name, call_id, input, status, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'tool', ${event.data.toolName}, ${event.data.callId}, ${inputJson}, 'started',
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			// A part write advances the message that owns the part: a task update can
			// name whichever message is streaming when it lands (a background task
			// finishing after its turn), and that message's refetch misses this part.
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
						updated_at = ${event.createdAt},
						version = ${ctx.version}
					WHERE id = ${event.data.partId}`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = COALESCE((SELECT message_id FROM message_parts WHERE id = ${event.data.partId}), ${event.data.messageId}) RETURNING id`,
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
					SET result = ${resultJson}, duration = ${event.data.duration}, status = 'completed', metadata = ${metadata}, updated_at = ${event.createdAt}, version = ${ctx.version},
						input = COALESCE(${event.data.input === undefined ? null : encodeJson(event.data.input)}, input)
					WHERE id = ${event.data.partId}`;
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = COALESCE((SELECT message_id FROM message_parts WHERE id = ${event.data.partId}), ${event.data.messageId}) RETURNING id`,
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
					(id, message_id, type, metadata, sort_order, created_at, updated_at, version)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'file', ${metadata},
						COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${event.data.messageId}), 0),
						${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;

				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
			}

			if (isEventType(event, "turn.completed")) {
				// New Claude completions carry cost deltas, so repeated completions add.
				// Other providers and historical Claude events retain latest-wins cost.
				const tokens = event.data.tokens;
				yield* closeThinking(event.data.messageId);
				return ids(
					yield* sql<{ id: string }>`
					UPDATE messages SET
					cost = CASE WHEN ${event.data.providerCostTotalUsd !== undefined ? 1 : 0}
						THEN COALESCE(cost, 0) + ${event.data.cost ?? 0}
						ELSE ${event.data.cost ?? null} END,
					tokens_in = ${tokens?.input ?? null},
					tokens_out = ${tokens?.output ?? null},
					tokens_cache_read = ${tokens?.cacheRead ?? null},
					tokens_cache_write = ${tokens?.cacheWrite ?? null},
					context_tokens = ${event.data.contextTokens ?? null},
					context_window = ${tokens?.contextWindow ?? null},
					is_streaming = 0,
					completed_at = ${event.createdAt},
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
					(id, message_id, type, text, metadata, sort_order, created_at, updated_at, version)
					VALUES (${`turn-error-part-${event.sequence}`}, ${errorMessageId}, 'error', ${event.data.error},
						${event.data.code === undefined ? null : encodeJson({ code: event.data.code })},
						0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
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
				const summaryId =
					event.provider === "opencode"
						? event.metadata.providerRefs?.providerMessageId
						: undefined;
				const ownerId =
					summaryId ??
					(latest?.role === "assistant" && latest.is_streaming === 1
						? latest.id
						: undefined);
				if (ownerId) {
					yield* sql`
						INSERT INTO message_parts
						(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at, version)
						VALUES (${partId}, ${ownerId}, 'compaction', ${event.data.detail}, ${metadata}, ${status},
							COALESCE((SELECT MAX(sort_order) + 1 FROM message_parts WHERE message_id = ${ownerId}), 0),
							${event.createdAt}, ${event.createdAt}, ${ctx.version})
						ON CONFLICT (id) DO NOTHING`;
					return [ownerId];
				}
				const messageId = `compaction-${event.sequence}`;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at, version)
					VALUES (${messageId}, ${event.data.sessionId}, 'assistant', '', 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
					ON CONFLICT (id) DO NOTHING`;
				yield* sql`
					INSERT INTO message_parts
					(id, message_id, type, text, metadata, status, sort_order, created_at, updated_at, version)
					VALUES (${partId}, ${messageId}, 'compaction', ${event.data.detail}, ${metadata}, ${status}, 0, ${event.createdAt}, ${event.createdAt}, ${ctx.version})
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
					? stampSessions([event.sessionId], ctx.version).pipe(
							Effect.map((touch) => ({
								...touch,
								collections: [...touch.collections, "messages"] as const,
							})),
						)
					: Effect.gen(function* () {
							const sql = yield* SqlClient.SqlClient;
							for (const messageId of new Set(written)) {
								yield* sql`DELETE FROM message_tombstones WHERE message_id = ${messageId}`;
								// Likewise a part written now, a snapshot's kept parts included.
								// A bulk batch (a fork's copied history) stamps every part with
								// one version, so SQLite's pick of the version index scans them all.
								yield* sql`DELETE FROM message_part_tombstones WHERE part_id IN (
									SELECT id FROM message_parts INDEXED BY idx_message_parts_message
									WHERE message_id = ${messageId} AND version = ${ctx.version})`;
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
				"messageId" in event.data &&
				!(isEventType(event, "turn.completed") && event.data.userMessageId)
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
					// A steer closes the turn it joined at its own start time, so a
					// folded result splits into two turns; the result completes this one.
					const closed = event.data.backfilled
						? []
						: yield* sql<
								OwnedRow & { id: string }
							>`UPDATE turns SET state = 'completed',
							completed_at = ${event.createdAt}
							WHERE session_id = ${event.data.sessionId}
							AND state IN ('pending', 'running')
							AND id != ${event.data.messageId}
							RETURNING id, session_id`;
					return {
						sessions: owners([
							...closed,
							...(yield* sql<OwnedRow>`
								INSERT OR REPLACE INTO turns
								(id, session_id, state, user_message_id, requested_at)
								VALUES (${event.data.messageId}, ${event.data.sessionId}, ${persistedTurnState("prompt")}, ${event.data.messageId}, ${event.createdAt})
								RETURNING session_id`),
						]),
						messages: ids(closed),
					};
				}
			}

			// Idle means the provider has nothing in flight, so every turn it
			// leaves open is over: one waiting for a reply never got it, and one
			// whose result named no reply this turn owns will see no other close.
			// The inbox reads an open turn as busy and would queue every later
			// send. A turn the provider continues reopens on its next reply.
			if (
				isEventType(event, "session.status") &&
				event.data.status === "idle"
			) {
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns SET state = 'completed', completed_at = ${event.createdAt}
						WHERE session_id = ${event.sessionId}
						AND state IN ('pending', 'running')
						AND requested_at <= ${event.createdAt}
						RETURNING id, session_id`;
				return { sessions: owners(written), messages: ids(written) };
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
				// Without a key, a signal belongs to the newest turn, except that a
				// newer turn not yet started must not take over a running turn's
				// busy and tool signals; a new reply is what starts it. A turn still
				// running from before a later one settled is a crash leftover, so it
				// never wins.
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
				const reopening = turn.state !== "pending" && turn.state !== "running";
				// A tool no message of ours owns (a background task restarting
				// between turns) joins an open turn only. Reopened, a settled turn
				// would run with no reply whose result could close it.
				if (
					reopening &&
					isEventType(event, "tool.started") &&
					!parentTurn.length
				)
					return { sessions: [], messages: [] };
				// Turns run one at a time, so a reply starting ends every earlier
				// turn still running.
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
				// New Claude completions add their cost deltas, like per-execution tokens.
				// Other providers and historical Claude events retain latest-wins cost.
				// A result-only turn (Claude /compact) has no reply of its own,
				// so it is keyed by its prompt instead of the previous turn's reply.
				const tokens = event.data.tokens;
				const written = yield* sql<OwnedRow & { id: string }>`
						UPDATE turns
						SET state = 'completed',
							cost = CASE WHEN ${event.data.providerCostTotalUsd !== undefined ? 1 : 0}
								THEN COALESCE(cost, 0) + ${event.data.cost ?? 0}
								ELSE COALESCE(${event.data.cost ?? null}, cost) END,
							tokens_in = COALESCE(tokens_in + ${tokens?.input ?? null}, tokens_in, ${tokens?.input ?? null}),
							tokens_out = COALESCE(tokens_out + ${tokens?.output ?? null}, tokens_out, ${tokens?.output ?? null}),
							completed_at = ${event.createdAt}
						WHERE ${
							event.data.userMessageId
								? sql`id = ${event.data.userMessageId} AND session_id = ${event.sessionId}`
								: // A turn can hold several replies (an input the SDK folds
									// into it starts a new one), but its row names only the
									// first, so the reply's own turn link settles it too.
									sql`session_id = ${event.sessionId}
									AND (assistant_message_id = ${event.data.messageId}
										OR id = (SELECT turn_id FROM messages
											WHERE id = ${event.data.messageId}))`
						}
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
				// it ends the running turn.
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
				// Stop ends the session's work, so whatever is still open stops with
				// the named turn. That also covers an empty id (stopped before naming
				// its reply) and an id no turn owns.
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
					return mergeTouches([
						yield* stampMessage(messageIds, ctx.version),
						// The pending counts roll up into the family's row.
						{
							...sessions,
							collections:
								written.length > 0
									? [...sessions.collections, "approvals"]
									: sessions.collections,
							sidebar: sessions.stamped,
						},
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

// One row per input conduit is holding. Rows are never deleted: a row that
// leaves the tray turns `removed` and takes the event's version, so catch-up
// can report it gone. Its owning session moves with every write.
export const makeInputProjector = (): EffectProjector => ({
	name: "input",
	handles: [
		"input.admitted",
		"input.sent",
		"input.cancelled",
		"input.interrupt_requested",
		"message.created",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "input.admitted")) {
				const { request } = event.data;
				const images = request.images ? encodeJson(request.images) : null;
				return owners(
					yield* sql<OwnedRow>`
						INSERT INTO pending_inputs
						(input_id, session_id, text, images, request, state, admitted_at, version)
						VALUES (${event.data.inputId}, ${event.data.sessionId}, ${request.text}, ${images}, ${encodeJson(request)}, 'queued', ${event.createdAt}, ${ctx.version})
						ON CONFLICT (input_id) DO NOTHING
						RETURNING session_id`,
				);
			}

			// The interrupt marker stays in events; the input remains queued.
			if (isEventType(event, "input.interrupt_requested"))
				return [event.data.sessionId];

			// Sent as a steer, the input stays in the tray until its message lands.
			// Otherwise it starts its own turn and leaves now.
			if (isEventType(event, "input.sent")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs
						SET state = ${event.data.steer ? "steering" : "removed"},
							version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state = 'queued'
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "input.cancelled")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs SET state = 'removed', version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state = 'queued'
						RETURNING session_id`,
				);
			}

			if (
				isEventType(event, "message.created") &&
				event.data.role === "user" &&
				event.data.inputId
			) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_inputs
						SET state = 'removed', version = ${ctx.version}
						WHERE input_id = ${event.data.inputId} AND state != 'removed'
						RETURNING session_id`,
				);
			}
			return [];
		}).pipe(
			Effect.mapError((e) =>
				e instanceof ProjectionError
					? e
					: new ProjectionError({
							projector: "input",
							operation: "project",
							cause: e,
						}),
			),
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
			Effect.map((touch) => ({
				...touch,
				collections:
					touch.stamped.length > 0 && event.type !== "input.interrupt_requested"
						? ([...touch.collections, "inputs"] as const)
						: touch.collections,
			})),
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
 * Creates all 7 Effect-based projectors in the correct order.
 * Order matters for FK compliance: SessionProjector first.
 */
export function createAllEffectProjectors(): EffectProjector[] {
	return [
		makeSessionProjector(),
		makeMessageProjector(),
		makeTurnProjector(),
		makeProviderProjector(),
		makeApprovalProjector(),
		makeInputProjector(),
	];
}
