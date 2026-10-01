import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Switch to Streaming Session", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(() => {
		harness.mock.resetQueues();
	});

	it("returns completed transcript content after switching away and back", async () => {
		const client = await harness.connectWsClient();
		try {
			await client.waitForInitialState();
			const sessionA = client.getActiveSessionId();
			expect(sessionA).toBeTruthy();
			if (!sessionA) throw new Error("No initial session");

			client.clearReceived();
			await client.sendMessage(
				"Reply with just the word 'pong'. Nothing else.",
			);
			const firstDelta = await client.waitForAny(["delta", "thinking_delta"]);
			expect(firstDelta["text"]).toBeTruthy();
			await client.waitFor("done");
			client.clearReceived();

			const created = await client.createSession(
				"Streaming Bug Test - Session B",
			);
			expect(created["id"]).not.toBe(sessionA);
			expect(
				client
					.getReceivedOfType("delta")
					.filter((message) => message["sessionId"] === sessionA),
			).toHaveLength(0);
			const viewed = await client.switchSession(sessionA);
			expect(viewed["id"]).toBe(sessionA);

			const page = await client.loadMoreHistory(sessionA);
			expect(
				page.messages.some(
					(message) => message.role === "assistant" && !!message.text,
				),
			).toBe(true);
		} finally {
			await client.close();
		}
	}, 15_000);
});
