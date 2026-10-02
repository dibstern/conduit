import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import {
	createConnection,
	createServer,
	type Server,
	type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "@effect/rpc";
import { Deferred, Effect, Mailbox, Option, Ref } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GetProjects,
	RestartWithConfig,
	Shutdown,
	WsRpcError,
	WsRpcGroup,
} from "../../../src/lib/contracts/ws-rpc.js";
import { sendRpcRequest } from "../../../src/lib/daemon/daemon-rpc-client.js";
import {
	DaemonRpcSocketTag,
	makeDaemonRpcSocketLayer,
	withRpcShutdownResponse,
} from "../../../src/lib/daemon/daemon-rpc-server.js";
import { ShutdownSignalTag } from "../../../src/lib/domain/daemon/Layers/daemon-layers.js";
import { DaemonWsRpcHandlersTag } from "../../../src/lib/domain/daemon/Layers/daemon-ws-rpc-layer.js";
import { DaemonConfigRefTag } from "../../../src/lib/domain/daemon/Services/daemon-config-ref.js";
import { DaemonStateTag } from "../../../src/lib/domain/daemon/Services/daemon-state.js";
import {
	type DaemonRpcHandlers,
	makeRoutedWsRpcServerLayer,
} from "../../../src/lib/server/ws-rpc.js";
import { makeDaemonRpcTestLayer } from "../../helpers/daemon-rpc.js";

describe("committed daemon shutdown replies", () => {
	for (const command of ["Shutdown", "RestartWithConfig"] as const) {
		it(`completes ${command} when the requester disconnects before its reply is written`, async () => {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const signal = yield* ShutdownSignalTag;
						const handlers = yield* DaemonWsRpcHandlersTag;
						const replyAttempted = yield* Deferred.make<void>();
						const disconnects = yield* Mailbox.make<number>();
						const protocol = RpcServer.Protocol.of({
							run: (handle) =>
								handle(1, {
									_tag: "Request",
									id: "1",
									tag: command,
									payload: { _tag: command },
									headers: [],
								}).pipe(Effect.zipRight(Effect.never)),
							disconnects,
							send: (_clientId, response) =>
								Effect.gen(function* () {
									expect(response).toMatchObject({
										_tag: "Exit",
										exit: { _tag: "Success", value: { ok: true } },
									});
									yield* Deferred.succeed(replyAttempted, undefined);
									return yield* Effect.die(new Error("requester disconnected"));
								}),
							end: () => Effect.void,
							clientIds: Effect.succeed(new Set([1])),
							initialMessage: Effect.succeed(Option.none()),
							supportsAck: false,
							supportsTransferables: false,
							supportsSpanPropagation: false,
						});
						yield* RpcServer.make(WsRpcGroup).pipe(
							Effect.provideService(
								RpcServer.Protocol,
								withRpcShutdownResponse(protocol, () =>
									Deferred.succeed(signal, undefined).pipe(Effect.asVoid),
								),
							),
							Effect.provide(
								makeRoutedWsRpcServerLayer(
									() => Effect.die("Unexpected project routing"),
									handlers,
								),
							),
							Effect.interruptible,
							Effect.forkScoped,
						);
						yield* Deferred.await(replyAttempted).pipe(
							Effect.timeout("1 second"),
						);
						expect((yield* Ref.get(yield* DaemonStateTag)).shuttingDown).toBe(
							true,
						);
						expect(
							(yield* Ref.get(yield* DaemonConfigRefTag)).shuttingDown,
						).toBe(true);
						yield* Deferred.await(signal).pipe(Effect.timeout("250 millis"));
					}),
				).pipe(Effect.provide(makeDaemonRpcTestLayer())),
			);
		});
	}
});

describe("daemon Unix RPC transport", () => {
	let directory: string;
	let server: Server | undefined;
	const sockets = new Set<Socket>();

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "conduit-rpc-"));
	});

	afterEach(async () => {
		for (const socket of sockets) socket.destroy();
		sockets.clear();
		if (server) {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
			server = undefined;
		}
		await rm(directory, { recursive: true, force: true });
	});

	it("rejects when the daemon socket never becomes ready", async () => {
		await expect(
			sendRpcRequest(join(directory, "missing.sock"), new GetProjects({}), {
				startupRetries: 1,
			}),
		).rejects.toThrow();
	});

	it("rejects a stale, refused socket after startup retries", async () => {
		const path = join(directory, "stale.sock");
		execFileSync(process.execPath, [
			"-e",
			"const net = require('node:net'); net.createServer().listen(process.argv[1], () => process.exit(0))",
			path,
		]);
		expect((await stat(path)).isSocket()).toBe(true);
		await expect(
			sendRpcRequest(path, new GetProjects({}), { startupRetries: 1 }),
		).rejects.toMatchObject({ code: "ECONNREFUSED" });
	});

	it("rejects malformed RPC framing instead of hanging", async () => {
		const path = join(directory, "malformed.sock");
		server = createServer((socket) => {
			sockets.add(socket);
			socket.write("not-json\n");
			socket.end();
		});
		await new Promise<void>((resolve) => server?.listen(path, resolve));
		await expect(
			sendRpcRequest(path, new GetProjects({}), { requestTimeoutMs: 500 }),
		).rejects.toMatchObject({
			reason: "Protocol",
			message: "Error decoding message",
		});
	});

	it("never replays a request after its response times out", async () => {
		const path = join(directory, "timeout.sock");
		let requests = 0;
		let received = "";
		server = createServer((socket) => {
			sockets.add(socket);
			let buffer = "";
			socket.on("data", (chunk: Buffer) => {
				received += chunk.toString();
				buffer += chunk.toString();
				for (;;) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.includes('"_tag":"Request"')) requests++;
				}
			});
		});
		await new Promise<void>((resolve) => server?.listen(path, resolve));
		await expect(
			sendRpcRequest(path, new Shutdown({}), { requestTimeoutMs: 50 }),
		).rejects.toThrow("RPC Shutdown timed out");
		expect(requests, received).toBe(1);
	});

	it("serves the shared RPC group, preserves typed errors, and removes its 0600 socket", async () => {
		const path = join(directory, "rpc.sock");
		const shutdownCallbacks: string[] = [];
		let shutdownDrain: Effect.Effect<void> = Effect.void;
		const daemonHandlers = {
			GetProjects: (request: GetProjects) =>
				request.projectSlug === "fail"
					? Effect.fail(new WsRpcError({ message: "expected failure" }))
					: Effect.succeed({ projectSlug: request.projectSlug, projects: [] }),
			Shutdown: () => Effect.succeed({ ok: true as const }),
			RestartWithConfig: () =>
				Effect.fail(new WsRpcError({ message: "restart rejected" })),
		};
		const handlers = makeRoutedWsRpcServerLayer(
			() => Effect.fail(new WsRpcError({ message: "not routed" })),
			// This fixture exercises only these daemon methods; all other routes
			// retain the existing handlers and fail at the resolver above.
			daemonHandlers as unknown as DaemonRpcHandlers,
		);
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const service = yield* DaemonRpcSocketTag;
					shutdownDrain = service.drain;
					expect(service.socketPath).toBe(path);
					const metadata = yield* Effect.promise(() => stat(path));
					expect(metadata.mode & 0o777).toBe(0o600);
					const result = yield* Effect.promise(() =>
						sendRpcRequest(path, new GetProjects({})),
					);
					expect(result).toEqual({
						projects: [],
					});
					yield* Effect.promise(() =>
						expect(
							sendRpcRequest(path, new GetProjects({ projectSlug: "fail" })),
						).rejects.toMatchObject({
							_tag: "WsRpcError",
							message: "expected failure",
						}),
					);
					yield* Effect.promise(() =>
						expect(
							sendRpcRequest(path, new RestartWithConfig({})),
						).rejects.toMatchObject({ message: "restart rejected" }),
					);
					expect(shutdownCallbacks).toEqual([]);
					const shutdown = yield* Effect.promise(() =>
						sendRpcRequest(path, new Shutdown({})),
					);
					expect(shutdown).toEqual({ ok: true });
					yield* Effect.sleep("20 millis");
					expect(shutdownCallbacks).toEqual(["Shutdown"]);
					const idleClient = yield* Effect.promise(
						() =>
							new Promise<Socket>((resolve, reject) => {
								const client = createConnection(path);
								client.once("connect", () => resolve(client));
								client.once("error", reject);
							}),
					);
					yield* Effect.sleep("20 millis");
					const closed = new Promise<void>((resolve) =>
						idleClient.once("close", () => resolve()),
					);
					yield* service.drain;
					yield* Effect.promise(() => closed);
					expect(idleClient.destroyed).toBe(true);
				}),
			).pipe(
				Effect.provide(
					makeDaemonRpcSocketLayer(path, handlers, {
						onSuccessfulShutdownResponse: (tag) =>
							Effect.sync(() => {
								shutdownCallbacks.push(tag);
							}).pipe(Effect.zipRight(shutdownDrain)),
					}),
				),
			),
		);
		await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
