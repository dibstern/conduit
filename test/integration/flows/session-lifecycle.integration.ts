// ─── Integration: Session Lifecycle ──────────────────────────────────────────
// Tests session management operations: create, switch, rename, delete, and
// search sessions through the relay WebSocket interface.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Session Lifecycle", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	// ── Create ──────────────────────────────────────────────────────────────

	it("create session and receive session_switched", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		client.send({ type: "new_session", title: "Test Session" });
		const msg = await client.waitFor("session_switched", { timeout: 5000 });
		expect(msg["id"]).toBeTruthy();
		expect(typeof msg["id"]).toBe("string");

		await client.close();
	});

	it("created session appears in session_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session with a deterministic title
		const title = "Lifecycle-List-Test";
		client.send({ type: "new_session", title });
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		const newId = switched["id"] as string;
		client.clearReceived();

		// List sessions and verify the new one is present
		client.send({ type: "list_sessions" });
		const list = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = list["sessions"] as Array<{ id: string; title?: string }>;
		expect(Array.isArray(sessions)).toBe(true);

		const found = sessions.find((s) => s.id === newId);
		expect(found).toBeTruthy();

		await client.close();
	});

	// ── Switch ──────────────────────────────────────────────────────────────

	it("switch to a different session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session ID
		const initialSwitched = client.getReceivedOfType("session_switched");
		expect(initialSwitched.length).toBeGreaterThan(0);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const firstId = initialSwitched[0]!["id"] as string;

		// Create a second session (this switches to it automatically)
		client.clearReceived();
		client.send({ type: "new_session", title: "Switch Target" });
		const switchMsg = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(switchMsg["id"]).toBeTruthy();
		client.clearReceived();

		// Now switch back to the first session
		client.send({ type: "switch_session", sessionId: firstId });
		const msg = await client.waitFor("session_switched", { timeout: 5000 });
		expect(msg["id"]).toBe(firstId);

		await client.close();
	});

	// ── Rename ──────────────────────────────────────────────────────────────

	// SKIPPED: The mock returns static pre-recorded session lists from GET /session.
	// Mutations (rename, delete) succeed at the API level (200/204) but the side
	// effects are not reflected in subsequent list queries. Needs a stateful mock
	// or a live OpenCode instance.
	it.skip("rename a session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session
		client.send({ type: "new_session", title: "Before Rename" });
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		const sessionId = switched["id"] as string;
		client.clearReceived();

		// Rename it
		const newTitle = "Renamed-Session-Test";
		client.send({ type: "rename_session", sessionId, title: newTitle });

		// Give the rename a moment to take effect
		await new Promise((r) => setTimeout(r, 500));
		client.clearReceived();

		// List sessions and verify the title changed
		client.send({ type: "list_sessions" });
		const list = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = list["sessions"] as Array<{ id: string; title?: string }>;
		const found = sessions.find((s) => s.id === sessionId);
		expect(found).toBeTruthy();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(found!.title).toBe(newTitle);

		await client.close();
	});

	// ── Delete ──────────────────────────────────────────────────────────────

	// SKIPPED: Static mock lists — see rename test above.
	it.skip("delete a session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session to delete
		client.send({ type: "new_session", title: "To Be Deleted" });
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		const sessionId = switched["id"] as string;
		client.clearReceived();

		// Delete it
		client.send({ type: "delete_session", sessionId });

		// Give the delete a moment to propagate
		await new Promise((r) => setTimeout(r, 500));
		client.clearReceived();

		// List sessions and verify it is gone
		client.send({ type: "list_sessions" });
		const list = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = list["sessions"] as Array<{ id: string }>;
		const found = sessions.find((s) => s.id === sessionId);
		expect(found).toBeUndefined();

		await client.close();
	});

	// ── Search ──────────────────────────────────────────────────────────────

	// SKIPPED: The mock's GET /session/search returns a static empty array.
	// A dynamically created session title won't appear in search results.
	it.skip("search sessions by query", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session with a unique, searchable title
		const uniqueTag = "Searchable-Integration-Test";
		client.send({ type: "new_session", title: uniqueTag });
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(switched["id"]).toBeTruthy();
		client.clearReceived();

		// Search for it
		client.send({ type: "search_sessions", query: uniqueTag });
		const msg = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = msg["sessions"] as Array<{ id: string; title?: string }>;
		expect(Array.isArray(sessions)).toBe(true);

		const found = sessions.find((s) => s.title?.includes(uniqueTag));
		expect(found).toBeTruthy();

		await client.close();
	});

	it("search sessions returns empty for no match", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Search for something that should not match anything
		client.send({
			type: "search_sessions",
			query: "NoMatchWillEverExist-zzz-integration",
		});
		const msg = await client.waitFor("session_list", { timeout: 5000 });
		const sessions = msg["sessions"] as Array<{ id: string }>;
		expect(Array.isArray(sessions)).toBe(true);
		expect(sessions).toHaveLength(0);

		await client.close();
	});

	// ── State reset on switch ───────────────────────────────────────────────

	it("switching session broadcasts session_switched and session_list", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session
		const initialSwitched = client.getReceivedOfType("session_switched");
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		const firstId = initialSwitched[0]!["id"] as string;

		// Create a new session (auto-switches)
		client.clearReceived();
		client.send({ type: "new_session", title: "Reset State Test" });
		const switchMsg = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(switchMsg["id"]).toBeTruthy();

		// Now switch back — should get session_switched + session_list
		client.clearReceived();
		client.send({ type: "switch_session", sessionId: firstId });
		const switched = await client.waitFor("session_switched", {
			timeout: 5000,
		});
		expect(switched["id"]).toBe(firstId);

		// After switching, verify we also get an updated session list
		const list = await client.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(list["sessions"])).toBe(true);

		await client.close();
	});
});
