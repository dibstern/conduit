import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ProcessHarness,
	responseChunks,
} from "../../helpers/process-harness.js";

describe("foreground daemon process harness", () => {
	let harness: ProcessHarness | undefined;

	afterEach(async (context) => {
		if (!harness) return;
		try {
			await harness.dispose();
		} finally {
			mkdirSync("test-results/process-harness", { recursive: true });
			writeFileSync(
				`test-results/process-harness/${context.task.name.replace(/\W+/g, "-")}.json`,
				JSON.stringify(harness.proof(), null, 2),
			);
			harness = undefined;
		}
	});

	it("sends over browser RPC and receives each streamed response chunk", async () => {
		harness = await ProcessHarness.start({ enqueueMarkDelayMs: 250 });
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const turn = await browser.send(sessionId, "stream-proof");
		expect(turn.chunks).toEqual(responseChunks("stream-proof"));
		expect(turn.done["code"]).toBe(0);
		await vi.waitFor(
			() => {
				expect(
					harness?.marks.filter((mark) => mark.kind === "enqueue"),
				).toHaveLength(1);
			},
			{ timeout: 5000 },
		);
		expect(harness.generations[0]?.pid).not.toBe(process.pid);
		expect(harness.generations[0]?.instances).toEqual([
			{ managed: false, url: "http://127.0.0.1:0" },
		]);
		expect(harness.generations[0]?.projects).toEqual([harness.projectDir]);
	});

	it("exits locally when the parent IPC channel disappears", async () => {
		harness = await ProcessHarness.start();
		await harness.disconnectParent();
		expect(harness.generations[0]?.exitCode).toBe(0);
		expect(harness.generations[0]?.signal).toBeNull();
	});

	it.each([
		"allow",
		"deny",
	] as const)("resolves a tool approval through browser RPC with decision %s", async (decision) => {
		harness = await ProcessHarness.start();
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		const cursor = browser.frames.length;
		const pending = browser.send(sessionId, "approval-proof");
		const request = await browser.waitFor(
			(message) => message["type"] === "permission_request",
			cursor,
		);
		expect(request["toolName"]).toBe("Bash");
		expect(request["toolInput"]).toEqual({
			command: "printf harness-approved",
		});
		expect(
			browser.frames
				.slice(cursor)
				.some(({ message }) => message["type"] === "tool_result"),
		).toBe(false);
		await browser.answerApproval(request, decision);
		const turn = await pending;
		expect(turn.chunks).toEqual(responseChunks("approval-proof"));
		const resolved = await browser.waitFor(
			(message) =>
				message["type"] === "permission_resolved" &&
				message["requestId"] === request["requestId"],
			cursor,
		);
		expect(resolved["decision"]).toBe(decision === "allow" ? "once" : "reject");
		const result = await browser.waitFor(
			(message) => message["type"] === "tool_result",
			cursor,
		);
		expect(result["content"]).toBe(
			decision === "allow" ? "harness-approved" : "harness-denied",
		);
	});

	it("survives SIGKILL, reconnects on the same dirs, and reads persisted history", async () => {
		harness = await ProcessHarness.start();
		const browser = await harness.connect();
		const sessionId = await browser.createSession();
		await browser.send(sessionId, "restart-proof");
		const before = await browser.history(sessionId);
		expect(before.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(before[0]?.text).toBe("restart-proof");
		expect(before[1]?.parts?.map((part) => part.text ?? "").join("")).toBe(
			responseChunks("restart-proof").join(""),
		);
		await harness.kill();
		expect(harness.generations[0]?.signal).toBe("SIGKILL");
		await harness.restart();
		const reconnected = await harness.connect(sessionId);
		const after = await reconnected.history(sessionId);
		expect(after).toEqual(before);
		expect(harness.generations[1]?.pid).not.toBe(harness.generations[0]?.pid);
		expect(harness.generations[1]?.projects).toEqual([harness.projectDir]);
		await reconnected.send(sessionId, "after-restart-proof");
		const continued = await reconnected.history(sessionId);
		expect(continued.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(new Set(continued.map((message) => message.id)).size).toBe(4);
	});
});
