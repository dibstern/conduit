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

// ─── Error type ─────────────────────────────────────────────────────────────

export class ProjectionError extends Data.TaggedError("ProjectionError")<{
	readonly projector: string;
	readonly operation: string;
	readonly cause: unknown;
}> {}

// ─── Effect Projector interface ─────────────────────────────────────────────

export interface ProjectionContext {
	readonly replaying?: boolean;
}

export interface EffectProjector {
	readonly name: string;
	readonly handles: readonly CanonicalEventType[];
	readonly project: (
		event: StoredEvent,
		ctx?: ProjectionContext,
	) => Effect.Effect<void, ProjectionError | SqlError, SqlClient.SqlClient>;
}

// ─── Type guard ─────────────────────────────────────────────────────────────

function isEventType<K extends CanonicalEventType>(
	event: StoredEvent,
	type: K,
): event is StoredEvent & { type: K; data: EventPayloadMap[K] } {
	return event.type === type;
}

function encodeJson(value: unknown): string {
	if (value === undefined) return "null";
	return JSON.stringify(value);
}

// ─── Session Projector ──────────────────────────────────────────────────────

export const makeSessionProjector = (): EffectProjector => ({
	name: "session",
	handles: [
		"session.created",
		"session.renamed",
		"session.status",
		"session.provider_changed",
		"turn.completed",
		"turn.error",
		"message.created",
	],
	project: (event: StoredEvent) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "session.created")) {
				yield* sql`
					INSERT INTO sessions (id, provider, title, status, created_at, updated_at)
					VALUES (${event.data.sessionId}, ${event.data.provider}, ${event.data.title}, 'idle', ${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO UPDATE SET
						provider = excluded.provider,
						title = excluded.title,
						updated_at = excluded.updated_at`;
				return;
			}

			if (isEventType(event, "session.renamed")) {
				yield* sql`UPDATE sessions SET title = ${event.data.title}, updated_at = ${event.createdAt} WHERE id = ${event.data.sessionId}`;
				return;
			}

			if (isEventType(event, "session.status")) {
				yield* sql`UPDATE sessions SET status = ${event.data.status}, updated_at = ${event.createdAt} WHERE id = ${event.data.sessionId}`;
				return;
			}

			if (isEventType(event, "session.provider_changed")) {
				yield* sql`UPDATE sessions SET provider = ${event.data.newProvider}, updated_at = ${event.createdAt} WHERE id = ${event.data.sessionId}`;
				return;
			}

			if (
				isEventType(event, "turn.completed") ||
				isEventType(event, "turn.error")
			) {
				yield* sql`UPDATE sessions SET updated_at = ${event.createdAt} WHERE id = ${event.sessionId}`;
				return;
			}

			if (isEventType(event, "message.created")) {
				yield* sql`
					UPDATE sessions SET
						last_message_at = MAX(COALESCE(last_message_at, 0), ${event.createdAt}),
						updated_at = ${event.createdAt}
					WHERE id = ${event.data.sessionId}`;
				return;
			}
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
		"turn.completed",
		"turn.error",
	],
	project: (event: StoredEvent, ctx?: ProjectionContext) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "message.created")) {
				const isStreaming = event.data.role === "assistant" ? 1 : 0;
				yield* sql`
					INSERT INTO messages
					(id, session_id, role, text, is_streaming, created_at, updated_at)
					VALUES (${event.data.messageId}, ${event.data.sessionId}, ${event.data.role}, '', ${isStreaming}, ${event.createdAt}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				return;
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
						return;
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

				yield* sql`
					UPDATE messages SET text = text || ${event.data.text}, last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
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

				yield* sql`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
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
						return;
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

				yield* sql`UPDATE messages SET last_applied_seq = ${event.sequence}, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "thinking.end")) {
				yield* sql`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
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

				yield* sql`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "tool.running")) {
				yield* sql`UPDATE message_parts SET status = 'running', updated_at = ${event.createdAt} WHERE id = ${event.data.partId}`;
				yield* sql`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "tool.completed")) {
				const resultJson = encodeJson(event.data.result);
				yield* sql`
					UPDATE message_parts
					SET result = ${resultJson}, duration = ${event.data.duration}, status = 'completed', updated_at = ${event.createdAt}
					WHERE id = ${event.data.partId}`;
				yield* sql`UPDATE messages SET updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "turn.completed")) {
				const tokens = event.data.tokens;
				yield* sql`
					UPDATE messages SET
					cost = ${event.data.cost ?? null},
					tokens_in = ${tokens?.input ?? null},
					tokens_out = ${tokens?.output ?? null},
					tokens_cache_read = ${tokens?.cacheRead ?? null},
					tokens_cache_write = ${tokens?.cacheWrite ?? null},
					is_streaming = 0,
					updated_at = ${event.createdAt}
					WHERE id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "turn.error")) {
				yield* sql`UPDATE messages SET is_streaming = 0, updated_at = ${event.createdAt} WHERE id = ${event.data.messageId}`;
				return;
			}
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
	],
	project: (event: StoredEvent) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "message.created")) {
				if (event.data.role === "user") {
					yield* sql`
						INSERT OR REPLACE INTO turns
						(id, session_id, state, user_message_id, requested_at)
						VALUES (${event.data.messageId}, ${event.data.sessionId}, 'pending', ${event.data.messageId}, ${event.createdAt})`;
				} else {
					yield* sql`
						UPDATE turns
						SET assistant_message_id = ${event.data.messageId}
						WHERE id = (
							SELECT id FROM turns
							WHERE session_id = ${event.data.sessionId}
								AND assistant_message_id IS NULL
								AND state IN ('pending', 'running')
							ORDER BY requested_at DESC
							LIMIT 1
						)`;
				}
				return;
			}

			if (isEventType(event, "session.status")) {
				if (event.data.status !== "busy") return;
				yield* sql`
					UPDATE turns
					SET state = 'running', started_at = ${event.createdAt}
					WHERE id = (
						SELECT id FROM turns
						WHERE session_id = ${event.data.sessionId}
							AND state = 'pending'
						ORDER BY requested_at DESC
						LIMIT 1
					)`;
				return;
			}

			if (isEventType(event, "turn.completed")) {
				const tokens = event.data.tokens;
				yield* sql`
					UPDATE turns
					SET state = 'completed',
						cost = ${event.data.cost ?? null},
						tokens_in = ${tokens?.input ?? null},
						tokens_out = ${tokens?.output ?? null},
						completed_at = ${event.createdAt}
					WHERE assistant_message_id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "turn.error")) {
				yield* sql`
					UPDATE turns
					SET state = 'error', completed_at = ${event.createdAt}
					WHERE assistant_message_id = ${event.data.messageId}`;
				return;
			}

			if (isEventType(event, "turn.interrupted")) {
				yield* sql`
					UPDATE turns
					SET state = 'interrupted', completed_at = ${event.createdAt}
					WHERE assistant_message_id = ${event.data.messageId}`;
				return;
			}
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
	project: (event: StoredEvent) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const insert = (
				tone: string,
				kind: string,
				summary: string,
				payload: unknown,
			) => {
				const id = `${event.sessionId}:${event.sequence}:${kind}`;
				const payloadJson = encodeJson(payload);
				return sql`
					INSERT OR IGNORE INTO activities
					(id, session_id, tone, kind, summary, payload, sequence, created_at)
					VALUES (${id}, ${event.sessionId}, ${tone}, ${kind}, ${summary}, ${payloadJson}, ${event.sequence}, ${event.createdAt})`;
			};

			if (isEventType(event, "tool.started")) {
				yield* insert("tool", "tool.started", event.data.toolName, event.data);
				return;
			}
			if (isEventType(event, "tool.running")) {
				yield* insert("tool", "tool.running", event.data.partId, event.data);
				return;
			}
			if (isEventType(event, "tool.completed")) {
				const summary = `${event.data.partId} (${event.data.duration}ms)`;
				yield* insert("tool", "tool.completed", summary, event.data);
				return;
			}
			if (isEventType(event, "permission.asked")) {
				yield* insert(
					"approval",
					"permission.asked",
					event.data.toolName,
					event.data,
				);
				return;
			}
			if (isEventType(event, "permission.resolved")) {
				yield* insert(
					"approval",
					"permission.resolved",
					event.data.decision,
					event.data,
				);
				return;
			}
			if (isEventType(event, "question.asked")) {
				yield* insert("info", "question.asked", "Question asked", event.data);
				return;
			}
			if (isEventType(event, "question.resolved")) {
				yield* insert(
					"info",
					"question.resolved",
					"Question answered",
					event.data,
				);
				return;
			}
			if (isEventType(event, "turn.error")) {
				yield* insert("error", "turn.error", event.data.error, event.data);
				return;
			}
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
	project: (event: StoredEvent) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "permission.asked")) {
				const inputJson = encodeJson(event.data.input);
				yield* sql`
					INSERT INTO pending_approvals
					(id, session_id, type, status, tool_name, input, created_at)
					VALUES (${event.data.id}, ${event.data.sessionId}, 'permission', 'pending', ${event.data.toolName}, ${inputJson}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				return;
			}

			if (isEventType(event, "permission.resolved")) {
				yield* sql`
					UPDATE pending_approvals
					SET status = 'resolved', decision = ${event.data.decision}, resolved_at = ${event.createdAt}
					WHERE id = ${event.data.id}`;
				return;
			}

			if (isEventType(event, "question.asked")) {
				const questionsJson = encodeJson(event.data.questions);
				yield* sql`
					INSERT INTO pending_approvals
					(id, session_id, type, status, input, created_at)
					VALUES (${event.data.id}, ${event.data.sessionId}, 'question', 'pending', ${questionsJson}, ${event.createdAt})
					ON CONFLICT (id) DO NOTHING`;
				return;
			}

			if (isEventType(event, "question.resolved")) {
				const answersJson = encodeJson(event.data.answers);
				yield* sql`
					UPDATE pending_approvals
					SET status = 'resolved', decision = ${answersJson}, resolved_at = ${event.createdAt}
					WHERE id = ${event.data.id}`;
				return;
			}
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
		),
});

// ─── Provider Projector ─────────────────────────────────────────────────────

export const makeProviderProjector = (): EffectProjector => ({
	name: "provider",
	handles: ["session.created", "session.provider_changed"],
	project: (event: StoredEvent) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			if (isEventType(event, "session.created")) {
				yield* sql`
					INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
					VALUES (${`${event.data.sessionId}:initial`}, ${event.data.sessionId}, ${event.data.provider}, 'active', ${event.createdAt})`;
				return;
			}

			if (isEventType(event, "session.provider_changed")) {
				yield* sql`
					UPDATE session_providers
					SET status = 'stopped', deactivated_at = ${event.createdAt}
					WHERE session_id = ${event.data.sessionId} AND status = 'active'`;

				yield* sql`
					INSERT OR IGNORE INTO session_providers (id, session_id, provider, status, activated_at)
					VALUES (${`${event.data.sessionId}:${event.sequence}`}, ${event.data.sessionId}, ${event.data.newProvider}, 'active', ${event.createdAt})`;
				return;
			}
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
