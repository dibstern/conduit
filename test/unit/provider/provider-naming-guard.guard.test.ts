import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

function listSourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) return listSourceFiles(path);
		return path.endsWith(".ts") ? [path] : [];
	});
}

describe("provider naming guard", () => {
	it("does not expose adapter-named provider implementation classes", () => {
		const source = listSourceFiles(join(REPO_ROOT, "src/lib/provider"))
			.map((path) => readFileSync(path, "utf8"))
			.join("\n");

		expect(source).not.toMatch(
			/\b(?:OpenCodeAdapter|OpenCodeAdapterOptions|ClaudeAdapter|ClaudeAdapterDeps|wireSSEToAdapter)\b/,
		);
	});

	it("does not keep adapter-named provider implementation test files", () => {
		const testFiles = [
			...listSourceFiles(join(REPO_ROOT, "test/unit/provider")),
			...listSourceFiles(join(REPO_ROOT, "test/integration/flows")),
			...listSourceFiles(join(REPO_ROOT, "test/e2e/provider")),
		];

		expect(
			testFiles.map((path) => path.replace(REPO_ROOT, "")).sort(),
		).not.toEqual(
			expect.arrayContaining([
				expect.stringMatching(/(?:opencode|claude)-adapter/),
			]),
		);
	});

	it("does not keep the provider Promise-deferred helper", () => {
		expect(existsSync(join(REPO_ROOT, "src/lib/provider/deferred.ts"))).toBe(
			false,
		);
	});
});
