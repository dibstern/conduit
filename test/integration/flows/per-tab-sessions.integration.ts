// ─── Integration: Per-Tab Sessions ────────────────────────────────────────────
// Verifies that each WebSocket client (browser tab) can independently view
// different sessions. Tests the per-tab session routing introduced by the
// view_session / setClientSession / sendToSession system.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

	// ── Independent Session Viewing ──────────────────────────────────────────

	it("two clients can view different sessions independently", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create two sessions via client1
		client1.clearReceived();
		client1.send({ type: "new_session", title: "Tab-A Session" });
		const switchedA = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const sessionA = switchedA["id"] as string;

		client1.clearReceived();
		client1.send({ type: "new_session", title: "Tab-B Session" });
		const switchedB = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const sessionB = switchedB["id"] as string;

		// Client1 views session A, Client2 views session B
		client1.clearReceived();
		client2.clearReceived();

		client1.send({ type: "view_session", sessionId: sessionA });
		client2.send({ type: "view_session", sessionId: sessionB });

		// Each client gets its own session_switched for the session it viewed
		const view1 = await client1.waitFor("session_switched", { timeout: 5000 });
		const view2 = await client2.waitFor("session_switched", { timeout: 5000 });

		expect(view1["id"]).toBe(sessionA);
		expect(view2["id"]).toBe(sessionB);

		await client1.close();
		await client2.close();
	});

	it("view_session sends status to the requesting client", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Get any session ID
		client.send({ type: "list_sessions" });
		const list = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = list["sessions"] as Array<{ id: string }>;
		expect(sessions.length).toBeGreaterThan(0);

		client.clearReceived();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		client.send({ type: "view_session", sessionId: sessions[0]!.id });

		// Should receive session_switched AND status
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(switched["id"]).toBe(sessions[0]!.id);

		const status = await client.waitFor("status", { timeout: 5000 });
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
		const initial2 = client2.getReceivedOfType("session_switched");
		expect(initial2.length).toBeGreaterThan(0);

		client1.clearReceived();
		client2.clearReceived();

		// Client1 creates a new session
		client1.send({ type: "new_session", title: "Per-Tab New Session" });

		// Client1 should get session_switched with the new ID
		const switched1 = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(switched1["id"]).toBeTruthy();

		// Client2 should get session_list (broadcast) but NOT session_switched
		const list2 = await client2.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(list2["sessions"])).toBe(true);

		// Wait a moment then verify client2 did NOT get session_switched
		await new Promise((r) => setTimeout(r, 500));
		const switches2 = client2.getReceivedOfType("session_switched");
		expect(switches2).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	// ── Session List Broadcasts to All ───────────────────────────────────────

	it("session list updates reach all clients regardless of viewed session", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Have them view different sessions first
		client1.clearReceived();
		client1.send({ type: "new_session", title: "List-Broadcast-A" });
		const a = await client1.waitFor("session_switched", { timeout: 5000 });

		client2.clearReceived();
		client2.send({ type: "view_session", sessionId: a["id"] as string });
		await client2.waitFor("session_switched", { timeout: 5000 });

		// Now create another session from client1 — both should get updated list
		client1.clearReceived();
		client2.clearReceived();
		client1.send({ type: "new_session", title: "List-Broadcast-B" });
		const b = await client1.waitFor("session_switched", { timeout: 5000 });

		// Both clients should get session_list
		const list1 = await client1.waitFor("session_list", { timeout: 5000 });
		const list2 = await client2.waitFor("session_list", { timeout: 5000 });

		expect(Array.isArray(list1["sessions"])).toBe(true);
		expect(Array.isArray(list2["sessions"])).toBe(true);

		// Both lists should contain the new session
		const sessions1 = list1["sessions"] as Array<{ id: string }>;
		const sessions2 = list2["sessions"] as Array<{ id: string }>;
		expect(sessions1.find((s) => s.id === b["id"])).toBeTruthy();
		expect(sessions2.find((s) => s.id === b["id"])).toBeTruthy();

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
		client1.send({ type: "new_session", title: "Sync-Session" });
		const switched = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const sharedId = switched["id"] as string;

		// Both clients view the same session
		client2.clearReceived();
		client2.send({ type: "view_session", sessionId: sharedId });
		await client2.waitFor("session_switched", { timeout: 5000 });

		// Clear and send input_sync from client1
		client1.clearReceived();
		client2.clearReceived();
		client1.send({ type: "input_sync", text: "typing from tab1" });

		// Client2 should receive it (same session)
		const msg = await client2.waitFor("input_sync", { timeout: 3000 });
		expect(msg["text"]).toBe("typing from tab1");

		await client1.close();
		await client2.close();
	});

	it("input_sync does NOT reach clients viewing a different session", async () => {
		// Reset queues to ensure fresh POST /session entries are available
		// (prior tests may have exhausted the queue, causing duplicate session IDs)
		harness.mock.resetQueues();

		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create two sessions
		client1.clearReceived();
		client1.send({ type: "new_session", title: "Input-Sync-A" });
		const a = await client1.waitFor("session_switched", { timeout: 5000 });

		client1.clearReceived();
		client1.send({ type: "new_session", title: "Input-Sync-B" });
		const b = await client1.waitFor("session_switched", { timeout: 5000 });

		// Client1 views session A, Client2 views session B
		client1.clearReceived();
		client2.clearReceived();
		client1.send({ type: "view_session", sessionId: a["id"] as string });
		client2.send({ type: "view_session", sessionId: b["id"] as string });
		await client1.waitFor("session_switched", { timeout: 5000 });
		await client2.waitFor("session_switched", { timeout: 5000 });

		// Send input_sync from client1 (session A)
		client1.clearReceived();
		client2.clearReceived();
		client1.send({ type: "input_sync", text: "isolated input" });

		// Wait and verify client2 (session B) does NOT receive it
		await new Promise((r) => setTimeout(r, 1000));
		const syncs = client2.getReceivedOfType("input_sync");
		expect(syncs).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	// ── Delete Session Scoping ───────────────────────────────────────────────

	// Skip: mock's POST /session queue returns the same canned ID after exhaustion,
	// so the redirect-after-delete gets the same ID as the deleted session.
	// Needs a stateful mock or live OpenCode to test properly.
	it.skip("deleting the viewed session only switches the requesting client", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Create a session for client1 to delete
		client1.clearReceived();
		client1.send({ type: "new_session", title: "To-Delete-PerTab" });
		const created = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const deleteId = created["id"] as string;

		// Client1 views the session-to-delete
		client1.clearReceived();
		client1.send({ type: "view_session", sessionId: deleteId });
		await client1.waitFor("session_switched", { timeout: 5000 });

		// Client2 views a different session (the initial one)
		client2.clearReceived();

		// Delete from client1
		client1.clearReceived();
		client1.send({ type: "delete_session", sessionId: deleteId });

		// Client1 should be redirected to another session
		const redirected = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(redirected["id"]).toBeTruthy();
		expect(redirected["id"]).not.toBe(deleteId);

		// Both should get updated session_list
		const list1 = await client1.waitFor("session_list", { timeout: 5000 });
		const list2 = await client2.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(list1["sessions"])).toBe(true);
		expect(Array.isArray(list2["sessions"])).toBe(true);

		// Deleted session should not appear in either list
		const sessions1 = list1["sessions"] as Array<{ id: string }>;
		const sessions2 = list2["sessions"] as Array<{ id: string }>;
		expect(sessions1.find((s) => s.id === deleteId)).toBeUndefined();
		expect(sessions2.find((s) => s.id === deleteId)).toBeUndefined();

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
		client1.send({ type: "new_session", title: "Model-Switch-PerTab" });
		const created = await client1.waitFor("session_switched", {
			timeout: 5000,
		});
		const sharedId = created["id"] as string;

		// Both clients view the same session
		client2.clearReceived();
		client2.send({ type: "view_session", sessionId: sharedId });
		await client2.waitFor("session_switched", { timeout: 5000 });

		// Switch model from client1
		client1.clearReceived();
		client2.clearReceived();
		client1.send({
			type: "switch_model",
			modelId: "per-tab-test-model",
			providerId: "per-tab-test-provider",
		});

		// Client2 should receive model_info (same session)
		const modelMsg = await client2.waitFor("model_info", { timeout: 5000 });
		expect(modelMsg["model"]).toBe("per-tab-test-model");
		expect(modelMsg["provider"]).toBe("per-tab-test-provider");

		await client1.close();
		await client2.close();
	});
});
