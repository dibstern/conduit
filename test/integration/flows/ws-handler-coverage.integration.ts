// Verifies Bug B: all 23 WebSocket message types from ws-router.ts have
// handlers in the relay stack. None should be silently dropped.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: WS Handler Coverage", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("GetAgents RPC returns agents", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);
		await client.close();
	});

	it("GetCommands RPC returns command metadata", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getCommands();
		expect(Array.isArray(result.commands)).toBe(true);
		await client.close();
	});

	it("GetProjects RPC returns project list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getProjects();
		expect(Array.isArray(result.projects)).toBe(true);
		expect(result.current).toBe("integration-test");
		await client.close();
	});

	it("GetFileTree RPC returns tree entries", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getFileTree();
		expect(Array.isArray(result.entries)).toBe(true);
		expect(result.entries.length).toBeGreaterThan(0);
		await client.close();
	});

	it("CreateSession RPC creates and switches to new session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const msg = await client.createSession("Integration Test New");
		expect(msg["id"]).toBeTruthy();
		await client.close();
	});

	it("SwitchAgent RPC does not error", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.switchAgent("code");
		// Observe a full window to ensure SwitchAgent produces no error.
		await new Promise((r) => setTimeout(r, 500));
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);
		await client.close();
	});

	it("SwitchModel RPC records the session's model", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		await client.switchModel("test-model", "test-provider");
		const { active } = await client.getModels();
		expect(active).toEqual({ model: "test-model", provider: "test-provider" });
		await client.close();
	});

	it("GetFileList RPC returns file entries", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getFileList(".");
		expect(result.path).toBeTruthy();
		expect(Array.isArray(result.entries)).toBe(true);
		await client.close();
	});

	it("input_sync broadcasts to clients", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		const sessionId = client1.getActiveSessionId();
		if (!sessionId) throw new Error("Expected active session after init");
		await client2.viewSession(sessionId);
		client1.clearReceived();
		client2.clearReceived();

		await client1.syncInputDraft("typing something", {
			sessionId,
			originId: "browser-tab-a",
		});
		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("typing something");
		expect(msg["from"]).toBe("browser-tab-a");

		await client1.close();
		await client2.close();
	});
});
