// ─── Regression: History Rendering of Multi-Part Messages ────────────────────
// Reproduces: after switching back to a session, the assistant message content
// is EMPTY — the HistoryView renders parts[0]?.text, but the first part of
// an OpenCode assistant message is typically NOT the text response.
//
// OpenCode assistant messages have multiple part types:
//   [step_start, reasoning, text, tool, text, step_finish, ...]
//
// The FIX: getAssistantText() finds all "text" type parts and concatenates them.

import { describe, expect, it } from "vitest";
import {
	getAssistantText,
	groupIntoTurns,
	type HistoryMessage,
} from "../../../src/lib/frontend/utils/history-logic.js";
import type { PartType } from "../../../src/lib/shared-types.js";

// ─── Realistic OpenCode message fixtures ────────────────────────────────────

/** User message — always has a single text part */
function userMsg(id: string, text: string): HistoryMessage {
	return {
		id,
		role: "user",
		parts: [{ id: `${id}-p1`, type: "text", text }],
	};
}

/** Assistant message matching OpenCode's actual REST API response format.
 *  Parts are ordered as they appear in OpenCode: reasoning first, then text.
 */
function assistantMsg(
	id: string,
	parts: Array<{ id: string; type: PartType; text?: string }>,
): HistoryMessage {
	return { id, role: "assistant", parts };
}

// ─── Tests: the OLD parts[0]?.text approach ─────────────────────────────────

describe("Regression: HistoryView rendering of multi-part assistant messages", () => {
	it("parts[0]?.text is EMPTY when first part has no text field", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "Tell me about pi"),
			assistantMsg("m2", [
				{ id: "p1", type: "step-start" }, // No text field!
				{
					id: "p2",
					type: "reasoning",
					text: "Let me think about pi...",
				},
				{
					id: "p3",
					type: "text",
					text: "Pi is approximately 3.14159...",
				},
				{ id: "p4", type: "step-finish" }, // No text field!
			]),
		];

		const turns = groupIntoTurns(messages);
		expect(turns).toHaveLength(1);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const turn = turns[0]!;

		// User message renders correctly (parts[0] IS text type)
		const userText = turn.user?.parts?.[0]?.text ?? "";
		expect(userText).toBe("Tell me about pi");

		// OLD BEHAVIOR (BUG): parts[0]?.text is undefined for step_start
		const oldRendering = turn.assistant?.parts?.[0]?.text ?? "";
		expect(oldRendering).toBe(""); // BUG: empty

		// FIX: getAssistantText finds text-type parts
		expect(getAssistantText(turn.assistant)).toBe(
			"Pi is approximately 3.14159...",
		);
	});

	it("parts[0]?.text shows thinking content instead of response", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "What is TypeScript?"),
			assistantMsg("m2", [
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
			]),
		];

		const turns = groupIntoTurns(messages);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const turn = turns[0]!;

		// OLD BEHAVIOR (BUG): shows thinking text
		const oldRendering = turn.assistant?.parts?.[0]?.text ?? "";
		expect(oldRendering).toBe("The user wants to know about TypeScript...");

		// FIX: getAssistantText shows only text-type parts
		expect(getAssistantText(turn.assistant)).toBe(
			"TypeScript is a typed superset of JavaScript.",
		);
	});

	it("tool-heavy response has no text at parts[0]", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "Read foo.ts"),
			assistantMsg("m2", [
				{
					id: "p1",
					type: "reasoning",
					text: "I need to read that file...",
				},
				{ id: "p2", type: "tool" },
				{
					id: "p3",
					type: "text",
					text: "Here is the contents of foo.ts.",
				},
			]),
		];

		const turns = groupIntoTurns(messages);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const turn = turns[0]!;

		// FIX: getAssistantText finds the text part
		expect(getAssistantText(turn.assistant)).toBe(
			"Here is the contents of foo.ts.",
		);
	});

	it("simple response still works", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "Hello"),
			assistantMsg("m2", [
				{
					id: "p1",
					type: "text",
					text: "Hello! How can I help?",
				},
			]),
		];

		const turns = groupIntoTurns(messages);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const turn = turns[0]!;

		expect(getAssistantText(turn.assistant)).toBe("Hello! How can I help?");
	});

	it("user's exact scenario: pi digits question with reasoning", () => {
		const messages: HistoryMessage[] = [
			userMsg(
				"msg_c9986e41d0010BveYH0EyoA9YX",
				"Tell me your favourite digits from pi",
			),
			assistantMsg("msg_c9986e420001Vpdpr07GKRFt22", [
				{
					id: "p1",
					type: "reasoning",
					text: "The user wants me to share favorite digits from pi. I should note that I don't actually have preferences...",
				},
				{
					id: "p2",
					type: "text",
					text: "I don't have preferences, but I find 149 interesting - it's the digits starting at position 1, and 99999999 appears later in pi (at positions 172-179). Purely mathematically interesting, not personal favorites!",
				},
			]),
		];

		const turns = groupIntoTurns(messages);
		expect(turns).toHaveLength(1);

		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		const turn = turns[0]!;

		// User message is correct
		expect(turn.user?.parts?.[0]?.text).toBe(
			"Tell me your favourite digits from pi",
		);

		// FIX: getAssistantText shows the response, not reasoning
		expect(getAssistantText(turn.assistant)).toBe(
			"I don't have preferences, but I find 149 interesting - it's the digits starting at position 1, and 99999999 appears later in pi (at positions 172-179). Purely mathematically interesting, not personal favorites!",
		);
	});

	it("multiple text parts are concatenated (response split by tool calls)", () => {
		const messages: HistoryMessage[] = [
			userMsg("m1", "Read both files"),
			assistantMsg("m2", [
				{
					id: "p1",
					type: "text",
					text: "Let me read the first file.",
				},
				{ id: "p2", type: "tool" },
				{
					id: "p3",
					type: "text",
					text: "Now the second file.",
				},
				{ id: "p4", type: "tool" },
				{
					id: "p5",
					type: "text",
					text: "Both files have been read.",
				},
			]),
		];

		const turns = groupIntoTurns(messages);
		// biome-ignore lint/style/noNonNullAssertion: safe — guarded by length check
		expect(getAssistantText(turns[0]!.assistant)).toBe(
			"Let me read the first file.\n\nNow the second file.\n\nBoth files have been read.",
		);
	});

	it("undefined/null assistant returns empty string", () => {
		expect(getAssistantText(undefined)).toBe("");
		expect(getAssistantText({ id: "m1", role: "assistant" })).toBe("");
		expect(getAssistantText({ id: "m1", role: "assistant", parts: [] })).toBe(
			"",
		);
	});
});
