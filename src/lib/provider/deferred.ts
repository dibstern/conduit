// src/lib/provider/deferred.ts
// ─── Shared Deferred Utility ────────────────────────────────────────────────
// A Promise wrapper that exposes resolve/reject for external settlement.
// Used by adapters and EventSink to bridge callback-based and Promise-based
// control flow (e.g., SSE turn completion, permission requests).

export interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (reason: Error) => void;
}

export function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}
