// src/lib/persistence/read-query-service.ts
// ─── ReadQueryService ───────────────────────────────────────────────────────
// Centralized SQLite read layer for Phase 4 read switchover.
// Each sub-phase adds query methods here. All methods are synchronous
// (SQLite is blocking) and return plain objects — no ORM, no async.

import { PersistenceError } from "./errors.js";
import type { SqliteClient } from "./sqlite-client.js";

// ─── Row types (match projection table schemas) ─────────────────────────────

export interface SessionRow {
	id: string;
	provider: string;
	provider_sid: string | null;
	title: string;
	status: string;
	parent_id: string | null;
	fork_point_event: string | null;
	last_message_at: number | null;
	created_at: number;
	updated_at: number;
}

export interface MessageRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	role: string;
	text: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	tokens_cache_read: number | null;
	tokens_cache_write: number | null;
	is_streaming: number;
	created_at: number;
	updated_at: number;
}

/** (P1) Normalized message part row from the message_parts table. */
export interface MessagePartRow {
	id: string;
	message_id: string;
	type: string;
	text: string;
	tool_name: string | null;
	call_id: string | null;
	input: string | null;
	result: string | null;
	duration: number | null;
	status: string | null;
	sort_order: number;
	created_at: number;
	updated_at: number;
}

/** Message with its parts pre-loaded (for batch queries). */
export interface MessageWithParts extends MessageRow {
	parts: MessagePartRow[];
}

export interface TurnRow {
	id: string;
	session_id: string;
	state: string;
	user_message_id: string | null;
	assistant_message_id: string | null;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	requested_at: number;
	started_at: number | null;
	completed_at: number | null;
}

export interface PendingApprovalRow {
	id: string;
	session_id: string;
	turn_id: string | null;
	type: string;
	status: string;
	tool_name: string | null;
	input: string | null;
	decision: string | null;
	created_at: number;
	resolved_at: number | null;
}

export interface ForkMetadata {
	parentId: string;
	forkPointEvent: string | null;
}

// ─── Service ────────────────────────────────────────────────────────────────

export class ReadQueryService {
	constructor(private readonly db: SqliteClient) {}

	// (B1) Every public method wraps its query in a try/catch that throws
	// PersistenceError with code PROJECTION_FAILED, including the method
	// name, parameters, and the raw SQLite error. This gives LLMs enough
	// context to diagnose read-path failures from logs alone.

	// ── 4a: Tool content ──────────────────────────────────────────────────

	/** Retrieve full tool content by tool ID. Returns undefined if not found. */
	getToolContent(toolId: string): string | undefined {
		try {
			const row = this.db.queryOne<{ content: string }>(
				"SELECT content FROM tool_content WHERE tool_id = ?",
				[toolId],
			);
			return row?.content;
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getToolContent failed",
				{
					method: "getToolContent",
					toolId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	/** Get fork metadata for a session. Returns undefined if not a fork. */
	getForkMetadata(sessionId: string): ForkMetadata | undefined {
		try {
			const row = this.db.queryOne<{
				parent_id: string | null;
				fork_point_event: string | null;
			}>("SELECT parent_id, fork_point_event FROM sessions WHERE id = ?", [
				sessionId,
			]);
			if (!row || !row.parent_id) return undefined;
			return {
				parentId: row.parent_id,
				forkPointEvent: row.fork_point_event,
			};
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getForkMetadata failed",
				{
					method: "getForkMetadata",
					sessionId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── 4c: Session list ──────────────────────────────────────────────────

	/**
	 * List sessions, optionally filtering to roots only (no parent).
	 * (P8) last_message_at is denormalized on the sessions table by
	 * SessionProjector, so no correlated subquery is needed.
	 */
	listSessions(opts?: { roots?: boolean }): SessionRow[] {
		try {
			if (opts?.roots) {
				return this.db.query<SessionRow>(
					"SELECT * FROM sessions WHERE parent_id IS NULL ORDER BY updated_at DESC",
				);
			}
			return this.db.query<SessionRow>(
				"SELECT * FROM sessions ORDER BY updated_at DESC",
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.listSessions failed",
				{
					method: "listSessions",
					opts,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── 4d: Session status ────────────────────────────────────────────────

	/** Get the status of a single session. */
	getSessionStatus(sessionId: string): string | undefined {
		try {
			const row = this.db.queryOne<{ status: string }>(
				"SELECT status FROM sessions WHERE id = ?",
				[sessionId],
			);
			return row?.status;
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getSessionStatus failed",
				{
					method: "getSessionStatus",
					sessionId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	/** Get status for all sessions as a map. */
	getAllSessionStatuses(): Record<string, string> {
		try {
			const rows = this.db.query<{ id: string; status: string }>(
				"SELECT id, status FROM sessions",
			);
			const result: Record<string, string> = {};
			for (const row of rows) {
				result[row.id] = row.status;
			}
			return result;
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getAllSessionStatuses failed",
				{
					method: "getAllSessionStatuses",
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── 4e: Session messages and turns ────────────────────────────────────

	/**
	 * Get messages for a session, ordered by created_at ASC (chronological).
	 *
	 * > **Amendment (2026-04-07 — Perf-Fix-6): Composite Cursor Pagination.**
	 * > Replaced `beforeMessageId` parameter (which required a lookup query)
	 * > with explicit `beforeCreatedAt` / `beforeId` cursor fields. Uses
	 * > OR-expanded form since SQLite doesn't optimize tuple comparison.
	 * > Over-fetches by 1 (I7) for `hasMore` detection. Wraps in ASC subquery
	 * > for consistent caller interface.
	 * > See `docs/plans/2026-04-07-orchestrator-performance-fixes.md` Task 6.
	 *
	 * Supports pagination:
	 * - `limit`: max messages to return. When set without cursor fields,
	 *   returns the *latest* N messages (useful for initial page load).
	 * - `beforeCreatedAt` + `beforeId`: composite cursor-based pagination —
	 *   returns messages before this (created_at, id) pair.
	 */
	getSessionMessages(
		sessionId: string,
		opts?: {
			limit?: number;
			/** Cursor: return messages before this (created_at, id) pair */
			beforeCreatedAt?: number;
			beforeId?: string;
		},
	): MessageRow[] {
		try {
			// (Perf-Fix-6) Composite (created_at, id) cursor. Uses OR-expanded form
			// since SQLite doesn't optimize tuple comparison. Over-fetches by 1 (I7)
			// for hasMore detection. Wraps in ASC subquery for consistent caller interface.
			if (opts?.beforeCreatedAt != null && opts?.beforeId != null) {
				const limit = opts.limit ?? 50;
				return this.db.query<MessageRow>(
					`SELECT * FROM (
						SELECT * FROM messages
						WHERE session_id = ?
						  AND (created_at < ? OR (created_at = ? AND id < ?))
						ORDER BY created_at DESC, id DESC
						LIMIT ?
					) sub ORDER BY created_at ASC, id ASC`,
					[
						sessionId,
						opts.beforeCreatedAt,
						opts.beforeCreatedAt,
						opts.beforeId,
						limit + 1,
					],
				);
			}

			if (opts?.limit) {
				// (Perf-Fix-6) Latest N messages (first page). Over-fetch by 1 for hasMore detection (I7).
				// Callers should check rows.length > limit to detect pagination,
				// then slice to limit before rendering.
				return this.db.query<MessageRow>(
					`SELECT * FROM (
						SELECT * FROM messages
						WHERE session_id = ?
						ORDER BY created_at DESC, id DESC
						LIMIT ?
					) sub ORDER BY created_at ASC, id ASC`,
					[sessionId, opts.limit + 1],
				);
			}

			// All messages
			return this.db.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
				[sessionId],
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getSessionMessages failed",
				{
					method: "getSessionMessages",
					sessionId,
					opts,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	/** Get all turns for a session, ordered by requested_at ASC. */
	getSessionTurns(sessionId: string): TurnRow[] {
		try {
			return this.db.query<TurnRow>(
				"SELECT * FROM turns WHERE session_id = ? ORDER BY requested_at ASC",
				[sessionId],
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getSessionTurns failed",
				{
					method: "getSessionTurns",
					sessionId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	/** Get all pending approvals across all sessions. */
	getPendingApprovals(): PendingApprovalRow[] {
		try {
			return this.db.query<PendingApprovalRow>(
				"SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY created_at ASC",
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getPendingApprovals failed",
				{
					method: "getPendingApprovals",
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	/** Get pending approvals for a specific session. */
	getPendingApprovalsForSession(sessionId: string): PendingApprovalRow[] {
		try {
			return this.db.query<PendingApprovalRow>(
				"SELECT * FROM pending_approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC",
				[sessionId],
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getPendingApprovalsForSession failed",
				{
					method: "getPendingApprovalsForSession",
					sessionId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	// ── Message parts (P1 normalized table) ───────────────────────────────

	/** (P1) Get all parts for a message, ordered by sort_order. */
	getMessageParts(messageId: string): MessagePartRow[] {
		try {
			return this.db.query<MessagePartRow>(
				"SELECT * FROM message_parts WHERE message_id = ? ORDER BY sort_order",
				[messageId],
			);
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getMessageParts failed",
				{
					method: "getMessageParts",
					messageId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}

	/**
	 * (P1) Get messages with parts for a session, batch-loaded in one query.
	 * Returns messages ordered by created_at ASC with parts pre-loaded
	 * via a single indexed scan on `idx_message_parts_message`.
	 *
	 * (S10b) Uses CTE + JOIN instead of IN clause to avoid
	 * SQLITE_MAX_VARIABLE_NUMBER limit and improve query planner behavior.
	 */
	getSessionMessagesWithParts(sessionId: string): MessageWithParts[] {
		try {
			const messages = this.db.query<MessageRow>(
				"SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC",
				[sessionId],
			);
			if (messages.length === 0) return [];

			// (S10b) CTE + JOIN approach avoids SQLITE_MAX_VARIABLE_NUMBER limit
			// and lets SQLite use idx_message_parts_message via nested-loop join.
			const parts = this.db.query<MessagePartRow>(
				`WITH target_messages AS (
					SELECT id FROM messages WHERE session_id = ? ORDER BY created_at
				)
				SELECT mp.* FROM message_parts mp
				JOIN target_messages tm ON mp.message_id = tm.id
				ORDER BY mp.message_id, mp.sort_order`,
				[sessionId],
			);

			// Group parts by message_id
			const partsByMessage = new Map<string, MessagePartRow[]>();
			for (const part of parts) {
				let arr = partsByMessage.get(part.message_id);
				if (!arr) {
					arr = [];
					partsByMessage.set(part.message_id, arr);
				}
				arr.push(part);
			}

			return messages.map((m) => ({
				...m,
				parts: partsByMessage.get(m.id) ?? [],
			}));
		} catch (err) {
			throw new PersistenceError(
				"PROJECTION_FAILED",
				"ReadQueryService.getSessionMessagesWithParts failed",
				{
					method: "getSessionMessagesWithParts",
					sessionId,
					sqliteError: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}
}
