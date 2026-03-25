// ─── WebSocket Handler Per-Client Session Tracking Tests (Task 8) ────────────

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
				// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
				if (messages.length >= waiters[i]!.n) {
					// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
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

async function setup(): Promise<{
	server: Server;
	handler: WebSocketHandler;
	port: number;
}> {
	const server = createServer();
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const handler = new WebSocketHandler(new ServiceRegistry(), server, {
		heartbeatInterval: 60_000,
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

describe("Per-client session tracking", () => {
	it("S1: setClientSession and getClientSession round-trip", async () => {
		const { server, handler, port } = await setup();

		let clientId = "";
		handler.once("client_connected", (evt) => {
			clientId = evt.clientId;
		});

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		expect(clientId).not.toBe("");

		// Before setting, should be undefined
		expect(handler.getClientSession(clientId)).toBeUndefined();

		// Set and retrieve
		handler.setClientSession(clientId, "session-abc");
		expect(handler.getClientSession(clientId)).toBe("session-abc");

		// Overwrite with a different session
		handler.setClientSession(clientId, "session-xyz");
		expect(handler.getClientSession(clientId)).toBe("session-xyz");

		await c.close();
		await teardown(server, handler);
	});

	it("S2: getClientsForSession returns only matching clients", async () => {
		const { server, handler, port } = await setup();

		const clientIds: string[] = [];
		handler.on("client_connected", ({ clientId }) => clientIds.push(clientId));

		// Connect 3 clients
		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1);

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1);
		await c1.waitForMessages(2);

		const c3 = await createBufferedClient(port);
		await c3.waitForMessages(1);
		await c1.waitForMessages(3);
		await c2.waitForMessages(2);

		// Assign sessions: c1 and c3 → session-A, c2 → session-B
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[0]!, "session-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[1]!, "session-B");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[2]!, "session-A");

		const sessionAClients = handler.getClientsForSession("session-A");
		expect(sessionAClients).toHaveLength(2);
		expect(sessionAClients).toContain(clientIds[0]);
		expect(sessionAClients).toContain(clientIds[2]);

		const sessionBClients = handler.getClientsForSession("session-B");
		expect(sessionBClients).toHaveLength(1);
		expect(sessionBClients).toContain(clientIds[1]);

		await c1.close();
		await c2.close();
		await c3.close();
		await teardown(server, handler);
	});

	it("S3: sendToSession sends only to session viewers", async () => {
		const { server, handler, port } = await setup();

		const clientIds: string[] = [];
		handler.on("client_connected", ({ clientId }) => clientIds.push(clientId));

		// Connect 3 clients
		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1); // count=1

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1); // count=2
		await c1.waitForMessages(2); // count=2 for c1

		const c3 = await createBufferedClient(port);
		await c3.waitForMessages(1); // count=3
		await c1.waitForMessages(3); // count=3 for c1
		await c2.waitForMessages(2); // count=3 for c2

		// c1 and c3 view session-A; c2 views session-B
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[0]!, "session-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[1]!, "session-B");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[2]!, "session-A");

		// Send to session-A only
		handler.sendToSession("session-A", {
			type: "delta",
			text: "session-A update",
		});

		// c1 and c3 should receive the message
		await c1.waitForMessages(4);
		await c3.waitForMessages(2);
		expect(c1.messages[3]).toEqual({
			type: "delta",
			text: "session-A update",
		});
		expect(c3.messages[1]).toEqual({
			type: "delta",
			text: "session-A update",
		});

		// c2 should NOT have received it
		await new Promise((r) => setTimeout(r, 100));
		// c2 has: count=2, count=3 → 2 messages total
		expect(c2.messages.length).toBe(2);
		expect(c2.messages.every((m) => m["type"] === "client_count")).toBe(true);

		await c1.close();
		await c2.close();
		await c3.close();
		await teardown(server, handler);
	});

	it("S4: disconnect removes client from clientSessions map", async () => {
		const { server, handler, port } = await setup();

		let clientId = "";
		handler.once("client_connected", (evt) => {
			clientId = evt.clientId;
		});

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count
		expect(clientId).not.toBe("");

		handler.setClientSession(clientId, "session-abc");
		expect(handler.getClientSession(clientId)).toBe("session-abc");
		expect(handler.getClientsForSession("session-abc")).toContain(clientId);

		// Disconnect the client
		await c.close();
		await vi.waitFor(() => {
			expect(handler.getClientSession(clientId)).toBeUndefined();
		});

		// Session mapping should be cleaned up
		expect(handler.getClientsForSession("session-abc")).toHaveLength(0);

		await teardown(server, handler);
	});

	it("S5: getClientsForSession returns empty array for unknown session", async () => {
		const { server, handler, port } = await setup();

		const c = await createBufferedClient(port);
		await c.waitForMessages(1); // client_count

		// No sessions have been set — querying any session should return empty
		expect(handler.getClientsForSession("nonexistent-session")).toEqual([]);

		await c.close();
		await teardown(server, handler);
	});

	it("S7: close() clears clientSessions map synchronously", async () => {
		const { server, handler, port } = await setup();

		const clientIds: string[] = [];
		handler.on("client_connected", ({ clientId }) => clientIds.push(clientId));

		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1);

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1);
		await c1.waitForMessages(2);

		// Assign sessions
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[0]!, "session-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[1]!, "session-B");

		// Verify they're set
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(handler.getClientSession(clientIds[0]!)).toBe("session-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(handler.getClientSession(clientIds[1]!)).toBe("session-B");

		// close() should clear clientSessions synchronously (not rely on
		// async close events from individual connections)
		handler.close();

		// Check IMMEDIATELY — before close events could fire
		expect(handler.getClientsForSession("session-A")).toHaveLength(0);
		expect(handler.getClientsForSession("session-B")).toHaveLength(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(handler.getClientSession(clientIds[0]!)).toBeUndefined();
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		expect(handler.getClientSession(clientIds[1]!)).toBeUndefined();

		await new Promise((r) => setTimeout(r, 200));
		await new Promise<void>((r) => server.close(() => r()));
	});

	it("S6: sendToSession is a no-op when no clients view the session", async () => {
		const { server, handler, port } = await setup();

		const clientIds: string[] = [];
		handler.on("client_connected", ({ clientId }) => clientIds.push(clientId));

		const c1 = await createBufferedClient(port);
		await c1.waitForMessages(1); // count=1

		const c2 = await createBufferedClient(port);
		await c2.waitForMessages(1); // count=2
		await c1.waitForMessages(2); // count=2 for c1

		// Assign both to session-A
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[0]!, "session-A");
		// biome-ignore lint/style/noNonNullAssertion: safe — index within bounds
		handler.setClientSession(clientIds[1]!, "session-A");

		// Send to a session that no one is viewing — should not throw or crash
		expect(() => {
			handler.sendToSession("session-nobody", {
				type: "delta",
				text: "lost message",
			});
		}).not.toThrow();

		// Verify clients are still functional and received nothing extra
		// At this point c1 has: count=1, count=2 → 2 messages
		// c2 has: count=2 → 1 message
		// (c2 connected second, only sees count=2)
		const c1Before = c1.messages.length;
		const c2Before = c2.messages.length;

		handler.broadcast({ type: "delta", text: "broadcast check" });
		await c1.waitForMessages(c1Before + 1);
		await c2.waitForMessages(c2Before + 1);
		expect(c1.messages[c1Before]).toEqual({
			type: "delta",
			text: "broadcast check",
		});
		expect(c2.messages[c2Before]).toEqual({
			type: "delta",
			text: "broadcast check",
		});

		await c1.close();
		await c2.close();
		await teardown(server, handler);
	});
});
