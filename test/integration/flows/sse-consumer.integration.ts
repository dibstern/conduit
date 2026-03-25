// ─── Integration: SSE Consumer ───────────────────────────────────────────────
// Tests the SSEConsumer class against a mock OpenCode server.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import { SSEConsumer } from "../../../src/lib/relay/sse-consumer.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Integration: SSE Consumer", () => {
	let consumer: SSEConsumer;
	let restClient: OpenCodeClient;
	let mock: MockOpenCodeServer;

	beforeAll(async () => {
		const recording = loadOpenCodeRecording("chat-simple");
		mock = new MockOpenCodeServer(recording);
		await mock.start();
		restClient = new OpenCodeClient({ baseUrl: mock.url });
	});

	afterEach(async () => {
		if (consumer) {
			await consumer.disconnect();
		}
	});

	afterAll(async () => {
		if (mock) await mock.stop();
	});

	// ── Connection ────────────────────────────────────────────────────────

	it("connects to real OpenCode SSE endpoint", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;

		expect(consumer.isConnected()).toBe(true);
	}, 15_000);

	it("receives events when activity occurs", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const events: unknown[] = [];
		consumer.on("event", (event) => events.push(event));

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;

		// Emit a synthetic SSE event (the consumer filters server.connected
		// and server.heartbeat, so we use session.updated which passes through)
		mock.emitTestEvent("session.updated", { id: "test" });

		// Wait for events to arrive
		await delay(1000);

		// Should have received the emitted event
		expect(events.length).toBeGreaterThan(0);
	}, 15_000);

	it("isConnected returns false before connect", () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });
		expect(consumer.isConnected()).toBe(false);
	});

	it("disconnect stops receiving events", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;
		expect(consumer.isConnected()).toBe(true);

		await consumer.disconnect();
		expect(consumer.isConnected()).toBe(false);
	}, 15_000);

	it("getHealth reports connected state", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;

		const health = consumer.getHealth();
		expect(health.stale).toBe(false);
	}, 15_000);

	it("connect is idempotent — calling twice doesn't crash", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;

		// Second connect should not throw
		await consumer.connect();
		expect(consumer.isConnected()).toBe(true);
	}, 15_000);

	it("reconnects after disconnect/reconnect cycle", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		// First connection
		let connectCount = 0;
		consumer.on("connected", () => connectCount++);

		await consumer.connect();
		await delay(2000);
		expect(connectCount).toBeGreaterThanOrEqual(1);

		// Disconnect
		await consumer.disconnect();
		expect(consumer.isConnected()).toBe(false);

		// Reconnect
		await consumer.connect();
		await delay(2000);
		expect(consumer.isConnected()).toBe(true);
		expect(connectCount).toBeGreaterThanOrEqual(2);
	}, 20_000);

	it("activity on server produces SSE events", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), { baseUrl: mock.url });

		const events: unknown[] = [];
		consumer.on("event", (event) => events.push(event));

		const connected = new Promise<void>((resolve) => {
			consumer.on("connected", () => resolve());
		});

		await consumer.connect();
		await connected;

		// Record event count before activity
		const countBefore = events.length;

		// Trigger activity: create a session, then emit a synthetic event.
		// POST /session alone only produces server.connected SSE (filtered),
		// so we emit a session.updated event that passes through the consumer.
		await restClient.createSession({ title: "sse-integration-test" });
		mock.emitTestEvent("session.updated", { id: "test-activity" });

		// Wait for events to arrive
		await delay(1000);

		// Should have received more events after the activity
		expect(events.length).toBeGreaterThan(countBefore);
	}, 20_000);

	// ── Error handling ────────────────────────────────────────────────────

	it("emits error when connecting to invalid URL", async () => {
		consumer = new SSEConsumer(new ServiceRegistry(), {
			baseUrl: "http://127.0.0.1:1",
			backoff: { baseDelay: 100, maxDelay: 100 },
		});

		const errorPromise = new Promise<Error>((resolve) => {
			consumer.on("error", (err) => resolve(err));
		});

		await consumer.connect();

		const error = await errorPromise;
		expect(error).toBeDefined();
	}, 15_000);
});
