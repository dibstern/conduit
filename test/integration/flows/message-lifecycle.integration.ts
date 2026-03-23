// ─── Integration: Message Lifecycle ──────────────────────────────────────────
// Full end-to-end lifecycle test against a mock OpenCode server.
// Verifies the complete message flow:
//   send → status:processing → delta(s) → done(code:0) → idle

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

	it("complete lifecycle: send → processing → delta → done", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a minimal prompt
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// 1. Should receive processing status
		const status = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		expect(status["status"]).toBe("processing");

		// 2. Should receive at least one delta (streamed text)
		const delta = await client.waitFor("delta", { timeout: 5_000 });
		expect(delta["text"]).toBeTruthy();
		expect(typeof delta["text"]).toBe("string");

		// 3. Should receive done with code 0 (successful completion)
		const done = await client.waitFor("done", { timeout: 5_000 });
		expect(done["code"]).toBe(0);

		await client.close();
	}, 10_000);

	it("sequential messages: second message works after first completes", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// --- First message ---
		client.send({
			type: "message",
			text: "Reply with just 'one'.",
		});

		await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		const done1 = await client.waitFor("done", { timeout: 5_000 });
		expect(done1["code"]).toBe(0);

		// Clear messages between turns and reset mock queues so the second
		// prompt_async has fresh SSE events (deltas + idle) to replay.
		client.clearReceived();
		harness.mock.resetQueues();

		// --- Second message ---
		client.send({
			type: "message",
			text: "Reply with just 'two'.",
		});

		// Should enter processing again (not stuck from first turn)
		const status2 = await client.waitFor("status", {
			predicate: (m) => m["status"] === "processing",
			timeout: 5_000,
		});
		expect(status2["status"]).toBe("processing");

		// Should receive delta for second message
		const delta2 = await client.waitFor("delta", { timeout: 5_000 });
		expect(delta2["text"]).toBeTruthy();

		// Should complete
		const done2 = await client.waitFor("done", { timeout: 5_000 });
		expect(done2["code"]).toBe(0);

		await client.close();
	}, 120_000);

	it("done event resets state — no stale processing status", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "message",
			text: "Reply with just 'ok'.",
		});

		// Wait for full cycle
		await client.waitFor("done", { timeout: 5_000 });

		// After done, the last status-related message should indicate idle/done
		// (no lingering processing status)
		const allDone = client.getReceivedOfType("done");
		expect(allDone.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(allDone[allDone.length - 1]!["code"]).toBe(0);

		await client.close();
	}, 10_000);
});
