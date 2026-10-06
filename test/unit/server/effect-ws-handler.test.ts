import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import * as wsHandlerService from "../../../src/lib/domain/relay/Services/ws-handler-service.js";
import { makeWsHandlerStateLive } from "../../../src/lib/domain/relay/Services/ws-handler-service.js";
import {
	type EffectWsHandler,
	makeEffectWsHandler,
} from "../../../src/lib/server/effect-ws-handler.js";
import type {
	WsAttachOptions,
	WsClientConnectedEvent,
	WsClientDisconnectedEvent,
} from "../../../src/lib/server/ws-handler-shape.js";

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const fn of cleanup.reverse()) {
		await fn();
	}
	cleanup = [];
});

async function createHandler(
	options: Parameters<typeof makeEffectWsHandler>[0],
): Promise<EffectWsHandler> {
	const runtime = ManagedRuntime.make(makeWsHandlerStateLive());
	const handler = await runtime.runPromise(makeEffectWsHandler(options));
	cleanup.push(async () => {
		await handler.drain();
		await runtime.dispose();
	});
	return handler;
}

async function startServer(
	handler: EffectWsHandler,
	options: WsAttachOptions = { clientId: "test-client" },
): Promise<{
	server: Server;
	url: string;
}> {
	const server = createServer();
	const wss = new WebSocketServer({ noServer: true });
	server.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			handler.attach(ws, options);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				wss.close();
				server.close(() => resolve());
			}),
	);
	return { server, url: `ws://127.0.0.1:${addr.port}/ws` };
}

function onceConnected(
	handler: EffectWsHandler,
): Promise<WsClientConnectedEvent> {
	return new Promise((resolve) => handler.once("client_connected", resolve));
}

function onceDisconnected(
	handler: EffectWsHandler,
): Promise<WsClientDisconnectedEvent> {
	return new Promise((resolve) => handler.once("client_disconnected", resolve));
}

class TestWebSocket extends EventEmitter {
	readyState: number = WebSocket.OPEN;
	readonly send = vi.fn();
	readonly ping = vi.fn();
	readonly close = vi.fn(() => {
		this.readyState = WebSocket.CLOSED;
		this.emit("close");
	});

	asWebSocket(): WebSocket {
		return this as unknown as WebSocket;
	}
}

function waitOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		ws.once("open", () => resolve());
		ws.once("error", reject);
	});
}

describe("Effect WS handler bridge", () => {
	it("attaches and detaches an open socket without closing it", async () => {
		const addClient = vi.spyOn(wsHandlerService, "addClient");
		cleanup.push(() => addClient.mockRestore());
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const socket = new TestWebSocket();
		const connected = onceConnected(handler);
		const detach = handler.attach(socket.asWebSocket(), {
			clientId: "daemon-client",
			requestedSessionId: "session-a",
			skipDefaultSession: true,
		});
		const connectedInfo = await connected;
		const connection = addClient.mock.calls[0]?.[1];
		expect(connection).toBeDefined();
		expect(connectedInfo).toMatchObject({
			clientId: "daemon-client",
			requestedSessionId: "session-a",
			skipDefaultSession: true,
		});

		const disconnected = onceDisconnected(handler);
		const sentAtDetach = socket.send.mock.calls.length;
		detach();
		// A bootstrap/send effect that captured the old connection before detach
		// must lose access synchronously, before removeClient's fiber runs.
		connection?.send(JSON.stringify({ type: "session_list", sessions: [] }));
		connection?.close();
		connection?.ping?.();
		connection?.terminate?.();
		expect(socket.send).toHaveBeenCalledTimes(sentAtDetach);
		expect(socket.ping).not.toHaveBeenCalled();
		expect(await disconnected).toMatchObject({
			clientId: "daemon-client",
			clientCount: 0,
		});
		expect(socket.close).not.toHaveBeenCalled();
		expect(socket.readyState).toBe(WebSocket.OPEN);
		for (const event of ["message", "close", "error", "pong"]) {
			expect(socket.listenerCount(event)).toBe(0);
		}
		const sentBeforeBroadcast = socket.send.mock.calls.length;
		handler.broadcast({ type: "server_update", restartAvailable: true });
		detach();
		await handler.drain();
		expect(socket.send).toHaveBeenCalledTimes(sentBeforeBroadcast);
		expect(socket.close).not.toHaveBeenCalled();

		socket.emit(
			"message",
			Buffer.from(
				JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "b" }),
			),
		);
		await handler.drain();
		expect(socket.send).toHaveBeenCalledTimes(sentBeforeBroadcast);
	});

	it("drain closes sockets attached without an upgrade", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const socket = new TestWebSocket();
		const connected = onceConnected(handler);
		handler.attach(socket.asWebSocket(), { clientId: "daemon-client" });
		await connected;

		await handler.drain();

		expect(socket.close).toHaveBeenCalledWith(1001, "Server shutting down");
	});

	it("keeps the replacement socket registered when the previous one closes", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const first = new TestWebSocket();
		const second = new TestWebSocket();
		const firstConnected = onceConnected(handler);
		handler.attach(first.asWebSocket(), { clientId: "same-client" });
		await firstConnected;

		const secondConnected = onceConnected(handler);
		handler.attach(second.asWebSocket(), { clientId: "same-client" });
		await secondConnected;
		handler.setClientSession("same-client", "session-b");
		const disconnected = vi.fn();
		handler.on("client_disconnected", disconnected);

		first.close();
		await new Promise<void>((resolve) => setImmediate(resolve));
		handler.broadcast({ type: "server_update", restartAvailable: true });

		await vi.waitFor(() => {
			expect(second.send).toHaveBeenCalledWith(
				JSON.stringify({ type: "server_update", restartAvailable: true }),
			);
		});
		expect(handler.getClientIds()).toEqual(["same-client"]);
		expect(handler.getClientSession("same-client")).toBe("session-b");
		expect(handler.getClientsForSession("session-b")).toEqual(["same-client"]);
		expect(disconnected).not.toHaveBeenCalled();

		const secondDisconnected = onceDisconnected(handler);
		second.close();
		expect(await secondDisconnected).toMatchObject({
			clientId: "same-client",
			clientCount: 0,
			sessionId: "session-b",
		});
		expect(disconnected).toHaveBeenCalledTimes(1);
		expect(handler.getClientCount()).toBe(0);
	});

	it("ignores raw inbound frames without replying or disconnecting", async () => {
		// Every browser request is an @effect/rpc call; the raw socket carries no
		// requests, so a stray frame earns no system_error reply (fork 3.2).
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const { url } = await startServer(handler, {
			clientId: "test-client",
			requestedSessionId: "s1",
		});
		const connected = onceConnected(handler);
		const client = new WebSocket(url);
		cleanup.push(() => client.close());
		await waitOpen(client);
		await connected;

		const replies: unknown[] = [];
		client.on("message", (data) => replies.push(JSON.parse(data.toString())));
		client.send(
			JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "x" }),
		);
		client.send("not json{");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(replies).toEqual([]);
		expect(handler.getClientCount()).toBe(1);
	});

	it("updates viewer state synchronously when binding a client to a session", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const { url } = await startServer(handler);
		const connected = onceConnected(handler);
		const client = new WebSocket(url);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const { clientId } = await connected;

		handler.setClientSession(clientId, "sess-1");

		expect(handler.getClientSession(clientId)).toBe("sess-1");
		expect(handler.getClientsForSession("sess-1")).toEqual([clientId]);
	});

	it("uses the client id supplied when attaching", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const { url } = await startServer(handler, { clientId: "browser-tab-1" });
		const connected = onceConnected(handler);
		const client = new WebSocket(url);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const connectedInfo = await connected;

		expect(connectedInfo.clientId).toBe("browser-tab-1");
		expect(handler.getClientIds()).toEqual(["browser-tab-1"]);
	});
});
