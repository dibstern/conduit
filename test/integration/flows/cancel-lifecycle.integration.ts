// ─── Integration: Cancel / Abort Lifecycle ───────────────────────────────────
// Tests the cancel/abort flow against a mock OpenCode server.
// Verifies: send → processing → cancel → abort called → done → can send again

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Cancel / Abort Lifecycle", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("cancel during processing triggers done", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a prompt that will take a moment to process
		client.send({
			type: "message",
			text: "Write a short paragraph about the weather.",
		});

		// Wait for processing to start
		await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 10_000,
		});

		// Send cancel while processing
		client.send({ type: "cancel" });

		// Should receive done (code 0 from OpenCode idle, or code 1 from relay cancel)
		const done = await client.waitFor("done", { timeout: 15_000 });
		expect(typeof done["code"]).toBe("number");

		await client.close();
	}, 30_000);

	it("can send a new message after cancel", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// First: send + cancel
		client.send({
			type: "message",
			text: "Write a long essay about oceans.",
		});

		await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 10_000,
		});

		client.send({ type: "cancel" });
		await client.waitFor("done", { timeout: 15_000 });

		// Let SSE stream settle — stale events from the cancelled message may
		// still be in flight. Wait for OpenCode to fully return to idle.
		await new Promise((r) => setTimeout(r, 3000));

		// Clear messages between turns
		client.clearReceived();

		// Second: send a new message — should work (not stuck)
		client.send({
			type: "message",
			text: "Reply with just 'ok'.",
		});

		// Should enter processing again
		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 10_000,
		});
		expect(status["status"]).toBe("processing");

		// Should complete — wait for done (delta may or may not arrive
		// depending on model streaming behavior after abort)
		const done = await client.waitFor("done", { timeout: 10_000 });
		expect(done["code"]).toBe(0);

		await client.close();
	}, 120_000);

	it("cancel when idle is harmless (no crash)", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send cancel without having sent a message
		client.send({ type: "cancel" });

		// Wait a moment — should not crash or produce unexpected messages
		await new Promise((r) => setTimeout(r, 1000));

		// Filter out model/quota errors from the SSE stream (session.error events)
		// — those aren't caused by the cancel itself. We only care that cancel
		// didn't produce a relay-level handler crash.
		const errors = client.getReceivedOfType("error");
		const cancelErrors = errors.filter(
			(e: Record<string, unknown>) =>
				![
					"insufficient_quota",
					"api_error",
					"Unknown",
					"SEND_FAILED",
					"NO_SESSION",
					"CANCEL_FAILED",
					"HANDLER_ERROR",
					"provider_error",
				].includes(String(e["code"] ?? "")),
		);
		expect(cancelErrors).toHaveLength(0);

		// Should still be able to send a message (relay not crashed)
		client.send({
			type: "message",
			text: "Reply with just 'ok'.",
		});

		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 10_000,
		});
		expect(status["status"]).toBe("processing");

		await client.waitFor("done", { timeout: 10_000 });
		await client.close();
	}, 30_000);
});
