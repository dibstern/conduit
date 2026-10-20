import { describe, expect, it } from "vitest";
import { numberTurnMessages } from "../../src/lib/turn-message-numbers.js";

// Failure modes: mixed old/new messages collide, sparse persisted citations
// change their destination, or a later annotation renumbers an earlier message.
describe("turn message numbers", () => {
	it("numbers unclassified messages while reserving persisted numbers", () => {
		expect(
			numberTurnMessages([
				{ id: "a" },
				{ id: "b", surfacingOrdinal: 1 },
				{ id: "c", surfacingOrdinal: 6 },
				{ id: "d" },
			]),
		).toEqual([
			{ id: "a", surfacingOrdinal: 2 },
			{ id: "b", surfacingOrdinal: 1 },
			{ id: "c", surfacingOrdinal: 6 },
			{ id: "d", surfacingOrdinal: 7 },
		]);
	});
});
