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
	const runnerPayloadSource = () =>
		source("src/lib/provider/claude/claude-runner-payload.ts");

	it("uses Effect Deferred for session setup locks in the runtime", () => {
		const runnerPayload = runnerPayloadSource();

		expect(runnerPayload).toContain("Deferred.make<void, Error>");
		expect(runnerPayload).toContain("Deferred.Deferred<void, Error>");
		for (const runtime of [providerRuntimeSource(), runnerPayload]) {
			expect(runtime).not.toContain(
				"sessionLocks = new Map<string, Promise<void>>",
			);
			expect(runtime).not.toContain("setupLock.promise");
			expect(runtime).not.toContain(
				"this.sessionLocks.set(sessionId, setupLock.promise)",
			);
		}
	});

	it("uses Effect Deferred for turn queues in the runtime", () => {
		const runnerPayload = runnerPayloadSource();

		expect(runnerPayload).toContain("Deferred.make<TurnResult, Error>");
		for (const runtime of [providerRuntimeSource(), runnerPayload]) {
			expect(runtime).not.toContain("createDeferred");
			expect(runtime).not.toContain("PromiseDeferred");
			expect(runtime).not.toContain("deferred.promise");
			expect(runtime).not.toMatch(/Effect\.tryPromise\([^)]*deferred/);
		}
	});

	it("does not pass translator writes through Runtime.runPromise", () => {
		const providerInstance = providerInstanceSource();
		const translator = source(
			"src/lib/provider/claude/claude-event-translator.ts",
		);

		expect(providerInstance).not.toContain("Runtime.runPromise");
		for (const runtime of [providerRuntimeSource(), runnerPayloadSource()]) {
			expect(runtime).not.toContain("Runtime.runPromise");
			expect(runtime).not.toContain("makeRuntimeEffectRunner");
			expect(runtime).not.toContain("runEffect:");
		}
		expect(translator).not.toContain("runEffect:");
	});
});
