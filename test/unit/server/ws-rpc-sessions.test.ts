import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { RpcTest } from "effect/rpc";
import { SqlClient } from "effect/sql";
import { expect, vi } from "vitest";
import { AccountIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { OpenCodeUnavailable } from "../../../src/lib/domain/daemon/Services/opencode-instances-service.js";
import { GoalSummaryServiceTag } from "../../../src/lib/domain/relay/Services/goal-summary-service.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import { SessionManagerError } from "../../../src/lib/domain/relay/Services/session-manager-error.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { ClaudeEventPersistEffectTag } from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import {
	EventStoreEffectTag,
	EventStoreError,
} from "../../../src/lib/persistence/effect/event-store-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProjectionRunnerEffectTag } from "../../../src/lib/persistence/effect/projection-runner-effect.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { refreshSidebar } from "../../../src/lib/persistence/effect/sidebar-projection.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { configuredClaudeConfigDir } from "../../../src/lib/provider/claude/claude-sdk-env.js";
import { CLAUDE_FORK_SOURCE_KEY } from "../../../src/lib/provider/claude/claude-session-fork.js";
import { makePrepareTurn } from "../../../src/lib/provider/claude/prepare-turn.js";
import { ProviderRegistry } from "../../../src/lib/provider/provider-registry.js";
import type { ProviderInstance } from "../../../src/lib/provider/types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockAccountDirectory,
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";
import { withDispatchEffect } from "../../helpers/orchestration-engine-test-double.js";

const makeModelApi = () => {
	const api = makeMockOpenCodeAPI();
	vi.mocked(api.provider.list).mockResolvedValue({
		providers: [
			{
				id: "openai",
				name: "OpenAI",
				models: [{ id: "gpt-4", name: "GPT-4" }],
			},
		],
		defaults: {},
		connected: ["openai"],
	});
	return api;
};

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer GenerateGoalSummary", () => {
	it.effect(
		"goal RPCs keep missing-session and unsupported-provider guards and only generate on request",
		() => {
			const summary = {
				text: "Upload needs a release credential.",
				generatedAt: 300,
				stale: false,
			};
			const generate = vi.fn(() => Effect.succeed(summary));
			const layer = Layer.merge(
				makeTestHandlerLayer({
					persistenceLayer: makePersistenceEffectLayer(
						":memory:",
						"test-project",
					),
				}),
				Layer.succeed(GoalSummaryServiceTag, {
					metadata: () =>
						Effect.succeed({ summary: null, summaryEnabled: true }),
					generate,
				}),
			);
			return Effect.gen(function* () {
				yield* (yield* ProjectionRunnerEffectTag).recover();
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO sessions (id, project_id, provider, title, created_at, updated_at)
				VALUES ('claude-goal', 'test-project', 'claude', 'Goal', 1, 1),
				('opencode-goal', 'test-project', 'opencode', 'Goal', 1, 1)`;
				const client = yield* rpcClient;
				const before = yield* client.GetGoalDetails({
					sessionId: "claude-goal",
				});
				for (const [sessionId, message] of [
					["missing", "Session missing not found"],
					[
						"opencode-goal",
						"Goal summaries are available only for Claude sessions",
					],
				] as const) {
					expect(
						yield* Effect.result(client.GenerateGoalSummary({ sessionId })),
					).toMatchObject({
						_tag: "Failure",
						failure: { _tag: "WsRpcError", message },
					});
				}
				expect(generate).not.toHaveBeenCalled();
				expect(
					yield* client.GenerateGoalSummary({ sessionId: "claude-goal" }),
				).toEqual(summary);
				expect(generate).toHaveBeenCalledExactlyOnceWith("claude-goal");
				expect(
					yield* client.GetGoalDetails({ sessionId: "claude-goal" }),
				).toEqual(before);
				expect(before).not.toHaveProperty("stuck");
				expect(before).toMatchObject({ summary: null, summaryEnabled: true });
			}).pipe(Effect.provide(WsRpcServerLayer.pipe(Layer.provideMerge(layer))));
		},
	);
});

describe("WsRpcServerLayer ResolveSession", () => {
	it.effect("uses session manager existence with persistence", () => {
		const sessionExists = vi.fn((sessionId: string) =>
			Effect.succeed(sessionId === "existing"),
		);
		const layer = makeTestHandlerLayer({
			config: makeMockConfig({ slug: "project-a" }),
			sessionManagerService: makeMockSessionManagerService({ sessionExists }),
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			expect(yield* client.ResolveSession({ sessionId: "existing" })).toEqual({
				projectSlug: "project-a",
			});
			expect(
				yield* Effect.result(client.ResolveSession({ sessionId: "missing" })),
			).toMatchObject({
				_tag: "Failure",
				failure: { _tag: "WsRpcError", message: "Unknown session: missing" },
			});
			expect(sessionExists).toHaveBeenCalledWith("existing");
			expect(sessionExists).toHaveBeenCalledWith("missing");
		}).pipe(
			Effect.provide(WsRpcServerLayer.pipe(Layer.provideMerge(layer)), {
				local: true,
			}),
		);
	});
});

describe("WsRpcServerLayer ListSessions", () => {
	// The root's row shows only its own snooze, so a child waking is not a
	// visible change and the root is not resent.
	it.effect("does not resend a root summary when only a child wakes", () =>
		Effect.gen(function* () {
			const projections = yield* ProjectionRunnerEffectTag;
			yield* projections.recover();
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, project_id, provider, title, created_at, updated_at, version)
				VALUES ('root', 'test-project', 'claude', 'Root', 1, 1, 1)`;
			yield* sql`INSERT INTO sessions
				(id, project_id, provider, title, parent_id, created_at, updated_at, version, snoozed_at)
				VALUES ('child', 'test-project', 'claude', 'Child', 'root', 1, 1, 1, 2)`;
			yield* sql`UPDATE read_model_counter SET value = 1 WHERE id = 1`;
			yield* sql`UPDATE sessions SET root_id = 'root'`;
			yield* refreshSidebar(["root"], 1);
			const reader = yield* ReadQueryEffectTag;
			const before = yield* reader.readSessionList({
				projectIds: ["test-project"],
			});
			expect(before.rows.map(({ item }) => item.id)).toEqual(["root"]);
			expect(before.rows[0]?.version).toBe(1);
			yield* sql`UPDATE sessions SET woken_at = 3, woken_reason = 'activity', version = 2
				WHERE id = 'child'`;
			yield* sql`UPDATE read_model_counter SET value = 2 WHERE id = 1`;
			yield* refreshSidebar(["child"], 2);
			const after = yield* reader.readSessionList(
				{ projectIds: ["test-project"] },
				{ after: 1 },
			);
			expect(after).toEqual({
				rows: [],
				version: 2,
				removed: [],
				removedSince: 0,
			});
		}).pipe(
			Effect.provide(makePersistenceEffectLayer(":memory:", "test-project"), {
				local: true,
			}),
		),
	);

	it.effect("creates a session for the originating browser tab", () => {
		const api = makeModelApi();
		const createSession = vi.fn(() =>
			Effect.succeed({
				id: "session-new",
				title: "New Session",
			} as unknown as SessionDetail),
		);
		const wsHandler = makeMockWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			createSession,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CreateSession({
				permissionMode: "ask",
				projectSlug: "project-a",
				originId: "browser-tab-a",
				instanceId: AccountIdSchema.make("opencode"),
				providerId: "opencode",
				model: {
					providerId: "openai",
					modelId: "gpt-4",
					variant: "",
					contextWindow: "",
				},
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				sessionId: "session-new",
			});
			expect(createSession).toHaveBeenCalledWith(undefined, {
				account: expect.objectContaining({
					id: "opencode",
					driver: "opencode",
				}),
				permissionMode: "ask",
				pick: {
					harness: "opencode",
					model: { providerId: "openai", modelId: "gpt-4" },
					effort: "",
					contextWindow: "",
				},
			});
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-new",
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ api, wsHandler, sessionManagerService }),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect(
		"rejects a worktree base without a new worktree before creating a session",
		() => {
			const createSession = vi.fn(() =>
				Effect.fail(
					new SessionManagerError({
						operation: "createSession",
						cause: new Error("Must not create"),
					}),
				),
			);
			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const result = yield* Effect.result(
					client.CreateSession({
						permissionMode: "ask",
						projectSlug: "project-a",
						originId: "browser-tab-a",
						worktreeBase: "main",
					}),
				);
				expect(result).toMatchObject({
					_tag: "Failure",
					failure: {
						_tag: "WsRpcError",
						message: expect.stringContaining(
							"worktreeBase requires newWorktree",
						),
					},
				});
				expect(createSession).not.toHaveBeenCalled();
			}).pipe(
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								sessionManagerService: makeMockSessionManagerService({
									createSession,
								}),
							}),
						),
					),
					{ local: true },
				),
			);
		},
	);

	it.effect(
		"preserves an unavailable instance's cause in the CreateSession error without auth details",
		() => {
			const dir = mkdtempSync(
				join(tmpdir(), "conduit-rpc-unavailable-instance-"),
			);
			writeFileSync(
				join(dir, "daemon.json"),
				JSON.stringify({
					...defaultDaemonConfig(),
					instances: [
						{
							id: "work-oc",
							name: "OpenCode",
							port: 4555,
							managed: false,
							driver: "opencode",
						},
					],
				}),
			);
			const cause = Object.assign(
				new OpenCodeUnavailable({
					instanceId: "work-oc",
					reason: "unreachable",
					message:
						'OpenCode instance "work-oc" is unreachable at http://127.0.0.1:4555: connection refused',
				}),
				{
					authHeaders: { Authorization: "Basic private-auth-header" },
					password: "private-instance-password",
				},
			);
			const layer = makeTestHandlerLayer({
				accountDirectory: makeMockAccountDirectory([
					{
						driver: "opencode",
						usageEligible: false,
						id: AccountIdSchema.make("work-oc"),
						name: "Work OpenCode",
					},
				]),
				api: makeModelApi(),
				config: makeMockConfig({ configDir: dir }),
				sessionManagerService: makeMockSessionManagerService({
					createSession: () =>
						Effect.fail(
							new SessionManagerError({ operation: "createSession", cause }),
						),
				}),
			});

			return Effect.gen(function* () {
				const client = yield* rpcClient;
				const error = yield* Effect.flip(
					client.CreateSession({
						permissionMode: "ask",
						projectSlug: "project-a",
						originId: "browser-tab-a",
						instanceId: AccountIdSchema.make("work-oc"),
						providerId: "opencode",
						model: {
							providerId: "openai",
							modelId: "gpt-4",
							variant: "",
							contextWindow: "",
						},
					}),
				);
				expect(error.message).toBe(`CreateSession failed: ${cause.message}`);
				expect(error.message).not.toMatch(
					/Authorization|private-auth-header|private-instance-password/,
				);
			}).pipe(
				Effect.provide(WsRpcServerLayer.pipe(Layer.provideMerge(layer)), {
					local: true,
				}),
				Effect.ensuring(
					Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
				),
			);
		},
	);

	it.effect("views a session for the originating browser tab", () => {
		const wsHandler = makeMockWebSocketHandler();

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions
				(id, project_id, provider, title, status, created_at, updated_at)
				VALUES ('session-1', 'test-project', 'opencode', 'Session', 'idle', 1, 1)`;
			yield* client.SyncInputDraft({
				key: { session: "session-1" },
				text: "saved draft",
			});

			const result = yield* client.ViewSession({
				sessionId: "session-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-1",
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ wsHandler })),
				),
				{ local: true },
			),
		);
	});

	it.effect("deletes a session through the shared session handler", () => {
		const deleteSession = vi.fn(() => Effect.succeed(true));
		const sessionManagerService = makeMockSessionManagerService({
			deleteSession,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.DeleteSession({
				sessionId: "session-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(deleteSession).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ sessionManagerService })),
				),
				{ local: true },
			),
		);
	});

	it.effect("returns ok for a coalesced delete", () => {
		const deleteSession = vi.fn(() => Effect.succeed(false));
		const sessionManagerService = makeMockSessionManagerService({
			deleteSession,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.DeleteSession({
				sessionId: "session-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(deleteSession).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ sessionManagerService })),
				),
				{ local: true },
			),
		);
	});

	it.effect("forks a session for the originating browser tab", () => {
		const api = makeModelApi();
		vi.mocked(api.session.fork).mockResolvedValue({
			id: "session-forked",
			title: "Forked Session",
			time: { created: 10, updated: 20 },
		} as unknown as SessionDetail);
		vi.mocked(api.session.messages).mockResolvedValue([
			{ id: "message-1", time: { created: 9 } },
			{ id: "message-2", time: { created: 11 } },
		] as unknown as Awaited<ReturnType<typeof api.session.messages>>);
		const setForkEntry = vi.fn(() => Effect.void);
		const wsHandler = makeMockWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			listSessions: vi.fn(() =>
				Effect.succeed([
					{
						projectSlug: "project-a",
						accountId: null,
						id: "session-1",
						title: "Original Session",
						status: "idle" as const,
					},
				]),
			),
			setForkEntry,
		});
		const persistenceLayer = makePersistenceEffectLayer(
			":memory:",
			"test-project",
		);

		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const projections = yield* ProjectionRunnerEffectTag;
			yield* projections.recover();
			yield* sql`INSERT INTO sessions
				(id, provider, title, model_provider, model_id, variant, context_window, created_at, updated_at)
				VALUES ('session-1', 'opencode', 'Original Session', 'openai', 'gpt-4', '', '', 1, 1)`;
			const client = yield* rpcClient;

			const result = yield* client.ForkSession({
				sessionId: "session-1",
				messageId: "message-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({
				projectSlug: "test-project",
				sessionId: "session-forked",
				forkedFrom: "session-1",
				forkMessageId: "message-1",
			});
			// OpenCode cuts before messageID, so the fork keeps message-1.
			expect(api.session.fork).toHaveBeenCalledWith("session-1", {
				messageID: "message-2",
			});
			// The fork command commits its boundary id with creation. The handler
			// must not recompute it and append a second lineage event.
			expect(setForkEntry).not.toHaveBeenCalled();
			const readQuery = yield* ReadQueryEffectTag;
			expect(yield* readQuery.getSession("session-forked")).toMatchObject({
				parent_id: null,
				forked_from: "session-1",
				fork_point_event: "message-1",
				fork_point_timestamp: null,
				fork_point_message_id: "message-1",
			});
			expect(
				yield* sql`SELECT type FROM events WHERE session_id = 'session-forked' ORDER BY sequence`,
			).toEqual([
				{ type: "session.created" },
				{ type: "session.model_changed" },
				{ type: "session.variant_changed" },
				{ type: "session.context_window_changed" },
				{ type: "session.workspace_changed" },
			]);
			expect(wsHandler.setClientSession).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							wsHandler,
							sessionManagerService,
							persistenceLayer,
						}),
					),
					Layer.provideMerge(persistenceLayer),
				),
				{ local: true },
			),
		);
	});

	it.effect.each([
		{
			profile: "instance",
			instanceConfigDir: "/instance-config",
			sessionConfigDir: undefined,
		},
		{
			profile: "shell",
			instanceConfigDir: undefined,
			sessionConfigDir: "/shell-config",
		},
		{
			profile: "saved",
			instanceConfigDir: "/updated-instance-config",
			sessionConfigDir: "/original-config",
		},
		{
			profile: "legacy project",
			instanceConfigDir: undefined,
			sessionConfigDir: undefined,
		},
	])(
		"forks retained Claude history using the $profile profile and binds its copied history",
		({ instanceConfigDir, sessionConfigDir }) => {
			const usesCanonicalHistory =
				instanceConfigDir !== undefined &&
				sessionConfigDir !== undefined &&
				instanceConfigDir !== sessionConfigDir;
			const claudeConfigDir =
				instanceConfigDir ?? sessionConfigDir ?? "/current-project-config";
			const dir = mkdtempSync(join(tmpdir(), "conduit-claude-fork-rpc-"));
			writeFileSync(
				join(dir, "daemon.json"),
				JSON.stringify({
					...defaultDaemonConfig(),
					instances: [
						{
							id: "my-claude",
							name: "Claude",
							port: 0,
							managed: false,
							driver: "claude",
							...(instanceConfigDir !== undefined && {
								configDir: instanceConfigDir,
							}),
						},
					],
				}),
			);
			const api = makeMockOpenCodeAPI();
			const wsHandler = makeMockWebSocketHandler();
			const setForkEntry = vi.fn(() => Effect.void);
			const sessionManagerService = makeMockSessionManagerService({
				setForkEntry,
				listSessions: vi.fn(() =>
					Effect.succeed([
						{
							projectSlug: "project-a",
							accountId: null,
							id: "ses-parent",
							title: "Parent",
							status: "idle" as const,
						},
					]),
				),
			});
			const transcript = (
				uuid: string,
				type: SessionMessage["type"],
				message: unknown,
			): SessionMessage => ({
				uuid,
				type,
				message,
				session_id: "sdk-parent",
				parent_tool_use_id: null,
				parent_agent_id: null,
			});
			const parentMessages = [
				transcript("parent-prompt", "user", { content: "Question" }),
				transcript("parent-thinking", "assistant", {
					id: "api-first",
					content: [{ type: "thinking", thinking: "Think" }],
				}),
				transcript("parent-final", "assistant", {
					id: "api-second",
					content: [{ type: "text", text: "Answer" }],
				}),
			];
			const readTranscript = vi.fn(async () => parentMessages);
			const forkSession = vi.fn(async () => {
				throw new Error("Unexpected eager Claude fork");
			});
			const sessionForkSdk = {
				readTranscript,
				forkSession,
				transcriptExists: vi.fn(async () => false),
			};
			const query = vi.fn(() => {
				throw new Error("Unexpected Claude query");
			});
			const persistenceLayer = makePersistenceEffectLayer(
				join(dir, "events.db"),
				"test-project",
			);
			const layer = WsRpcServerLayer.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						makeTestHandlerLayer({
							api,
							wsHandler,
							sessionManagerService,
							persistenceLayer,
							accountDirectory: makeMockAccountDirectory([
								{
									driver: "claude",
									id: AccountIdSchema.make("my-claude"),
									name: "Claude",
									folder: configuredClaudeConfigDir(claudeConfigDir),
									usageEligible: true,
								},
							]),
							orchestrationEngine: withDispatchEffect({
								dispatch: vi.fn(async () => ({
									models: [
										{ id: "sonnet", name: "Sonnet", providerId: "claude" },
									],
									supportsTools: true,
									supportsThinking: true,
									supportsPermissions: true,
									supportsQuestions: true,
									supportsAttachments: true,
									supportsFork: true,
									supportsRevert: false,
									commands: [],
								})),
							}),
							config: makeMockConfig({
								configDir: dir,
								projectDir: "/project",
								claudeSdk: {
									query,
									titleQuery: async function* () {},
									fork: sessionForkSdk,
								},
								shellEnv: () => ({
									CLAUDE_CONFIG_DIR: "/current-project-config",
								}),
							}),
						}),
						persistenceLayer,
					),
				),
			);

			return Effect.gen(function* () {
				yield* applySessionCommand(
					{
						type: "session.created",
						data: {
							sessionId: "ses-parent",
							title: "Parent",
							provider: "my-claude",
							providerSessionId: "sdk-parent",
						},
					},
					{
						pick: {
							harness: "claude",
							model: { providerId: "claude", modelId: "sonnet" },
							effort: "",
							contextWindow: "",
						},
					},
				);
				const providerState = yield* ProviderStateEffectTag;
				yield* providerState.saveUpdates("ses-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
					...(sessionConfigDir !== undefined
						? [{ key: "claudeConfigDir", value: sessionConfigDir }]
						: []),
				]);
				const persist = yield* ClaudeEventPersistEffectTag;
				const timestamp = Date.now() - 1000;
				yield* persist.persistEvents([
					canonicalEvent(
						"message.created",
						"ses-parent",
						{
							sessionId: "ses-parent",
							messageId: "parent-prompt",
							role: "user",
						},
						{ provider: "claude", createdAt: timestamp },
					),
					canonicalEvent(
						"text.delta",
						"ses-parent",
						{
							messageId: "parent-prompt",
							partId: "prompt-text",
							text: "Question",
						},
						{ provider: "claude", createdAt: timestamp + 1 },
					),
					canonicalEvent(
						"message.created",
						"ses-parent",
						{
							sessionId: "ses-parent",
							messageId: "api-first",
							role: "assistant",
						},
						{ provider: "claude", createdAt: timestamp + 2 },
					),
					canonicalEvent(
						"thinking.start",
						"ses-parent",
						{ messageId: "api-first", partId: "thinking-part" },
						{ provider: "claude", createdAt: timestamp + 3 },
					),
					canonicalEvent(
						"thinking.delta",
						"ses-parent",
						{ messageId: "api-first", partId: "thinking-part", text: "Think" },
						{ provider: "claude", createdAt: timestamp + 4 },
					),
					canonicalEvent(
						"thinking.end",
						"ses-parent",
						{ messageId: "api-first", partId: "thinking-part" },
						{ provider: "claude", createdAt: timestamp + 5 },
					),
					canonicalEvent(
						"tool.started",
						"ses-parent",
						{
							messageId: "api-first",
							partId: "tool-part",
							callId: "tool-call",
							toolName: "Read",
							input: { tool: "Read", filePath: "/file" },
						},
						{ provider: "claude", createdAt: timestamp + 6 },
					),
					canonicalEvent(
						"tool.completed",
						"ses-parent",
						{
							messageId: "api-first",
							partId: "tool-part",
							result: "done",
							duration: 3,
						},
						{ provider: "claude", createdAt: timestamp + 7 },
					),
					canonicalEvent(
						"text.delta",
						"ses-parent",
						{ messageId: "api-first", partId: "answer-part", text: "Answer" },
						{ provider: "claude", createdAt: timestamp + 8 },
					),
					canonicalEvent(
						"turn.completed",
						"ses-parent",
						{ messageId: "api-first" },
						{ provider: "claude", createdAt: timestamp + 9 },
					),
					canonicalEvent(
						"message.created",
						"ses-parent",
						{ sessionId: "ses-parent", messageId: "next-prompt", role: "user" },
						{ provider: "claude", createdAt: timestamp + 10 },
					),
					canonicalEvent(
						"message.created",
						"ses-parent",
						{
							sessionId: "ses-parent",
							messageId: "api-next",
							role: "assistant",
						},
						{ provider: "claude", createdAt: timestamp + 11 },
					),
					canonicalEvent(
						"message.created",
						"ses-parent",
						{
							sessionId: "ses-parent",
							messageId: "result-only",
							role: "assistant",
						},
						{ provider: "claude", createdAt: timestamp + 12 },
					),
					canonicalEvent(
						"text.delta",
						"ses-parent",
						{
							messageId: "result-only",
							partId: "result-only-text",
							text: "Handled locally",
						},
						{ provider: "claude", createdAt: timestamp + 13 },
					),
				]);
				const client = yield* rpcClient;
				const result = yield* client.ForkSession({
					sessionId: "ses-parent",
					messageId: "api-first",
					originId: "browser-tab-a",
				});
				const readQuery = yield* ReadQueryEffectTag;
				const forkRow = yield* readQuery.getSession(result.sessionId);
				expect(forkRow).toMatchObject({
					provider: "my-claude",
					parent_id: null,
					forked_from: "ses-parent",
					provider_sid: null,
					fork_point_event: "api-first",
					fork_point_message_id: "api-first",
				});
				const forkThread = yield* providerState.nativeThread(
					result.sessionId,
					"my-claude",
				);
				expect(forkThread).toBeUndefined();
				const sourceHint = (yield* providerState.getState(result.sessionId))[
					CLAUDE_FORK_SOURCE_KEY
				];
				if (usesCanonicalHistory) expect(sourceHint).toBeUndefined();
				else
					expect(JSON.parse(sourceHint ?? "null")).toEqual({
						instanceId: "my-claude",
						resumeSessionId: "sdk-parent",
						configDir: configuredClaudeConfigDir(claudeConfigDir),
						messageId: "api-first",
					});
				expect(api.session.fork).not.toHaveBeenCalled();
				expect(forkSession).not.toHaveBeenCalled();
				expect(readTranscript).not.toHaveBeenCalled();
				expect(sessionForkSdk.transcriptExists).not.toHaveBeenCalled();
				expect(query).not.toHaveBeenCalled();
				const prepare = yield* makePrepareTurn({
					folderSource: "account",
					configDir: configuredClaudeConfigDir(claudeConfigDir),
					sessionForkSdk,
				});
				const prepared = yield* prepare(
					result.sessionId,
					"my-claude",
					"Continue fork",
				);
				if (usesCanonicalHistory) {
					expect(prepared.resumeSessionId).toBeUndefined();
					expect(prepared.handoff).toBeDefined();
					expect(prepared.prompt).toContain("Question");
					expect(prepared.prompt).toContain("Answer");
				} else {
					expect(prepared).toMatchObject({
						resumeSessionId: "sdk-parent",
						resumeSessionAt: "parent-final",
						forkSession: true,
						clearInheritedGoal: true,
						configDir: configuredClaudeConfigDir(claudeConfigDir),
						prompt: "Continue fork",
					});
					expect(readTranscript).toHaveBeenCalledWith("sdk-parent", {
						configDir: configuredClaudeConfigDir(claudeConfigDir),
					});
				}
				expect(readTranscript).toHaveBeenCalledTimes(
					usesCanonicalHistory ? 0 : 1,
				);
				expect(result).toMatchObject({
					forkedFrom: "ses-parent",
					forkMessageId: "api-first",
					forkPointTimestamp: expect.any(Number),
				});
				expect(setForkEntry).not.toHaveBeenCalled();
				const history = yield* readQuery.getSessionMessagesWithParts(
					result.sessionId,
				);
				const parentHistory =
					yield* readQuery.getSessionMessagesWithParts("ses-parent");
				const parentCut = parentHistory.filter((message) =>
					["parent-prompt", "api-first"].includes(message.id),
				);
				const summary = (messages: typeof history) =>
					messages.map((message) => ({
						id: message.id,
						role: message.role,
						text: message.text,
						parts: message.parts.map((part) => ({
							id: part.id,
							type: part.type,
							text: part.text,
							callId: part.call_id,
							status: part.status,
						})),
					}));
				expect(summary(history)).toEqual(
					summary(parentCut).map((message) => ({
						...message,
						id: `${message.id}_${result.sessionId}`,
						parts: message.parts.map((part) => ({
							...part,
							id: `${part.id}_${result.sessionId}`,
							callId:
								part.callId === null
									? null
									: `${part.callId}_${result.sessionId}`,
						})),
					})),
				);
				expect(result.forkPointTimestamp).toBe(
					parentHistory.find((message) => message.id === "api-first")
						?.created_at,
				);
				const sql = yield* SqlClient.SqlClient;
				const sessionCount = () =>
					sql<{ count: number }>`SELECT COUNT(*) AS count FROM sessions`;
				const resultOnlyFork = yield* client.ForkSession({
					sessionId: "ses-parent",
					messageId: "result-only",
					originId: "browser-tab-a",
				});
				expect(forkSession).not.toHaveBeenCalled();
				const resultOnlyPrepared = yield* prepare(
					resultOnlyFork.sessionId,
					"my-claude",
					"Continue result fork",
				);
				expect(resultOnlyPrepared.resumeSessionId).toBeUndefined();
				expect(resultOnlyPrepared.handoff).toBeDefined();
				expect(resultOnlyPrepared.prompt).toContain("Handled locally");
				expect(
					(yield* readQuery.getSessionMessagesWithParts(
						resultOnlyFork.sessionId,
					)).map((message) => message.id),
				).toContain(`result-only_${resultOnlyFork.sessionId}`);
				const beforeMissingPoint = (yield* sessionCount())[0]?.count;
				const missingPoint = yield* Effect.result(
					client.ForkSession({
						sessionId: "ses-parent",
						messageId: "not-in-history",
						originId: "browser-tab-a",
					}),
				);
				expect(missingPoint._tag).toBe("Failure");
				if (missingPoint._tag === "Failure")
					expect(String(missingPoint.failure)).toContain(
						"was not found in the session history",
					);
				expect((yield* sessionCount())[0]?.count).toBe(beforeMissingPoint);
				expect(forkSession).not.toHaveBeenCalled();

				const eventStore = yield* EventStoreEffectTag;
				const failPersist = vi
					.spyOn(eventStore, "appendBatch")
					.mockReturnValueOnce(
						Effect.fail(
							new EventStoreError({
								operation: "appendBatch",
								cause: "disk full",
							}),
						),
					);
				const rolledBack = yield* Effect.result(
					client.ForkSession({
						sessionId: "ses-parent",
						originId: "browser-tab-a",
					}),
				);
				failPersist.mockRestore();
				expect(rolledBack._tag).toBe("Failure");
				expect(forkSession).not.toHaveBeenCalled();
				expect((yield* sessionCount())[0]?.count).toBe(beforeMissingPoint);

				yield* applySessionCommand({
					type: "session.created",
					data: {
						sessionId: "ses-no-transcript",
						title: "New",
						provider: "my-claude",
					},
				});
				const missing = yield* Effect.result(
					client.ForkSession({
						sessionId: "ses-no-transcript",
						originId: "browser-tab-a",
					}),
				);
				expect(missing._tag).toBe("Failure");
				if (missing._tag === "Failure")
					expect(String(missing.failure)).toContain("has no messages yet");
				expect(forkSession).not.toHaveBeenCalled();
				expect(query).not.toHaveBeenCalled();
				if (usesCanonicalHistory) expect(readTranscript).not.toHaveBeenCalled();
			}).pipe(
				Effect.scoped,
				Effect.provide(layer, { local: true }),
				Effect.ensuring(
					Effect.sync(() => {
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
	);

	it.effect("responds to a permission request for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
		const dispatchEffect = vi.fn(() => Effect.void);
		const orchestrationEngine = withDispatchEffect({
			dispatchEffect,
			getProviderForSessionEffect: () => Effect.succeed("opencode"),
		});
		const resolvePermissionEffect = vi.fn(() => Effect.void);
		const providerRegistry = new ProviderRegistry();
		providerRegistry.registerInstance({
			providerId: "opencode",
			resolvePermissionEffect,
		} as unknown as ProviderInstance);
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});

		return Effect.gen(function* () {
			const pendingInteractions = yield* PendingInteractionServiceTag;
			yield* pendingInteractions.recordPermissionRequest({
				requestId: "per-1" as PermissionId,
				sessionId: "session-1",
				toolName: "Bash",
				toolInput: { command: "pnpm test" },
			});

			const client = yield* rpcClient;
			const result = yield* client.RespondPermission({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				commandId: "cmd-respond-permission",
				requestId: "per-1",
				decision: "allow",
			});

			expect(result).toEqual({ ok: true });
			expect(dispatchEffect).toHaveBeenCalledWith({
				type: "resolve_permission",
				commandId: "cmd-respond-permission",
				sessionId: "session-1",
				requestId: "per-1",
				decision: "once",
				response: { decision: "once" },
			});
			expect(resolvePermissionEffect).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							wsHandler,
							providerRegistry,
							orchestrationEngine,
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("answers an ask-user question for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
		const dispatchEffect = vi.fn(() => Effect.void);
		const orchestrationEngine = withDispatchEffect({ dispatchEffect });
		const config = makeMockConfig({ projectDir: "/project" });
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		return Effect.gen(function* () {
			yield* applySessionCommand({
				type: "session.created",
				data: {
					sessionId: "session-1",
					title: "Question",
					provider: "opencode",
				},
			});
			yield* applySessionCommand({
				type: "session.workspace_changed",
				data: {
					sessionId: "session-1",
					cause: "user",
					origin: "existing",
					worktrees: { "/project": "/project-worktree" },
				},
			});
			const client = yield* rpcClient;
			const result = yield* client.AnswerQuestion({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				commandId: "cmd-answer-question",
				toolId: "que-1",
				answers: { "0": "PostgreSQL" },
			});

			expect(result).toEqual({ ok: true });
			expect(dispatchEffect).toHaveBeenCalledWith({
				type: "resolve_question",
				commandId: "cmd-answer-question",
				sessionId: "session-1",
				requestId: "que-1",
				answers: { "0": "PostgreSQL" },
			});
			expect(api.question.reply).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							config,
							wsHandler,
							orchestrationEngine,
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("rejects an ask-user question for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
		const dispatchEffect = vi.fn(() => Effect.void);
		const orchestrationEngine = withDispatchEffect({ dispatchEffect });
		const config = makeMockConfig({ projectDir: "/project" });
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		return Effect.gen(function* () {
			yield* applySessionCommand({
				type: "session.created",
				data: {
					sessionId: "session-1",
					title: "Question",
					provider: "opencode",
				},
			});
			yield* applySessionCommand({
				type: "session.workspace_changed",
				data: {
					sessionId: "session-1",
					cause: "user",
					origin: "existing",
					worktrees: { "/project": "/project-worktree" },
				},
			});
			const client = yield* rpcClient;
			const result = yield* client.RejectQuestion({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				commandId: "cmd-reject-question",
				toolId: "que-1",
			});

			expect(result).toEqual({ ok: true });
			expect(dispatchEffect).toHaveBeenCalledWith({
				type: "resolve_question",
				commandId: "cmd-reject-question",
				sessionId: "session-1",
				requestId: "que-1",
				answers: {},
				operation: "reject",
			});
			expect(api.question.reject).not.toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							config,
							wsHandler,
							orchestrationEngine,
						}),
					),
				),
				{ local: true },
			),
		);
	});

	it.effect("returns older history pages from SQLite", () => {
		const persistenceLayer = makePersistenceEffectLayer(
			":memory:",
			"test-project",
		);
		return Effect.gen(function* () {
			const projections = yield* ProjectionRunnerEffectTag;
			yield* projections.recover();
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT INTO sessions (id, provider, title, created_at, updated_at)
				VALUES ('session-1', 'claude', 'Session', 1, 1)`;
			yield* sql`INSERT INTO messages
				(id, session_id, role, text, created_at, updated_at)
				VALUES
				('message-1', 'session-1', 'assistant', 'older', 1, 1),
				('message-2', 'session-1', 'user', 'newer', 2, 2)`;
			yield* sql`INSERT INTO message_parts
				(id, message_id, type, text, sort_order, created_at, updated_at)
				VALUES ('part-1', 'message-1', 'text', 'older', 0, 1, 1)`;
			const client = yield* rpcClient;

			const response = yield* client.LoadMoreHistory({
				sessionId: "session-1",
				before: "message-2",
			});

			expect(response).toMatchObject({
				projectSlug: "test-project",
				sessionId: "session-1",
				messages: [
					{
						id: "message-1",
						role: "assistant",
						parts: [{ id: "part-1", type: "text", text: "older" }],
					},
				],
				hasMore: false,
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ persistenceLayer })),
					Layer.provideMerge(persistenceLayer),
				),
				{ local: true },
			),
		);
	});
});
