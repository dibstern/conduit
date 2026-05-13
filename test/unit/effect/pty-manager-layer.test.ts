import { EventEmitter } from "node:events";
import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { expect, vi } from "vitest";
import { makePtyRuntimeLive } from "../../../src/lib/effect/pty-manager-layer.js";
import {
	ConfigTag,
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
import type { RelayMessage } from "../../../src/lib/types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

class FakePtyWebSocket extends EventEmitter {
	static instances: FakePtyWebSocket[] = [];
	readyState = 1;
	readonly send = vi.fn();
	readonly close = vi.fn((code?: number, reason?: string | Buffer) => {
		this.readyState = 3;
		this.emit("close", code, reason);
	});
	readonly terminate = vi.fn(() => {
		this.readyState = 3;
		this.emit("close");
	});

	constructor(
		readonly url: string,
		readonly options: unknown,
	) {
		super();
		FakePtyWebSocket.instances.push(this);
		queueMicrotask(() => this.emit("open"));
	}
}

const makeApi = (): OpenCodeAPI =>
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
		},
		getAuthHeaders: vi.fn(() => ({ authorization: "Bearer test" })),
	}) as unknown as OpenCodeAPI;

describe("PtyManagerLive", () => {
	it.effect(
		"uses one scoped manager for terminal create, replay, input, and cleanup",
		() =>
			Effect.gen(function* () {
				FakePtyWebSocket.instances = [];
				const messages: Array<{ clientId: string; message: RelayMessage }> = [];
				const wsHandler = makeMockWebSocketHandler({
					getClientSession: vi.fn(() => "session-1"),
					sendTo: vi.fn((clientId, message) => {
						messages.push({ clientId, message });
					}),
				});
				const dependencyLayer = Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeApi()),
					Layer.succeed(WebSocketHandlerTag, wsHandler),
					Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/project" })),
					Layer.succeed(LoggerTag, makeMockLogger()),
				);
				const ptyRuntimeLayer = makePtyRuntimeLive(
					FakePtyWebSocket as unknown as typeof import("ws").WebSocket,
				).pipe(Layer.provide(dependencyLayer));
				const fullLayer = Layer.merge(
					OpenCodeTerminalServiceLive.pipe(
						Layer.provide(Layer.merge(dependencyLayer, ptyRuntimeLayer)),
					),
					ptyRuntimeLayer,
				);

				const scope = yield* Scope.make();
				const context = yield* Layer.buildWithScope(
					Layer.fresh(fullLayer),
					scope,
				);
				const runWithContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
					Effect.provide(effect, context);

				const service = yield* runWithContext(OpenCodeTerminalServiceTag);
				const ptyManager = yield* runWithContext(PtyManagerTag);

				yield* runWithContext(service.create("client-1"));
				const upstream = FakePtyWebSocket.instances[0];
				expect(upstream).toBeDefined();
				expect(ptyManager.hasSession("pty-1")).toBe(true);
				expect(upstream?.url).toBe(
					"ws://localhost:4096/pty/pty-1/connect?cursor=0",
				);

				upstream?.emit("message", Buffer.from("hello\n"));
				yield* runWithContext(service.replay("client-2"));
				expect(messages).toContainEqual({
					clientId: "client-2",
					message: { type: "pty_output", ptyId: "pty-1", data: "hello\n" },
				});

				yield* runWithContext(service.sendInput("pty-1", "ls\n"));
				expect(upstream?.send).toHaveBeenCalledWith("ls\n");

				yield* Scope.close(scope, Exit.void);
				expect(upstream?.close).toHaveBeenCalledWith(1000, "Proxy closed");
			}),
	);
});
