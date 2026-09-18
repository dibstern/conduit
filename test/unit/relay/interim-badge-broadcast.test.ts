import { createServer } from "node:http";
import { Layer, ManagedRuntime } from "effect";
import { expect, it, vi } from "vitest";
import { WebSocketHandlerLive } from "../../../src/lib/domain/relay/Layers/websocket-handler-layer.js";
import {
	ConfigTag,
	LoggerTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { makeSessionEventBusLive } from "../../../src/lib/domain/relay/Services/session-event-bus.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import type { RelayMessage } from "../../../src/lib/shared-types.js";

it("broadcasts committed permission counts before a SubscribeShell consumer exists", async () => {
	const server = createServer();
	const bus = makeSessionEventBusLive();
	const persistence = makePersistenceEffectLayer(":memory:", undefined, bus);
	const dependencies = Layer.mergeAll(
		bus,
		persistence,
		Layer.succeed(ConfigTag, {
			httpServer: server,
			projectDir: "/tmp",
			slug: "test",
			opencodeUrl: "http://unused",
			noServer: true,
		}),
		Layer.succeed(LoggerTag, createSilentLogger()),
	);
	const runtime = ManagedRuntime.make(
		Layer.merge(
			dependencies,
			WebSocketHandlerLive.pipe(Layer.provide(dependencies)),
		),
	);
	try {
		const handler = await runtime.runPromise(WebSocketHandlerTag);
		const messages: RelayMessage[] = [];
		vi.spyOn(handler, "broadcast").mockImplementation((message) => {
			messages.push(message);
		});
		const commit = await runtime.runPromise(makeCommitAndSignal);
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"session.created",
					"s1",
					{ sessionId: "s1", title: "session", provider: "claude" },
					{ provider: "claude" },
				),
			]),
		);
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"permission.asked",
					"s1",
					{ id: "p1", sessionId: "s1", toolName: "bash", input: {} },
					{ provider: "claude" },
				),
			]),
		);
		const counts = () =>
			messages
				.filter((m) => m.type === "session_list")
				.flatMap((m) =>
					m.sessions
						.filter((s) => s.id === "s1")
						.map((s) => s.pendingPermissions),
				);
		await expect.poll(counts, { timeout: 700 }).toContain(1);
		messages.length = 0;
		await runtime.runPromise(
			commit([
				canonicalEvent(
					"permission.resolved",
					"s1",
					{ id: "p1", decision: "once" },
					{ provider: "claude" },
				),
			]),
		);
		await expect.poll(counts, { timeout: 700 }).toContain(0);
	} finally {
		await runtime.dispose();
		vi.restoreAllMocks();
	}
});
