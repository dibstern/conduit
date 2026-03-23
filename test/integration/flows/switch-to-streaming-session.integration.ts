// ─── Integration: Switch to Streaming Session ────────────────────────────────
// Verifies that after switching to a session that has been streaming,
// the client receives the session's streamed content (via cached replay
// or REST history in the session_switched payload).
//
// With a mock server, SSE events fire near-instantly so the stream completes
// before a session switch can occur mid-stream. The tests verify the relay's
// cache/history mechanism delivers the content on switch-back.

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

	it("deltas arrive after switching to a session that streamed", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session (Session A)
		const initialSwitched = client.getReceivedOfType("session_switched");
		expect(initialSwitched.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const sessionA = initialSwitched[0]!["id"] as string;

		// ── Step 1: Start a prompt on Session A ────────────────────
		client.clearReceived();
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for streaming to start — proof that deltas arrive.
		const firstDelta = await client.waitForAny(["delta", "thinking_delta"], {
			timeout: 5_000,
		});
		expect(firstDelta["text"]).toBeTruthy();

		// Wait for the full cycle to complete
		await client.waitFor("done", { timeout: 5_000 });

		// ── Step 2: Switch away to a new Session B ──────────────────
		client.clearReceived();
		client.send({
			type: "new_session",
			title: "Streaming Bug Test - Session B",
		});
		const switchedToB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedToB["id"]).toBeTruthy();

		// Verify no Session A deltas leak through while B is active
		const leakedDeltas = client.getReceivedOfType("delta");
		expect(leakedDeltas.length).toBe(0);

		// ── Step 3: Switch back to Session A ────────────────────────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		// Should receive session_switched for Session A
		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedBack["id"]).toBe(sessionA);

		// ── Step 4: Verify session content is available after switch ─
		// The relay provides the session's content via cached events
		// in the session_switched payload or via REST history.
		const hasEvents = Array.isArray(
			(switchedBack as Record<string, unknown>)["events"],
		);
		const hasHistory = !!(switchedBack as Record<string, unknown>)["history"];

		expect(hasEvents || hasHistory).toBe(true);

		if (hasEvents) {
			const events = (
				switchedBack as unknown as { events: Array<{ type: string }> }
			).events;
			const cachedDeltas = events.filter(
				(e) => e.type === "delta" || e.type === "thinking_delta",
			);
			expect(cachedDeltas.length).toBeGreaterThan(0);
		}

		await client.close();
	}, 15_000);

	it("cached events replay after switch contains streamed content", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		const initialSwitched = client.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const sessionA = initialSwitched[0]!["id"] as string;

		// ── Start streaming on Session A ────────────────────────────
		client.clearReceived();
		client.send({
			type: "message",
			text: "Reply with just the word 'pong'. Nothing else.",
		});

		// Wait for streaming to start
		await client.waitForAny(["delta", "thinking_delta"], { timeout: 5_000 });

		// Wait for full cycle
		await client.waitFor("done", { timeout: 5_000 });

		const cachedDeltaCount = client
			.getReceived()
			.filter((m) => m.type === "delta" || m.type === "thinking_delta").length;
		expect(cachedDeltaCount).toBeGreaterThanOrEqual(1);

		// ── Switch away briefly ─────────────────────────────────────
		client.clearReceived();
		client.send({
			type: "new_session",
			title: "Cache+Live Test - Session B",
		});
		const switchedToB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedToB["id"]).toBeTruthy();

		// ── Switch back ─────────────────────────────────────────────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedBack["id"]).toBe(sessionA);

		// The session_switched message should contain cached events or history
		const hasEvents = Array.isArray(
			(switchedBack as Record<string, unknown>)["events"],
		);
		const hasHistory = !!(switchedBack as Record<string, unknown>)["history"];
		expect(hasEvents || hasHistory).toBe(true);

		if (hasEvents) {
			const events = (
				switchedBack as unknown as { events: Array<{ type: string }> }
			).events;
			// Should include streaming events from the cached stream
			const cachedDeltas = events.filter(
				(e) => e.type === "delta" || e.type === "thinking_delta",
			);
			expect(cachedDeltas.length).toBeGreaterThan(0);
		}

		await client.close();
	}, 15_000);
});
