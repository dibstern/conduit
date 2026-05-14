import { Effect, Exit, Layer, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makeMessagePollerManagerLive } from "../../../src/lib/domain/relay/Layers/message-poller-manager-layer.js";
import {
	ConfigTag,
	LoggerTag,
	type PollerManagerShape,
	PollerManagerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { Message } from "../../../src/lib/instance/sdk-types.js";
import { MessagePollerManager } from "../../../src/lib/relay/message-poller-impl.js";
import {
	makeMockConfig,
	makeMockLogger,
} from "../../helpers/mock-factories.js";

const flushMicrotasks = async () => {
	await Promise.resolve();
	await Promise.resolve();
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
	readonly messages?: (sessionId: string) => Promise<Message[]>;
}) {
	const messages = vi.fn(
		options?.messages ??
			(async (sessionId: string) => [textMessage(sessionId, "")]),
	);
	const api = {
		session: { messages },
	} as unknown as OpenCodeAPI;
	const dependencyLayer = Layer.mergeAll(
		Layer.succeed(OpenCodeAPITag, api),
		Layer.succeed(
			ConfigTag,
			makeMockConfig({
				messagePollerInterval: options?.interval ?? 1_000,
			}),
		),
		Layer.succeed(LoggerTag, makeMockLogger()),
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

	return { api, close, messages, runWithContext };
}

describe("MessagePollerManagerLive", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("constructs a real manager that seeds REST polling and emits only new synthesized events", async () => {
		vi.useFakeTimers({ now: 1_000 });
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

		expect(harness.messages).toHaveBeenCalledWith("s1");
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
		vi.useFakeTimers({ now: 1_000 });
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
	});

	it("suppresses duplicate REST synthesis after SSE activity until silence reseeds the snapshot", async () => {
		vi.useFakeTimers({ now: 1_000 });
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
