// Full end-to-end lifecycle test against a mock OpenCode server.
// Verifies the complete message flow:
//   send → busy shell row → transcript text → completed idle shell row

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Message Lifecycle", () => {
	let harness: RelayHarness;

	beforeEach(async () => {
		harness = await createRelayHarness("chat-multi-turn");
	}, 30_000);

	afterEach(async () => {
		if (harness) await harness.stop();
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
		// Live updates carry the text on its part, not the message header.
		const text = message.parts?.find((part) => part.type === "text")?.text;
		expect(text).toBeTruthy();
		expect(typeof text).toBe("string");

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

		// The multi-turn recording gives the next turn distinct message IDs.
		// Replaying the first turn would be deduplicated by the event store.
		client.clearReceived();

		// --- Second message ---
		await client.sendMessage("Reply with just 'two'.");

		// Should enter processing again (not stuck from first turn)
		await client.waitForTurnStart();

		const message2 = await client.waitForAssistantText();
		expect(
			message2.parts?.find((part) => part.type === "text")?.text,
		).toBeTruthy();

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
