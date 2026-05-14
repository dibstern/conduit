import { readdirSync, readFileSync, statSync } from "node:fs";
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
});
