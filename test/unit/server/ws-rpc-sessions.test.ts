import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { RpcTest } from "@effect/rpc";
import { SqlClient } from "@effect/sql";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { ProviderInstanceIdSchema } from "../../../src/lib/contracts/provider-instance.js";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { defaultDaemonConfig } from "../../../src/lib/daemon/config-persistence.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import { applySessionCommand } from "../../../src/lib/domain/relay/Services/session-command.js";
import type { SessionManagerService } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import {
	ClaudeEventPersistEffectError,
	ClaudeEventPersistEffectTag,
} from "../../../src/lib/persistence/effect/claude-event-persist-effect.js";
import { makePersistenceEffectLayer } from "../../../src/lib/persistence/effect/live.js";
import { ProviderStateEffectTag } from "../../../src/lib/persistence/effect/provider-state-effect.js";
import { ReadQueryEffectTag } from "../../../src/lib/persistence/effect/read-query-effect.js";
import { canonicalEvent } from "../../../src/lib/persistence/events.js";
import { defaultClaudeSessionForkSdk } from "../../../src/lib/provider/claude/claude-session-fork.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
	makeMockConfig,
	makeMockOpenCodeAPI,
	makeMockSessionManagerService,
	makeMockWebSocketHandler,
	makeTestHandlerLayer,
} from "../../helpers/mock-factories.js";

const rpcClient = Effect.gen(function* () {
	return yield* RpcTest.makeClient(WsRpcGroup);
});

describe("WsRpcServerLayer ListSessions", () => {
	it.effect("creates a session for the originating browser tab", () => {
		const createSession = vi.fn(() =>
			Effect.succeed({
				id: "session-new",
				title: "New Session",
			} as unknown as SessionDetail),
		);
		const sendSessionLists = vi.fn((send) =>
			Effect.sync(() => {
				send({
					type: "session_list" as const,
					sessions: [{ id: "session-new", title: "New Session" }],
					roots: true,
				});
			}),
		);
		const wsHandler = makeMockWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			createSession,
			sendSessionLists,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CreateSession({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				requestId: "request-1",
				instanceId: ProviderInstanceIdSchema.make("opencode"),
				providerId: "opencode",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				sessionId: "session-new",
			});
			expect(createSession).toHaveBeenCalledWith(undefined, {
				instanceId: "opencode",
				providerId: "opencode",
			});
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-new",
			);
			expect(wsHandler.sendTo).toHaveBeenCalledWith(
				"browser-tab-a",
				expect.objectContaining({
					type: "session_switched",
					id: "session-new",
					requestId: "request-1",
				}),
			);
			expect(sendSessionLists).toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});

	it.effect("views a session for the originating browser tab", () => {
		const wsHandler = makeMockWebSocketHandler();

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.ViewSession({
				projectSlug: "project-a",
				sessionId: "session-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-1",
			);
			expect(wsHandler.sendTo).toHaveBeenCalledWith(
				"browser-tab-a",
				expect.objectContaining({
					type: "session_switched",
					id: "session-1",
				}),
			);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ wsHandler })),
				),
			),
		);
	});

	it.effect("deletes a session through the shared session handler", () => {
		const deleteSession = vi.fn(() => Effect.void);
		const sendSessionLists = vi.fn((send) =>
			Effect.sync(() => {
				send({
					type: "session_list" as const,
					sessions: [],
					roots: true,
				});
			}),
		);
		const wsHandler = makeMockWebSocketHandler({
			getClientsForSession: vi.fn(() => []),
		});
		const sessionManagerService = makeMockSessionManagerService({
			deleteSession,
			sendSessionLists,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.DeleteSession({
				projectSlug: "project-a",
				sessionId: "session-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({ ok: true });
			expect(deleteSession).toHaveBeenCalledWith("session-1");
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "session_deleted",
				sessionId: "session-1",
			});
			expect(sendSessionLists).toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});

	it.effect("forks a session for the originating browser tab", () => {
		const api = makeMockOpenCodeAPI();
		vi.mocked(api.session.fork).mockResolvedValue({
			id: "session-forked",
			title: "Forked Session",
			time: { created: 10, updated: 20 },
		} as unknown as SessionDetail);
		vi.mocked(api.session.message).mockResolvedValue({
			id: "message-1",
			time: { created: 9 },
		} as unknown as Awaited<ReturnType<typeof api.session.message>>);
		const setForkEntry = vi.fn(() => Effect.void);
		const clearPaginationCursor = vi.fn(() => Effect.void);
		const sendSessionLists = vi.fn((send) =>
			Effect.sync(() => {
				send({
					type: "session_list" as const,
					sessions: [{ id: "session-forked", title: "Forked Session" }],
					roots: true,
				});
			}),
		);
		const wsHandler = makeMockWebSocketHandler();
		const sessionManagerService = makeMockSessionManagerService({
			listSessions: vi.fn(() =>
				Effect.succeed([{ id: "session-1", title: "Original Session" }]),
			),
			clearPaginationCursor,
			setForkEntry,
			sendSessionLists,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.ForkSession({
				projectSlug: "project-a",
				sessionId: "session-1",
				messageId: "message-1",
				originId: "browser-tab-a",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				sessionId: "session-forked",
			});
			expect(api.session.fork).toHaveBeenCalledWith("session-1", {
				messageID: "message-1",
			});
			expect(clearPaginationCursor).toHaveBeenCalledWith("session-1");
			expect(setForkEntry).toHaveBeenCalledWith("session-forked", {
				forkMessageId: "message-1",
				parentID: "session-1",
				forkPointTimestamp: 9,
			});
			expect(wsHandler.broadcast).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "session_forked",
					sessionId: "session-forked",
					forkedFrom: "session-1",
					parentTitle: "Original Session",
				}),
			);
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-forked",
			);
			expect(sendSessionLists).toHaveBeenCalled();
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							api,
							wsHandler,
							sessionManagerService,
						}),
					),
				),
			),
		);
	});

	it.effect(
		"forks a Claude transcript and binds its copied history to a new session",
		() => {
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
							configDir: "/instance-config",
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
					Effect.succeed([{ id: "ses-parent", title: "Parent" }]),
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
			const readTranscript = vi
				.spyOn(defaultClaudeSessionForkSdk, "readTranscript")
				.mockResolvedValue(parentMessages);
			const forkSession = vi
				.spyOn(defaultClaudeSessionForkSdk, "forkSession")
				.mockResolvedValue({ sessionId: "sdk-fork" });
			const layer = WsRpcServerLayer.pipe(
				Layer.provideMerge(
					Layer.mergeAll(
						makeTestHandlerLayer({
							api,
							wsHandler,
							sessionManagerService,
							config: makeMockConfig({
								configDir: dir,
								projectDir: "/project",
							}),
						}),
						makePersistenceEffectLayer(join(dir, "events.db")),
					),
				),
			);

			return Effect.gen(function* () {
				yield* applySessionCommand({
					type: "session.created",
					data: {
						sessionId: "ses-parent",
						title: "Parent",
						provider: "my-claude",
						providerSessionId: "sdk-parent",
					},
				});
				const providerState = yield* ProviderStateEffectTag;
				yield* providerState.saveUpdates("ses-parent", [
					{ key: "resumeSessionId", value: "sdk-parent" },
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
					projectSlug: "project-a",
					sessionId: "ses-parent",
					messageId: "api-first",
					originId: "browser-tab-a",
				});
				const readQuery = yield* ReadQueryEffectTag;
				const forkRow = yield* readQuery.getSession(result.sessionId);
				expect(forkRow).toMatchObject({
					provider: "my-claude",
					parent_id: null,
					forked_from: null,
					provider_sid: "sdk-fork",
				});
				expect(
					(yield* providerState.getState(result.sessionId))["resumeSessionId"],
				).toBe("sdk-fork");
				expect(api.session.fork).not.toHaveBeenCalled();
				expect(forkSession).toHaveBeenCalledWith("sdk-parent", {
					dir: "/project",
					configDir: "/instance-config",
					title: "Parent (fork)",
					upToMessageId: "parent-final",
				});
				expect(readTranscript).toHaveBeenCalledWith("sdk-parent", {
					dir: "/project",
					configDir: "/instance-config",
				});
				expect(readTranscript).toHaveBeenCalledTimes(1);
				const forkNotice = vi
					.mocked(wsHandler.broadcast)
					.mock.calls.map(([message]) => message)
					.find((message) => message.type === "session_forked");
				expect(forkNotice).toMatchObject({
					forkedFrom: "ses-parent",
					sessionId: result.sessionId,
					session: {
						forkMessageId: `api-first_${result.sessionId}`,
						forkPointTimestamp: expect.any(Number),
					},
				});
				expect(setForkEntry).toHaveBeenCalledWith(
					result.sessionId,
					expect.objectContaining({
						parentID: "ses-parent",
						forkMessageId: `api-first_${result.sessionId}`,
					}),
				);
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
				if (forkNotice?.type === "session_forked") {
					expect(
						history.every(
							(message) =>
								message.created_at <
								(forkNotice.session.forkPointTimestamp ?? 0),
						),
					).toBe(true);
				}
				const sql = yield* SqlClient.SqlClient;
				const sessionCount = () =>
					sql<{ count: number }>`SELECT COUNT(*) AS count FROM sessions`;
				const resultOnlyFork = yield* client.ForkSession({
					projectSlug: "project-a",
					sessionId: "ses-parent",
					messageId: "result-only",
					originId: "browser-tab-a",
				});
				expect(forkSession).toHaveBeenLastCalledWith("sdk-parent", {
					dir: "/project",
					configDir: "/instance-config",
					title: "Parent (fork)",
					upToMessageId: "parent-final",
				});
				expect(
					(yield* readQuery.getSessionMessagesWithParts(
						resultOnlyFork.sessionId,
					)).map((message) => message.id),
				).toContain(`result-only_${resultOnlyFork.sessionId}`);
				const beforeMissingPoint = (yield* sessionCount())[0]?.count;
				const missingPoint = yield* Effect.either(
					client.ForkSession({
						projectSlug: "project-a",
						sessionId: "ses-parent",
						messageId: "not-in-history",
						originId: "browser-tab-a",
					}),
				);
				expect(missingPoint._tag).toBe("Left");
				if (missingPoint._tag === "Left")
					expect(String(missingPoint.left)).toContain(
						"was not found in the session history",
					);
				expect((yield* sessionCount())[0]?.count).toBe(beforeMissingPoint);
				expect(forkSession).toHaveBeenCalledTimes(2);

				const persistService = yield* ClaudeEventPersistEffectTag;
				const failPersist = vi
					.spyOn(persistService, "persistEvents")
					.mockReturnValueOnce(
						Effect.fail(
							new ClaudeEventPersistEffectError({
								operation: "persistEvents",
								cause: "disk full",
							}),
						),
					);
				const rolledBack = yield* Effect.either(
					client.ForkSession({
						projectSlug: "project-a",
						sessionId: "ses-parent",
						originId: "browser-tab-a",
					}),
				);
				failPersist.mockRestore();
				expect(rolledBack._tag).toBe("Left");
				expect(forkSession).toHaveBeenCalledTimes(3);
				expect((yield* sessionCount())[0]?.count).toBe(beforeMissingPoint);

				yield* applySessionCommand({
					type: "session.created",
					data: {
						sessionId: "ses-no-transcript",
						title: "New",
						provider: "my-claude",
					},
				});
				const missing = yield* Effect.either(
					client.ForkSession({
						projectSlug: "project-a",
						sessionId: "ses-no-transcript",
						originId: "browser-tab-a",
					}),
				);
				expect(missing._tag).toBe("Left");
				if (missing._tag === "Left")
					expect(String(missing.left)).toContain(
						"has no Claude transcript yet",
					);
				expect(forkSession).toHaveBeenCalledTimes(3);
			}).pipe(
				Effect.scoped,
				Effect.provide(layer),
				Effect.ensuring(
					Effect.sync(() => {
						readTranscript.mockRestore();
						forkSession.mockRestore();
						rmSync(dir, { recursive: true, force: true });
					}),
				),
			);
		},
	);

	it.effect("responds to a permission request for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
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
			expect(api.permission.reply).toHaveBeenCalledWith(
				"session-1",
				"per-1",
				"once",
			);
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "permission_resolved",
				sessionId: "session-1",
				requestId: "per-1",
				decision: "once",
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(makeTestHandlerLayer({ api, wsHandler })),
				),
			),
		);
	});

	it.effect("answers an ask-user question for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const decrementPendingQuestionCount = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			decrementPendingQuestionCount,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const result = yield* client.AnswerQuestion({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				commandId: "cmd-answer-question",
				toolId: "que-1",
				answers: { "0": "PostgreSQL" },
			});

			expect(result).toEqual({ ok: true });
			expect(api.question.reply).toHaveBeenCalledWith("que-1", [
				["PostgreSQL"],
			]);
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "ask_user_resolved",
				toolId: "que-1",
				sessionId: "session-1",
			});
			expect(decrementPendingQuestionCount).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ api, wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});

	it.effect("rejects an ask-user question for the originating tab", () => {
		const api = makeMockOpenCodeAPI();
		const wsHandler = makeMockWebSocketHandler({
			getClientSession: vi.fn(() => "session-1"),
		});
		const decrementPendingQuestionCount = vi.fn(() => Effect.void);
		const sessionManagerService = makeMockSessionManagerService({
			decrementPendingQuestionCount,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;
			const result = yield* client.RejectQuestion({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				commandId: "cmd-reject-question",
				toolId: "que-1",
			});

			expect(result).toEqual({ ok: true });
			expect(api.question.reject).toHaveBeenCalledWith("que-1");
			expect(wsHandler.broadcast).toHaveBeenCalledWith({
				type: "ask_user_resolved",
				toolId: "que-1",
				sessionId: "session-1",
			});
			expect(decrementPendingQuestionCount).toHaveBeenCalledWith("session-1");
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({ api, wsHandler, sessionManagerService }),
					),
				),
			),
		);
	});

	it.effect("returns sessions for the requested root/all-session view", () => {
		const listSessions = vi.fn((options?: { roots?: boolean }) =>
			Effect.succeed(
				options?.roots
					? [{ id: "root-1", title: "Root Session" }]
					: [
							{ id: "root-1", title: "Root Session" },
							{ id: "child-1", title: "Child Session", parentID: "root-1" },
						],
			),
		);

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const roots = yield* client.ListSessions({
				projectSlug: "project-a",
				roots: true,
			});
			const all = yield* client.ListSessions({
				projectSlug: "project-a",
				roots: false,
			});

			expect(roots).toEqual({
				projectSlug: "project-a",
				roots: true,
				sessions: [{ id: "root-1", title: "Root Session" }],
			});
			expect(all.sessions).toEqual([
				{ id: "root-1", title: "Root Session" },
				{ id: "child-1", title: "Child Session", parentID: "root-1" },
			]);
			expect(listSessions).toHaveBeenCalledWith({ roots: true });
			expect(listSessions).toHaveBeenCalledWith({ roots: false });
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							sessionManagerService: {
								listSessions,
							} as unknown as SessionManagerService,
						}),
					),
				),
			),
		);
	});

	it.effect(
		"filters sessions for search requests without mutating the view",
		() => {
			const listSessions = vi.fn(() =>
				Effect.succeed([
					{ id: "root-1", title: "Root Session" },
					{ id: "child-1", title: "Child Session", parentID: "root-1" },
					{ id: "task-99", title: "Unrelated" },
				]),
			);

			return Effect.gen(function* () {
				const client = yield* rpcClient;

				const response = yield* client.ListSessions({
					projectSlug: "project-a",
					roots: false,
					query: "CHILD",
				});

				expect(response).toEqual({
					projectSlug: "project-a",
					roots: false,
					search: true,
					sessions: [
						{ id: "child-1", title: "Child Session", parentID: "root-1" },
					],
				});
				expect(listSessions).toHaveBeenCalledWith({ roots: false });
			}).pipe(
				Effect.scoped,
				Effect.provide(
					WsRpcServerLayer.pipe(
						Layer.provideMerge(
							makeTestHandlerLayer({
								sessionManagerService: {
									listSessions,
								} as unknown as SessionManagerService,
							}),
						),
					),
				),
			);
		},
	);

	it.effect("returns older history pages", () => {
		const loadPreRenderedHistory = vi.fn(() =>
			Effect.succeed({
				messages: [
					{
						id: "message-1",
						role: "assistant" as const,
						parts: [{ id: "part-1", type: "text" as const, text: "older" }],
					},
				],
				hasMore: true,
				total: 125,
			}),
		);

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const response = yield* client.LoadMoreHistory({
				projectSlug: "project-a",
				sessionId: "session-1",
				offset: 50,
			});

			expect(response).toEqual({
				projectSlug: "project-a",
				sessionId: "session-1",
				messages: [
					{
						id: "message-1",
						role: "assistant",
						parts: [{ id: "part-1", type: "text", text: "older" }],
					},
				],
				hasMore: true,
				total: 125,
			});
			expect(loadPreRenderedHistory).toHaveBeenCalledWith("session-1", 50);
		}).pipe(
			Effect.scoped,
			Effect.provide(
				WsRpcServerLayer.pipe(
					Layer.provideMerge(
						makeTestHandlerLayer({
							sessionManagerService: {
								loadPreRenderedHistory,
							} as unknown as SessionManagerService,
						}),
					),
				),
			),
		);
	});
});
