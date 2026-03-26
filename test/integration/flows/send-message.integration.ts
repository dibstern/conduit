// ─── Integration: Send Message ───────────────────────────────────────────────
// Verifies Bug A: the relay sends the correct body format to OpenCode's
// prompt_async endpoint. If this test passes, messages actually work.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Send Message", () => {
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

	it("sends a message and receives processing status", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a simple message
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Should immediately get processing status
		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5000,
		});
		expect(status["status"]).toBe("processing");

		await client.close();
	}, 15_000);

	it("receives streamed delta events from a real prompt", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a minimal prompt that should produce a short response
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for at least one delta (streamed text)
		const delta = await client.waitFor("delta", { timeout: 5_000 });
		expect(delta["text"]).toBeTruthy();
		expect(typeof delta["text"]).toBe("string");

		// Wait for done signal
		const done = await client.waitFor("done", { timeout: 5_000 });
		expect(done["code"]).toBe(0);

		// result events (from message.updated) may or may not arrive depending
		// on SSE event ordering — the critical path is delta + done above
		await client.close();
	}, 10_000);

	it("does not send flat text field to OpenCode (Bug A)", async () => {
		// This test verifies the fix for the original 400 error.
		// We send a message and verify no error comes back.
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "message", text: "Reply with just 'ok'" });

		// Wait a moment for the request to be processed
		await new Promise((r) => setTimeout(r, 2000));

		// Should NOT have received a HANDLER_ERROR about 400
		const errors = client.getReceivedOfType("error");
		const promptErrors = errors.filter(
			(e) => typeof e["message"] === "string" && e["message"].includes("400"),
		);
		expect(promptErrors).toHaveLength(0);

		await client.close();
	}, 15_000);
});
