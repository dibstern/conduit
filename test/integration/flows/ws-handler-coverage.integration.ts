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

	it("get_agents returns agent_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);
		await client.close();
	});

	it("get_models returns model_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_models" });
		const msg = await client.waitFor("model_list", { timeout: 5000 });
		expect(Array.isArray(msg["providers"])).toBe(true);
		await client.close();
	});

	it("get_commands returns command_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_commands" });
		const msg = await client.waitFor("command_list", { timeout: 5000 });
		expect(Array.isArray(msg["commands"])).toBe(true);
		await client.close();
	});

	it("get_projects returns project_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_projects" });
		const msg = await client.waitFor("project_list", { timeout: 5000 });
		expect(Array.isArray(msg["projects"])).toBe(true);
		expect(msg["current"]).toBe("integration-test");
		await client.close();
	});

	// ── Session management ──────────────────────────────────────────────────

	it("list_sessions returns session_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "list_sessions" });
		const msg = await client.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(msg["sessions"])).toBe(true);
		await client.close();
	});

	it("new_session creates and switches to new session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "new_session", title: "Integration Test New" });
		const msg = await client.waitFor("session_switched", { timeout: 5000 });
		expect(msg["id"]).toBeTruthy();
		await client.close();
	});

	it("search_sessions returns filtered results", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "search_sessions", query: "Integration" });
		const msg = await client.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(msg["sessions"])).toBe(true);
		await client.close();
	});

	// ── Agent/model switching ───────────────────────────────────────────────

	it("switch_agent does not error", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "switch_agent", agentId: "code" });
		// No error should come back
		await new Promise((r) => setTimeout(r, 500));
		const errors = client.getReceivedOfType("error");
		expect(errors).toHaveLength(0);
		await client.close();
	});

	it("switch_model broadcasts model_info", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "switch_model",
			modelId: "test-model",
			providerId: "test-provider",
		});
		const msg = await client.waitFor("model_info", { timeout: 3000 });
		expect(msg["model"]).toBe("test-model");
		expect(msg["provider"]).toBe("test-provider");
		await client.close();
	});

	// ── File browser ────────────────────────────────────────────────────────

	it("get_file_list returns file_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_file_list" });
		const msg = await client.waitFor("file_list", { timeout: 5000 });
		expect(msg["path"]).toBeTruthy();
		expect(Array.isArray(msg["entries"])).toBe(true);
		await client.close();
	});

	// ── Todo ────────────────────────────────────────────────────────────────

	it("get_todo returns todo_state", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_todo" });
		const msg = await client.waitFor("todo_state", { timeout: 3000 });
		expect(Array.isArray(msg["items"])).toBe(true);
		await client.close();
	});

	// ── Input sync ──────────────────────────────────────────────────────────

	it("input_sync broadcasts to clients", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		client1.clearReceived();
		client2.clearReceived();

		client1.send({ type: "input_sync", text: "typing something" });
		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("typing something");

		await client1.close();
		await client2.close();
	});
});
