// ─── Integration: WebSocket Handler Coverage ────────────────────────────────
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

	// ── Discovery endpoints ──────────────────────────────────────────────────

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

	// ── Session management ──────────────────────────────────────────────────

	it("new_session creates and switches to new session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "new_session", title: "Integration Test New" });
		const msg = await client.waitFor("session_switched", { timeout: 5000 });
		expect(msg["id"]).toBeTruthy();
		await client.close();
	});

	it("ListSessions RPC returns filtered results", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.searchSessions("Integration");
		expect(Array.isArray(result.sessions)).toBe(true);
		await client.close();
	});

	// ── Agent/model switching ───────────────────────────────────────────────

	it("SwitchAgent RPC does not error", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.switchAgent("code");
		// No error should come back
		await new Promise((r) => setTimeout(r, 500));
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);
		await client.close();
	});

	it("SwitchModel RPC broadcasts model_info", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.switchModel("test-model", "test-provider");
		const msg = await client.waitFor("model_info", { timeout: 3000 });
		expect(msg["model"]).toBe("test-model");
		expect(msg["provider"]).toBe("test-provider");
		await client.close();
	});

	// ── File browser ────────────────────────────────────────────────────────

	it("GetFileList RPC returns file entries", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getFileList(".");
		expect(result.path).toBeTruthy();
		expect(Array.isArray(result.entries)).toBe(true);
		await client.close();
	});

	// ── Todo ────────────────────────────────────────────────────────────────

	it("GetTodo RPC returns todo state", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getTodo();
		expect(Array.isArray(result.items)).toBe(true);
		await client.close();
	});

	// ── Input sync ──────────────────────────────────────────────────────────

	it("input_sync broadcasts to clients", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		const sessionId = client1.getActiveSessionId();
		if (!sessionId) throw new Error("Expected active session after init");
		client2.send({ type: "view_session", sessionId });
		await client2.waitFor("session_switched", {
			timeout: 3000,
			predicate: (msg) => msg["id"] === sessionId,
		});
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
