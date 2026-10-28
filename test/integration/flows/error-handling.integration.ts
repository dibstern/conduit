// Verifies that malformed RPC input and failed requests leave the server usable.

import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createSdkClient } from "../../../src/lib/instance/sdk-factory.js";
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

	it("times out a held provider request without retrying and recovers on the next call", async () => {
		let requests = 0;
		let holdResponse = true;
		const provider = createServer((_request, response) => {
			requests++;
			if (!holdResponse) {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify([{ name: "recovered" }]));
			}
		});
		await new Promise<void>((resolve) =>
			provider.listen(0, "127.0.0.1", resolve),
		);
		vi.stubEnv("CONDUIT_TEST_REQUEST_TIMEOUT_MS", "150");
		try {
			const address = provider.address();
			if (!address || typeof address === "string")
				throw new Error("No provider port");
			const { fetch: request } = createSdkClient({
				baseUrl: `http://127.0.0.1:${address.port}`,
				retry: { retries: 2, retryDelay: 1 },
			});
			const url = `http://127.0.0.1:${address.port}/agent`;
			const failure = await request(url).catch((error: unknown) => error);
			expect(requests, "native deadline must not retry the held request").toBe(
				1,
			);
			expect(failure).toMatchObject({
				message: "Request timed out after 150ms",
			});
			holdResponse = false;
			const recovered = await request(url);
			expect(recovered.status).toBe(200);
			expect(await recovered.json()).toEqual([{ name: "recovered" }]);
			expect(requests).toBe(2);
		} finally {
			vi.unstubAllEnvs();
			provider.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				provider.close((error) => (error ? reject(error) : resolve())),
			);
		}
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

	it("GetFileContent RPC with non-existent path fails without crashing", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		harness.mock.setExactResponse("GET", "/file/content", 404, {
			message: "File not found",
		});
		await expect(
			client.getFileContent("nonexistent/path/file.txt"),
		).rejects.toThrow("GetFileContent failed:");

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
					rpc.GetSkillContent({
						projectSlug: "integration-test",
						skillRef: toolId,
					}),
				),
			).rejects.toThrow("Skill content not available");
		}

		// Now send a valid request and verify the server still works
		client.clearReceived();
		const result = await client.getAgents();
		expect(Array.isArray(result.agents)).toBe(true);
		expect(result.agents.length).toBeGreaterThan(0);

		await client.close();
	});
});
