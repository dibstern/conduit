import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { historyToChatMessages } from "../../../src/lib/frontend/utils/history-logic.js";
import { segmentTurns } from "../../../src/lib/frontend/utils/turns.js";
import { messageRowsToHistory } from "../../../src/lib/persistence/session-history-adapter.js";
import {
	type EffectProjectionHarness,
	makeEffectProjectionHarness,
} from "../../helpers/effect-projection-harness.js";
import { makeStored } from "../../helpers/persistence-factories.js";

const SESSION_ID = "ses-mid-turn-compaction";
const NOW = 1_000_000_000_000;

// An auto-compaction lands in the middle of a long assistant message. On
// reload the turn must still read as one piece of work with the compaction
// inside it, not as a finished turn followed by a compaction-only segment.
describe("mid-turn compaction on reload", () => {
	let harness: EffectProjectionHarness;
	let seq = 0;

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

	const at = (offset: number) => ({ sequence: ++seq, createdAt: NOW + offset });

	const tool = async (partId: string, offset: number) => {
		await harness.reproject([
			makeStored(
				"tool.started",
				SESSION_ID,
				{
					messageId: "msg-asst",
					partId,
					toolName: "Bash",
					callId: partId,
					input: { tool: "Bash", command: "true" },
				},
				at(offset),
			),
		]);
		await harness.reproject([
			makeStored(
				"tool.completed",
				SESSION_ID,
				{ messageId: "msg-asst", partId, result: "ok", duration: 1 },
				at(offset + 1),
			),
		]);
	};

	it("keeps the compaction inside the segment the result closes", async () => {
		await harness.reproject([
			makeStored(
				"message.created",
				SESSION_ID,
				{ messageId: "msg-user", role: "user", sessionId: SESSION_ID },
				at(0),
			),
		]);
		await harness.reproject([
			makeStored(
				"message.created",
				SESSION_ID,
				{ messageId: "msg-asst", role: "assistant", sessionId: SESSION_ID },
				at(100),
			),
		]);
		await tool("tool-before", 200);
		await harness.reproject([
			makeStored(
				"session.compaction",
				SESSION_ID,
				{
					sessionId: SESSION_ID,
					state: "completed",
					detail: "Context compacted (auto) · 149k → 24k",
					preTokens: 148_663,
					postTokens: 23_683,
				},
				at(300),
			),
		]);
		await tool("tool-after", 400);
		await harness.reproject([
			makeStored(
				"turn.completed",
				SESSION_ID,
				{
					messageId: "msg-asst",
					cost: 0.01,
					duration: 500,
					tokens: { input: 2, output: 6 },
				},
				at(500),
			),
		]);

		const rows = await harness.sessionMessagesWithParts(SESSION_ID);
		const { messages } = messageRowsToHistory(rows, { pageSize: 50 });
		const turns = segmentTurns(historyToChatMessages(messages), false);

		expect(turns).toHaveLength(1);
		const segments = turns[0]?.segments ?? [];
		expect(
			segments.map((segment) => ({
				activity: segment.activity.map((part) =>
					part.type === "tool" ? part.id : part.type,
				),
				end: segment.end?.type,
			})),
		).toEqual([
			{ activity: ["tool-before", "system", "tool-after"], end: "result" },
		]);
	});
});
