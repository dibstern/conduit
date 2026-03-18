// ─── Integration: Error Handling ──────────────────────────────────────────────
// Verifies that the relay handles malformed, unknown, and invalid messages
// gracefully without crashing the server or disconnecting the client.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Error Handling", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	it("sending invalid JSON does not crash the server", async () => {
		// Use a raw WebSocket to send non-JSON data
		const rawWs = new WebSocket(`ws://127.0.0.1:${harness.relayPort}/ws`);
		await new Promise<void>((resolve, reject) => {
			rawWs.once("open", resolve);
			rawWs.once("error", reject);
		});

		// Send garbage data
		rawWs.send("this is not valid json {{{");
		rawWs.send("<<<>>>");

		// Wait for error response(s) — the server should reply, not crash
		await new Promise((r) => setTimeout(r, 500));

		// Close the raw socket
		await new Promise<void>((resolve) => {
			rawWs.once("close", () => resolve());
			rawWs.close();
		});

		// Verify the server is still alive by connecting a proper client
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);

		await client.close();
	});

	it("unknown message type returns error", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "nonexistent_type" });

		// Should receive an error response about unknown message type
		const errMsg = await client.waitFor("error", { timeout: 3000 });
		expect(errMsg["code"]).toBe("UNKNOWN_MESSAGE_TYPE");
		expect(typeof errMsg["message"]).toBe("string");

		await client.close();
	});

	it("get_file_content with non-existent path returns response without crash", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({
			type: "get_file_content",
			path: "/nonexistent/path/file.txt",
		});

		// OpenCode may return file_content (with empty content) or an error —
		// either way, the server should not crash
		await new Promise((r) => setTimeout(r, 1000));

		// Verify the server is still alive
		client.clearReceived();
		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);

		await client.close();
	});

	it("message without text field is handled gracefully", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a "message" type without the required text field
		client.send({ type: "message" });

		// Wait for the server to process — it should not crash
		await new Promise((r) => setTimeout(r, 1000));

		// Verify the client is still connected and functional
		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);

		await client.close();
	});

	it("server remains functional after errors", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Send a barrage of invalid messages
		client.send({ type: "nonexistent_type_1" });
		client.send({ type: "nonexistent_type_2" });
		client.send({ type: "nonexistent_type_3" });
		client.send({ type: "get_file_content", path: "/does/not/exist.txt" });
		client.send({ type: "message" }); // missing text

		// Wait for the server to process them all
		await new Promise((r) => setTimeout(r, 2000));

		// Now send a valid request and verify the server still works
		client.clearReceived();
		client.send({ type: "get_agents" });
		const msg = await client.waitFor("agent_list", { timeout: 5000 });
		expect(Array.isArray(msg["agents"])).toBe(true);
		expect((msg["agents"] as unknown[]).length).toBeGreaterThan(0);

		await client.close();
	});
});
