import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { saveDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { setAgent } from "../../../src/lib/domain/relay/Services/session-overrides-state.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

describe("WsRpcServerLayer GetAgents", () => {
	it.effect("returns filtered agents and the active session override", () => {
		const configDir = mkdtempSync(join(tmpdir(), "conduit-rpc-agents-"));
		const api = makeMockOpenCodeAPI();
		api.app.agents = vi.fn(async () => [
			{ id: "build", name: "build", description: "Build things" },
			{ id: "plan", name: "plan" },
			{ id: "hidden", name: "hidden", hidden: true },
			{ id: "summarize", name: "summarize" },
		]) as typeof api.app.agents;

		return Effect.gen(function* () {
			yield* setAgent("session-1", "plan");
			const client = yield* RpcTest.makeClient(WsRpcGroup);

			const result = yield* client.GetAgents({
				projectSlug: "project-a",
				sessionId: "session-1",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				providerScope: { id: "opencode", name: "OpenCode" },
				agents: [
					{ id: "build", name: "build", description: "Build things" },
					{ id: "plan", name: "plan" },
				],
				activeAgentId: "plan",
				hiddenAgents: [],
			});
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
	});

	it.effect(
		"scopes a configured instance request to its resolved driver",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-agents-instance-"),
			);
			const api = makeMockOpenCodeAPI();
			api.app.agents = vi.fn(async () => [
				{ id: "build", name: "build", mode: "primary" },
				{ id: "internal", name: "internal", mode: "subagent" },
			]) as typeof api.app.agents;
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [],
					supportsTools: true,
					supportsThinking: true,
					supportsPermissions: true,
					supportsQuestions: true,
					supportsAttachments: true,
					supportsFork: false,
					supportsRevert: false,
					commands: [],
					agents: [
						{ id: "Explore", name: "Explore", description: "Claude only" },
					],
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
									id: "opencode-work",
									name: "OpenCode Work",
									port: 4096,
									managed: false,
									driver: "opencode",
								},
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
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const claudeResult = yield* client.GetAgents({
					projectSlug: "project-a",
					instanceId: "claude-work",
				});
				const openCodeResult = yield* client.GetAgents({
					projectSlug: "project-a",
					instanceId: "opencode-work",
				});

				expect(claudeResult).toEqual({
					projectSlug: "project-a",
					instanceId: "claude-work",
					providerScope: { id: "claude", name: "Claude" },
					agents: [
						{ id: "Explore", name: "Explore", description: "Claude only" },
					],
					hiddenAgents: [],
				});
				expect(openCodeResult).toEqual({
					projectSlug: "project-a",
					instanceId: "opencode-work",
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [{ id: "build", name: "build" }],
					hiddenAgents: [],
				});
				expect(api.app.agents).toHaveBeenCalledOnce();
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
		"returns an empty snapshot for an unknown configured driver",
		() => {
			const configDir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-agents-unknown-driver-"),
			);
			const api = makeMockOpenCodeAPI();
			const orchestrationEngine = withDispatchEffect({
				dispatch: vi.fn(async () => ({
					models: [],
					agents: [{ id: "future", name: "Future" }],
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
				const client = yield* RpcTest.makeClient(WsRpcGroup);
				const result = yield* client.GetAgents({
					projectSlug: "project-a",
					instanceId: "future-work",
				});

				expect(result).toEqual({
					projectSlug: "project-a",
					instanceId: "future-work",
					providerScope: { id: "opencode", name: "OpenCode" },
					agents: [],
					hiddenAgents: [],
				});
				expect(api.app.agents).not.toHaveBeenCalled();
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
});
