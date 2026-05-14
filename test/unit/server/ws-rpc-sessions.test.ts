import { RpcTest } from "@effect/rpc";
import { describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { WsRpcGroup } from "../../../src/lib/contracts/ws-rpc.js";
import { PendingInteractionServiceTag } from "../../../src/lib/domain/relay/Services/pending-interaction-service.js";
import type { SessionManagerService } from "../../../src/lib/domain/relay/Services/session-manager-service.js";
import type { SessionDetail } from "../../../src/lib/instance/sdk-types.js";
import { WsRpcServerLayer } from "../../../src/lib/server/ws-rpc.js";
import type { PermissionId } from "../../../src/lib/shared-types.js";
import {
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
		const sendDualSessionLists = vi.fn((send) =>
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
			sendDualSessionLists,
		});

		return Effect.gen(function* () {
			const client = yield* rpcClient;

			const result = yield* client.CreateSession({
				projectSlug: "project-a",
				originId: "browser-tab-a",
				requestId: "request-1",
			});

			expect(result).toEqual({
				projectSlug: "project-a",
				sessionId: "session-new",
			});
			expect(createSession).toHaveBeenCalledWith(undefined);
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
			expect(sendDualSessionLists).toHaveBeenCalled();
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
		const sendDualSessionLists = vi.fn((send) =>
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
			sendDualSessionLists,
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
			expect(sendDualSessionLists).toHaveBeenCalled();
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
		const sendDualSessionLists = vi.fn((send) =>
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
			sendDualSessionLists,
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
					parentId: "session-1",
					parentTitle: "Original Session",
				}),
			);
			expect(wsHandler.setClientSession).toHaveBeenCalledWith(
				"browser-tab-a",
				"session-forked",
			);
			expect(sendDualSessionLists).toHaveBeenCalled();
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
