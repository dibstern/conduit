import { mkdtempSync } from "node:fs";
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
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer GetModels", () => {
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
