import type { resolveSettings } from "@anthropic-ai/claude-agent-sdk";
import { Effect } from "effect";
import type { ClaudeSessionRunnerDeps } from "./claude-provider-runtime.js";

interface ClaudeSdkTestModule {
	readonly claudeSdk: {
		readonly query: NonNullable<ClaudeSessionRunnerDeps["queryFactory"]>;
	};
	readonly claudeSubagentSdk?: ClaudeSessionRunnerDeps["subagentSdk"];
	readonly resolveSettings?: typeof resolveSettings;
}

/** Both runner turns and daemon controls honor the same process-test adapter. */
export const loadClaudeSdkTestModule = Effect.gen(function* () {
	const testModule = process.env["CONDUIT_TEST_CLAUDE_QUERY_MODULE"];
	if (process.env["NODE_ENV"] !== "test" || !testModule) return undefined;
	// The configured dynamic module cannot carry its TypeScript export signature.
	const module = yield* Effect.tryPromise(
		() => import(testModule) as Promise<ClaudeSdkTestModule>,
	);
	if (typeof module.claudeSdk?.query !== "function")
		return yield* Effect.die(
			"Process test module must export a Claude query factory",
		);
	return module;
});
