import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

it("resolves Cursor credentials only in the account resource owner", () => {
	const callers: string[] = [];
	const scan = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) scan(path);
			else if (
				path.endsWith(".ts") &&
				!path.endsWith("/cursor-credential.ts")
			) {
				const source = readFileSync(path, "utf8");
				for (const _ of source.matchAll(/\bresolveCursorCredential\s*\(/g))
					callers.push(path);
			}
		}
	};
	scan("src");
	expect(callers).toEqual([
		"src/lib/provider/cursor/cursor-account-resources.ts",
	]);
});
