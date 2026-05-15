import { Cause, Chunk, Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { preloadDecoder } from "../../../src/lib/frontend/effect-boundary.js";
import {
	TransportSocketError,
	type WsProtocolError,
	wsMessageStream,
} from "../../../src/lib/frontend/transport/runtime.js";

class MockWebSocket extends EventTarget {
	readyState: number = WebSocket.OPEN;

	close(): void {
		this.readyState = WebSocket.CLOSED;
		this.dispatchEvent(new Event("close"));
	}

	emitMessage(data: string): void {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}

	emitError(): void {
		this.dispatchEvent(new Event("error"));
	}
}

async function collectAfter(
	fn: (ws: MockWebSocket) => void | Promise<void>,
	onProtocolError?: (error: WsProtocolError) => void,
): Promise<ReadonlyArray<unknown>> {
	const ws = new MockWebSocket();
	const stream =
		onProtocolError === undefined
			? wsMessageStream(ws as unknown as WebSocket)
			: wsMessageStream(ws as unknown as WebSocket, { onProtocolError });
	const effect = Stream.runCollect(stream).pipe(Effect.map(Chunk.toArray));
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
		const errors: WsProtocolError[] = [];
		const messages = await collectAfter((ws) => {
			ws.emitMessage("not json{");
			ws.emitMessage(JSON.stringify({ type: "client_count", count: 1 }));
		}, errors.push.bind(errors));

		expect(messages).toEqual([
			expect.objectContaining({ type: "client_count", count: 1 }),
		]);
		expect(errors).toEqual([expect.objectContaining({ kind: "invalid_json" })]);
	});

	it("passes unknown messages through but rejects malformed known messages", async () => {
		await preloadDecoder();
		const unknown = { type: "future_type", data: 1 };
		const malformed = { type: "delta" };
		const errors: WsProtocolError[] = [];
		const messages = await collectAfter((ws) => {
			ws.emitMessage(JSON.stringify(unknown));
			ws.emitMessage(JSON.stringify(malformed));
		}, errors.push.bind(errors));

		expect(messages).toEqual([unknown]);
		expect(errors).toEqual([
			expect.objectContaining({
				kind: "invalid_message",
				messageType: "delta",
			}),
		]);
	});

	it("fails the stream with a typed socket error", async () => {
		const ws = new MockWebSocket();
		const promise = Effect.runPromiseExit(
			Stream.runDrain(wsMessageStream(ws as unknown as WebSocket)),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));

		ws.emitError();

		const exit = await promise;
		expect(exit._tag).toBe("Failure");
		if (exit._tag === "Failure") {
			expect(Chunk.toArray(Cause.failures(exit.cause))).toEqual([
				expect.any(TransportSocketError),
			]);
		}
	});
});
