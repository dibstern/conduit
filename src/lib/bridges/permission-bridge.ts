// ─── Permission Bridge (Ticket 1.5) ─────────────────────────────────────────

import type { SSEEvent } from "../relay/opencode-events.js";
import type { PermissionId } from "../shared-types.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	PendingPermission,
} from "../types.js";

// ─── Decision Mapping ───────────────────────────────────────────────────────

const DECISION_MAP: Record<FrontendDecision, OpenCodeDecision> = {
	allow: "once",
	deny: "reject",
	allow_always: "always",
};

const REVERSE_DECISION_MAP: Record<OpenCodeDecision, FrontendDecision> = {
	once: "allow",
	reject: "deny",
	always: "allow_always",
};

/** Map frontend decision vocabulary → OpenCode vocabulary */
export function mapDecision(frontend: string): OpenCodeDecision | null {
	return DECISION_MAP[frontend as FrontendDecision] ?? null;
}

/** Map OpenCode decision vocabulary → frontend vocabulary */
export function mapDecisionReverse(opencode: string): FrontendDecision | null {
	return REVERSE_DECISION_MAP[opencode as OpenCodeDecision] ?? null;
}

// ─── Permission Bridge ──────────────────────────────────────────────────────

export interface PermissionBridgeOptions {
	timeoutMs?: number;
	now?: () => number;
}

export class PermissionBridge {
	private pending: Map<string, PendingPermission> = new Map();
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(options: PermissionBridgeOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 5 * 60_000; // 5 minutes
		this.now = options.now ?? Date.now;
	}

	/** Process an incoming permission.asked SSE event */
	onPermissionRequest(event: SSEEvent): PendingPermission | null {
		const props = event.properties as {
			id?: string;
			sessionID?: string;
			permission?: string;
			patterns?: string[];
			metadata?: Record<string, unknown>;
			always?: string[];
		};

		if (!props.id || !props.permission) return null;

		const entry: PendingPermission = {
			requestId: props.id as PermissionId,
			sessionId: props.sessionID ?? "",
			toolName: props.permission,
			toolInput: {
				patterns: props.patterns ?? [],
				metadata: props.metadata ?? {},
			},
			always: props.always ?? [],
			timestamp: this.now(),
		};

		this.pending.set(props.id, entry);
		return entry;
	}

	/** Process a user's permission decision from the browser */
	onPermissionResponse(
		requestId: string,
		decision: string,
	): { mapped: OpenCodeDecision; toolName: string } | null {
		const entry = this.pending.get(requestId);
		if (!entry) return null; // Already resolved or unknown — ignore duplicate

		const mapped = mapDecision(decision);
		if (!mapped) return null;

		this.pending.delete(requestId);
		return { mapped, toolName: entry.toolName };
	}

	/** Handle a permission.replied SSE event (resolved from CLI) */
	onPermissionReplied(requestId: string): boolean {
		return this.pending.delete(requestId);
	}

	/** Register a pending permission directly (used by Claude SDK path). */
	trackPending(entry: PendingPermission): void {
		this.pending.set(entry.requestId, entry);
	}

	/** Get all pending permissions (for replay on reconnect) */
	getPending(): PendingPermission[] {
		return Array.from(this.pending.values());
	}

	/** Check for timed-out permissions and return their IDs with sessionIds */
	checkTimeouts(): Array<{ id: string; sessionId: string }> {
		const now = this.now();
		const timedOut: Array<{ id: string; sessionId: string }> = [];

		for (const [id, entry] of this.pending) {
			if (now - entry.timestamp >= this.timeoutMs) {
				timedOut.push({ id, sessionId: entry.sessionId });
				this.pending.delete(id);
			}
		}

		return timedOut;
	}

	/** Recover pending permissions from REST API response */
	recoverPending(
		permissions: Array<{
			id: string;
			permission: string;
			sessionId?: string;
			patterns?: string[];
			metadata?: Record<string, unknown>;
			always?: string[];
		}>,
	): PendingPermission[] {
		const recovered: PendingPermission[] = [];
		for (const p of permissions) {
			const entry: PendingPermission = {
				requestId: p.id as PermissionId,
				sessionId: p.sessionId ?? "",
				toolName: p.permission,
				toolInput: {
					patterns: p.patterns ?? [],
					metadata: p.metadata ?? {},
				},
				always: p.always ?? [],
				timestamp: this.now(),
			};
			this.pending.set(p.id, entry);
			recovered.push(entry);
		}
		return recovered;
	}

	/** Number of pending permissions */
	get size(): number {
		return this.pending.size;
	}
}
