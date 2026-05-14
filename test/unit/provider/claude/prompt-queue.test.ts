// test/unit/provider/claude/prompt-queue.test.ts
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	EffectPromptQueueAlreadyIterating,
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
	} as unknown as SDKUserMessage;
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
	it("keeps producer operations free of local runtime bridges", () => {
		const source = readFileSync(
			"src/lib/provider/claude/effect-prompt-queue.ts",
			"utf8",
		);
		expect(source).not.toMatch(/Effect\.run(?:Promise|Sync)/);
	});

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

		// Give the consumer a tick to start awaiting.
		await new Promise((r) => setTimeout(r, 10));

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

		await new Promise((r) => setTimeout(r, 10));
		await close(q);

		const items = await consumer;
		expect(items).toEqual([]);
	});

	it("enqueue after close is a no-op", async () => {
		const q = await makeQueue();
		await close(q);
		await enqueue(q, msg("ignored"));
		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toEqual([]);
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
		await enqueue(q, msg("ignored")); // after close

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
