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

		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

		await client.close();
	});

	it("unknown message type returns error", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "nonexistent_type" });

		// Should receive an error response about unknown message type
		const errMsg = await client.waitFor("system_error", { timeout: 3000 });
		expect(errMsg["code"]).toBe("UNKNOWN_MESSAGE_TYPE");
		expect(typeof errMsg["message"]).toBe("string");

		await client.close();
	});

	it("GetFileContent RPC with non-existent path fails without crashing", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		try {
			const result = await client.getFileContent("/nonexistent/path/file.txt");
			expect(result.path).toBe("/nonexistent/path/file.txt");
			expect(typeof result.content).toBe("string");
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
		}

		// Verify the server is still alive
		client.clearReceived();
		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

		await client.close();
	});

	it("removed legacy message command is rejected gracefully", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Browser sends now use RPC; the old WS command should be treated as
		// an unknown legacy command, not routed to the prompt handler.
		client.send({ type: "message" });

		const errMsg = await client.waitFor("system_error", { timeout: 3000 });
		expect(errMsg["code"]).toBe("UNKNOWN_MESSAGE_TYPE");

		// Verify the client is still connected and functional
		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

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
		client.send({ type: "get_file_content", path: "/does/not/exist.txt" }); // removed legacy WS command
		client.send({ type: "message" }); // removed legacy WS command

		// Wait for the server to process them all
		await new Promise((r) => setTimeout(r, 2000));

		// Now send a valid request and verify the server still works
		client.clearReceived();
		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);
		expect(result.agents.length).toBeGreaterThan(0);

		await client.close();
	});
});
