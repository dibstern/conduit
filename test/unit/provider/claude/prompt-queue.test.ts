// test/unit/provider/claude/prompt-queue.test.ts
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	EffectPromptQueueAlreadyIterating,
	EffectPromptQueueClosed,
	makeEffectPromptQueue,
} from "../../../../src/lib/provider/claude/effect-prompt-queue.js";
import type {
	PromptQueueController,
	SDKUserMessage,
} from "../../../../src/lib/provider/claude/types.js";

function msg(text: string): SDKUserMessage {
	return {
		type: "user",
		parent_tool_use_id: null,
		message: { role: "user", content: [{ type: "text", text }] },
	} satisfies SDKUserMessage;
}

async function takeN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) {
		out.push(item);
		if (out.length >= n) break;
	}
	return out;
}

async function makeQueue(): Promise<PromptQueueController> {
	return Effect.runPromise(makeEffectPromptQueue());
}

async function enqueue(
	queue: PromptQueueController,
	message: SDKUserMessage,
): Promise<void> {
	await Effect.runPromise(queue.enqueue(message));
}

async function close(queue: PromptQueueController): Promise<void> {
	await Effect.runPromise(queue.close());
}

describe("EffectPromptQueue", () => {
	it("exposes Effect-returning producer operations", async () => {
		const q = await makeQueue();

		const enqueueEffect = q.enqueue(msg("effectful"));
		expect(Effect.isEffect(enqueueEffect)).toBe(true);
		await Effect.runPromise(enqueueEffect);

		const closeEffect = q.close();
		expect(Effect.isEffect(closeEffect)).toBe(true);
		await Effect.runPromise(closeEffect);
	});

	it("yields messages in enqueue order", async () => {
		const q = await makeQueue();
		await enqueue(q, msg("one"));
		await enqueue(q, msg("two"));
		await enqueue(q, msg("three"));
		await close(q);

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(3);
		expect(
			(items[0]?.message.content as ReadonlyArray<{ text: string }>)[0]?.text,
		).toBe("one");
		expect(
			(items[2]?.message.content as ReadonlyArray<{ text: string }>)[0]?.text,
		).toBe("three");
	});

	it("blocks consumer until a message is enqueued", async () => {
		const q = await makeQueue();
		const consumerPromise = takeN(q, 1);

		// Flush the consumer's pending async-iterator subscription.
		await new Promise<void>((resolve) => setImmediate(resolve));

		await enqueue(q, msg("hello"));
		const items = await consumerPromise;
		expect(items).toHaveLength(1);
		expect(
			(items[0]?.message.content as ReadonlyArray<{ text: string }>)[0]?.text,
		).toBe("hello");
		await close(q);
	});

	it("terminates the iterator when close() is called", async () => {
		const q = await makeQueue();
		await enqueue(q, msg("only"));
		await close(q);

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(1);
	});

	it("close() unblocks a waiting consumer with an end-of-stream", async () => {
		const q = await makeQueue();
		const consumer = (async () => {
			const items: SDKUserMessage[] = [];
			for await (const m of q) items.push(m);
			return items;
		})();

		await new Promise<void>((resolve) => setImmediate(resolve));
		await close(q);

		const items = await consumer;
		expect(items).toEqual([]);
	});

	// A prompt nothing will read must fail its sender: dropped silently, the
	// turn waiting on it never ends (conduit-test-6ksg).
	it("enqueue after close fails and delivers nothing", async () => {
		const q = await makeQueue();
		await close(q);
		await expect(
			Effect.runPromise(Effect.flip(q.enqueue(msg("lost")))),
		).resolves.toBeInstanceOf(EffectPromptQueueClosed);
		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toEqual([]);
	});

	it("enqueue after the consumer returned fails", async () => {
		const q = await makeQueue();
		await q[Symbol.asyncIterator]().return?.();
		await expect(
			Effect.runPromise(Effect.flip(q.enqueue(msg("lost")))),
		).resolves.toBeInstanceOf(EffectPromptQueueClosed);
	});

	it("throws on second iteration attempt (single-consumer guard)", async () => {
		const q = await makeQueue();
		q[Symbol.asyncIterator]();
		let error: unknown;
		try {
			q[Symbol.asyncIterator]();
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(EffectPromptQueueAlreadyIterating);
		expect(error).toMatchObject({
			_tag: "EffectPromptQueueAlreadyIterating",
			message:
				"EffectPromptQueue is single-consumer. Cannot iterate more than once.",
		});
		await close(q);
	});

	it("close() is idempotent", async () => {
		const q = await makeQueue();
		await close(q);
		await close(q); // should not throw
	});

	it("drains buffered messages before ending on close", async () => {
		const q = await makeQueue();
		await enqueue(q, msg("first"));
		await enqueue(q, msg("second"));
		await close(q);

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(2);
	});

	it("return() closes the queue and signals done", async () => {
		const q = await makeQueue();
		const iter = q[Symbol.asyncIterator]();
		const result = await iter.return?.();
		expect(result?.done).toBe(true);
	});
});
