import { describe, it } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { expect } from "vitest";
import type { RelayEvent } from "../../../src/lib/domain/relay/Services/relay-domain-model.js";
import {
	makeRelayEventBusLive,
	publishRelayEvent,
	RELAY_EVENT_BUS_CAPACITY,
	subscribeToRelayEvents,
} from "../../../src/lib/domain/relay/Services/relay-event-bus.js";

const accepted = (commandId: string): RelayEvent => ({
	_tag: "ClientCommandAccepted",
	projectSlug: "project-a",
	command: {
		commandId,
		clientId: "client-1",
		messageType: "message",
		receivedAt: 1000,
	},
});

describe("RelayEventBus", () => {
	it.scoped("publishes relay domain events to subscribers", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToRelayEvents;
			yield* publishRelayEvent(accepted("cmd-a"));

			const event = yield* Queue.take(sub);

			expect(event).toMatchObject({
				_tag: "ClientCommandAccepted",
				projectSlug: "project-a",
				command: { commandId: "cmd-a" },
			});
		}).pipe(Effect.provide(Layer.fresh(makeRelayEventBusLive()))),
	);

	it.scoped("fans out events to each subscriber", () =>
		Effect.gen(function* () {
			const sub1 = yield* subscribeToRelayEvents;
			const sub2 = yield* subscribeToRelayEvents;
			yield* publishRelayEvent(accepted("cmd-a"));

			const first = yield* Queue.take(sub1);
			const second = yield* Queue.take(sub2);

			expect(first._tag).toBe("ClientCommandAccepted");
			expect(second._tag).toBe("ClientCommandAccepted");
		}).pipe(Effect.provide(Layer.fresh(makeRelayEventBusLive()))),
	);

	it.scoped("uses a bounded sliding buffer for slow subscribers", () =>
		Effect.gen(function* () {
			const sub = yield* subscribeToRelayEvents;

			yield* publishRelayEvent(accepted("cmd-a"));
			yield* publishRelayEvent(accepted("cmd-b"));
			yield* publishRelayEvent(accepted("cmd-c"));

			const first = yield* Queue.take(sub);
			const second = yield* Queue.take(sub);

			expect(first).toMatchObject({
				_tag: "ClientCommandAccepted",
				command: { commandId: "cmd-b" },
			});
			expect(second).toMatchObject({
				_tag: "ClientCommandAccepted",
				command: { commandId: "cmd-c" },
			});
		}).pipe(
			Effect.provide(Layer.fresh(makeRelayEventBusLive({ capacity: 2 }))),
		),
	);

	it("documents the production replay buffer size", () => {
		expect(RELAY_EVENT_BUS_CAPACITY).toBe(256);
	});
});
