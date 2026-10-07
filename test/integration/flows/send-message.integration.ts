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
		await client.waitForTurnEnd();

		await client.close();
	}, 15_000);

	it("receives assistant text through the detail subscription", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a minimal prompt that should produce a short response
		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		const message = await client.waitForAssistantText();
		expect(message.text).toBeTruthy();
		expect(typeof message.text).toBe("string");

		const done = await client.waitForTurnEnd();
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");
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
		const done = await client.waitForTurnEnd();
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");

		await client.close();
	}, 15_000);
});
