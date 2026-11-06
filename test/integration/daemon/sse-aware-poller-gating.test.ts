// SSE-aware message-poller gating on the daemon, end to end (82tn.16). A turn is busy the way
// the product sees it: a send with the OpenCode stream silent leaves the Run Ledger holding the
// session's Run; OpenCode's idle status on the stream, filed under that Run, ends it. Poller
// activity is read from the mock's GET /session/{id}/message requests. How it could fail
// (the scenario numbers):
// 1. a busy session whose stream keeps flowing starts a message poller anyway;
// 2. stream events for another session count as this session's coverage;
// 3. the poller starts before the grace period ends, or never starts after it;
// 5. a stream that goes quiet mid-turn never hands over to the poller;
// 6. a stream that resumes leaves the poller reading at its full rate;
// 7-9. a turn ending during the grace, under stream cover, or while polling leaves a poller reading;
// 10. one session's coverage gates another session's poller;
// 12-14. a subagent's turn end alerts its parent's tab, an unviewed session's turn end alerts
//     nobody, or a viewed session's turn end alerts its own viewer;
// 16. a retry status ends the turn;
// 17. back-to-back turns lose a start or an end;
// 18. idle poll ticks push family rows.
// Scenario 11 (a session deleted while busy leaves effects behind) is covered on the daemon by
// opencode-poller-demand.test.ts, "a session deleted while a tab views it stops its message poller".
// Timings are about 10x faster than production through the daemon's pollerTimings seam.

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { Effect, PubSub } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	getCurrentStatuses,
	PollerPubSubTag,
} from "../../../src/lib/domain/relay/Services/session-status-poller.js";
import { makeCommitAndSignal } from "../../../src/lib/persistence/effect/commit-and-signal.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import {
	createDaemonProject,
	type DaemonProject,
} from "../../helpers/in-process-daemon.js";
import type { TestWsClient } from "../helpers/test-ws-client.js";

const GRACE_MS = 150;
const STALENESS_MS = 250;
const STATUS_POLL_MS = 25;
const MESSAGE_POLL_MS = 50;
const INJECT_MS = 20;

interface SessionDef {
	readonly id: string;
	readonly title: string;
	readonly parentID?: string;
}

async function createMockOpenCode(sessions: readonly SessionDef[]) {
	const sseClients = new Set<ServerResponse>();
	let eventId = 0;
	let onConnect: () => void = () => {};
	const connected = new Promise<void>((resolve) => {
		onConnect = resolve;
	});
	const counts = new Map<string, number>();
	/** What OpenCode stored for each session: its echoed sends. */
	const history = new Map<string, unknown[]>();
	const waiters = new Map<string, (() => void)[]>();
	const promptWaiters = new Map<string, (() => void)[]>();
	const next = (on: Map<string, (() => void)[]>, sessionId: string) =>
		new Promise<void>((resolve) =>
			on.set(sessionId, [...(on.get(sessionId) ?? []), resolve]),
		);
	const wake = (on: Map<string, (() => void)[]>, sessionId: string) => {
		for (const resolve of on.get(sessionId) ?? []) resolve();
		on.delete(sessionId);
	};
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
			onConnect();
			return;
		}
		res.setHeader("Content-Type", "application/json");
		const json = (body: unknown) => res.end(JSON.stringify(body));
		if (url.pathname === "/global/health") return json({ healthy: true });
		if (url.pathname === "/path")
			return json({
				state: "/tmp/opencode-state",
				config: "/tmp/opencode-config",
				worktree: "/test",
				directory: "/test",
			});
		if (url.pathname === "/session" && req.method === "GET")
			return json(sessions.map(toOpenCodeSession));
		if (url.pathname === "/session/status")
			return json(
				Object.fromEntries(sessions.map(({ id }) => [id, { type: "idle" }])),
			);
		const message = url.pathname.match(/^\/session\/([\w-]+)\/message$/);
		if (message?.[1] && req.method === "GET") {
			const id = message[1];
			counts.set(id, (counts.get(id) ?? 0) + 1);
			wake(waiters, id);
			return json(history.get(id) ?? []);
		}
		const session = url.pathname.match(/^\/session\/([\w-]+)$/);
		if (session?.[1] && req.method === "GET") {
			const id = session[1];
			return json(
				toOpenCodeSession(
					sessions.find((s) => s.id === id) ?? { id, title: "Unknown" },
				),
			);
		}
		if (url.pathname === "/agent")
			return json([{ id: "coder", name: "coder", description: "Main" }]);
		if (url.pathname === "/provider")
			return json({
				all: [
					{
						id: "openai",
						name: "OpenAI",
						models: {
							"gpt-4": {
								id: "gpt-4",
								name: "GPT-4",
								limit: { context: 8192, output: 4096 },
							},
						},
					},
				],
				default: { openai: "gpt-4" },
				connected: ["openai"],
			});
		// OpenCode accepts a send by echoing its user message on the stream;
		// nothing else follows, so the stream is silent after it.
		const prompt = url.pathname.match(/^\/session\/([\w-]+)\/prompt_async$/);
		if (prompt?.[1] && req.method === "POST") {
			const sessionID = prompt[1];
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => {
				const { messageID, parts } = JSON.parse(
					Buffer.concat(chunks).toString(),
				) as { messageID: string; parts: Record<string, unknown>[] };
				const info = {
					id: messageID,
					sessionID,
					role: "user",
					time: { created: Date.now() },
					agent: "coder",
					model: { providerID: "openai", modelID: "gpt-4" },
				};
				history.set(sessionID, [
					...(history.get(sessionID) ?? []),
					{
						info,
						parts: parts.map((part, index) => ({
							...part,
							id: `${messageID}-part-${index}`,
							sessionID,
							messageID,
						})),
					},
				]);
				json({});
				inject("message.updated", { info });
				wake(promptWaiters, sessionID);
			});
			return;
		}
		return json({});
	}

	const server = createServer(handler);
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as { port: number }).port;
	const inject = (type: string, properties: Record<string, unknown>) => {
		const data = JSON.stringify({
			directory: process.cwd(),
			payload: { id: `evt_${++eventId}`, type, properties },
		});
		for (const client of sseClients) client.write(`data: ${data}\n\n`);
	};
	return {
		url: `http://127.0.0.1:${port}`,
		connected,
		inject,
		/** GET /session/{id}/message requests since the last reset. */
		messageReads: (sessionId: string) => counts.get(sessionId) ?? 0,
		resetMessageReads: () => counts.clear(),
		/** Resolves on the session's next message read. */
		nextMessageRead: (sessionId: string) => next(waiters, sessionId),
		/** Resolves once the session's next send reached OpenCode and was echoed. */
		nextPrompt: (sessionId: string) => next(promptWaiters, sessionId),
		async close() {
			for (const client of sseClients) client.end();
			await new Promise<void>((r) => server.close(() => r()));
		},
	};
}
type MockOpenCode = Awaited<ReturnType<typeof createMockOpenCode>>;

interface Harness {
	readonly project: DaemonProject;
	readonly mock: MockOpenCode;
	stop(): Promise<void>;
}

async function createHarness(
	sessions: readonly SessionDef[] = [{ id: "sess-1", title: "Session 1" }],
): Promise<Harness> {
	const mock = await createMockOpenCode(sessions);
	const project = await createDaemonProject("chat-simple", {
		opencodeUrl: mock.url,
		slug: "sse-gating",
		pollerTimings: {
			pollerGatingConfig: {
				sseGracePeriodMs: GRACE_MS,
				sseActiveThresholdMs: STALENESS_MS,
			},
			statusPollerInterval: STATUS_POLL_MS,
			messagePollerInterval: MESSAGE_POLL_MS,
			messagePollerSseSilence: STALENESS_MS,
		},
	}).catch(async (error: unknown) => {
		await mock.close();
		throw error;
	});
	await project.run(
		Effect.flatMap(makeCommitAndSignal, (commit) =>
			commit(
				sessions.flatMap(({ id: sessionId, title, parentID }) => [
					canonicalEvent(
						"session.created",
						sessionId,
						{
							sessionId,
							title,
							provider: "opencode",
							// A subagent is contained by its parent; session.forked would make it a Fork.
							...(parentID != null && { parentId: parentID }),
						},
						{ provider: "opencode" },
					),
					// A send needs the session's model pick, checked against the mock's catalog.
					canonicalEvent(
						"session.model_changed",
						sessionId,
						{ sessionId, modelId: "gpt-4", providerId: "openai" },
						{ provider: "opencode" },
					),
					canonicalEvent(
						"session.variant_changed",
						sessionId,
						{ sessionId, variant: "" },
						{ provider: "opencode" },
					),
					canonicalEvent(
						"session.context_window_changed",
						sessionId,
						{ sessionId, contextWindow: "" },
						{ provider: "opencode" },
					),
				]),
			),
		),
	);
	// The daemon opens the external OpenCode's stream at start.
	await mock.connected;
	return {
		project,
		mock,
		async stop() {
			try {
				await project.stop();
			} finally {
				await mock.close();
			}
		},
	};
}

/** Observe real status-poll publications, including unchanged statuses. */
const pollCycles = (harness: Harness, cycles: number) =>
	harness.project.run(
		Effect.gen(function* () {
			const subscription = yield* PubSub.subscribe(yield* PollerPubSubTag);
			for (let cycle = 0; cycle < cycles; cycle++)
				yield* PubSub.take(subscription);
		}).pipe(Effect.scoped),
	);

const statusOf = async (harness: Harness, sessionId: string) =>
	(await harness.project.run(getCurrentStatuses))[sessionId]?.type;

async function connectAndView(harness: Harness, sessionId: string) {
	const client = await harness.project.connectWsClient();
	await client.waitForInitialState();
	await client.viewSession(sessionId);
	await client.subscribeAlerts();
	client.clearReceived();
	return client;
}

/** A send with the stream silent after OpenCode's echo: busy once the shell
 *  row shows the turn and the status poller read it. */
async function startTurn(
	harness: Harness,
	client: TestWsClient,
	sessionId: string,
) {
	const prompted = harness.mock.nextPrompt(sessionId);
	await client.sendMessage("go", { sessionId });
	await client.waitForTurnStart(sessionId);
	await prompted;
	await pollCycles(harness, 2);
	expect(await statusOf(harness, sessionId)).toBe("busy");
}

/** OpenCode's idle status on the stream ends the session's Run. */
async function endTurn(
	harness: Harness,
	client: TestWsClient,
	sessionId: string,
) {
	harness.mock.inject("session.status", {
		sessionID: sessionId,
		status: { type: "idle" },
	});
	await client.waitForTurnEnd(sessionId);
}

/** The message poller is running: two reads in a row. A single read can be a
 *  one-off history fetch (first sighting, or the recheck after a turn ends). */
async function polling(mock: MockOpenCode, sessionId: string) {
	await mock.nextMessageRead(sessionId);
	await mock.nextMessageRead(sessionId);
}

/** Stream coverage for a session: one event now, then one every INJECT_MS. */
function cover(mock: MockOpenCode, sessionId: string) {
	let injected = 0;
	let onTwice: () => void = () => {};
	const twice = new Promise<void>((resolve) => {
		onTwice = resolve;
	});
	const inject = () => {
		mock.inject("message.delta", { sessionID: sessionId, text: "..." });
		if (++injected === 2) onTwice();
	};
	inject();
	const timer = setInterval(inject, INJECT_MS);
	return { twice, stop: () => clearInterval(timer) };
}

describe("Group 1: SSE coverage and grace period", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness();
	});
	afterAll(() => harness?.stop());

	it("Scenario 1: busy with continuous SSE starts no poller", async () => {
		const client = await connectAndView(harness, "sess-1");
		// Coverage is already flowing when the grace period starts.
		const coverage = cover(harness.mock, "sess-1");
		await startTurn(harness, client, "sess-1");
		harness.mock.resetMessageReads();
		// A full covered window: past the grace twice and the staleness threshold.
		await pollCycles(
			harness,
			Math.ceil((GRACE_MS * 2 + STALENESS_MS) / STATUS_POLL_MS) + 1,
		);
		coverage.stop();
		expect(harness.mock.messageReads("sess-1")).toBeLessThan(5);
		await endTurn(harness, client, "sess-1");
		await client.close();
	});

	it("Scenario 2: SSE for another session is not coverage", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		const coverage = cover(harness.mock, "sess-2");
		harness.mock.resetMessageReads();
		await polling(harness.mock, "sess-1");
		coverage.stop();
		await endTurn(harness, client, "sess-1");
		await client.close();
	});

	it("Scenario 3: no poller reads during the grace; one starts after it", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		harness.mock.resetMessageReads();
		// Two more polls: still inside the grace.
		await pollCycles(harness, 2);
		const duringGrace = harness.mock.messageReads("sess-1");
		await polling(harness.mock, "sess-1");
		expect(harness.mock.messageReads("sess-1")).toBeGreaterThan(duringGrace);
		expect(duringGrace).toBe(0);
		await endTurn(harness, client, "sess-1");
		await client.close();
	});
});

describe("Group 2: SSE dynamics", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness();
	});
	afterAll(() => harness?.stop());

	it("Scenario 5: SSE that goes quiet hands over to the poller after staleness", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		const coverage = cover(harness.mock, "sess-1");
		await coverage.twice;
		coverage.stop();
		harness.mock.resetMessageReads();
		await polling(harness.mock, "sess-1");
		await endTurn(harness, client, "sess-1");
		await client.close();
	});

	it("Scenario 6: SSE resuming lowers the polling rate", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		await polling(harness.mock, "sess-1");
		harness.mock.resetMessageReads();
		await pollCycles(harness, 6);
		const withoutSse = harness.mock.messageReads("sess-1");
		expect(withoutSse).toBeGreaterThan(0);

		const coverage = cover(harness.mock, "sess-1");
		await coverage.twice;
		await pollCycles(harness, 2);
		harness.mock.resetMessageReads();
		await pollCycles(harness, 6);
		const withSse = harness.mock.messageReads("sess-1");
		coverage.stop();
		expect(withSse).toBeLessThan(withoutSse);
		await endTurn(harness, client, "sess-1");
		await client.close();
	});
});

describe("Group 3: Idle transitions", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness();
	});
	afterAll(() => harness?.stop());

	it("Scenario 7: a turn ending inside the grace started no poller", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		harness.mock.resetMessageReads();
		await endTurn(harness, client, "sess-1");
		expect(harness.mock.messageReads("sess-1")).toBeLessThan(3);
		await client.close();
	});

	it("Scenario 8: a turn ending under SSE cover started no poller", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		harness.mock.resetMessageReads();
		const coverage = cover(harness.mock, "sess-1");
		await coverage.twice;
		await pollCycles(harness, 4);
		coverage.stop();
		await endTurn(harness, client, "sess-1");
		expect(harness.mock.messageReads("sess-1")).toBeLessThan(3);
		await client.close();
	});

	it("Scenario 9: a turn ending while polling stops the poller", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		await polling(harness.mock, "sess-1");
		await endTurn(harness, client, "sess-1");
		// Let the one-off history recheck after the turn end land first.
		await pollCycles(harness, 4);
		harness.mock.resetMessageReads();
		// A quiet window of three message-poll intervals.
		await pollCycles(
			harness,
			Math.ceil((MESSAGE_POLL_MS * 3) / STATUS_POLL_MS) + 1,
		);
		expect(harness.mock.messageReads("sess-1")).toBe(0);
		await client.close();
	});
});

describe("Group 4: Cross-session", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness([
			{ id: "sess-1", title: "Session 1" },
			{ id: "sess-2", title: "Session 2" },
		]);
	});
	afterAll(() => harness?.stop());

	it("Scenario 10: one session polls while the other is SSE-covered", async () => {
		const client = await connectAndView(harness, "sess-1");
		const coverage = cover(harness.mock, "sess-2");
		await startTurn(harness, client, "sess-1");
		await startTurn(harness, client, "sess-2");
		harness.mock.resetMessageReads();
		await polling(harness.mock, "sess-1");
		await pollCycles(harness, 6);
		coverage.stop();
		const polled = harness.mock.messageReads("sess-1");
		expect(harness.mock.messageReads("sess-2")).toBeLessThan(polled);
		await endTurn(harness, client, "sess-1");
		await endTurn(harness, client, "sess-2");
		await client.close();
	});
});

describe("Group 5: Notifications", () => {
	const alertsOf = (client: TestWsClient) =>
		client.getReceivedOfType("alerts").filter((m) => m["_tag"] === "alert");
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness([
			{ id: "sess-1", title: "Session 1" },
			{ id: "sess-2", title: "Session 2 (subagent)", parentID: "sess-1" },
		]);
	});
	afterAll(() => harness?.stop());

	it("Scenario 12: an unviewed subagent's turn end alerts no one", async () => {
		// A send moves the client's one session view, so the subagent's sender
		// leaves; the parent's viewer is the only tab.
		const sender = await connectAndView(harness, "sess-2");
		await startTurn(harness, sender, "sess-2");
		await sender.close();
		const client = await connectAndView(harness, "sess-1");
		harness.mock.inject("session.status", {
			sessionID: "sess-2",
			status: { type: "idle" },
		});
		// The parent's family shows the subagent's turn end; then the status poll sees it.
		await client.waitForTurnEnd("sess-2");
		await pollCycles(harness, 4);
		expect(alertsOf(client)).toEqual([]);
		await client.close();
	});

	it("Scenario 13: an unviewed session's turn end alerts another tab", async () => {
		const sender = await connectAndView(harness, "sess-1");
		await startTurn(harness, sender, "sess-1");
		await sender.close();
		const client = await connectAndView(harness, "sess-2");
		harness.mock.inject("session.status", {
			sessionID: "sess-1",
			status: { type: "idle" },
		});
		const alert = await client.waitFor("alerts", {
			predicate: (m) => m["_tag"] === "alert" && m["kind"] === "done",
		});
		expect(alert).toMatchObject({ sessionId: "sess-1" });
		expect(alert["alertId"]).toEqual(expect.any(String));
		await client.close();
	});

	it("Scenario 14: a viewed session's turn end alerts no one", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		await endTurn(harness, client, "sess-1");
		await pollCycles(harness, 4);
		expect(alertsOf(client)).toEqual([]);
		await client.close();
	});
});

describe("Group 6: Retry status and cycling", () => {
	let harness: Harness;
	beforeAll(async () => {
		harness = await createHarness();
	});
	afterAll(() => harness?.stop());

	it("Scenario 16: a retry status keeps the turn busy", async () => {
		const client = await connectAndView(harness, "sess-1");
		await startTurn(harness, client, "sess-1");
		harness.mock.inject("session.status", {
			sessionID: "sess-1",
			status: {
				type: "retry",
				attempt: 1,
				message: "rate limited",
				next: Date.now() + 5000,
			},
		});
		await pollCycles(harness, 4);
		expect(await statusOf(harness, "sess-1")).toBe("busy");
		await endTurn(harness, client, "sess-1");
		await client.close();
	});

	it("Scenario 17: back-to-back turns each start and end", async () => {
		const client = await connectAndView(harness, "sess-1");
		for (let turn = 0; turn < 2; turn++) {
			await startTurn(harness, client, "sess-1");
			await endTurn(harness, client, "sess-1");
		}
		await client.close();
	});

	it("Scenario 18: idle poll ticks push no family rows", async () => {
		const client = await connectAndView(harness, "sess-1");
		await pollCycles(harness, 6);
		expect(client.getReceivedOfType("family")).toEqual([]);
		await client.close();
	});
});
