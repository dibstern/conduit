import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	LoggerTag,
	OpenCodeSettingsServiceLive,
	OrchestrationEngineTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { getCommandsForSession } from "../../../src/lib/handlers/settings.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import {
	makeHandlerLogger,
	makeHandlerOpenCodeAPI,
} from "../../helpers/handler-fakes.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

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

describe("getCommandsForSession active provider", () => {
	it.effect("returns Claude commands for a Claude-bound active session", () => {
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
			Layer.succeed(OrchestrationEngineTag, engine),
			Layer.succeed(LoggerTag, makeHandlerLogger()),
		);

		return getCommandsForSession("session-1").pipe(
			Effect.provide(layer),
			Effect.tap((commands) => {
				expect(engine.dispatchEffect).toHaveBeenCalledWith({
					type: "discover",
					providerId: "claude",
				});
				expect(client.app.commands).not.toHaveBeenCalled();
				expect(commands).toEqual([
					{ name: "init", description: "Init Claude", args: "[path]" },
				]);
			}),
		);
	});

	it.effect(
		"returns OpenCode commands for an OpenCode-bound active session",
		() => {
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
				Layer.succeed(OrchestrationEngineTag, engine),
			);

			return getCommandsForSession("session-1").pipe(
				Effect.provide(layer),
				Effect.tap((commands) => {
					expect(engine.dispatchEffect).not.toHaveBeenCalled();
					expect(client.app.commands).toHaveBeenCalledOnce();
					expect(commands).toEqual(opencodeCommands);
				}),
			);
		},
	);

	it.effect("preserves OpenCode behavior when no active session exists", () => {
		const opencodeCommands = [{ name: "opencode-default" }];
		const client = makeHandlerOpenCodeAPI({
			app: { commands: vi.fn(async () => opencodeCommands) },
		});

		const layer = Layer.mergeAll(
			openCodeSettingsLayer(client),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect({})),
		);

		return getCommandsForSession(undefined).pipe(
			Effect.provide(layer),
			Effect.tap((commands) => {
				expect(client.app.commands).toHaveBeenCalledOnce();
				expect(commands).toEqual(opencodeCommands);
			}),
		);
	});

	it.effect(
		"falls back to Claude commands when startup has no active session and OpenCode is unavailable",
		() => {
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
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(LoggerTag, makeHandlerLogger()),
			);

			return getCommandsForSession(undefined).pipe(
				Effect.provide(layer),
				Effect.tap((commands) => {
					expect(client.app.commands).toHaveBeenCalledOnce();
					expect(engine.dispatchEffect).toHaveBeenCalledWith({
						type: "discover",
						providerId: "claude",
					});
					expect(commands).toEqual([
						{ name: "init", description: "Init Claude", args: "[path]" },
					]);
				}),
			);
		},
	);

	it.effect("returns an empty Claude list when Claude discovery fails", () => {
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
			Layer.succeed(OrchestrationEngineTag, engine),
			Layer.succeed(LoggerTag, log),
		);

		return getCommandsForSession("session-1").pipe(
			Effect.provide(layer),
			Effect.tap((commands) => {
				expect(client.app.commands).not.toHaveBeenCalled();
				expect(log.warn).toHaveBeenCalledWith(
					expect.stringContaining("Failed to discover Claude commands"),
				);
				expect(commands).toEqual([]);
			}),
		);
	});
});
