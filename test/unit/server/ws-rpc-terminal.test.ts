import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Layer, Stream } from "effect";
import { expect, vi } from "vitest";
import { WsRpcError, WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	type LocalPtyService,
	type LocalPtySession,
	TerminalServiceError,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	MOCK_PROJECT_DIR,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer terminal controls", () => {
	it.effect(
		"lists PTYs through the terminal service and reconnects running upstreams",
		() => {
			const api = makeMockOpenCodeAPI();
			api.pty.list = vi.fn(async () => [
				{
					id: "pty-1",
					title: "Shell",
					command: "zsh",
					cwd: "/repo",
					status: "running",
					pid: 123,
				},
			]);
			api.pty.create = vi.fn(async () => ({ id: "pty-2" }));
			api.pty.delete = vi.fn(async () => undefined);
			api.pty.resize = vi.fn(async () => undefined);
			const wsHandler = makeMockWebSocketHandler();
			const connectPtyUpstream = vi.fn(() => Effect.void);

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const response = yield* client.ListPtys({
					projectSlug: "proj-1",
					originId: "browser-tab-a",
				});

				expect(response).toEqual({
					projectSlug: "proj-1",
					ptys: [
						{
							id: "pty-1",
							title: "Shell",
							command: "zsh",
							cwd: "/repo",
							status: "running",
							pid: 123,
						},
					],
				});
				expect(connectPtyUpstream).toHaveBeenCalledWith("pty-1", -1);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({ api, wsHandler, connectPtyUpstream }),
						),
					),
				),
			);
		},
	);

	it.live(
		"creates, resizes, and closes PTYs through RPC control calls, announced on the PTY stream",
		() => {
			const api = makeMockOpenCodeAPI();
			api.pty.list = vi.fn(async () => []);
			api.pty.create = vi.fn(async () => ({
				id: "pty-1",
				title: "Shell",
				command: "zsh",
				cwd: "/repo",
				status: "running",
				pid: 123,
			}));
			api.pty.delete = vi.fn(async () => undefined);
			api.pty.resize = vi.fn(async () => undefined);
			const wsHandler = makeMockWebSocketHandler();
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const upstream = {
				readyState: 1,
				send: vi.fn(),
				close: vi.fn(),
				terminate: vi.fn(),
				resize: vi.fn(),
			};
			const localPty: LocalPtyService = {
				list: () => Effect.succeed([]),
				attach: () => Effect.die("Unexpected attach in RPC test"),
				create: vi.fn(() => {
					const session: LocalPtySession = {
						pty: {
							id: "pty-1",
							title: "Shell",
							command: "zsh",
							cwd: "/repo",
							status: "running",
							pid: 123,
						},
						upstream,
						onData: vi.fn(),
						onExit: vi.fn(),
					};
					return Effect.succeed(session);
				}),
			};
			const connectPtyUpstream = vi.fn(() => Effect.void);

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const announced = yield* client
					.SubscribePtys({ projectSlug: "proj-1" })
					.pipe(Stream.take(4), Stream.runCollect, Effect.fork);
				yield* Effect.sleep("10 millis");

				expect(
					yield* client.CreatePty({
						projectSlug: "proj-1",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });
				expect(api.pty.create).not.toHaveBeenCalled();
				expect(localPty.create).toHaveBeenCalledWith({
					cwd: MOCK_PROJECT_DIR,
				});
				expect(connectPtyUpstream).not.toHaveBeenCalled();

				expect(
					yield* client.ResizePty({
						projectSlug: "proj-1",
						originId: "browser-tab-a",
						ptyId: "pty-1",
						cols: 120,
						rows: 40,
					}),
				).toEqual({ ok: true });
				expect(upstream.resize).toHaveBeenCalledWith(120, 40);
				expect(api.pty.resize).not.toHaveBeenCalled();

				expect(
					yield* client.ClosePty({
						projectSlug: "proj-1",
						ptyId: "pty-1",
					}),
				).toEqual({ ok: true });
				expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
				expect(api.pty.delete).not.toHaveBeenCalled();
				expect(Chunk.toReadonlyArray(yield* Fiber.join(announced))).toEqual([
					{ _tag: "snapshot", rows: [] },
					{ _tag: "synchronized" },
					{
						_tag: "upsert",
						item: {
							id: "pty-1",
							title: "Shell",
							command: "zsh",
							cwd: "/repo",
							status: "running",
							pid: 123,
						},
					},
					{ _tag: "remove", id: "pty-1" },
				]);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								wsHandler,
								ptyManager,
								localPty,
								connectPtyUpstream,
							}),
						),
					),
				),
			);
		},
	);

	it.effect(
		"CreatePty fails typed when the terminal cannot spawn, with no raw system_error",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const localPty: LocalPtyService = {
				list: () => Effect.succeed([]),
				attach: () => Effect.die("Unexpected attach in RPC test"),
				create: () =>
					Effect.fail(
						new TerminalServiceError({
							operation: "create",
							cause: new Error("spawn failed"),
						}),
					),
			};

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const error = yield* Effect.flip(
					client.CreatePty({ projectSlug: "proj-1", originId: "tab-a" }),
				);
				expect(error).toBeInstanceOf(WsRpcError);
				expect(error.message).toContain("spawn failed");
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(makeTestHandlerLayer({ wsHandler, localPty })),
					),
				),
			);
		},
	);

	it.effect(
		"PtyInput forwards keystrokes to a live terminal and fails typed for a gone one",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const upstream = {
				readyState: 1,
				send: vi.fn(),
				close: vi.fn(),
				terminate: vi.fn(),
			};
			ptyManager.registerSession("pty-1", upstream, "local");

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				expect(
					yield* client.PtyInput({
						projectSlug: "proj-1",
						ptyId: "pty-1",
						data: "ls\r",
					}),
				).toEqual({ ok: true });
				expect(upstream.send).toHaveBeenCalledWith("ls\r");
				expect(
					yield* Effect.flip(
						client.PtyInput({
							projectSlug: "proj-1",
							ptyId: "pty-gone",
							data: "ls\r",
						}),
					),
				).toEqual(
					new WsRpcError({
						message:
							"Terminal is unavailable; reconnect or create a new terminal",
					}),
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(makeTestHandlerLayer({ ptyManager })),
					),
				),
			);
		},
	);
});
