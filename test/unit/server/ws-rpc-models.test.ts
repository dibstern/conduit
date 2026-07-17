import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import {
	setDefaultContextWindow,
	setDefaultVariant,
} from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
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
							makeTestHandlerLayer({ api, orchestrationEngine }),
						),
					),
				),
			);
		},
	);
});
