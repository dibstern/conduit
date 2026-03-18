// ─── ToolContentStore ────────────────────────────────────────────────────────
// In-memory store for full tool result content (before truncation).
// Keyed by tool ID, with optional session-based grouping for bulk cleanup.
// Evicts oldest entries when over capacity.

interface Entry {
	toolId: string;
	content: string;
	sessionId?: string;
	/** Monotonic insertion order for eviction. */
	order: number;
}

export class ToolContentStore {
	private readonly entries = new Map<string, Entry>();
	private readonly maxEntries: number;
	private orderCounter = 0;

	constructor(maxEntries = 500) {
		this.maxEntries = maxEntries;
	}

	/** Store full content for a tool ID, optionally associated with a session. */
	store(toolId: string, content: string, sessionId?: string): void {
		// If overwriting, remove old entry first (don't double-count)
		this.entries.delete(toolId);

		this.entries.set(toolId, {
			toolId,
			content,
			...(sessionId != null && { sessionId }),
			order: this.orderCounter++,
		});

		// Evict oldest if over capacity
		while (this.entries.size > this.maxEntries) {
			this.evictOldest();
		}
	}

	/** Retrieve stored content by tool ID. */
	get(toolId: string): string | undefined {
		return this.entries.get(toolId)?.content;
	}

	/** Remove all entries associated with a session. */
	clearSession(sessionId: string): void {
		for (const [toolId, entry] of this.entries) {
			if (entry.sessionId === sessionId) {
				this.entries.delete(toolId);
			}
		}
	}

	/** Number of stored entries. */
	get size(): number {
		return this.entries.size;
	}

	/** Evict the entry with the lowest order (oldest). */
	private evictOldest(): void {
		let oldestKey: string | undefined;
		let oldestOrder = Number.POSITIVE_INFINITY;

		for (const [key, entry] of this.entries) {
			if (entry.order < oldestOrder) {
				oldestOrder = entry.order;
				oldestKey = key;
			}
		}

		if (oldestKey !== undefined) {
			this.entries.delete(oldestKey);
		}
	}
}
