import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("OpenCodeProviderInstance Effect boundary", () => {
	it("uses Effect Deferred for pending turns", () => {
		const providerInstance = source(
			"src/lib/provider/opencode-provider-instance.ts",
		);

		expect(providerInstance).toContain("Deferred.make<TurnResult");
		expect(providerInstance).not.toContain("createDeferred");
		expect(providerInstance).not.toContain("deferred.promise");
		expect(providerInstance).not.toMatch(/Effect\.tryPromise\([^)]*deferred/);
	});
});
