import { describe, expect, it } from "vitest";
import { extractToolSummary } from "../../../src/lib/frontend/utils/group-tools.js";

describe("extractToolSummary — CanonicalToolInput", () => {
	it("Read with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Read", {
			tool: "Read",
			filePath: "/src/main.ts",
			offset: 10,
			limit: 50,
		});
		expect(result.subtitle).toBe("/src/main.ts");
		expect(result.tags).toContain("offset:10");
		expect(result.tags).toContain("limit:50");
	});

	it("Bash with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Bash", {
			tool: "Bash",
			command: "ls -la /very/long/path/that/exceeds/forty/characters/easily",
		});
		expect(result.subtitle).toBeDefined();
		expect(result.subtitle!.length).toBeLessThanOrEqual(41); // 40 + ellipsis
	});

	it("Edit with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Edit", {
			tool: "Edit",
			filePath: "/src/main.ts",
			oldString: "a",
			newString: "b",
		});
		expect(result.subtitle).toBe("/src/main.ts");
	});

	it("Grep with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Grep", {
			tool: "Grep",
			pattern: "TODO",
			path: "/src",
			include: "*.ts",
			fileType: "ts",
		});
		expect(result.subtitle).toBe("TODO");
		expect(result.tags).toContain("*.ts");
		expect(result.tags).toContain("ts");
	});

	it("WebFetch with CanonicalToolInput shape", () => {
		const result = extractToolSummary("WebFetch", {
			tool: "WebFetch",
			url: "https://docs.example.com/page",
		});
		expect(result.subtitle).toBe("docs.example.com");
	});

	it("Task with CanonicalToolInput shape", () => {
		const result = extractToolSummary("Task", {
			tool: "Task",
			description: "find bugs",
			prompt: "look",
			subagentType: "review",
		});
		expect(result.subtitle).toBe("find bugs");
		expect(result.tags).toContain("review");
	});

	it("still works with legacy raw input (backwards compat)", () => {
		const result = extractToolSummary("Read", {
			filePath: "/src/legacy.ts",
		});
		expect(result.subtitle).toBe("/src/legacy.ts");
	});

	it("still works with legacy snake_case input (backwards compat)", () => {
		const result = extractToolSummary("Read", {
			file_path: "/src/snake.ts",
		});
		expect(result.subtitle).toBe("/src/snake.ts");
	});
});
