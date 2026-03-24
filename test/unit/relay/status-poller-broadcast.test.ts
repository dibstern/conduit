// ─── Status Poller → Browser Processing Status ──────────────────────────────
// Verifies that when the status poller detects a session transition (idle→busy
// or busy→idle), the relay sends `{ type: "status", status: "processing" }`
// and `{ type: "done" }` to browser clients viewing that session.
//
// This was the root cause of the bouncing-bar not appearing: the status
// poller broadcast a `session_list` (which updates the sidebar spinner) but
// never sent a `status` message to update `isProcessing`.

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

// ── Mock OpenCode Server with controllable session status ────────────────────

interface MockOpenCode {
	server: Server;
	port: number;
	sseClients: Set<ServerResponse>;
	/** Mutable status map — tests mutate this to simulate busy/idle transitions */
	sessionStatuses: Record<string, { type: string }>;
	injectSSE(event: { type: string; properties: Record<string, unknown> }): void;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	// All sessions start idle
	const sessionStatuses: Record<string, { type: string }> = {
		"sess-A": { type: "idle" },
		"sess-B": { type: "idle" },
	};

	const sessions: Record<
		string,
		{ id: string; title: string; modelID: string; providerID: string }
	> = {
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

		// Session status — returns the mutable sessionStatuses map
		if (url.pathname === "/session/status") {
			res.end(JSON.stringify(sessionStatuses));
			return;
		}

		// Get specific session
		const sessionMatch = url.pathname.match(/^\/session\/([\w-]+)$/);
		if (sessionMatch && req.method === "GET") {
			// biome-ignore lint/style/noNonNullAssertion: safe — regex guarantees capture group
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

// ── Harness ──────────────────────────────────────────────────────────────────

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
		slug: "test-status-poller",
		log: createSilentLogger(),
		statusPollerInterval: 100,
		messagePollerInterval: 150,
		pollerGatingConfig: {
			sseGracePeriodMs: 300,
			sseActiveThresholdMs: 500,
		},
	});

	// Wait for SSE + status poller to initialize
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

describe("Status poller → browser processing/done transitions", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 15_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 10_000);

	it("sends status:processing to clients viewing a session that becomes busy", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		// View session A
		client.send({ type: "view_session", sessionId: "sess-A" });
		await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		client.clearReceived();

		// Simulate session A becoming busy (e.g., TUI started processing)
		harness.mock.sessionStatuses["sess-A"] = { type: "busy" };

		// Wait for status poller to detect the change (polls every 500ms)
		const status = await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		expect(status["status"]).toBe("processing");

		// Reset for cleanup
		harness.mock.sessionStatuses["sess-A"] = { type: "idle" };
		// Wait for idle transition to settle
		await client.waitFor("done", { timeout: 3000 });

		await client.close();
	});

	it("sends done to clients viewing a session that becomes idle", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		client.send({ type: "view_session", sessionId: "sess-B" });
		await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});
		client.clearReceived();

		// First make session B busy
		harness.mock.sessionStatuses["sess-B"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		client.clearReceived();

		// Now make session B idle again
		harness.mock.sessionStatuses["sess-B"] = { type: "idle" };

		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		await client.close();
	});

	it("does NOT send status:processing to clients viewing a different session", async () => {
		const clientA = await harness.connectClient();
		const clientB = await harness.connectClient();
		await clientA.waitForInitialState();
		await clientB.waitForInitialState();

		// Client A views session A, Client B views session B
		clientA.send({ type: "view_session", sessionId: "sess-A" });
		clientB.send({ type: "view_session", sessionId: "sess-B" });
		await clientA.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-A",
		});
		await clientB.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-B",
		});
		clientA.clearReceived();
		clientB.clearReceived();

		// Only session A becomes busy
		harness.mock.sessionStatuses["sess-A"] = { type: "busy" };

		// Client A should get status:processing
		await clientA.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Client B should NOT get status:processing — give it time to NOT arrive
		await new Promise((r) => setTimeout(r, 150));
		const bStatuses = clientB
			.getReceivedOfType("status")
			.filter((m) => m["status"] === "processing");
		expect(bStatuses).toHaveLength(0);

		// Cleanup
		harness.mock.sessionStatuses["sess-A"] = { type: "idle" };
		await clientA.waitFor("done", { timeout: 3000 });

		await clientA.close();
		await clientB.close();
	});
});
