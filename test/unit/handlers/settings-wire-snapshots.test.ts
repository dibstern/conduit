import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { ClientMessageSerializationLive } from "../../../src/lib/effect/client-message-serialization.js";
import { RateLimiterTag } from "../../../src/lib/effect/rate-limiter-layer.js";
import {
	OrchestrationEngineTag,
	type WebSocketHandlerShape,
} from "../../../src/lib/effect/services.js";
import {
	handleGetCommands,
	handleGetProjects,
} from "../../../src/lib/handlers/settings.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import type { OrchestrationEngine } from "../../../src/lib/provider/orchestration-engine.js";
import { handleRelayWsMessage } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import {
	makeMockConfig,
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../snapshots/handlers/settings.json",
);

const readSnapshots = (): Record<string, RecordedWebSocketCall[]> =>
	JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
		string,
		RecordedWebSocketCall[]
	>;

interface SettingsApiOverrides {
	readonly commands?: OpenCodeAPI["app"]["commands"];
	readonly projects?: OpenCodeAPI["app"]["projects"];
}

const makeSettingsApi = (overrides: SettingsApiOverrides): OpenCodeAPI => {
	const api = makeMockOpenCodeAPI();
	if (overrides.commands) {
		vi.spyOn(api.app, "commands").mockImplementation(overrides.commands);
	}
	if (overrides.projects) {
		vi.spyOn(api.app, "projects").mockImplementation(overrides.projects);
	}
	return api;
};

const runSettingsHandler = async (
	effect: Effect.Effect<void, unknown, unknown>,
	api: OpenCodeAPI,
	wsHandler: WebSocketHandlerShape,
) => {
	const layer = makeTestHandlerLayer({ api, wsHandler });
	await Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

const makeDispatchLayer = (
	api: OpenCodeAPI,
	wsHandler: WebSocketHandlerShape,
) =>
	Layer.mergeAll(
		makeTestHandlerLayer({ api, wsHandler }),
		ClientMessageSerializationLive,
		Layer.succeed(RateLimiterTag, {
			checkLimit: vi.fn(() => Effect.succeed({ allowed: true })),
		}),
	);

describe("settings handler wire snapshots", () => {
	it("keeps the OpenCode get_commands envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeSettingsApi({
			commands: vi.fn(async () => [
				{ name: "build", description: "Run build" },
				{ name: "test" },
			]),
		});

		await runSettingsHandler(handleGetCommands("client-1", {}), api, wsHandler);

		expect(calls).toEqual(readSnapshots()["get_commands_opencode_success"]);
	});

	it("keeps the Claude get_commands envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const api = makeSettingsApi({
			commands: vi.fn(async () => [{ name: "opencode-only" }]),
		});
		const engine = {
			getProviderForSession: vi.fn(() => "claude"),
			dispatch: vi.fn(async () => ({
				models: [],
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

		await Effect.runPromise(
			handleGetCommands("client-1", {}).pipe(
				Effect.provide(
					Layer.merge(
						makeTestHandlerLayer({ api, wsHandler }),
						Layer.succeed(OrchestrationEngineTag, engine),
					),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["get_commands_claude_success"]);
	});

	it("keeps the top-level get_commands error envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeSettingsApi({
			commands: vi.fn(async () => {
				throw new Error("commands failed");
			}),
		});

		await Effect.runPromise(
			handleRelayWsMessage({
				clientId: "client-1",
				handler: "get_commands",
				payload: {},
				sendTo: wsHandler.sendTo,
				log: makeMockLogger(),
			}).pipe(Effect.provide(makeDispatchLayer(api, wsHandler))),
		);

		expect(calls).toEqual(readSnapshots()["get_commands_opencode_error"]);
	});

	it("keeps the config-backed get_projects envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeSettingsApi({});

		await Effect.runPromise(
			handleGetProjects("client-1", {}).pipe(
				Effect.provide(
					makeTestHandlerLayer({
						api,
						wsHandler,
						config: makeMockConfig({
							getProjects: () => [
								{
									slug: "proj-1",
									title: "Project 1",
									directory: "/work/proj",
									instanceId: "inst-1",
								},
							],
						}),
					}),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["get_projects_config_success"]);
	});

	it("keeps the OpenCode fallback get_projects envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeSettingsApi({
			projects: vi.fn(async () => [
				{ id: "p1", name: "Proj 1", path: "/proj1" },
			]),
		});

		await runSettingsHandler(handleGetProjects("client-1", {}), api, wsHandler);

		expect(calls).toEqual(
			readSnapshots()["get_projects_opencode_fallback_success"],
		);
	});

	it("keeps the top-level get_projects error envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeSettingsApi({
			projects: vi.fn(async () => {
				throw new Error("projects failed");
			}),
		});

		await Effect.runPromise(
			handleRelayWsMessage({
				clientId: "client-1",
				handler: "get_projects",
				payload: {},
				sendTo: wsHandler.sendTo,
				log: makeMockLogger(),
			}).pipe(Effect.provide(makeDispatchLayer(api, wsHandler))),
		);

		expect(calls).toEqual(readSnapshots()["get_projects_opencode_error"]);
	});
});
