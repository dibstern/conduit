import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThinkingMessage } from "../../../src/lib/frontend/types.js";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-perm-think";
const MSG_ID = "msg-perm-think";
const NOW = 1_000_000_000_000;

describe("Permission + thinking interleaving pipeline", () => {
	let harness: EffectProjectionHarness;
	let seq: number;

	beforeEach(async () => {
		harness = makeEffectProjectionHarness();
		seq = 0;
		await harness.query(
			"INSERT INTO sessions (id, provider, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
			[SESSION_ID, "claude", "Test", "idle", NOW, NOW],
		);
	});

	afterEach(async () => {
		await harness?.dispose();
	});

	async function project(event: ReturnType<typeof makeStored>): Promise<void> {
		await harness.reproject([event]);
	}

	function nextSeq(): number {
		return ++seq;
	}

	async function readPipeline() {
		const rows = await harness.sessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		return historyToChatMessages(messages);
	}

	it("thinking → tool(permission) → text — thinking text preserved across permission boundary", async () => {
		await project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: MSG_ID,
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		// Thinking block
		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-pre-perm" },
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);

		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "think-pre-perm",
					text: "I need to run a command to check this...",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);

		await project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-pre-perm" },
				{ sequence: nextSeq(), createdAt: NOW + 300 },
			),
		);

		// Tool use (triggers permission in real flow)
		await project(
			makeStored(
				"tool.started",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "tool-bash",
					toolName: "bash",
					callId: "call-1",
					input: { command: "ls -la" },
				},
				{ sequence: nextSeq(), createdAt: NOW + 400 },
			),
		);

		await project(
			makeStored(
				"tool.completed",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "tool-bash",
					result: "file1.ts\nfile2.ts",
					duration: 50,
				},
				{ sequence: nextSeq(), createdAt: NOW + 500 },
			),
		);

		// Post-tool text
		await project(
			makeStored(
				"text.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "text-post-perm",
					text: "Based on the directory listing...",
				},
				{ sequence: nextSeq(), createdAt: NOW + 600 },
			),
		);

		await project(
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: MSG_ID,
					cost: 0.02,
					duration: 1000,
					tokens: { input: 200, output: 100 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 700 },
			),
		);

		const chat = await readPipeline();

		// Thinking block preserved
		const thinking = chat.find(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinking).toBeDefined();
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.text).toBe("I need to run a command to check this...");
		// biome-ignore lint/style/noNonNullAssertion: asserted above
		expect(thinking!.done).toBe(true);

		// Tool message present
		expect(chat.some((m) => m.type === "tool")).toBe(true);

		// Assistant text present
		const assistant = chat.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();

		// Order: thinking → tool → assistant
		const types = chat
			.filter((m) => ["thinking", "tool", "assistant"].includes(m.type))
			.map((m) => m.type);
		expect(types).toEqual(["thinking", "tool", "assistant"]);
	});

	it("thinking → tool → thinking → text — double thinking across tool boundary", async () => {
		await project(
			makeStored(
				"message.created",
				SESSION_ID,
				{
					messageId: MSG_ID,
					role: "assistant",
					sessionId: SESSION_ID,
				},
				{ sequence: nextSeq(), createdAt: NOW },
			),
		);

		// First thinking
		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-1" },
				{ sequence: nextSeq(), createdAt: NOW + 100 },
			),
		);
		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "think-1",
					text: "pre-tool thought",
				},
				{ sequence: nextSeq(), createdAt: NOW + 200 },
			),
		);
		await project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-1" },
				{ sequence: nextSeq(), createdAt: NOW + 300 },
			),
		);

		// Tool
		await project(
			makeStored(
				"tool.started",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "tool-1",
					toolName: "read",
					callId: "call-2",
					input: { path: "/tmp/test" },
				},
				{ sequence: nextSeq(), createdAt: NOW + 400 },
			),
		);
		await project(
			makeStored(
				"tool.completed",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "tool-1",
					result: "file contents",
					duration: 30,
				},
				{ sequence: nextSeq(), createdAt: NOW + 500 },
			),
		);

		// Second thinking (post-tool)
		await project(
			makeStored(
				"thinking.start",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-2" },
				{ sequence: nextSeq(), createdAt: NOW + 600 },
			),
		);
		await project(
			makeStored(
				"thinking.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "think-2",
					text: "post-tool thought",
				},
				{ sequence: nextSeq(), createdAt: NOW + 700 },
			),
		);
		await project(
			makeStored(
				"thinking.end",
				SESSION_ID,
				{ messageId: MSG_ID, partId: "think-2" },
				{ sequence: nextSeq(), createdAt: NOW + 800 },
			),
		);

		// Final text
		await project(
			makeStored(
				"text.delta",
				SESSION_ID,
				{
					messageId: MSG_ID,
					partId: "text-final",
					text: "final answer",
				},
				{ sequence: nextSeq(), createdAt: NOW + 900 },
			),
		);

		await project(
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: MSG_ID,
					cost: 0,
					duration: 0,
					tokens: { input: 0, output: 0 },
				},
				{ sequence: nextSeq(), createdAt: NOW + 1000 },
			),
		);

		const chat = await readPipeline();

		// Both thinking blocks preserved with correct text
		const thinkingBlocks = chat.filter(
			(m): m is ThinkingMessage => m.type === "thinking",
		);
		expect(thinkingBlocks).toHaveLength(2);
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[0]!.text).toBe("pre-tool thought");
		// biome-ignore lint/style/noNonNullAssertion: length checked
		expect(thinkingBlocks[1]!.text).toBe("post-tool thought");

		// Order: thinking → tool → thinking → assistant
		const types = chat
			.filter((m) => ["thinking", "tool", "assistant"].includes(m.type))
			.map((m) => m.type);
		expect(types).toEqual(["thinking", "tool", "thinking", "assistant"]);
	});
});
