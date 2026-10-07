// Tests session management operations: create, switch, rename, delete, and
// manage sessions through the relay WebSocket interface.

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

	it("create session and receive its id from RPC", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const msg = await client.createSession("Test Session");
		expect(msg["id"]).toBeTruthy();
		expect(typeof msg["id"]).toBe("string");

		await client.close();
	});

	it("created session appears in the viewed family", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		// Create a session with a deterministic title
		const title = "Lifecycle-Family-Test";
		const switched = await client.createSession(title);
		const newId = switched["id"] as string;
		const sessions = await client.waitForFamilyRows(
			newId,
			(row) => row.id === newId,
			5000,
		);
		expect(sessions.find((s) => s.id === newId)).toMatchObject({ title });

		await client.close();
	});

	it("switch to a different session", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session ID
		const firstId = client.getActiveSessionId();
		expect(firstId).toBeTruthy();
		if (!firstId) throw new Error("No initial session");

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

		const sessions = await client.waitForFamilyRows(
			sessionId,
			(s) => s.id === sessionId && s.title === newTitle,
			5000,
		);
		expect(sessions.find((s) => s.id === sessionId)?.title).toBe(newTitle);

		await client.close();
	});

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

		const deleted = await client.waitFor("session_deleted", {
			timeout: 5000,
			predicate: (message) => message["sessionId"] === sessionId,
		});
		expect(deleted["sessionId"]).toBe(sessionId);

		await client.close();
	});

	it("switching session returns its draft and family", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();

		// Record the initial session
		const firstId = client.getActiveSessionId();
		expect(firstId).toBeTruthy();
		if (!firstId) throw new Error("No initial session");
		await client.syncInputDraft("Unsent draft", { sessionId: firstId });
		// The family comes from the client's own SubscribeSessionFamily, opened
		// when it settled on the session, not from a push on switch.
		const family = await client.waitForFamilyRows(
			firstId,
			(row) => row.id === firstId,
			5000,
		);
		expect(family.map((row) => row.id)).toContain(firstId);

		// Create a new session (auto-switches)
		client.clearReceived();
		const switchMsg = await client.createSession("Reset State Test");
		expect(switchMsg["id"]).toBeTruthy();

		// Now switch back to the first session.
		client.clearReceived();
		const switched = await client.switchSession(firstId);
		expect(switched["id"]).toBe(firstId);
		expect(switched["draft"]).toBe("Unsent draft");

		await client.close();
	});
});
