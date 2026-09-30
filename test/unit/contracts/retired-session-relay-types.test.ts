import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

it("has no producers or consumers of retired session relay frames", () => {
	const root = join(process.cwd(), "src");
	const retired = new RegExp(
		`${["session", "switched"].join("_")}|${["history", "page"].join("_")}`,
	);
	const matches: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (
				entry.isFile() &&
				(path.endsWith(".ts") || path.endsWith(".svelte")) &&
				retired.test(readFileSync(path, "utf8"))
			) {
				matches.push(relative(root, path));
			}
		}
	};
	visit(root);
	expect(matches).toEqual([]);
});
