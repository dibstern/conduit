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
			expect(client.getActiveSessionId()).toBeTruthy();

			client.clearReceived();
			const sessionA = await client.sendMessage(
				"Reply with just the word 'pong'. Nothing else.",
			);
			const message = await client.waitForAssistantText();
			expect(message.text).toBeTruthy();
			await client.waitForTurnEnd();
			client.clearReceived();

			const created = await client.createSession(
				"Streaming Bug Test - Session B",
			);
			const sessionB = created["id"];
			if (typeof sessionB !== "string") throw new Error("No created session");
			expect(sessionB).not.toBe(sessionA);
			expect(client.getActiveSessionId()).toBe(sessionB);
			const otherPage = await client.loadMoreHistory(sessionB);
			expect(otherPage.messages).toEqual([]);
			const viewed = await client.switchSession(sessionA);
			expect(viewed["id"]).toBe(sessionA);

			const page = await client.loadMoreHistory(sessionA);
			expect(
				page.messages.some(
					(returned) =>
						returned.id === message.id &&
						returned.role === "assistant" &&
						!!returned.text,
				),
			).toBe(true);
		} finally {
			await client.close();
		}
	}, 15_000);
});
