// ─── Integration: Per-Tab Sessions ────────────────────────────────────────────
// Verifies that each WebSocket client (browser tab) can independently view
// different sessions. Tests the per-tab session routing introduced by the
// ViewSession / setClientSession / sendToSession system.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Per-Tab Sessions", () => {
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

	// ── Independent Session Viewing ──────────────────────────────────────────

	it("two clients can view different sessions independently", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create two sessions via client1
		client1.clearReceived();
		const switchedA = await client1.createSession("Tab-A Session");
		const sessionA = switchedA["id"] as string;

		client1.clearReceived();
		const switchedB = await client1.createSession("Tab-B Session");
		const sessionB = switchedB["id"] as string;

		// Client1 views session A, Client2 views session B
		client1.clearReceived();
		client2.clearReceived();

		const view1 = await client1.viewSession(sessionA);
		const view2 = await client2.viewSession(sessionB);

		expect(view1["id"]).toBe(sessionA);
		expect(view2["id"]).toBe(sessionB);

		await client1.close();
		await client2.close();
	});

	it("ViewSession RPC sends status to the requesting client", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No initial session");

		client.clearReceived();
		const switched = await client.viewSession(sessionId);
		expect(switched["id"]).toBe(sessionId);

		const status = await client.waitFor("status");
		expect(status["status"]).toBe("idle");

		await client.close();
	});

	// ── New Session Only Switches Requester ──────────────────────────────────

	it("new session only switches the requesting client", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Record client2's initial session
		const initial2 = client2.getActiveSessionId();
		expect(initial2).toBeTruthy();

		client1.clearReceived();
		client2.clearReceived();

		// Client1 creates a new session
		const switched1 = await client1.createSession("Per-Tab New Session");
		expect(switched1["id"]).toBeTruthy();

		// Client2 remains on its current session.
		// Observe a full window to ensure client2 gets no session switch.
		await new Promise((r) => setTimeout(r, 500));
		expect(client2.getActiveSessionId()).toBe(initial2);

		await client1.close();
		await client2.close();
	});

	// ── Viewed Family Updates ────────────────────────────────────────────────

	it("family updates reach clients viewing the renamed session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Have them view different sessions first
		client1.clearReceived();
		const a = await client1.createSession("List-Broadcast-A");

		client2.clearReceived();
		await client2.viewSession(a["id"] as string);

		// Renaming the viewed session refreshes both viewers' family.
		client1.clearReceived();
		client2.clearReceived();
		const sessionId = a["id"] as string;
		await client1.renameSession(sessionId, "Renamed for both tabs");

		const containsRenamed = (m: Record<string, unknown>) => {
			const sessions = m["sessions"] as
				| Array<{ id: string; title?: string }>
				| undefined;
			return (
				Array.isArray(sessions) &&
				sessions.some(
					(s) => s.id === sessionId && s.title === "Renamed for both tabs",
				)
			);
		};
		const list1 = await client1.waitFor("session_family", {
			predicate: containsRenamed,
		});
		const list2 = await client2.waitFor("session_family", {
			predicate: containsRenamed,
		});

		expect(Array.isArray(list1["sessions"])).toBe(true);
		expect(Array.isArray(list2["sessions"])).toBe(true);

		await client1.close();
		await client2.close();
	});

	// ── Input Sync Scoped to Same Session ────────────────────────────────────

	it("input_sync reaches clients viewing the same session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create a shared session
		client1.clearReceived();
		const switched = await client1.createSession("Sync-Session");
		const sharedId = switched["id"] as string;

		// Both clients view the same session
		client2.clearReceived();
		await client2.viewSession(sharedId);

		// Clear and send input_sync from client1
		client1.clearReceived();
		client2.clearReceived();
		await client1.syncInputDraft("typing from tab1", {
			sessionId: sharedId,
			originId: "browser-tab-a",
		});

		// Client2 should receive it (same session)
		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("typing from tab1");
		expect(msg["from"]).toBe("browser-tab-a");

		await client1.close();
		await client2.close();
	});

	it("input_sync does NOT reach clients viewing a different session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create two sessions
		client1.clearReceived();
		const a = await client1.createSession("Input-Sync-A");

		client1.clearReceived();
		const b = await client1.createSession("Input-Sync-B");

		// Client1 views session A, Client2 views session B
		client1.clearReceived();
		client2.clearReceived();
		await client1.viewSession(a["id"] as string);
		await client2.viewSession(b["id"] as string);

		// Send input_sync from client1 (session A)
		client1.clearReceived();
		client2.clearReceived();
		await client1.syncInputDraft("isolated input", {
			sessionId: a["id"] as string,
			originId: "browser-tab-a",
		});

		// Observe a full window to ensure the draft does not reach session B.
		await new Promise((r) => setTimeout(r, 1000));
		const syncs = client2.getReceivedOfType("input_sync");
		expect(syncs).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	// ── Model Switch Per-Session ─────────────────────────────────────────────

	it("model switch broadcasts model_info to clients on the same session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create a shared session
		client1.clearReceived();
		const created = await client1.createSession("Model-Switch-PerTab");
		const sharedId = created["id"] as string;

		// Both clients view the same session
		client2.clearReceived();
		await client2.viewSession(sharedId);

		// Switch model from client1
		client1.clearReceived();
		client2.clearReceived();
		await client1.switchModel("per-tab-test-model", "per-tab-test-provider");

		// Client2 should receive model_info (same session)
		const modelMsg = await client2.waitFor("model_info");
		expect(modelMsg["model"]).toBe("per-tab-test-model");
		expect(modelMsg["provider"]).toBe("per-tab-test-provider");

		await client1.close();
		await client2.close();
	});
});
