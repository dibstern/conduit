import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

describe("ProviderInstance types", () => {
	it("does not expose adapter-named provider type exports", () => {
		const providerTypes = readFileSync(
			join(REPO_ROOT, "src/lib/provider/types.ts"),
			"utf8",
		);
		const providerErrors = readFileSync(
			join(REPO_ROOT, "src/lib/provider/errors.ts"),
			"utf8",
		);

		expect(providerTypes).not.toMatch(
			/\b(?:ProviderAdapter|AdapterCapabilities)\b/,
		);
		expect(providerErrors).not.toMatch(/\bProviderAdapterFailure\b/);
	});
});
