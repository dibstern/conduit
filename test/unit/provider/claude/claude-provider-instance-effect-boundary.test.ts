import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("ClaudeProviderInstance Effect boundary", () => {
	it("uses Effect Deferred for session setup locks", () => {
		const providerInstance = source(
			"src/lib/provider/claude/claude-provider-instance.ts",
		);

		expect(providerInstance).toContain("Deferred.make<void, Error>");
		expect(providerInstance).toContain("Deferred.Deferred<void, Error>");
		expect(providerInstance).not.toContain(
			"sessionLocks = new Map<string, Promise<void>>",
		);
		expect(providerInstance).not.toContain("setupLock.promise");
		expect(providerInstance).not.toContain(
			"this.sessionLocks.set(sessionId, setupLock.promise)",
		);
	});
});
