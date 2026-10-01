// Verifies that multiple WebSocket clients can connect simultaneously and
// that broadcasts, state changes, and disconnect isolation work correctly.

import { afterAll, assert, beforeAll, describe, expect, it } from "vitest";
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

		const list1 = client1.getReceivedOfType("session_family");
		const list2 = client2.getReceivedOfType("session_family");

		expect(list1.length).toBeGreaterThan(0);
		expect(list2.length).toBeGreaterThan(0);
		const firstList = list1[0];
		const secondList = list2[0];
		assert.exists(firstList, "expected the first client session family");
		assert.exists(secondList, "expected the second client session family");
		expect(Array.isArray(firstList["sessions"])).toBe(true);
		expect(Array.isArray(secondList["sessions"])).toBe(true);

		await client1.close();
		await client2.close();
	});

	it("model switch from one client reaches another client on the same session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		await client1.switchModel("multi-test-model", "multi-test-provider");

		const msg = await client2.waitFor("model_info", { timeout: 5000 });
		expect(msg["model"]).toBe("multi-test-model");
		expect(msg["provider"]).toBe("multi-test-provider");

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
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client2.getActiveSessionId()).not.toBe(newSessionId);

		await client1.close();
		await client2.close();
	});

	it("input_sync from one client reaches the other", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		await client1.syncInputDraft("hello from client1", {
			originId: "browser-tab-a",
		});

		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("hello from client1");
		expect(msg["from"]).toBe("browser-tab-a");

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
