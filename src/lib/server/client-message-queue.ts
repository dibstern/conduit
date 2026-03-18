// ─── Per-Client Message Queue ────────────────────────────────────────────────
// Serializes message handling per-client while allowing different clients to
// process in parallel. Replaces the global _messageQueue in relay-stack.ts.

export interface ClientMessageQueueOptions {
	/** Called when a handler throws. The queue continues processing. */
	onError?: (clientId: string, error: unknown) => void;
}

export class ClientMessageQueue {
	private queues = new Map<string, Promise<void>>();
	private readonly onError:
		| ((clientId: string, error: unknown) => void)
		| undefined;

	constructor(options?: ClientMessageQueueOptions) {
		this.onError = options?.onError;
	}

	/**
	 * Enqueue a handler for a specific client.
	 * Handlers for the same client run sequentially.
	 * Handlers for different clients run in parallel.
	 */
	enqueue(clientId: string, handler: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(clientId) ?? Promise.resolve();
		const next = previous.then(async () => {
			try {
				await handler();
			} catch (err) {
				this.onError?.(clientId, err);
			}
		});
		this.queues.set(clientId, next);

		// Clean up the map entry when the queue drains
		next.then(() => {
			if (this.queues.get(clientId) === next) {
				this.queues.delete(clientId);
			}
		});

		return next;
	}

	/** Remove a client's queue (e.g., on disconnect). */
	removeClient(clientId: string): void {
		this.queues.delete(clientId);
	}

	/** Number of clients with active queues. */
	get activeClients(): number {
		return this.queues.size;
	}

	/** Get pending items in a client's queue (0 = idle or not tracked). */
	getQueueDepth(clientId: string): number {
		return this.queues.has(clientId) ? 1 : 0;
	}
}
