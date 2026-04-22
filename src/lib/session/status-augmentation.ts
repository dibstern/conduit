import type { SessionStatus } from "../instance/sdk-types.js";

export interface AugmentInput {
	readonly raw: Record<string, SessionStatus>;
	readonly parentMap: ReadonlyMap<string, string>;
	readonly childToParentResolved: ReadonlyMap<string, string | undefined>;
	readonly messageActivityTimestamps: ReadonlyMap<string, number>;
	readonly sseIdleSessions: ReadonlySet<string>;
	readonly now: number;
	readonly messageActivityTtlMs: number;
}

export interface AugmentResult {
	readonly augmented: Record<string, SessionStatus>;
	readonly expiredActivitySessions: readonly string[];
	readonly sseIdleToRemove: readonly string[];
}

/**
 * Pure computation: augments raw session statuses with subagent propagation,
 * message-activity injection, and SSE-idle clearing.
 *
 * Returns the augmented statuses plus lists of side-effects to apply
 * (expired activity sessions to delete, sseIdle entries to remove).
 */
export function computeAugmentedStatuses(input: AugmentInput): AugmentResult {
	const augmented = { ...input.raw };
	const expiredActivitySessions: string[] = [];
	const sseIdleToRemove: string[] = [];

	// ── Step 1: Identify busy sessions and clear sseIdle ──────────────────
	const busyIds: string[] = [];
	for (const [id, status] of Object.entries(input.raw)) {
		if (status.type === "busy" || status.type === "retry") {
			busyIds.push(id);
		}
	}

	for (const busyId of busyIds) {
		if (input.sseIdleSessions.has(busyId)) {
			sseIdleToRemove.push(busyId);
		}
	}

	// ── Step 2: Subagent propagation ──────────────────────────────────────
	// A parent waiting for a busy subagent IS busy, even if OpenCode's raw
	// /session/status reports it as "idle".  Override idle parents but don't
	// downgrade parents that are already in a processing state (busy/retry).
	for (const busyId of busyIds) {
		// Fast path: session list parentMap
		let parentId = input.parentMap.get(busyId);

		// Slow path: resolved cache
		if (parentId === undefined) {
			parentId = input.childToParentResolved.get(busyId) ?? undefined;
		}

		if (!parentId) continue;
		const existing = augmented[parentId];
		if (!existing || existing.type === "idle") {
			augmented[parentId] = { type: "busy" };
		}
	}

	// ── Step 3: Message activity injection (time-decay) ──────────────────
	for (const [sessionId, timestamp] of input.messageActivityTimestamps) {
		if (input.now - timestamp > input.messageActivityTtlMs) {
			expiredActivitySessions.push(sessionId);
		} else if (!augmented[sessionId]) {
			augmented[sessionId] = { type: "busy" };
		}
	}

	return { augmented, expiredActivitySessions, sseIdleToRemove };
}
