import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const readSource = (path: string) =>
	readFileSync(join(REPO_ROOT, path), "utf8");

describe("SDK factory Effect boundary", () => {
	it("does not run a local Effect runtime for synchronous SDK client creation", () => {
		const sources = [
			"src/lib/relay/relay-stack.ts",
			"src/lib/domain/daemon/Layers/project-discovery-layer.ts",
			"src/lib/domain/daemon/Layers/daemon-main.ts",
		].map(readSource);

		for (const source of sources) {
			expect(source).not.toMatch(
				/(?:Effect|Eff)\s*\.\s*runSync\s*\(\s*createSdkClientEffect\s*\(/,
			);
		}
	});
});
