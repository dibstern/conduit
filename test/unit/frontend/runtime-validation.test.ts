import { Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { preloadDecoder } from "../../../src/lib/frontend/effect-boundary.js";
import { wsMessageStream } from "../../../src/lib/frontend/transport/runtime.js";

class MockWebSocket extends EventTarget {
	readyState: number = WebSocket.OPEN;

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	emitMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
}

async function collectAfter(
	fn: (ws: MockWebSocket) => void | Promise<void>,
): Promise<ReadonlyArray<unknown>> {
	const ws = new MockWebSocket();
	const effect = Stream.runCollect(
		wsMessageStream(ws as unknown as WebSocket),
	).pipe(Effect.map(Chunk.toArray));
	const promise = Effect.runPromise(effect);
	await new Promise((resolve) => setTimeout(resolve, 0));
	await fn(ws);
	ws.close();
	return promise;
}

describe("frontend runtime WebSocket validation", () => {
	it("emits valid decoded messages", async () => {
		await preloadDecoder();
		const messages = await collectAfter((ws) => {
			ws.emitMessage(
				JSON.stringify({ type: "delta", sessionId: "s1", text: "hi" }),
			);
		});

		expect(messages).toEqual([
			expect.objectContaining({ type: "delta", sessionId: "s1", text: "hi" }),
		]);
	});

	it("skips invalid JSON and keeps the stream alive", async () => {
		await preloadDecoder();
		const messages = await collectAfter((ws) => {
			ws.emitMessage("not json{");
			ws.emitMessage(JSON.stringify({ type: "client_count", count: 1 }));
		});

		expect(messages).toEqual([
			expect.objectContaining({ type: "client_count", count: 1 }),
		]);
	});

	it("passes unknown and malformed known messages through", async () => {
		await preloadDecoder();
		const unknown = { type: "future_type", data: 1 };
		const malformed = { type: "delta" };
		const messages = await collectAfter((ws) => {
			ws.emitMessage(JSON.stringify(unknown));
			ws.emitMessage(JSON.stringify(malformed));
		});

		expect(messages).toEqual([unknown, malformed]);
	});
});
