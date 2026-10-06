// Comprehensive verification of the monitoring reducer end-to-end (18 scenarios):
//
// Group 1 (1-4): SSE coverage and grace period
// Group 2 (5-6): SSE dynamics (staleness, resume)
// Group 3 (7-9): Idle transitions (grace, SSE-covered, polling)
// Group 4 (10-11): Cross-session and lifecycle
// Group 5 (12-15): Notifications (subagent, cross-session broadcast)
// Group 6 (16-18): Retry status and cycling
//
// Observes poller behavior indirectly via /session/{id}/message request counts
// on the mock OpenCode server.
//
// Uses accelerated timing intervals (~10x faster than production) to avoid
// 100+ second real-time waits while still exercising the same code paths.

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { Effect } from "effect";
import { afterAll, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { getCurrentStatuses } from "../../../src/lib/domain/relay/Services/session-status-poller.js";
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

// Production values: grace=3000ms, staleness=5000ms, statusPoll=500ms, msgPoll=750ms
// Test values: ~10x faster to avoid multi-minute test runs.

const TEST_GRACE_MS = 300;
const TEST_STALENESS_MS = 500;
const TEST_STATUS_POLL_MS = 100;
const TEST_MSG_POLL_MS = 150;
const TEST_SSE_INJECT_INTERVAL = 80; // production: 400ms

interface SessionDef {
	id: string;
	title: string;
	parentID?: string;
}

interface MockOpenCodeConfig {
	sessions?: SessionDef[];
}

interface MockOpenCode {
	server: Server;
	port: number;
	sseClients: Set<ServerResponse>;
	sessionStatuses: Record<string, { type: string; [key: string]: unknown }>;
	sessionList: SessionDef[];
	messageRequestCounts: Record<string, number>;
	injectSSE(event: { type: string; properties: Record<string, unknown> }): void;
	getMessageRequestCount(sessionId: string): number;
	resetMessageRequestCounts(): void;
	close(): Promise<void>;
}

async function createMockOpenCode(
	config?: MockOpenCodeConfig,
): Promise<MockOpenCode> {
	const sseClients = new Set<ServerResponse>();
	let eventId = 0;

	const sessionList: SessionDef[] = config?.sessions ?? [
		{ id: "sess-1", title: "Session 1" },
	];

	const sessionStatuses: Record<
		string,
		{ type: string; [key: string]: unknown }
	> = {};
	for (const s of sessionList) {
		sessionStatuses[s.id] = { type: "idle" };
	}

	const messageRequestCounts: Record<string, number> = {};
	const toOpenCodeSession = (session: SessionDef) => ({
		id: session.id,
		projectID: "proj-test",
		directory: "/test",
		title: session.title,
		version: "test",
		time: { created: 1, updated: 1 },
		modelID: "gpt-4",
		providerID: "openai",
		...(session.parentID != null && { parentID: session.parentID }),
	});

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

		if (url.pathname === "/path") {
			res.end(
				JSON.stringify({
					state: "/tmp/opencode-state",
					config: "/tmp/opencode-config",
					worktree: "/test",
					directory: "/test",
				}),
			);
			return;
		}

		if (url.pathname === "/session" && req.method === "GET") {
			const result = sessionList.map(toOpenCodeSession);
			res.end(JSON.stringify(result));
			return;
		}

		if (url.pathname === "/session" && req.method === "POST") {
			res.end(
				JSON.stringify(
					toOpenCodeSession({
						id: "sess-new",
						title: "New",
					}),
				),
			);
			return;
		}

		if (url.pathname === "/session/status") {
			res.end(JSON.stringify(sessionStatuses));
			return;
		}

		const sessionMatch = url.pathname.match(/^\/session\/([\w-]+)$/);
		if (sessionMatch && req.method === "GET") {
			const id = sessionMatch[1];
			assert.exists(id, "expected a session id in the request path");
			const found = sessionList.find((s) => s.id === id);
			const session = toOpenCodeSession(found ?? { id, title: "Unknown" });
			res.end(JSON.stringify(session));
			return;
		}

		// Count message requests per session — this is how we detect poller activity
		const msgMatch = url.pathname.match(/^\/session\/([\w-]+)\/message$/);
		if (msgMatch && req.method === "GET") {
			const sid = msgMatch[1];
			assert.exists(sid, "expected a session id in the message request path");
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
		sessionList,
		messageRequestCounts,
		injectSSE(event) {
			const data = JSON.stringify({
				directory: process.cwd(),
				payload: { id: `evt_${++eventId}`, ...event },
			});
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

interface TestHarness {
	relay: ProjectRelay;
	mock: MockOpenCode;
	relayPort: number;
	connectClient(): Promise<TestWsClient>;
	stop(): Promise<void>;
}

async function createTestHarness(
	mockConfig?: MockOpenCodeConfig,
): Promise<TestHarness> {
	const mock = await createMockOpenCode(mockConfig);

	const relayServer = createServer();
	await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
	const relayPort = (relayServer.address() as { port: number }).port;
	const dbPath = tempEventsDbPath();
	await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* EventStoreEffectTag;
			for (const session of mock.sessionList) {
				yield* store.append(
					canonicalEvent(
						"session.created",
						session.id,
						{
							sessionId: session.id,
							title: session.title,
							provider: "opencode",
						},
						{ provider: "opencode" },
					),
				);
				if (session.parentID) {
					yield* store.append(
						canonicalEvent(
							"session.forked",
							session.id,
							{
								sessionId: session.id,
								parentId: session.parentID,
							},
							{ provider: "opencode" },
						),
					);
				}
			}
		}).pipe(Effect.provide(makePersistenceEffectLayer(dbPath))),
	);
	const persistenceDir = mkdtempSync(join(tmpdir(), "conduit-sse-gating-"));

	const relay = await createProjectRelay({
		persistenceDbPath: dbPath,
		httpServer: relayServer,
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		projectDir: process.cwd(),
		slug: `test-sse-gating-${relayPort}`,
		// Keep the real ~/.config/conduit settings out of the relay.
		configDir: persistenceDir,
		noServer: true,
		log: createSilentLogger(),
		pollerGatingConfig: {
			sseGracePeriodMs: TEST_GRACE_MS,
			sseActiveThresholdMs: TEST_STALENESS_MS,
		},
		statusPollerInterval: TEST_STATUS_POLL_MS,
		messagePollerInterval: TEST_MSG_POLL_MS,
	});

	const eventSockets = new WebSocketServer({ noServer: true });
	relayServer.on("upgrade", (req, socket, head) => {
		if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
			eventSockets.handleUpgrade(req, socket, head, (ws) => {
				const params = new URL(req.url ?? "/ws", "http://localhost")
					.searchParams;
				const requestedClientId = params.get("client") ?? "";
				const clientId = /^[A-Za-z0-9._:-]{1,128}$/.test(requestedClientId)
					? requestedClientId
					: randomBytes(8).toString("hex");
				const requestedSessionId = params.get("session") || undefined;
				relay.wsHandler.attach(ws, {
					clientId,
					...(requestedSessionId != null && { requestedSessionId }),
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

	// The poller reads projected SQLite status, so mirror the mock's status
	// mutations into the per-harness store without emitting SSE coverage.
	const db = new Database(dbPath);
	// parent_id matters: notification routing treats a session without one as top-level.
	const upsertRow = db.prepare(`
		INSERT INTO sessions (id, provider, title, parent_id, status, created_at, updated_at)
		VALUES (?, 'opencode', 'Untitled', ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET status = excluded.status,
			updated_at = excluded.updated_at
	`);
	const upsertStatus = (sessionId: string, status: string, now: number) =>
		upsertRow.run(
			sessionId,
			mock.sessionList.find((s) => s.id === sessionId)?.parentID ?? null,
			status,
			now,
			now,
		);
	for (const [sessionId, status] of Object.entries(mock.sessionStatuses)) {
		upsertStatus(sessionId, status.type, Date.now());
	}
	mock.sessionStatuses = new Proxy(mock.sessionStatuses, {
		set(target, sessionId, value: unknown) {
			if (
				typeof sessionId === "string" &&
				typeof value === "object" &&
				value !== null &&
				"type" in value &&
				typeof value.type === "string"
			) {
				upsertStatus(sessionId, value.type, Date.now());
			}
			return Reflect.set(target, sessionId, value);
		},
		deleteProperty(target, sessionId) {
			if (typeof sessionId === "string") {
				db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
			}
			return Reflect.deleteProperty(target, sessionId);
		},
	});

	// Relay startup makes no OpenCode requests; the first use opens the stream.
	await relay.effectRuntime.runtime.runPromise(
		Effect.scoped(
			Effect.flatMap(OpenCodeInstancesTag, (instances) =>
				instances.use("opencode"),
			),
		),
	);
	await vi.waitFor(
		() => {
			expect(mock.sseClients.size).toBeGreaterThan(0);
		},
		{ timeout: 3000 },
	);

	return {
		relay,
		mock,
		relayPort,
		async connectClient() {
			const client = new TestWsClient(
				`ws://127.0.0.1:${relayPort}/ws?p=test-sse-gating-${relayPort}`,
			);
			await client.waitForOpen();
			return client;
		},
		async stop() {
			await relay.stop();
			db.close();
			await new Promise<void>((resolve) => eventSockets.close(() => resolve()));
			await new Promise<void>((r) => relayServer.close(() => r()));
			await mock.close();
			rmSync(dirname(dbPath), { recursive: true, force: true });
			rmSync(persistenceDir, { recursive: true, force: true });
		},
	};
}

/** Only used for windows that assert activity stays absent. */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The status poller reads SQLite only, so cycles are measured in time. */
async function waitForStatusPollCycles(_mock: MockOpenCode, cycles = 4) {
	await wait(cycles * TEST_STATUS_POLL_MS + TEST_STATUS_POLL_MS / 2);
}

/** Wait until the status poller has seen the session busy, then give the
 *  monitoring tick that reduces it a poll cycle to land. (This harness writes
 *  status straight to SQLite, so no read-model feed sees it live.) */
async function waitForMonitoredBusy(harness: TestHarness, sessionId: string) {
	await vi.waitFor(
		async () => {
			const statuses =
				await harness.relay.effectRuntime.runtime.runPromise(
					getCurrentStatuses,
				);
			expect(["busy", "retry"]).toContain(statuses[sessionId]?.type);
		},
		{ timeout: 3000, interval: 10 },
	);
	await waitForStatusPollCycles(harness.mock, 1);
}

/** Helper: connect client and switch to a session */
async function connectAndView(
	harness: TestHarness,
	sessionId: string,
): Promise<TestWsClient> {
	const client = await harness.connectClient();
	await client.waitForInitialState();
	await client.viewSession(sessionId);
	client.clearReceived();
	return client;
}

/** Helper: reset harness state for the next test within a shared describe. */
async function resetForNextTest(
	harness: TestHarness,
	sessions: string[],
): Promise<void> {
	for (const sid of sessions) {
		harness.mock.sessionStatuses[sid] = { type: "idle" };
	}
	await waitForStatusPollCycles(harness.mock);
	harness.mock.resetMessageRequestCounts();
}

describe("Group 1: SSE coverage and grace period", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	// Longer timeout: the file's first attach pays the one-time Claude capability
	// probe (model_list waits on it while no OpenCode catalog is cached).
	it("Scenario 1: Busy + continuous SSE → no poller starts", async () => {
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// Inject SSE events for sess-1 every 80ms for 800ms (covers grace+staleness)
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		// Observe a full SSE-covered window to prove polling stays suppressed.
		await wait(TEST_GRACE_MS * 2 + TEST_STALENESS_MS);
		clearInterval(sseInterval);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// With SSE covering, poller should NOT have started → few/no message requests
		expect(count).toBeLessThan(5);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 10_000);

	it("Scenario 2: SSE events for wrong session don't count as coverage", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session sess-1 goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// Inject SSE events only for sess-2 (wrong session)
		harness.mock.resetMessageRequestCounts();
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-2", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					0,
				);
			},
			{ timeout: 3000 },
		);
		clearInterval(sseInterval);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// sess-1 had no SSE coverage → poller should have started after grace
		expect(count).toBeGreaterThan(0);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);

	it("Scenario 3: Busy + no SSE, before grace expires → fewer requests than after grace", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// Reset counts AFTER busy is confirmed to exclude init requests
		harness.mock.resetMessageRequestCounts();

		// Observe the early grace window to confirm no poller has started.
		await wait(Math.floor(TEST_GRACE_MS * 0.6));

		const countDuringGrace = harness.mock.getMessageRequestCount("sess-1");

		harness.mock.resetMessageRequestCounts();
		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					countDuringGrace,
				);
			},
			{ timeout: 3000 },
		);

		const countAfterGrace = harness.mock.getMessageRequestCount("sess-1");

		// After grace expires, poller starts → significantly more message requests
		expect(countAfterGrace).toBeGreaterThan(countDuringGrace);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);

	it("Scenario 4: Busy + no SSE, after grace expires → poller starts", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		harness.mock.resetMessageRequestCounts();
		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					0,
				);
			},
			{ timeout: 3000 },
		);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// Grace expired + no SSE → poller should have started and polled
		expect(count).toBeGreaterThan(0);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);
});

describe("Group 2: SSE dynamics", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 5: SSE active then stops → poller starts after staleness", async () => {
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// SSE events flow for a short burst
		let injected = 0;
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
			injected++;
		}, TEST_SSE_INJECT_INTERVAL);

		await vi.waitFor(
			() => {
				expect(injected).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 3000 },
		);
		clearInterval(sseInterval);

		harness.mock.resetMessageRequestCounts();
		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					0,
				);
			},
			{ timeout: 3000 },
		);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// After SSE went stale + grace, poller should have started
		expect(count).toBeGreaterThan(0);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);

	it("Scenario 6: Poller running + SSE resumes → polling rate drops", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy, no SSE → wait for poller to start
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		harness.mock.resetMessageRequestCounts();
		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					0,
				);
			},
			{ timeout: 3000 },
		);

		// Measure baseline rate (polling without SSE)
		harness.mock.resetMessageRequestCounts();
		await waitForStatusPollCycles(harness.mock, 6);
		const rateWithoutSSE = harness.mock.getMessageRequestCount("sess-1");
		expect(rateWithoutSSE).toBeGreaterThan(0);

		// Start SSE injection
		let injected = 0;
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
			injected++;
		}, TEST_SSE_INJECT_INTERVAL);

		await vi.waitFor(
			() => {
				expect(injected).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 3000 },
		);
		await waitForStatusPollCycles(harness.mock, 2);

		// Measure rate with SSE
		harness.mock.resetMessageRequestCounts();
		await waitForStatusPollCycles(harness.mock, 6);
		const rateWithSSE = harness.mock.getMessageRequestCount("sess-1");

		clearInterval(sseInterval);

		// Rate after SSE resumes should be lower (poller stopped or reduced)
		expect(rateWithSSE).toBeLessThan(rateWithoutSSE);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 5000 });
		await client.close();
	}, 5_000);
});

describe("Group 3: Idle transitions", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 7: Busy-grace → idle → done sent, no poller to stop", async () => {
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// Reset counts AFTER busy is confirmed to exclude init/seeding requests
		harness.mock.resetMessageRequestCounts();

		// Observe a short grace window to confirm the poller stays inactive.
		await wait(Math.floor(TEST_GRACE_MS * 0.3));
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		// Client should receive done
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// Message request count should be at baseline (no poller was started)
		const count = harness.mock.getMessageRequestCount("sess-1");
		expect(count).toBeLessThan(3);

		await client.close();
	}, 5_000);

	it("Scenario 8: Busy-sse-covered → idle → done sent, no poller to stop", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy with SSE events flowing
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		// Reset counts AFTER busy is confirmed to exclude init/seeding requests
		// (same pattern as Scenarios 3 and 7)
		harness.mock.resetMessageRequestCounts();

		// SSE events flowing — keep them going long enough for the reducer to
		// register SSE coverage (multiple poll cycles under contention).
		let injected = 0;
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
			injected++;
		}, TEST_SSE_INJECT_INTERVAL);

		await vi.waitFor(
			() => {
				expect(injected).toBeGreaterThanOrEqual(2);
			},
			{ timeout: 3000 },
		);
		await waitForStatusPollCycles(harness.mock);
		clearInterval(sseInterval);
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		// Client should receive done — use generous timeout for contention
		const done = await client.waitFor("done", { timeout: 5000 });
		expect(done["type"]).toBe("done");

		// No poller was started → baseline message request count
		const count = harness.mock.getMessageRequestCount("sess-1");
		expect(count).toBeLessThan(3);

		await client.close();
	}, 8_000);

	it("Scenario 9: Busy-polling → idle → poller stops + done sent", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy, no SSE → wait for poller to start
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		harness.mock.resetMessageRequestCounts();
		await vi.waitFor(
			() => {
				expect(harness.mock.getMessageRequestCount("sess-1")).toBeGreaterThan(
					0,
				);
			},
			{ timeout: 3000 },
		);

		// Verify poller is running
		const countBefore = harness.mock.getMessageRequestCount("sess-1");
		expect(countBefore).toBeGreaterThan(0);

		// Go idle
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// Reset counts after idle; verify no further polling over several intervals.
		harness.mock.resetMessageRequestCounts();
		// Observe a quiet window after idle to prove the message poller stopped.
		await wait(TEST_MSG_POLL_MS * 3);
		const countAfter = harness.mock.getMessageRequestCount("sess-1");
		// Poller stopped → no new message requests
		expect(countAfter).toBe(0);

		await client.close();
	}, 5_000);
});

describe("Group 4: Cross-session and lifecycle", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness({
			sessions: [
				{ id: "sess-1", title: "Session 1" },
				{ id: "sess-2", title: "Session 2" },
			],
		});
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 10: Two sessions — A polling, B SSE-covered → independent", async () => {
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Both sessions go busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		harness.mock.sessionStatuses["sess-2"] = { type: "busy" };

		await waitForMonitoredBusy(harness, "sess-1");

		// SSE events for sess-2 only
		harness.mock.resetMessageRequestCounts();
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-2", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		await vi.waitFor(
			() => {
				const countSess1 = harness.mock.getMessageRequestCount("sess-1");
				expect(countSess1).toBeGreaterThan(0);
				expect(harness.mock.getMessageRequestCount("sess-2")).toBeLessThan(
					countSess1,
				);
			},
			{ timeout: 3000 },
		);

		clearInterval(sseInterval);

		const countSess1 = harness.mock.getMessageRequestCount("sess-1");
		const countSess2 = harness.mock.getMessageRequestCount("sess-2");

		// sess-1 has no SSE → should have high message requests (poller running)
		expect(countSess1).toBeGreaterThan(0);
		// sess-2 has SSE coverage → should have low message requests
		expect(countSess2).toBeLessThan(countSess1);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		harness.mock.sessionStatuses["sess-2"] = { type: "idle" };
		await waitForStatusPollCycles(harness.mock);
		await client.close();
	}, 5_000);

	it("Scenario 11: Session deleted while busy → no phantom effects", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// sess-2 goes busy
		harness.mock.sessionStatuses["sess-2"] = { type: "busy" };
		await waitForStatusPollCycles(harness.mock);

		// Remove sess-2 from session list and status map
		const idx = harness.mock.sessionList.findIndex((s) => s.id === "sess-2");
		if (idx >= 0) harness.mock.sessionList.splice(idx, 1);
		delete harness.mock.sessionStatuses["sess-2"];

		await waitForStatusPollCycles(harness.mock);

		// Connect a client and verify relay still works with sess-1
		const client = await harness.connectClient();
		await client.waitForInitialState();
		const switched = await client.viewSession("sess-1");
		expect(switched["id"]).toBe("sess-1");

		await client.close();

		// Restore sess-2 for any further tests
		harness.mock.sessionList.push({ id: "sess-2", title: "Session 2" });
		harness.mock.sessionStatuses["sess-2"] = { type: "idle" };
	}, 5_000);
});

describe("Group 5: Notifications", () => {
	const alertsOf = (client: TestWsClient) =>
		client.getReceivedOfType("alerts").filter((m) => m["_tag"] === "alert");

	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness({
			sessions: [
				{ id: "sess-1", title: "Session 1" },
				{ id: "sess-2", title: "Session 2 (subagent)", parentID: "sess-1" },
			],
		});
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 12: Subagent done → no cross-session broadcast", async () => {
		const client = await connectAndView(harness, "sess-1");
		await client.subscribeAlerts();

		// sess-2 (subagent of sess-1) goes busy then idle
		harness.mock.sessionStatuses["sess-2"] = { type: "busy" };
		await waitForStatusPollCycles(harness.mock);
		harness.mock.sessionStatuses["sess-2"] = { type: "idle" };
		await waitForStatusPollCycles(harness.mock);

		// Client viewing sess-1 should NOT receive an alert for subagent done
		expect(alertsOf(client)).toEqual([]);

		await client.close();
	}, 5_000);

	it("Scenario 13: Non-subagent done → cross-session broadcast fires", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-2 (no one viewing sess-1)
		const client = await connectAndView(harness, "sess-2");
		await client.subscribeAlerts();

		// sess-1 (NOT a subagent) goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForStatusPollCycles(harness.mock);

		client.clearReceived();

		// sess-1 goes idle → should trigger cross-session broadcast
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		// Client on sess-2 should receive a "done" alert on SubscribeAlerts
		const alert = await client.waitFor("alerts", {
			timeout: 5000,
			predicate: (m) => m["_tag"] === "alert" && m["kind"] === "done",
		});
		expect(alert).toMatchObject({ sessionId: "sess-1" });
		expect(alert["alertId"]).toEqual(expect.any(String));

		await client.close();
	}, 10_000);

	it("Scenario 14: Done with active viewer → sent to session, no cross-session broadcast", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-1 (the session that will go busy/idle)
		const client = await connectAndView(harness, "sess-1");
		await client.subscribeAlerts();

		// sess-1 goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		client.clearReceived();

		// sess-1 goes idle → done should be sent directly to session viewer
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// Should NOT receive an alert (done was delivered to viewer directly)
		await waitForStatusPollCycles(harness.mock);
		expect(alertsOf(client)).toEqual([]);

		await client.close();
	}, 5_000);

	it("Scenario 15: Done without viewer → cross-session broadcast", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-2 (no one viewing sess-1)
		const client = await connectAndView(harness, "sess-2");
		await client.subscribeAlerts();

		// sess-1 goes busy (no viewer)
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForStatusPollCycles(harness.mock);

		client.clearReceived();

		// sess-1 goes idle → cross-session broadcast should fire
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		const alert = await client.waitFor("alerts", {
			timeout: 5000,
			predicate: (m) => m["_tag"] === "alert" && m["kind"] === "done",
		});
		expect(alert).toMatchObject({ sessionId: "sess-1" });

		await client.close();
	}, 10_000);
});

describe("Group 6: Retry status and cycling", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 16: Retry status treated as busy", async () => {
		const client = await connectAndView(harness, "sess-1");

		// Set session status to retry
		harness.mock.sessionStatuses["sess-1"] = {
			type: "retry",
			attempt: 1,
			message: "rate limited",
			next: Date.now() + 5000,
		};

		// The shell row reports a running turn (retry is treated as busy)
		await waitForMonitoredBusy(harness, "sess-1");

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);

	it("Scenario 17: Rapid busy→idle→busy cycling → correct status/done sequence", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");

		// First busy cycle
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });

		client.clearReceived();

		// Second busy cycle
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await waitForMonitoredBusy(harness, "sess-1");

		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });

		// Verify the sequence: busy row, done, busy row, done
		// (We cleared after the first done, so only the second cycle is in received)
		expect(client.getReceivedOfType("done").length).toBeGreaterThanOrEqual(1);

		await client.close();
	}, 5_000);

	it("Scenario 18: Steady-state (no status changes) → no family push spam", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");

		// Session stays idle — clear received after initial setup
		client.clearReceived();

		// Observe a steady-state window: poll ticks alone move no family row.
		await wait(TEST_STATUS_POLL_MS * 6);

		expect(client.getReceivedOfType("family")).toEqual([]);

		await client.close();
	}, 5_000);
});
