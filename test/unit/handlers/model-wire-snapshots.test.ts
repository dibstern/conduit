import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { ClientMessageSerializationLive } from "../../../src/lib/effect/client-message-serialization.js";
import { RateLimiterTag } from "../../../src/lib/effect/rate-limiter-layer.js";
import type { WebSocketHandlerShape } from "../../../src/lib/effect/services.js";
import { handleGetModels } from "../../../src/lib/handlers/model.js";
import type { OpenCodeAPI } from "../../../src/lib/instance/opencode-api.js";
import { handleRelayWsMessage } from "../../../src/lib/relay/ws-message-dispatch-effect.js";
import {
	makeMockLogger,
	makeMockOpenCodeAPI,
	makeRecordingWebSocketHandler,
	makeTestHandlerLayer,
	type RecordedWebSocketCall,
} from "../../helpers/mock-factories.js";

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
}

const makeModelApi = (overrides: ModelApiOverrides): OpenCodeAPI => {
	const api = makeMockOpenCodeAPI();
	if (overrides.providerList) {
		vi.spyOn(api.provider, "list").mockImplementation(overrides.providerList);
	}
	if (overrides.sessionGet) {
		vi.spyOn(api.session, "get").mockImplementation(overrides.sessionGet);
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
});
