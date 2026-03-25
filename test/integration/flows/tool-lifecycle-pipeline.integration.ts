// ─── Integration: Tool Lifecycle Through Pipeline ────────────────────────────
// Verifies that tool SSE events (pending → running → completed) flow through
// the relay pipeline and arrive at WebSocket clients in the correct order.
// Also covers the history + SSE overlap scenario.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

	it("delivers tool_start, tool_executing, tool_result in order", async () => {
		const client = await harness.connectWsClient();
		const switchMsg = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionId = switchMsg["id"] as string;
		expect(sessionId).toBeTruthy();

		await client.waitForInitialState();
		client.clearReceived();

		// Inject SSE pending event — translator sees new part → emits tool_start
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

		const toolStart = await client.waitFor("tool_start", { timeout: 5_000 });
		expect(toolStart["id"]).toBe("toolu_lifecycle1");
		expect(toolStart["name"]).toBe("Bash");

		// Inject SSE running event → tool_executing
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

		const toolExec = await client.waitFor("tool_executing", {
			timeout: 5_000,
		});
		expect(toolExec["id"]).toBe("toolu_lifecycle1");

		// Inject SSE completed event → tool_result
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

		const toolResult = await client.waitFor("tool_result", {
			timeout: 5_000,
		});
		expect(toolResult["id"]).toBe("toolu_lifecycle1");
		expect(toolResult["content"]).toBe("file1.txt\nfile2.txt");
		expect(toolResult["is_error"]).toBe(false);

		// Verify ordering: tool_start before tool_executing before tool_result
		const all = client.getReceived();
		const startIdx = all.findIndex(
			(m) => m.type === "tool_start" && m["id"] === "toolu_lifecycle1",
		);
		const execIdx = all.findIndex(
			(m) => m.type === "tool_executing" && m["id"] === "toolu_lifecycle1",
		);
		const resultIdx = all.findIndex(
			(m) => m.type === "tool_result" && m["id"] === "toolu_lifecycle1",
		);
		expect(startIdx).toBeGreaterThanOrEqual(0);
		expect(execIdx).toBeGreaterThan(startIdx);
		expect(resultIdx).toBeGreaterThan(execIdx);

		await client.close();
	}, 15_000);

	it("handles history+SSE overlap without errors", async () => {
		const client = await harness.connectWsClient();
		const switchMsg = await client.waitFor("session_switched", {
			timeout: 5_000,
		});
		const sessionId = switchMsg["id"] as string;
		expect(sessionId).toBeTruthy();

		await client.waitForInitialState();
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
		await client.waitFor("tool_start", {
			timeout: 5_000,
			predicate: (m) => m["id"] === "toolu_overlap1",
		});

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
		await client.waitFor("tool_executing", {
			timeout: 5_000,
			predicate: (m) => m["id"] === "toolu_overlap1",
		});

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
		const result = await client.waitFor("tool_result", {
			timeout: 5_000,
			predicate: (m) => m["id"] === "toolu_overlap1",
		});
		expect(result["id"]).toBe("toolu_overlap1");

		// Now inject STALE SSE events for the same tool (overlap scenario)
		// The translator's seenParts already has this partID — so a "running"
		// event for an already-seen partID is not "new", meaning it emits
		// tool_executing (not tool_start+tool_executing). This exercises the
		// pipeline's ability to handle stale/replayed events gracefully.
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

		// The stale running event will produce a tool_executing since the
		// translator is intentionally stateless about transition validity.
		// The frontend's ToolRegistry handles the overlap gracefully
		// (completed→running is silently rejected). We verify the relay
		// doesn't crash and still delivers events.
		await new Promise((r) => setTimeout(r, 300));

		// Verify no relay-level errors during the overlap
		const errors = client
			.getReceivedOfType("error")
			.filter(
				(e) =>
					!["insufficient_quota", "api_error", "Unknown"].includes(
						String(e["code"] ?? ""),
					),
			);
		expect(errors).toHaveLength(0);

		await client.close();
	}, 15_000);
});
