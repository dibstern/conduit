import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { onTestFinished } from "vitest";
import type {
	ClaudeProviderInstance,
	ClaudeProviderInstanceDeps,
} from "../../src/lib/provider/claude/claude-provider-instance.js";
import {
	makeClaudeProviderRuntime,
	makeClaudeSessionRunner,
} from "../../src/lib/provider/claude/claude-provider-runtime.js";
import type { SDKUserMessage } from "../../src/lib/provider/claude/types.js";
import { ClaudeBoundaryError } from "../../src/lib/provider/event-sink-errors.js";
import type { SendTurnInput } from "../../src/lib/provider/types.js";

export function makeTestClaudeProviderInstance(
	deps: ClaudeProviderInstanceDeps,
): ClaudeProviderInstance {
	const scope = Effect.runSync(Scope.make());
	const runtime = Effect.runSync(
		Scope.provide(
			makeClaudeProviderRuntime({
				runnerFactory: makeClaudeSessionRunner,
				// Never fall back to the developer's real ~/.config/conduit.
				daemonConfigDir: mkdtempSync(join(tmpdir(), "conduit-test-config-")),
				...deps,
				...(deps.queryFactory && !deps.capabilitiesService
					? {
							capabilitiesService: {
								get: () =>
									Effect.fail(
										new ClaudeBoundaryError({
											operation: "probeCapabilities",
											cause: new Error(
												"Claude capabilities service unavailable",
											),
										}),
									),
							},
						}
					: {}),
			}),
			scope,
		),
	);
	onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
	// Keep the existing malformed-message injection at the implementation owner.
	const runner = (
		runtime as unknown as {
			runner: { buildUserMessage(input: SendTurnInput): SDKUserMessage };
		}
	).runner;
	Object.defineProperty(runtime, "buildUserMessage", {
		set: (build: (input: SendTurnInput) => SDKUserMessage) => {
			runner.buildUserMessage = build;
		},
	});
	Object.defineProperty(runtime, "runtime", { value: runtime });
	return runtime;
}
