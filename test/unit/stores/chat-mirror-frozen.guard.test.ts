import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return sourceFiles(path);
		return path.endsWith(".ts") || path.endsWith(".svelte") ? [path] : [];
	});
}

describe("chatState is read-only", () => {
	it("has no writer anywhere in src/", () => {
		const repoRoot = process.cwd();
		const assignment = /\bchatState\.[A-Za-z]+\s*(?:=[^=]|\+=|-=|\+\+|--)/;
		const hits = sourceFiles(join(repoRoot, "src")).flatMap((file) =>
			readFileSync(file, "utf8")
				.split("\n")
				.flatMap((line, index) =>
					assignment.test(line)
						? [`${relative(repoRoot, file)}:${index + 1}: ${line.trim()}`]
						: [],
				),
		);
		expect(
			hits,
			"the chat mirror is derived; write the session slot instead",
		).toEqual([]);
	});
});
