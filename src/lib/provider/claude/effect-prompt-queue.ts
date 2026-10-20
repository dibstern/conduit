// src/lib/provider/claude/effect-prompt-queue.ts
/**
 * Effect-backed prompt queue for the Claude Agent SDK.
 *
 * The SDK consumes prompts as an AsyncIterable, while conduit produces prompts
 * from Effect programs. The queue keeps the producer side Effect-native and
 * leaves the Promise bridge at the SDK-facing AsyncIterator boundary.
 */
import { Data, Effect, Queue, Stream } from "effect";

import type { PromptQueueController, SDKUserMessage } from "./types.js";

type PromptQueueItem =
	| {
			readonly _tag: "Message";
			readonly message: SDKUserMessage;
			readonly signal: AbortSignal | undefined;
			recalled: boolean;
			handed: boolean;
	  }
	| { readonly _tag: "End" };

type PromptQueueMessage = Extract<
	PromptQueueItem,
	{ readonly _tag: "Message" }
>;

type NoPromptQueueErrorFields = Record<never, never>;

export class EffectPromptQueueAlreadyIterating extends Data.TaggedError(
	"EffectPromptQueueAlreadyIterating",
)<NoPromptQueueErrorFields> {
	override get message(): string {
		return "EffectPromptQueue is single-consumer. Cannot iterate more than once.";
	}
}

/** Nothing will read the prompt: dropping it silently would strand its turn. */
export class EffectPromptQueueClosed extends Data.TaggedError(
	"EffectPromptQueueClosed",
)<NoPromptQueueErrorFields> {
	override get message(): string {
		return "EffectPromptQueue is closed. The prompt was not enqueued.";
	}
}

export class EffectPromptQueue implements PromptQueueController {
	private _iterating = false;
	private _closed = false;
	private readonly inputs = new Map<string, PromptQueueMessage>();

	private constructor(
		private readonly queue: Queue.Queue<PromptQueueItem>,
		private readonly iterable: AsyncIterable<PromptQueueMessage>,
	) {}

	static make(): Effect.Effect<EffectPromptQueue> {
		return Effect.gen(function* () {
			const queue = yield* Queue.unbounded<PromptQueueItem>();
			// Keep the SDK reader independent of the caller's service context. Its
			// return() must interrupt a pending read even when made during pre-warm.
			const iterable = Stream.fromQueue(queue).pipe(
				Stream.takeWhile(
					(item): item is PromptQueueMessage => item._tag === "Message",
				),
				Stream.ensuring(Queue.shutdown(queue)),
				Stream.toAsyncIterable,
			);
			return new EffectPromptQueue(queue, iterable);
		});
	}

	enqueue(
		message: SDKUserMessage,
		signal?: AbortSignal,
	): Effect.Effect<void, EffectPromptQueueClosed> {
		return Effect.suspend(() => {
			if (this._closed) return Effect.fail(new EffectPromptQueueClosed());
			const item: PromptQueueMessage = {
				_tag: "Message",
				message,
				signal,
				recalled: false,
				handed: false,
			};
			if (message.uuid) this.inputs.set(message.uuid, item);
			return Queue.offer(this.queue, item).pipe(Effect.asVoid);
		});
	}

	recall(inputId: string): Effect.Effect<boolean> {
		return Effect.sync(() => {
			const item = this.inputs.get(inputId);
			this.inputs.delete(inputId);
			if (item?.handed) return false;
			if (item) item.recalled = true;
			return true;
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
			throw new EffectPromptQueueAlreadyIterating();
		}
		this._iterating = true;

		const iterator = this.iterable[Symbol.asyncIterator]();
		return {
			next: async (): Promise<IteratorResult<SDKUserMessage>> => {
				while (true) {
					const next = await iterator.next();
					if (next.done) return { value: undefined, done: true };
					const item = next.value;
					// Stream can buffer a whole chunk. Recall remains possible until
					// this exact next() hands the individual input to the SDK.
					if (item.recalled || item.signal?.aborted) continue;
					item.handed = true;
					return { value: item.message, done: false };
				}
			},
			return: async (): Promise<IteratorResult<SDKUserMessage>> => {
				this._closed = true;
				this.inputs.clear();
				await iterator.return?.();
				return { value: undefined, done: true };
			},
		};
	}
}

export const makeEffectPromptQueue = (): Effect.Effect<EffectPromptQueue> =>
	EffectPromptQueue.make();
