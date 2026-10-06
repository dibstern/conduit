import { EventEmitter } from "node:events";
import { Effect, ManagedRuntime, Ref } from "effect";
import { describe, expect, it } from "vitest";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
} from "../../../src/lib/domain/relay/Services/project-settings.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { wireRelayWebSocketCallbacksEffect } from "../../../src/lib/relay/websocket-callback-wiring.js";
import type { WebSocketHandlerShape } from "../../../src/lib/server/ws-handler-shape.js";

// ni8.15: the browser count is a live project fact on SubscribeProjectSettings,
// published as browsers attach and detach rather than broadcast as a frame.
describe("wireRelayWebSocketCallbacksEffect", () => {
	it("publishes the browser count as browsers attach and detach", async () => {
		const events = new EventEmitter();
		const wsHandler = {
			on: events.on.bind(events),
		} as unknown as WebSocketHandlerShape;
		const runtime = ManagedRuntime.make(ProjectSettingsLive);

		const latest = await runtime.runPromise(
			Effect.gen(function* () {
				yield* wireRelayWebSocketCallbacksEffect({
					wsHandler,
					log: createSilentLogger(),
				});
				const { live } = yield* ProjectSettingsTag;
				const read = () => Effect.runSync(Ref.get(live)).clientCount;
				events.emit("client_connected", { clientId: "a", clientCount: 1 });
				events.emit("client_connected", { clientId: "b", clientCount: 2 });
				const afterAttach = read();
				events.emit("client_disconnected", { clientId: "a", clientCount: 1 });
				return { afterAttach, afterDetach: read() };
			}),
		);
		await runtime.dispose();

		expect(latest).toEqual({
			afterAttach: { _tag: "clientCount", count: 2 },
			afterDetach: { _tag: "clientCount", count: 1 },
		});
	});
});
