import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EffectWsHandler } from "../../../src/lib/server/effect-ws-handler.js";
import type {
	WsClientConnectedEvent,
	WsMessageEvent,
} from "../../../src/lib/server/ws-handler-shape.js";

let cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const fn of cleanup.reverse()) {
		await fn();
	}
	cleanup = [];
});

async function startServer(handler: EffectWsHandler): Promise<{
	server: Server;
	url: string;
}> {
	const server = createServer();
	server.on("upgrade", (req, socket, head) => {
		handler.handleUpgrade(req, socket, head);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address() as AddressInfo;
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
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
	it("upgrades connections and emits routed client messages", async () => {
		const handler = new EffectWsHandler({ heartbeatInterval: 300_000 });
		cleanup.push(() => handler.drain());
		const { url } = await startServer(handler);
		const connected = onceConnected(handler);
		const client = new WebSocket(`${url}?session=s1`);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const connectedInfo = await connected;
		expect(connectedInfo.requestedSessionId).toBe("s1");
		expect(connectedInfo.clientCount).toBe(1);

		const message = onceMessage(handler);
		client.send(JSON.stringify({ type: "view_session", sessionId: "s1" }));
		const routed = await message;

		expect(routed.clientId).toBe(connectedInfo.clientId);
		expect(routed.handler).toBe("view_session");
		expect(routed.payload).toEqual({ sessionId: "s1" });
	});

	it("sends system_error for invalid JSON without disconnecting", async () => {
		const handler = new EffectWsHandler({ heartbeatInterval: 300_000 });
		cleanup.push(() => handler.drain());
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
		const handler = new EffectWsHandler({ heartbeatInterval: 300_000 });
		cleanup.push(() => handler.drain());
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

	it("uses the browser-provided client id when present", async () => {
		const handler = new EffectWsHandler({ heartbeatInterval: 300_000 });
		cleanup.push(() => handler.drain());
		const { url } = await startServer(handler);
		const connected = onceConnected(handler);
		const client = new WebSocket(`${url}?client=browser-tab-1`);
		cleanup.push(() => client.close());

		await waitOpen(client);
		const connectedInfo = await connected;

		expect(connectedInfo.clientId).toBe("browser-tab-1");
		expect(handler.getClientIds()).toEqual(["browser-tab-1"]);
	});
});
