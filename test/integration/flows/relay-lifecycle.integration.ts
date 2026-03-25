/**
 * Integration test: Relay stack stop() cleans up all services.
 *
 * Uses the existing relay harness (MockOpenCodeServer + real relay stack)
 * to verify that stopping a relay stack properly tears down all services.
 */

import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

/** Make an HTTP request and return the status code, or "ECONNREFUSED" on failure. */
async function httpStatus(url: string): Promise<number | "ECONNREFUSED"> {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", (err) => {
			if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
				resolve("ECONNREFUSED");
			} else {
				resolve(0);
			}
		});
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(0);
		});
	});
}

describe("Relay stack lifecycle (real timers)", () => {
	let harness: RelayHarness;

	afterEach(async () => {
		await harness?.stop().catch(() => {});
	});

	it("stop() shuts down the HTTP server — no more connections accepted", async () => {
		harness = await createRelayHarness("chat-simple");
		const baseUrl = harness.relayBaseUrl;

		// Relay is alive
		const statusBefore = await httpStatus(`${baseUrl}/health`);
		expect(statusBefore).toBe(200);

		// Stop the relay
		await harness.stop();

		// Server is gone
		const statusAfter = await httpStatus(`${baseUrl}/health`);
		expect(statusAfter).toBe("ECONNREFUSED");
	});

	it("stop() after WS client connected closes the client", async () => {
		harness = await createRelayHarness("chat-simple");
		const client = await harness.connectWsClient();

		// Wait for initial messages
		await new Promise((r) => setTimeout(r, 200));

		// Stop relay — should close WS connections and shut down cleanly
		// If services leak, this would hang or leave timers running
		await harness.stop();

		// Client should be disconnected — close() should resolve immediately
		// (already closed by server)
		await client.close();
	});
});
