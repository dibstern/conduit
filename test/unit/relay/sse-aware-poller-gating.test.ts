// ─── SSE-Aware Poller Gating Integration Test ───────────────────────────────
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

// ── Accelerated timing constants ────────────────────────────────────────────
// Production values: grace=3000ms, staleness=5000ms, statusPoll=500ms, msgPoll=750ms
// Test values: ~10x faster to avoid multi-minute test runs.

const TEST_GRACE_MS = 300;
const TEST_STALENESS_MS = 500;
const TEST_STATUS_POLL_MS = 100;
const TEST_MSG_POLL_MS = 150;
const TEST_SSE_INJECT_INTERVAL = 80; // production: 400ms

// ── Mock OpenCode Server with request counting ──────────────────────────────

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
			const result = sessionList.map((s) => ({
				id: s.id,
				title: s.title,
				modelID: "gpt-4",
				providerID: "openai",
				...(s.parentID != null && { parentID: s.parentID }),
			}));
			res.end(JSON.stringify(result));
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
			const found = sessionList.find((s) => s.id === id);
			const session = found
				? {
						id: found.id,
						title: found.title,
						modelID: "gpt-4",
						providerID: "openai",
						...(found.parentID != null && { parentID: found.parentID }),
					}
				: { id, title: "Unknown", modelID: "gpt-4", providerID: "openai" };
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
		sessionList,
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

async function createTestHarness(
	mockConfig?: MockOpenCodeConfig,
): Promise<TestHarness> {
	const mock = await createMockOpenCode(mockConfig);

	const relayServer = createServer();
	await new Promise<void>((r) => relayServer.listen(0, "127.0.0.1", r));
	const relayPort = (relayServer.address() as { port: number }).port;

	const relay = await createProjectRelay({
		httpServer: relayServer,
		opencodeUrl: `http://127.0.0.1:${mock.port}`,
		projectDir: process.cwd(),
		slug: `test-sse-gating-${relayPort}`,
		log: createSilentLogger(),
		pollerGatingConfig: {
			sseGracePeriodMs: TEST_GRACE_MS,
			sseActiveThresholdMs: TEST_STALENESS_MS,
		},
		statusPollerInterval: TEST_STATUS_POLL_MS,
		messagePollerInterval: TEST_MSG_POLL_MS,
	});

	// Wait for SSE + status poller to initialize
	await new Promise((r) => setTimeout(r, 200));

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

/** Helper: wait for a specified duration */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Helper: connect client and switch to a session */
async function connectAndView(
	harness: TestHarness,
	sessionId: string,
): Promise<TestWsClient> {
	const client = await harness.connectClient();
	await client.waitForInitialState();
	client.send({ type: "view_session", sessionId });
	await client.waitFor("session_switched", {
		timeout: 3000,
		predicate: (m) => m["id"] === sessionId,
	});
	client.clearReceived();
	return client;
}

/** Helper: reset harness state for the next test within a shared describe */
async function resetForNextTest(
	harness: TestHarness,
	sessions: string[],
): Promise<void> {
	for (const sid of sessions) {
		harness.mock.sessionStatuses[sid] = { type: "idle" };
	}
	harness.mock.resetMessageRequestCounts();
	// Let the reducer process the idle transition (needs a few status poll cycles)
	await wait(TEST_GRACE_MS + TEST_STATUS_POLL_MS * 2);
}

// ── Tests ───────────────────────────────────────────────────────────────────

// ─── Group 1: SSE coverage and grace period ────────────────────────────────

describe("Group 1: SSE coverage and grace period", () => {
	let harness: TestHarness;

	beforeAll(async () => {
		harness = await createTestHarness();
	}, 10_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	}, 5_000);

	it("Scenario 1: Busy + continuous SSE → no poller starts", async () => {
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Inject SSE events for sess-1 every 80ms for 800ms (covers grace+staleness)
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		await wait(TEST_GRACE_MS * 2 + TEST_STALENESS_MS);
		clearInterval(sseInterval);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// With SSE covering, poller should NOT have started → few/no message requests
		expect(count).toBeLessThan(5);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);

	it("Scenario 2: SSE events for wrong session don't count as coverage", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session sess-1 goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Inject SSE events only for sess-2 (wrong session)
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-2", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		// Wait past grace period + some buffer
		await wait(TEST_GRACE_MS * 2);
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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Reset counts AFTER busy is confirmed to exclude init requests
		harness.mock.resetMessageRequestCounts();

		// Only wait half the grace period — no poller yet
		await wait(Math.floor(TEST_GRACE_MS * 0.6));

		const countDuringGrace = harness.mock.getMessageRequestCount("sess-1");

		// Now wait past grace period for poller to start
		harness.mock.resetMessageRequestCounts();
		await wait(TEST_GRACE_MS + TEST_STATUS_POLL_MS * 3);

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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Wait past grace period + extra time for poller to poll
		await wait(TEST_GRACE_MS * 2);

		const count = harness.mock.getMessageRequestCount("sess-1");
		// Grace expired + no SSE → poller should have started and polled
		expect(count).toBeGreaterThan(0);

		// Cleanup
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await client.close();
	}, 5_000);
});

// ─── Group 2: SSE dynamics ─────────────────────────────────────────────────

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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// SSE events flow for a short burst
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		await wait(TEST_STALENESS_MS * 0.4);
		clearInterval(sseInterval);

		// SSE stops — wait for staleness threshold + grace + buffer
		await wait(TEST_STALENESS_MS + TEST_GRACE_MS + TEST_STATUS_POLL_MS * 3);

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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Wait past grace for poller to start
		await wait(TEST_GRACE_MS * 2);

		// Measure baseline rate (polling without SSE)
		harness.mock.resetMessageRequestCounts();
		await wait(TEST_MSG_POLL_MS * 4);
		const rateWithoutSSE = harness.mock.getMessageRequestCount("sess-1");

		// Start SSE injection
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		// Let reducer detect SSE coverage and stop poller
		await wait(TEST_STATUS_POLL_MS * 4);

		// Measure rate with SSE
		harness.mock.resetMessageRequestCounts();
		await wait(TEST_MSG_POLL_MS * 4);
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

// ─── Group 3: Idle transitions ─────────────────────────────────────────────

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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Reset counts AFTER busy is confirmed to exclude init/seeding requests
		harness.mock.resetMessageRequestCounts();

		// Only busy for a fraction of grace period, then go idle
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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// SSE events flowing
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-1", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		// Go idle before grace matters
		await wait(Math.floor(TEST_GRACE_MS * 0.5));
		clearInterval(sseInterval);
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		// Client should receive done
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// No poller was started → baseline message request count
		const count = harness.mock.getMessageRequestCount("sess-1");
		expect(count).toBeLessThan(3);

		await client.close();
	}, 5_000);

	it("Scenario 9: Busy-polling → idle → poller stops + done sent", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");
		harness.mock.resetMessageRequestCounts();

		// Session goes busy, no SSE → wait for poller to start
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// Wait past grace for poller to start
		await wait(TEST_GRACE_MS * 2);

		// Verify poller is running
		const countBefore = harness.mock.getMessageRequestCount("sess-1");
		expect(countBefore).toBeGreaterThan(0);

		// Go idle
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// Reset counts after idle, wait for a few poll cycles → poller should have stopped
		harness.mock.resetMessageRequestCounts();
		await wait(TEST_MSG_POLL_MS * 3);
		const countAfter = harness.mock.getMessageRequestCount("sess-1");
		// Poller stopped → no new message requests
		expect(countAfter).toBe(0);

		await client.close();
	}, 5_000);
});

// ─── Group 4: Cross-session and lifecycle ──────────────────────────────────

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

		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		// SSE events for sess-2 only
		const sseInterval = setInterval(() => {
			harness.mock.injectSSE({
				type: "message.delta",
				properties: { sessionID: "sess-2", text: "..." },
			});
		}, TEST_SSE_INJECT_INTERVAL);

		// Wait past grace period for pollers to start
		await wait(TEST_GRACE_MS * 2);

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
		await wait(TEST_GRACE_MS);
		await client.close();
	}, 5_000);

	it("Scenario 11: Session deleted while busy → no phantom effects", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// sess-2 goes busy
		harness.mock.sessionStatuses["sess-2"] = { type: "busy" };
		await wait(TEST_STATUS_POLL_MS * 3);

		// Remove sess-2 from session list and status map
		const idx = harness.mock.sessionList.findIndex((s) => s.id === "sess-2");
		if (idx >= 0) harness.mock.sessionList.splice(idx, 1);
		delete harness.mock.sessionStatuses["sess-2"];

		// Wait — should not crash
		await wait(TEST_STATUS_POLL_MS * 3);

		// Connect a client and verify relay still works with sess-1
		const client = await harness.connectClient();
		await client.waitForInitialState();
		client.send({ type: "view_session", sessionId: "sess-1" });
		const switched = await client.waitFor("session_switched", {
			timeout: 3000,
			predicate: (m) => m["id"] === "sess-1",
		});
		expect(switched["id"]).toBe("sess-1");

		await client.close();

		// Restore sess-2 for any further tests
		harness.mock.sessionList.push({ id: "sess-2", title: "Session 2" });
		harness.mock.sessionStatuses["sess-2"] = { type: "idle" };
	}, 5_000);
});

// ─── Group 5: Notifications ────────────────────────────────────────────────

describe("Group 5: Notifications", () => {
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

		// sess-2 (subagent of sess-1) goes busy then idle
		harness.mock.sessionStatuses["sess-2"] = { type: "busy" };
		await wait(TEST_STATUS_POLL_MS * 3);
		harness.mock.sessionStatuses["sess-2"] = { type: "idle" };
		await wait(TEST_STATUS_POLL_MS * 3);

		// Client viewing sess-1 should NOT receive notification_event for subagent done
		const notifications = client.getReceivedOfType("notification_event");
		expect(notifications.length).toBe(0);

		await client.close();
	}, 5_000);

	it("Scenario 13: Non-subagent done → cross-session broadcast fires", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-2 (no one viewing sess-1)
		const client = await connectAndView(harness, "sess-2");

		// sess-1 (NOT a subagent) goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await wait(TEST_STATUS_POLL_MS * 3);

		client.clearReceived();

		// sess-1 goes idle → should trigger cross-session broadcast
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		// Client on sess-2 should receive notification_event with eventType: "done"
		const notification = await client.waitFor("notification_event", {
			timeout: 5000,
			predicate: (m) => m["eventType"] === "done",
		});
		expect(notification["type"]).toBe("notification_event");
		expect(notification["eventType"]).toBe("done");

		await client.close();
	}, 5_000);

	it("Scenario 14: Done with active viewer → sent to session, no cross-session broadcast", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-1 (the session that will go busy/idle)
		const client = await connectAndView(harness, "sess-1");

		// sess-1 goes busy
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});

		client.clearReceived();

		// sess-1 goes idle → done should be sent directly to session viewer
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		const done = await client.waitFor("done", { timeout: 3000 });
		expect(done["type"]).toBe("done");

		// Should NOT receive notification_event (done was delivered to viewer directly)
		await wait(TEST_STATUS_POLL_MS * 3);
		const notifications = client.getReceivedOfType("notification_event");
		expect(notifications.length).toBe(0);

		await client.close();
	}, 5_000);

	it("Scenario 15: Done without viewer → cross-session broadcast", async () => {
		await resetForNextTest(harness, ["sess-1", "sess-2"]);

		// Client viewing sess-2 (no one viewing sess-1)
		const client = await connectAndView(harness, "sess-2");

		// sess-1 goes busy (no viewer)
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await wait(TEST_STATUS_POLL_MS * 3);

		client.clearReceived();

		// sess-1 goes idle → cross-session broadcast should fire
		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };

		const notification = await client.waitFor("notification_event", {
			timeout: 5000,
			predicate: (m) => m["eventType"] === "done",
		});
		expect(notification["type"]).toBe("notification_event");

		await client.close();
	}, 5_000);
});

// ─── Group 6: Retry status and cycling ─────────────────────────────────────

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

		// Client should receive status:processing (retry is treated as busy)
		const status = await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		expect(status["status"]).toBe("processing");

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
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		await wait(TEST_STATUS_POLL_MS * 2);

		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });
		await wait(TEST_STATUS_POLL_MS * 2);

		client.clearReceived();

		// Second busy cycle
		harness.mock.sessionStatuses["sess-1"] = { type: "busy" };
		await client.waitFor("status", {
			timeout: 3000,
			predicate: (m) => m["status"] === "processing",
		});
		await wait(TEST_STATUS_POLL_MS * 2);

		harness.mock.sessionStatuses["sess-1"] = { type: "idle" };
		await client.waitFor("done", { timeout: 3000 });

		// Verify the sequence: status:processing, done, status:processing, done
		// (We cleared after the first done, so only the second cycle is in received)
		const statuses = client.getReceivedOfType("status");
		const dones = client.getReceivedOfType("done");
		expect(statuses.length).toBeGreaterThanOrEqual(1);
		expect(dones.length).toBeGreaterThanOrEqual(1);

		await client.close();
	}, 5_000);

	it("Scenario 18: Steady-state (no status changes) → no session_list spam", async () => {
		await resetForNextTest(harness, ["sess-1"]);
		const client = await connectAndView(harness, "sess-1");

		// Session stays idle — clear received after initial setup
		client.clearReceived();

		// Wait several status poll cycles in steady state
		await wait(TEST_STATUS_POLL_MS * 6);

		// Count session_list messages — should be 0 or very few
		const sessionListMsgs = client.getReceivedOfType("session_list");
		// The statusesChanged flag gates broadcast: no status changes → no session_list spam
		expect(sessionListMsgs.length).toBeLessThanOrEqual(2);

		await client.close();
	}, 5_000);
});
