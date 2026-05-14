import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import {
	getContextWindow,
	getDefaultContextWindow,
	makeOverridesStateLive,
	setDefaultModel,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { handleSwitchContextWindow } from "../../../src/lib/handlers/context-window.js";
import type { Logger } from "../../../src/lib/logger.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

function mockWsHandler(
	overrides?: Partial<WebSocketHandlerShape>,
): WebSocketHandlerShape {
	return {
		broadcast: vi.fn(),
		sendTo: vi.fn(),
		setClientSession: vi.fn(),
		getClientSession: vi.fn(() => "session-1"),
		getClientsForSession: vi.fn(() => []),
		sendToSession: vi.fn(),
		broadcastPerSessionEvent: vi.fn(),
		markClientBootstrapped: vi.fn(),
		getClientCount: vi.fn(() => 0),
		getClientIds: vi.fn(() => []),
		handleUpgrade: vi.fn(),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

function mockLogger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger;
}

describe("handleSwitchContextWindow with Effect override state", () => {
	it.effect(
		"stores a supported session context window without legacy SessionOverrides",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200k", isDefault: true },
				{ value: "1m", label: "1M" },
			];
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-42"),
			});
			const engine = {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-42", {
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});

				yield* handleSwitchContextWindow("client-1", {
					contextWindow: "1m",
				});

				expect(yield* getContextWindow("session-42")).toBe("1m");
				expect(ws.sendToSession).toHaveBeenCalledWith("session-42", {
					type: "context_window_info",
					contextWindow: "1m",
					options: contextWindowOptions,
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"stores a supported default context window without a session",
		() => {
			const contextWindowOptions = [
				{ value: "200k", label: "200k", isDefault: true },
				{ value: "1m", label: "1M" },
			];
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const engine = {
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet-4-7",
							name: "Claude Sonnet 4.7",
							providerId: "claude",
							contextWindowOptions,
						},
					],
				})),
			} as unknown as OrchestrationEngine;
			const layer = Layer.mergeAll(
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(LoggerTag, mockLogger()),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setDefaultModel({
					providerID: "claude",
					modelID: "claude-sonnet-4-7",
				});

				yield* handleSwitchContextWindow("client-1", {
					contextWindow: "1m",
				});

				expect(yield* getDefaultContextWindow()).toBe("1m");
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "context_window_info",
					contextWindow: "1m",
					options: contextWindowOptions,
				});
				expect(ws.sendToSession).not.toHaveBeenCalled();
			}).pipe(Effect.provide(layer));
		},
	);
});
