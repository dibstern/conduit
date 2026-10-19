// Verifies that multiple WebSocket clients can connect simultaneously and
// that broadcasts, state changes, and disconnect isolation work correctly.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Multi-Client", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("both clients receive their viewed session family on connect", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();

		await client1.waitForInitialState();
		await client2.waitForInitialState();

		for (const client of [client1, client2]) {
			const sessionId = client.getActiveSessionId();
			if (!sessionId) throw new Error("expected an active session");
			expect(
				client
					.getReceivedOfType("family")
					.find((msg) => msg["_tag"] === "snapshot"),
			).toMatchObject({
				familyOf: sessionId,
				rows: expect.arrayContaining([
					expect.objectContaining({ id: sessionId }),
				]),
			});
		}

		await client1.close();
		await client2.close();
	});

	it("new session from one client notifies the other", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		const created = await client1.createSession("Multi-Client Test Session");
		const newSessionId = created["id"] as string;
		expect(newSessionId).toBeTruthy();

		// CreateSession does not switch another tab.
		await client2.waitFor("shell", {
			predicate: (msg) =>
				msg["_tag"] === "upsert" &&
				(msg["item"] as Record<string, unknown> | undefined)?.["id"] ===
					newSessionId,
		});
		expect(client2.getActiveSessionId()).not.toBe(newSessionId);

		await client1.close();
		await client2.close();
	});

	it("disconnecting one client does not affect the other", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Disconnect client1
		await client1.close();

		// client2 should still be fully functional
		client2.clearReceived();
		const result = await client2.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

		await client2.close();
	});
});
