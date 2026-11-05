// Verifies that status-poller transitions reach RPC subscribers through the
// session's shell row.

import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { Effect } from "effect";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import {
	type CanonicalEvent,
	canonicalEvent,
} from "../../../src/lib/persistence/events.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
import { activeRunEvents } from "../../helpers/ledger-tasks.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

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
	let eventId = 0;
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

		if (url.pathname === "/global/event") {
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
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
	project: DaemonProject;
	mock: MockOpenCode;
	connectClient(): Promise<TestWsClient>;
	stop(): Promise<void>;
}

async function createTestHarness(): Promise<TestHarness> {
	const mock = await createMockOpenCode();
	// The mock OpenCode is the daemon's default instance; the harness opens its
	// event stream at start.
	const project = await createDaemonProject("chat-simple", {
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		slug: "test-status-poller",
	}).catch(async (error: unknown) => {
		await mock.close();
		throw error;
	});
	await project.run(
		Effect.flatMap(makeCommitAndSignal, (commit) =>
			commit(
				["sess-A", "sess-B"].map((sessionId) =>
					canonicalEvent(
						"session.created",
						sessionId,
						{ sessionId, title: sessionId, provider: "opencode" },
						{ provider: "opencode" },
					),
				),
			),
		),
	);
	await vi.waitFor(() => expect(mock.sseClients.size).toBeGreaterThan(0));

	return {
		project,
		mock,
		connectClient: () => project.connectWsClient(),
		async stop() {
			try {
				await project.stop();
			} finally {
				await mock.close();
			}
		},
	};
}

describe("Status poller → browser shell transitions", () => {
	let harness: TestHarness;
	beforeAll(async () => {
		harness = await createTestHarness();
	}, 15_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 10_000);

	it("publishes an idle shell row when a viewed session's Run ends", async () => {
		const client = await harness.connectClient();
		await client.waitForInitialState();
		await client.viewSession("sess-B");
		await client.subscribeShell();
		const commit = (events: readonly CanonicalEvent[]) =>
			harness.project.run(
				Effect.gen(function* () {
					yield* (yield* makeCommitAndSignal)(events);
				}),
			);
		const shellRow = (status: string) => (msg: Record<string, unknown>) =>
			msg["_tag"] === "upsert" &&
			(msg["item"] as { id?: string }).id === "sess-B" &&
			(msg["item"] as { status?: string }).status === status;

		// 8.1 (CONTRACT.md 2734): the row is busy while the ledger holds the session's Run (82tn.32.30).
		const beforeRun = client.getReceived().length;
		await commit(activeRunEvents("sess-B"));
		await client.waitForAny(["shell"], {
			timeout: 3000,
			cursor: beforeRun,
			predicate: shellRow("busy"),
		});

		const afterBusy = client.getReceived().length;
		const meta = { provider: "opencode", metadata: { runId: "ledger-u1-run" } };
		// 3.9 D59: OpenCode's idle status under the Run's id is its terminal.
		await commit([
			canonicalEvent(
				"run.started",
				"sess-B",
				{ inputId: "ledger-u1", requestedRunId: "ledger-u1-run" },
				meta,
			),
			canonicalEvent(
				"session.status",
				"sess-B",
				{ sessionId: "sess-B", status: "idle" },
				meta,
			),
		]);
		await client.waitForAny(["shell"], {
			timeout: 3000,
			cursor: afterBusy,
			predicate: shellRow("idle"),
		});

		await client.close();
	});
});
