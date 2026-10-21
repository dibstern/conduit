import { setImmediate } from "node:timers/promises";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makeMessagePollerManagerLive } from "../../../src/lib/domain/relay/Layers/message-poller-manager-layer.js";
import { backgroundOpenCodeAPI } from "../../../src/lib/domain/relay/Layers/relay-core-layers.js";
import {
	ConfigTag,
	LoggerTag,
	type PollerManagerShape,
	PollerManagerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionWorkspaceTag } from "../../../src/lib/domain/relay/Services/session-workspace.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { SessionRow } from "../../../src/lib/persistence/read-model-types.js";
import {
	MessagePoller,
	MessagePollerManager,
} from "../../../src/lib/relay/message-poller-impl.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";
import { partialFake } from "../../helpers/partial-fake.js";

const flushMicrotasks = async () => {
	await setImmediate();
	await setImmediate();
};

function textMessage(sessionId: string, text: string): Message {
	return {
		id: "msg-1",
		role: "assistant",
		sessionID: sessionId,
		parts: [{ id: "part-1", type: "text", text }],
	};
}

function expectRealManager(
	manager: PollerManagerShape,
): asserts manager is MessagePollerManager {
	expect(manager).toBeInstanceOf(MessagePollerManager);
}

async function buildLayerHarness(options?: {
	readonly interval?: number;
	readonly hasViewers?: (sessionId: string) => boolean;
	readonly messages?: OpenCodeAPI["session"]["messages"];
}) {
	const messages = vi.fn(
		options?.messages ??
			(async (sessionId: string) => [textMessage(sessionId, "")]),
	);
	const api = partialFake<OpenCodeAPI>({
		session: partialFake<OpenCodeAPI["session"]>({ messages }),
	});
	const workspaceGet = vi.fn((sessionId: string) =>
		Effect.succeed(`/tmp/${sessionId}`),
	);
	const ifRunning = vi.fn(() => Effect.succeed(Option.some(api)));
	const useIfRunning = vi.fn(() =>
		Effect.die(
			new Error("Background message reads must not acquire an instance hold"),
		),
	);
	const dependencyLayer = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag)(api),
		Layer.succeed(OpenCodeInstancesTag)(
			partialFake<OpenCodeInstancesTag["Service"]>({ ifRunning, useIfRunning }),
		),
		Layer.succeed(SessionWorkspaceTag)(
			partialFake<SessionWorkspaceTag["Service"]>({
				get: workspaceGet,
				withLaunch: (effect) => effect,
			}),
		),
		Layer.succeed(ReadQueryEffectTag)(
			partialFake<ReadQueryEffectTag["Service"]>({
				getSession: (sessionId) =>
					Effect.succeed(
						partialFake<SessionRow>({ id: sessionId, provider: "named-test" }),
					),
			}),
		),
		Layer.succeed(ConfigTag)(
			makeMockConfig({
				messagePollerInterval: options?.interval ?? 1_000,
			}),
		),
		Layer.succeed(LoggerTag)(makeMockLogger()),
	);
	const layer = makeMessagePollerManagerLive({
		...(options?.hasViewers != null && { hasViewers: options.hasViewers }),
	}).pipe(Layer.provide(dependencyLayer));
	const scope = await Effect.runPromise(Scope.make());
	const context = await Effect.runPromise(
		Layer.buildWithScope(Layer.fresh(layer), scope),
	);
	const runWithContext = <A, E>(
		effect: Effect.Effect<A, E, PollerManagerTag>,
	) => Effect.runPromise(Effect.provide(effect, context));
	const close = () => Effect.runPromise(Scope.close(scope, Exit.void));

	return {
		api,
		close,
		messages,
		ifRunning,
		runWithContext,
		useIfRunning,
		workspaceGet,
	};
}

describe("MessagePollerManagerLive", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("constructs a real manager that seeds REST polling and emits only new synthesized events", async () => {
		vi.useFakeTimers({
			now: 1_000,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
		const seed = [textMessage("s1", "hello")];
		const harness = await buildLayerHarness({
			messages: async () => [textMessage("s1", "hello world")],
		});
		const events: unknown[] = [];

		const manager = await harness.runWithContext(PollerManagerTag);
		expectRealManager(manager);
		manager.on("events", (batch, sessionId) => {
			events.push({ batch, sessionId });
		});

		manager.startPolling("s1", seed);
		await flushMicrotasks();

		expect(harness.messages).toHaveBeenCalledWith("s1", {
			signal: expect.any(AbortSignal),
		});
		expect(harness.workspaceGet).toHaveBeenCalledWith("s1", undefined);
		expect(harness.ifRunning).toHaveBeenCalledWith("named-test", "/tmp/s1");
		expect(harness.useIfRunning).not.toHaveBeenCalled();
		expect(events).toEqual([
			{
				sessionId: "s1",
				batch: [
					{
						type: "delta",
						text: " world",
						messageId: "msg-1",
						sessionId: "s1",
					},
				],
			},
		]);

		await harness.close();
	});

	it("drains active pollers when the layer scope closes", async () => {
		vi.useFakeTimers({
			now: 1_000,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
		const drainSpy = vi.spyOn(MessagePollerManager.prototype, "drain");
		const harness = await buildLayerHarness({
			messages: async () => [textMessage("s1", "hello")],
		});
		const manager = await harness.runWithContext(PollerManagerTag);
		expectRealManager(manager);

		manager.startPolling("s1", [textMessage("s1", "hello")]);
		expect(manager.isPolling("s1")).toBe(true);

		await harness.close();

		expect(drainSpy).toHaveBeenCalledTimes(1);
		expect(manager.isPolling("s1")).toBe(false);
		expect(harness.messages).not.toHaveBeenCalled();
	});

	it("cancels a passive blocked read when the layer closes", async () => {
		vi.useFakeTimers({
			now: 1_000,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
		let signal: AbortSignal | undefined;
		const harness = await buildLayerHarness({
			messages: (_sessionId, options) => {
				signal = options?.signal;
				return new Promise(() => {});
			},
		});
		const manager = await harness.runWithContext(PollerManagerTag);
		manager.startPolling("s1");
		await flushMicrotasks();
		expect(signal?.aborted).toBe(false);
		expect(harness.useIfRunning).not.toHaveBeenCalled();

		await harness.close();

		expect(signal?.aborted).toBe(true);
		expect(harness.ifRunning).toHaveBeenCalledWith("named-test", "/tmp/s1");
		expect(harness.useIfRunning).not.toHaveBeenCalled();
		expect(manager.isPolling("s1")).toBe(false);
	}, 2_000);

	it("keeps fallback polling quiet while OpenCode is stopped and resumes reads when running", async () => {
		vi.useFakeTimers({
			now: 1_000,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
		let running = false;
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json([]));
		const runningApi = partialFake<OpenCodeAPI>({
			getBaseUrl: () => "http://managed.test",
			getAuthHeaders: () => ({}),
		});
		const client = await Effect.runPromise(
			backgroundOpenCodeAPI.pipe(
				Effect.provide(
					Layer.mergeAll(
						Layer.succeed(ConfigTag)(makeMockConfig()),
						Layer.succeed(OpenCodeInstancesTag)(
							partialFake<OpenCodeInstancesTag["Service"]>({
								ifRunning: () =>
									Effect.sync(() =>
										running ? Option.some(runningApi) : Option.none(),
									),
							}),
						),
					),
				),
			),
		);
		const log = makeMockLogger();
		const poller = new MessagePoller({
			client,
			log,
			interval: 750,
			hasViewers: () => true,
		});
		try {
			poller.startPolling("s1", []);
			await vi.advanceTimersByTimeAsync(3_000);
			// A non-starting client is expected to reject without making a request.
			// Main logs that expected rejection on every fallback tick.
			expect(fetch).not.toHaveBeenCalled();
			expect(log.warn).not.toHaveBeenCalled();
			running = true;
			await vi.advanceTimersByTimeAsync(750);
			await poller.drain();
			expect(log.warn).not.toHaveBeenCalled();
			expect(fetch).toHaveBeenCalled();
		} finally {
			await poller.drain();
		}
	});

	it("suppresses duplicate REST synthesis after SSE activity until silence reseeds the snapshot", async () => {
		vi.useFakeTimers({
			now: 1_000,
			toFake: ["Date", "setInterval", "clearInterval"],
		});
		const seed = [textMessage("s1", "hello")];
		let currentMessages = seed;
		const harness = await buildLayerHarness({
			interval: 1_000,
			messages: async () => currentMessages,
		});
		const events: unknown[] = [];
		const manager = await harness.runWithContext(PollerManagerTag);
		expectRealManager(manager);
		manager.on("events", (batch, sessionId) => {
			events.push({ batch, sessionId });
		});

		manager.startPolling("s1", seed);
		await flushMicrotasks();
		expect(events).toEqual([]);

		currentMessages = [textMessage("s1", "hello world")];
		manager.notifySSEEvent("s1");

		await vi.advanceTimersByTimeAsync(1_000);
		expect(events).toEqual([]);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(events).toEqual([]);

		await harness.close();
	});
});
