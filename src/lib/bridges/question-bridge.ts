// ─── Question / Ask-User Bridge ──────────────────────────────────────────────

import type { AskUserQuestion } from "../types.js";

/**
 * Map OpenCode question format (with `multiple` field) to frontend format (with `multiSelect` field).
 */
export function mapQuestionFields(
	ocQuestions: Array<{
		question?: string;
		header?: string;
		options?: Array<{ label?: string; description?: string }>;
		multiple?: boolean;
		custom?: boolean;
	}>,
): AskUserQuestion[] {
	return ocQuestions.map((q) => ({
		question: q.question ?? "",
		header: q.header ?? "",
		options: (q.options ?? []).map((o) => ({
			label: o.label ?? "",
			description: o.description ?? "",
		})),
		multiSelect: q.multiple ?? false,
		custom: q.custom ?? true,
	}));
}

// ─── Pending Question Type ──────────────────────────────────────────────────

export interface PendingQuestion {
	requestId: string;
	sessionId: string;
	questions: Array<{
		question: string;
		header?: string;
		options?: unknown[];
		multiSelect?: boolean;
	}>;
	toolCallId?: string;
	timestamp: number;
}

// ─── Question Bridge ────────────────────────────────────────────────────────

/**
 * Tracks pending questions for Claude sessions so they can be replayed when
 * the user switches sessions and comes back. Mirrors the PermissionBridge
 * pattern used for permission replay.
 */
export class QuestionBridge {
	private pending = new Map<string, PendingQuestion>();

	/** Register a pending question (used by Claude SDK path via RelayEventSink). */
	trackPending(entry: PendingQuestion): void {
		this.pending.set(entry.requestId, entry);
	}

	/** Clean up the bridge entry when a question is resolved. Returns true if found. */
	onResolved(requestId: string): boolean {
		return this.pending.delete(requestId);
	}

	/** Get all pending questions (for replay on reconnect / session switch). */
	getPending(): PendingQuestion[] {
		return Array.from(this.pending.values());
	}

	/** Number of pending questions. */
	get size(): number {
		return this.pending.size;
	}
}
