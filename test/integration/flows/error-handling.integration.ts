// Verifies that malformed RPC input and failed requests leave the server usable.

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

	it("rejects the removed project RPC socket", async () => {
		const socket = new WebSocket(
			`ws://127.0.0.1:${harness.relayPort}/p/integration-test/rpc`,
		);
		try {
			const error = await new Promise<Error>((resolve, reject) => {
				socket.once("error", resolve);
				socket.once("open", () =>
					reject(new Error("Removed socket path opened")),
				);
			});
			expect(error).toMatchObject({ code: "ECONNRESET" });
		} finally {
			socket.terminate();
		}
	});

	it("sending invalid JSON does not crash the server", async () => {
		// Exercise malformed input on the RPC transport.
		const rawWs = new WebSocket(`ws://127.0.0.1:${harness.relayPort}/rpc`);
		await new Promise<void>((resolve, reject) => {
			rawWs.once("open", resolve);
			rawWs.once("error", reject);
		});

		// The malformed client may be closed; the server must remain available.
		rawWs.send("this is not valid json {{{");
		rawWs.send("<<<>>>");

		// Close the raw socket
		if (rawWs.readyState !== WebSocket.CLOSED) {
			await new Promise<void>((resolve) => {
				rawWs.once("close", () => resolve());
				rawWs.close();
			});
		}

		// Verify the server is still alive by connecting a proper client
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

		await client.close();
	});

	it("a failed RPC leaves the same client usable", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await expect(
			client.rpcCall((rpc) =>
				rpc.GetToolContent({
					projectSlug: "integration-test",
					toolId: "nonexistent-tool",
				}),
			),
		).rejects.toThrow("Full tool content not available");

		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);

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

	it("server remains functional after errors", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		for (const toolId of [
			"missing-tool-1",
			"missing-tool-2",
			"missing-tool-3",
		]) {
			await expect(
				client.rpcCall((rpc) =>
					rpc.GetToolContent({
						projectSlug: "integration-test",
						toolId,
					}),
				),
			).rejects.toThrow("Full tool content not available");
		}

		// Now send a valid request and verify the server still works
		client.clearReceived();
		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);
		expect(result.agents.length).toBeGreaterThan(0);

		await client.close();
	});
});
