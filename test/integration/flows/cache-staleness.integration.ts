import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Cache Staleness Detection", () => {
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

	it("falls back to REST when mock reports more messages than cache contains", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Create a fresh session and send a message to populate the cache
		client.send({ type: "new_session", title: "Staleness Test" });
		const newSession = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionA = newSession["id"] as string;

		// Send a message so the cache accumulates events for session A
		client.send({
			type: "message",
			text: "Reply with just the word 'hello'",
			sessionId: sessionA,
		});

		// Wait for a delta to ensure events are cached
		await client.waitFor("delta", { timeout: 10_000 });

		// Wait for processing to finish
		await new Promise((r) => setTimeout(r, 3_000));

		// Verify the cache has events for this session
		const cachedEvents = await harness.stack.messageCache.getEvents(sessionA);
		expect(cachedEvents).toBeTruthy();
		if (!cachedEvents) throw new Error("expected cached events");
		expect(cachedEvents.some((e) => e.type === "user_message")).toBe(true);

		// Now inject a mock response that reports MORE messages than the cache
		// has, simulating messages that arrived while the daemon was down.
		// The recording replay populates the cache with many events, so the
		// unique message count (user_messages + distinct messageIds) can be
		// high. Compute the actual cached count and exceed it by a wide margin.
		// Messages must pass normalizeMessage validation (need id, role, sessionID).
		const { countUniqueMessages } = await import(
			"../../../src/lib/session/session-switch.js"
		);
		const cachedUniqueCount = countUniqueMessages(cachedEvents);
		const fakeCount = cachedUniqueCount + 100;
		const fakeMessages = Array.from({ length: fakeCount }, (_, i) => ({
			id: `msg_fake_${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			sessionID: sessionA,
			parts: [{ type: "text", text: `fake message ${i}` }],
			time: { created: Date.now() - (20 - i) * 1000 },
		}));
		harness.mock.setExactResponse(
			"GET",
			`/session/${sessionA}/message`,
			200,
			fakeMessages,
		);

		// Switch away to a new session, then back to A
		client.send({ type: "new_session", title: "Temp Session" });
		await client.waitFor("session_switched", { timeout: 5_000 });

		// Clear and switch back — this triggers resolveSessionHistory which
		// fetches 20 messages, but cache has fewer → REST fallback
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		const switchBack = await client.waitFor("session_switched", {
			timeout: 10_000,
			predicate: (m) => m["id"] === sessionA,
		});

		// The key assertion: when the cache is stale, the relay falls back to
		// REST and sends `history` instead of `events`.
		const hasHistory = "history" in switchBack && switchBack["history"] != null;
		const hasEvents = "events" in switchBack && switchBack["events"] != null;

		expect(hasHistory).toBe(true);
		expect(hasEvents).toBe(false);

		await client.close();
	}, 30_000);
});
