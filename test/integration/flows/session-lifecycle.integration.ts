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

		const msg = await client.createSession("Test Session");
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
		const switched = await client.createSession(title);
		const newId = switched["id"] as string;
		// Verify the broadcast session list includes the new session.
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
		const switchMsg = await client.createSession("Switch Target");
		expect(switchMsg["id"]).toBeTruthy();
		client.clearReceived();

		// Now switch back to the first session
		const msg = await client.switchSession(firstId);
		expect(msg["id"]).toBe(firstId);

		await client.close();
	});

	// ── Rename ──────────────────────────────────────────────────────────────

	it("rename a session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session
		const switched = await client.createSession("Before Rename");
		const sessionId = switched["id"] as string;
		client.clearReceived();

		// Rename it
		const newTitle = "Renamed-Session-Test";
		await client.renameSession(sessionId, newTitle);

		// Verify the broadcast session list includes the new title.
		const list = await client.waitFor("session_list", {
			timeout: 5000,
			predicate: (msg) => {
				const sessions = msg["sessions"] as
					| Array<{ id: string; title?: string }>
					| undefined;
				return (
					Array.isArray(sessions) &&
					sessions.some((s) => s.id === sessionId && s.title === newTitle)
				);
			},
		});
		const sessions = list["sessions"] as Array<{ id: string; title?: string }>;
		const found = sessions.find((s) => s.id === sessionId);
		expect(found).toBeTruthy();
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(found!.title).toBe(newTitle);

		await client.close();
	});

	// ── Delete ──────────────────────────────────────────────────────────────

	it("delete a session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session to delete
		const switched = await client.createSession("To Be Deleted");
		const sessionId = switched["id"] as string;
		client.clearReceived();

		// Delete it
		await client.deleteSession(sessionId);

		// Verify the broadcast session list no longer includes it.
		const list = await client.waitFor("session_list", {
			timeout: 5000,
			predicate: (msg) => {
				const sessions = msg["sessions"] as Array<{ id: string }> | undefined;
				return (
					Array.isArray(sessions) && !sessions.some((s) => s.id === sessionId)
				);
			},
		});
		const sessions = list["sessions"] as Array<{ id: string }>;
		const found = sessions.find((s) => s.id === sessionId);
		expect(found).toBeUndefined();

		await client.close();
	});

	// ── Search ──────────────────────────────────────────────────────────────

	it("search sessions by query", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session with a unique, searchable title
		const uniqueTag = "Searchable-Integration-Test";
		const switched = await client.createSession(uniqueTag);
		expect(switched["id"]).toBeTruthy();
		client.clearReceived();

		// Search for it
		const msg = await client.searchSessions(uniqueTag);
		const sessions = msg.sessions;
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
		const msg = await client.searchSessions(
			"NoMatchWillEverExist-zzz-integration",
		);
		const sessions = msg.sessions;
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
		const switchMsg = await client.createSession("Reset State Test");
		expect(switchMsg["id"]).toBeTruthy();

		// Now switch back — should get session_switched + session_list
		client.clearReceived();
		const switched = await client.switchSession(firstId);
		expect(switched["id"]).toBe(firstId);

		// After switching, verify we also get an updated session list
		const list = await client.waitFor("session_list", { timeout: 5000 });
		expect(Array.isArray(list["sessions"])).toBe(true);

		await client.close();
	});
});
