import { describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect, vi } from "vitest";
import { ClientMessageSerializationLive } from "../../../src/lib/domain/relay/Services/client-message-serialization.js";
import {
	makeRelayCommandGateLive,
	RelayCommandGateTag,
} from "../../../src/lib/domain/relay/Services/relay-command-gate.js";
import {
	getLogLevel,
	type Logger,
	setLogLevel,
} from "../../../src/lib/logger.js";
import type { RelayWsDispatch } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import {
	handleRelayWsMessage,
	handleRelayWsMessageThroughGate,
} from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import type { RelayMessage } from "../../../src/lib/types.js";
import {
	makeMockPtyManager,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

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

function makeBaseLayer() {
	return ClientMessageSerializationLive;
}

function makeGatedLayer() {
	return Layer.merge(makeBaseLayer(), makeRelayCommandGateLive("test"));
}

describe("handleRelayWsMessage", () => {
	it.effect("queues gated dispatch until the relay command gate is ready", () =>
		Effect.gen(function* () {
			const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
			const order: string[] = [];
			const dispatch: RelayWsDispatch<never> = vi.fn(() =>
				Effect.sync(() => {
					order.push("dispatched");
				}),
			);

			const fiber = yield* handleRelayWsMessageThroughGate({
				commandId: "cmd-a",
				receivedAt: 1000,
				clientId: "client-1",
				handler: "pty_input",
				payload: { ptyId: "pty-1", data: "ls\n" },
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(Effect.fork);

			yield* Effect.yieldNow();
			expect(order).toEqual([]);

			const gate = yield* RelayCommandGateTag;
			yield* gate.markReady(2000);
			yield* Fiber.join(fiber);

			expect(order).toEqual(["dispatched"]);
			expect(sendTo).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeGatedLayer()), Effect.scoped),
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

			const firstFiber = yield* handleRelayWsMessage({
				clientId: "client-1",
				handler: "first",
				payload: {},
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(Effect.fork);

			yield* Deferred.await(firstStarted);

			const secondFiber = yield* handleRelayWsMessage({
				clientId: "client-1",
				handler: "second",
				payload: {},
				sendTo,
				log: mockLogger(),
				dispatch,
			}).pipe(Effect.fork);

			yield* Effect.yieldNow();
			expect(order).toEqual(["first-start"]);

			yield* Deferred.succeed(releaseFirst, undefined);
			yield* Fiber.join(firstFiber);
			yield* Fiber.join(secondFiber);

			expect(order).toEqual(["first-start", "first-end", "second"]);
			expect(sendTo).not.toHaveBeenCalled();
		}).pipe(Effect.provide(makeBaseLayer())),
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
		const ptyManager = makeMockPtyManager();
		const sendTo = vi.fn<(clientId: string, message: RelayMessage) => void>();
		const layer = Layer.mergeAll(
			makeBaseLayer(),
			makeTestHandlerLayer({ ptyManager }),
		);

		return handleRelayWsMessage({
			clientId: "client-1",
			handler: "pty_input",
			payload: { ptyId: "pty-1", data: "pwd\n" },
			sendTo,
			log: mockLogger(),
		}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(ptyManager.sendInput).toHaveBeenCalledWith("pty-1", "pwd\n");
				expect(sendTo).not.toHaveBeenCalled();
			}),
		);
	});
});
