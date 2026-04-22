// src/lib/provider/claude/prompt-queue.ts
/**
 * PromptQueue bridges synchronous enqueue() calls to an AsyncIterable that
 * the Claude Agent SDK's `query()` function consumes for user messages.
 *
 * Design notes:
 * - Single-consumer: `query()` is the only consumer. Symbol.asyncIterator
 *   returns `this`, so re-iteration is not supported. A guard prevents
 *   multiple concurrent consumers from silently losing messages.
 * - FIFO buffer: messages enqueued before the consumer starts are queued
 *   and delivered in order.
 * - Future-based wake: when the buffer is empty, `next()` returns a promise
 *   that is resolved by the next enqueue() or close() call.
 * - Close semantics: once closed, any buffered messages still drain; then
 *   the iterator yields `{ done: true }`. Further enqueue() calls are no-ops.
 */
import type { PromptQueueController, SDKUserMessage } from "./types.js";

type PendingResolver = (result: IteratorResult<SDKUserMessage>) => void;

export class PromptQueue
	implements PromptQueueController, AsyncIterator<SDKUserMessage>
{
	private readonly buffer: SDKUserMessage[] = [];
	private readonly waiters: PendingResolver[] = [];
	private closed = false;
	private _iterating = false;

	enqueue(message: SDKUserMessage): void {
		if (this.closed) return;
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value: message, done: false });
			return;
		}
		this.buffer.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// Flush any awaiting consumers with end-of-stream.
		while (this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			waiter?.({ value: undefined as unknown as SDKUserMessage, done: true });
		}
	}

	async next(): Promise<IteratorResult<SDKUserMessage>> {
		const buffered = this.buffer.shift();
		if (buffered !== undefined) {
			return { value: buffered, done: false };
		}
		if (this.closed) {
			return {
				value: undefined as unknown as SDKUserMessage,
				done: true,
			};
		}
		return new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
			this.waiters.push(resolve);
		});
	}

	async return(): Promise<IteratorResult<SDKUserMessage>> {
		this.close();
		return { value: undefined as unknown as SDKUserMessage, done: true };
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		if (this._iterating) {
			throw new Error(
				"PromptQueue is single-consumer. Cannot iterate more than once.",
			);
		}
		this._iterating = true;
		return this;
	}
}
