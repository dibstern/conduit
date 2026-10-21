// Assistant history must show text parts after step markers, reasoning, and tools.

import { assert, describe, expect, it } from "vitest";
import {
	getAssistantText,
	groupIntoTurns,
	type HistoryMessage,
} from "../../../src/lib/frontend/utils/history-logic.js";

describe("Regression: HistoryView rendering of multi-part assistant messages", () => {
	it.each<{
		name: string;
		parts: NonNullable<HistoryMessage["parts"]>;
		expected: string;
	}>([
		{
			name: "text after step markers",
			parts: [
				{ id: "p1", type: "step-start" },
				{ id: "p2", type: "reasoning", text: "Let me think about pi..." },
				{ id: "p3", type: "text", text: "Pi is approximately 3.14159..." },
				{ id: "p4", type: "step-finish" },
			],
			expected: "Pi is approximately 3.14159...",
		},
		{
			name: "reasoning is excluded",
			parts: [
				{
					id: "p1",
					type: "reasoning",
					text: "The user wants to know about TypeScript...",
				},
				{
					id: "p2",
					type: "text",
					text: "TypeScript is a typed superset of JavaScript.",
				},
			],
			expected: "TypeScript is a typed superset of JavaScript.",
		},
		{
			name: "text after tool calls",
			parts: [
				{ id: "p1", type: "reasoning", text: "I need to read that file..." },
				{ id: "p2", type: "tool" },
				{ id: "p3", type: "text", text: "Here is the contents of foo.ts." },
			],
			expected: "Here is the contents of foo.ts.",
		},
		{
			name: "simple response",
			parts: [{ id: "p1", type: "text", text: "Hello! How can I help?" }],
			expected: "Hello! How can I help?",
		},
		{
			name: "text parts separated by tools are concatenated",
			parts: [
				{ id: "p1", type: "text", text: "Let me read the first file." },
				{ id: "p2", type: "tool" },
				{ id: "p3", type: "text", text: "Now the second file." },
				{ id: "p4", type: "tool" },
				{ id: "p5", type: "text", text: "Both files have been read." },
			],
			expected:
				"Let me read the first file.\n\nNow the second file.\n\nBoth files have been read.",
		},
	])("$name", ({ parts, expected }) => {
		const turns = groupIntoTurns([
			{
				id: "m1",
				role: "user",
				parts: [{ id: "m1-p1", type: "text", text: "Tell me about pi" }],
			},
			{ id: "m2", role: "assistant", parts },
		]);
		expect(turns).toHaveLength(1);
		const turn = turns[0];
		assert.exists(turn, "expected first turn");
		expect(turn.user?.parts?.[0]?.text).toBe("Tell me about pi");
		expect(getAssistantText(turn.assistant)).toBe(expected);
	});

	it("undefined/null assistant returns empty string", () => {
		expect(getAssistantText(undefined)).toBe("");
		expect(getAssistantText({ id: "m1", role: "assistant" })).toBe("");
		expect(getAssistantText({ id: "m1", role: "assistant", parts: [] })).toBe(
			"",
		);
	});
});
