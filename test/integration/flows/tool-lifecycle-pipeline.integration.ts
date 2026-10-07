// Verifies that tool SSE events (pending → running → completed) flow through
// the relay pipeline and publish transcript states in the correct order.
// Also covers the history + SSE overlap scenario.

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
import type { HistoryMessage } from "../../../src/lib/shared-types.js";
import {
	createRelayHarness,
	type RelayHarness,
} from "../helpers/relay-harness.js";

describe("Integration: Tool lifecycle through pipeline", () => {
	let harness: RelayHarness;

	beforeAll(async () => {
		harness = await createRelayHarness();
	}, 30_000);

	afterAll(async () => {
		if (harness) await harness.stop();
	});

	beforeEach(() => {
		harness.mock.resetQueues();
	});

	it("publishes tool appearance, running, and completion in order", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		expect(sessionId).toBeTruthy();
		if (!sessionId) throw new Error("No initial session");

		client.clearReceived();

		// Wait for each projected state before injecting its successor.
		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-lifecycle-1",
					messageID: "msg-lifecycle-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_lifecycle1",
						tool: "bash",
						state: { status: "pending" },
					},
				},
			},
		]);

		const toolStart = await client.waitForToolState(
			"part-lifecycle-1",
			undefined,
			sessionId,
		);
		expect(toolStart.callID).toBe("toolu_lifecycle1");
		expect(toolStart.tool).toBe("Bash");

		// Inject the running state.
		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-lifecycle-1",
					messageID: "msg-lifecycle-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_lifecycle1",
						tool: "bash",
						state: {
							status: "running",
							input: { command: "ls" },
						},
					},
				},
			},
		]);

		const toolExec = await client.waitForToolState(
			"part-lifecycle-1",
			"running",
			sessionId,
		);
		expect(toolExec.callID).toBe("toolu_lifecycle1");

		// Inject the completed state.
		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-lifecycle-1",
					messageID: "msg-lifecycle-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_lifecycle1",
						tool: "bash",
						state: {
							status: "completed",
							output: "file1.txt\nfile2.txt",
						},
					},
				},
			},
		]);

		const toolResult = await client.waitForToolState(
			"part-lifecycle-1",
			"completed",
			sessionId,
		);
		expect(toolResult.callID).toBe("toolu_lifecycle1");
		expect(toolResult.state?.["output"]).toBe("file1.txt\nfile2.txt");
		expect(toolResult.state?.["status"]).toBe("completed");

		const all = client
			.getReceivedOfType("transcript_message")
			.filter((message) => message["sessionId"] === sessionId);
		const startIdx = all.findIndex((message) =>
			(message["parts"] as HistoryMessage["parts"])?.some(
				(part) =>
					part.id === "part-lifecycle-1" && part.state?.status === undefined,
			),
		);
		const execIdx = all.findIndex((message) =>
			(message["parts"] as HistoryMessage["parts"])?.some(
				(part) =>
					part.id === "part-lifecycle-1" && part.state?.status === "running",
			),
		);
		const resultIdx = all.findIndex((message) =>
			(message["parts"] as HistoryMessage["parts"])?.some(
				(part) =>
					part.id === "part-lifecycle-1" && part.state?.status === "completed",
			),
		);
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(execIdx).toBeGreaterThan(startIdx);
		expect(resultIdx).toBeGreaterThan(execIdx);

		await client.close();
	}, 15_000);

	it("handles history+SSE overlap without errors", async () => {
		const client = await harness.connectWsClient();
		await client.waitForInitialState();
		const sessionId = client.getActiveSessionId();
		expect(sessionId).toBeTruthy();
		if (!sessionId) throw new Error("No initial session");

		client.clearReceived();

		// Simulate a full tool lifecycle (as if from history replay via SSE)
		// pending → running → completed
		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-overlap-1",
					messageID: "msg-overlap-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_overlap1",
						tool: "read",
						state: { status: "pending" },
					},
				},
			},
		]);
		await client.waitForToolState("part-overlap-1", undefined, sessionId);

		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-overlap-1",
					messageID: "msg-overlap-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_overlap1",
						tool: "read",
						state: {
							status: "running",
							input: { path: "/tmp/test" },
						},
					},
				},
			},
		]);
		await client.waitForToolState("part-overlap-1", "running", sessionId);

		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-overlap-1",
					messageID: "msg-overlap-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_overlap1",
						tool: "read",
						state: {
							status: "completed",
							output: "file content",
						},
					},
				},
			},
		]);
		const result = await client.waitForToolState(
			"part-overlap-1",
			"completed",
			sessionId,
		);
		expect(result.callID).toBe("toolu_overlap1");

		// Now inject STALE SSE events for the same tool (overlap scenario)
		// The projection must keep the completed state when stale running arrives.
		client.clearReceived();
		harness.mock.injectSSEEvents([
			{
				type: "message.part.updated",
				properties: {
					partID: "part-overlap-1",
					messageID: "msg-overlap-1",
					sessionID: sessionId,
					part: {
						type: "tool",
						callID: "toolu_overlap1",
						tool: "read",
						state: {
							status: "running",
							input: { path: "/tmp/test" },
						},
					},
				},
			},
		]);

		const db = new Database(harness.eventsDbPath, { readonly: true });
		try {
			await vi.waitFor(() => {
				const row = db
					.prepare(
						"SELECT count(*) AS count FROM events WHERE session_id = ? AND type = 'tool.running' AND json_extract(data, '$.partId') = ?",
					)
					.get(sessionId, "part-overlap-1") as { count: number };
				expect(row.count).toBeGreaterThan(1);
			});
			const errors = db
				.prepare(
					"SELECT data FROM events WHERE session_id = ? AND type = 'turn.error' AND COALESCE(json_extract(data, '$.code'), '') NOT IN ('insufficient_quota', 'api_error', 'Unknown')",
				)
				.all(sessionId);
			expect(errors).toHaveLength(0);
		} finally {
			db.close();
		}
		const afterOverlap = await client.waitForToolState(
			"part-overlap-1",
			"completed",
			sessionId,
		);
		expect(afterOverlap.state?.["output"]).toBe("file content");

		await client.close();
	}, 15_000);
});
