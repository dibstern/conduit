import { mkdtempSync, rmSync } from "node:fs";
import { type IncomingHttpHeaders, IncomingMessage } from "node:http";
import { Socket as NetSocket } from "node:net";
import { TLSSocket } from "node:tls";
import { describe, it } from "@effect/vitest";
import { Effect, Queue } from "effect";
import { RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { SocketServer } from "effect/socket";
import { afterEach, expect, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { UpdateMessageSurfacing } from "../../../src/lib/contracts/ws-rpc.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { RpcCaller } from "../../../src/lib/server/ws-rpc.js";
import { WsRpcWebSocketHandler } from "../../../src/lib/server/ws-rpc-handler.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";
import { makeFakeSocketServer } from "../../helpers/fake-socket-server.js";

const directories: string[] = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

// Failure modes: malformed secrets in nested objects/arrays or invalid sibling
// fields leak before handlers run; proxy headers bypass the peer trust boundary;
// trusted HTTPS or direct TLS loses its security context before a key save.
describe("message surfacing RPC security", () => {
	for (const { name, payload } of [
		{
			name: "a nested key",
			payload: { apiKey: { value: "fake-secret-canary" } },
		},
		{ name: "an array key", payload: { apiKey: ["fake-secret-canary"] } },
		{
			name: "an invalid sibling",
			payload: { apiKey: "fake-secret-canary", recap: { model: "invalid" } },
		},
		{
			name: "a secret-bearing sibling",
			payload: {
				apiKey: "fake-secret-canary",
				enabled: { value: "fake-secret-canary" },
			},
		},
	]) {
		it.effect(`redacts encoded validation failures for ${name}`, () =>
			Effect.gen(function* () {
				const group = RpcGroup.make(UpdateMessageSurfacing);
				const update = vi.fn(() =>
					Effect.die("Invalid payload reached handler"),
				);
				const connection = yield* makeFakeSocketServer;
				yield* RpcServer.make(group).pipe(
					Effect.provide(RpcServer.layerProtocolSocketServer),
					Effect.provideService(
						SocketServer.SocketServer,
						connection.socketServer,
					),
					Effect.provide(group.toLayer({ UpdateMessageSurfacing: update })),
					Effect.provide(RpcSerialization.layerJson),
					Effect.forkScoped,
				);
				const responses = yield* Queue.unbounded<unknown>();
				yield* Effect.gen(function* () {
					const reader = yield* connection.clientSocket.reader;
					while (true) {
						const chunks = yield* reader.pull;
						for (const data of chunks)
							yield* Queue.offer(
								responses,
								JSON.parse(
									typeof data === "string"
										? data
										: new TextDecoder().decode(data),
								),
							);
					}
				}).pipe(Effect.forkScoped);
				const write = yield* connection.clientSocket.writer;
				yield* write.write(
					JSON.stringify({
						_tag: "Request",
						id: "1",
						tag: "UpdateMessageSurfacing",
						payload: { _tag: "UpdateMessageSurfacing", ...payload },
						headers: [],
					}),
				);
				const response = yield* Queue.take(responses);
				expect(response).toMatchObject({
					_tag: "Exit",
					exit: { _tag: "Failure" },
				});
				expect(JSON.stringify(response)).toContain(
					"Invalid message surfacing settings",
				);
				expect(connection.clientFrames.join("")).toContain(
					"fake-secret-canary",
				);
				expect(connection.serverFrames.join("")).not.toContain(
					"fake-secret-canary",
				);
				expect(update).not.toHaveBeenCalled();
			}),
		);
	}

	const cases: ReadonlyArray<{
		name: string;
		peer: string;
		headers: IncomingHttpHeaders;
		tls?: boolean;
		allowed: boolean;
	}> = [
		{
			name: "IPv4 loopback HTTPS proxy",
			peer: "127.0.0.1",
			headers: { "x-forwarded-proto": "https" },
			allowed: true,
		},
		{
			name: "IPv6 loopback HTTPS proxy",
			peer: "::1",
			headers: { "x-forwarded-proto": "https" },
			allowed: true,
		},
		{
			name: "mapped loopback HTTPS proxy",
			peer: "::ffff:127.0.0.1",
			headers: { "x-forwarded-proto": "https" },
			allowed: true,
		},
		{
			name: "loopback subnet HTTPS proxy",
			peer: "127.0.0.2",
			headers: { "x-forwarded-proto": "https" },
			allowed: true,
		},
		{
			name: "loopback HTTP proxy",
			peer: "127.0.0.1",
			headers: { "x-forwarded-proto": "http" },
			allowed: false,
		},
		{
			name: "loopback proxy without protocol",
			peer: "127.0.0.1",
			headers: {},
			allowed: false,
		},
		{
			name: "ambiguous protocol chain",
			peer: "127.0.0.1",
			headers: { "x-forwarded-proto": "https, http" },
			allowed: false,
		},
		{
			name: "ambiguous protocol array",
			peer: "127.0.0.1",
			headers: { "x-forwarded-proto": ["https", "http"] },
			allowed: false,
		},
		{
			name: "remote spoofed HTTPS proxy",
			peer: "192.0.2.2",
			headers: { "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" },
			allowed: false,
		},
		{
			name: "loopback-looking remote peer",
			peer: "127.example",
			headers: { "x-forwarded-proto": "https" },
			allowed: false,
		},
		{
			name: "direct remote HTTP",
			peer: "192.0.2.2",
			headers: {},
			allowed: false,
		},
		{
			name: "direct remote TLS",
			peer: "192.0.2.2",
			headers: {},
			tls: true,
			allowed: true,
		},
	];
	for (const { name, peer, headers, tls, allowed } of cases) {
		it.effect(`guards a key save through ${name}`, () => {
			const dir = mkdtempSync("/tmp/surfacing-rpc-");
			directories.push(dir);
			return Effect.gen(function* () {
				const handlers = yield* DaemonWsRpcHandlersTag;
				const wss = new WebSocketServer({ noServer: true });
				const socket = tls ? new TLSSocket(new NetSocket()) : new NetSocket();
				Object.defineProperty(socket, "remoteAddress", { value: peer });
				const request = new IncomingMessage(socket);
				request.headers = { "x-forwarded-for": "192.0.2.1", ...headers };
				// ws's declarations omit the options required by its server constructor.
				const ws: WebSocket = Reflect.construct(WebSocket, [
					null,
					undefined,
					{},
				]);
				const runConnection = vi.fn(
					(_ws: WebSocket, ip: string, secure?: boolean) => ({
						kind: "browser" as const,
						ip,
						secure,
					}),
				);
				new WsRpcWebSocketHandler(undefined, {
					transport: {
						wss,
						handleUpgrade: () => Effect.die("Unexpected upgrade"),
					},
					runConnection,
					runTransportFork: () => {
						throw new Error("Unexpected transport fork");
					},
				});
				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						ws.emit("close");
						wss.close();
						socket.destroy();
					}),
				);
				wss.emit("connection", ws, request);
				const caller = runConnection.mock.results[0]?.value;
				if (!caller) throw new Error("Connection did not supply an RPC caller");
				expect(caller.ip).toBe(
					peer === "192.0.2.2" || peer === "127.example" ? peer : "192.0.2.1",
				);
				const result = yield* handlers
					.UpdateMessageSurfacing(
						UpdateMessageSurfacing.payloadSchema.make({
							apiKey: "fake-secret-canary",
						}),
					)
					.pipe(Effect.provideService(RpcCaller, caller), Effect.result);
				expect(result).toMatchObject(
					allowed
						? {
								_tag: "Success",
								success: { key: { source: "stored", rejected: false } },
							}
						: {
								_tag: "Failure",
								failure: {
									message: "Saving a TypeSafe key requires TLS or loopback",
								},
							},
				);
			}).pipe(
				Effect.provide(
					makeDaemonRpcTestLayer([], undefined, {
						configDir: dir,
						messageSurfacing: {
							env: {},
							transport: async () => new Response(null, { status: 200 }),
						},
					}),
				),
			);
		});
	}
});
