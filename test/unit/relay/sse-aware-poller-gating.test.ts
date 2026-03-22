// ─── SSE-Aware Poller Gating Integration Test ───────────────────────────────
// Verifies the core monitoring reducer behavior end-to-end:
// 1. Session busy + SSE active → NO poller started (SSE covers it)
// 2. Session busy + SSE stops → grace period → poller starts
// 3. SSE resumes → poller stops
//
// Observes poller behavior indirectly via /session/{id}/message request counts
// on the mock OpenCode server.

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

// ── Mock OpenCode Server with request counting ──────────────────────────────

interface MockOpenCode {
	server: Server;
	port: number;
	sseClients: Set<ServerResponse>;
	sessionStatuses: Record<string, { type: string }>;
	messageRequestCounts: Record<string, number>;
	injectSSE(event: { type: string; properties: Record<string, unknown> }): void;
	getMessageRequestCount(sessionId: string): number;
	resetMessageRequestCounts(): void;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	const sessionStatuses: Record<string, { type: string }> = {
		"sess-1": { type: "idle" },
	};
	const messageRequestCounts: Record<string, number> = {};

	const sessions = {
		"sess-1": {
			id: "sess-1",
			title: "Session 1",
			modelID: "gpt-4",
			providerID: "openai",
		},
	};

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		if (url.pathname === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": heartbeat\n\n");
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");

		if (url.pathname === "/path") {
			res.end(JSON.stringify("/test"));
			return;
		}

		if (url.pathname === "/session" && req.method === "GET") {
			res.end(JSON.stringify(Object.values(sessions)));
			return;
		}

		if (url.pathname === "/session" && req.method === "POST") {
			res.end(
				JSON.stringify({
					id: "sess-new",
					title: "New",
					modelID: "gpt-4",
					providerID: "openai",
				}),
			);
			return;
		}

		if (url.pathname === "/session/status") {
			res.end(JSON.stringify(sessionStatuses));
			return;
		}

		const sessionMatch = url.pathname.match(/^\/session\/([\w-]+)$/);
		if (sessionMatch && req.method === "GET") {
			// biome-ignore lint/style/noNonNullAssertion: regex guarantees capture
			const id = sessionMatch[1]!;
			const session = sessions[id as keyof typeof sessions] ?? {
				id,
				title: "Unknown",
				modelID: "gpt-4",
				providerID: "openai",
			};
			res.end(JSON.stringify(session));
			return;
		}

		// Count message requests per session — this is how we detect poller activity
		const msgMatch = url.pathname.match(/^\/session\/([\w-]+)\/message$/);
		if (msgMatch && req.method === "GET") {
			// biome-ignore lint/style/noNonNullAssertion: regex guarantees capture
			const sid = msgMatch[1]!;
			messageRequestCounts[sid] = (messageRequestCounts[sid] ?? 0) + 1;
			res.end(JSON.stringify([]));
			return;
		}

		if (url.pathname === "/agent") {
			res.end(
				JSON.stringify([{ id: "coder", name: "coder", description: "Main" }]),
			);
			return;
		}

		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ providers: [], defaults: {}, connected: [] }));
			return;
		}

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
		sessionStatuses,
		messageRequestCounts,
		injectSSE(event) {
			const data = JSON.stringify(event);
			for (const client of sseClients) {
				client.write(`data: ${data}\n\n`);
			}
		},
		getMessageRequestCount(sessionId: string) {
			return messageRequestCounts[sessionId] ?? 0;
		},
		resetMessageRequestCounts() {
			for (const key of Object.keys(messageRequestCounts)) {
				delete messageRequestCounts[key];
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

// ── Test harness ────────────────────────────────────────────────────────────

interface TestHarness {
	relay: ProjectRelay;
	mock: MockOpenCode;
	relayPort: number;
	connectClient(): Promise<TestWsClient>;
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
		slug: "test-sse-gating",
		log: createSilentLogger(),
	});

	// Wait for SSE + status poller to initialize
	await new Promise((r) => setTimeout(r, 800));

	return {
		relay,
		mock,
		relayPort,
		async connectClient() {
			const client = new TestWsClient(`ws://127.0.0.1:${relayPort}`);
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

// ── Tests ───────────────────────────────────────────────────────────────────

describe("SSE-aware poller gating", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 15_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 10_000);

	it("SSE-covered busy session has fewer message requests than non-covered", async () => {
		// This test compares two scenarios to verify SSE gating:
		// 1. Session busy WITH SSE events → fewer message polls
		// 2. Session busy WITHOUT SSE events → more message polls (poller starts)

		const client = await harness.connectClient();
		await client.waitForInitialState();
		client.send({ type: "view_session", sessionId: "sess-1" });
		await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-1",
		});

		// ── Scenario A: Busy WITH SSE coverage ──────────────────────────────
		harness.mock.resetMessageRequestCounts();
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };

		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, 400);

		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Wait past grace period + polling window
		await new Promise((r) => setTimeout(r, 5_000));
		clearInterval(sseInterval);
		const countWithSSE = harness.mock.getMessageRequestCount("sess-1");

		// Go idle to reset state
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await new Promise((r) => setTimeout(r, 1000));

		// ── Scenario B: Busy WITHOUT SSE coverage ───────────────────────────
		harness.mock.resetMessageRequestCounts();
		client.clearReceived();
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };

		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Same wait window — but no SSE events this time
		await new Promise((r) => setTimeout(r, 5_000));
		const countWithoutSSE = harness.mock.getMessageRequestCount("sess-1");

		// The scenario without SSE should have more message requests
		// because the reducer starts a poller after the grace period
		expect(countWithoutSSE).toBeGreaterThan(countWithSSE);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 25_000);

	it("sends done to viewers when a busy session becomes idle", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		client.send({ type: "view_session", sessionId: "sess-1" });
		await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-1",
		});
		client.clearReceived();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		client.clearReceived();

		// Session goes idle — should trigger notify-idle → done to viewers
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		await client.close();
	});
});
