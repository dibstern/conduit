// Verifies Bug C: when a browser connects, the relay sends all the initial
// state needed for the UI to populate (session, agents, models, etc.)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Initial State on Connect", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	});

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("serves the viewed session family over SubscribeSessionFamily", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		expect(sessionId).toBeTruthy();
		const snapshot = await client.waitFor("family", {
			predicate: (msg) =>
				msg["_tag"] === "snapshot" && msg["familyOf"] === sessionId,
		});
		expect(snapshot["rows"]).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: sessionId })]),
		);
		await client.close();
	});

	it("publishes a renamed session through its family subscription", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("expected an active session");
		await client.renameSession(sessionId, "Renamed for the family feed");
		await client.waitFor("family", {
			predicate: (msg) =>
				msg["_tag"] === "upsert" &&
				(msg["item"] as { title?: string }).title ===
					"Renamed for the family feed",
		});
		await client.close();
	});

	it("serves agents over GetAgents after connect", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const { agents } = await client.getAgents();
		// OpenCode should have at least one agent
		expect(agents.length).toBeGreaterThan(0);
		for (const a of agents) {
			expect(a.id).toBeTruthy();
			expect(a.name).toBeTruthy();
		}
		await client.close();
	});

	it("serves models over GetModels after connect", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const { providers } = await client.getModels();
		expect(providers.length).toBeGreaterThan(0);
		await client.close();
	});

	it("second client also receives full initial state", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();

		const client2 = await harness.connectWsClient();
		await client2.waitForInitialState();

		expect(client2.getReceivedOfType("family").map((m) => m["_tag"])).toContain(
			"snapshot",
		);

		await client1.close();
		await client2.close();
	});
});
