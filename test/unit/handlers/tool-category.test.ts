import { describe, expect, it } from "vitest";
import { getToolCategory } from "../../../src/lib/frontend/utils/tool-category.js";

describe("getToolCategory", () => {
	it("maps unknown tool names to other", () => {
		expect(getToolCategory("SomethingNew")).toBe("other");
	});
});
