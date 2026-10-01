import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	LoggerTag,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { handleGetCommands } from "../../../src/lib/handlers/settings.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeHandlerLogger,
	makeHandlerOpenCodeAPI,
} from "../../helpers/handler-fakes.js";
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
		attach: vi.fn(() => () => {}),
		close: vi.fn(),
		drain: vi.fn(async () => undefined),
		on: vi.fn(),
		once: vi.fn(),
		...overrides,
	};
}

function openCodeSettingsLayer(client: OpenCodeAPI) {
	const apiLayer = Layer.succeed(OpenCodeAPITag, client);
	return Layer.merge(
		apiLayer,
		Layer.merge(
			OpenCodeSettingsServiceLive.pipe(Layer.provide(apiLayer)),
			Layer.succeed(LoggerTag, makeHandlerLogger()),
		),
	);
}

describe("handleGetCommands active provider", () => {
	it.effect("returns Claude commands for a Claude-bound active session", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = makeHandlerOpenCodeAPI({
			app: { commands: vi.fn(async () => [{ name: "opencode-only" }]) },
		});
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
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
		});

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, engine),
			Layer.succeed(LoggerTag, makeHandlerLogger()),
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
			const client = makeHandlerOpenCodeAPI({
				app: { commands: vi.fn(async () => opencodeCommands) },
			});
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("opencode")),
				dispatch: vi.fn(),
			});

			const layer = Layer.mergeAll(
				openCodeSettingsLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(OrchestrationEngineTag, engine),
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
		const client = makeHandlerOpenCodeAPI({
			app: { commands: vi.fn(async () => opencodeCommands) },
		});

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
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

	it.effect(
		"falls back to Claude commands when startup has no active session and OpenCode is unavailable",
		() => {
			const ws = mockWsHandler({
				getClientSession: vi.fn(() => undefined),
			});
			const client = makeHandlerOpenCodeAPI({
				app: {
					commands: vi.fn(async () => {
						throw new Error("opencode offline");
					}),
				},
			});
			const engine = withDispatchEffect({
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
			});

			const layer = Layer.mergeAll(
				openCodeSettingsLayer(client),
				Layer.succeed(WebSocketHandlerTag, ws),
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(LoggerTag, makeHandlerLogger()),
			);

			return handleGetCommands("client-1", {}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(client.app.commands).toHaveBeenCalledOnce();
					expect(engine.dispatchEffect).toHaveBeenCalledWith({
						type: "discover",
						providerId: "claude",
					});
					expect(ws.sendTo).toHaveBeenCalledWith("client-1", {
						type: "command_list",
						commands: [
							{ name: "init", description: "Init Claude", args: "[path]" },
						],
					});
				}),
			);
		},
	);

	it.effect("sends an empty Claude list when Claude discovery fails", () => {
		const ws = mockWsHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const client = makeHandlerOpenCodeAPI({
			app: { commands: vi.fn(async () => [{ name: "opencode-only" }]) },
		});
		const log = makeHandlerLogger();
		const engine = withDispatchEffect({
			getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
			dispatch: vi.fn(async () => {
				throw new Error("discover failed");
			}),
		});

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(WebSocketHandlerTag, ws),
			Layer.succeed(OrchestrationEngineTag, engine),
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
