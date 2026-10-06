/**
 * Acceptance 3 of conduit-test-ni8.11, measured: a sustained PTY output storm
 * does not stall unary calls, and coalescing is engaged — the wire carries one
 * chunk (and one client ack) per 50 ms window, not one per write.
 *
 * Worst case on purpose: the storm and the unary probes share ONE connection,
 * with the real JSON serialization and the real server handlers and terminal
 * service. Production splits them across the control and stream sockets.
 */
import { Socket, SocketServer } from "@effect/platform";
import { RpcClient, RpcSerialization, RpcServer } from "@effect/rpc";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type {
	LocalPtyService,
	LocalPtySession,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import { makeFakeSocketServer } from "../../helpers/fake-socket-server.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const TICKS = 200;
const WRITES_PER_TICK = 10;
const WRITES = TICKS * WRITES_PER_TICK;
const PROBES = 20;
/** Generous: a stalled server shows up as seconds, not tens of milliseconds. */
const UNARY_BOUND_MS = 1_000;

describe("PTY output storm", () => {
	it("keeps unary round trips bounded and batches output per window", async () => {
		let emitData: (data: string) => void = () => undefined;
		const upstream = {
			readyState: 1,
			send: vi.fn(),
			close: vi.fn(),
			terminate: vi.fn(),
			resize: vi.fn(),
		};
		const session: LocalPtySession = {
			pty: {
				id: "pty-1",
				title: "Shell",
				command: "zsh",
				cwd: "/repo",
				status: "running",
				pid: 1,
			},
			upstream,
			onData: (handler) => {
				emitData = handler;
			},
			onExit: () => undefined,
		};
		const localPty: LocalPtyService = {
			list: () => Effect.succeed([session.pty]),
			attach: () => Effect.die("Unexpected attach in storm test"),
			create: () => Effect.succeed(session),
		};
		const api = makeMockOpenCodeAPI();
		api.pty.list = vi.fn(async () => []);
		const handlers = WsRpcServerLayer.pipe(
			Layer.provideMerge(
				makeTestHandlerLayer({
					api,
					localPty,
					ptyManager: new PtyManager({ log: makeMockLogger() }),
				}),
			),
		);

		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const connection = yield* makeFakeSocketServer;
					yield* RpcServer.make(WsRpcGroup, { concurrency: 32 }).pipe(
						Effect.provide(RpcServer.layerProtocolSocketServer),
						Effect.provideService(
							SocketServer.SocketServer,
							connection.socketServer,
						),
						Effect.provide(handlers),
						Effect.provide(RpcSerialization.layerJson),
						Effect.forkScoped,
					);
					const protocol = yield* Layer.build(
						RpcClient.layerProtocolSocket().pipe(
							Layer.provide(
								Layer.succeed(Socket.Socket, connection.clientSocket),
							),
							Layer.provide(RpcSerialization.layerJson),
						),
					);
					const client = yield* RpcClient.make(WsRpcGroup).pipe(
						Effect.provide(protocol),
					);

					yield* client.CreatePty({ projectSlug: "p", originId: "tab-a" });
					const synchronized = yield* Deferred.make<void>();
					let received = "";
					let outputEnvelopes = 0;
					const subscription = yield* client
						.SubscribePtys({ projectSlug: "p" })
						.pipe(
							Stream.runForEach((envelope) =>
								Effect.gen(function* () {
									if (envelope._tag === "synchronized")
										yield* Deferred.succeed(synchronized, undefined);
									if (envelope._tag === "output") {
										outputEnvelopes++;
										received += envelope.data;
									}
								}),
							),
							Effect.forkScoped,
						);
					yield* Deferred.await(synchronized);

					const expected: string[] = [];
					const storm = yield* Effect.forkScoped(
						Effect.gen(function* () {
							for (let tick = 0; tick < TICKS; tick++) {
								for (let i = 0; i < WRITES_PER_TICK; i++) {
									const data = `${tick}.${i} ${"x".repeat(64)}\r\n`;
									expected.push(data);
									emitData(data);
								}
								yield* Effect.sleep("5 millis");
							}
						}),
					);
					const roundTrips: number[] = [];
					for (let probe = 0; probe < PROBES; probe++) {
						const started = performance.now();
						yield* client.PtyInput({
							projectSlug: "p",
							ptyId: "pty-1",
							data: String(probe % 10),
						});
						roundTrips.push(performance.now() - started);
						yield* Effect.sleep("40 millis");
					}
					yield* Fiber.join(storm);
					const all = expected.join("");
					while (received.length < all.length) yield* Effect.sleep("20 millis");
					yield* Fiber.interrupt(subscription);

					const frames = (raw: readonly string[], tag: string) =>
						raw
							.flatMap((frame) => frame.split("\n"))
							.filter((line) => line.length > 0)
							.flatMap((line): Array<{ _tag: string }> => {
								const parsed = JSON.parse(line);
								return Array.isArray(parsed) ? parsed : [parsed];
							})
							.filter((frame) => frame._tag === tag).length;
					const chunks = frames(connection.serverFrames, "Chunk");
					const acks = frames(connection.clientFrames, "Ack");
					// console.info is silenced by test/setup.ts; this line is the evidence.
					console.log(
						`pty storm: writes=${WRITES} outputEnvelopes=${outputEnvelopes} chunks=${chunks} acks=${acks} unary max=${Math.max(...roundTrips).toFixed(1)}ms p50=${[...roundTrips].sort((a, b) => a - b)[PROBES / 2]?.toFixed(1)}ms`,
					);

					expect(received).toBe(all);
					expect(upstream.send.mock.calls.map(([data]) => data)).toEqual(
						Array.from({ length: PROBES }, (_, probe) => String(probe % 10)),
					);
					expect(Math.max(...roundTrips)).toBeLessThan(UNARY_BOUND_MS);
					expect(WRITES / outputEnvelopes).toBeGreaterThanOrEqual(10);
					expect(acks).toBeLessThanOrEqual(chunks);
					expect(WRITES / Math.max(acks, 1)).toBeGreaterThanOrEqual(10);
				}),
			).pipe(Effect.timeout("30 seconds")),
		);
	}, 60_000);
});
