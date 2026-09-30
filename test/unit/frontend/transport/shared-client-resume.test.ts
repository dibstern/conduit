import { Effect, Fiber, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	WsRpcClients,
	WsRpcClientsLayer,
} from "../../../../src/lib/frontend/transport/shared-client.js";

const Request = Schema.Struct({
	_tag: Schema.Literal("Request"),
	id: Schema.String,
	tag: Schema.String,
	payload: Schema.Struct({
		projectSlug: Schema.String,
		resumeFromSequence: Schema.optional(Schema.Number),
	}),
});

const sockets: FakeWebSocket[] = [];

// Only the browser socket is replaced. The production layer owns serialization,
// protocol failure, reconnect, and subscription re-issue.
class FakeWebSocket extends EventTarget {
	readyState = 0;
	readonly requests: (typeof Request.Type)[] = [];

	constructor(readonly url: string) {
		super();
		sockets.push(this);
		setTimeout(() => {
			if (this.readyState !== 0) return;
			this.readyState = 1;
			this.dispatchEvent(new Event("open"));
		}, 0);
	}

	send(data: string): void {
		const frame: unknown = JSON.parse(data);
		if (typeof frame !== "object" || frame === null || !("_tag" in frame))
			throw new Error("invalid RPC frame");
		if (frame._tag === "Request") {
			this.requests.push(Schema.decodeUnknownSync(Request)(frame));
		} else if (frame._tag === "Ping") {
			this.receive({ _tag: "Pong" });
		}
	}

	receive(frame: object): void {
		if (this.readyState !== 1) throw new Error("socket is not open");
		this.dispatchEvent(
			new MessageEvent("message", { data: JSON.stringify(frame) }),
		);
	}

	close(): void {
		this.readyState = 3;
	}

	drop(): void {
		this.close();
		this.dispatchEvent(
			Object.assign(new Event("close"), {
				code: 1006,
				reason: "connection lost",
			}),
		);
	}
}

const nextSubscription = async () => {
	await vi.waitFor(
		() => {
			expect(sockets.some((socket) => socket.requests.length > 0)).toBe(true);
		},
		{ timeout: 4000 },
	);
	for (const socket of sockets) {
		const request = socket.requests.shift();
		if (request) {
			expect(request.tag).toBe("SubscribeShell");
			return { socket, request };
		}
	}
	throw new Error("missing subscription request");
};

beforeEach(() => {
	sockets.length = 0;
	vi.stubGlobal("location", { protocol: "http:", host: "localhost:2633" });
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => vi.unstubAllGlobals());

describe("shared client resume over WebSockets", () => {
	it.each([
		undefined,
		7,
	])("preserves the original resume point %s when no item arrived", async (from) => {
		const runtime = ManagedRuntime.make(WsRpcClientsLayer);
		try {
			const clients = await runtime.runPromise(WsRpcClients);
			const pair = await runtime.runPromise(clients.forProject("alpha"));
			const observed: object[] = [];
			const options = from === undefined ? {} : { resumeFromSequence: from };
			const consumer = runtime.runFork(
				pair.subscriptions.shell(options).pipe(
					Stream.runForEach((item) =>
						Effect.sync(() => {
							observed.push(item);
						}),
					),
				),
			);
			const first = await nextSubscription();
			expect(first.request.payload).toEqual({
				projectSlug: "alpha",
				...options,
			});
			expect(observed).toEqual([]);
			first.socket.drop();
			const resumed = await nextSubscription();
			expect(resumed.socket).not.toBe(first.socket);
			expect(resumed.request.payload).toEqual({
				projectSlug: "alpha",
				...options,
			});
			resumed.socket.receive({
				_tag: "Chunk",
				requestId: resumed.request.id,
				values: [
					{ _tag: "snapshot", rows: [], sequence: 11 },
					{ _tag: "synchronized" },
				],
			});
			await vi.waitFor(() => expect(observed).toHaveLength(2));
			resumed.socket.receive({
				_tag: "Exit",
				requestId: resumed.request.id,
				exit: { _tag: "Success" },
			});
			await runtime.runPromise(Fiber.join(consumer));
			expect(observed).toEqual([
				{ _tag: "snapshot", rows: [], sequence: 11 },
				{ _tag: "synchronized" },
			]);
		} finally {
			await runtime.dispose();
		}
	}, 10000);

	it("resumes from the last closed sequence without losing or repeating items", async () => {
		const runtime = ManagedRuntime.make(WsRpcClientsLayer);
		try {
			const clients = await runtime.runPromise(WsRpcClients);
			const pair = await runtime.runPromise(clients.forProject("alpha"));
			const observed: object[] = [];
			const consumer = runtime.runFork(
				pair.subscriptions.shell().pipe(
					Stream.runForEach((item) =>
						Effect.sync(() => {
							observed.push(item);
						}),
					),
				),
			);
			const first = await nextSubscription();
			expect(first.request.payload).toEqual({ projectSlug: "alpha" });
			first.socket.receive({
				_tag: "Chunk",
				requestId: first.request.id,
				values: [
					{ _tag: "snapshot", rows: [], sequence: 11 },
					{ _tag: "synchronized" },
					{ _tag: "remove", id: "a", sequence: 12 },
					{ _tag: "remove", id: "b", sequence: 13 },
				],
			});
			await vi.waitFor(() => expect(observed).toHaveLength(4));
			first.socket.drop();

			const resumed = await nextSubscription();
			expect(resumed.socket).not.toBe(first.socket);
			// 13 is open: its already delivered member must be suppressed while
			// its undelivered sibling still reaches the same consumer.
			expect(resumed.request.payload).toEqual({
				projectSlug: "alpha",
				resumeFromSequence: 12,
			});
			const history = [
				{ _tag: "remove", id: "a", sequence: 12 },
				{ _tag: "remove", id: "b", sequence: 13 },
				{ _tag: "remove", id: "c", sequence: 13 },
				{ _tag: "remove", id: "d", sequence: 14 },
			];
			resumed.socket.receive({
				_tag: "Chunk",
				requestId: resumed.request.id,
				values: [
					...history.filter(
						(item) =>
							item.sequence > (resumed.request.payload.resumeFromSequence ?? 0),
					),
					{ _tag: "synchronized" },
				],
			});
			await vi.waitFor(() => expect(observed).toHaveLength(7));
			resumed.socket.receive({
				_tag: "Exit",
				requestId: resumed.request.id,
				exit: { _tag: "Success" },
			});
			await runtime.runPromise(Fiber.join(consumer));
			expect(observed).toEqual([
				{ _tag: "snapshot", rows: [], sequence: 11 },
				{ _tag: "synchronized" },
				{ _tag: "remove", id: "a", sequence: 12 },
				{ _tag: "remove", id: "b", sequence: 13 },
				{ _tag: "remove", id: "c", sequence: 13 },
				{ _tag: "remove", id: "d", sequence: 14 },
				{ _tag: "synchronized" },
			]);
		} finally {
			await runtime.dispose();
		}
	}, 10000);
});
