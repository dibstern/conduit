/**
 * Tracks timers, promises, and an AbortController for lifecycle management.
 * Used internally by TrackedService — not used directly by application code.
 */
export class AsyncTracker {
	private controller = new AbortController();
	private pending = new Set<Promise<unknown>>();
	private timers = new Set<ReturnType<typeof setInterval>>();
	private drained = false;

	/** AbortSignal that is aborted on drain(). Pass to fetch() etc. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	/** Number of pending tracked promises. Exposed for testing. */
	get pendingCount(): number {
		return this.pending.size;
	}

	/** Number of tracked timers. Exposed for testing. */
	get timerCount(): number {
		return this.timers.size;
	}

	/** Track a promise. It is removed from the set when it settles. */
	track<T>(promise: Promise<T>): Promise<T> {
		if (this.drained) throw new Error("Cannot track after drain");
		this.pending.add(promise);
		// Suppress unhandled rejection from the cleanup branch
		promise.finally(() => this.pending.delete(promise)).catch(() => {});
		return promise;
	}

	/** Create a tracked setInterval. Cleared automatically on drain(). */
	interval(fn: () => void, ms: number): ReturnType<typeof setInterval> {
		if (this.drained) throw new Error("Cannot track after drain");
		const id = setInterval(fn, ms);
		this.timers.add(id);
		return id;
	}

	/** Create a tracked setTimeout. Self-removes when it fires. Cleared on drain(). */
	timeout(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
		if (this.drained) throw new Error("Cannot track after drain");
		const id = setTimeout(() => {
			this.timers.delete(id);
			fn();
		}, ms);
		this.timers.add(id);
		return id;
	}

	/** Clear a specific timer (interval or timeout). */
	clearTimer(id: ReturnType<typeof setInterval>): void {
		clearInterval(id);
		clearTimeout(id);
		this.timers.delete(id);
	}

	/** Abort the signal, clear all timers, and await all pending promises. */
	async drain(): Promise<void> {
		this.drained = true;
		this.controller.abort();
		for (const id of this.timers) {
			clearInterval(id);
			clearTimeout(id);
		}
		this.timers.clear();
		await Promise.allSettled([...this.pending]);
		this.pending.clear();
	}
}
