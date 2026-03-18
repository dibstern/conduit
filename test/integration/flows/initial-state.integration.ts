// ─── Integration: Initial State on Connect ───────────────────────────────────
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

	it("sends session_switched on connect", async () => {
		const client = await harness.connectWsClient();
		const msg = await client.waitFor("session_switched");
		expect(msg["id"]).toBeTruthy();
		expect(typeof msg["id"]).toBe("string");
		await client.close();
	});

	it("sends status: idle on connect", async () => {
		const client = await harness.connectWsClient();
		const msg = await client.waitFor("status");
		expect(msg["status"]).toBe("idle");
		await client.close();
	});

	it("sends session_list on connect", async () => {
		const client = await harness.connectWsClient();
		const msg = await client.waitFor("session_list");
		expect(Array.isArray(msg["sessions"])).toBe(true);
		expect((msg["sessions"] as unknown[]).length).toBeGreaterThan(0);
		await client.close();
	});

	it("sends agent_list on connect", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const msg = client.getReceivedOfType("agent_list");
		expect(msg.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const agents = msg[0]!["agents"] as Array<{ id: string; name: string }>;
		expect(Array.isArray(agents)).toBe(true);
		// OpenCode should have at least one agent
		expect(agents.length).toBeGreaterThan(0);
		// Each agent should have id and name
		for (const a of agents) {
			expect(a.id).toBeTruthy();
			expect(a.name).toBeTruthy();
		}
		await client.close();
	});

	it("sends model_list on connect", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const msg = client.getReceivedOfType("model_list");
		expect(msg.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const providers = msg[0]!["providers"] as Array<{
			id: string;
			name: string;
			models: unknown[];
		}>;
		expect(Array.isArray(providers)).toBe(true);
		expect(providers.length).toBeGreaterThan(0);
		await client.close();
	});

	it("second client also receives full initial state", async () => {
		const client1 = await harness.connectWsClient();
		await client1.waitForInitialState();

		const client2 = await harness.connectWsClient();
		await client2.waitForInitialState();

		const types2 = client2.getReceived().map((m) => m.type);
		expect(types2).toContain("session_switched");
		expect(types2).toContain("status");
		expect(types2).toContain("session_list");

		await client1.close();
		await client2.close();
	});
});
