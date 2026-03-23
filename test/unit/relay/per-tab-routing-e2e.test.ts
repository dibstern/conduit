// ─── E2E: Per-Tab Session Routing (Mock OpenCode) ────────────────────────────
// Spins up a mock OpenCode HTTP+SSE server and a real relay stack, then connects
// real WebSocket clients to verify SSE events route only to session viewers.
//
// No real OpenCode required — runs in CI without external dependencies.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";
import { TestWsClient } from "../../integration/helpers/test-ws-client.js";

// ── Mock OpenCode Server ─────────────────────────────────────────────────────
// Minimal HTTP server impersonating OpenCode's REST + SSE endpoints.
// Sessions are stored in-memory; SSE events are injected via helper function.

interface MockOpenCode {
	server: Server;
	port: number;
	sseClients: Set<ServerResponse>;
	sessions: Record<
		string,
		{ id: string; title: string; modelID: string; providerID: string }
	>;
	/** Inject an SSE event as if OpenCode sent it */
	injectSSE(event: { type: string; properties: Record<string, unknown> }): void;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	const sessions: MockOpenCode["sessions"] = {
		"sess-A": {
			id: "sess-A",
			title: "Session A",
			modelID: "gpt-4",
			providerID: "openai",
		},
		"sess-B": {
			id: "sess-B",
			title: "Session B",
			modelID: "gpt-4",
			providerID: "openai",
		},
	};
	let nextSessionNum = 1;

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		// SSE event stream — keep connection open
		if (url.pathname === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			// Send initial heartbeat so SSE consumer registers as connected
			res.write(": heartbeat\n\n");
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");

		// Health check
		if (url.pathname === "/path") {
			res.end(JSON.stringify("/test"));
			return;
		}

		// Session list
		if (url.pathname === "/session" && req.method === "GET") {
			res.end(JSON.stringify(Object.values(sessions)));
			return;
		}

		// Create session
		if (url.pathname === "/session" && req.method === "POST") {
			const id = `sess-new-${nextSessionNum++}`;
			sessions[id] = {
				id,
				title: "New Session",
				modelID: "gpt-4",
				providerID: "openai",
			};
			res.end(JSON.stringify(sessions[id]));
			return;
		}

		// Session status
		if (url.pathname === "/session/status") {
			const statuses: Record<string, unknown> = {};
			for (const id of Object.keys(sessions)) {
				statuses[id] = { type: "idle" };
			}
			res.end(JSON.stringify(statuses));
			return;
		}

		// Get specific session
		const sessionMatch = url.pathname.match(/^\/session\/([\w-]+)$/);
		if (sessionMatch && req.method === "GET") {
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			const id = sessionMatch[1]!;
			const session = sessions[id] ?? {
				id,
				title: "Unknown",
				modelID: "gpt-4",
				providerID: "openai",
			};
			res.end(JSON.stringify(session));
			return;
		}

		// Get messages for session
		const msgMatch = url.pathname.match(/^\/session\/([\w-]+)\/message$/);
		if (msgMatch && req.method === "GET") {
			res.end(JSON.stringify([]));
			return;
		}

		// Agents
		if (url.pathname === "/agent") {
			res.end(
				JSON.stringify([{ id: "coder", name: "coder", description: "Main" }]),
			);
			return;
		}

		// Providers
		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ providers: [], defaults: {}, connected: [] }));
			return;
		}

		// Fallback
		res.statusCode = 200;
		res.end("{}");
	}

	const server = createServer(handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;

	return {
		server,
		port,
		sseClients,
		sessions,
		injectSSE(event) {
			const data = JSON.stringify(event);
			for (const client of sseClients) {
				client.write(`data: ${data}\n\n`);
			}
		},
		async close() {
			for (const client of sseClients) {
				client.end();
			}
			sseClients.clear();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

// ── Test Harness ─────────────────────────────────────────────────────────────

interface TestHarness {
	relay: ProjectRelay;
	mock: MockOpenCode;
	relayPort: number;
	connectClient(opts?: { session?: string }): Promise<TestWsClient>;
	stop(): Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
	const mock = await createMockOpenCode();

	const relayServer = createServer();
	await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
	const relayPort = (relayServer.address() as { port: number }).port;

	const relay = await createProjectRelay({
		httpServer: relayServer,
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		projectDir: process.cwd(),
		slug: "test-project",
		log: createSilentLogger(), // silence logs
		statusPollerInterval: 100,
		messagePollerInterval: 150,
		pollerGatingConfig: {
			sseGracePeriodMs: 300,
			sseActiveThresholdMs: 500,
		},
	});

	// Wait for SSE to connect
	await new Promise((r) => setTimeout(r, 200));

	return {
		relay,
		mock,
		relayPort,
		async connectClient(opts?: { session?: string }) {
			let url = `ws://127.0.0.1:${relayPort}`;
			if (opts?.session) {
				url += `?session=${encodeURIComponent(opts.session)}`;
			}
			const client = new TestWsClient(url);
			await client.waitForOpen();
			return client;
		},
		async stop() {
			await relay.stop();
			await new Promise<void>((r) => relayServer.close(() => r()));
			await mock.close();
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("E2E: Per-tab session routing with mock OpenCode", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 15_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 10_000);

	it("client receives initial state on connect", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		const switched = client.getReceivedOfType("session_switched");
		expect(switched.length).toBeGreaterThan(0);

		const status = client.getReceivedOfType("status");
		expect(status.length).toBeGreaterThan(0);

		await client.close();
	});

	it("SSE chat events only reach clients viewing that session", async () => {
		const client1 = await harness.connectClient();
		const client2 = await harness.connectClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Client1 views session A, Client2 views session B
		client1.send({ type: "view_session", sessionId: "sess-A" });
		client2.send({ type: "view_session", sessionId: "sess-B" });

		await client1.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		await client2.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});

		client1.clearReceived();
		client2.clearReceived();

		// Inject an SSE text delta event for session A only
		// (message.part.delta produces a "delta" relay message; message.part.updated
		// returns null for text parts since text is streamed via deltas)
		harness.mock.injectSSE({
			type: "message.part.delta",
			properties: {
				sessionID: "sess-A",
				partID: "part-1",
				messageID: "msg-1",
				field: "text",
				delta: "hello from session A",
			},
		});

		// Client1 (viewing sess-A) should receive the delta
		const delta = await client1.waitFor("delta", { timeout: 3000 });
		expect(delta["text"]).toBe("hello from session A");

		// Client2 (viewing sess-B) should NOT receive it
		await new Promise((r) => setTimeout(r, 100));
		const client2Deltas = client2.getReceivedOfType("delta");
		expect(client2Deltas).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	it("SSE events for session B only reach session B viewers", async () => {
		const client1 = await harness.connectClient();
		const client2 = await harness.connectClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Client1 views session A, Client2 views session B
		client1.send({ type: "view_session", sessionId: "sess-A" });
		client2.send({ type: "view_session", sessionId: "sess-B" });

		await client1.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		await client2.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});

		client1.clearReceived();
		client2.clearReceived();

		// Inject SSE delta event for session B
		harness.mock.injectSSE({
			type: "message.part.delta",
			properties: {
				sessionID: "sess-B",
				partID: "part-2",
				messageID: "msg-2",
				field: "text",
				delta: "hello from session B",
			},
		});

		// Client2 (viewing sess-B) should receive the delta
		const delta = await client2.waitFor("delta", { timeout: 3000 });
		expect(delta["text"]).toBe("hello from session B");

		// Client1 (viewing sess-A) should NOT receive it
		await new Promise((r) => setTimeout(r, 100));
		const client1Deltas = client1.getReceivedOfType("delta");
		expect(client1Deltas).toHaveLength(0);

		await client1.close();
		await client2.close();
	});

	it("both clients viewing same session both receive SSE events", async () => {
		const client1 = await harness.connectClient();
		const client2 = await harness.connectClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Both view session A
		client1.send({ type: "view_session", sessionId: "sess-A" });
		client2.send({ type: "view_session", sessionId: "sess-A" });

		await client1.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		await client2.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});

		client1.clearReceived();
		client2.clearReceived();

		// Inject SSE delta event for session A
		harness.mock.injectSSE({
			type: "message.part.delta",
			properties: {
				sessionID: "sess-A",
				partID: "part-3",
				messageID: "msg-3",
				field: "text",
				delta: "shared update",
			},
		});

		// Both clients should receive it
		const delta1 = await client1.waitFor("delta", { timeout: 3000 });
		const delta2 = await client2.waitFor("delta", { timeout: 3000 });
		expect(delta1["text"]).toBe("shared update");
		expect(delta2["text"]).toBe("shared update");

		await client1.close();
		await client2.close();
	});

	it("client that view_session's then reconnects gets correct session on init", async () => {
		// Bug: When client reconnects, handleClientConnected sends session_switched
		// with the GLOBAL activeSessionId, overriding the client's intended session.
		// After reconnect, if the client sends view_session, it should end up on
		// the correct session without an intermediate session_switched for the wrong one.

		const client1 = await harness.connectClient();
		await client1.waitForInitialState();

		// Client1 views session B (not the default session A)
		client1.send({ type: "view_session", sessionId: "sess-B" });
		await client1.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});
		client1.clearReceived();

		// Disconnect and reconnect (simulates HMR or network blip)
		await client1.close();

		const client2 = await harness.connectClient();

		// Wait for initial state to settle first
		await client2.waitForInitialState();

		// On reconnect, client sends view_session (as ws.svelte.ts does)
		client2.send({ type: "view_session", sessionId: "sess-B" });

		// Wait specifically for the view_session response
		const switched = await client2.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});

		expect(switched["id"]).toBe("sess-B");

		await client2.close();
	});

	it("client connecting with ?session= gets that session as first session_switched (no flash)", async () => {
		// Bug: When a new tab opens /p/slug/s/sess-B, the server sends
		// session_switched for the GLOBAL active session first (e.g., sess-A),
		// causing a flash of wrong content before the correct session arrives.
		//
		// Fix: Pass desired session via ?session= query param on WS URL.
		// The server should use it instead of the global active session.

		// First, ensure the global active session is sess-A (the default)
		const setupClient = await harness.connectClient();
		await setupClient.waitForInitialState();
		setupClient.send({ type: "view_session", sessionId: "sess-A" });
		await setupClient.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		await setupClient.close();

		// Now connect a NEW client requesting sess-B via query param
		const client = await harness.connectClient({ session: "sess-B" });
		await client.waitForInitialState();

		// The FIRST session_switched should be for sess-B, NOT sess-A
		const allSwitched = client.getReceivedOfType("session_switched");
		expect(allSwitched.length).toBeGreaterThan(0);

		// Check that the FIRST session_switched is sess-B (no flash of sess-A)
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
		expect(allSwitched[0]!["id"]).toBe("sess-B");

		// There should be exactly ONE session_switched — no duplicate
		expect(allSwitched).toHaveLength(1);

		await client.close();
	});

	it("SSE events are cached even when no client views that session", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		// Client views session A — nobody views session B
		client.send({ type: "view_session", sessionId: "sess-A" });
		await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		client.clearReceived();

		// Inject SSE delta for session B (no viewer)
		harness.mock.injectSSE({
			type: "message.part.delta",
			properties: {
				sessionID: "sess-B",
				partID: "part-cached",
				messageID: "msg-cached",
				field: "text",
				delta: "cached event",
			},
		});

		// Client shouldn't receive it (wrong session)
		await new Promise((r) => setTimeout(r, 100));
		expect(client.getReceivedOfType("delta")).toHaveLength(0);

		// Now switch to session B — should get cached history
		client.clearReceived();
		client.send({ type: "view_session", sessionId: "sess-B" });

		const switched = await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});

		// The cached event should be in the events array
		const events = switched["events"] as
			| Array<{ type: string; text?: string }>
			| undefined;
		expect(events).toBeDefined();
		expect(
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			events!.some((e) => e.type === "delta" && e.text === "cached event"),
		).toBe(true);

		await client.close();
	});
});
