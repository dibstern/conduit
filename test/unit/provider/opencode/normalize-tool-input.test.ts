import { describe, expect, it } from "vitest";
import { normalizeToolInput } from "../../../../src/lib/provider/opencode/normalize-tool-input.js";

describe("OpenCode normalizeToolInput", () => {
	it("passes through camelCase Read input", () => {
		const result = normalizeToolInput("Read", {
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result).toEqual({
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
	});

	it("normalizes Bash", () => {
		const result = normalizeToolInput("Bash", {
			command: "ls",
			description: "list",
		});
		expect(result).toEqual({
			tool: "Bash",
			command: "ls",
			description: "list",
		});
	});

	it("normalizes WebSearch with url → hostname-based query fallback", () => {
		const result = normalizeToolInput("WebSearch", {
			url: "https://docs.example.com/search?q=test",
		});
		expect(result).toEqual({
			tool: "WebSearch",
			query: "docs.example.com",
		});
	});

	it("normalizes WebSearch with query (passthrough)", () => {
		const result = normalizeToolInput("WebSearch", {
			query: "typescript generics",
		});
		expect(result).toEqual({ tool: "WebSearch", query: "typescript generics" });
	});

	it("collapses unknown tool to Unknown variant", () => {
		const result = normalizeToolInput("CustomTool", { x: 1 });
		expect(result).toEqual({
			tool: "Unknown",
			name: "CustomTool",
			raw: { x: 1 },
		});
	});

	it("handles null input", () => {
		const result = normalizeToolInput("Read", null);
		// null coerces to {} via toRecord — known tool name still produces typed shape
		expect(result).toEqual({ tool: "Read", filePath: "" });
	});
});
