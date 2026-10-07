// Verifies that SSE events from OpenCode flow through the relay and arrive at
// RPC clients. Sends prompts and observes the full event pipeline:
// SSE -> persisted projections -> SubscribeSessionDetail and SubscribeShell.

import Database from "better-sqlite3";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { TurnErrorPayload } from "../../../src/lib/contracts/stored-event.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: SSE to RPC Pipeline", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(async () => {
		harness.mock.resetQueues();
		await harness.stack.client.app.path();
		await vi.waitFor(() => {
			expect(harness.stack.sseStream.getHealth().connected).toBe(true);
		});
	});

	it("SSE stream is running after relay startup", async () => {
		// The SSE stream connect() is fire-and-forget, so isConnected() may
		// not be true immediately. But it should be running (this.running=true).
		// The best proof is that SSE events actually flow — tested below.
		// Here we just verify the stream was started successfully.
		const consumer = harness.stack.sseStream;
		// The stream object exists and was wired up
		expect(consumer).toBeTruthy();

		await vi.waitFor(() => {
			expect(consumer.getHealth().connected).toBe(true);
		});
	});

	it("sending a prompt starts a turn that completes", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		await client.subscribeShell();
		client.clearReceived();

		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// The session's shell row shows the turn started
		await client.waitForTurnStart(undefined, 10_000);

		const done = await client.waitForTurnEnd(undefined, 10_000);
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");

		await client.close();
	}, 30_000);

	it("successive text deltas grow the subscribed transcript", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		const sessionId = client.getActiveSessionId();
		if (!sessionId) throw new Error("No initial session");
		let text = "";
		for (const delta of ["po", "ng"]) {
			harness.mock.injectSSEEvents([
				{
					type: "message.part.delta",
					properties: {
						sessionID: sessionId,
						messageID: "msg-incremental-rpc",
						partID: "part-incremental-rpc",
						field: "text",
						delta,
					},
				},
			]);
			text += delta;
			const message = await client.waitForTranscriptMessage(
				(message) =>
					message.id === "msg-incremental-rpc" && message.text === text,
				sessionId,
			);
			expect(message.text).toBe(text);
		}

		await client.close();
	}, 30_000);

	it("persists text before turn completion and exposes both through RPC", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		await client.waitForAssistantText();
		const done = await client.waitForTurnEnd(undefined, 10_000);
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const events = db
				.prepare(
					"SELECT type, sequence FROM events WHERE session_id = ? AND type IN ('text.delta', 'turn.completed') ORDER BY sequence",
				)
				.all(done.id) as Array<{ type: string; sequence: number }>;
			const delta = events.find((event) => event.type === "text.delta");
			const completed = events.find((event) => event.type === "turn.completed");
			expect(delta).toBeDefined();
			expect(completed).toBeDefined();
			expect(completed?.sequence).toBeGreaterThan(delta?.sequence ?? 0);
		} finally {
			db.close();
		}

		await client.close();
	}, 30_000);

	it("multiple clients receive the same SSE-sourced transcript", async () => {
		const client1 = await harness.connectWsClient();
		const client2 = await harness.connectWsClient();
		await client1.waitForInitialState();
		await client2.waitForInitialState();
		const sessionId = client1.getActiveSessionId();
		if (!sessionId) throw new Error("No initial session");
		await client2.viewSession(sessionId);
		client1.clearReceived();
		client2.clearReceived();

		// Send prompt from client1
		await client1.sendMessage("Reply with just the word 'pong'. Nothing else.");

		const [message1, message2] = await Promise.all([
			client1.waitForAssistantText(sessionId, 10_000),
			client2.waitForAssistantText(sessionId, 10_000),
		]);
		expect(message1.text).toBeTruthy();
		expect(message2.text).toBeTruthy();

		await Promise.all([
			client1.waitForTurnEnd(sessionId, 10_000),
			client2.waitForTurnEnd(sessionId, 10_000),
		]);
		const [history1, history2] = await Promise.all([
			client1.loadMoreHistory(sessionId),
			client2.loadMoreHistory(sessionId),
		]);
		expect(history2.messages).toEqual(history1.messages);

		await client1.close();
		await client2.close();
	}, 30_000);

	it("turn completion arrives with no errors", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		client.clearReceived();

		await client.sendMessage("Reply with just the word 'pong'. Nothing else.");

		// Wait for a new terminal shell version.
		const done = await client.waitForTurnEnd(undefined, 10_000);
		expect(done.status).toBe("idle");
		expect(done.attention).not.toBe("error");

		// Verify no relay-level errors occurred during the pipeline
		// (filter out SSE-sourced session.error events from previous tests)
		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			const errors = db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error'",
				)
				.all(done.id) as Array<{ data: string }>;
			const pipelineErrors = errors
				.map((event) => JSON.parse(event.data) as TurnErrorPayload)
				.filter(
					(error) =>
						!["insufficient_quota", "api_error", "Unknown"].includes(
							error.code ?? "",
						),
				);
			expect(pipelineErrors).toHaveLength(0);
		} finally {
			db.close();
		}

		await client.close();
	}, 30_000);
});
