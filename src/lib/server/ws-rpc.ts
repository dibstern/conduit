import { Effect } from "effect";
import { RateLimiterTag } from "../domain/relay/Layers/rate-limiter-layer.js";
import { AgentServiceTag } from "../domain/relay/Services/agent-service.js";
import { DirectoryListingServiceTag } from "../domain/relay/Services/directory-listing-service.js";
import { ProjectManagementServiceTag } from "../domain/relay/Services/project-management-service.js";
import { SessionManagerServiceTag } from "../domain/relay/Services/session-manager-service.js";
import { switchContextWindowForSession } from "../handlers/context-window.js";
import {
	getModelsResponse,
	setDefaultModelForRelay,
	switchModelForSession,
	switchVariantForSession,
} from "../handlers/model.js";
import {
	cancelSessionById,
	sendMessageToSession,
	syncInputDraftForSession,
} from "../handlers/prompt.js";
import { reloadProviderSessionForClient } from "../handlers/reload.js";
import {
	loadMoreHistoryForSession,
	renameSessionForClient,
} from "../handlers/session.js";
import { getCommandsForSession, getTodoState } from "../handlers/settings.js";

export {
	CancelSession,
	GetAgents,
	type GetAgentsResponse,
	GetCommands,
	type GetCommandsResponse,
	GetFileContent,
	type GetFileContentResponse,
	GetFileList,
	type GetFileListResponse,
	GetFileTree,
	type GetFileTreeResponse,
	GetModels,
	type GetModelsResponse,
	GetProjects,
	type GetProjectsResponse,
	GetTodo,
	type GetTodoResponse,
	GetToolContent,
	type GetToolContentResponse,
	ListDirectories,
	type ListDirectoriesResponse,
	ListSessions,
	type ListSessionsResponse,
	LoadMoreHistory,
	type LoadMoreHistoryResponse,
	type ModelInfo,
	type ProviderInfo,
	ReloadProviderSession,
	type ReloadProviderSessionResponse,
	RenameSession,
	SendMessage,
	type SessionInfo,
	SetDefaultModel,
	type SetDefaultModelResponse,
	SwitchAgent,
	SwitchContextWindow,
	type SwitchContextWindowResponse,
	SwitchModel,
	type SwitchModelResponse,
	SwitchVariant,
	type SwitchVariantResponse,
	SyncInputDraft,
	WsRpcError,
	WsRpcGroup,
	WsRpcRequest,
} from "../contracts/ws-rpc.js";

import { WsRpcError, WsRpcGroup } from "../contracts/ws-rpc.js";
import {
	getFileContentResponse,
	getFileListResponse,
	getFileTreeEntries,
} from "../handlers/files.js";
import { getToolContentValue } from "../handlers/tool-content.js";

export const WsRpcServerLayer = WsRpcGroup.toLayer({
	GetAgents: (request) =>
		Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			const result = yield* agentService.listAgents(request.sessionId);
			return {
				projectSlug: request.projectSlug,
				agents: result.agents,
				...(result.activeAgentId != null
					? { activeAgentId: result.activeAgentId }
					: {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetAgents failed: ${String(error)}`,
					}),
				),
			),
		),
	GetCommands: (request) =>
		getCommandsForSession(request.sessionId).pipe(
			Effect.map((commands) => ({
				projectSlug: request.projectSlug,
				commands,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetCommands failed: ${String(error)}`,
					}),
				),
			),
		),
	GetProjects: (request) =>
		Effect.gen(function* () {
			const projectService = yield* ProjectManagementServiceTag;
			const projects = yield* projectService.list();
			const current = yield* projectService.currentSlug();
			return {
				projectSlug: request.projectSlug,
				projects,
				...(current ? { current } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetProjects failed: ${String(error)}`,
					}),
				),
			),
		),
	ListDirectories: (request) =>
		Effect.gen(function* () {
			const directoryListing = yield* DirectoryListingServiceTag;
			const result = yield* directoryListing.list(request.path);
			return {
				projectSlug: request.projectSlug,
				path: result.path,
				entries: [...result.entries],
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ListDirectories failed: ${String(error)}`,
					}),
				),
			),
		),
	GetTodo: (request) =>
		getTodoState().pipe(
			Effect.map((items) => ({
				projectSlug: request.projectSlug,
				items: [...items],
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetTodo failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchAgent: (request) =>
		Effect.gen(function* () {
			const agentService = yield* AgentServiceTag;
			yield* agentService.switchAgent({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				agentId: request.agentId,
			});
			return { ok: true as const };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchAgent failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchContextWindow: (request) =>
		switchContextWindowForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			contextWindow: request.contextWindow,
		}).pipe(
			Effect.map((message) => ({
				projectSlug: request.projectSlug,
				contextWindow: message.contextWindow,
				options: message.options,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchContextWindow failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchModel: (request) =>
		switchModelForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			modelId: request.modelId,
			providerId: request.providerId,
		}).pipe(
			Effect.map((messages) => ({
				projectSlug: request.projectSlug,
				model: messages.model.model,
				provider: messages.model.provider,
				variant: messages.variant.variant,
				variants: messages.variant.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchModel failed: ${String(error)}`,
					}),
				),
			),
		),
	SetDefaultModel: (request) =>
		setDefaultModelForRelay({
			clientId: request.originId ?? "rpc",
			model: request.model,
			provider: request.provider,
		}).pipe(
			Effect.map((messages) => ({
				projectSlug: request.projectSlug,
				model: messages.model.model,
				provider: messages.model.provider,
				variant: messages.variant.variant,
				variants: messages.variant.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SetDefaultModel failed: ${String(error)}`,
					}),
				),
			),
		),
	ReloadProviderSession: (request) =>
		reloadProviderSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
		}).pipe(
			Effect.as({
				projectSlug: request.projectSlug,
				sessionId: request.sessionId,
			}),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ReloadProviderSession failed: ${String(error)}`,
					}),
				),
			),
		),
	RenameSession: (request) =>
		renameSessionForClient({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			title: request.title,
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `RenameSession failed: ${String(error)}`,
					}),
				),
			),
		),
	SwitchVariant: (request) =>
		switchVariantForSession({
			clientId: request.originId ?? "rpc",
			sessionId: request.sessionId,
			variant: request.variant,
		}).pipe(
			Effect.map((message) => ({
				projectSlug: request.projectSlug,
				variant: message.variant,
				variants: message.variants,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SwitchVariant failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileTree: (request) =>
		getFileTreeEntries().pipe(
			Effect.map((entries) => ({
				projectSlug: request.projectSlug,
				entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileTree failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileList: (request) =>
		getFileListResponse(request.path ?? ".").pipe(
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				path: result.path,
				entries: result.entries,
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileList failed: ${String(error)}`,
					}),
				),
			),
		),
	GetFileContent: (request) =>
		getFileContentResponse(request.path).pipe(
			Effect.map((result) => ({
				projectSlug: request.projectSlug,
				path: result.path,
				content: result.content,
				...(result.binary != null ? { binary: result.binary } : {}),
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetFileContent failed: ${String(error)}`,
					}),
				),
			),
		),
	GetToolContent: (request) =>
		getToolContentValue(request.toolId).pipe(
			Effect.flatMap((content) =>
				content == null
					? Effect.fail(
							new WsRpcError({
								message: "Full tool content not available",
							}),
						)
					: Effect.succeed({
							projectSlug: request.projectSlug,
							toolId: request.toolId,
							content,
						}),
			),
			Effect.catchAll((error) =>
				error instanceof WsRpcError
					? Effect.fail(error)
					: Effect.fail(
							new WsRpcError({
								message: `GetToolContent failed: ${String(error)}`,
							}),
						),
			),
		),
	GetModels: (request) =>
		getModelsResponse({
			projectSlug: request.projectSlug,
			...(request.sessionId != null ? { sessionId: request.sessionId } : {}),
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `GetModels failed: ${String(error)}`,
					}),
				),
			),
		),
	ListSessions: (request) =>
		Effect.gen(function* () {
			const sessionManager = yield* SessionManagerServiceTag;
			const roots = request.roots ?? false;
			const query = request.query?.trim() ?? "";
			const normalizedQuery = query.toLowerCase();
			const sessions = yield* sessionManager.listSessions({ roots });
			const filtered =
				normalizedQuery.length === 0
					? sessions
					: sessions.filter(
							(session) =>
								(session.title ?? "").toLowerCase().includes(normalizedQuery) ||
								session.id.toLowerCase().includes(normalizedQuery),
						);
			return {
				projectSlug: request.projectSlug,
				sessions: filtered,
				roots,
				...(query.length > 0 ? { search: true } : {}),
			};
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `ListSessions failed: ${String(error)}`,
					}),
				),
			),
		),
	LoadMoreHistory: (request) =>
		loadMoreHistoryForSession({
			sessionId: request.sessionId,
			offset: request.offset,
		}).pipe(
			Effect.map((page) => ({
				projectSlug: request.projectSlug,
				sessionId: page.sessionId,
				messages: page.messages,
				hasMore: page.hasMore,
				...(page.total != null ? { total: page.total } : {}),
			})),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `LoadMoreHistory failed: ${String(error)}`,
					}),
				),
			),
		),
	SendMessage: (request) =>
		Effect.gen(function* () {
			const limiterOption = yield* Effect.serviceOption(RateLimiterTag);
			if (limiterOption._tag === "Some") {
				const result = yield* limiterOption.value.checkLimit(
					request.originId ?? request.sessionId,
				);
				if (!result.allowed) {
					return yield* Effect.fail(
						new WsRpcError({
							message: `Rate limited. Try again in ${Math.ceil((result.retryAfterMs ?? 1000) / 1000)}s`,
						}),
					);
				}
			}
			yield* sendMessageToSession({
				clientId: request.originId ?? "rpc",
				sessionId: request.sessionId,
				text: request.text,
				...(request.images ? { images: request.images } : {}),
				...(request.originId ? { originId: request.originId } : {}),
				errorDelivery: "session",
			});
			return { ok: true as const };
		}).pipe(
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SendMessage failed: ${String(error)}`,
					}),
				),
			),
		),
	SyncInputDraft: (request) =>
		syncInputDraftForSession({
			sessionId: request.sessionId,
			text: request.text,
			...(request.originId ? { from: request.originId } : {}),
		}).pipe(
			Effect.as({ ok: true as const }),
			Effect.catchAll((error) =>
				Effect.fail(
					new WsRpcError({
						message: `SyncInputDraft failed: ${String(error)}`,
					}),
				),
			),
		),
	CancelSession: (request) =>
		cancelSessionById("rpc", request.sessionId).pipe(
			Effect.as({ ok: true as const }),
		),
});
