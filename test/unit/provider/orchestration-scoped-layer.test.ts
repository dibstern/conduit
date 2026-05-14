import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import { OrchestrationEngineTag } from "../../../src/lib/domain/relay/Services/services.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { ClaudeAdapter } from "../../../src/lib/provider/claude/claude-adapter.js";
import { OpenCodeAdapter } from "../../../src/lib/provider/opencode-adapter.js";
import { makeOrchestrationRuntimeLayer } from "../../../src/lib/provider/orchestration-wiring.js";

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

	it("shuts down registered adapters when the runtime is disposed", async () => {
		const opencodeShutdown = vi
			.spyOn(OpenCodeAdapter.prototype, "shutdownEffect")
			.mockReturnValue(Effect.void);
		const claudeShutdown = vi
			.spyOn(ClaudeAdapter.prototype, "shutdownEffect")
			.mockReturnValue(Effect.void);
		const runtime = ManagedRuntime.make(
			makeOrchestrationRuntimeLayer().pipe(
				Layer.provide(Layer.succeed(OpenCodeAPITag, makeStubClient())),
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
		expect(claudeShutdown).toHaveBeenCalledTimes(1);
	});
});
