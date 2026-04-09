// test/unit/provider/claude/prompt-queue.test.ts
import { describe, expect, it } from "vitest";
import { PromptQueue } from "../../../../src/lib/provider/claude/prompt-queue.js";
import type { SDKUserMessage } from "../../../../src/lib/provider/claude/types.js";

function msg(text: string): SDKUserMessage {
	return {
		type: "user",
		session_id: "",
		parent_tool_use_id: null,
		message: { role: "user", content: [{ type: "text", text }] },
	};
}

async function takeN<T>(iter: AsyncIterable<T>, n: number): Promise<T[]> {
	const out: T[] = [];
	for await (const item of iter) {
		out.push(item);
		if (out.length >= n) break;
	}
	return out;
}

describe("PromptQueue", () => {
	it("yields messages in enqueue order", async () => {
		const q = new PromptQueue();
		q.enqueue(msg("one"));
		q.enqueue(msg("two"));
		q.enqueue(msg("three"));
		q.close();

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
		const q = new PromptQueue();
		const consumerPromise = takeN(q, 1);

		// Give the consumer a tick to start awaiting.
		await new Promise((r) => setTimeout(r, 10));

		q.enqueue(msg("hello"));
		const items = await consumerPromise;
		expect(items).toHaveLength(1);
		expect(
			(items[0]?.message.content as ReadonlyArray<{ text: string }>)[0]?.text,
		).toBe("hello");
		q.close();
	});

	it("terminates the iterator when close() is called", async () => {
		const q = new PromptQueue();
		q.enqueue(msg("only"));
		q.close();

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(1);
	});

	it("close() unblocks a waiting consumer with an end-of-stream", async () => {
		const q = new PromptQueue();
		const consumer = (async () => {
			const items: SDKUserMessage[] = [];
			for await (const m of q) items.push(m);
			return items;
		})();

		await new Promise((r) => setTimeout(r, 10));
		q.close();

		const items = await consumer;
		expect(items).toEqual([]);
	});

	it("enqueue after close is a no-op", async () => {
		const q = new PromptQueue();
		q.close();
		q.enqueue(msg("ignored"));
		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toEqual([]);
	});

	it("throws on second iteration attempt (single-consumer guard)", () => {
		const q = new PromptQueue();
		q[Symbol.asyncIterator]();
		expect(() => q[Symbol.asyncIterator]()).toThrow(
			"PromptQueue is single-consumer",
		);
		q.close();
	});

	it("close() is idempotent", () => {
		const q = new PromptQueue();
		q.close();
		q.close(); // should not throw
	});

	it("drains buffered messages before ending on close", async () => {
		const q = new PromptQueue();
		q.enqueue(msg("first"));
		q.enqueue(msg("second"));
		q.close();
		q.enqueue(msg("ignored")); // after close

		const items: SDKUserMessage[] = [];
		for await (const m of q) items.push(m);
		expect(items).toHaveLength(2);
	});

	it("return() closes the queue and signals done", async () => {
		const q = new PromptQueue();
		const iter = q[Symbol.asyncIterator]();
		const result = await iter.return?.();
		expect(result?.done).toBe(true);
	});
});
