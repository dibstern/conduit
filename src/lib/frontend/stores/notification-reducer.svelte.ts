// ─── Notification Reducer ──────────────────────────────────────────────────
// Pure reducer for cross-session notification indicator state.
// Replaces the scattered mutation functions in permissions.svelte.ts.
//
// Three patterns combined:
// 1. Discriminated union per-session state (structurally safe)
// 2. Typed reducer (single dispatch, exhaustive handling)
// 3. Server reconciliation (drift self-corrects on session list refresh)

// ─── Per-Session State (discriminated union) ────────────────────────────────

export type SessionNotifState =
	| { kind: "none" }
	| { kind: "attention"; questions: number; permissions: number }
	| { kind: "done-unviewed" };

// ─── State Map ──────────────────────────────────────────────────────────────

export type NotifMap = ReadonlyMap<string, SessionNotifState>;

// ─── Actions ────────────────────────────────────────────────────────────────

export type NotifAction =
	| { type: "question_appeared"; sessionId: string }
	| { type: "question_resolved"; sessionId: string }
	| { type: "permission_appeared"; sessionId: string }
	| { type: "permission_resolved"; sessionId: string }
	| { type: "session_done"; sessionId: string }
	| { type: "session_viewed"; sessionId: string }
	| {
			type: "reconcile";
			counts: ReadonlyMap<string, { questions: number; permissions: number }>;
	  }
	| { type: "reset" };

// ─── Reducer (pure function) ────────────────────────────────────────────────

function getAttention(
	state: NotifMap,
	sessionId: string,
): { questions: number; permissions: number } {
	const entry = state.get(sessionId);
	if (entry?.kind === "attention")
		return { questions: entry.questions, permissions: entry.permissions };
	return { questions: 0, permissions: 0 };
}

function setAttentionOrRemove(
	next: Map<string, SessionNotifState>,
	sessionId: string,
	q: number,
	p: number,
): void {
	if (q <= 0 && p <= 0) {
		next.delete(sessionId);
	} else {
		next.set(sessionId, {
			kind: "attention",
			questions: Math.max(0, q),
			permissions: Math.max(0, p),
		});
	}
}

export function reduce(state: NotifMap, action: NotifAction): NotifMap {
	switch (action.type) {
		case "question_appeared": {
			const { questions, permissions } = getAttention(state, action.sessionId);
			const next = new Map(state);
			next.set(action.sessionId, {
				kind: "attention",
				questions: questions + 1,
				permissions,
			});
			return next;
		}
		case "question_resolved": {
			// Force-evict all question counts (resolved is authoritative)
			const { permissions } = getAttention(state, action.sessionId);
			const next = new Map(state);
			setAttentionOrRemove(next, action.sessionId, 0, permissions);
			return next;
		}
		case "permission_appeared": {
			const { questions, permissions } = getAttention(state, action.sessionId);
			const next = new Map(state);
			next.set(action.sessionId, {
				kind: "attention",
				questions,
				permissions: permissions + 1,
			});
			return next;
		}
		case "permission_resolved": {
			const { questions, permissions } = getAttention(state, action.sessionId);
			const next = new Map(state);
			setAttentionOrRemove(
				next,
				action.sessionId,
				questions,
				Math.max(0, permissions - 1),
			);
			return next;
		}
		case "session_done": {
			// Done session can't have pending questions — evict attention, add done-unviewed
			const next = new Map(state);
			next.set(action.sessionId, { kind: "done-unviewed" });
			return next;
		}
		case "session_viewed": {
			// Clear all indicators for the viewed session
			const next = new Map(state);
			next.delete(action.sessionId);
			return next;
		}
		case "reconcile": {
			// Server truth overwrites attention states.
			// Preserve done-unviewed (client-local).
			const next = new Map<string, SessionNotifState>();
			// First, carry over done-unviewed entries
			for (const [sid, entry] of state) {
				if (entry.kind === "done-unviewed") {
					next.set(sid, entry);
				}
			}
			// Then apply server counts
			for (const [sid, counts] of action.counts) {
				if (counts.questions > 0 || counts.permissions > 0) {
					// Server says this session needs attention — overwrite even if done-unviewed
					next.set(sid, {
						kind: "attention",
						questions: counts.questions,
						permissions: counts.permissions,
					});
				}
			}
			return next;
		}
		case "reset": {
			return new Map();
		}
	}
	// TypeScript exhaustive check
	const _exhaustive: never = action;
	return state;
}

// ─── Svelte Store Integration ───────────────────────────────────────────────

const NONE: SessionNotifState = { kind: "none" } as const;

let _state = $state<NotifMap>(new Map());

/** Dispatch an action through the reducer. In dev mode, log all actions. */
export function dispatch(action: NotifAction): void {
	if (import.meta.env.DEV) {
		console.debug("[notif]", action.type, action);
	}
	_state = reduce(_state, action);
}

/** Get the current notification state for a session. */
export function getNotifState(sessionId: string): SessionNotifState {
	return _state.get(sessionId) ?? NONE;
}

/** Get session indicator for sidebar dot rendering. Returns null for current session. */
export function getSessionIndicator(
	sessionId: string,
	currentSessionId: string | null,
): "attention" | "done-unviewed" | null {
	if (sessionId === currentSessionId) return null;
	const entry = _state.get(sessionId);
	if (!entry || entry.kind === "none") return null;
	if (entry.kind === "attention") return "attention";
	if (entry.kind === "done-unviewed") return "done-unviewed";
	return null;
}

/** Get all sessions needing attention (for AttentionBanner). Excludes current session and descendants. */
export function getAttentionSessions(
	currentSessionId: string | null,
	getDescendantIds: (sid: string) => Set<string>,
): Map<string, { questions: number; permissions: number }> {
	const result = new Map<string, { questions: number; permissions: number }>();
	const descendants = currentSessionId
		? getDescendantIds(currentSessionId)
		: new Set<string>();
	for (const [sid, entry] of _state) {
		if (entry.kind !== "attention") continue;
		if (sid === currentSessionId || descendants.has(sid)) continue;
		result.set(sid, {
			questions: entry.questions,
			permissions: entry.permissions,
		});
	}
	return result;
}

/** Reset internal state (for testing). */
export function resetNotifState(): void {
	_state = new Map();
}
