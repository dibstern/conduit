// ─── Integration: Multi-Client ────────────────────────────────────────────────
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

	it("both clients receive session_list on connect", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();

		await client1.waitForInitialState();
		await client2.waitForInitialState();

		const list1 = client1.getReceivedOfType("session_list");
		const list2 = client2.getReceivedOfType("session_list");

		expect(list1.length).toBeGreaterThan(0);
		expect(list2.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(Array.isArray(list1[0]!["sessions"])).toBe(true);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(Array.isArray(list2[0]!["sessions"])).toBe(true);

		await client1.close();
		await client2.close();
	});

	it("model switch from one client broadcasts to another", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		client1.send({
			type: "switch_model",
			modelId: "multi-test-model",
			providerId: "multi-test-provider",
		});

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

		client1.send({ type: "new_session", title: "Multi-Client Test Session" });

		// The creating client should get session_switched
		const switched1 = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const newSessionId = switched1["id"] as string;
		expect(newSessionId).toBeTruthy();

		// The other client receives session_list broadcast (not session_switched)
		// since new_session only switches the requesting client's tab.
		// sendDualSessionLists sends roots then all — use a predicate to wait
		// for the list that actually contains the new session ID.
		const list2 = await client2.waitFor("session_list", {
			timeout: 5000,
			predicate: (m) => {
				const sessions = m["sessions"] as Array<{ id?: string }> | undefined;
				return (
					Array.isArray(sessions) && sessions.some((s) => s.id === newSessionId)
				);
			},
		});
		expect(Array.isArray(list2["sessions"])).toBe(true);
		const sessions = list2["sessions"] as Array<{ id?: string }>;
		const newSession = sessions.find((s) => s.id === newSessionId);
		expect(newSession).toBeTruthy();

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

		client1.send({ type: "input_sync", text: "hello from client1" });

		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("hello from client1");

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

		// Give the server a moment to process the disconnect
		await new Promise((r) => setTimeout(r, 500));

		// client2 should still be fully functional
		client2.clearReceived();
		client2.send({ type: "get_agents" });
		const msg = await client2.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);

		await client2.close();
	});
});
