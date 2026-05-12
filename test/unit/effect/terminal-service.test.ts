import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	ConfigTag,
	type ConnectPtyUpstreamShape,
	ConnectPtyUpstreamTag,
	LoggerTag,
	OpenCodeAPITag,
	PtyManagerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import {
	OpenCodeTerminalServiceLive,
	OpenCodeTerminalServiceTag,
} from "../../../src/lib/effect/terminal-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	PtyManager,
	type PtyUpstream,
} from "../../../src/lib/relay/pty-manager.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

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
	({
		pty: {
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
		},
	}) as unknown as OpenCodeAPI;

const makeLayer = (options?: {
	readonly api?: OpenCodeAPI;
	readonly ptyManager?: PtyManager;
	readonly connectPtyUpstream?: ConnectPtyUpstreamShape;
	readonly wsHandler?: ReturnType<typeof makeMockWebSocketHandler>;
	readonly log?: ReturnType<typeof makeMockLogger>;
}) => {
	const api = options?.api ?? makeApi();
	const ptyManager =
		options?.ptyManager ?? new PtyManager({ log: makeMockLogger() });
	const connectPtyUpstream =
		options?.connectPtyUpstream ?? vi.fn(async () => undefined);
	const wsHandler = options?.wsHandler ?? makeMockWebSocketHandler();
	const log = options?.log ?? makeMockLogger();

	return OpenCodeTerminalServiceLive.pipe(
		Layer.provide(
			Layer.mergeAll(
				Layer.succeed(OpenCodeAPITag, api),
				Layer.succeed(PtyManagerTag, ptyManager),
				Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/project" })),
				Layer.succeed(LoggerTag, log),
			),
		),
	);
};

describe("OpenCodeTerminalServiceLive", () => {
	it.effect("broadcasts pty_created before connecting the upstream", () => {
		const events: string[] = [];
		const wsHandler = makeMockWebSocketHandler({
			broadcast: vi.fn((message) => events.push(`broadcast:${message.type}`)),
		});
		const connectPtyUpstream = vi.fn(async () => {
			events.push("connect");
		});
		const layer = makeLayer({ wsHandler, connectPtyUpstream });

		return Effect.gen(function* () {
			const service = yield* OpenCodeTerminalServiceTag;
			yield* service.create("client-1");

			expect(events).toEqual(["broadcast:pty_created", "connect"]);
			expect(connectPtyUpstream).toHaveBeenCalledWith("pty-1");
			expect(wsHandler.sendTo).not.toHaveBeenCalled();
		}).pipe(Effect.provide(layer));
	});

	it.effect(
		"deletes the optimistic tab and sends an error when upstream connect fails",
		() => {
			const sent: unknown[] = [];
			const broadcasts: string[] = [];
			const wsHandler = makeMockWebSocketHandler({
				broadcast: vi.fn((message) => broadcasts.push(message.type)),
				sendTo: vi.fn((_clientId, message) => sent.push(message)),
			});
			const connectPtyUpstream = vi.fn(async () => {
				throw new Error("connect failed");
			});
			const layer = makeLayer({ wsHandler, connectPtyUpstream });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.create("client-1");

				expect(broadcasts).toEqual(["pty_created", "pty_deleted"]);
				expect(sent).toMatchObject([
					{ type: "system_error", code: "PTY_CONNECT_FAILED" },
				]);
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"lists PTYs and reconnects missing running upstreams with cursor -1",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const connectPtyUpstream = vi.fn(async () => undefined);
			const api = makeApi({
				list: vi.fn(async () => [
					{ id: "pty-1", status: "running" },
					{ id: "pty-2", status: "exited" },
				]),
			});
			const layer = makeLayer({ api, wsHandler, connectPtyUpstream });

			return Effect.gen(function* () {
				const service = yield* OpenCodeTerminalServiceTag;
				yield* service.list("client-1");

				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "pty_list",
					ptys: [
						{ id: "pty-1", status: "running" },
						{ id: "pty-2", status: "exited" },
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
});
