import { describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Scope } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makePtyRuntimeLive } from "../../../src/lib/domain/relay/Layers/pty-manager-layer.js";
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
} from "../../../src/lib/domain/relay/Services/terminal-service.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockWebSocketHandler,
} from "../../helpers/mock-factories.js";

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
				const messages: Array<{ clientId: string; message: RelayMessage }> = [];
				const dataHandlers: Array<(data: string) => void> = [];
				const upstream = {
					readyState: 1,
					send: vi.fn(),
					close: vi.fn(),
					terminate: vi.fn(),
				};
				const localPty: LocalPtyService = {
					create: vi.fn(() => {
						const session: LocalPtySession = {
							pty: {
								id: "local-pty-1",
								title: "Terminal",
								command: "zsh",
								cwd: "/project",
								status: "running",
								pid: 123,
							},
							upstream,
							onData: (handler: (data: string) => void) => {
								dataHandlers.push(handler);
							},
							onExit: vi.fn(),
						};
						return Effect.succeed(session);
					}),
				};
				const wsHandler = makeMockWebSocketHandler({
					getClientSession: vi.fn(() => "session-1"),
					sendTo: vi.fn((clientId, message) => {
						messages.push({ clientId, message });
					}),
				});
				const connectPtyUpstream: ConnectPtyUpstreamShape = vi.fn(
					async () => undefined,
				);
				const dependencyLayer = Layer.mergeAll(
					Layer.succeed(OpenCodeAPITag, makeApi()),
					Layer.succeed(WebSocketHandlerTag, wsHandler),
					Layer.succeed(ConfigTag, makeMockConfig({ projectDir: "/project" })),
					Layer.succeed(LoggerTag, makeMockLogger()),
					Layer.succeed(LocalPtyServiceTag, localPty),
					Layer.succeed(ConnectPtyUpstreamTag, connectPtyUpstream),
				);
				const ptyRuntimeLayer = makePtyRuntimeLive().pipe(
					Layer.provide(dependencyLayer),
				);
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
				expect(ptyManager.hasSession("local-pty-1")).toBe(true);

				dataHandlers[0]?.("hello\n");
				yield* runWithContext(service.replay("client-2"));
				expect(messages).toContainEqual({
					clientId: "client-2",
					message: {
						type: "pty_output",
						ptyId: "local-pty-1",
						data: "hello\n",
					},
				});

				yield* runWithContext(service.sendInput("local-pty-1", "ls\n"));
				expect(upstream.send).toHaveBeenCalledWith("ls\n");

				yield* Scope.close(scope, Exit.void);
				expect(upstream.close).toHaveBeenCalledWith(1000, "Proxy closed");
			}),
	);
});
