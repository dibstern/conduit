import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import type {
	LocalPtyService,
	LocalPtySession,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import { PtyManager } from "../../../src/lib/relay/pty-manager.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
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
			const connectPtyUpstream = vi.fn(async () => undefined);

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
				expect(wsHandler.sendTo).toHaveBeenCalledWith("browser-tab-a", {
					type: "pty_list",
					ptys: response.ptys,
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

	it.effect(
		"creates, resizes, and closes PTYs through RPC control calls",
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
			const connectPtyUpstream = vi.fn(async () => undefined);

			return Effect.gen(function* () {
				const client = yield* rpcClient;

				expect(
					yield* client.CreatePty({
						projectSlug: "proj-1",
						originId: "browser-tab-a",
					}),
				).toEqual({ ok: true });
				expect(api.pty.create).not.toHaveBeenCalled();
				expect(localPty.create).toHaveBeenCalledWith({
					cwd: "/test/project",
				});
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "pty_created",
					pty: {
						id: "pty-1",
						title: "Shell",
						command: "zsh",
						cwd: "/repo",
						status: "running",
						pid: 123,
					},
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
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "pty_deleted",
					ptyId: "pty-1",
				});
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
});
