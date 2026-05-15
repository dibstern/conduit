import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("ClaudeProviderInstance Effect boundary", () => {
	const providerInstanceSource = () =>
		source("src/lib/provider/claude/claude-provider-instance.ts");

	it("uses Effect Deferred for session setup locks", () => {
		const providerInstance = providerInstanceSource();

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

	it("uses Effect Deferred for turn queues", () => {
		const providerInstance = providerInstanceSource();

		expect(providerInstance).toContain("Deferred.make<TurnResult, Error>");
		expect(providerInstance).not.toContain("createDeferred");
		expect(providerInstance).not.toContain("PromiseDeferred");
		expect(providerInstance).not.toContain("deferred.promise");
		expect(providerInstance).not.toMatch(/Effect\.tryPromise\([^)]*deferred/);
	});

	it("does not pass translator writes through Runtime.runPromise", () => {
		const providerInstance = providerInstanceSource();

		expect(providerInstance).not.toContain("Runtime.runPromise");
	});
});
