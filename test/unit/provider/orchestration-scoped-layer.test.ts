import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountsStateFromInstances } from "../../../src/lib/account-directory.js";
import {
	AccountDirectory,
	makeAccountDirectory,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { makeProviderRuntimeIngestionLive } from "../../../src/lib/domain/relay/Services/provider-runtime-ingestion-service.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { OpenCodeProviderInstance } from "../../../src/lib/provider/opencode-provider-instance.js";
import { makeOrchestrationRuntimeLayer } from "../../../src/lib/provider/orchestration-wiring.js";
import { RunnerProviderInstance } from "../../../src/lib/provider/runner/runner-provider-instance.js";
import { makeOpenCodeInstancesStub } from "../../helpers/mock-factories.js";

function makeStubClient(): OpenCodeAPI {
	return {
		session: { abort: vi.fn(async () => {}), prompt: vi.fn(async () => {}) },
		permission: { reply: vi.fn(async () => {}), list: vi.fn(async () => []) },
		question: {
			reply: vi.fn(async () => {}),
			reject: vi.fn(async () => {}),
			list: vi.fn(async () => []),
		},
		app: { providers: vi.fn(async () => ({})) },
		event: { subscribe: vi.fn(async function* () {}) },
		config: {
			get: vi.fn(async () => ({})),
			set: vi.fn(async () => ({})),
		},
	} as unknown as OpenCodeAPI;
}

describe("orchestration scoped layer", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shuts down registered instances when the runtime is disposed", async () => {
		const opencodeShutdown = vi
			.spyOn(OpenCodeProviderInstance.prototype, "shutdownEffect")
			.mockReturnValue(Effect.void);
		const runnerShutdown = vi
			.spyOn(RunnerProviderInstance.prototype, "shutdownEffect")
			.mockReturnValue(Effect.void);
		const persistence = makePersistenceEffectLayer(":memory:", "test-project");
		const openCodeApi = makeStubClient();
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer().pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(
							AccountDirectory,
							makeAccountDirectory(
								Effect.succeed(
									accountsStateFromInstances(
										[
											{ id: "opencode", name: "OpenCode", driver: "opencode" },
											{ id: "claude", name: "Claude", driver: "claude" },
										],
										configuredClaudeConfigDir("/tmp/g4zp-test-claude"),
									),
								),
							),
						),
						Layer.succeed(OpenCodeAPITag, openCodeApi),
						persistence,
						Layer.succeed(
							OpenCodeInstancesTag,
							makeOpenCodeInstancesStub({ opencode: openCodeApi }),
						),
						makeProviderRuntimeIngestionLive().pipe(Layer.provide(persistence)),
					),
				),
			),
		);

		try {
			await runtime.runPromise(
				Effect.gen(function* () {
					yield* OrchestrationEngineTag;
				}),
			);
		} finally {
			await runtime.dispose();
		}

		expect(opencodeShutdown).toHaveBeenCalledTimes(1);
		expect(runnerShutdown).toHaveBeenCalledTimes(2);
	});
});
