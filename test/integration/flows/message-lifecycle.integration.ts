// Full end-to-end lifecycle test against a mock OpenCode server.
// Verifies the complete message flow:
//   send → busy shell row → transcript text → completed idle shell row

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Message Lifecycle", () => {
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

	it("complete lifecycle: send → processing → transcript text → idle", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// Send a minimal prompt
		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// 1. The session's shell row shows the turn started
		await client.waitForTurnStart();

		// 2. The detail subscription publishes the assistant's text.
		const message = await client.waitForAssistantText();
		expect(message.text).toBeTruthy();
		expect(typeof message.text).toBe("string");

		// 3. The shell reports a completed turn, with no processing state left.
		const done = await client.waitForTurnEnd();
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");

		await client.close();
	}, 15_000);

	it("sequential messages: second message works after first completes", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// --- First message ---
		await client.sendMessage("Reply with just 'one'.");

		await client.waitForTurnStart();
		const done1 = await client.waitForTurnEnd();
		expect(done1.status).toBe("idle");
		expect(done1.attention).not.toBe("error");

		// Clear messages between turns and reset mock queues so the second
		// prompt_async has fresh SSE events (deltas + idle) to replay.
		client.clearReceived();
		harness.mock.resetQueues();

		// --- Second message ---
		await client.sendMessage("Reply with just 'two'.");

		// Should enter processing again (not stuck from first turn)
		await client.waitForTurnStart();

		const message2 = await client.waitForAssistantText();
		expect(message2.text).toBeTruthy();

		// Should complete
		const done2 = await client.waitForTurnEnd();
		expect(done2.status).toBe("idle");
		expect(done2.attention).not.toBe("error");
		expect(done2.lastTurnEndVersion).toBeGreaterThan(
			done1.lastTurnEndVersion ?? 0,
		);

		await client.close();
	}, 120_000);

	it("turn completion resets state without stale processing status", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		await client.sendMessage("Reply with just 'ok'.");

		const done = await client.waitForTurnEnd();
		expect(done.lastTurnEndVersion).toBeGreaterThan(0);
		expect(done.status).toBe("idle");
		expect(done.processing).not.toBe(true);
		expect(done.attention).not.toBe("error");

		await client.close();
	}, 15_000);
});
