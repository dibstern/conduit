import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { setModel } from "../../../src/lib/effect/session-overrides-state.js";
import {
	handleGetModels,
	handleSetDefaultModel,
	handleSwitchModel,
	handleSwitchVariant,
} from "../../../src/lib/handlers/model.js";
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
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const snapshotPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../snapshots/handlers/models.json",
);

const readSnapshots = (): Record<string, RecordedWebSocketCall[]> =>
	JSON.parse(readFileSync(snapshotPath, "utf-8")) as Record<
		string,
		RecordedWebSocketCall[]
	>;

interface ModelApiOverrides {
	readonly providerList?: OpenCodeAPI["provider"]["list"];
	readonly sessionGet?: OpenCodeAPI["session"]["get"];
	readonly configUpdate?: OpenCodeAPI["config"]["update"];
}

const makeModelApi = (overrides: ModelApiOverrides): OpenCodeAPI => {
	const api = makeMockOpenCodeAPI();
	if (overrides.providerList) {
		vi.spyOn(api.provider, "list").mockImplementation(overrides.providerList);
	}
	if (overrides.sessionGet) {
		vi.spyOn(api.session, "get").mockImplementation(overrides.sessionGet);
	}
	if (overrides.configUpdate) {
		vi.spyOn(api.config, "update").mockImplementation(overrides.configUpdate);
	}
	return api;
};

const runModelHandler = async (
	api: OpenCodeAPI,
	wsHandler: WebSocketHandlerShape,
) => {
	await Effect.runPromise(
		handleGetModels("client-1", {}).pipe(
			Effect.provide(makeTestHandlerLayer({ api, wsHandler })),
		),
	);
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

const makeNoopEngine = (): OrchestrationEngine =>
	withDispatchEffect({
		bindSession: vi.fn(),
		dispatch: vi.fn(async () => ({ models: [] })),
	});

describe("model handler wire snapshots", () => {
	it("keeps the OpenCode-only get_models envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeModelApi({
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								limit: { context: 128000, output: 4096 },
								variants: { standard: {}, fast: {} },
							},
						],
					},
					{
						id: "local",
						name: "Local",
						models: [{ id: "llama", name: "Llama" }],
					},
				],
			})),
		});

		await runModelHandler(api, wsHandler);

		expect(calls).toEqual(readSnapshots()["get_models_opencode_success"]);
	});

	it("keeps the active-session model info envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const api = makeModelApi({
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								variants: { standard: {}, fast: {} },
							},
						],
					},
				],
			})),
			sessionGet: vi.fn(async () => ({
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 0, updated: 0 },
				modelID: "gpt-4",
				providerID: "openai",
			})),
		});

		await runModelHandler(api, wsHandler);

		expect(calls).toEqual(readSnapshots()["get_models_active_session_success"]);
	});

	it("keeps the top-level provider-list error envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeModelApi({
			providerList: vi.fn(async () => {
				throw new Error("provider list failed");
			}),
		});

		await Effect.runPromise(
			handleRelayWsMessage({
				clientId: "client-1",
				handler: "get_models",
				payload: {},
				sendTo: wsHandler.sendTo,
				log: makeMockLogger(),
			}).pipe(Effect.provide(makeDispatchLayer(api, wsHandler))),
		);

		expect(calls).toEqual(readSnapshots()["get_models_provider_list_error"]);
	});

	it("keeps the OpenCode switch_model variant envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const api = makeModelApi({
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								variants: { standard: {}, fast: {} },
							},
						],
					},
				],
			})),
		});

		await Effect.runPromise(
			handleSwitchModel("client-1", {
				modelId: "gpt-4",
				providerId: "openai",
			}).pipe(
				Effect.provide(
					Layer.merge(
						makeTestHandlerLayer({
							api,
							wsHandler,
							config: makeMockConfig({
								configDir: mkdtempSync(join(tmpdir(), "conduit-switch-model-")),
							}),
						}),
						Layer.succeed(OrchestrationEngineTag, makeNoopEngine()),
					),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["switch_model_opencode_success"]);
	});

	it("keeps the OpenCode switch_variant envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const api = makeModelApi({
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{ id: "gpt-4", name: "GPT-4", variants: { v2: {}, v3: {} } },
						],
					},
				],
			})),
		});

		await Effect.runPromise(
			Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				yield* handleSwitchVariant("client-1", { variant: "v2" });
			}).pipe(
				Effect.provide(
					makeTestHandlerLayer({
						api,
						wsHandler,
						config: makeMockConfig({
							configDir: mkdtempSync(join(tmpdir(), "conduit-switch-variant-")),
						}),
					}),
				),
			),
		);

		expect(calls).toEqual(readSnapshots()["switch_variant_opencode_success"]);
	});

	it("keeps the OpenCode set_default_model envelope stable", async () => {
		const { wsHandler, calls } = makeRecordingWebSocketHandler();
		const api = makeModelApi({
			configUpdate: vi.fn(async () => undefined),
			providerList: vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [
							{
								id: "gpt-4",
								name: "GPT-4",
								variants: { standard: {}, fast: {} },
							},
						],
					},
				],
			})),
		});

		await Effect.runPromise(
			handleSetDefaultModel("client-1", {
				model: "gpt-4",
				provider: "openai",
			}).pipe(
				Effect.provide(
					makeTestHandlerLayer({
						api,
						wsHandler,
						config: makeMockConfig({
							configDir: mkdtempSync(join(tmpdir(), "conduit-default-model-")),
							projectDir: mkdtempSync(join(tmpdir(), "conduit-project-")),
						}),
					}),
				),
			),
		);

		expect(calls).toEqual(
			readSnapshots()["set_default_model_opencode_success"],
		);
	});
});
