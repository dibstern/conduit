// ─── Unit: SSEConsumer TrackedService integration ────────────────────────────
// Tests SSEConsumer's TrackedService lifecycle (drain, registry registration).

import { describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { SSEConsumer } from "../../../src/lib/relay/sse-consumer.js";

describe("SSEConsumer – TrackedService", () => {
	it("registers itself with the ServiceRegistry on construction", () => {
		const registry = new ServiceRegistry();
		expect(registry.size).toBe(0);

		new SSEConsumer(registry, { baseUrl: "http://localhost:1234" });

		expect(registry.size).toBe(1);
	});

	it("drain() calls disconnect and stops the SSE stream", async () => {
		const registry = new ServiceRegistry();
		const consumer = new SSEConsumer(registry, {
			baseUrl: "http://localhost:1234",
			backoff: { baseDelay: 50, maxDelay: 50 },
		});

		// Spy on disconnect to verify drain invokes it
		const disconnectSpy = vi.spyOn(consumer, "disconnect");

		// Start consuming (will fail to connect but that's fine for this test)
		const errorSeen = new Promise<void>((resolve) => {
			consumer.on("error", () => resolve());
		});
		await consumer.connect();
		// Wait for the initial connection error
		await errorSeen;

		// Drain should disconnect and clean up
		await consumer.drain();

		expect(disconnectSpy).toHaveBeenCalled();
		expect(consumer.isConnected()).toBe(false);
	});

	it("drain via registry.drainAll() disconnects the consumer", async () => {
		const registry = new ServiceRegistry();
		const consumer = new SSEConsumer(registry, {
			baseUrl: "http://localhost:1234",
			backoff: { baseDelay: 50, maxDelay: 50 },
		});

		const disconnectSpy = vi.spyOn(consumer, "disconnect");

		// Start consuming (will fail to connect)
		const errorSeen = new Promise<void>((resolve) => {
			consumer.on("error", () => resolve());
		});
		await consumer.connect();
		await errorSeen;

		// drainAll on the registry should cascade to the consumer
		await registry.drainAll();

		expect(disconnectSpy).toHaveBeenCalled();
		expect(consumer.isConnected()).toBe(false);
	});
});
