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
		await client.subscribeShell();
		client.clearReceived();

		// Send a simple message
		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// The session's shell row shows the turn started
		await client.waitForTurnStart();
		await client.waitFor("done");

		await client.close();
	}, 15_000);

	it("receives streamed delta events from a real prompt", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a minimal prompt that should produce a short response
		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// Wait for at least one delta (streamed text)
		const delta = await client.waitFor("delta");
		expect(delta["text"]).toBeTruthy();
		expect(typeof delta["text"]).toBe("string");

		// Wait for done signal
		const done = await client.waitFor("done");
		expect(done["code"]).toBe(0);

		// result events (from message.updated) may or may not arrive depending
		// on SSE event ordering — the critical path is delta + done above
		await client.close();
	}, 15_000);

	it("does not send flat text field to OpenCode (Bug A)", async () => {
		// This test verifies the fix for the original 400 error.
		// We send a message and verify no error comes back.
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.sendMessage("Reply with just 'ok'");

		// A rejected prompt (the original 400) would end the turn failed.
		const done = await client.waitFor("done");
		expect(done["error"]).toBeUndefined();

		await client.close();
	}, 15_000);
});
