import { describe, expect, it } from "vitest";
import { getSwipeStage } from "../../../src/lib/frontend/utils/swipe.js";

describe("swipe thresholds", () => {
	it("uses the row width in either direction", () => {
		for (const direction of [-1, 1]) {
			expect(getSwipeStage(direction * 49, 200)).toBe("none");
			expect(getSwipeStage(direction * 50, 200)).toBe("reveal");
			expect(getSwipeStage(direction * 109, 200)).toBe("reveal");
			expect(getSwipeStage(direction * 110, 200)).toBe("commit");
		}
	});
});
