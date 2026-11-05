// Per-tab session routing (mock OpenCode)
// Spins up a mock OpenCode HTTP+SSE server as an in-process daemon's default
// instance, then connects RPC clients to verify SSE events reach
// session-detail subscribers.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import Database from "better-sqlite3";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { __setProbeOverrideForTesting } from "../../../src/lib/provider/claude/claude-capabilities-probe.js";
import { createDaemonProject } from "../../helpers/in-process-daemon.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

// Minimal HTTP server impersonating OpenCode's REST + SSE endpoints.
// Sessions are stored in-memory; SSE events are injected via helper function.

interface MockOpenCode {
	server: Server;
	port: number;
	sseClients: Set<ServerResponse>;
	sessions: Record<
		string,
		{
			id: string;
			projectID: string;
			directory: string;
			title: string;
			version: string;
			time: { created: number; updated: number };
			modelID: string;
			providerID: string;
		}
	>;
	/** Inject an SSE event as if OpenCode sent it */
	injectSSE(event: { type: string; properties: Record<string, unknown> }): void;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	let eventId = 0;
	const sessions: MockOpenCode["sessions"] = {
		"sess-A": {
			id: "sess-A",
			projectID: "project-1",
			directory: "/test",
			title: "Session A",
			version: "1.0.0",
			time: { created: 1, updated: 1 },
			modelID: "gpt-4",
			providerID: "openai",
		},
		"sess-B": {
			id: "sess-B",
			projectID: "project-1",
			directory: "/test",
			title: "Session B",
			version: "1.0.0",
			time: { created: 2, updated: 2 },
			modelID: "gpt-4",
			providerID: "openai",
		},
	};
	let nextSessionNum = 1;

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		// SSE event stream — keep connection open
		if (url.pathname === "/global/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			// Send initial heartbeat so SSE consumer registers as connected
			res.write(
				`data: ${JSON.stringify({ payload: { id: "evt_connected", type: "server.connected", properties: {} } })}\n\n`,
			);
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");

		if (url.pathname === "/global/health" && req.method === "GET") {
			res.end(JSON.stringify({ healthy: true, version: "1.0.0" }));
			return;
		}

		// Project paths
		if (url.pathname === "/path") {
			res.end(
				JSON.stringify({
					state: "/test/state",
					config: "/test/config",
					worktree: "/test",
					directory: "/test",
				}),
			);
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
				projectID: "project-1",
				directory: "/test",
				title: "New Session",
				version: "1.0.0",
				time: { created: nextSessionNum, updated: nextSessionNum },
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
			const id = sessionMatch[1];
			assert.exists(id, "expected session ID capture");
			const session = sessions[id] ?? {
				id,
				projectID: "project-1",
				directory: "/test",
				title: "Unknown",
				version: "1.0.0",
				time: { created: 1, updated: 1 },
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
				JSON.stringify([
					{
						name: "coder",
						description: "Main",
						mode: "primary",
						builtIn: true,
						permission: { edit: "ask", bash: {} },
						tools: {},
						options: {},
					},
				]),
			);
			return;
		}

		// Providers
		if (url.pathname === "/provider") {
			res.end(
				JSON.stringify({
					all: [
						{
							id: "openai",
							name: "OpenAI",
							models: {
								"gpt-4": {
									id: "gpt-4",
									name: "GPT-4",
									limit: { context: 128000, output: 4096 },
								},
							},
						},
					],
					default: { openai: "gpt-4" },
					connected: ["openai"],
				}),
			);
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
			const data = JSON.stringify({
				directory: process.cwd(),
				payload: { id: `evt_${++eventId}`, ...event },
			});
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

interface TestHarness {
	mock: MockOpenCode;
	connectClient(opts?: { session?: string }): Promise<TestWsClient>;
	stop(): Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
	const mock = await createMockOpenCode();
	// The mock OpenCode is the daemon's default instance; the default model
	// selects it instead of Claude.
	const daemon = await createDaemonProject("chat-simple", {
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		defaultModel: "openai/gpt-4",
		slug: "test-project",
	}).catch(async (error: unknown) => {
		await mock.close();
		throw error;
	});
	await vi.waitFor(() => expect(mock.sseClients.size).toBeGreaterThan(0));
	for (const session of Object.values(mock.sessions))
		mock.injectSSE({ type: "session.created", properties: { info: session } });
	const db = new Database(daemon.eventsDbPath, { readonly: true });
	try {
		await vi.waitFor(
			() => {
				for (const session of Object.values(mock.sessions))
					expect(
						db
							.prepare<[string], { model_id: string; model_provider: string }>(
								"SELECT model_id, model_provider FROM sessions WHERE id = ?",
							)
							.get(session.id),
					).toEqual({ model_id: "gpt-4", model_provider: "openai" });
			},
			{ timeout: 5_000 },
		);
	} finally {
		db.close();
	}

	const clients: TestWsClient[] = [];
	return {
		mock,
		async connectClient(opts?: { session?: string }) {
			let url = `ws://127.0.0.1:${daemon.port}/rpc?p=${daemon.slug}`;
			if (opts?.session) {
				url += `&session=${encodeURIComponent(opts.session)}`;
			}
			const client = new TestWsClient(url);
			clients.push(client);
			await client.waitForOpen();
			return client;
		},
		async stop() {
			for (const client of clients) await client.close().catch(() => {});
			try {
				await daemon.stop();
			} finally {
				await mock.close();
			}
		},
	};
}

describe("Per-tab session routing with mock OpenCode", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		// Keep capability discovery off the live Claude SDK.
		__setProbeOverrideForTesting(async () => ({
			models: [],
			commands: [],
			agents: [],
		}));
		harness = await createTestHarness();
	}, 15_000);

	afterAll(async () => {
		try {
			if (harness) await harness.stop();
		} finally {
			__setProbeOverrideForTesting(undefined);
		}
	}, 10_000);

	it("client receives initial state on connect", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		expect(client.getReceivedOfType("family")).toContainEqual(
			expect.objectContaining({ _tag: "snapshot" }),
		);

		await client.close();
	});

	it("SSE chat events reach every session subscriber, whatever it views", async () => {
		const client1 = await harness.connectClient();
		const client2 = await harness.connectClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();

		// Viewing does not gate delivery: a subscriber to session A's detail
		// receives its transcript while viewing session B.
		await client1.viewSession("sess-A");
		await client2.viewSession("sess-B");
		await client1.subscribeSessionDetail("sess-A");
		await client2.subscribeSessionDetail("sess-A");

		harness.mock.injectSSE({
			type: "message.updated",
			properties: {
				sessionID: "sess-A",
				info: { id: "msg-1", sessionID: "sess-A", role: "assistant" },
			},
		});
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

		const hasText: Parameters<TestWsClient["waitForTranscriptMessage"]>[0] = (
			message,
		) =>
			(message.parts ?? []).some(
				(part) => part.text === "hello from session A",
			);
		await client1.waitForTranscriptMessage(hasText, "sess-A", 3000);
		await client2.waitForTranscriptMessage(hasText, "sess-A", 3000);

		await client1.close();
		await client2.close();
	});

	it("client that views a session then reconnects gets correct session on init", async () => {
		const client1 = await harness.connectClient();
		await client1.waitForInitialState();

		// Client1 views session B (not the default session A)
		await client1.viewSession("sess-B");
		client1.clearReceived();

		// Disconnect and reconnect (simulates HMR or network blip)
		await client1.close();

		const client2 = await harness.connectClient();

		// Wait for initial state to settle first
		await client2.waitForInitialState();

		// On reconnect, the frontend sends ViewSession RPC.
		await client2.viewSession("sess-B");
		await client2.subscribeFamily("sess-B");
		expect(client2.getActiveSessionId()).toBe("sess-B");
		expect(client2.getReceivedOfType("family")).toContainEqual(
			expect.objectContaining({ familyOf: "sess-B", _tag: "snapshot" }),
		);

		await client2.close();
	});

	it("client requesting a session gets that family snapshot first", async () => {
		// First, ensure the global active session is sess-A (the default)
		const setupClient = await harness.connectClient();
		await setupClient.waitForInitialState();
		await setupClient.viewSession("sess-A");
		await setupClient.close();

		// The RPC client follows sess-B before selecting its initial session.
		const client = await harness.connectClient({ session: "sess-B" });
		await client.waitForInitialState();

		const families = client.getReceivedOfType("family");
		expect(families).toContainEqual(
			expect.objectContaining({ familyOf: "sess-B", _tag: "snapshot" }),
		);
		expect(families).not.toContainEqual(
			expect.objectContaining({ familyOf: "sess-A" }),
		);

		await client.close();
	});

	// "SSE events are cached even when no client views that session" removed in Task 50.5.
	// messageCache stripped from all deps; unviewed SSE events are no longer buffered
	// in-memory. History is served via REST/SQLite when clients switch sessions.
});
