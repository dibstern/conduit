// ─── Integration: SSE to WS Pipeline ─────────────────────────────────────────
// Verifies that SSE events from OpenCode flow through the relay and arrive at
// WebSocket clients. Sends prompts and observes the full event pipeline:
// SSE -> translator -> WebSocket broadcast.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: SSE to WS Pipeline", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(() => {
		harness.mock.resetQueues();
	});

	it("SSE consumer is running after relay startup", async () => {
		// The SSE consumer connect() is fire-and-forget, so isConnected() may
		// not be true immediately. But it should be running (this.running=true).
		// The best proof is that SSE events actually flow — tested below.
		// Here we just verify the consumer was started successfully.
		const consumer = harness.stack.sseConsumer;
		// The consumer object exists and was wired up
		expect(consumer).toBeTruthy();

		// Give it a moment to connect, then check
		await new Promise((r) => setTimeout(r, 1000));
		// After a second, it should be connected (if mock is running)
		const health = consumer.getHealth();
		expect(health.connected).toBe(true);
	});

	it("sending a prompt produces status:processing then done", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Should get processing status (sent immediately by the relay on message send)
		const processing = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		expect(processing["status"]).toBe("processing");

		// The event translator maps session.updated(idle) → { type: "done", code: 0 }
		// So we wait for "done" not "status: idle"
		const done = await client.waitFor("done", { timeout: 5_000 });
		expect(done["code"]).toBe(0);

		await client.close();
	}, 10_000);

	it("delta events contain incremental text", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Collect delta events until done
		await client.waitFor("done", { timeout: 5_000 });

		const deltas = client.getReceivedOfType("delta");
		expect(deltas.length).toBeGreaterThan(0);

		// Each delta should have text content
		for (const delta of deltas) {
			expect(typeof delta["text"]).toBe("string");
			expect((delta["text"] as string).length).toBeGreaterThan(0);
		}

		await client.close();
	}, 10_000);

	it("done event arrives after deltas", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for done
		await client.waitFor("done", { timeout: 5_000 });

		const all = client.getReceived();
		const deltaIndex = all.findIndex((m) => m.type === "delta");
		const doneIndex = all.findIndex((m) => m.type === "done");

		// At least one delta must exist before done
		expect(deltaIndex).toBeGreaterThanOrEqual(0);
		expect(doneIndex).toBeGreaterThan(deltaIndex);

		await client.close();
	}, 10_000);

	it("multiple clients all receive same SSE-sourced events", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		// Send prompt from client1
		client1.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Both clients should receive delta events
		const [delta1, delta2] = await Promise.all([
			client1.waitFor("delta", { timeout: 5_000 }),
			client2.waitFor("delta", { timeout: 5_000 }),
		]);
		expect(delta1["text"]).toBeTruthy();
		expect(delta2["text"]).toBeTruthy();

		// Both should receive done
		await Promise.all([
			client1.waitFor("done", { timeout: 5_000 }),
			client2.waitFor("done", { timeout: 5_000 }),
		]);

		// Both clients should have received delta events
		const deltas1 = client1.getReceivedOfType("delta");
		const deltas2 = client2.getReceivedOfType("delta");
		expect(deltas1.length).toBeGreaterThan(0);
		expect(deltas2.length).toBeGreaterThan(0);

		await client1.close();
		await client2.close();
	}, 10_000);

	it("done signal arrives after completion with no errors", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for the full cycle: processing → deltas → done
		const done = await client.waitFor("done", { timeout: 5_000 });
		expect(done["code"]).toBe(0);

		// Verify no relay-level errors occurred during the pipeline
		// (filter out SSE-sourced session.error events from previous tests)
		const errors = client.getReceivedOfType("error");
		const pipelineErrors = errors.filter(
			(e) =>
				!["insufficient_quota", "api_error", "Unknown"].includes(
					String((e as Record<string, unknown>)["code"] ?? ""),
				),
		);
		expect(pipelineErrors).toHaveLength(0);

		await client.close();
	}, 10_000);
});
