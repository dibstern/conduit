import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { saveDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import {
	setDefaultContextWindow,
	setDefaultVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import {
	type ReadQueryEffect,
	ReadQueryEffectError,
	ReadQueryEffectTag,
} from "../../../src/lib/persistence/effect/read-query-effect.js";
import type { ClaudeCapabilitiesService } from "../../../src/lib/provider/claude/claude-capabilities-service.js";
import { ClaudeProviderInstance } from "../../../src/lib/provider/claude/claude-provider-instance.js";
import type { SDKMessage } from "../../../src/lib/provider/claude/types.js";
import { createRelayEventSink } from "../../../src/lib/provider/relay-event-sink.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { createMockQuery, makeSuccessResult } from "../../helpers/mock-sdk.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";
import { providerRuntimeEvent } from "../../helpers/provider-runtime-event.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

const makeReadQuery = (
	getLatestTurnModelExecution: NonNullable<
		ReadQueryEffect["getLatestTurnModelExecution"]
	>,
): ReadQueryEffect => ({
	getToolContent: () => Effect.succeed(undefined),
	getSessionStatus: () => Effect.succeed(undefined),
	getSession: () => Effect.succeed(undefined),
	getAllSessionStatuses: () => Effect.succeed({}),
	listSessions: () => Effect.succeed([]),
	getSessionMessagesWithParts: () => Effect.succeed([]),
	getLatestTurnModelExecution,
});

describe("WsRpcServerLayer GetModels", () => {
	it.effect(
		"returns drifted, matching, and unknown model execution evidence",
		() => {
			const api = makeMockOpenCodeAPI();
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "sonnet",
							name: "Sonnet",
							resolvedModel: "claude-sonnet-5",
						},
					],
				})),
			});
			for (const sessionId of ["drift", "match", "unknown"]) {
				orchestrationEngine.bindSession(sessionId, "claude");
			}
			const readQuery = makeReadQuery((sessionId) =>
				Effect.succeed(
					sessionId === "drift"
						? {
								requested_model: "sonnet",
								expected_model: "claude-sonnet-5",
								actual_model: "claude-fable-4-0",
							}
						: sessionId === "match"
							? {
									requested_model: "sonnet",
									expected_model: "claude-sonnet-5",
									actual_model: "claude-sonnet-5",
								}
							: {
									requested_model: "agent-model",
									expected_model: null,
									actual_model: "claude-sonnet-5",
								},
				),
			);

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const drift = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "drift",
				});
				const match = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "match",
				});
				const unknown = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "unknown",
				});

				expect(drift.modelExecution).toEqual({
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5",
					actualModel: "claude-fable-4-0",
					drifted: true,
				});
				expect(match.modelExecution).toEqual({
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5",
					actualModel: "claude-sonnet-5",
					drifted: false,
				});
				expect(unknown.modelExecution).toEqual({
					requestedModel: "agent-model",
					actualModel: "claude-sonnet-5",
				});
				expect(drift.providers[0]?.models[0]).not.toHaveProperty(
					"resolvedModel",
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							Layer.merge(
								makeTestHandlerLayer({ api, orchestrationEngine }),
								Layer.succeed(ReadQueryEffectTag, readQuery),
							),
						),
					),
				),
			);
		},
	);

	it.effect("omits model execution without a session or resolved row", () => {
		const getLatestTurnModelExecution = vi.fn((_sessionId: string) =>
			Effect.succeed(undefined),
		);
		const readQuery = makeReadQuery(getLatestTurnModelExecution);

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const noSession = yield* client.GetModels({ projectSlug: "project-a" });
			expect(noSession.modelExecution).toBeUndefined();
			expect(getLatestTurnModelExecution).not.toHaveBeenCalled();

			const noRow = yield* client.GetModels({
				projectSlug: "project-a",
				sessionId: "session-1",
			});
			expect(noRow.modelExecution).toBeUndefined();
			expect(getLatestTurnModelExecution).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						Layer.merge(
							makeTestHandlerLayer(),
							Layer.succeed(ReadQueryEffectTag, readQuery),
						),
					),
				),
			),
		);
	});

	it.effect(
		"keeps GetModels successful when the model execution read fails",
		() => {
			const readQuery = makeReadQuery(() =>
				Effect.fail(
					new ReadQueryEffectError({
						operation: "getLatestTurnModelExecution",
						cause: new Error("database unavailable"),
					}),
				),
			);

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "session-1",
				});
				expect(result.providers).toBeDefined();
				expect(result.modelExecution).toBeUndefined();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							Layer.merge(
								makeTestHandlerLayer(),
								Layer.succeed(ReadQueryEffectTag, readQuery),
							),
						),
					),
				),
			);
		},
	);

	it.effect(
		"carries runtime model resolution through persistence into GetModels",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "conduit-rpc-model-execution-"));
			const persistenceLayer = makePersistenceEffectLayer(
				join(dir, "events.db"),
			);
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "sonnet",
							name: "Sonnet",
							resolvedModel: "claude-sonnet-5",
						},
					],
				})),
			});
			orchestrationEngine.bindSession("match-session", "claude");
			orchestrationEngine.bindSession("drift-session", "claude");

			return Effect.gen(function* () {
				const persist = yield* ClaudeEventPersistEffectTag;
				const matchSink = createRelayEventSink({
					sessionId: "match-session",
					send: vi.fn(),
					persist,
				});
				const driftSink = createRelayEventSink({
					sessionId: "drift-session",
					send: vi.fn(),
					persist,
				});
				for (const [sessionId, sink, actualModel] of [
					["match-session", matchSink, "claude-sonnet-5[1m]"] as const,
					["drift-session", driftSink, "claude-fable-4-0"] as const,
				]) {
					yield* sink.push(
						providerRuntimeEvent(
							"message.created",
							sessionId,
							{
								messageId: `${sessionId}-user`,
								role: "user",
								sessionId,
							},
							{
								eventId: `${sessionId}-message`,
							},
						),
					);
					const capabilitiesService: ClaudeCapabilitiesService = {
						get: vi.fn(() =>
							Effect.succeed({
								models: [
									{
										id: "sonnet",
										name: "Sonnet",
										providerId: "claude",
										resolvedModel: "claude-sonnet-5",
									},
								],
								commands: [],
								agents: [],
							}),
						),
					};
					const initMessage = {
						type: "system",
						subtype: "init",
						apiKeySource: "api_key",
						claude_code_version: "1.0.0",
						cwd: "/tmp/ws",
						tools: [],
						mcp_servers: [],
						model: actualModel,
						permissionMode: "default",
						slash_commands: [],
						output_style: "text",
						skills: [],
						plugins: [],
						uuid: "00000000-0000-0000-0000-000000000001",
						session_id: `${sessionId}-sdk`,
					} as unknown as SDKMessage;
					const instance = new ClaudeProviderInstance({
						workspaceRoot: "/tmp/ws",
						capabilitiesService,
						queryFactory: vi.fn(() =>
							createMockQuery([
								initMessage,
								makeSuccessResult({ session_id: `${sessionId}-sdk` }),
							]),
						),
					});
					yield* instance.sendTurnEffect({
						sessionId,
						turnId: `${sessionId}-turn`,
						prompt: "Use Sonnet with a 1M context window",
						history: [],
						providerState: {},
						workspaceRoot: "/tmp/ws",
						eventSink: sink,
						abortSignal: new AbortController().signal,
						model: { providerId: "claude", modelId: "sonnet" },
						contextWindow: "1m",
					});
				}

				const client = yield* rpcClient;
				const match = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "match-session",
				});
				const drift = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "drift-session",
				});
				expect(match.modelExecution).toEqual({
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5[1m]",
					actualModel: "claude-sonnet-5[1m]",
					drifted: false,
				});
				expect(drift.modelExecution).toEqual({
					requestedModel: "sonnet",
					expectedModel: "claude-sonnet-5[1m]",
					actualModel: "claude-fable-4-0",
					drifted: true,
				});
				expect(match.providers[0]?.models[0]).not.toHaveProperty(
					"resolvedModel",
				);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							Layer.merge(
								makeTestHandlerLayer({ orchestrationEngine }),
								persistenceLayer,
							),
						),
					),
				),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect(
		"returns provider list, active session model, variant, and context window",
		() => {
			const api = makeMockOpenCodeAPI();
			api.provider.list = vi.fn(async () => ({
				connected: ["anthropic"],
				defaults: {},
				providers: [
					{
						id: "anthropic",
						name: "Anthropic",
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								variants: { fast: {}, careful: {} },
							},
						],
					},
					{
						id: "local",
						name: "Local",
						models: [{ id: "offline", name: "Offline" }],
					},
				],
			})) as typeof api.provider.list;
			api.session.get = vi.fn(async () => ({
				id: "session-1",
				projectID: "project-1",
				directory: "/tmp/project",
				title: "Session 1",
				version: "1.0.0",
				time: { created: 0, updated: 0 },
				modelID: "claude-sonnet",
				providerID: "claude",
			}));
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [
						{
							id: "claude-sonnet",
							name: "Claude Sonnet",
							variants: { fast: {}, careful: {} },
							contextWindowOptions: [
								{ value: "200k", label: "200K", isDefault: true },
							],
						},
					],
				})),
			});

			return Effect.gen(function* () {
				yield* setDefaultVariant("careful");
				yield* setDefaultContextWindow("200k");
				const client = yield* rpcClient;

				const result = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "session-1",
				});

				expect(result.projectSlug).toBe("project-a");
				expect(result.providers).toEqual([
					{
						id: "anthropic",
						name: "Anthropic - opencode",
						configured: true,
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								provider: "anthropic",
								variants: ["fast", "careful"],
							},
						],
					},
					{
						id: "claude",
						name: "Anthropic - claude",
						configured: true,
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								provider: "claude",
								variants: ["fast", "careful"],
								contextWindowOptions: [
									{ value: "200k", label: "200K", isDefault: true },
								],
							},
						],
					},
				]);
				expect(result.active).toEqual({
					model: "claude-sonnet",
					provider: "claude",
				});
				expect(result.variant).toEqual({
					variant: "careful",
					variants: ["fast", "careful"],
				});
				expect(result.permissionMode).toBe("ask");
				expect(result.contextWindow).toEqual({
					contextWindow: "200k",
					options: [{ value: "200k", label: "200K", isDefault: true }],
				});
				expect(result.modelExecution).toBeUndefined();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								orchestrationEngine,
								config: makeMockConfig({
									configDir: mkdtempSync(join(tmpdir(), "conduit-rpc-models-")),
								}),
							}),
						),
					),
				),
			);
		},
	);

	it.effect(
		"returns only the requested configured instance driver snapshot",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-models-instance-"),
			);
			const api = makeMockOpenCodeAPI();
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
					agents: [],
				})),
			});

			return Effect.gen(function* () {
				yield* Effect.tryPromise(() =>
					saveDaemonConfig(
						{
							pid: process.pid,
							port: 2633,
							pinHash: null,
							tls: false,
							debug: false,
							keepAwake: false,
							dangerouslySkipPermissions: false,
							projects: [],
							instances: [
								{
									id: "claude-work",
									name: "Claude Work",
									port: 0,
									managed: false,
									driver: "claude",
								},
							],
						},
						configDir,
					),
				);
				const client = yield* rpcClient;
				const result = yield* client.GetModels({
					projectSlug: "project-a",
					instanceId: "claude-work",
				});

				expect(result.instanceId).toBe("claude-work");
				expect(result.providers).toEqual([
					{
						id: "claude",
						instanceId: "claude-work",
						name: "Anthropic - claude",
						configured: true,
						models: [
							{
								id: "claude-sonnet",
								name: "Claude Sonnet",
								provider: "claude",
							},
						],
					},
				]);
				expect(api.provider.list).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								orchestrationEngine,
								config: makeMockConfig({ configDir }),
							}),
						),
					),
				),
			);
		},
	);

	it.effect(
		"returns an empty scoped model snapshot when OpenCode is unavailable",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-models-empty-"),
			);
			const api = makeMockOpenCodeAPI();
			api.provider.list = vi.fn(async () => {
				throw new Error("opencode offline");
			}) as typeof api.provider.list;

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* client.GetModels({
					projectSlug: "project-a",
					instanceId: "opencode",
				});

				expect(result.instanceId).toBe("opencode");
				expect(result.providers).toEqual([]);
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								config: makeMockConfig({ configDir }),
							}),
						),
					),
				),
			);
		},
	);

	it.effect(
		"omits active model metadata from a differently scoped instance",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-models-active-scope-"),
			);
			const api = makeMockOpenCodeAPI();
			api.provider.list = vi.fn(async () => ({
				connected: ["openai"],
				defaults: {},
				providers: [
					{
						id: "openai",
						name: "OpenAI",
						models: [{ id: "gpt-5", name: "GPT-5" }],
					},
				],
			})) as typeof api.provider.list;
			api.session.get = vi.fn(async () => {
				throw new Error("must not read an OpenCode session for Claude");
			}) as typeof api.session.get;
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [{ id: "claude-sonnet", name: "Claude Sonnet" }],
					agents: [],
				})),
			});
			orchestrationEngine.bindSession("session-1", "claude");

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* client.GetModels({
					projectSlug: "project-a",
					sessionId: "session-1",
					instanceId: "opencode",
				});

				expect(result.instanceId).toBe("opencode");
				expect(result.active).toBeUndefined();
				expect(api.session.get).not.toHaveBeenCalled();
				expect(orchestrationEngine.dispatch).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								api,
								orchestrationEngine,
								config: makeMockConfig({ configDir }),
							}),
						),
					),
				),
			);
		},
	);

	it.effect("returns an empty model snapshot for an unknown driver", () => {
		const configDir = mkdtempSync(
			join(tmpdir(), "conduit-rpc-models-unknown-driver-"),
		);
		const api = makeMockOpenCodeAPI();
		const orchestrationEngine = withDispatchEffect({
			dispatch: vi.fn(async () => ({
				models: [{ id: "future-model", name: "Future Model" }],
				agents: [],
			})),
		});

		return Effect.gen(function* () {
			yield* Effect.tryPromise(() =>
				saveDaemonConfig(
					{
						pid: process.pid,
						port: 2633,
						pinHash: null,
						tls: false,
						debug: false,
						keepAwake: false,
						dangerouslySkipPermissions: false,
						projects: [],
						instances: [
							{
								id: "future-work",
								name: "Future Work",
								port: 0,
								managed: false,
								driver: "future-driver",
							},
						],
					},
					configDir,
				),
			);
			const client = yield* rpcClient;
			const result = yield* client.GetModels({
				projectSlug: "project-a",
				instanceId: "future-work",
			});

			expect(result.instanceId).toBe("future-work");
			expect(result.providers).toEqual([]);
			expect(result.active).toBeUndefined();
			expect(api.provider.list).not.toHaveBeenCalled();
			expect(orchestrationEngine.dispatch).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							orchestrationEngine,
							config: makeMockConfig({ configDir }),
						}),
					),
				),
			),
		);
	});
});
