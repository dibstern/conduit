// ─── QuestionBridge unit tests ───────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
	type PendingQuestion,
	QuestionBridge,
} from "../../../src/lib/bridges/question-bridge.js";

function makeQuestion(
	requestId: string,
	sessionId: string,
	overrides?: Partial<PendingQuestion>,
): PendingQuestion {
	return {
		requestId,
		sessionId,
		questions: [{ question: "Pick one", header: "Choose" }],
		timestamp: Date.now(),
		...overrides,
	};
}

describe("QuestionBridge", () => {
	it("getPending returns empty array initially", () => {
		const bridge = new QuestionBridge();
		expect(bridge.getPending()).toEqual([]);
		expect(bridge.size).toBe(0);
	});

	it("tracks and retrieves pending questions", () => {
		const bridge = new QuestionBridge();
		const q1 = makeQuestion("q1", "ses_A");
		const q2 = makeQuestion("q2", "ses_A");

		bridge.trackPending(q1);
		bridge.trackPending(q2);

		expect(bridge.getPending()).toHaveLength(2);
		expect(bridge.size).toBe(2);
		expect(bridge.getPending()).toContainEqual(q1);
		expect(bridge.getPending()).toContainEqual(q2);
	});

	it("removes question on resolution and returns true", () => {
		const bridge = new QuestionBridge();
		bridge.trackPending(makeQuestion("q1", "ses_A"));
		bridge.trackPending(makeQuestion("q2", "ses_A"));

		const result = bridge.onResolved("q1");

		expect(result).toBe(true);
		expect(bridge.getPending()).toHaveLength(1);
		expect(bridge.getPending()[0]?.requestId).toBe("q2");
		expect(bridge.size).toBe(1);
	});

	it("returns false when resolving an unknown request", () => {
		const bridge = new QuestionBridge();
		bridge.trackPending(makeQuestion("q1", "ses_A"));

		expect(bridge.onResolved("nonexistent")).toBe(false);
		expect(bridge.getPending()).toHaveLength(1);
	});

	it("returns false when resolving an already-resolved request", () => {
		const bridge = new QuestionBridge();
		bridge.trackPending(makeQuestion("q1", "ses_A"));

		expect(bridge.onResolved("q1")).toBe(true);
		expect(bridge.onResolved("q1")).toBe(false);
	});

	it("filters by session (multiple sessions)", () => {
		const bridge = new QuestionBridge();
		bridge.trackPending(makeQuestion("q1", "ses_A"));
		bridge.trackPending(makeQuestion("q2", "ses_B"));
		bridge.trackPending(makeQuestion("q3", "ses_A"));
		bridge.trackPending(makeQuestion("q4", "ses_C"));

		const all = bridge.getPending();
		expect(all).toHaveLength(4);

		// Filter by session — mirrors what sendSessionMetadata does
		const sesA = all.filter((q) => q.sessionId === "ses_A");
		const sesB = all.filter((q) => q.sessionId === "ses_B");
		const sesC = all.filter((q) => q.sessionId === "ses_C");

		expect(sesA).toHaveLength(2);
		expect(sesA.map((q) => q.requestId)).toEqual(["q1", "q3"]);

		expect(sesB).toHaveLength(1);
		expect(sesB[0]?.requestId).toBe("q2");

		expect(sesC).toHaveLength(1);
		expect(sesC[0]?.requestId).toBe("q4");
	});

	it("overwrites existing entry when trackPending is called with same requestId", () => {
		const bridge = new QuestionBridge();
		const original = makeQuestion("q1", "ses_A", {
			questions: [{ question: "Original?" }],
		});
		const updated = makeQuestion("q1", "ses_A", {
			questions: [{ question: "Updated?" }],
		});

		bridge.trackPending(original);
		bridge.trackPending(updated);

		expect(bridge.getPending()).toHaveLength(1);
		expect(bridge.getPending()[0]?.questions[0]?.question).toBe("Updated?");
	});

	it("preserves toolCallId in tracked entries", () => {
		const bridge = new QuestionBridge();
		const q = makeQuestion("q1", "ses_A", { toolCallId: "toolu_abc" });

		bridge.trackPending(q);

		expect(bridge.getPending()[0]?.toolCallId).toBe("toolu_abc");
	});

	it("preserves question options and multiSelect in tracked entries", () => {
		const bridge = new QuestionBridge();
		const q = makeQuestion("q1", "ses_A", {
			questions: [
				{
					question: "Pick many",
					header: "Multi",
					options: [{ label: "A" }, { label: "B" }] as unknown[],
					multiSelect: true,
				},
			],
		});

		bridge.trackPending(q);

		const pending = bridge.getPending()[0];
		expect(pending?.questions[0]?.multiSelect).toBe(true);
		expect(pending?.questions[0]?.options).toHaveLength(2);
	});
});
