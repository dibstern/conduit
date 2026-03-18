// ─── Integration: Switch to Streaming Session ────────────────────────────────
// Verifies Bug 1: after switching to a session that is actively streaming,
// live delta events should arrive in real-time (not just cached replay).
//
// Scenario:
//   1. Session A starts streaming a long response
//   2. User switches away to Session B (A continues streaming in background)
//   3. User switches back to Session A while it's still streaming
//   4. Live delta events should arrive after the switch

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

	it("live deltas arrive after switching to an actively streaming session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session (Session A)
		const initialSwitched = client.getReceivedOfType("session_switched");
		expect(initialSwitched.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const sessionA = initialSwitched[0]!["id"] as string;

		// ── Step 1: Start a long-running prompt on Session A ────────
		client.clearReceived();
		client.send({
			type: "message",
			text:
				"Write a detailed 500-word essay about the history of computing, " +
				"from Charles Babbage to modern AI. Include specific dates and names. " +
				"Do not stop early or abbreviate.",
		});

		// Wait for the first streaming event — proof that streaming has started.
		// Some models start with thinking/reasoning before text output,
		// so we accept either delta or thinking_delta as the first event.
		const firstDelta = await client.waitForAny(["delta", "thinking_delta"], {
			timeout: 60_000,
		});
		expect(firstDelta["text"]).toBeTruthy();

		// Collect a few more deltas to confirm steady streaming
		await new Promise((r) => setTimeout(r, 1_500));
		const preSwitchDeltas = client
			.getReceived()
			.filter((m) => m.type === "delta" || m.type === "thinking_delta");
		expect(preSwitchDeltas.length).toBeGreaterThan(1);

		// ── Step 2: Switch away to a new Session B ──────────────────
		client.clearReceived();
		client.send({
			type: "new_session",
			title: "Streaming Bug Test - Session B",
		});
		const switchedToB = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionB = switchedToB["id"] as string;
		expect(sessionB).toBeTruthy();

		// Brief pause on Session B — Session A is still streaming.
		await new Promise((r) => setTimeout(r, 500));

		// Verify no Session A deltas leak through while B is active
		const leakedDeltas = client.getReceivedOfType("delta");
		expect(leakedDeltas.length).toBe(0);

		// ── Step 3: Switch back to Session A (still streaming) ──────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		// Should receive session_switched for Session A
		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedBack["id"]).toBe(sessionA);

		// ── Step 4: Verify live deltas arrive after switch ──────────
		const postSwitchDelta = await client.waitForAny(
			["delta", "thinking_delta"],
			{ timeout: 30_000 },
		);
		expect(postSwitchDelta["text"]).toBeTruthy();
		expect(typeof postSwitchDelta["text"]).toBe("string");
		expect((postSwitchDelta["text"] as string).length).toBeGreaterThan(0);

		// Collect more events to prove sustained streaming (not just one cached event)
		await new Promise((r) => setTimeout(r, 2_000));
		const postSwitchDeltas = client
			.getReceived()
			.filter((m) => m.type === "delta" || m.type === "thinking_delta");

		// We should have multiple streaming events proving the stream is flowing
		expect(postSwitchDeltas.length).toBeGreaterThan(1);

		// Wait for the full response to complete (cleanup)
		await client.waitFor("done", { timeout: 120_000 });

		await client.close();
	}, 180_000);

	it("cached events replay AND live streaming both work after switch", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		const initialSwitched = client.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const sessionA = initialSwitched[0]!["id"] as string;

		// ── Start streaming on Session A ────────────────────────────
		client.clearReceived();
		client.send({
			type: "message",
			text:
				"Write a long, detailed explanation of how TCP/IP networking works, " +
				"covering all 4 layers with examples. At least 400 words.",
		});

		// Wait for streaming to start and accumulate cached events
		await client.waitForAny(["delta", "thinking_delta"], { timeout: 60_000 });
		await new Promise((r) => setTimeout(r, 2_000));

		const cachedDeltaCount = client
			.getReceived()
			.filter((m) => m.type === "delta" || m.type === "thinking_delta").length;
		expect(cachedDeltaCount).toBeGreaterThan(2);

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
		await new Promise((r) => setTimeout(r, 500));

		// ── Switch back ─────────────────────────────────────────────
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: sessionA });

		const switchedBack = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		expect(switchedBack["id"]).toBe(sessionA);

		// The session_switched message should contain cached events
		const hasEvents = Array.isArray(
			(switchedBack as Record<string, unknown>)["events"],
		);
		const hasHistory = !!(switchedBack as Record<string, unknown>)["history"];
		// Should have either events (cache hit) or history (REST fallback)
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

		// Now verify LIVE streaming continues after the cached replay
		const liveDelta = await client.waitForAny(["delta", "thinking_delta"], {
			timeout: 30_000,
		});
		expect(liveDelta["text"]).toBeTruthy();

		// Wait for completion
		await client.waitFor("done", { timeout: 120_000 });

		await client.close();
	}, 180_000);
});
