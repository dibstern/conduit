// ─── Effect-based Projectors ────────────────────────────────────────────────
// Migrates all projectors from raw SqliteClient to @effect/sql SqlClient.
// Each projector's `project` method becomes an Effect program.

import { SqlClient } from "@effect/sql";
import type { SqlError } from "@effect/sql/SqlError";
import { Data, Effect } from "effect";
import type {
	CanonicalEventType,
	EventPayloadMap,
	StoredEvent,
} from "../events.js";

import {
	getSessionStatements,
	SESSION_HANDLED_TYPES,
} from "../projectors/session-handlers.js";

// ─── Error type ─────────────────────────────────────────────────────────────

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
	readonly projector: string;
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Effect Projector interface ─────────────────────────────────────────────

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

export interface EffectProjector {
	readonly name: string;
	readonly handles: readonly CanonicalEventType[];
	/**
	 * Apply the event, then report the ids of the sessions whose read-model rows
	 * it stamped. Every statement names the rows it wrote through `RETURNING`,
	 * so a projector can neither stamp a row it did not write nor stay quiet
	 * about one it did, and the projection runner needs nothing from the caller
	 * to know what moved.
	 */
	readonly project: (
		event: StoredEvent,
		ctx: ProjectionContext,
	) => Effect.Effect<
		readonly string[],
		ProjectionError | SqlError,
		SqlClient.SqlClient
	>;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

function isEventType<K extends CanonicalEventType>(
	event: StoredEvent,
	type: K,
): event is StoredEvent & { type: K; data: EventPayloadMap[K] } {
	return event.type === type;
}

// ─── Read-model stamping ────────────────────────────────────────────────────

// A child-table row naming the session row it belongs to. `turns`, `activities`,
// `pending_approvals` and `session_providers` carry no version of their own, so
// the session row that owns them is what moves — and the owner is whatever the
// write itself put in `session_id`, not what the event header says.
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
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const stamped: string[] = [];
		for (const sessionId of new Set(sessionIds)) {
			const rows = yield* sql<{ id: string }>`
				UPDATE sessions SET version = ${version}
				WHERE id = ${sessionId}
				RETURNING id`;
			stamped.push(...rows.map((row) => row.id));
		}
		return stamped;
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
): Effect.Effect<readonly string[], SqlError, SqlClient.SqlClient> =>
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
		return stamped;
	});

function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

function mergeMetadata(
	current: string | null,
	next: Record<string, unknown> | undefined,
): string | null {
	if (next === undefined) return current;
	let currentObject: Record<string, unknown> = {};
	if (current != null) {
		try {
			const parsed: unknown = JSON.parse(current);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				currentObject = parsed as Record<string, unknown>;
			}
		} catch {
			currentObject = {};
		}
	}
	return encodeJson({ ...currentObject, ...next });
}

// ─── Session Projector ──────────────────────────────────────────────────────

export const makeSessionProjector = (): EffectProjector => ({
	name: "session",
	handles: SESSION_HANDLED_TYPES,
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const written: string[] = [];

			// Every session statement is a single-table write against `sessions`
			// keyed by id, so `RETURNING id` names exactly the rows it wrote: the
			// subagent row for a message filed under its parent, and nothing at
			// all when the auto-title guard declines the rename.
			for (const stmt of getSessionStatements(event)) {
				const rows = yield* sql.unsafe<{ id: string }>(
					`${stmt.sql} RETURNING id`,
					[...stmt.params],
				);
				written.push(...rows.map((row) => row.id));
			}
			return written;
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
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
});

// ─── Message Projector ──────────────────────────────────────────────────────

export const makeMessageProjector = (): EffectProjector => ({
	name: "message",
	handles: [
		"message.created",
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
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "message.created")) {
				const isStreaming = event.data.role === "assistant" ? 1 : 0;
				return ids(
					yield* sql<{ id: string }>`
						INSERT INTO messages
						(id, session_id, role, text, is_streaming, created_at, updated_at)
						VALUES (${event.data.messageId}, ${event.data.sessionId}, ${event.data.role}, '', ${isStreaming}, ${event.createdAt}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING
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
					INSERT INTO message_parts (id, message_id, type, text, sort_order, created_at, updated_at)
					VALUES (${event.data.partId}, ${event.data.messageId}, 'thinking', '',
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
				const metadata = mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
				);
				yield* sql`
					UPDATE message_parts
					SET status = CASE
							WHEN status IN ('completed', 'error') THEN status
							ELSE 'running'
						END,
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
				const metadata = mergeMetadata(
					rows[0]?.metadata ?? null,
					event.data.metadata,
				);
				yield* sql`
					UPDATE message_parts
					SET result = ${resultJson}, duration = ${event.data.duration}, status = 'completed', metadata = ${metadata}, updated_at = ${event.createdAt}
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
				const tokens = event.data.tokens;
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
				return ids(
					yield* sql<{
						id: string;
					}>`UPDATE messages SET is_streaming = 0, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId} RETURNING id`,
				);
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
			Effect.flatMap((written) => stampMessage(written, ctx.version)),
		),
});

// ─── Turn Projector ─────────────────────────────────────────────────────────

export const makeTurnProjector = (): EffectProjector => ({
	name: "turn",
	handles: [
		"message.created",
		"session.status",
		"turn.completed",
		"turn.error",
		"turn.interrupted",
		"turn.model_resolved",
	],
	project: (event: StoredEvent, ctx: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "message.created")) {
				if (event.data.role === "user") {
					return owners(
						yield* sql<OwnedRow>`
							INSERT OR REPLACE INTO turns
							(id, session_id, state, user_message_id, requested_at)
							VALUES (${event.data.messageId}, ${event.data.sessionId}, 'pending', ${event.data.messageId}, ${event.createdAt})
							RETURNING session_id`,
					);
				}
				return owners(
					yield* sql<OwnedRow>`
						UPDATE turns
						SET assistant_message_id = ${event.data.messageId}
						WHERE id = (
							SELECT id FROM turns
							WHERE session_id = ${event.data.sessionId}
								AND assistant_message_id IS NULL
								AND state IN ('pending', 'running')
							ORDER BY requested_at DESC
							LIMIT 1
						)
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "session.status")) {
				if (event.data.status !== "busy") return [];
				return owners(
					yield* sql<OwnedRow>`
						UPDATE turns
						SET state = 'running', started_at = ${event.createdAt}
						WHERE id = (
							SELECT id FROM turns
							WHERE session_id = ${event.data.sessionId}
								AND state = 'pending'
							ORDER BY requested_at DESC
							LIMIT 1
						)
						RETURNING session_id`,
				);
			}

			// These three find their turn by assistant message id, so the owning
			// session is nowhere in the statement — `RETURNING session_id` is the
			// only thing that knows which session row actually moved.
			if (isEventType(event, "turn.completed")) {
				const tokens = event.data.tokens;
				return owners(
					yield* sql<OwnedRow>`
						UPDATE turns
						SET state = 'completed',
							cost = ${event.data.cost ?? null},
							tokens_in = ${tokens?.input ?? null},
							tokens_out = ${tokens?.output ?? null},
							completed_at = ${event.createdAt}
						WHERE assistant_message_id = ${event.data.messageId}
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "turn.error")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE turns
						SET state = 'error', completed_at = ${event.createdAt}
						WHERE assistant_message_id = ${event.data.messageId}
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "turn.interrupted")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE turns
						SET state = 'interrupted', completed_at = ${event.createdAt}
						WHERE assistant_message_id = ${event.data.messageId}
						RETURNING session_id`,
				);
			}

			// Attributed to the newest open turn rather than by id, because the
			// event carries no key that reaches a turns row: turns.id is the user
			// message id, while the provider's turnId is a per-send uuid. This is
			// exact only while a session has at most one turn in flight. The
			// Claude translator is the sole emitter and its runtime serializes
			// turn admission, so a turn's model_resolved always lands before the
			// next turn's row exists. A second emitter, or concurrent turns,
			// needs a real key first — see conduit-test-7i3.
			if (isEventType(event, "turn.model_resolved")) {
				return owners(
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
				);
			}
			return [];
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
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
});

// ─── Activity Projector ─────────────────────────────────────────────────────

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

// ─── Approval Projector ─────────────────────────────────────────────────────

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
			if (isEventType(event, "permission.asked")) {
				const inputJson = encodeJson(event.data.input);
				return owners(
					yield* sql<OwnedRow>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, tool_name, input, created_at)
						VALUES (${event.data.id}, ${event.data.sessionId}, 'permission', 'pending', ${event.data.toolName}, ${inputJson}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "permission.resolved")) {
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${event.data.decision}, resolved_at = ${event.createdAt}
						WHERE id = ${event.data.id}
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "question.asked")) {
				const questionsJson = encodeJson(event.data.questions);
				return owners(
					yield* sql<OwnedRow>`
						INSERT INTO pending_approvals
						(id, session_id, type, status, input, created_at)
						VALUES (${event.data.id}, ${event.data.sessionId}, 'question', 'pending', ${questionsJson}, ${event.createdAt})
						ON CONFLICT (id) DO NOTHING
						RETURNING session_id`,
				);
			}

			if (isEventType(event, "question.resolved")) {
				const answersJson = encodeJson(event.data.answers);
				return owners(
					yield* sql<OwnedRow>`
						UPDATE pending_approvals
						SET status = 'resolved', decision = ${answersJson}, resolved_at = ${event.createdAt}
						WHERE id = ${event.data.id}
						RETURNING session_id`,
				);
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
			Effect.flatMap((written) => stampSessions(written, ctx.version)),
		),
});

// ─── Provider Projector ─────────────────────────────────────────────────────

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

// ─── Factory ────────────────────────────────────────────────────────────────

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
