// ─── Permission Rehydration Wiring ───────────────────────────────────────────
// Verifies that createProjectRelay wires listPendingPermissions into the SSE
// consumer, so pending permissions are rehydrated from the OpenCode API on
// SSE connect. Uses a mock OpenCode server — no real OpenCode required.
//
// This is the integration-level companion to the unit tests in sse-wiring.test.ts
// that prove wireSSEConsumer handles listPendingPermissions correctly. This test
// proves relay-stack.ts actually passes the function through.

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
			res.end(
				JSON.stringify([
					{
						id: "sess-1",
						title: "Session 1",
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
					title: "Session 1",
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
				JSON.stringify([{ id: "coder", name: "coder", description: "Main" }]),
			);
			return;
		}

		// Providers
		if (url.pathname === "/provider") {
			res.end(JSON.stringify({ providers: [], defaults: {}, connected: [] }));
			return;
		}

		// Pending questions — empty
		if (url.pathname === "/question" && req.method === "GET") {
			res.end(JSON.stringify([]));
			return;
		}

		// ── THE KEY ENDPOINT ────────────────────────────────────────────────
		// Pending permissions — returns one permission to rehydrate
		if (url.pathname === "/permission" && req.method === "GET") {
			res.end(
				JSON.stringify([
					{
						id: "perm-rehydrate-1",
						permission: "Bash",
						sessionID: "sess-1",
						metadata: { command: "rm -rf /" },
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Permission rehydration wiring in createProjectRelay", () => {
	let mock: MockOpenCode;
	let relay: ProjectRelay;
	let relayServer: Server;
	let relayPort: number;

	beforeAll(async () => {
		mock = await createMockOpenCode();

		relayServer = createServer();
		await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
		relayPort = (relayServer.address() as { port: number }).port;

		relay = await createProjectRelay({
			httpServer: relayServer,
			opencodeUrl: `http://127.0.0.1:${mock.port}`,
			projectDir: process.cwd(),
			slug: "test-perm-rehydrate",
			log: createSilentLogger(),
		});

		// Wait for SSE to connect and rehydration to complete
		await new Promise((r) => setTimeout(r, 1000));
	}, 15_000);

	afterAll(async () => {
		if (relay) await relay.stop();
		if (relayServer)
			await new Promise<void>((r) => relayServer.close(() => r()));
		if (mock) await mock.close();
	}, 10_000);

	it("rehydrates pending permissions from OpenCode API into the bridge on SSE connect", () => {
		// The permission bridge should have the rehydrated permission
		const pending = relay.permissionBridge.getPending();
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
		await client.waitForInitialState();

		// The client-init path replays pending permissions from the bridge.
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
});
