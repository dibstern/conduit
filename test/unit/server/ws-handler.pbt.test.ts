// ─── WebSocket Handler PBT Tests (Ticket 2.2) ───────────────────────────────

import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { WebSocketHandler } from "../../../src/lib/server/ws-handler.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as typeof import("ws").default;

type WS = InstanceType<typeof WebSocket>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Buffered WebSocket client — captures messages from the moment it connects */
interface BufferedClient {
	ws: WS;
	messages: Record<string, unknown>[];
	/** Wait until at least N messages have been received */
	waitForMessages(n: number): Promise<Record<string, unknown>[]>;
	close(): Promise<void>;
}

function createBufferedClient(port: number): Promise<BufferedClient> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		const messages: Record<string, unknown>[] = [];
		const waiters: Array<{
			n: number;
			resolve: (msgs: Record<string, unknown>[]) => void;
		}> = [];

		ws.on("message", (data: Buffer) => {
			messages.push(JSON.parse(data.toString()));
			// Check if any waiters are satisfied
			for (let i = waiters.length - 1; i >= 0; i--) {
				// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
				if (messages.length >= waiters[i]!.n) {
					// biome-ignore lint/style/noNonNullAssertion: safe — bounded by array length
					waiters[i]!.resolve([...messages]);
					waiters.splice(i, 1);
				}
			}
		});

		const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
		ws.on("open", () => {
			clearTimeout(timer);
			resolve({
				ws,
				messages,
				waitForMessages(n: number) {
					if (messages.length >= n) return Promise.resolve([...messages]);
					return new Promise((res, rej) => {
						const t = setTimeout(
							() =>
								rej(
									new Error(`waited for ${n} messages, got ${messages.length}`),
								),
							3000,
						);
						waiters.push({
							n,
							resolve: (msgs) => {
								clearTimeout(t);
								res(msgs);
							},
						});
					});
				},
				async close() {
					return new Promise<void>((res) => {
						if (ws.readyState === WebSocket.CLOSED) {
							res();
							return;
						}
						ws.once("close", () => res());
						ws.close();
					});
				},
			});
		});
		ws.on("error", (e: Error) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

async function setup(options?: {
	heartbeatInterval?: number;
}): Promise<{ server: Server; handler: WebSocketHandler; port: number }> {
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const handler = new WebSocketHandler(new ServiceRegistry(), server, {
		heartbeatInterval: options?.heartbeatInterval ?? 60_000,
	});
	return { server, handler, port };
}

async function teardown(
	server: Server,
	handler: WebSocketHandler,
): Promise<void> {
	handler.close();
	await new Promise<void>((r) => server.close(() => r()));
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Ticket 2.2 — WebSocket Handler PBT", () => {
	it("P1: client count updates on connect/disconnect (AC4)", async () => {
		const { server, handler, port } = await setup();

		expect(handler.getClientCount()).toBe(0);

		const c1 = await createBufferedClient(port);
		const msgs1 = await c1.waitForMessages(1);
		expect(msgs1[0]).toEqual({ type: "client_count", count: 1 });
		expect(handler.getClientCount()).toBe(1);

		const c2 = await createBufferedClient(port);
		const msgs2 = await c2.waitForMessages(1);
		expect(msgs2[0]).toEqual({ type: "client_count", count: 2 });

		// c1 also gets updated count
		await c1.waitForMessages(2);
		expect(c1.messages[1]).toEqual({ type: "client_count", count: 2 });

		await c1.close();
		await vi.waitFor(() => {
			expect(handler.getClientCount()).toBe(1);
		});

		await c2.close();
		await vi.waitFor(() => {
			expect(handler.getClientCount()).toBe(0);
		});

		await teardown(server, handler);
	});

	it("P2: broadcast reaches all connected clients (AC2)", async () => {
		const { server, handler, port } = await setup();

		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1); // count=1

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1); // count=2
		await c1.waitForMessages(2); // count=2 update

		handler.broadcast({ type: "delta", text: "hello world" });

		await c1.waitForMessages(3);
		await c2.waitForMessages(2);
		expect(c1.messages[2]).toEqual({ type: "delta", text: "hello world" });
		expect(c2.messages[1]).toEqual({ type: "delta", text: "hello world" });

		await c1.close();
		await c2.close();
		await teardown(server, handler);
	});

	it("P3a: malformed JSON sends error but doesn't disconnect (AC7)", async () => {
		const { server, handler, port } = await setup();

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		c.ws.send("not valid json");
		await c.waitForMessages(2);
		expect(c.messages[1]).toEqual({
			type: "error",
			code: "PARSE_ERROR",
			message: "Could not parse message as JSON",
		});
		expect(c.ws.readyState).toBe(WebSocket.OPEN);

		await c.close();
		await teardown(server, handler);
	});

	it("P3b: unknown message type sends error but doesn't disconnect (AC7)", async () => {
		const { server, handler, port } = await setup();

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		c.ws.send(JSON.stringify({ type: "nonexistent_type" }));
		await c.waitForMessages(2);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(c.messages[1]!["type"]).toBe("error");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(c.messages[1]!["code"]).toBe("UNKNOWN_MESSAGE_TYPE");
		expect(c.ws.readyState).toBe(WebSocket.OPEN);

		await c.close();
		await teardown(server, handler);
	});

	it("P4a: valid messages are routed to handler (AC3)", async () => {
		const { server, handler, port } = await setup();

		const received: Array<{
			handler: string;
			payload: Record<string, unknown>;
		}> = [];
		handler.on("message", (msg) => received.push(msg));

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		c.ws.send(JSON.stringify({ type: "message", text: "hello" }));
		await vi.waitFor(() => {
			expect(received.length).toBe(1);
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(received[0]!.handler).toBe("message");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(received[0]!.payload["text"]).toBe("hello");

		await c.close();
		await teardown(server, handler);
	});

	it("P4b: permission_response is routed correctly (AC3)", async () => {
		const { server, handler, port } = await setup();

		const received: Array<{ handler: string }> = [];
		handler.on("message", (msg) => received.push(msg));

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		c.ws.send(
			JSON.stringify({
				type: "permission_response",
				requestId: "req-1",
				decision: "allow",
			}),
		);
		await vi.waitFor(() => {
			expect(received.length).toBe(1);
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(received[0]!.handler).toBe("permission_response");

		await c.close();
		await teardown(server, handler);
	});

	it("P5: connect/disconnect events are emitted (AC6)", async () => {
		const { server, handler, port } = await setup();

		const connected: string[] = [];
		const disconnected: string[] = [];
		handler.on("client_connected", ({ clientId }) => connected.push(clientId));
		handler.on("client_disconnected", ({ clientId }) =>
			disconnected.push(clientId),
		);

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count
		expect(connected.length).toBe(1);

		await c.close();
		await vi.waitFor(() => {
			expect(disconnected.length).toBe(1);
		});
		expect(disconnected[0]).toBe(connected[0]);

		await teardown(server, handler);
	});

	it("P6: sendTo only sends to target client (AC2)", async () => {
		const { server, handler, port } = await setup();

		let firstId = "";
		handler.once("client_connected", ({ clientId }) => {
			firstId = clientId;
		});

		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1); // count=1

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1); // count=2
		await c1.waitForMessages(2); // count=2 update

		handler.sendTo(firstId, { type: "status", status: "processing" });
		await c1.waitForMessages(3);
		expect(c1.messages[2]).toEqual({ type: "status", status: "processing" });

		// c2 should NOT have received it
		await new Promise((r) => setTimeout(r, 100));
		expect(c2.messages.length).toBe(1); // only the initial client_count

		await c1.close();
		await c2.close();
		await teardown(server, handler);
	});

	// ─── New: Heartbeat, client_error, sendTo edge cases ──

	it("P7: heartbeat terminates dead connections and emits client_disconnected", async () => {
		// Use a short heartbeat interval (150ms) to test quickly
		const { server, handler, port } = await setup({ heartbeatInterval: 150 });

		const disconnected: Array<{ clientId: string; clientCount: number }> = [];
		handler.on("client_disconnected", (evt) => disconnected.push(evt));

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count=1
		expect(handler.getClientCount()).toBe(1);

		// Access the internal clients map to simulate a dead connection.
		// Set isAlive=false and remove the pong listener so the heartbeat
		// will see a dead connection on the next cycle.
		const handlerInternal = handler as unknown as {
			clients: Map<string, WS & { isAlive: boolean }>;
		};

		for (const [_id, serverWs] of handlerInternal.clients) {
			serverWs.isAlive = false;
			// Remove the pong listener to prevent isAlive from being reset
			serverWs.removeAllListeners("pong");
		}

		// Wait for the heartbeat cycle to detect and terminate the dead connection
		await vi.waitFor(
			() => {
				expect(handler.getClientCount()).toBe(0);
			},
			{ timeout: 1000 },
		);
		// The heartbeat terminates the ws, which also triggers the close handler.
		// Both paths emit client_disconnected (the second is idempotent on state).
		// We verify at least one disconnect event fired and client count reached 0.
		expect(disconnected.length).toBeGreaterThanOrEqual(1);
		// The last disconnect event should show count=0
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const lastDisconnect = disconnected[disconnected.length - 1]!;
		expect(lastDisconnect.clientCount).toBe(0);

		await teardown(server, handler);
	});

	it("P9: client_error event is emitted when a WebSocket error occurs", async () => {
		const { server, handler, port } = await setup();

		const errors: Array<{ clientId: string; error: Error }> = [];
		handler.on("client_error", (evt) => errors.push(evt));

		let connectedId = "";
		handler.on("client_connected", ({ clientId }) => {
			connectedId = clientId;
		});

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		expect(connectedId).not.toBe("");

		// Access the internal server-side ws and directly emit an error on it.
		// This simulates a network error on the server-side connection.
		const handlerInternal = handler as unknown as {
			clients: Map<string, WS>;
		};

		const serverWs = handlerInternal.clients.get(connectedId);
		expect(serverWs).toBeTruthy();

		// Emit an error directly on the server-side ws connection
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		serverWs!.emit("error", new Error("simulated network error"));

		// The handler should have caught the error and emitted client_error
		await vi.waitFor(() => {
			expect(errors.length).toBe(1);
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(errors[0]!.clientId).toBe(connectedId);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(errors[0]!.error.message).toBe("simulated network error");

		await c.close();
		await teardown(server, handler);
	});

	it("P10: sendTo with non-existent clientId does not crash", async () => {
		const { server, handler, port } = await setup();

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		// Send to a bogus client ID — should not throw or crash
		expect(() => {
			handler.sendTo("nonexistent-id-12345", {
				type: "delta",
				text: "lost message",
			});
		}).not.toThrow();

		// The existing client should still be functional
		handler.broadcast({ type: "delta", text: "still alive" });
		await c.waitForMessages(2);
		expect(c.messages[1]).toEqual({ type: "delta", text: "still alive" });

		await c.close();
		await teardown(server, handler);
	});

	it("P11: drain() closes connections and clears heartbeat timer", async () => {
		const { server, handler, port } = await setup();

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		// Verify clients map is populated before drain
		const handlerInternal = handler as unknown as {
			clients: Map<string, WS>;
		};
		expect(handlerInternal.clients.size).toBe(1);

		await handler.drain();

		// After drain, internal clients map should be cleared
		expect(handlerInternal.clients.size).toBe(0);

		await new Promise<void>((r) => server.close(() => r()));
	});

	it("P12: WebSocketHandler registers with ServiceRegistry on construction", () => {
		const registry = new ServiceRegistry();
		expect(registry.size).toBe(0);

		const handler = new WebSocketHandler(registry, null, {
			heartbeatInterval: 60_000,
		});
		expect(registry.size).toBe(1);
		handler.close();
	});
});
