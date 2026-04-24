// src/lib/provider/claude/effect-prompt-queue.ts
/**
 * EffectPromptQueue -- Drop-in replacement for PromptQueue backed by an
 * Effect Queue.
 *
 * The Claude Agent SDK's `query()` function requires an
 * `AsyncIterable<SDKUserMessage>`. Effect's Queue is NOT AsyncIterable,
 * so this bridge adapts between the two worlds:
 *
 * - Internally uses `Effect.Queue.unbounded<SDKUserMessage>()` for the
 *   buffer and blocking take semantics.
 * - Exposes the same `PromptQueueController` interface (`enqueue`, `close`,
 *   `Symbol.asyncIterator`) so the rest of the adapter is unchanged.
 * - Single-consumer guard: throws if iterated more than once, matching the
 *   original PromptQueue contract.
 *
 * Drain-before-close semantics:
 * Effect's `Queue.shutdown` discards all buffered items and interrupts
 * pending takes. The original PromptQueue drains buffered items first,
 * then signals end-of-stream. To preserve this contract:
 * - `close()` snapshots any remaining Effect Queue items into a local
 *   drain buffer, then shuts down the Effect Queue.
 * - `next()` serves from the drain buffer first, falling back to the
 *   Effect Queue for blocking takes while still open.
 */
import { Chunk, Effect, Exit, Queue } from "effect";

import type { PromptQueueController, SDKUserMessage } from "./types.js";

export class EffectPromptQueue
	implements PromptQueueController, AsyncIterator<SDKUserMessage>
{
	private readonly queue: Queue.Queue<SDKUserMessage>;
	private _iterating = false;
	private _closed = false;
	/** Items drained from the Effect Queue at close time, served first. */
	private readonly drainBuffer: SDKUserMessage[] = [];

	private constructor(queue: Queue.Queue<SDKUserMessage>) {
		this.queue = queue;
	}

	/**
	 * Create a new EffectPromptQueue backed by an Effect unbounded Queue.
	 */
	static create(): EffectPromptQueue {
		const queue = Effect.runSync(Queue.unbounded<SDKUserMessage>());
		return new EffectPromptQueue(queue);
	}

	enqueue(message: SDKUserMessage): void {
		if (this._closed) return;
		Effect.runSync(Queue.offer(this.queue, message));
	}

	close(): void {
		if (this._closed) return;
		this._closed = true;
		// Snapshot remaining items before shutdown discards them.
		const exit = Effect.runSyncExit(Queue.takeAll(this.queue));
		if (Exit.isSuccess(exit)) {
			this.drainBuffer.push(...Chunk.toArray(exit.value));
		}
		Effect.runSync(Queue.shutdown(this.queue));
	}

	async next(): Promise<IteratorResult<SDKUserMessage>> {
		// 1. Serve from the drain buffer (populated by close()).
		const buffered = this.drainBuffer.shift();
		if (buffered !== undefined) {
			return { value: buffered, done: false };
		}
		// 2. If already closed and drain buffer is empty, we are done.
		if (this._closed) {
			return {
				value: undefined as unknown as SDKUserMessage,
				done: true,
			};
		}
		// 3. Block on the Effect Queue for the next item.
		const exit = await Effect.runPromiseExit(Queue.take(this.queue));
		if (Exit.isFailure(exit)) {
			// Queue was shut down while we were waiting -- signal end-of-stream.
			return {
				value: undefined as unknown as SDKUserMessage,
				done: true,
			};
		}
		return { value: exit.value, done: false };
	}

	async return(): Promise<IteratorResult<SDKUserMessage>> {
		this.close();
		return { value: undefined as unknown as SDKUserMessage, done: true };
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		if (this._iterating) {
			throw new Error(
				"EffectPromptQueue is single-consumer. Cannot iterate more than once.",
			);
		}
		this._iterating = true;
		return this;
	}
}
