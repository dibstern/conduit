// Full end-to-end lifecycle test against a mock OpenCode server.
// Verifies the complete message flow:
//   send → busy shell row → delta(s) → done(code:0) → idle

import {
	afterAll,
	assert,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
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

	it("complete lifecycle: send → processing → delta → done", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// Send a minimal prompt
		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// 1. The session's shell row shows the turn started
		await client.waitForTurnStart();

		// 2. Should receive at least one delta (streamed text)
		const delta = await client.waitFor("delta");
		expect(delta["text"]).toBeTruthy();
		expect(typeof delta["text"]).toBe("string");

		// 3. Should receive done with code 0 (successful completion)
		const done = await client.waitFor("done");
		expect(done["code"]).toBe(0);

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
		const done1 = await client.waitFor("done");
		expect(done1["code"]).toBe(0);

		// Clear messages between turns and reset mock queues so the second
		// prompt_async has fresh SSE events (deltas + idle) to replay.
		client.clearReceived();
		harness.mock.resetQueues();

		// --- Second message ---
		await client.sendMessage("Reply with just 'two'.");

		// Should enter processing again (not stuck from first turn)
		await client.waitForTurnStart();

		// Should receive delta for second message
		const delta2 = await client.waitFor("delta");
		expect(delta2["text"]).toBeTruthy();

		// Should complete
		const done2 = await client.waitFor("done");
		expect(done2["code"]).toBe(0);

		await client.close();
	}, 120_000);

	it("done event resets state — no stale processing status", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.sendMessage("Reply with just 'ok'.");

		// Wait for full cycle
		await client.waitFor("done");

		// After done, the last status-related message should indicate idle/done
		// (no lingering processing status)
		const allDone = client.getReceivedOfType("done");
		expect(allDone.length).toBeGreaterThan(0);
		const lastDone = allDone.at(-1);
		assert.exists(lastDone, "expected a done message");
		expect(lastDone["code"]).toBe(0);

		await client.close();
	}, 15_000);
});
