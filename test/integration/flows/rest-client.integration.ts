// ─── Integration: REST API Client ────────────────────────────────────────────
// Tests the OpenCodeClient class against a mock OpenCode server.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	OpenCodeClient,
	type SessionDetail,
} from "../../../src/lib/instance/opencode-client.js";
import { loadOpenCodeRecording } from "../../e2e/helpers/recorded-loader.js";
import { MockOpenCodeServer } from "../../helpers/mock-opencode-server.js";

describe("Integration: REST API Client", () => {
	let client: OpenCodeClient;
	let mock: MockOpenCodeServer;

	beforeAll(async () => {
		const recording = loadOpenCodeRecording("chat-simple");
		mock = new MockOpenCodeServer(recording);
		await mock.start();
		client = new OpenCodeClient({ baseUrl: mock.url });
	});

	afterAll(async () => {
		if (mock) await mock.stop();
	});

	// ── Health ────────────────────────────────────────────────────────────

	it("getHealth returns ok", async () => {
		const health = await client.getHealth();
		expect(health).toBeDefined();
	}, 10_000);

	// ── Project info ──────────────────────────────────────────────────────

	it("getPath returns project directory info", async () => {
		const result = await client.getPath();
		expect(result).toBeDefined();
		// OpenCode returns { home, state, config, worktree, directory }
		const r = result as Record<string, unknown>;
		expect(typeof r["directory"]).toBe("string");
		expect((r["directory"] as string).length).toBeGreaterThan(0);
	}, 10_000);

	// ── Sessions ──────────────────────────────────────────────────────────

	it("listSessions returns an array", async () => {
		const sessions = await client.listSessions();
		expect(Array.isArray(sessions)).toBe(true);
	}, 10_000);

	it("createSession returns a session with id", async () => {
		const session = await client.createSession({
			title: "integration-test-session",
		});
		expect(session).toBeDefined();
		expect(typeof session.id).toBe("string");
		expect(session.id.length).toBeGreaterThan(0);

		// Cleanup
		await client.deleteSession(session.id);
	}, 15_000);

	it("getSession returns the created session", async () => {
		const created = await client.createSession({
			title: "integration-test-get",
		});

		const fetched = await client.getSession(created.id);
		expect(fetched.id).toBe(created.id);

		// Cleanup
		await client.deleteSession(created.id);
	}, 15_000);

	it("deleteSession removes the session", async () => {
		const session = await client.createSession({
			title: "integration-test-delete",
		});

		await client.deleteSession(session.id);

		// Verify it's gone (listSessions should not include it)
		const sessions = await client.listSessions();
		const found = sessions.find((s: SessionDetail) => s.id === session.id);
		expect(found).toBeUndefined();
	}, 15_000);

	it("listSessions includes a newly created session", async () => {
		const session = await client.createSession({
			title: "integration-test-list",
		});

		const sessions = await client.listSessions();
		const found = sessions.find((s: SessionDetail) => s.id === session.id);
		expect(found).toBeDefined();

		// Cleanup
		await client.deleteSession(session.id);
	}, 15_000);

	// ── Discovery ─────────────────────────────────────────────────────────

	it("listProviders returns providers with models", async () => {
		const result = await client.listProviders();
		expect(result).toBeDefined();
		expect(Array.isArray(result.providers)).toBe(true);
		expect(result.providers.length).toBeGreaterThan(0);

		// At least one provider should have models
		const withModels = result.providers.find(
			(p) => Array.isArray(p.models) && p.models.length > 0,
		);
		expect(withModels).toBeDefined();
	}, 10_000);

	it("listAgents returns an array of agents", async () => {
		const agents = await client.listAgents();
		expect(Array.isArray(agents)).toBe(true);
		// OpenCode should have at least a default agent
		expect(agents.length).toBeGreaterThan(0);
		// OpenCode agents have `name` field
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(typeof agents[0]!.name).toBe("string");
	}, 10_000);

	// ── Messages ──────────────────────────────────────────────────────────

	it("getMessages returns messages for a session", async () => {
		const session = await client.createSession({
			title: "integration-test-messages",
		});

		const messages = await client.getMessages(session.id);
		expect(Array.isArray(messages)).toBe(true);

		// Cleanup
		await client.deleteSession(session.id);
	}, 15_000);

	// ── PTY via REST ──────────────────────────────────────────────────────

	it("createPty and deletePty work via REST", async () => {
		const pty = await client.createPty();
		expect(pty).toBeDefined();
		expect(typeof pty.id).toBe("string");

		await client.deletePty(pty.id);
	}, 15_000);

	it("listPtys includes a created PTY", async () => {
		const pty = await client.createPty();

		const ptys = await client.listPtys();
		expect(Array.isArray(ptys)).toBe(true);
		const found = ptys.find((p: { id: string }) => p.id === pty.id);
		expect(found).toBeDefined();

		// Cleanup
		await client.deletePty(pty.id);
	}, 15_000);

	it("resizePty does not throw", async () => {
		const pty = await client.createPty();

		await expect(client.resizePty(pty.id, 120, 40)).resolves.not.toThrow();

		// Cleanup
		await client.deletePty(pty.id);
	}, 15_000);

	// ── Error handling ────────────────────────────────────────────────────

	it("getSession with invalid id throws", async () => {
		await expect(
			client.getSession("nonexistent-session-id-12345"),
		).rejects.toThrow();
	}, 10_000);

	// ── Base URL normalization ────────────────────────────────────────────

	it("works with trailing slash in base URL", async () => {
		const clientWithSlash = new OpenCodeClient({
			baseUrl: `${mock.url}/`,
		});
		const health = await clientWithSlash.getHealth();
		expect(health).toBeDefined();
	}, 10_000);
});
