import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();

const source = (path: string) => readFileSync(join(REPO_ROOT, path), "utf8");

describe("ClaudeProviderInstance Effect boundary", () => {
	const providerInstanceSource = () =>
		source("src/lib/provider/claude/claude-provider-instance.ts");
	const providerRuntimeSource = () =>
		source("src/lib/provider/claude/claude-provider-runtime.ts");

	it("uses Effect Deferred for session setup locks in the runtime", () => {
		const providerRuntime = providerRuntimeSource();

		expect(providerRuntime).toContain("Deferred.make<void, Error>");
		expect(providerRuntime).toContain("Deferred.Deferred<void, Error>");
		expect(providerRuntime).not.toContain(
			"sessionLocks = new Map<string, Promise<void>>",
		);
		expect(providerRuntime).not.toContain("setupLock.promise");
		expect(providerRuntime).not.toContain(
			"this.sessionLocks.set(sessionId, setupLock.promise)",
		);
	});

	it("uses Effect Deferred for turn queues in the runtime", () => {
		const providerRuntime = providerRuntimeSource();

		expect(providerRuntime).toContain("Deferred.make<TurnResult, Error>");
		expect(providerRuntime).not.toContain("createDeferred");
		expect(providerRuntime).not.toContain("PromiseDeferred");
		expect(providerRuntime).not.toContain("deferred.promise");
		expect(providerRuntime).not.toMatch(/Effect\.tryPromise\([^)]*deferred/);
	});

	it("does not pass translator writes through Runtime.runPromise", () => {
		const providerInstance = providerInstanceSource();
		const providerRuntime = providerRuntimeSource();
		const translator = source(
			"src/lib/provider/claude/claude-event-translator.ts",
		);

		expect(providerInstance).not.toContain("Runtime.runPromise");
		expect(providerRuntime).not.toContain("Runtime.runPromise");
		expect(providerRuntime).not.toContain("makeRuntimeEffectRunner");
		expect(providerRuntime).not.toContain("runEffect:");
		expect(translator).not.toContain("runEffect:");
	});
});
