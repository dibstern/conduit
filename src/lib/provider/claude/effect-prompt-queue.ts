// src/lib/provider/claude/effect-prompt-queue.ts
/**
 * Effect-backed prompt queue for the Claude Agent SDK.
 *
 * The SDK consumes prompts as an AsyncIterable, while conduit produces prompts
 * from Effect programs. The queue keeps the producer side Effect-native and
 * leaves the Promise bridge at the SDK-facing AsyncIterator boundary.
 */
import { Effect, Queue, Stream } from "effect";

import type { PromptQueueController, SDKUserMessage } from "./types.js";

type PromptQueueItem =
	| { readonly _tag: "Message"; readonly message: SDKUserMessage }
	| { readonly _tag: "End" };

type PromptQueueMessage = Extract<
	PromptQueueItem,
	{ readonly _tag: "Message" }
>;

export class EffectPromptQueue implements PromptQueueController {
	private _iterating = false;
	private _closed = false;

	private constructor(
		private readonly queue: Queue.Queue<PromptQueueItem>,
		private readonly iterable: AsyncIterable<SDKUserMessage>,
	) {}

	static make(): Effect.Effect<EffectPromptQueue> {
		return Effect.gen(function* () {
			const queue = yield* Queue.unbounded<PromptQueueItem>();
			const iterable = yield* Stream.fromQueue(queue, { shutdown: true }).pipe(
				Stream.takeWhile(
					(item): item is PromptQueueMessage => item._tag === "Message",
				),
				Stream.map((item) => item.message),
				Stream.toAsyncIterableEffect,
			);
			return new EffectPromptQueue(queue, iterable);
		});
	}

	enqueue(message: SDKUserMessage): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this._closed) return Effect.void;
			return Queue.offer(this.queue, {
				_tag: "Message",
				message,
			}).pipe(Effect.asVoid);
		});
	}

	close(): Effect.Effect<void> {
		return Effect.suspend(() => {
			if (this._closed) return Effect.void;
			this._closed = true;
			return Queue.offer(this.queue, { _tag: "End" }).pipe(Effect.asVoid);
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		if (this._iterating) {
			throw new Error(
				"EffectPromptQueue is single-consumer. Cannot iterate more than once.",
			);
		}
		this._iterating = true;

		const iterator = this.iterable[Symbol.asyncIterator]();
		return {
			next: () => iterator.next(),
			return: async () => {
				this._closed = true;
				return iterator.return
					? iterator.return()
					: { value: undefined as unknown as SDKUserMessage, done: true };
			},
		};
	}
}

export const makeEffectPromptQueue = (): Effect.Effect<EffectPromptQueue> =>
	EffectPromptQueue.make();
