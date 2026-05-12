import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect, vi } from "vitest";
import { ClientMessageSerializationLive } from "../../../src/lib/effect/client-message-serialization.js";
import type { RateLimitResult } from "../../../src/lib/effect/rate-limiter-layer.js";
import { RateLimiterTag } from "../../../src/lib/effect/rate-limiter-layer.js";
import {
	OpenCodeAPITag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { filterAgents } from "../../../src/lib/handlers/index.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	getLogLevel,
	type Logger,
	setLogLevel,
} from "../../../src/lib/logger.js";
import type { RelayWsDispatch } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import { handleRelayWsMessage } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import type { RelayMessage } from "../../../src/lib/types.js";

function mockLogger(): Logger {
	const logger: Logger = {
		debug: vi.fn(),
		verbose: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: () => logger,
	};
	return logger;
}

function makeRateLimiterLayer(result: RateLimitResult) {
	return Layer.succeed(RateLimiterTag, {
		checkLimit: vi.fn(() => Effect.succeed(result)),
	});
}

function makeBaseLayer(rateLimit: RateLimitResult = { allowed: true }) {
	return Layer.mergeAll(
		ClientMessageSerializationLive,
		makeRateLimiterLayer(rateLimit),
	);
}

function mockWsHandler(
	overrides: Partial<WebSocketHandlerShape> = {},
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => undefined),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

describe("handleRelayWsMessage", () => {
	it.effect(
		"sends a system error without dispatching when message rate limit is denied",
		() => {
			const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
			const dispatch: RelayWsDispatch<never> = vi.fn(() => Effect.void);

			return handleRelayWsMessage({
				clientId: "client-1",
				handler: "message",
				payload: { text: "hello" },
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(
				Effect.provide(makeBaseLayer({ allowed: false, retryAfterMs: 2_500 })),
				Effect.tap(() => {
					expect(dispatch).not.toHaveBeenCalled();
					expect(sendTo).toHaveBeenCalledWith("client-1", {
						type: "system_error",
						code: "RATE_LIMITED",
						message: "Rate limited. Try again in 3s",
					});
				}),
			);
		},
	);

	it.effect(
		"handles log-level changes without entering normal dispatch",
		() => {
			const originalLevel = getLogLevel();
			const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
			const dispatch: RelayWsDispatch<never> = vi.fn(() => Effect.void);
			const log = mockLogger();

			return handleRelayWsMessage({
				clientId: "client-1",
				handler: "set_log_level",
				payload: { level: "debug" },
				sendTo,
				log,
				dispatch,
			}).pipe(
				Effect.provide(makeBaseLayer()),
				Effect.tap(() => {
					expect(dispatch).not.toHaveBeenCalled();
					expect(sendTo).not.toHaveBeenCalled();
					expect(getLogLevel()).toBe("debug");
					expect(log.info).toHaveBeenCalledWith(
						"Log level changed to debug by client client-1",
					);
				}),
				Effect.ensuring(Effect.sync(() => setLogLevel(originalLevel))),
			);
		},
	);

	it.effect("serializes normal dispatch for the same client", () =>
		Effect.gen(function* () {
			const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
			const order: string[] = [];
			const firstStarted = yield* Deferred.make<void>();
			const releaseFirst = yield* Deferred.make<void>();

			const dispatch: RelayWsDispatch<never> = vi.fn(
				(_: string, handler: string) => {
					if (handler === "first") {
						return Effect.gen(function* () {
							order.push("first-start");
							yield* Deferred.succeed(firstStarted, undefined);
							yield* Deferred.await(releaseFirst);
							order.push("first-end");
						});
					}
					return Effect.sync(() => {
						order.push("second");
					});
				},
			);

			const layer = makeBaseLayer();
			const firstFiber = yield* handleRelayWsMessage({
				clientId: "client-1",
				handler: "first",
				payload: {},
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(Effect.provide(layer), Effect.fork);

			yield* Deferred.await(firstStarted);

			const secondFiber = yield* handleRelayWsMessage({
				clientId: "client-1",
				handler: "second",
				payload: {},
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(Effect.provide(layer), Effect.fork);

			yield* Effect.yieldNow();
			expect(order).toEqual(["first-start"]);

			yield* Deferred.succeed(releaseFirst, undefined);
			yield* Fiber.join(firstFiber);
			yield* Fiber.join(secondFiber);

			expect(order).toEqual(["first-start", "first-end", "second"]);
			expect(sendTo).not.toHaveBeenCalled();
		}),
	);

	it.effect("renders dispatch failures as system errors", () => {
		const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
		const log = mockLogger();

		return handleRelayWsMessage({
			clientId: "client-1",
			handler: "bad_handler",
			payload: {},
			sendTo,
			log,
			dispatch: (() =>
				Effect.fail(new Error("boom"))) satisfies RelayWsDispatch<never>,
		}).pipe(
			Effect.provide(makeBaseLayer()),
			Effect.tap(() => {
				expect(log.error).toHaveBeenCalledWith(
					"Error handling message for client-1:",
					"boom",
				);
				expect(sendTo).toHaveBeenCalledWith("client-1", {
					type: "system_error",
					code: "HANDLER_ERROR",
					message: "boom",
				});
			}),
		);
	});

	it.effect(
		"propagates pure dispatch interruption without rendering an error",
		() =>
			Effect.gen(function* () {
				const sendTo =
					vi.fn<(clientId: string, message: RelayMessage) => void>();
				const log = mockLogger();

				const exit = yield* handleRelayWsMessage({
					clientId: "client-1",
					handler: "interrupted_handler",
					payload: {},
					sendTo,
					log,
					dispatch: (() => Effect.interrupt) satisfies RelayWsDispatch<never>,
				}).pipe(Effect.provide(makeBaseLayer()), Effect.exit);

				expect(exit._tag).toBe("Failure");
				expect(log.error).not.toHaveBeenCalled();
				expect(sendTo).not.toHaveBeenCalled();
			}),
	);

	it.effect("uses dispatchMessageEffect by default", () => {
		const agents = [
			{ name: "build", id: "build", mode: "primary" as const },
			{ name: "hidden", id: "hidden", mode: "subagent" as const, hidden: true },
		];
		const client = {
			app: { agents: vi.fn(async () => agents) },
		} as unknown as OpenCodeAPI;
		const wsHandler = mockWsHandler();
		const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
		const layer = Layer.mergeAll(
			makeBaseLayer(),
			Layer.succeed(OpenCodeAPITag, client),
			Layer.succeed(WebSocketHandlerTag, wsHandler),
		);

		return handleRelayWsMessage({
			clientId: "client-1",
			handler: "get_agents",
			payload: {},
			sendTo,
			log: mockLogger(),
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.app.agents).toHaveBeenCalledOnce();
				expect(wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
					type: "agent_list",
					agents: filterAgents(agents),
				});
				expect(sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});
