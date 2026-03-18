import { describe, expect, it, vi } from "vitest";
import { ClientMessageQueue } from "../../../src/lib/server/client-message-queue.js";

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe("ClientMessageQueue", () => {
	it("processes messages for the same client sequentially", async () => {
		const order: string[] = [];
		const queue = new ClientMessageQueue();

		const p1 = queue.enqueue("c1", async () => {
			await delay(50);
			order.push("c1-first");
		});
		const p2 = queue.enqueue("c1", async () => {
			order.push("c1-second");
		});

		await Promise.all([p1, p2]);
		expect(order).toEqual(["c1-first", "c1-second"]);
	});

	it("processes messages for different clients in parallel", async () => {
		const order: string[] = [];
		const queue = new ClientMessageQueue();

		const p1 = queue.enqueue("c1", async () => {
			await delay(50);
			order.push("c1");
		});
		const p2 = queue.enqueue("c2", async () => {
			order.push("c2");
		});

		await Promise.all([p1, p2]);
		// c2 should finish before c1 because they run in parallel
		expect(order).toEqual(["c2", "c1"]);
	});

	it("continues processing after handler error", async () => {
		const order: string[] = [];
		const onError = vi.fn();
		const queue = new ClientMessageQueue({ onError });

		await queue.enqueue("c1", async () => {
			throw new Error("boom");
		});
		await queue.enqueue("c1", async () => {
			order.push("c1-after-error");
		});

		expect(order).toEqual(["c1-after-error"]);
		expect(onError).toHaveBeenCalledWith("c1", expect.any(Error));
	});

	it("cleans up idle clients", async () => {
		const queue = new ClientMessageQueue();
		await queue.enqueue("c1", async () => {});
		expect(queue.activeClients).toBe(0); // queue auto-cleans when empty
	});

	it("removeClient removes queue entry", async () => {
		const queue = new ClientMessageQueue();
		// Start a long-running task
		const p = queue.enqueue("c1", async () => {
			await delay(100);
		});
		expect(queue.activeClients).toBe(1);
		queue.removeClient("c1");
		// After removeClient, map entry is gone (task still runs to completion)
		expect(queue.activeClients).toBe(0);
		await p;
	});

	it("getQueueDepth returns 0 for unknown client", () => {
		const queue = new ClientMessageQueue();
		expect(queue.getQueueDepth("c1")).toBe(0);
	});
});
