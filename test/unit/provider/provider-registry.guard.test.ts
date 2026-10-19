import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("ProviderRegistry", () => {
	it("does not expose adapter-named registry shims", () => {
		const source = readFileSync(
			join(REPO_ROOT, "src/lib/provider/provider-registry.ts"),
			"utf8",
		);
		expect(source).not.toMatch(
			/\b(?:registerAdapter|getAdapter|getAdapterEffect|getAdapterOrThrow|hasAdapter|removeAdapter)\b/,
		);
	});
});
