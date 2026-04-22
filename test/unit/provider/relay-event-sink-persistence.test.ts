// Integration test: RelayEventSink → real EventStore + ProjectionRunner → SQLite → session history
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistenceLayer } from "../../../src/lib/persistence/persistence-layer.js";
import { ReadQueryService } from "../../../src/lib/persistence/read-query-service.js";
import { SessionSeeder } from "../../../src/lib/persistence/session-seeder.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import { resolveSessionHistoryFromSqlite } from "../../../src/lib/session/session-switch.js";
import {
	makeMessageCreatedEvent,
	makeTextDelta,
} from "../../helpers/persistence-factories.js";

describe("RelayEventSink persistence integration", () => {
	let layer: PersistenceLayer;

	afterEach(() => {
		layer?.close();
	});

	it("persisted Claude events are retrievable via resolveSessionHistoryFromSqlite", async () => {
		layer = PersistenceLayer.memory();
		layer.projectionRunner.recover();

		const seeder = new SessionSeeder(layer.db);
		const send = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "s1",
			send,
			persist: {
				eventStore: layer.eventStore,
				projectionRunner: layer.projectionRunner,
				ensureSession: (sid) => seeder.ensureSession(sid, "claude"),
			},
		});

		// Push a message.created + text.delta (simulates Claude assistant turn)
		await sink.push(
			makeMessageCreatedEvent("s1", "m1", {
				role: "assistant",
			}),
		);
		await sink.push(makeTextDelta("s1", "m1", "Hello from Claude"));

		// Verify session history is now available from SQLite
		const readQuery = new ReadQueryService(layer.db);
		const source = resolveSessionHistoryFromSqlite("s1", readQuery, {
			pageSize: 50,
		});

		expect(source.kind).toBe("rest-history");
		if (source.kind === "rest-history") {
			expect(source.history.messages.length).toBeGreaterThanOrEqual(1);
			// The assistant message should have text content
			const assistantMsg = source.history.messages.find(
				(m) => m.role === "assistant",
			);
			expect(assistantMsg).toBeDefined();
		}

		// Verify WebSocket send was also called
		expect(send).toHaveBeenCalled();
	});

	it("session row is created with provider 'claude'", async () => {
		layer = PersistenceLayer.memory();
		layer.projectionRunner.recover();

		const seeder = new SessionSeeder(layer.db);
		const send = vi.fn();
		const sink = createRelayEventSink({
			sessionId: "s-claude",
			send,
			persist: {
				eventStore: layer.eventStore,
				projectionRunner: layer.projectionRunner,
				ensureSession: (sid) => seeder.ensureSession(sid, "claude"),
			},
		});

		await sink.push(
			makeMessageCreatedEvent("s-claude", "m1", { role: "assistant" }),
		);

		// Verify session row exists with correct provider
		const row = layer.db.queryOne<{ provider: string }>(
			"SELECT provider FROM sessions WHERE id = ?",
			["s-claude"],
		);
		expect(row?.provider).toBe("claude");
	});
});
