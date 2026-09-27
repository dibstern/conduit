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
	WsMessageEvent,
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

function onceMessage(handler: EffectWsHandler): Promise<WsMessageEvent> {
	return new Promise((resolve) => handler.once("message", resolve));
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

function waitForMessage(
	ws: WebSocket,
	predicate: (msg: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
	return new Promise((resolve) => {
		ws.on("message", (data) => {
			const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
			if (predicate(parsed)) resolve(parsed);
		});
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

		const delivered = vi.fn();
		handler.on("message", delivered);
		socket.emit(
			"message",
			Buffer.from(
				JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "a" }),
			),
		);
		expect(delivered).toHaveBeenCalledTimes(1);

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
		handler.broadcast({ type: "client_count", count: 99 });
		detach();
		await handler.drain();
		expect(socket.send).toHaveBeenCalledTimes(sentBeforeBroadcast);
		expect(socket.close).not.toHaveBeenCalled();

		delivered.mockClear();
		socket.emit(
			"message",
			Buffer.from(
				JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "b" }),
			),
		);
		expect(delivered).not.toHaveBeenCalled();
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

	it("emits routed messages for attached connections", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const { url } = await startServer(handler, {
			clientId: "test-client",
			requestedSessionId: "s1",
		});
		const connected = onceConnected(handler);
		const client = new WebSocket(url);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const connectedInfo = await connected;
		expect(connectedInfo.requestedSessionId).toBe("s1");
		expect(connectedInfo.clientCount).toBe(1);

		const message = onceMessage(handler);
		client.send(
			JSON.stringify({ type: "pty_input", ptyId: "pty-1", data: "x" }),
		);
		const routed = await message;

		expect(routed.clientId).toBe(connectedInfo.clientId);
		expect(routed.handler).toBe("pty_input");
		expect(routed.payload).toEqual({ ptyId: "pty-1", data: "x" });
	});

	it("sends system_error for invalid JSON without disconnecting", async () => {
		const handler = await createHandler({ heartbeatInterval: 300_000 });
		const { url } = await startServer(handler);
		const client = new WebSocket(url);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const errorMessage = waitForMessage(
			client,
			(msg) => msg["type"] === "system_error",
		);
		client.send("not json{");
		const msg = await errorMessage;

		expect(msg).toMatchObject({
			type: "system_error",
			code: "PARSE_ERROR",
		});
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
