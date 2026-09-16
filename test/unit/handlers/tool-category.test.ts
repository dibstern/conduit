// ─── Tool Category — Unit Tests ───────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import { getToolCategory } from "../../../src/lib/frontend/utils/tool-category.js";

describe("getToolCategory", () => {
	it.each([
		["Read", "explore"],
		["Glob", "explore"],
		["Grep", "explore"],
		["LSP", "explore"],
		["Skill", "explore"],
		["Edit", "edit"],
		["Write", "edit"],
		["Bash", "shell"],
		["WebFetch", "fetch"],
		["WebSearch", "fetch"],
		["Task", "task"],
	])("maps %s to %s", (name, category) => {
		expect(getToolCategory(name)).toBe(category);
	});

	it("maps unknown tool names to other", () => {
		expect(getToolCategory("SomethingNew")).toBe("other");
	});
});
