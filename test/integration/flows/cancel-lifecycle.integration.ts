// Tests the cancel/abort flow against a mock OpenCode server.
// Verifies: send → processing → cancel → turn ends → can send again

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

	beforeEach(async () => {
		harness.mock.resetQueues();
		// Drain: a cancelled turn keeps emitting events after its first terminal update, and
		// nothing marks the end of that stream, so give it time to finish.
		await new Promise((r) => setTimeout(r, 500));
	});

	it("cancel during processing ends the turn", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// Send a prompt that will take a moment to process
		await client.sendMessage("Write a short paragraph about the weather.");

		// Wait for processing to start
		await client.waitForTurnStart();

		// Send cancel while processing
		await client.cancelSession();

		const done = await client.waitForTurnEnd(undefined, 15_000);
		expect(done.id).toBe(client.getActiveSessionId());
		expect(done.status).toBe("idle");

		await client.close();
	}, 30_000);

	it("can send a new message after cancel", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// First: send + cancel
		await client.sendMessage("Write a long essay about oceans.");

		await client.waitForTurnStart();

		await client.cancelSession();
		const cancelled = await client.waitForTurnEnd(undefined, 15_000);

		// Drain: the cancelled turn can still send late terminal updates, and no
		// event marks the end of its stream. The next turn needs fresh replay queues.
		await new Promise((r) => setTimeout(r, 3000));

		// Clear messages between turns
		client.clearReceived();

		// Second: send a new message — should work (not stuck)
		await client.sendMessage("Reply with just 'ok'.");

		// Should enter processing again
		await client.waitForTurnStart();

		const done = await client.waitForTurnEnd();
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");
		expect(done.lastTurnEndVersion).toBeGreaterThan(
			cancelled.lastTurnEndVersion ?? 0,
		);

		await client.close();
	}, 120_000);

	it("cancel when idle is harmless (no crash)", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		// Send cancel without having sent a message
		await client.cancelSession();

		// Observe a full window to ensure idle cancel produces no unexpected errors.
		await new Promise((r) => setTimeout(r, 1000));

		// Nothing was running, so the cancel must not fail a turn.
		const failedTurns = client
			.getReceivedOfType("shell")
			.filter(
				(message) =>
					message["_tag"] === "upsert" &&
					(message["item"] as { id?: string; status?: string }).id ===
						client.getActiveSessionId() &&
					((message["item"] as { status?: string }).status === "error" ||
						(message["item"] as { attention?: string }).attention === "error"),
			);
		expect(failedTurns).toHaveLength(0);

		// Should still be able to send a message (relay not crashed)
		await client.sendMessage("Reply with just 'ok'.");

		await client.waitForTurnStart();

		const done = await client.waitForTurnEnd();
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");
		await client.close();
	}, 30_000);
});
