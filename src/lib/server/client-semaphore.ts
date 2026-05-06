// ─── Per-Client Semaphore Serialization ──────────────────────────────────────
// Serializes message handling per-client using Effect Semaphore(1) while
// allowing different clients to process in parallel.
// Replaces the promise-chain-based ClientMessageQueue.

import { Effect } from "effect";

type Semaphore = Effect.Semaphore;

const clientSemaphores = new Map<string, Semaphore>();

/** Get or create a Semaphore(1) for the given client. */
export function getClientSemaphore(clientId: string): Semaphore {
	let sem = clientSemaphores.get(clientId);
	if (!sem) {
		sem = Effect.unsafeMakeSemaphore(1);
		clientSemaphores.set(clientId, sem);
	}
	return sem;
}

/** Remove a client's semaphore (e.g., on disconnect). */
export function removeClient(clientId: string): void {
	clientSemaphores.delete(clientId);
}

/** Number of clients with active semaphores. */
export function activeClients(): number {
	return clientSemaphores.size;
}

/**
 * Get queue depth for a client.
 * Binary: 0 (idle or unknown) — semaphores don't expose internal wait counts,
 * so this returns 0 for unknown clients and 0 for known ones.
 * The presence check via activeClients() is the primary observability tool.
 */
export function getQueueDepth(clientId: string): number {
	return clientSemaphores.has(clientId) ? 0 : 0;
}
