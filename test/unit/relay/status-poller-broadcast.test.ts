// ─── Status Poller → Browser Processing Status ──────────────────────────────
// Verifies that when the status poller detects a session transition (idle→busy
// or busy→idle), the relay sends `{ type: "status", status: "processing" }`
// and `{ type: "done" }` to browser clients viewing that session.
//
// This was the root cause of the bouncing-bar not appearing: the status
// poller broadcast a `session_list` (which updates the sidebar spinner) but
// never sent a `status` message to update `isProcessing`.

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname } from "node:path";
import { Effect, Ref } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { PollerStateTag } from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { EventStoreEffectTag } from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";
import { tempEventsDbPath } from "../../helpers/temp-events-db.js";
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
	> = {
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

		if (url.pathname === "/session" && req.method === "GET") {
			res.end(JSON.stringify(Object.values(sessions)));
			return;
		}

		if (url.pathname === "/session" && req.method === "POST") {
			res.end(
				JSON.stringify({
					id: "sess-new",
					projectID: "project-1",
					directory: "/test",
					title: "New",
					version: "1.0.0",
					time: { created: 3, updated: 3 },
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

		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ all: [], default: {}, connected: [] }));
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
	refreshSessionGit: ReturnType<typeof vi.fn<() => Promise<void>>>;
	relayPort: number;
	connectClient(opts?: { session?: string }): Promise<TestWsClient>;
	stop(): Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
	const mock = await createMockOpenCode();
	const refreshSessionGit = vi.fn(async () => undefined);

	const relayServer = createServer();
	await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
	const relayPort = (relayServer.address() as { port: number }).port;
	const dbPath = tempEventsDbPath();
	await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			for (const sessionId of ["sess-A", "sess-B"]) {
				yield* store.append(
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title: sessionId,
							provider: "opencode",
						},
						{ provider: "opencode" },
					),
				);
			}
		}).pipe(Effect.provide(makePersistenceEffectLayer(dbPath))),
	);

	const relay = await createProjectRelay({
		persistenceDbPath: dbPath,
		httpServer: relayServer,
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		projectDir: process.cwd(),
		slug: "test-status-poller",
		noServer: true,
		log: createSilentLogger(),
		statusPollerInterval: 100,
		messagePollerInterval: 150,
		pollerGatingConfig: {
			sseGracePeriodMs: 300,
			sseActiveThresholdMs: 500,
		},
		refreshSessionGit,
	});

	const browserSockets = new WebSocketServer({ noServer: true });
	relayServer.on("upgrade", (req, socket, head) => {
		if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
			browserSockets.handleUpgrade(req, socket, head, (ws) => {
				const params = new URL(req.url ?? "/ws", "http://localhost")
					.searchParams;
				const clientId = params.get("client");
				const requestedSessionId = params.get("session");
				ws.send(
					JSON.stringify({
						type: "project_attached",
						slug: "test-status-poller",
					}),
				);
				relay.wsHandler.attach(ws, {
					clientId:
						clientId && /^[A-Za-z0-9._:-]{1,128}$/.test(clientId)
							? clientId
							: randomBytes(8).toString("hex"),
					...(requestedSessionId != null ? { requestedSessionId } : {}),
				});
			});
			return;
		}
		if (req.url === "/rpc" || req.url?.startsWith("/rpc?")) {
			relay.rpcWsHandler.handleUpgrade(req, socket, head);
			return;
		}
		socket.destroy();
	});

	await vi.waitFor(() => expect(mock.sseClients.size).toBeGreaterThan(0));

	return {
		relay,
		mock,
		refreshSessionGit,
		relayPort,
		async connectClient(opts?: { session?: string }) {
			let url = `ws://127.0.0.1:${relayPort}/ws`;
			if (opts?.session) {
				url += `?session=${encodeURIComponent(opts.session)}`;
			}
			const client = new TestWsClient(url);
			await client.waitForOpen();
			return client;
		},
		async stop() {
			try {
				await relay.stop();
			} finally {
				for (const ws of browserSockets.clients) ws.terminate();
				await new Promise<void>((resolve) =>
					browserSockets.close(() => resolve()),
				);
			}
			await new Promise<void>((r) => relayServer.close(() => r()));
			await mock.close();
			rmSync(dirname(dbPath), { recursive: true, force: true });
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Status poller → browser processing/done transitions", () => {
	let harness: TestHarness;
	const publishStatus = (sessionId: string, status: "busy" | "idle") => {
		harness.mock.sessionStatuses[sessionId] = { type: status };
		harness.mock.injectSSE({
			type: "session.status",
			properties: { sessionID: sessionId, status: { type: status } },
		});
	};

	beforeAll(async () => {
		harness = await createTestHarness();
		publishStatus("sess-A", "idle");
		publishStatus("sess-B", "idle");
		await vi.waitFor(
			async () => {
				const statuses = await harness.relay.effectRuntime.runtime.runPromise(
					Effect.gen(function* () {
						const state = yield* Ref.get(yield* PollerStateTag);
						return state.previousStatuses;
					}),
				);
				expect(statuses["sess-A"]?.type).toBe("idle");
				expect(statuses["sess-B"]?.type).toBe("idle");
			},
			{ timeout: 3000 },
		);
	}, 15_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 10_000);

	it("refreshes git on the status poll cadence", async () => {
		await vi.waitFor(
			() => expect(harness.refreshSessionGit).toHaveBeenCalled(),
			{ timeout: 3000 },
		);
		const previousCalls = harness.refreshSessionGit.mock.calls.length;
		await vi.waitFor(
			() =>
				expect(harness.refreshSessionGit.mock.calls.length).toBeGreaterThan(
					previousCalls,
				),
			{ timeout: 3000 },
		);
	});

	it("sends status:processing to clients viewing a session that becomes busy", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		// View session A
		await client.viewSession("sess-A");
		client.clearReceived();

		// Persist session A's status through the provider event stream.
		publishStatus("sess-A", "busy");

		// Wait for status poller to detect the change (polls every 500ms)
		const status = await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		expect(status["status"]).toBe("processing");

		// Reset for cleanup
		publishStatus("sess-A", "idle");
		// Wait for idle transition to settle
		await client.waitFor("done", { timeout: 3000 });

		await client.close();
	});

	it("sends done to clients viewing a session that becomes idle", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();

		await client.viewSession("sess-B");
		client.clearReceived();

		// First make session B busy
		publishStatus("sess-B", "busy");
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		client.clearReceived();

		// Now make session B idle again
		publishStatus("sess-B", "idle");

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
		await clientA.viewSession("sess-A");
		await clientB.viewSession("sess-B");
		clientA.clearReceived();
		clientB.clearReceived();

		// Only session A becomes busy
		publishStatus("sess-A", "busy");

		// Client A should get status:processing
		await clientA.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Client B must receive no processing status during this window.
		await new Promise((r) => setTimeout(r, 150));
		const bStatuses = clientB
			.getReceivedOfType("status")
			.filter((m) => m["status"] === "processing");
		expect(bStatuses).toHaveLength(0);

		// Cleanup
		publishStatus("sess-A", "idle");
		await clientA.waitFor("done", { timeout: 3000 });

		await clientA.close();
		await clientB.close();
	});

	it("shares status-poller state with the relay Effect runtime", async () => {
		publishStatus("sess-A", "busy");

		await vi.waitFor(
			() => expect(harness.relay.isAnySessionProcessing()).toBe(true),
			{ timeout: 3000 },
		);

		const relayRuntimeStatus =
			await harness.relay.effectRuntime.runtime.runPromise(
				Effect.gen(function* () {
					const ref = yield* PollerStateTag;
					const state = yield* Ref.get(ref);
					return state.previousStatuses["sess-A"]?.type;
				}),
			);
		expect(relayRuntimeStatus).toBe("busy");

		publishStatus("sess-A", "idle");
		await vi.waitFor(
			() => expect(harness.relay.isAnySessionProcessing()).toBe(false),
			{ timeout: 3000 },
		);
	});
});
