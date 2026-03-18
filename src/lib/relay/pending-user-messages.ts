// ─── Pending User Messages Tracker ───────────────────────────────────────────
// Tracks user messages recently sent by the relay (from the web frontend) so
// that SSE echoes and REST poller duplicates can be suppressed.
//
// When a user sends a message via the web UI, the frontend immediately adds it
// to the chat. OpenCode then fires a `message.created` SSE event for the same
// message (designed for TUI-originated messages), which the translator converts
// to a `user_message` relay event. Without suppression, this creates a
// duplicate in the frontend chat.
//
// Usage:
//   1. prompt.ts calls `record(sessionId, text)` when sending a message
//   2. sse-wiring.ts / relay-stack.ts calls `consume(sessionId, text)` when a
//      `user_message` event arrives — returns true if it was relay-originated
//      (and should be suppressed), false if it came from TUI/CLI

/** How long to keep pending entries before auto-expiring (ms). */
const PENDING_TTL_MS = 30_000;

/** Maximum entries before FIFO eviction (safety cap). */
const MAX_ENTRIES = 100;

interface PendingEntry {
	text: string;
	sessionId: string;
	createdAt: number;
}

export class PendingUserMessages {
	private readonly entries: PendingEntry[] = [];

	/**
	 * Record a user message that was just sent by the relay.
	 * Call this from the prompt handler before sending to OpenCode.
	 */
	record(sessionId: string, text: string): void {
		this.entries.push({ sessionId, text, createdAt: Date.now() });

		// FIFO eviction if we hit the cap
		while (this.entries.length > MAX_ENTRIES) {
			this.entries.shift();
		}
	}

	/**
	 * Check if a `user_message` event matches a pending relay-originated
	 * message. If it does, consume (remove) it and return `true` — the
	 * caller should suppress the event. If not, return `false` — the
	 * message came from TUI/CLI and should be processed normally.
	 */
	consume(sessionId: string, text: string): boolean {
		this.evictExpired();

		const idx = this.entries.findIndex(
			(e) => e.sessionId === sessionId && e.text === text,
		);
		if (idx >= 0) {
			this.entries.splice(idx, 1);
			return true;
		}
		return false;
	}

	/** Remove expired entries. */
	private evictExpired(): void {
		const now = Date.now();
		while (
			this.entries.length > 0 &&
			// biome-ignore lint/style/noNonNullAssertion: length > 0 guarantees entry exists
			now - this.entries[0]!.createdAt > PENDING_TTL_MS
		) {
			this.entries.shift();
		}
	}

	/** Number of tracked entries (for testing). */
	get size(): number {
		this.evictExpired();
		return this.entries.length;
	}
}
