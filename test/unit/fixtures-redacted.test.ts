import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

// Captured provider traces are committed to a public repo. A home path names
// the person who captured it and their accounts, plugins and projects; capture
// tests rewrite it to /home/test before writing.
const HOME_PATH = /\/Users\/[^/\s"\\]+|\/home\/(?!test\b)[^/\s"\\]+/;

it("committed fixtures contain no real home path", () => {
	const root = "test/fixtures";
	const leaks = readdirSync(root, { recursive: true, encoding: "utf8" })
		.map((path) => join(root, path))
		.filter((path) => statSync(path).isFile())
		.flatMap((path) => {
			const match = HOME_PATH.exec(readFileSync(path, "utf8"));
			return match ? [`${path}: ${match[0]}`] : [];
		});
	expect(leaks).toEqual([]);
});
