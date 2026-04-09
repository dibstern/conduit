// src/lib/persistence/read-adapter.ts
// ─── ReadAdapter ────────────────────────────────────────────────────────────
// Adapter that routes read queries to SQLite or legacy based on ReadFlags.
// Used by Phase 4 handlers to implement the read switchover without
// modifying every individual handler's logic.
//
// When a flag is set to "sqlite" AND a ReadQueryService is available,
// the adapter returns data from SQLite. Otherwise it returns undefined,
// signalling that the caller should use the legacy source.

import type { ReadFlagMode, ReadFlags } from "./read-flags.js";
import { isSqlite } from "./read-flags.js";
import type {
	ForkMetadata,
	MessageRow,
	PendingApprovalRow,
	ReadQueryService,
	SessionRow,
} from "./read-query-service.js";

/**
 * Adapter that routes read queries to SQLite or legacy based on flags.
 *
 * Each method returns `undefined` when the flag is not "sqlite" or when
 * the ReadQueryService is not available. Callers use a simple pattern:
 *
 * ```ts
 * const sqliteResult = readAdapter.getToolContent(toolId);
 * if (sqliteResult !== undefined) return sqliteResult;
 * // fall through to legacy source
 * ```
 */
export class ReadAdapter {
	constructor(
		private readonly readQuery: ReadQueryService | undefined,
		private readonly readFlags: ReadFlags | undefined,
	) {}

	/** True when the adapter has both a query service and flags available. */
	get isConfigured(): boolean {
		return this.readQuery != null && this.readFlags != null;
	}

	/** Check if a specific flag is set to "sqlite". */
	isSqliteFor(flag: keyof ReadFlags): boolean {
		return isSqlite(this.readFlags?.[flag]);
	}

	/** Get the current mode for a flag. */
	getMode(flag: keyof ReadFlags): ReadFlagMode | undefined {
		return this.readFlags?.[flag];
	}

	// ── 4a: Tool content ──────────────────────────────────────────────────

	/** Get tool content from SQLite when toolContent flag is "sqlite". */
	getToolContent(toolId: string): string | undefined {
		if (!isSqlite(this.readFlags?.toolContent) || !this.readQuery)
			return undefined;
		return this.readQuery.getToolContent(toolId);
	}

	// ── 4b: Fork metadata ─────────────────────────────────────────────────

	/** Get fork metadata from SQLite when forkMetadata flag is "sqlite". */
	getForkMetadata(sessionId: string): ForkMetadata | undefined {
		if (!isSqlite(this.readFlags?.forkMetadata) || !this.readQuery)
			return undefined;
		return this.readQuery.getForkMetadata(sessionId);
	}

	// ── 4c: Session list ──────────────────────────────────────────────────

	/** List sessions from SQLite when sessionList flag is "sqlite". */
	listSessions(opts?: { roots?: boolean }): SessionRow[] | undefined {
		if (!isSqlite(this.readFlags?.sessionList) || !this.readQuery)
			return undefined;
		return this.readQuery.listSessions(opts);
	}

	// ── 4d: Session status ────────────────────────────────────────────────

	/** Get session status from SQLite when sessionStatus flag is "sqlite". */
	getSessionStatus(sessionId: string): string | undefined {
		if (!isSqlite(this.readFlags?.sessionStatus) || !this.readQuery)
			return undefined;
		return this.readQuery.getSessionStatus(sessionId);
	}

	/** Get all session statuses from SQLite when sessionStatus flag is "sqlite". */
	getAllSessionStatuses(): Record<string, string> | undefined {
		if (!isSqlite(this.readFlags?.sessionStatus) || !this.readQuery)
			return undefined;
		return this.readQuery.getAllSessionStatuses();
	}

	// ── 4e: Session history ───────────────────────────────────────────────

	/** Get session messages from SQLite when sessionHistory flag is "sqlite". */
	getSessionMessages(
		sessionId: string,
		opts?: Parameters<ReadQueryService["getSessionMessages"]>[1],
	): MessageRow[] | undefined {
		if (!isSqlite(this.readFlags?.sessionHistory) || !this.readQuery)
			return undefined;
		return this.readQuery.getSessionMessages(sessionId, opts);
	}

	// ── 4f: Pending approvals ─────────────────────────────────────────────

	/** Get pending approvals from SQLite when pendingApprovals flag is "sqlite". */
	getPendingApprovals(sessionId?: string): PendingApprovalRow[] | undefined {
		if (!isSqlite(this.readFlags?.pendingApprovals) || !this.readQuery)
			return undefined;
		if (sessionId)
			return this.readQuery.getPendingApprovalsForSession(sessionId);
		return this.readQuery.getPendingApprovals();
	}
}
