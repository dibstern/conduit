import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlClient } from "@effect/sql";
import { describe, layer } from "@effect/vitest";
import {
	Deferred,
	Effect,
	Fiber,
	FiberMap,
	Layer,
	Option,
	PubSub,
	Queue,
	Stream,
	Supervisor,
} from "effect";
import { expect, vi } from "vitest";
import {
	AccountDirectory,
	AccountDirectoryFromConfigLive,
} from "../../../src/lib/domain/daemon/Services/account-directory.js";
import { OpenCodeInstancesTag } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { OpenCodeAPITag } from "../../../src/lib/domain/provider/Services/opencode-api-service.js";
import {
	ProjectSettingsLive,
	ProjectSettingsTag,
	refreshGlobalDefaults,
	subscribeProjectSettings,
} from "../../../src/lib/domain/relay/Services/project-settings.js";
import {
	ConfigTag,
	LoggerTag,
	OpenCodeModelServiceLive,
	OpenCodeModelServiceTag,
	OrchestrationEngineTag,
	WebSocketHandlerTag,
} from "../../../src/lib/domain/relay/Services/services.js";
import { SessionManagerServiceTag } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import {
	getDefaultModel,
	getDefaultVariant,
	getVariant,
	makeOverridesStateLive,
	setDefaultModel,
	setModel,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../../../src/lib/handlers/model.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import {
	ProviderRegistry,
	ProviderRegistryTag,
} from "../../../src/lib/provider/provider-registry.js";
import type { ProviderCapabilities } from "../../../src/lib/provider/types.js";
import { RpcSubscriptionScopeLive } from "../../../src/lib/server/ws-rpc.js";
import { makeHandlerOpenCodeAPI } from "../../helpers/handler-fakes.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockLogger,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeOpenCodeInstancesStub,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

// biome-ignore format: Keep the existing test layout inside this runtime suite.
layer(Layer.mergeAll(Layer.succeed(AccountDirectory, makeMockAccountDirectory()), makePersistenceEffectLayer(":memory:", "test-project"), Layer.succeed(SessionManagerServiceTag, makeMockSessionManagerService()), Layer.succeed(OrchestrationEngineTag, withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [], commands: [] })) })), Layer.succeed(ProviderRegistryTag, new ProviderRegistry()), Layer.succeed(ConfigTag, makeMockConfig()), ProjectSettingsLive, RpcSubscriptionScopeLive))("persistent handler runtime", (it) => {
describe("model handlers with Effect-native model service", () => {
	it.effect(
		"loads providers and relay-owned active-session model info without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
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
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					OrchestrationEngineTag,
					withDispatchEffect({ dispatch: vi.fn(async () => ({ models: [] })) }),
				),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				const projections = yield* ProjectionRunnerEffectTag;
				yield* projections.recover();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions
					(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
					VALUES ('session-1', 'opencode', 'Stored session', 'openai', 'gpt-4', '', '', 1, 1)`;
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				return yield* getModelsResponse({
					clientId: "client-1",
					sessionId: "session-1",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap((response) => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(response.active).toEqual({
						model: "gpt-4",
						provider: "openai",
					});
					expect(response.variant).toEqual({
						variant: "",
						variants: ["standard", "fast"],
					});
				}),
			);
		},
	);

	it.effect(
		"keeps configured OpenCode providers in model refreshes for Claude-bound sessions",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
						connected: ["openai"],
						defaults: {},
						providers: [
							{
								id: "openai",
								name: "OpenAI",
								models: [{ id: "gpt-5", name: "GPT-5" }],
							},
						],
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};
			const engine = withDispatchEffect({
				getProviderForSessionEffect: vi.fn(() => Effect.succeed("claude")),
				dispatch: vi.fn(async () => ({
					models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }],
					supportsTools: true,
					supportsThinking: true,
					supportsPermissions: true,
					supportsQuestions: true,
					supportsAttachments: true,
					supportsFork: true,
					supportsRevert: true,
					commands: [],
				})),
			});

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(OrchestrationEngineTag, engine),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "claude",
					modelID: "sonnet",
				});
				const response = yield* getModelsResponse({
					clientId: "client-1",
					sessionId: "session-1",
				});

				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(response.providers).toEqual([
						{
							id: "openai",
							name: "OpenAI",
							configured: true,
							models: [
								{
									id: "gpt-5",
									name: "GPT-5",
									provider: "openai",
								},
							],
						},
				]);
				const catalog = yield* subscribeProjectSettings().pipe(
					Stream.mapConcat((envelope) => envelope._tag === "snapshot" ? envelope.rows : envelope._tag === "upsert" ? [envelope.item] : []),
					Stream.filter((setting) => setting._tag === "providerModels"),
					Stream.runHead, Effect.map(Option.getOrThrow),
				);
				expect(catalog.providers).toEqual([
						{
							id: "claude",
							name: "Anthropic - claude",
							configured: true,
							models: [
								{
									id: "sonnet",
									name: "Sonnet",
									provider: "claude",
								},
							],
						},
				]);
			}).pipe(Effect.provide(Layer.merge(layer, ProjectSettingsLive)));
		},
	);

	for (const fails of [false, true]) {
		it.effect(`shares one pending Claude discovery and publication, then refreshes after ${fails ? "failure" : "success"}`, () => Effect.gen(function* () {
			let pending = yield* Deferred.make<ProviderCapabilities, Error>();
			let discoveries = 0;
			const capabilities: ProviderCapabilities = {
				models: [{ id: "sonnet", name: "Sonnet", providerId: "claude" }], commands: [],
				supportsTools: true, supportsThinking: true, supportsPermissions: true,
				supportsQuestions: true, supportsAttachments: true, supportsFork: true, supportsRevert: true,
			};
			const engine = withDispatchEffect({ dispatchEffect: () => Effect.gen(function* () {
				discoveries += 1;
				return yield* Deferred.await(pending);
			}) });
			const deps = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, {
					listProviders: () => Effect.succeed({ connected: ["fake"], defaults: {}, providers: [
						{ id: "fake", name: "Fake", models: [{ id: "model-a", name: "A" }] },
					] }),
					cachedProviders: () => Effect.succeedNone,
					persistDefaultModel: () => Effect.void,
				}),
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(LoggerTag, makeMockLogger()),
				Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
				makeOverridesStateLive(), ProjectSettingsLive, RpcSubscriptionScopeLive,
			);
			return yield* Effect.gen(function* () {
				const updates = yield* PubSub.subscribe((yield* ProjectSettingsTag).changes);
				const supervisor = yield* Supervisor.track;
				const responses = yield* Effect.forEach(Array.from({ length: 25 }), () => getModelsResponse(), {
					concurrency: "unbounded",
				}).pipe(Effect.supervised(supervisor));
				expect(responses).toHaveLength(25);
				for (const response of responses) expect(response.providers.map(({ id }) => id)).toEqual(["fake"]);
				expect(yield* Deferred.isDone(pending)).toBe(false);
				const fibers = yield* supervisor.value;
				expect(fibers).toHaveLength(1);
				expect(discoveries).toBe(1);
				if (fails) yield* Deferred.fail(pending, new Error("Claude discovery failed"));
				else yield* Deferred.succeed(pending, capabilities);
				yield* Effect.forEach(fibers, Fiber.join);
				const firstUpdates = Array.from(yield* Queue.takeAll(updates));
				expect(firstUpdates.filter(({ item }) => item._tag === "providerModels")).toHaveLength(fails ? 0 : 1);
				pending = yield* Deferred.make<ProviderCapabilities, Error>();
				yield* getModelsResponse().pipe(Effect.supervised(supervisor));
				expect(discoveries).toBe(2);
				const refresh = yield* supervisor.value;
				expect(refresh).toHaveLength(1);
				yield* Deferred.succeed(pending, { ...capabilities, models: [{ id: "opus", name: "Opus", providerId: "claude" }] });
				yield* Effect.forEach(refresh, Fiber.join);
				expect(Array.from(yield* Queue.takeAll(updates)).filter(({ item }) => item._tag === "providerModels")).toMatchObject([
					{ item: { _tag: "providerModels", providers: [{ id: "claude", models: [{ id: "opus" }] }] } },
				]);
			}).pipe(Effect.provide(deps), Effect.scoped);
		}));
	}

	it.effect("returns OpenCode models while Claude discovery is pending and publishes Claude models when ready", () => {
		return Effect.gen(function* () {
			const pending = yield* Deferred.make<ProviderCapabilities>();
			const started = yield* Deferred.make<void>();
			let readyCapabilities: ProviderCapabilities | undefined;
			const modelService = {
				listProviders: () => Effect.succeed({
					connected: ["fake"], defaults: {},
					providers: [{ id: "fake", name: "Fake", models: [{ id: "model-a", name: "A" }] }],
				}),
				cachedProviders: () => Effect.succeedNone,
				persistDefaultModel: () => Effect.void,
			};
			const engine = withDispatchEffect({
				dispatchEffect: () => Deferred.succeed(started, undefined).pipe(
					Effect.zipRight(readyCapabilities ? Effect.succeed(readyCapabilities) : Deferred.await(pending)),
				),
			});
			const deps = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(OrchestrationEngineTag, engine),
				Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
				Layer.succeed(LoggerTag, makeMockLogger()),
				makeOverridesStateLive(), ProjectSettingsLive, RpcSubscriptionScopeLive,
			);
			return yield* Effect.gen(function* () {
				const request = yield* Effect.fork(getModelsResponse());
				yield* Deferred.await(started);
				const response = yield* Fiber.join(request);
				expect(yield* Deferred.isDone(pending)).toBe(false);
				expect(response.providers.map(({ id }) => id)).toEqual(["fake"]);
				const subscribed = yield* Deferred.make<void>();
				const update = yield* subscribeProjectSettings().pipe(
					Stream.tap((envelope) => envelope._tag === "synchronized" ? Deferred.succeed(subscribed, undefined) : Effect.void),
					Stream.filter((envelope) => envelope._tag === "upsert" && envelope.item._tag === "providerModels"),
					Stream.runHead, Effect.fork,
				);
				yield* Deferred.await(subscribed);
				yield* Deferred.succeed(pending, {
					models: [{ id: "sonnet", name: "Sonnet", providerId: "claude", variants: { high: {} } }], commands: [],
					supportsTools: true, supportsThinking: true, supportsPermissions: true,
					supportsQuestions: true, supportsAttachments: true, supportsFork: true, supportsRevert: true,
				});
				const published = yield* Fiber.join(update);
			yield* FiberMap.awaitEmpty((yield* ProjectSettingsTag).modelDiscovery);
				expect(Option.isSome(published)).toBe(true);
				if (Option.isSome(published)) expect(published.value).toMatchObject({
					_tag: "upsert", item: { _tag: "providerModels", providers: [{ id: "claude", models: [{ id: "sonnet", variants: ["high"] }] }] },
				});
				const snapshot = yield* subscribeProjectSettings().pipe(Stream.runHead);
				expect(Option.isSome(snapshot) && snapshot.value._tag === "snapshot" &&
					snapshot.value.rows.some((row) => row._tag === "providerModels")).toBe(true);
				readyCapabilities = { ...(yield* Deferred.await(pending)), models: [{ id: "opus", name: "Opus", providerId: "claude" }] };
				const refreshSubscribed = yield* Deferred.make<void>();
				const refreshedUpdate = yield* subscribeProjectSettings().pipe(
					Stream.tap((envelope) => envelope._tag === "synchronized" ? Deferred.succeed(refreshSubscribed, undefined) : Effect.void),
					Stream.filter((envelope) => envelope._tag === "upsert" && envelope.item._tag === "providerModels"),
					Stream.runHead, Effect.fork,
				);
				yield* Deferred.await(refreshSubscribed);
				const refreshed = yield* getModelsResponse({ instanceId: "claude" });
				expect(refreshed.providers).toEqual([]);
				expect(Option.getOrThrow(yield* Fiber.join(refreshedUpdate))).toMatchObject({
					_tag: "upsert", item: { _tag: "providerModels", providers: [{ id: "claude", models: [{ id: "opus" }] }] },
				});
				const refreshedSnapshot = yield* subscribeProjectSettings().pipe(Stream.runHead);
				expect(Option.isSome(refreshedSnapshot) && refreshedSnapshot.value._tag === "snapshot" &&
					refreshedSnapshot.value.rows.some((row) => row._tag === "providerModels" && row.providers[0]?.models[0]?.id === "opus")).toBe(true);
			}).pipe(Effect.provide(deps));
		});
	});

	it.effect(
		"switches OpenCode variants using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-1"),
			});
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
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
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-variant-")),
					}),
				),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				yield* setModel("session-1", {
					providerID: "openai",
					modelID: "gpt-4",
				});
				const result = yield* switchVariantForSession({
					clientId: "client-1",
					sessionId: "session-1",
					variant: "fast",
				});
				expect(yield* getVariant("session-1")).toBe("fast");
				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(result).toEqual({
					variant: "fast",
					variants: ["standard", "fast"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect(
		"switches a stored OpenCode session model using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler({
				getClientSession: vi.fn(() => "session-model-switch"),
			});
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
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
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-switch-model-")),
					}),
				),
				makeOverridesStateLive(),
			);

			return Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).recover();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions
					(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
					VALUES ('session-model-switch', 'opencode', 'Stored session', 'openai', 'gpt-4', '', '', 1, 1)`;
				return yield* switchModelForSession({
					clientId: "client-1",
					sessionId: "session-model-switch",
					modelId: "gpt-4",
					providerId: "openai",
				});
			}).pipe(
				Effect.provide(layer),
				Effect.tap((result) => {
					expect(modelService.listProviders).toHaveBeenCalledOnce();
					expect(result).toEqual({
						model: "gpt-4",
						provider: "openai",
						variant: "",
						variants: ["standard", "fast"],
						contextWindow: { contextWindow: "", options: [] },
					});
				}),
			);
		},
	);

	it.effect(
		"sets the OpenCode default model using the model service without requiring the Promise OpenCode API tag",
		() => {
			const wsHandler = makeMockWebSocketHandler();
			const logger = makeMockLogger();
			const modelService = {
				listProviders: vi.fn(() =>
					Effect.succeed({
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
					}),
				),
				cachedProviders: vi.fn(() => Effect.succeedNone),
				persistDefaultModel: vi.fn(() => Effect.succeed(undefined)),
			};

			const layer = Layer.mergeAll(
				Layer.succeed(OpenCodeModelServiceTag, modelService),
				Layer.succeed(WebSocketHandlerTag, wsHandler),
				Layer.succeed(LoggerTag, logger),
				Layer.succeed(
					ConfigTag,
					makeMockConfig({
						configDir: mkdtempSync(join(tmpdir(), "conduit-default-model-")),
						projectDir: mkdtempSync(join(tmpdir(), "conduit-project-")),
					}),
				),
				makeOverridesStateLive(),
				ProjectSettingsLive,
			);

			return Effect.gen(function* () {
				const result = yield* setDefaultModelForRelay({
					clientId: "client-1",
					model: "gpt-4",
					provider: "openai",
				});
				expect(yield* getDefaultModel()).toEqual({
					providerID: "openai",
					modelID: "gpt-4",
				});
				expect(yield* getDefaultVariant()).toBe("");
				expect(modelService.persistDefaultModel).toHaveBeenCalledWith(
					"openai",
					"gpt-4",
				);
				expect(modelService.listProviders).toHaveBeenCalledOnce();
				expect(result).toMatchObject({
					variant: "",
					variants: ["standard", "fast"],
				});
			}).pipe(Effect.provide(layer));
		},
	);

	it.effect("keeps cold model discovery non-starting, refreshes live data and retains it after stop", () => {
		const catalog = { providers: [], defaults: { fake: "fake-model" }, connected: ["fake"] };
		const api = makeHandlerOpenCodeAPI({ provider: { list: vi.fn(async () => catalog) } });
		let running = false;
		const instances = {
			...makeOpenCodeInstancesStub({ opencode: api }),
			use: vi.fn(() => Effect.succeed(api)),
			ifRunning: vi.fn(() => Effect.succeed(running ? Option.some(api) : Option.none())),
		};
		return Effect.gen(function* () {
			const models = yield* OpenCodeModelServiceTag;
			expect(yield* models.listProviders()).toEqual({ providers: [], defaults: {}, connected: [] });
			expect(instances.use).not.toHaveBeenCalled();
			expect(api.provider.list).not.toHaveBeenCalled();
			running = true;
			expect(yield* models.listProviders()).toEqual(catalog);
			expect(api.provider.list).toHaveBeenCalledOnce();
			running = false;
			expect(yield* models.listProviders()).toEqual(catalog);
			expect(instances.use).not.toHaveBeenCalled();
			expect(api.provider.list).toHaveBeenCalledOnce();
		}).pipe(Effect.provide(OpenCodeModelServiceLive.pipe(Layer.provide(Layer.mergeAll(
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(OpenCodeInstancesTag, instances),
			Layer.succeed(ConfigTag, makeMockConfig()),
			Layer.succeed(LoggerTag, makeMockLogger()),
		)))));
	});

	it.effect("honours the harness's native default for drafts independently of project defaults and session picks", () => {
		let running = false;
		const nativeConfig = { model: "fake/model-b" };
		const api = makeHandlerOpenCodeAPI({
			config: { get: vi.fn(async () => nativeConfig) },
			provider: { list: vi.fn(async () => ({
				connected: ["fake"],
				defaults: { fake: "model-a" },
				providers: [{ id: "fake", name: "Fake", models: [
					{ id: "model-a", name: "A" },
					{ id: "model-b", name: "B" },
				] }],
			})) },
		});
		const instances = {
			...makeOpenCodeInstancesStub({ opencode: api }),
			use: vi.fn(() => Effect.succeed(api)),
			ifRunning: vi.fn(() => Effect.succeed(running ? Option.some(api) : Option.none())),
		};
		const configDir = mkdtempSync(join(tmpdir(), "conduit-native-default-"));
		const config = makeMockConfig({ configDir });
		writeFileSync(join(configDir, "daemon.json"), JSON.stringify({
			pid: 1234, port: 0, pinHash: null, tls: false, debug: false,
			keepAwake: false, projects: [],
			instances: [{ id: "work-claude", name: "Work Claude", port: 0, managed: false, driver: "claude" }],
		}));
		const deps = Layer.mergeAll(
			AccountDirectoryFromConfigLive(configDir, configuredClaudeConfigDir(join(configDir, "login"))),
			Layer.succeed(OpenCodeAPITag, api),
			Layer.succeed(OpenCodeInstancesTag, instances),
			Layer.succeed(ConfigTag, config),
			Layer.succeed(LoggerTag, makeMockLogger()),
			Layer.succeed(WebSocketHandlerTag, makeMockWebSocketHandler()),
			Layer.succeed(OrchestrationEngineTag, withDispatchEffect({
				getProviderForSessionEffect: (sessionId: string) => Effect.succeed(
					sessionId === "opencode-session" ? "opencode" : sessionId === "claude-session" ? "claude" : "work-claude",
				),
				dispatch: vi.fn(async () => ({ models: [], commands: [] })),
			})),
			makeOverridesStateLive(),
			ProjectSettingsLive,
		);
		const models = OpenCodeModelServiceLive.pipe(Layer.provide(deps));
		return Effect.gen(function* () {
			const cold = yield* getModelsResponse({ instanceId: "opencode" });
			expect(cold.providers).toEqual([]);
			expect(api.config.get).not.toHaveBeenCalled();
			expect(api.provider.list).not.toHaveBeenCalled();
			running = true;
			const live = yield* getModelsResponse({ instanceId: "opencode" });
			expect(live.active).toEqual({ provider: "fake", model: "model-b" });
			expect(live.providers[0]?.models.map(({ id }) => id)).toEqual(["model-a", "model-b"]);
			expect(yield* getDefaultModel()).toEqual({ providerID: "fake", modelID: "model-b" });
			yield* refreshGlobalDefaults;
			expect(yield* getDefaultModel()).toEqual({ providerID: "fake", modelID: "model-b" });
			expect((yield* getModelsResponse({ instanceId: "opencode", sessionId: "opencode-session" })).active).toBeUndefined();
			for (const sessionId of ["claude-session", "named-claude-session"]) {
				expect((yield* getModelsResponse({ sessionId })).active).toBeUndefined();
			}
			yield* setDefaultModel({ providerID: "fake", modelID: "model-a" });
			expect((yield* getModelsResponse({ instanceId: "opencode" })).active).toEqual({ provider: "fake", model: "model-b" });
			running = false;
			expect((yield* getModelsResponse({ instanceId: "opencode" })).active).toEqual({ provider: "fake", model: "model-b" });
			expect(instances.use).not.toHaveBeenCalled();
			expect(api.config.get).toHaveBeenCalledTimes(5);
		}).pipe(Effect.provide(Layer.merge(deps, models)));
	});

	it.effect(
		"persists OpenCode default model and relocates the config write in the live model service",
		() => {
			const projectDir = mkdtempSync(join(tmpdir(), "conduit-model-live-"));
			const configDir = mkdtempSync(join(tmpdir(), "conduit-model-live-cfg-"));
			const logger = makeMockLogger();
			const api = makeHandlerOpenCodeAPI({
				config: {
					update: vi.fn(async (patch: Record<string, unknown>) => {
						await writeFile(
							join(projectDir, "config.json"),
							`${JSON.stringify(patch)}\n`,
						);
					}),
				},
				provider: {
					list: vi.fn(async () => ({
						connected: [],
						defaults: {},
						providers: [],
					})),
				},
				session: {
					get: vi.fn(async () => ({
						id: "session",
						projectID: "project",
						directory: projectDir,
						title: "Session",
						version: "1.0.0",
						time: { created: 0, updated: 0 },
					})),
				},
			});

			const layer = OpenCodeModelServiceLive.pipe(
				Layer.provide(
					Layer.mergeAll(
						Layer.succeed(OpenCodeAPITag, api),
						Layer.succeed(
							OpenCodeInstancesTag,
							makeOpenCodeInstancesStub({ opencode: api }),
						),
						Layer.succeed(ConfigTag, makeMockConfig({ configDir, projectDir })),
						Layer.succeed(LoggerTag, logger),
					),
				),
			);

			return Effect.gen(function* () {
				const modelService = yield* OpenCodeModelServiceTag;
				yield* modelService.persistDefaultModel("openai", "gpt-4");
			}).pipe(
				Effect.provide(layer),
				Effect.tap(() => {
					expect(api.config.update).toHaveBeenCalledWith({
						model: "openai/gpt-4",
					});
					expect(existsSync(join(projectDir, "config.json"))).toBe(false);
					expect(
						JSON.parse(
							readFileSync(join(projectDir, "opencode.json"), "utf-8"),
						),
					).toEqual({
						model: "openai/gpt-4",
					});
					expect(logger.info).toHaveBeenCalledWith(
						expect.stringContaining("Merged config.json"),
					);
				}),
			);
		},
	);
});
});
