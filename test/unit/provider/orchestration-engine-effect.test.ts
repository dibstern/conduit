import { describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { expect, vi } from "vitest";
import {
	OrchestrationEngine,
	type SendTurnCommand,
} from "../../../src/lib/provider/orchestration-engine.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type {
	AdapterCapabilities,
	ProviderAdapter,
} from "../../../src/lib/provider/types.js";
import { createMockEventSink } from "../../helpers/mock-sdk.js";

function makeStubAdapter(providerId: string): ProviderAdapter & {
	sendTurn: ReturnType<typeof vi.fn>;
} {
	return {
		providerId,
		discoverEffect: vi.fn(() =>
			Effect.succeed({
				models: [],
				supportsTools: false,
				supportsThinking: false,
				supportsPermissions: false,
				supportsQuestions: false,
				supportsAttachments: false,
				supportsFork: false,
				supportsRevert: false,
				commands: [],
			}),
		),
		sendTurn: vi.fn(async () => ({
			status: "completed" as const,
			cost: 0,
			tokens: { input: 1, output: 1 },
			durationMs: 1,
			providerStateUpdates: [],
		})),
		interruptTurn: vi.fn(async () => {}),
		resolvePermission: vi.fn(async () => {}),
		resolveQuestion: vi.fn(async () => {}),
		shutdown: vi.fn(async () => {}),
		endSession: vi.fn(async () => {}),
	};
}

function capabilities(): AdapterCapabilities {
	return {
		models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
		supportsTools: true,
		supportsThinking: true,
		supportsPermissions: true,
		supportsQuestions: true,
		supportsAttachments: true,
		supportsFork: false,
		supportsRevert: false,
		commands: [],
	};
}

function sendTurnCommand(): SendTurnCommand {
	return {
		type: "send_turn",
		commandId: "cmd-retry-after-lookup-failure",
		providerId: "opencode",
		input: {
			sessionId: "session-1",
			turnId: "turn-1",
			prompt: "hello",
			history: [],
			providerState: {},
			workspaceRoot: "/tmp/project",
			eventSink: createMockEventSink(),
			abortSignal: new AbortController().signal,
		},
	};
}

describe("OrchestrationEngine dispatchEffect", () => {
	it.effect(
		"returns typed provider lookup failures without consuming command idempotency",
		() =>
			Effect.gen(function* () {
				const registry = new ProviderRegistry();
				const engine = new OrchestrationEngine({ registry });
				const command = sendTurnCommand();

				const failed = yield* Effect.either(engine.dispatchEffect(command));
				expect(failed._tag).toBe("Left");
				if (failed._tag === "Left") {
					expect(failed.left).toMatchObject({
						_tag: "ProviderNotRegistered",
						providerId: "opencode",
					});
				}

				const adapter = makeStubAdapter("opencode");
				registry.registerAdapter(adapter);
				const result = yield* engine.dispatchEffect(command);

				expect(result).toMatchObject({ status: "completed" });
				expect(adapter.sendTurn).toHaveBeenCalledTimes(1);
				expect(engine.getProviderForSession("session-1")).toBe("opencode");
			}),
	);

	it.effect("dispatches discovery through the adapter Effect boundary", () =>
		Effect.gen(function* () {
			const registry = new ProviderRegistry();
			const engine = new OrchestrationEngine({ registry });
			const discover = vi.fn(() => {
				throw new Error("legacy Promise discover should not be called");
			});
			const discoverEffect = vi.fn(() => Effect.succeed(capabilities()));

			registry.registerAdapter({
				...makeStubAdapter("claude"),
				discover,
				discoverEffect,
			} as ProviderAdapter & { discover: typeof discover });

			const result = yield* engine.dispatchEffect({
				type: "discover",
				providerId: "claude",
			});

			expect(result.models).toEqual([
				{ id: "sonnet", name: "Sonnet", providerId: "claude" },
			]);
			expect(discover).not.toHaveBeenCalled();
			expect(discoverEffect).toHaveBeenCalledTimes(1);
		}),
	);
});
