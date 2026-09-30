import { Effect, Exit, Scope } from "effect";
import { onTestFinished } from "vitest";
import {
	ClaudeProviderInstance,
	type ClaudeProviderInstanceDeps,
} from "../../src/lib/provider/claude/claude-provider-instance.js";
import { makeClaudeProviderRuntime } from "../../src/lib/provider/claude/claude-provider-runtime.js";

export function makeTestClaudeProviderInstance(
	deps: ClaudeProviderInstanceDeps,
): ClaudeProviderInstance {
	const scope = Effect.runSync(Scope.make());
	const runtime = Effect.runSync(
		Scope.extend(
			makeClaudeProviderRuntime({
				...deps,
				...(deps.queryFactory && !deps.capabilitiesService
					? {
							capabilitiesService: {
								get: () =>
									Effect.fail(
										new Error("Claude capabilities service unavailable"),
									),
							},
						}
					: {}),
			}),
			scope,
		),
	);
	onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
	return new ClaudeProviderInstance(runtime);
}
