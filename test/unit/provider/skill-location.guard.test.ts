import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("only discovery chooses Claude skill roots for content lookup", () => {
	const sourceRoot = join(process.cwd(), "src/lib");
	const files = readdirSync(sourceRoot, {
		recursive: true,
		withFileTypes: true,
	})
		.filter((entry) => entry.isFile() && /\.(ts|svelte)$/.test(entry.name))
		.map((entry) => join(entry.parentPath, entry.name));
	const violations = files.filter((path) => {
		if (path.endsWith("-discovery.ts")) return false;
		// Runner reuse fingerprints config directories; it does not look up documents.
		if (
			relative(sourceRoot, path) === "provider/claude/claude-runner-settings.ts"
		)
			return false;
		const source = readFileSync(path, "utf8");
		return (
			/\.claude[\\/]skills|["']\.claude["']\s*,\s*["']skills["']/.test(
				source,
			) && /\b(?:readFile|readFileSync|open|realpath)\b/.test(source)
		);
	});
	expect(violations.map((path) => relative(sourceRoot, path))).toEqual([]);
});
