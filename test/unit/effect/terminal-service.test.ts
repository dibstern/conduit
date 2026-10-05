import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import {
	ConfigTag,
	type ConnectPtyUpstreamShape,
	ConnectPtyUpstreamTag,
	LoggerTag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	type LocalPtyService,
	LocalPtyServiceTag,
	type LocalPtySession,
	OpenCodeTerminalServiceLive,
	OpenCodeTerminalServiceTag,
	TerminalServiceError,
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	PtyManager,
	type PtyUpstream,
} from "../../../src/lib/relay/pty-manager.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { partialFake } from "../../helpers/partial-fake.js";

const openState = 1;
const closedState = 3;

const makeUpstream = (
	readyState = openState,
): PtyUpstream & {
	readonly send: ReturnType<typeof vi.fn>;
	readonly close: ReturnType<typeof vi.fn>;
	readonly terminate: ReturnType<typeof vi.fn>;
} => ({
	readyState,
	send: vi.fn(),
	close: vi.fn(),
	terminate: vi.fn(),
});

const makeApi = (overrides?: Partial<OpenCodeAPI["pty"]>): OpenCodeAPI =>
	partialFake<OpenCodeAPI>({
		pty: partialFake<OpenCodeAPI["pty"]>({
			create: vi.fn(async () => ({
				id: "pty-1",
				title: "Shell",
				command: "zsh",
				cwd: "/project",
				status: "running",
				pid: 123,
			})),
			list: vi.fn(async () => []),
			delete: vi.fn(async () => undefined),
			resize: vi.fn(async () => undefined),
			...overrides,
		}),
	});

const makeLayer = (options?: {
	readonly api?: OpenCodeAPI;
	readonly ptyManager?: PtyManager;
	readonly connectPtyUpstream?: ConnectPtyUpstreamShape;
	readonly localPty?: LocalPtyService;
	readonly wsHandler?: ReturnType<typeof makeMockWebSocketHandler>;
	readonly log?: ReturnType<typeof makeMockLogger>;
}) => {
	const api = options?.api ?? makeApi();
	const ptyManager =
		options?.ptyManager ?? new PtyManager({ log: makeMockLogger() });
	const connectPtyUpstream =
		options?.connectPtyUpstream ?? vi.fn(() => Effect.void);
	const localPty =
		options?.localPty ??
		({
			list: () => Effect.succeed([]),
			attach: (ptyId: string) =>
				Effect.fail(
					new TerminalServiceError({
						operation: "connect",
						ptyId,
						cause: "Not found",
					}),
				),
			create: vi.fn(() => {
				const session: LocalPtySession = {
					pty: {
						id: "local-pty-1",
						title: "Terminal",
						command: "zsh",
						cwd: "/project",
						status: "running",
						pid: 456,
					},
					upstream: makeUpstream(openState),
					onData: vi.fn(),
					onExit: vi.fn(),
				};
				return Effect.succeed(session);
			}),
		} satisfies LocalPtyService);
	const wsHandler = options?.wsHandler ?? makeMockWebSocketHandler();
	const log = options?.log ?? makeMockLogger();

	return OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(
					OpenCodeInstancesTag,
					makeOpenCodeInstancesStub({ opencode: api }),
				),
				Layer.succeed(PtyManagerTag, ptyManager),
				Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
				Layer.succeed(LocalPtyServiceTag, localPty),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/project" })),
				Layer.succeed(LoggerTag, log),
			),
		),
	);
};

describe("OpenCodeTerminalServiceLive", () => {
	it.effect("creates a local terminal without requiring OpenCode PTY", () => {
		const dataHandlers: Array<(data: string) => void> = [];
		const exitHandlers: Array<(exitCode: number) => void> = [];
		const upstream = { ...makeUpstream(openState), resize: vi.fn() };
		const localPty: LocalPtyService = {
			list: () => Effect.succeed([]),
			attach: (ptyId) =>
				Effect.fail(
					new TerminalServiceError({
						operation: "connect",
						ptyId,
						cause: "Not found",
					}),
				),
			create: vi.fn(() => {
				const session: LocalPtySession = {
					pty: {
						id: "local-pty-1",
						title: "Terminal",
						command: "zsh",
						cwd: "/project",
						status: "running",
						pid: 456,
					},
					upstream,
					onData: (handler: (data: string) => void) => {
						dataHandlers.push(handler);
					},
					onExit: (handler: (exitCode: number) => void) => {
						exitHandlers.push(handler);
					},
				};
				return Effect.succeed(session);
			}),
		};
		const api = makeApi({
			create: vi.fn(async () => {
				throw new Error("fetch failed");
			}),
		});
		const wsHandler = makeMockWebSocketHandler({
			getClientIds: () => ["client-1"],
		});
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const layer = makeLayer({ api, wsHandler, ptyManager, localPty });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.create("client-1");
			yield* service.sendInput("local-pty-1", "echo hi\n");

			expect(api.pty.create).not.toHaveBeenCalled();
			expect(ptyManager.hasSession("local-pty-1")).toBe(true);
			expect(upstream.send).toHaveBeenCalledWith("echo hi\n");
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "pty_created",
				pty: {
					id: "local-pty-1",
					title: "Terminal",
					command: "zsh",
					cwd: "/project",
					status: "running",
					pid: 456,
				},
			});

			dataHandlers[0]?.("hello\n");
			expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
				type: "pty_output",
				ptyId: "local-pty-1",
				data: "hello\n",
			});

			yield* service.resize("client-1", "local-pty-1", 40, 120);
			expect(upstream.resize).toHaveBeenCalledWith(120, 40);

			yield* service.close("local-pty-1");
			expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
			expect(api.pty.delete).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"does not connect an OpenCode upstream when creating a terminal",
		() => {
			const events: string[] = [];
			const wsHandler = makeMockWebSocketHandler({
				broadcast: vi.fn((message) => events.push(`broadcast:${message.type}`)),
			});
			const connectPtyUpstream = vi.fn(() =>
				Effect.sync(() => {
					events.push("connect");
				}),
			);
			const api = makeApi();
			const layer = makeLayer({ api, wsHandler, connectPtyUpstream });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.create("client-1");

				expect(events).toEqual(["broadcast:pty_created"]);
				expect(api.pty.create).not.toHaveBeenCalled();
				expect(connectPtyUpstream).not.toHaveBeenCalled();
				expect(wsHandler.sendTo).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("sends an error when local terminal creation fails", () => {
		const sent: unknown[] = [];
		const broadcasts: string[] = [];
		const wsHandler = makeMockWebSocketHandler({
			broadcast: vi.fn((message) => broadcasts.push(message.type)),
			sendTo: vi.fn((_clientId, message) => sent.push(message)),
		});
		const localPty: LocalPtyService = {
			list: () => Effect.succeed([]),
			attach: (ptyId) =>
				Effect.fail(
					new TerminalServiceError({
						operation: "connect",
						ptyId,
						cause: "Not found",
					}),
				),
			create: vi.fn(() =>
				Effect.fail(
					new TerminalServiceError({
						operation: "create",
						cause: new Error("spawn failed"),
					}),
				),
			),
		};
		const layer = makeLayer({ wsHandler, localPty });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.create("client-1");

			expect(broadcasts).toEqual([]);
			expect(sent).toMatchObject([
				{ type: "system_error", code: "PTY_CREATE_FAILED" },
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"lists PTYs and reconnects missing running upstreams with cursor -1",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const connectPtyUpstream = vi.fn(() => Effect.void);
			const api = makeApi({
				list: vi.fn(async () => [
					{ id: "pty-1", status: "running" },
					{ id: "pty-2", status: "exited" },
				]),
			});
			const layer = makeLayer({ api, wsHandler, connectPtyUpstream });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				const ptys = yield* service.list("client-1");

				expect(ptys).toEqual([
					{
						id: "pty-1",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "running",
						pid: 0,
					},
					{
						id: "pty-2",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "exited",
						pid: 0,
					},
				]);

				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "pty_list",
					ptys: [
						{
							id: "pty-1",
							title: "Terminal",
							command: "bash",
							cwd: "/project",
							status: "running",
							pid: 0,
						},
						{
							id: "pty-2",
							title: "Terminal",
							command: "bash",
							cwd: "/project",
							status: "exited",
							pid: 0,
						},
					],
				});
				expect(connectPtyUpstream).toHaveBeenCalledWith("pty-1", -1);
				expect(connectPtyUpstream).toHaveBeenCalledTimes(1);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("sends input only to open tracked upstreams", () => {
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const open = makeUpstream(openState);
		const closed = makeUpstream(closedState);
		ptyManager.registerSession("pty-open", open);
		ptyManager.registerSession("pty-closed", closed);
		const layer = makeLayer({ ptyManager });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.sendInput("pty-open", "ls\n");
			yield* service.sendInput("pty-closed", "pwd\n");
			yield* service.sendInput("pty-missing", "whoami\n");

			expect(open.send).toHaveBeenCalledWith("ls\n");
			expect(closed.send).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"closes the local upstream, deletes provider PTY, and broadcasts deletion",
		() => {
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const upstream = makeUpstream(openState);
			ptyManager.registerSession("pty-1", upstream);
			const api = makeApi();
			const wsHandler = makeMockWebSocketHandler();
			const layer = makeLayer({ api, ptyManager, wsHandler });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.close("pty-1");

				expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
				expect(api.pty.delete).toHaveBeenCalledWith("pty-1");
				expect(wsHandler.broadcast).toHaveBeenCalledWith({
					type: "pty_deleted",
					ptyId: "pty-1",
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("closes a hosted terminal before the relay discovers it", () => {
		const upstream = makeUpstream(openState);
		const hosted: LocalPtySession = {
			pty: {
				id: "local-pty-undiscovered",
				title: "Terminal",
				command: "sh",
				cwd: "/project",
				status: "running",
				pid: 456,
			},
			upstream,
			onData: vi.fn(),
			onExit: vi.fn(),
		};
		const localPty: LocalPtyService = {
			list: vi.fn(() => Effect.succeed([hosted.pty])),
			attach: vi.fn(() => Effect.succeed(hosted)),
			create: vi.fn(() => Effect.succeed(hosted)),
		};
		const api = makeApi();
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const layer = makeLayer({ localPty, api, ptyManager });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			expect(ptyManager.sessionCount).toBe(0);
			yield* service.close(hosted.pty.id);
			expect(localPty.list).toHaveBeenCalledWith("/project");
			expect(localPty.attach).toHaveBeenCalledWith(hosted.pty.id, "/project");
			expect(upstream.close).toHaveBeenCalledWith(1000, "Terminal closed");
			expect(api.pty.delete).not.toHaveBeenCalled();
			expect(ptyManager.sessionCount).toBe(0);
		}).pipe(Effect.provide(layer));
	});

	it.effect("serializes close after a suspended local terminal reattach", () =>
		Effect.gen(function* () {
			const attachStarted = yield* Deferred.make<void>();
			const releaseAttach = yield* Deferred.make<void>();
			const closeStarted = yield* Deferred.make<void>();
			const events: Array<"attached" | "closed" | "deleted" | "listed"> = [];
			const disconnectHandlers: Array<() => void> = [];
			const oldUpstream = makeUpstream(openState);
			const restoredUpstream = makeUpstream(openState);
			restoredUpstream.close.mockImplementation(() => events.push("closed"));
			const initial: LocalPtySession = {
				pty: {
					id: "local-pty-1",
					title: "Terminal",
					command: "sh",
					cwd: "/project",
					status: "running",
					pid: 456,
				},
				upstream: oldUpstream,
				onData: vi.fn(),
				onExit: vi.fn(),
				onDisconnect: (handler) => disconnectHandlers.push(handler),
			};
			const restored: LocalPtySession = {
				...initial,
				upstream: restoredUpstream,
				onData: (handler) => {
					events.push("attached");
					handler("replayed\n");
				},
			};
			const localPty: LocalPtyService = {
				create: () => Effect.succeed(initial),
				list: () => Effect.succeed([initial.pty]),
				attach: () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(attachStarted, undefined);
						yield* Deferred.await(releaseAttach);
						return restored;
					}),
			};
			const ptyManager = new PtyManager({ log: makeMockLogger() });
			const wsHandler = makeMockWebSocketHandler({
				getClientIds: () => ["client-1"],
				broadcast: vi.fn((message: RelayMessage) => {
					if (message.type === "pty_deleted") events.push("deleted");
				}),
				sendTo: vi.fn((_clientId: string, message: RelayMessage) => {
					if (
						message.type === "pty_list" &&
						message.ptys.some(({ id }) => id === initial.pty.id)
					)
						events.push("listed");
				}),
			});
			const layer = makeLayer({ localPty, ptyManager, wsHandler });

			yield* Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.create("client-1");
				oldUpstream.readyState = 0;
				disconnectHandlers[0]?.();
				const listing = yield* Effect.fork(service.list("client-1"));
				yield* Deferred.await(attachStarted);
				const closing = yield* Effect.fork(
					Effect.gen(function* () {
						yield* Deferred.succeed(closeStarted, undefined);
						yield* service.close(initial.pty.id);
					}),
				);
				yield* Deferred.await(closeStarted);
				yield* Effect.yieldNow();
				const closedBeforeAttach = Option.isSome(yield* Fiber.poll(closing));
				yield* Deferred.succeed(releaseAttach, undefined);
				yield* Fiber.join(listing);
				yield* Fiber.join(closing);

				expect(closedBeforeAttach).toBe(false);
				expect(ptyManager.hasSession(initial.pty.id)).toBe(false);
				expect(restoredUpstream.close).toHaveBeenCalledExactlyOnceWith(
					1000,
					"Proxy closed",
				);
				const deletion = events.indexOf("deleted");
				expect(deletion).toBeGreaterThan(events.indexOf("attached"));
				expect(events.slice(deletion + 1)).not.toContain("listed");
			}).pipe(Effect.provide(layer));
		}),
	);

	it.effect("replays tracked PTY sessions, scrollback, and exit state", () => {
		const ptyManager = new PtyManager({ log: makeMockLogger() });
		const wsHandler = makeMockWebSocketHandler();
		ptyManager.registerSession("pty-running", makeUpstream(openState));
		ptyManager.appendScrollback("pty-running", "hello\n");
		ptyManager.registerSession("pty-exited", makeUpstream(closedState));
		ptyManager.appendScrollback("pty-exited", "done\n");
		ptyManager.markExited("pty-exited", 7);
		const layer = makeLayer({ ptyManager, wsHandler });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.replay("client-1");

			expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
				type: "pty_list",
				ptys: [
					{
						id: "pty-running",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "running",
						pid: 0,
					},
					{
						id: "pty-exited",
						title: "Terminal",
						command: "bash",
						cwd: "/project",
						status: "exited",
						pid: 0,
					},
				],
			});
			expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
				type: "pty_output",
				ptyId: "pty-running",
				data: "hello\n",
				replace: true,
			});
			expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
				type: "pty_output",
				ptyId: "pty-exited",
				data: "done\n",
				replace: true,
			});
			expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
				type: "pty_exited",
				ptyId: "pty-exited",
				exitCode: 7,
			});
		}).pipe(Effect.provide(layer));
	});

	it.effect("does not replay a pty_list when no PTYs are tracked", () => {
		const wsHandler = makeMockWebSocketHandler();
		const layer = makeLayer({ wsHandler });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.replay("client-1");

			expect(wsHandler.sendTo).not.toHaveBeenCalledWith(
				"client-1",
				expect.objectContaining({ type: "pty_list" }),
			);
		}).pipe(Effect.provide(layer));
	});
});
