import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import {
	LoggerTag,
	OpenCodeAPITag,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/effect/services.js";
import { handleGetCommands } from "../../../src/lib/handlers/settings.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
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
		getClientSession: vi.fn(() => undefined),
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

function openCodeSettingsLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		OpenCodeSettingsServiceLive.pipe(Layer.provide(apiLayer)),
	);
}

describe("handleGetCommands active provider", () => {
	it.effect("returns Claude commands for a Claude-bound active session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = {
			app: { commands: vi.fn(async () => [{ name: "opencode-only" }]) },
		} as unknown as OpenCodeAPI;
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				models: [],
				supportsTools: true,
				supportsThinking: true,
				supportsPermissions: true,
				supportsQuestions: true,
				supportsAttachments: true,
				supportsFork: false,
				supportsRevert: false,
				commands: [
					{
						name: "init",
						description: "Init Claude",
						args: "[path]",
						source: "claude-sdk",
					},
				],
			})),
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			Layer.succeed(LoggerTag, mockLogger()),
		);

		return handleGetCommands("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(client.app.commands).not.toHaveBeenCalled();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "command_list",
					commands: [
						{ name: "init", description: "Init Claude", args: "[path]" },
					],
				});
			}),
		);
	});

	it.effect(
		"returns OpenCode commands for an OpenCode-bound active session",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const opencodeCommands = [{ name: "opencode-only" }];
			const client = {
				app: { commands: vi.fn(async () => opencodeCommands) },
			} as unknown as OpenCodeAPI;
			const engine = {
				getProviderForSession: vi.fn(() => "opencode"),
				dispatch: vi.fn(),
			} as unknown as OrchestrationEngine;

			const layer = Layer.mergeAll(
				openCodeSettingsLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			);

			return handleGetCommands("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(engine.dispatchEffect).not.toHaveBeenCalled();
					expect(client.app.commands).toHaveBeenCalledOnce();
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "command_list",
						commands: opencodeCommands,
					});
				}),
			);
		},
	);

	it.effect("preserves OpenCode behavior when no active session exists", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => undefined),
		});
		const opencodeCommands = [{ name: "opencode-default" }];
		const client = {
			app: { commands: vi.fn(async () => opencodeCommands) },
		} as unknown as OpenCodeAPI;

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
		);

		return handleGetCommands("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.app.commands).toHaveBeenCalledOnce();
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "command_list",
					commands: opencodeCommands,
				});
			}),
		);
	});

	it.effect("sends an empty Claude list when Claude discovery fails", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = {
			app: { commands: vi.fn(async () => [{ name: "opencode-only" }]) },
		} as unknown as OpenCodeAPI;
		const log = mockLogger();
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => {
				throw new Error("discover failed");
			}),
		} as unknown as OrchestrationEngine;

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect(engine)),
			Layer.succeed(LoggerTag, log),
		);

		return handleGetCommands("client-1", {}).pipe(
			Effect.provide(layer),
			Effect.tap(() => {
				expect(client.app.commands).not.toHaveBeenCalled();
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("Failed to discover Claude commands"),
				);
				expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
					type: "command_list",
					commands: [],
				});
			}),
		);
	});
});
