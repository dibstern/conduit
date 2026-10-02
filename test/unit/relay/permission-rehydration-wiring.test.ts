// Verifies that createProjectRelay wires listPendingPermissions into the SSE
// consumer, so pending permissions are rehydrated from the OpenCode API on
// SSE connect. Uses a mock OpenCode server — no real OpenCode required.
//
// This is the integration-level companion to the unit tests in sse-wiring.test.ts
// that prove wireSSEConsumerEffect handles listPendingPermissions correctly. This test
// proves relay-stack.ts actually passes the function through.

import { mkdtempSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { viewSessionForClient } from "../../../src/lib/handlers/session.js";
import { createSilentLogger } from "../../../src/lib/logger.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import type { RelayRuntimeServices } from "../../../src/lib/relay/project-relay-layers.js";
import {
	createProjectRelay,
	type ProjectRelay,
} from "../../../src/lib/relay/relay-stack.js";
import { TestWsClient } from "../../integration/helpers/test-ws-client.js";

// Returns one pending permission from GET /permission.

interface MockOpenCode {
	server: Server;
	port: number;
	close(): Promise<void>;
}

async function createMockOpenCode(): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();

	function handler(req: IncomingMessage, res: ServerResponse) {
		const url = new URL(req.url ?? "/", "http://localhost");

		// SSE event stream
		if (url.pathname === "/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			res.write(": heartbeat\n\n");
			// Real OpenCode's first SSE frame is always server.connected; conduit
			// treats the first yielded event as its connect signal.
			res.write(
				`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
			);
			sseClients.add(res);
			req.on("close", () => sseClients.delete(res));
			return;
		}

		res.setHeader("Content-Type", "application/json");

		// Health check
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
			res.end(
				JSON.stringify([
					{
						id: "sess-1",
						projectID: "project-1",
						directory: "/test",
						title: "Session 1",
						version: "1.0.0",
						time: { created: 1, updated: 1 },
						modelID: "gpt-4",
						providerID: "openai",
					},
				]),
			);
			return;
		}

		// Session status
		if (url.pathname === "/session/status") {
			res.end(JSON.stringify({ "sess-1": { type: "idle" } }));
			return;
		}

		// Get specific session
		if (url.pathname.match(/^\/session\/[\w-]+$/) && req.method === "GET") {
			res.end(
				JSON.stringify({
					id: "sess-1",
					projectID: "project-1",
					directory: "/test",
					title: "Session 1",
					version: "1.0.0",
					time: { created: 1, updated: 1 },
					modelID: "gpt-4",
					providerID: "openai",
				}),
			);
			return;
		}

		// Get messages
		if (
			url.pathname.match(/^\/session\/[\w-]+\/message$/) &&
			req.method === "GET"
		) {
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
			res.end(JSON.stringify({ all: [], default: {}, connected: [] }));
			return;
		}

		// Pending questions — empty
		if (url.pathname === "/question" && req.method === "GET") {
			res.end(JSON.stringify([]));
			return;
		}

		// Pending permissions — returns one permission to rehydrate
		if (url.pathname === "/permission" && req.method === "GET") {
			res.end(
				JSON.stringify([
					{
						id: "perm-rehydrate-1",
						permission: "Bash",
						sessionID: "sess-1",
						patterns: ["rm -rf /"],
						metadata: { command: "rm -rf /" },
						always: [],
					},
				]),
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
		async close() {
			for (const client of sseClients) {
				client.end();
			}
			sseClients.clear();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}

describe("Permission rehydration wiring in createProjectRelay", () => {
	let mock: MockOpenCode;
	let relay: ProjectRelay;
	let relayServer: Server;
	let relayPort: number;
	let wss: WebSocketServer;
	let persistenceDir: string;

	beforeAll(async () => {
		mock = await createMockOpenCode();

		relayServer = createServer();
		await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
		relayPort = (relayServer.address() as { port: number }).port;
		persistenceDir = mkdtempSync(join(tmpdir(), "conduit-permission-"));

		relay = await createProjectRelay({
			httpServer: relayServer,
			opencodeUrl: `http://127.0.0.1:${mock.port}`,
			projectDir: process.cwd(),
			slug: "test-perm-rehydrate",
			persistenceDbPath: join(persistenceDir, "events.db"),
			log: createSilentLogger(),
		});

		// Relays never own upgrades; the caller attaches sockets, as the daemon does.
		wss = new WebSocketServer({ noServer: true });
		relayServer.on("upgrade", (req, socket, head) => {
			wss.handleUpgrade(req, socket, head, (ws) => {
				relay.wsHandler.attach(ws, { clientId: "perm-rehydrate-client" });
			});
		});

		await vi.waitFor(async () => {
			const pending = await relay.effectRuntime.runtime.runPromise(
				Effect.gen(function* () {
					const interactions = yield* PendingInteractionServiceTag;
					return yield* interactions.listPendingPermissions();
				}),
			);
			expect(pending).toHaveLength(1);
		});
	}, 15_000);

	afterAll(async () => {
		if (relay) await relay.stop();
		if (wss) await new Promise<void>((r) => wss.close(() => r()));
		if (relayServer)
			await new Promise<void>((r) => relayServer.close(() => r()));
		if (mock) await mock.close();
		rmSync(persistenceDir, { recursive: true, force: true });
	}, 10_000);

	it("rehydrates pending permissions from OpenCode API into the Effect service on SSE connect", async () => {
		const pending = await relay.effectRuntime.runtime.runPromise(
			Effect.gen(function* () {
				const pendingInteractions = yield* PendingInteractionServiceTag;
				return yield* pendingInteractions.listPendingPermissions();
			}),
		);
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			requestId: "perm-rehydrate-1",
			sessionId: "sess-1",
			toolName: "Bash",
		});
	});

	it("broadcasts rehydrated permission to connected WS clients", async () => {
		const url = `ws://127.0.0.1:${relayPort}`;
		const client = new TestWsClient(url);
		await client.waitForOpen();

		// The client-init path replays pending permissions from the shared service.
		// If rehydration worked, the client should receive a permission_request.
		const permMsg = await client.waitFor("permission_request", {
			timeout: 3000,
		});
		expect(permMsg).toMatchObject({
			type: "permission_request",
			requestId: "perm-rehydrate-1",
			toolName: "Bash",
			sessionId: "sess-1",
		});

		await client.close();
	});

	// A page reload is a fresh socket; the card it rebuilds must say what the
	// live prompt said, including why the provider asked under Full access.
	it("replays a provider prompt's title, description and reason after a reload", async () => {
		const pendingInteractions = await relay.effectRuntime.runtime.runPromise(
			PendingInteractionServiceTag,
		);
		const sink = createRelayEventSink({
			sessionId: "sess-1",
			send: () => {},
			pendingInteractions: {
				beginPermissionRequest: (entry) =>
					pendingInteractions.beginPermissionRequest(entry),
				resolvePermissionRequest: (requestId, response) =>
					pendingInteractions.resolvePermissionRequest(requestId, response),
				beginQuestionRequest: (entry) =>
					pendingInteractions.beginQuestionRequest(entry),
				resolveQuestionRequest: (requestId, answers) =>
					pendingInteractions.resolveQuestionRequest(requestId, answers),
			},
		});
		const prompt = {
			permissionTitle: "Claude wants to run rm",
			permissionDisplayName: "Bash",
			permissionDescription: "Clean up worktrees",
			permissionReason:
				"Dangerous rm operation on possibly-empty variable path",
		};
		const ask = Effect.runFork(
			sink.requestPermission({
				requestId: "perm-reload-1",
				sessionId: "sess-1",
				turnId: "turn-1",
				providerItemId: "tool-1",
				toolName: "Bash",
				toolInput: { command: "rm $R/$w/node_modules" },
				...prompt,
			}),
		);
		const replayed = (client: TestWsClient) =>
			client
				.getReceivedOfType("permission_request")
				.filter((msg) => msg["requestId"] === "perm-reload-1");

		const client = new TestWsClient(`ws://127.0.0.1:${relayPort}`);
		await client.waitForOpen();
		await vi.waitFor(() => expect(replayed(client)).toHaveLength(1));
		const onConnect = replayed(client)[0];
		client.clearReceived();
		// The ViewSession RPC body; this harness serves the socket, not /rpc.
		// The relay runtime provides the handler services; its public type
		// promises only a subset.
		await relay.effectRuntime.runtime.runPromise(
			viewSessionForClient({
				clientId: "perm-rehydrate-client",
				sessionId: "sess-1",
			}) as unknown as Effect.Effect<unknown, unknown, RelayRuntimeServices>,
		);
		await vi.waitFor(() => expect(replayed(client)).toHaveLength(1));

		expect(onConnect).toMatchObject(prompt);
		expect(replayed(client)[0]).toMatchObject(prompt);
		await client.close();
		await Effect.runPromise(
			pendingInteractions.resolvePermissionRequest("perm-reload-1", {
				decision: "reject",
			}),
		);
		await Effect.runPromise(Fiber.join(ask));
	});
});
