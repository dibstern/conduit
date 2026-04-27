import { describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { expect } from "vitest";
import {
	addClient,
	bindClientSession,
	broadcast,
	broadcastPerSessionEvent,
	getClientCount,
	getClientIds,
	getClientSession,
	getSessionViewers,
	makeWsHandlerStateLive,
	markClientBootstrapped,
	removeClient,
	safeSend,
	sendTo,
	sendToSession,
	type WsConn,
} from "../../../src/lib/effect/ws-handler-service.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock WsConn that records sent messages. */
function mockWs(options?: { readyState?: number }): WsConn & {
	sent: string[];
	closed: boolean;
} {
	const sent: string[] = [];
	return {
		sent,
		closed: false,
		readyState: options?.readyState ?? 1, // WS_OPEN
		send(data: string) {
			sent.push(data);
		},
		close() {
			this.closed = true;
			this.readyState = 3; // WS_CLOSED
		},
	};
}

/** Create a fresh layer for each test (Layer.fresh ensures isolated state). */
const freshLayer = () => Layer.fresh(makeWsHandlerStateLive());

/** A minimal RelayMessage for testing. */
const testMsg = (type: string, extra?: Record<string, unknown>): RelayMessage =>
	({ type, ...extra }) as unknown as RelayMessage;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("WebSocket Handler Effect", () => {
	// ── addClient / removeClient ──────────────────────────────────────────

	it.effect("addClient registers and removeClient cleans up", () =>
		Effect.gen(function* () {
			const ws1 = mockWs();
			const ws2 = mockWs();

			// Add two clients
			const count1 = yield* addClient("c1", ws1);
			expect(count1).toBe(1);
			const count2 = yield* addClient("c2", ws2);
			expect(count2).toBe(2);

			// Remove first client
			const { sessionId, newCount } = yield* removeClient("c1");
			expect(sessionId).toBeUndefined();
			expect(newCount).toBe(1);

			// Verify remaining count
			const finalCount = yield* getClientCount;
			expect(finalCount).toBe(1);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("removeClient returns session if client had one", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);
			yield* bindClientSession("c1", "sess-1");

			const { sessionId } = yield* removeClient("c1");
			expect(sessionId).toBe("sess-1");
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("removeClient is a no-op for unknown client", () =>
		Effect.gen(function* () {
			const { sessionId, newCount } = yield* removeClient("nonexistent");
			expect(sessionId).toBeUndefined();
			expect(newCount).toBe(0);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── broadcast ─────────────────────────────────────────────────────────

	it.effect("broadcast sends to all connected clients", () =>
		Effect.gen(function* () {
			const ws1 = mockWs();
			const ws2 = mockWs();
			yield* addClient("c1", ws1);
			yield* addClient("c2", ws2);

			const msg = testMsg("client_count", { count: 2 });
			yield* broadcast(msg);

			const expected = JSON.stringify(msg);
			expect(ws1.sent).toEqual([expected]);
			expect(ws2.sent).toEqual([expected]);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("broadcast skips clients with closed connections", () =>
		Effect.gen(function* () {
			const wsOpen = mockWs();
			const wsClosed = mockWs({ readyState: 3 }); // WS_CLOSED
			yield* addClient("c1", wsOpen);
			yield* addClient("c2", wsClosed);

			yield* broadcast(testMsg("client_count", { count: 2 }));

			expect(wsOpen.sent.length).toBe(1);
			expect(wsClosed.sent.length).toBe(0);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── sendTo ────────────────────────────────────────────────────────────

	it.effect("sendTo targets a specific client", () =>
		Effect.gen(function* () {
			const ws1 = mockWs();
			const ws2 = mockWs();
			yield* addClient("c1", ws1);
			yield* addClient("c2", ws2);

			const msg = testMsg("delta", { sessionId: "s1", text: "hi" });
			yield* sendTo("c1", msg);

			expect(ws1.sent).toEqual([JSON.stringify(msg)]);
			expect(ws2.sent).toEqual([]);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("sendTo is a no-op for unknown client", () =>
		Effect.gen(function* () {
			// Should not throw
			yield* sendTo(
				"nonexistent",
				testMsg("delta", { sessionId: "s1", text: "x" }),
			);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── Bootstrap queue ──────────────────────────────────────────────────

	it.effect("events buffered until markBootstrapped flushes", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			// Before bootstrap: per-session events should be buffered
			const event1 = testMsg("delta", { sessionId: "s1", text: "one" });
			const event2 = testMsg("delta", { sessionId: "s1", text: "two" });
			yield* broadcastPerSessionEvent("s1", event1);
			yield* broadcastPerSessionEvent("s1", event2);

			// Nothing sent yet — events are in bootstrap queue
			expect(ws.sent).toEqual([]);

			// Mark client as bootstrapped — should flush in order
			yield* markClientBootstrapped("c1");

			expect(ws.sent).toEqual([JSON.stringify(event1), JSON.stringify(event2)]);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect(
		"broadcastPerSessionEvent delivers immediately to bootstrapped clients",
		() =>
			Effect.gen(function* () {
				const ws = mockWs();
				yield* addClient("c1", ws);
				yield* markClientBootstrapped("c1");

				const event = testMsg("delta", { sessionId: "s1", text: "live" });
				yield* broadcastPerSessionEvent("s1", event);

				expect(ws.sent).toEqual([JSON.stringify(event)]);
			}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("markClientBootstrapped is idempotent", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			yield* broadcastPerSessionEvent(
				"s1",
				testMsg("delta", { sessionId: "s1", text: "buf" }),
			);
			yield* markClientBootstrapped("c1");
			yield* markClientBootstrapped("c1"); // second call — no-op

			// Only one message flushed
			expect(ws.sent.length).toBe(1);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect(
		"broadcastPerSessionEvent mixes bootstrapped and buffered clients",
		() =>
			Effect.gen(function* () {
				const wsReady = mockWs();
				const wsNew = mockWs();
				yield* addClient("c-ready", wsReady);
				yield* markClientBootstrapped("c-ready");
				yield* addClient("c-new", wsNew);

				const event = testMsg("delta", { sessionId: "s1", text: "mixed" });
				yield* broadcastPerSessionEvent("s1", event);

				// Ready client gets it immediately
				expect(wsReady.sent).toEqual([JSON.stringify(event)]);
				// New client has it buffered
				expect(wsNew.sent).toEqual([]);

				// Now bootstrap the new client
				yield* markClientBootstrapped("c-new");
				expect(wsNew.sent).toEqual([JSON.stringify(event)]);
			}).pipe(Effect.provide(freshLayer())),
	);

	// ── bindClientSession + getSessionViewers ────────────────────────────

	it.effect("bindClientSession + getSessionViewers", () =>
		Effect.gen(function* () {
			const ws1 = mockWs();
			const ws2 = mockWs();
			const ws3 = mockWs();
			yield* addClient("c1", ws1);
			yield* addClient("c2", ws2);
			yield* addClient("c3", ws3);

			yield* bindClientSession("c1", "sess-A");
			yield* bindClientSession("c2", "sess-A");
			yield* bindClientSession("c3", "sess-B");

			const viewersA = yield* getSessionViewers("sess-A");
			expect(viewersA.sort()).toEqual(["c1", "c2"]);

			const viewersB = yield* getSessionViewers("sess-B");
			expect(viewersB).toEqual(["c3"]);

			const viewersNone = yield* getSessionViewers("nonexistent");
			expect(viewersNone).toEqual([]);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("getClientSession returns the bound session", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);
			yield* bindClientSession("c1", "sess-1");

			const session = yield* getClientSession("c1");
			expect(Option.isSome(session)).toBe(true);
			expect(Option.getOrThrow(session)).toBe("sess-1");
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("getClientSession returns None for unbound client", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			const session = yield* getClientSession("c1");
			expect(Option.isNone(session)).toBe(true);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── sendToSession ────────────────────────────────────────────────────

	it.effect("sendToSession sends only to viewers of that session", () =>
		Effect.gen(function* () {
			const ws1 = mockWs();
			const ws2 = mockWs();
			yield* addClient("c1", ws1);
			yield* addClient("c2", ws2);
			yield* bindClientSession("c1", "sess-A");
			yield* bindClientSession("c2", "sess-B");

			const msg = testMsg("session_status", { sessionId: "sess-A" });
			yield* sendToSession("sess-A", msg);

			expect(ws1.sent).toEqual([JSON.stringify(msg)]);
			expect(ws2.sent).toEqual([]);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── getClientCount + getClientIds ─────────────────────────────────────

	it.effect("getClientCount reflects current state", () =>
		Effect.gen(function* () {
			expect(yield* getClientCount).toBe(0);
			yield* addClient("c1", mockWs());
			expect(yield* getClientCount).toBe(1);
			yield* addClient("c2", mockWs());
			expect(yield* getClientCount).toBe(2);
			yield* removeClient("c1");
			expect(yield* getClientCount).toBe(1);
		}).pipe(Effect.provide(freshLayer())),
	);

	it.effect("getClientIds returns all registered client IDs", () =>
		Effect.gen(function* () {
			yield* addClient("c1", mockWs());
			yield* addClient("c2", mockWs());
			const ids = yield* getClientIds;
			expect(ids.sort()).toEqual(["c1", "c2"]);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── safeSend ─────────────────────────────────────────────────────────

	it.effect("safeSend returns true on success", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			const result = yield* safeSend(ws, "hello");
			expect(result).toBe(true);
			expect(ws.sent).toEqual(["hello"]);
		}),
	);

	it.effect("safeSend returns false for closed connection", () =>
		Effect.gen(function* () {
			const ws = mockWs({ readyState: 3 });
			const result = yield* safeSend(ws, "hello");
			expect(result).toBe(false);
			expect(ws.sent).toEqual([]);
		}),
	);

	it.effect("safeSend returns false on send exception", () =>
		Effect.gen(function* () {
			const ws: WsConn = {
				readyState: 1,
				send() {
					throw new Error("write EPIPE");
				},
				close() {},
			};
			const result = yield* safeSend(ws, "hello");
			expect(result).toBe(false);
		}),
	);

	// ── removeClient cleans up bootstrap state ───────────────────────────

	it.effect("removeClient clears bootstrap queue", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			// Buffer an event
			yield* broadcastPerSessionEvent(
				"s1",
				testMsg("delta", { sessionId: "s1", text: "buf" }),
			);

			// Remove client — bootstrap queue should be discarded
			yield* removeClient("c1");

			// Re-add client with same ID (fresh state)
			yield* addClient("c1", ws);
			yield* markClientBootstrapped("c1");

			// No stale queued messages should flush
			expect(ws.sent).toEqual([]);
		}).pipe(Effect.provide(freshLayer())),
	);

	// ── Edge case: bootstrap flush with closed connection ────────────────

	it.effect("markClientBootstrapped does not flush to closed connection", () =>
		Effect.gen(function* () {
			const ws = mockWs();
			yield* addClient("c1", ws);

			yield* broadcastPerSessionEvent(
				"s1",
				testMsg("delta", { sessionId: "s1", text: "buf" }),
			);

			// Close the connection before bootstrap
			ws.readyState = 3;
			yield* markClientBootstrapped("c1");

			// Nothing should be sent
			expect(ws.sent).toEqual([]);
		}).pipe(Effect.provide(freshLayer())),
	);
});
