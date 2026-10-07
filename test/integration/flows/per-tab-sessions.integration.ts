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
		const sessionId = a["id"] as string;
		await client1.subscribeFamily(sessionId);
		await client2.subscribeFamily(sessionId);
		client1.clearReceived();
		client2.clearReceived();
		await client1.renameSession(sessionId, "Renamed for both tabs");

		const renamed = (s: { id: string; title?: string }) =>
			s.id === sessionId && s.title === "Renamed for both tabs";
		await client1.waitForFamilyRows(sessionId, renamed);
		await client2.waitForFamilyRows(sessionId, renamed);

		await client1.close();
		await client2.close();
	});

	it("a draft reaches clients following the same session", async () => {
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

		// Clear and send a draft from client1
		client1.clearReceived();
		client2.clearReceived();
		await client2.subscribeInputDraft(sharedId);
		await client1.syncInputDraft("typing from tab1", {
			sessionId: sharedId,
			originId: "browser-tab-a",
		});

		// Client2 should receive it (same session)
		const msg = await client2.waitFor("input_draft", {
			timeout: 3000,
			predicate: (m) => m["_tag"] === "draft",
		});
		expect(msg["text"]).toBe("typing from tab1");
		expect(msg["from"]).toBe("browser-tab-a");

		await client1.close();
		await client2.close();
	});

	it("a draft does NOT reach clients following a different session", async () => {
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

		// Send a draft from client1 (session A)
		client1.clearReceived();
		client2.clearReceived();
		await client2.subscribeInputDraft(b["id"] as string);
		await client1.syncInputDraft("isolated input", {
			sessionId: a["id"] as string,
			originId: "browser-tab-a",
		});

		// Observe a full window to ensure the draft does not reach session B.
		await new Promise((r) => setTimeout(r, 1000));
		const syncs = client2
			.getReceivedOfType("input_draft")
			.filter((m) => m["_tag"] === "draft");
		expect(syncs).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	it("model switch reaches a peer as the session's shell row, version bumped", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		const created = await client1.createSession("Model-Switch-PerTab");
		const sharedId = created["id"] as string;
		await client2.viewSession(sharedId);
		await client2.subscribeShell();
		const lastSequence = Math.max(
			...client2
				.getReceivedOfType("shell")
				.map((msg) => Number(msg["sequence"] ?? 0)),
		);

		client2.clearReceived();
		await client1.switchModel(
			"per-tab-test-model",
			"per-tab-test-provider",
			sharedId,
		);

		// The peer sees the pick on its shell subscription: no refetch, no reconnect.
		const upsert = await client2.waitFor("shell", {
			predicate: (msg) => {
				const item = msg["item"] as Record<string, unknown> | undefined;
				return (
					msg["_tag"] === "upsert" &&
					item?.["id"] === sharedId &&
					item["model"] !== undefined
				);
			},
		});
		expect((upsert["item"] as Record<string, unknown>)["model"]).toEqual({
			model: "per-tab-test-model",
			provider: "per-tab-test-provider",
		});
		expect(upsert["sequence"]).toBeGreaterThan(lastSequence);

		await client1.close();
		await client2.close();
	});
});
